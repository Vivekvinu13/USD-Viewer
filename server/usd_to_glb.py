"""Compose a USD project with real OpenUSD and export it as a single GLB.

Handles what browser-side loaders can't: payloads, references, sublayers, variant
selections, instancing, material bindings, Omniverse/Arnold-style layered assets.
"""
from __future__ import annotations

import io
import math
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image
from pxr import Gf, Sdf, Usd, UsdGeom, UsdShade, UsdUtils

USD_EXT = {".usd", ".usda", ".usdc", ".usdz"}
IMG_OK = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tga"}
MAX_TEX = 4096

try:
    import OpenEXR
except Exception:  # noqa: BLE001  (optional dependency)
    OpenEXR = None


def _read_exr(path: str) -> np.ndarray:
    """Read an OpenEXR file as float32 HxWxC (C = 1, 3 or 4)."""
    if OpenEXR is None:
        raise RuntimeError("OpenEXR is not installed (pip install OpenEXR)")
    with OpenEXR.File(path) as f:
        ch = f.channels()
        for key in ("RGBA", "RGB"):
            if key in ch:
                return np.asarray(ch[key].pixels, dtype=np.float32)
        names = [n for n in ("R", "G", "B", "A") if n in ch]
        if names:
            planes = [np.asarray(ch[n].pixels, dtype=np.float32) for n in names]
            return np.stack(planes, axis=-1)
        for n in ("Y", "V", "L"):
            if n in ch:
                return np.asarray(ch[n].pixels, dtype=np.float32)[..., None]
        first = next(iter(ch.values()))
        arr = np.asarray(first.pixels, dtype=np.float32)
        return arr if arr.ndim == 3 else arr[..., None]


