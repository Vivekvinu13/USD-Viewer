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


def _load_image(path: str | None, warnings: list[str]):
    if not path:
        return None
    ext = Path(path).suffix.lower()
    if ext not in IMG_OK:
        warnings.append(f"{ext} textures can't be shown (using fallback colour)")
        return None
    try:
        img = Image.open(path)
        img.load()
        if max(img.size) > 4096:
            img.thumbnail((4096, 4096))
        return img
    except Exception as e:  # noqa: BLE001
        warnings.append(f"could not read texture {Path(path).name}: {e}")
        return None


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


def extract_material(mat: UsdShade.Material, stage, cache: dict, warnings: list[str]) -> dict:
    key = str(mat.GetPath())
    if key in cache:
        return cache[key]
    info = {"base": [0.8, 0.8, 0.8, 1.0], "metal": 0.0, "rough": 0.6, "image": None, "alpha": False,
            "name": mat.GetPrim().GetName(), "emissive": None}
    nodes = _shader_nodes(mat.GetPrim())

    # 1) Standard UsdPreviewSurface
    ps = next((s for s in nodes.values() if _val(s.GetIdAttr()) == "UsdPreviewSurface"), None)
    if ps:
        d = ps.GetInput("diffuseColor")
        if d:
            tex = _texture_of(d)
            if tex:
                info["image"] = _load_image(tex, warnings)
            v = d.Get()
            if v is not None:
                info["base"][:3] = _rgb(v)
        for k, name in (("metal", "metallic"), ("rough", "roughness")):
            i = ps.GetInput(name)
            if i and i.Get() is not None:
                info[k] = float(i.Get())
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
        s = nodes.get("base_color")
        if s:
            info["image"] = _load_image(_asset_path(s.GetPrim().GetAttribute("inputs:file")), warnings)
    # 3) Artwork materials take their picture from an `_artwork_controller` prim's texture input
    if info["image"] is None and "artwork" in info["name"].lower():
        for p in stage.Traverse():
            if p.GetName() == "_artwork_controller":
                a = p.GetAttribute("inputs:param_artwork_texture")
                img = _load_image(_asset_path(a), warnings)
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
    if info["image"] is not None:
        kw["baseColorTexture"] = info["image"].convert("RGBA")
        base = [1, 1, 1, base[3]]
    kw["baseColorFactor"] = [int(round(c * 255)) for c in base]
    if info["alpha"]:
        kw["alphaMode"] = "BLEND"
    return trimesh.visual.material.PBRMaterial(**kw)


# --------------------------------------------------------------------------- meshes
def _uv_primvar(mesh: UsdGeom.Mesh):
    api = UsdGeom.PrimvarsAPI(mesh)
    for name in ("st", "UVMap", "uv", "st0", "map1"):
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
    pv = _uv_primvar(mesh)
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
    return glb, {"root": root.name, "meshes": n_meshes, "triangles": n_tris, "warnings": sorted(set(warnings))[:20]}