def _srgb_encode(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def _exr_to_image(path: str, color: bool) -> Image.Image:
    a = _read_exr(path)
    if a.shape[-1] == 1:
        a = np.repeat(a, 3, axis=-1)
    elif a.shape[-1] == 2:
        a = np.concatenate([a, np.zeros_like(a[..., :1])], axis=-1)
    a = np.nan_to_num(a, nan=0.0, posinf=1.0, neginf=0.0)
    if color:                                   # linear colour -> sRGB for display
        rgb = _srgb_encode(a[..., :3])
        a = np.concatenate([rgb, np.clip(a[..., 3:], 0, 1)], axis=-1) if a.shape[-1] == 4 else rgb
    else:                                       # data maps (normal, roughness, opacity) stay linear
        a = np.clip(a, 0.0, 1.0)
    return Image.fromarray((a * 255 + 0.5).astype(np.uint8))


# --------------------------------------------------------------------------- root selection
def pick_root(project: Path) -> Path:
    """Choose the root layer: a USD file that no other layer in the project depends on."""
    layers = sorted(p for p in project.rglob("*") if p.suffix.lower() in USD_EXT and p.is_file())
    if not layers:
        raise ValueError("No USD file (.usd/.usda/.usdc/.usdz) found in the upload.")
    usdz = [p for p in layers if p.suffix.lower() == ".usdz"]
    if usdz:
        return usdz[0]
    if len(layers) == 1:
        return layers[0]
    referenced: set[Path] = set()
    for p in layers:
        try:
            sub_layers, assets, unresolved = UsdUtils.ComputeAllDependencies(str(p))
            for l in sub_layers:
                lp = Path(l.realPath).resolve() if l.realPath else None
                if lp and lp != p.resolve():
                    referenced.add(lp)
        except Exception:
            continue
    free = [p for p in layers if p.resolve() not in referenced] or layers
    return sorted(free, key=lambda p: (len(p.relative_to(project).parts), p.name))[0]


# --------------------------------------------------------------------------- materials
def _val(attr):
    return attr.Get() if attr and attr.HasValue() else None


def _asset_path(attr) -> str | None:
    v = _val(attr)
    if v is None:
        return None
    return v.resolvedPath or None


_img_cache: dict = {}


def _load_image(path: str | None, warnings: list[str], color: bool = True):
    """Load a texture as a PIL image. .exr files are converted (sRGB-encoded when `color`)."""
    if not path:
        return None
    key = (path, color)
    if key in _img_cache:
        return _img_cache[key]
    ext = Path(path).suffix.lower()
    img = None
    try:
        if ext == ".exr":
            img = _exr_to_image(path, color)
        elif ext in IMG_OK:
            img = Image.open(path); img.load()
        else:
            warnings.append(f"{ext} textures are not supported (using fallback colour)")
        if img is not None and max(img.size) > MAX_TEX:
            img.thumbnail((MAX_TEX, MAX_TEX))
    except Exception as e:  # noqa: BLE001
        warnings.append(f"could not read texture {Path(path).name}: {e}")
        img = None
    _img_cache[key] = img
    return img


def _rgb(v):
    return [float(v[0]), float(v[1]), float(v[2])]


def _shader_nodes(mat_prim):
    out = {}
    for p in Usd.PrimRange(mat_prim):
        if p.IsA(UsdShade.Shader):
            out.setdefault(p.GetName(), UsdShade.Shader(p))
    return out


def _texture_of(shader_input) -> str | None:
    """Follow a connection to a UsdUVTexture and return its resolved file path."""
    if not shader_input:
        return None
    src = shader_input.GetConnectedSource()
    if not src:
        return None
    node = UsdShade.Shader(src[0].GetPrim())
    f = node.GetInput("file")
    return _asset_path(f.GetAttr()) if f else None


def _st_info(tex_node) -> dict | None:
    """Describe how a UsdUVTexture node is fed its coordinates: UV set name and any UsdTransform2d."""
    if tex_node is None:
        return None
    st = tex_node.GetInput("st")
    if not st:
        return None
    out: dict = {}
    src = st.GetConnectedSource()
    hops = 0
    while src and hops < 4:
        sh = UsdShade.Shader(src[0].GetPrim())
        sid = _val(sh.GetIdAttr()) or ""
        if sid == "UsdTransform2d":
            sc, rot, tr = (sh.GetInput(n) for n in ("scale", "rotation", "translation"))
            out["scale"] = tuple(sc.Get()) if sc and sc.Get() is not None else (1.0, 1.0)
            out["rot"] = float(rot.Get()) if rot and rot.Get() is not None else 0.0
            out["trans"] = tuple(tr.Get()) if tr and tr.Get() is not None else (0.0, 0.0)
            nxt = sh.GetInput("in")
            src = nxt.GetConnectedSource() if nxt else None
        elif sid.startswith("UsdPrimvarReader"):
            vn = sh.GetInput("varname")
            v = vn.Get() if vn else None
            if v:
                out["varname"] = str(v)
            break
        else:
            break
        hops += 1
    return out or None


def extract_material(mat: UsdShade.Material, stage, cache: dict, warnings: list[str]) -> dict:
    key = str(mat.GetPath())
    if key in cache:
        return cache[key]
    info = {"base": [0.8, 0.8, 0.8, 1.0], "metal": 0.0, "rough": 0.6, "image": None, "alpha": False,
            "name": mat.GetPrim().GetName(), "emissive": None, "normal": None, "opacity": None}
    nodes = _shader_nodes(mat.GetPrim())

    # 1) Standard UsdPreviewSurface
    ps = next((s for s in nodes.values() if _val(s.GetIdAttr()) == "UsdPreviewSurface"), None)
    if ps:
        d = ps.GetInput("diffuseColor")
        if d:
            tex = _texture_of(d)
            if tex:
                info["image"] = _load_image(tex, warnings)
                src = d.GetConnectedSource()
                if src:
                    info["uv"] = _st_info(UsdShade.Shader(src[0].GetPrim()))
            v = d.Get()
            if v is not None:
                info["base"][:3] = _rgb(v)
        for k, name in (("metal", "metallic"), ("rough", "roughness")):
            i = ps.GetInput(name)
            if i and i.Get() is not None:
                info[k] = float(i.Get())
        n_in = ps.GetInput("normal")
        if n_in:
            info["normal"] = _load_image(_texture_of(n_in), warnings, False)
        o = ps.GetInput("opacity")
        if o and o.Get() is not None and float(o.Get()) < 1:
            info["base"][3] = float(o.Get()); info["alpha"] = True
    else:
        # 2) Layered "named node" materials (e.g. Grip / Arnold exports): child shaders such as
        #    base_color / metalness / roughness / opacity carrying inputs:fallback and inputs:file.
        def fallback(n):
            s = nodes.get(n)
            fb = _val(s.GetPrim().GetAttribute("inputs:fallback")) if s else None
            return fb
        fb = fallback("base_color")
        if fb is not None:
            info["base"][:3] = _rgb(fb)
        for k, n in (("metal", "metalness"), ("rough", "roughness")):
            v = fallback(n)
            if v is not None:
                info[k] = float(v[0])
        def tex(n, color):
            node = nodes.get(n)
            return _load_image(_asset_path(node.GetPrim().GetAttribute("inputs:file")), warnings, color) if node else None
        info["image"] = tex("base_color", True)
        info["normal"] = tex("normal_map", False)
        info["opacity"] = tex("opacity", False)
        if info["opacity"] is not None:
            info["alpha"] = True
        else:
            o = fallback("opacity")
            if o is not None and float(o[0]) < 1:
                info["base"][3] = float(o[0]); info["alpha"] = True
    # 2b) Named texture nodes also count when a UsdPreviewSurface exists but has no connected textures
    def _named_tex(n, color):
        node = nodes.get(n)
        if not node:
            return None
        return _load_image(_asset_path(node.GetPrim().GetAttribute("inputs:file")), warnings, color)
    if info["image"] is None:
        info["image"] = _named_tex("base_color", True)
        if info["image"] is not None and nodes.get("base_color") is not None:
            info["uv"] = _st_info(nodes["base_color"])
    if info["normal"] is None:
        info["normal"] = _named_tex("normal_map", False)
    if info["opacity"] is None:
        info["opacity"] = _named_tex("opacity", False)
        if info["opacity"] is not None:
            info["alpha"] = True
    # 3) Artwork materials take their picture from an `_artwork_controller` prim's texture input
    if info["image"] is None and "artwork" in info["name"].lower():
        for p in stage.Traverse():
            if p.GetName() == "_artwork_controller":
                a = p.GetAttribute("inputs:param_artwork_texture")
                img = _load_image(_asset_path(a), warnings, True)
                if img is not None:
                    info["image"] = img
                    info["alpha"] = img.mode in ("RGBA", "LA")
                    break
    cache[key] = info
    return info


def to_pbr(info: dict) -> trimesh.visual.material.PBRMaterial:
    kw = dict(name=info["name"], metallicFactor=min(max(info["metal"], 0), 1),
              roughnessFactor=min(max(info["rough"], 0), 1), doubleSided=True)
    base = [min(max(c, 0), 1) for c in info["base"]]
    color_img = info["image"]
    opacity = info.get("opacity")
    if opacity is not None:                          # opacity map (R channel) becomes the alpha channel
        size = color_img.size if color_img is not None else opacity.size
        rgb = (color_img.convert("RGB").resize(size) if color_img is not None
               else Image.new("RGB", size, tuple(int(round(c * 255)) for c in base[:3])))
        alpha = opacity.convert("RGB").split()[0].resize(size)
        color_img = Image.merge("RGBA", (*rgb.split(), alpha))
        base = [1, 1, 1, 1]
    if color_img is not None:
        rgba = color_img.convert("RGBA")
        kw["baseColorTexture"] = rgba
        base = [1, 1, 1, base[3]]
        if rgba.getchannel("A").getextrema()[0] < 255:      # texture has transparent areas: honour them
            kw["alphaMode"] = "BLEND"
    if info.get("normal") is not None:
        kw["normalTexture"] = info["normal"].convert("RGB")
    kw["baseColorFactor"] = [int(round(c * 255)) for c in base]
    if info["alpha"]:
        kw["alphaMode"] = "BLEND"
    return trimesh.visual.material.PBRMaterial(**kw)


# --------------------------------------------------------------------------- meshes
def _uv_primvar(mesh: UsdGeom.Mesh, preferred: str | None = None):
    api = UsdGeom.PrimvarsAPI(mesh)
    names = ([preferred] if preferred else []) + ["st", "UVMap", "uv", "st0", "map1"]
    for name in names:
        pv = api.GetPrimvar(name)
        if pv and pv.HasValue():
            return pv
    return None


def mesh_to_trimesh(prim, xf_cache, to_unit: Gf.Matrix4d, material: dict | None):
    mesh = UsdGeom.Mesh(prim)
    pts = mesh.GetPointsAttr().Get()
    fvc = mesh.GetFaceVertexCountsAttr().Get()
    fvi = mesh.GetFaceVertexIndicesAttr().Get()
    if pts is None or not fvc or fvi is None:
        return None
    pts = np.asarray(pts, dtype=np.float64)
    fvc = np.asarray(fvc); fvi = np.asarray(fvi)

    # fan-triangulate, remembering the face-vertex ("corner") index of each triangle corner
    tri, corner = [], []
    off = 0
    for n in fvc:
        n = int(n)
        for k in range(1, n - 1):
            tri.append((fvi[off], fvi[off + k], fvi[off + k + 1]))
            corner.append((off, off + k, off + k + 1))
        off += n
    if not tri:
        return None
    tri = np.asarray(tri); corner = np.asarray(corner)
    if mesh.GetOrientationAttr().Get() == UsdGeom.Tokens.leftHanded:
        tri = tri[:, ::-1]; corner = corner[:, ::-1]

    # world transform (row-vector convention)
    M = np.array(xf_cache.GetLocalToWorldTransform(prim) * to_unit).reshape(4, 4)
    wp = (np.c_[pts, np.ones(len(pts))] @ M)[:, :3]
    nm = np.linalg.inv(M[:3, :3]).T
    if np.linalg.det(M[:3, :3]) < 0:
        tri = tri[:, ::-1]; corner = corner[:, ::-1]

    tm = trimesh.Trimesh(vertices=wp, faces=tri, process=False)
    flat_v = tri.reshape(-1)
    verts = wp[flat_v]
    normals = tm.vertex_normals[flat_v]

    n_attr = mesh.GetNormalsAttr().Get()
    if n_attr is not None and len(n_attr):
        n_arr = np.asarray(n_attr, dtype=np.float64)
        interp = mesh.GetNormalsInterpolation()
        try:
            if interp == UsdGeom.Tokens.faceVarying and len(n_arr) == len(fvi):
                normals = n_arr[corner.reshape(-1)] @ nm
            elif interp == UsdGeom.Tokens.vertex and len(n_arr) == len(pts):
                normals = n_arr[flat_v] @ nm
        except Exception:
            pass
        ln = np.linalg.norm(normals, axis=1, keepdims=True); ln[ln == 0] = 1
        normals = normals / ln

    uv = None
    uvx = (material or {}).get("uv") or {}
    pv = _uv_primvar(mesh, uvx.get("varname"))
    if pv is not None:
        vals = np.asarray(pv.Get(), dtype=np.float64)
        idx = pv.GetIndices()
        if idx is not None and len(idx):
            vals = vals[np.asarray(idx)]
        interp = pv.GetInterpolation()
        try:
            if interp == UsdGeom.Tokens.faceVarying and len(vals) == len(fvi):
                uv = vals[corner.reshape(-1)]
            elif interp == UsdGeom.Tokens.vertex and len(vals) == len(pts):
                uv = vals[flat_v]
        except Exception:
            uv = None
    if uv is not None and ("scale" in uvx):           # UsdTransform2d: scale, then rotate, then translate
        sx, sy = uvx["scale"]; t = math.radians(uvx.get("rot", 0.0)); tx, ty = uvx.get("trans", (0.0, 0.0))
        u, v = uv[:, 0] * sx, uv[:, 1] * sy
        uv = np.stack([u * math.cos(t) - v * math.sin(t) + tx, u * math.sin(t) + v * math.cos(t) + ty], axis=1)

    out = trimesh.Trimesh(vertices=verts, faces=np.arange(len(verts)).reshape(-1, 3),
                          vertex_normals=normals, process=False)
    if material is not None:
        mat = to_pbr(material)
        if uv is not None:
            out.visual = trimesh.visual.TextureVisuals(uv=uv, material=mat)
        else:
            out.visual = trimesh.visual.TextureVisuals(material=mat)
    return out


def convert(root: Path) -> tuple[bytes, dict]:
    stage = Usd.Stage.Open(str(root))
    if not stage:
        raise ValueError(f"OpenUSD could not open {root.name}")
    warnings: list[str] = []
    mpu = UsdGeom.GetStageMetersPerUnit(stage) or 1.0
    up = UsdGeom.GetStageUpAxis(stage)
    to_unit = Gf.Matrix4d(1.0).SetScale(Gf.Vec3d(mpu, mpu, mpu))
    if up == UsdGeom.Tokens.z:
        to_unit = to_unit * Gf.Matrix4d().SetRotate(Gf.Rotation(Gf.Vec3d(1, 0, 0), -90))

    xf_cache = UsdGeom.XformCache(Usd.TimeCode.Default())
    cache: dict = {}
    scene = trimesh.Scene()
    n_meshes = n_tris = 0
    diag: list = []
    seen_names: dict[str, int] = {}
    pred = Usd.TraverseInstanceProxies(Usd.PrimDefaultPredicate)
    for prim in stage.Traverse(pred):
        if not prim.IsA(UsdGeom.Mesh):
            continue
        img = UsdGeom.Imageable(prim)
        if img.ComputeVisibility() == UsdGeom.Tokens.invisible:
            continue
        if img.ComputePurpose() in (UsdGeom.Tokens.guide, UsdGeom.Tokens.proxy):
            continue
        material = None
        try:
            bound = UsdShade.MaterialBindingAPI(prim).ComputeBoundMaterial()[0]
            if bound:
                material = extract_material(bound, stage, cache, warnings)
        except Exception as e:  # noqa: BLE001
            warnings.append(f"material lookup failed on {prim.GetPath()}: {e}")
        if material is None:
            dc = UsdGeom.Gprim(prim).GetDisplayColorAttr().Get()
            material = {"base": [*(_rgb(dc[0]) if dc else [0.75, 0.75, 0.78]), 1.0], "metal": 0.0, "rough": 0.7,
                        "image": None, "alpha": False, "name": "default", "emissive": None}
        try:
            tm = mesh_to_trimesh(prim, xf_cache, to_unit, material)
        except Exception as e:  # noqa: BLE001
            warnings.append(f"skipped {prim.GetPath()}: {e}")
            continue
        if tm is None:
            continue
        name = prim.GetName()
        seen_names[name] = seen_names.get(name, 0) + 1
        if seen_names[name] > 1:
            name = f"{name}_{seen_names[name]}"
        scene.add_geometry(tm, node_name=name, geom_name=name)
        diag.append({"mesh": name, "material": material.get("name"), "texture": material.get("image") is not None,
                     "uv": material.get("uv"), "alpha": bool(material.get("alpha"))})
        n_meshes += 1; n_tris += len(tm.faces)

    if not n_meshes:
        raise ValueError(
            f"OpenUSD composed '{root.name}' but found no visible meshes. "
            "Check that the referenced/payload files (e.g. resources/layers/geometry.usdc) were included.")
    glb = scene.export(file_type="glb")
    unresolved = []
    try:
        _, _, unresolved = UsdUtils.ComputeAllDependencies(str(root))
    except Exception:
        pass
    if unresolved:
        names = sorted({Path(u).name for u in unresolved})
        warnings.append(f"{len(names)} referenced file(s) not included in the upload (e.g. {names[0]})")
    return glb, {"root": root.name, "meshes": n_meshes, "triangles": n_tris, "warnings": sorted(set(warnings))[:20], "meshes": diag}
