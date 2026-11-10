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
from PIL import Image, ImageFilter
import json
import struct
import time
import uuid

from pxr import Gf, Sdf, Usd, UsdGeom, UsdLux, UsdShade, UsdUtils

VERSION = "15-water-droplets"
USD_EXT = {".usd", ".usda", ".usdc", ".usdz"}
IMG_OK = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tga"}
DATA_QUARTER_MAX = 1024  # gloss/metal and normal-map quarters stay smooth: at full size their fine grain shows as streaks
ARTWORK_MAX = 4096        # artwork atlas: 4 quarters, so a 4096 sheet keeps a 2048 label
MAX_TEX = 2048          # keeps the GLB small enough for a browser (huge EXRs are downsampled while decoding)

try:
    import OpenEXR
except Exception:  # noqa: BLE001  (optional dependency)
    OpenEXR = None


def _reduce_chunked(a: np.ndarray, limit: int) -> np.ndarray:
    """float16/32 HxWxC -> float32, average-pooled so the longest side <= limit, converting a few rows at a time."""
    h, w, c = a.shape
    f = -(-max(h, w) // limit)
    if f <= 1:
        return a.astype(np.float32)
    h2, w2 = h // f * f, w // f * f
    out = np.empty((h2 // f, w2 // f, c), np.float32)
    step = 32
    for r0 in range(0, h2 // f, step):
        r1 = min(r0 + step, h2 // f)
        blk = a[r0 * f:r1 * f, :w2].astype(np.float32)
        out[r0:r1] = blk.reshape(r1 - r0, f, w2 // f, f, c).mean(axis=(1, 3))
    return out


def _read_exr(path: str, limit: int = 4096) -> np.ndarray:
    """Read an OpenEXR file as float32 HxWxC (C = 1, 3 or 4), downsampled while decoding to keep memory low."""
    if OpenEXR is None:
        raise RuntimeError("OpenEXR is not installed (pip install OpenEXR)")
    with OpenEXR.File(path) as f:
        ch = f.channels()
        for key in ("RGBA", "RGB"):
            if key in ch:
                return _reduce_chunked(np.asarray(ch[key].pixels), limit)
        names = [n for n in ("R", "G", "B", "A") if n in ch]
        if names:
            return np.concatenate([_reduce_chunked(np.asarray(ch[n].pixels)[..., None], limit) for n in names], axis=-1)
        for n in ("Y", "V", "L"):
            if n in ch:
                return _reduce_chunked(np.asarray(ch[n].pixels)[..., None], limit)
        arr = np.asarray(next(iter(ch.values())).pixels)
        return _reduce_chunked(arr if arr.ndim == 3 else arr[..., None], limit)


def _srgb_encode(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def _box_reduce(a: np.ndarray, limit: int) -> np.ndarray:
    """Average-pool big images down so the longest side is at most `limit` (saves memory and time)."""
    h, w = a.shape[:2]
    f = -(-max(h, w) // limit)
    if f <= 1:
        return a
    h2, w2 = h // f * f, w // f * f
    return a[:h2, :w2].reshape(h2 // f, f, w2 // f, f, a.shape[2]).mean(axis=(1, 3), dtype=np.float32)


def _exr_to_image(path: str, color: bool, limit: int = MAX_TEX) -> Image.Image:
    a = _read_exr(path, limit)
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


def _srgb_decode(x: np.ndarray) -> np.ndarray:
    return np.where(x <= 0.04045, x / 12.92, np.power((x + 0.055) / 1.055, 2.4))


def decode_artwork_atlas(img: Image.Image, p: dict) -> dict:
    """Grip artwork textures are 2x2 atlases. Mirrors Grip's `artwork_texture` shader:
        top-left     = label colour (sRGB)
        bottom-left  = R reflection, G gloss, B metalness factor
        top-right    = opacity (luminance)
        bottom-right = normal map
    Each quarter spans the whole surface UV range. Returns PIL images for a glTF PBR material."""
    a = np.asarray(img.convert("RGBA"), dtype=np.float32) / 255.0
    h, w = a.shape[:2]
    hh, hw = h // 2, w // 2
    tl, tr = a[:hh, :hw, :3], a[:hh, hw:2 * hw, :3]
    bl, br = a[hh:2 * hh, :hw, :3], a[hh:2 * hh, hw:2 * hw, :3]

    tl_lin = _srgb_decode(tl)
    black = np.array(p["base_black"], dtype=np.float32); white = np.array(p["base_white"], dtype=np.float32)
    base = black + (white - black) * tl_lin
    refl = 2.0 * bl[..., 0:1]
    metal = np.clip(refl * bl[..., 2:3], 0.0, 1.0)
    metal_color = np.clip(refl * tl_lin, 0.0, 1.0)
    base = base * (1.0 - metal) + metal_color * metal
    rough = 1.0 - np.clip((1.0 - p["rough_black"]) * 2.0 * bl[..., 1:2], 0.0, 1.0)
    if p.get("refractive"):
        opacity = tr[..., 0:1]
    else:
        opacity = (0.2126 * tr[..., 0:1] + 0.7152 * tr[..., 1:2] + 0.0722 * tr[..., 2:3])

    def u8(x):
        return (np.clip(x, 0, 1) * 255 + 0.5).astype(np.uint8)
    # Hairline gaps in the print-opacity data (specks, scratches) show the bare metal as thin pale lines once the
    # texture is sharp. Close them (dilate then erode) and soften, so only real transparent regions stay transparent.
    alpha = Image.fromarray(u8(opacity[..., 0]), "L")
    alpha = alpha.filter(ImageFilter.MaxFilter(7)).filter(ImageFilter.MinFilter(7)).filter(ImageFilter.GaussianBlur(1.2))
    base_rgba = Image.fromarray(np.concatenate([u8(_srgb_encode(base)), np.asarray(alpha)[..., None]], axis=-1), "RGBA")
    mr = Image.fromarray(u8(np.concatenate([np.zeros_like(rough), rough, metal], axis=-1)), "RGB")
    normal = Image.fromarray(u8(br), "RGB")
    # the label colour keeps full resolution (sharp small print); the *data* maps are smoothed to <= 1024 px, which is
    # what Grip's renders effectively show (full-size scratch/grain data looks like vertical streaks on a flat label)
    for_name = {"mr": mr, "normal": normal}
    for k, im in for_name.items():
        if max(im.size) > DATA_QUARTER_MAX:
            f = DATA_QUARTER_MAX / max(im.size)
            for_name[k] = im.resize((max(1, round(im.size[0] * f)), max(1, round(im.size[1] * f))), Image.LANCZOS)
    mr, normal = for_name["mr"], for_name["normal"]
    return {"image": base_rgba, "mr": mr, "normal": normal, "has_alpha": float(opacity.min()) < 0.999}


def _artwork_params(stage, mat_prim) -> dict:
    """Read Grip's per-material artwork settings (falling back to the shader's own defaults)."""
    def fb(name):
        pr = stage.GetPrimAtPath(f"{mat_prim.GetPath()}/grip_interface/grip_arnold_overrides/{name}")
        at = pr.GetAttribute("inputs:fallback") if pr else None
        return _val(at)
    bb, bw, rb, rf = fb("base_color_black"), fb("base_color_white"), fb("roughness_black"), fb("use_refractive_artwork")
    return {
        "base_black": _rgb(bb) if bb is not None else [0.0, 0.0, 0.0],
        "base_white": _rgb(bw) if bw is not None else [1.0, 1.0, 1.0],
        "rough_black": float(rb[0]) if rb is not None else 0.2,
        "refractive": bool(rf is not None and float(rf[0]) > 0.5),
    }


_img_cache: dict = {}


def _load_image(path: str | None, warnings: list[str], color: bool = True, limit: int = MAX_TEX):
    """Load a texture as a PIL image. .exr files are converted (sRGB-encoded when `color`).
    `limit` caps the longest side; label artwork uses a higher one so fine print stays readable."""
    if not path:
        return None
    key = (path, color, limit)
    if key in _img_cache:
        return _img_cache[key]
    ext = Path(path).suffix.lower()
    img = None
    try:
        if ext == ".exr":
            img = _exr_to_image(path, color, limit)
        elif ext in IMG_OK:
            img = Image.open(path); img.load()
        else:
            warnings.append(f"{ext} textures are not supported (using fallback colour)")
        if img is not None and max(img.size) > limit:
            img.thumbnail((limit, limit), Image.LANCZOS)
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
    # 3) Grip artwork materials: the picture comes from an `_artwork_controller` prim and is a 2x2 atlas
    if "artwork" in info["name"].lower():
        for p in stage.Traverse():
            if p.GetName() == "_artwork_controller":
                a = p.GetAttribute("inputs:param_artwork_texture")
                # raw: quarters carry data, not just colour. Keep it sharp: each quarter spans the whole can, so a
                # 4096 sheet gives a 2048 label (fine print such as ingredients/slogans needs that)
                img = _load_image(_asset_path(a), warnings, False, limit=ARTWORK_MAX)
                if img is not None:
                    parts = decode_artwork_atlas(img, _artwork_params(stage, mat.GetPrim()))
                    info.update(image=parts["image"], mr=parts["mr"], normal=parts["normal"],
                                alpha=parts["has_alpha"], metal=1.0, rough=1.0, atlas=True)
                    info["base"] = [1.0, 1.0, 1.0, 1.0]
                    info["opacity"] = None
                    break
    tr = nodes.get("transmission")
    trv = _val(tr.GetPrim().GetAttribute("inputs:fallback")) if tr else None
    if trv is not None and float(trv[0]) >= 0.5:         # water droplets, glass, liquids: transmissive material
        info["glass"] = True
        info["transmission"] = min(max(float(trv[0]), 0.0), 1.0)
        info["metal"] = 0.0
        info["rough"] = min(info["rough"], 0.08)
        # in glTF the base colour tints the light passing through, so use Grip's transmission colour for it
        tc = nodes.get("transmission_color")
        tc_fb = _val(tc.GetPrim().GetAttribute("inputs:fallback")) if tc else None
        tc_img = (_load_image(_asset_path(tc.GetPrim().GetAttribute("inputs:file")), warnings, True) if tc else None)
        # Grip/Arnold's transmission colour is the colour reached after light has travelled `transmission_depth`
        # through the material (an absorption colour), so it is NOT a plain multiplier: very dark values are normal.
        # It becomes glTF volume attenuation, and the base colour stays white.
        info["base"][:3] = [1.0, 1.0, 1.0]
        info["image"] = None
        if tc_img is not None:
            _px = np.asarray(tc_img.convert("RGBA"), dtype=np.float32).reshape(-1, 4)
            info["tint_srgb"] = [int(v) for v in _px[:, :3].mean(0).round()]
            info["tint_alpha_min"] = int(_px[:, 3].min())
            info["tint_lin"] = [float(v) for v in _srgb_decode(_px[:, :3] / 255.0).mean(0)]
        elif tc_fb is not None:
            info["tint_lin"] = [float(x) for x in tc_fb[:3]]
        else:
            info["tint_lin"] = [1.0, 1.0, 1.0]
        ior = nodes.get("IOR")
        ior_fb = _val(ior.GetPrim().GetAttribute("inputs:fallback")) if ior else None
        info["ior"] = min(max(float(ior_fb[0]), 1.0), 2.4) if ior_fb is not None else 1.45
        dp = nodes.get("transmission_depth")
        dpv = _val(dp.GetPrim().GetAttribute("inputs:fallback")) if dp else None
        info["depth"] = float(dpv[0]) if dpv is not None else None
        info["tc_fallback"] = [round(float(x), 3) for x in tc_fb[:3]] if tc_fb is not None else None
    cache[key] = info
    return info


def _jpeg(img: Image.Image, quality: int = 90) -> Image.Image:
    """Re-encode as JPEG so the GLB stores it as JPEG (trimesh keeps JPEGs as they are)."""
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=quality)
    buf.seek(0)
    out = Image.open(buf)
    out.load()
    return out


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
        base = [1, 1, 1, base[3]]
        if rgba.getchannel("A").getextrema()[0] < 255:      # texture has transparent areas: honour them
            kw["alphaMode"] = "BLEND"
            kw["baseColorTexture"] = rgba
        else:
            kw["baseColorTexture"] = _jpeg(rgba, 90)
    if info.get("normal") is not None:
        kw["normalTexture"] = _jpeg(info["normal"], 92)
    if info.get("mr") is not None:
        kw["metallicRoughnessTexture"] = _jpeg(info["mr"], 92)
    kw["baseColorFactor"] = [int(round(c * 255)) for c in base]
    if info["alpha"]:
        kw["alphaMode"] = "BLEND"
    if info.get("glass") and (info["alpha"] or kw.get("alphaMode") == "BLEND"):
        # droplets/glass whose shape comes from an opacity mask: cut the shape out cleanly and let real refraction do
        # the rest. Fading it like a film (BLEND) gives frosted white blobs instead of clear water.
        kw["alphaMode"] = "MASK"
        kw["alphaCutoff"] = 0.5
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


def _vertex_normals(points: np.ndarray, tris: np.ndarray) -> np.ndarray:
    """Area-weighted smooth vertex normals (much faster than trimesh's for multi-million triangle meshes)."""
    p0, p1, p2 = points[tris[:, 0]], points[tris[:, 1]], points[tris[:, 2]]
    fn = np.cross(p1 - p0, p2 - p0)
    out = np.zeros_like(points)
    for k in range(3):
        for c in range(3):
            out[:, c] += np.bincount(tris[:, k], weights=fn[:, c], minlength=len(points))
    return out


def _pack_unique(keys: np.ndarray) -> np.ndarray:
    """Dense ids (0..n-1) for equal int64 keys."""
    return np.unique(keys, return_inverse=True)[1].astype(np.int64).reshape(-1)


def mesh_to_trimesh(prim, xf_cache, to_unit: Gf.Matrix4d, material: dict | None):
    mesh = UsdGeom.Mesh(prim)
    pts = mesh.GetPointsAttr().Get()
    fvc = mesh.GetFaceVertexCountsAttr().Get()
    fvi = mesh.GetFaceVertexIndicesAttr().Get()
    if pts is None or fvc is None or fvi is None or not len(fvc):
        return None
    pts = np.asarray(pts, dtype=np.float64)
    fvc = np.asarray(fvc, dtype=np.int64); fvi = np.asarray(fvi, dtype=np.int64)
    if fvc.sum() > len(fvi):
        return None

    # --- vectorised fan triangulation: `corner` = face-vertex index of each triangle corner
    if (fvc == 3).all():
        corner = np.arange(len(fvi), dtype=np.int64).reshape(-1, 3)
    else:
        cnt = np.maximum(fvc - 2, 0)
        total = int(cnt.sum())
        if total == 0:
            return None
        starts = np.cumsum(fvc) - fvc
        face = np.repeat(np.arange(len(fvc)), cnt)
        k = np.arange(total) - np.repeat(np.cumsum(cnt) - cnt, cnt)
        a0 = starts[face]
        corner = np.stack([a0, a0 + k + 1, a0 + k + 2], axis=1)
    flip = mesh.GetOrientationAttr().Get() == UsdGeom.Tokens.leftHanded

    # --- world transform (row-vector convention)
    M = np.array(xf_cache.GetLocalToWorldTransform(prim) * to_unit).reshape(4, 4)
    wp = (np.c_[pts, np.ones(len(pts))] @ M)[:, :3]
    nm = np.linalg.inv(M[:3, :3]).T
    if np.linalg.det(M[:3, :3]) < 0:
        flip = not flip
    if flip:
        corner = corner[:, ::-1]
    cflat = np.ascontiguousarray(corner.reshape(-1))
    pidx = fvi[cflat]

    # --- authored normals and UVs -> keys that decide which corners may share a vertex
    n_vals = n_mode = None
    n_attr = mesh.GetNormalsAttr().Get()
    if n_attr is not None and len(n_attr):
        arr = np.asarray(n_attr, dtype=np.float64)
        interp = mesh.GetNormalsInterpolation()
        if interp == UsdGeom.Tokens.faceVarying and len(arr) == len(fvi):
            n_vals, n_mode = arr, "corner"
        elif interp == UsdGeom.Tokens.vertex and len(arr) == len(pts):
            n_vals, n_mode = arr, "vertex"

    uvx = (material or {}).get("uv") or {}
    pv = _uv_primvar(mesh, uvx.get("varname"))
    uv_vals = uv_mode = uv_corner_key = None
    if pv is not None:
        vals = np.asarray(pv.Get(), dtype=np.float64)
        idx = pv.GetIndices()
        interp = pv.GetInterpolation()
        if interp == UsdGeom.Tokens.faceVarying:
            if idx is not None and len(idx) == len(fvi):
                uv_vals, uv_mode, uv_corner_key = vals, "corner_idx", np.asarray(idx, dtype=np.int64)
            elif len(vals) == len(fvi):
                uv_vals, uv_mode = vals, "corner"
                uv_corner_key = np.ascontiguousarray(vals.astype(np.float32)).view(np.int64).reshape(-1)
        elif interp == UsdGeom.Tokens.vertex:
            if idx is not None and len(idx):
                vals = vals[np.asarray(idx, dtype=np.int64)]
            if len(vals) == len(pts):
                uv_vals, uv_mode = vals, "vertex"

    # --- weld: corners with the same position, normal and UV become one vertex
    extra = np.zeros(len(cflat), dtype=np.int64)
    if n_mode == "corner":
        q = np.clip(np.round(n_vals * 4096).astype(np.int64) + 4096, 0, 16383)
        packed = (q[:, 0] << 28) | (q[:, 1] << 14) | q[:, 2]
        extra = _pack_unique(packed)[cflat]
    if uv_mode in ("corner", "corner_idx"):
        ukey = _pack_unique(uv_corner_key)[cflat]
        extra = ukey if n_mode != "corner" else _pack_unique(extra * (int(ukey.max()) + 1) + ukey)
    if n_mode == "corner" or uv_mode in ("corner", "corner_idx"):
        final = pidx * (int(extra.max()) + 1) + extra
    else:
        final = pidx
    _, first, inv = np.unique(final, return_index=True, return_inverse=True)
    faces = inv.reshape(-1, 3)
    src_c, src_p = cflat[first], pidx[first]
    verts = wp[src_p]

    # --- per-vertex normals
    if n_mode == "corner":
        normals = n_vals[src_c] @ nm
    elif n_mode == "vertex":
        normals = n_vals[src_p] @ nm
    else:
        # smooth normals computed on the original points, so shading stays continuous across UV seams
        normals = _vertex_normals(wp, pidx.reshape(-1, 3))[src_p]
    ln = np.linalg.norm(normals, axis=1, keepdims=True); ln[ln == 0] = 1
    normals = normals / ln

    # --- per-vertex UVs
    uv = None
    if uv_mode in ("corner", "corner_idx"):
        full = uv_vals[uv_corner_key] if uv_mode == "corner_idx" else uv_vals
        uv = full[src_c]
    elif uv_mode == "vertex":
        uv = uv_vals[src_p]
    if uv is not None and ("scale" in uvx):           # UsdTransform2d: scale, then rotate, then translate
        sx, sy = uvx["scale"]; t = math.radians(uvx.get("rot", 0.0)); tx, ty = uvx.get("trans", (0.0, 0.0))
        u, v = uv[:, 0] * sx, uv[:, 1] * sy
        uv = np.stack([u * math.cos(t) - v * math.sin(t) + tx, u * math.sin(t) + v * math.cos(t) + ty], axis=1)

    out = trimesh.Trimesh(vertices=verts, faces=faces, vertex_normals=normals, process=False)
    if material is not None:
        mat = to_pbr(material)
        if uv is not None:
            out.visual = trimesh.visual.TextureVisuals(uv=uv, material=mat)
        else:
            out.visual = trimesh.visual.TextureVisuals(material=mat)
    return out


# --------------------------------------------------------------------------- variants
USER_VARIANT_SETS = ("Visibility", "Artwork")      # the ones worth exposing to a viewer user


def list_variants(stage) -> list[dict]:
    """Variant sets users may switch (e.g. Grip's Visibility = Dry/Wet/Open_Dry/Open_Wet, Artwork)."""
    out, seen = [], set()
    for prim in stage.Traverse():
        vsets = prim.GetVariantSets()
        for name in vsets.GetNames():
            if name in USER_VARIANT_SETS and name not in seen:
                vs = vsets.GetVariantSet(name)
                out.append({"set": name, "options": vs.GetVariantNames(), "selected": vs.GetVariantSelection()})
                seen.add(name)
    return out


def apply_variants(stage, selection: dict[str, str]) -> None:
    if not selection:
        return
    with Usd.EditContext(stage, stage.GetSessionLayer()):
        for prim in stage.Traverse():
            vsets = prim.GetVariantSets()
            for name in vsets.GetNames():
                want = selection.get(name)
                if want and want in vsets.GetVariantSet(name).GetVariantNames():
                    vsets.GetVariantSet(name).SetVariantSelection(want)


# --------------------------------------------------------------------------- lighting environment
ENV_CACHE: dict[str, bytes] = {}


def find_environment(stage) -> str | None:
    for prim in stage.Traverse():
        if prim.IsA(UsdLux.DomeLight):
            a = prim.GetAttribute("inputs:texture:file")
            path = _asset_path(a) if a else None
            if path:
                return path
    return None


def encode_environment(path: str, w: int = 1024, h: int = 512) -> bytes | None:
    """Dome-light image -> little-endian float16 RGBA (w*h*4), ready for a browser DataTexture."""
    try:
        if Path(path).suffix.lower() == ".exr":
            a = _read_exr(path, 2048)
        else:
            a = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255.0
            a = _srgb_decode(a)
        a = np.nan_to_num(a[..., :3] if a.shape[-1] >= 3 else np.repeat(a[..., :1], 3, axis=-1), nan=0.0, posinf=60000.0)
        chans = [np.asarray(Image.fromarray(np.ascontiguousarray(a[..., c]), mode="F").resize((w, h), Image.BOX))
                 for c in range(3)]
        rgb = np.clip(np.stack(chans, axis=-1), 0.0, 60000.0)
        rgba = np.concatenate([rgb, np.ones((h, w, 1), dtype=np.float32)], axis=-1).astype("<f2")
        return rgba.tobytes()
    except Exception:  # noqa: BLE001
        return None


# --------------------------------------------------------------------------- glTF post-processing
def extract_look(stage, xf_cache, to_unit: Gf.Matrix4d, bounds, warnings: list[str]) -> dict:
    """The project's own camera and dome-light settings (what the reference render was made with)."""
    look: dict = {}
    # ---- camera
    cam_prim = None
    for prim in stage.Traverse():
        if prim.IsA(UsdGeom.Camera):
            if cam_prim is None or prim.GetName() == "default":
                cam_prim = prim
            if prim.GetName() == "default":
                break
    if cam_prim is not None and bounds is not None:
        cam = UsdGeom.Camera(cam_prim)
        focal = float(cam.GetFocalLengthAttr().Get() or 50.0)
        h_ap = float(cam.GetHorizontalApertureAttr().Get() or 36.0)
        M = xf_cache.GetLocalToWorldTransform(cam_prim) * to_unit
        pos = np.array(M.Transform(Gf.Vec3d(0, 0, 0)), dtype=float)
        fwd = np.array(M.TransformDir(Gf.Vec3d(0, 0, -1)), dtype=float)
        up = np.array(M.TransformDir(Gf.Vec3d(0, 1, 0)), dtype=float)
        fwd /= max(np.linalg.norm(fwd), 1e-12); up /= max(np.linalg.norm(up), 1e-12)
        center = (bounds[0] + bounds[1]) / 2.0
        radius = float(np.linalg.norm(bounds[1] - bounds[0])) / 2.0
        to_c = center - pos
        dist = float(np.linalg.norm(to_c))
        cos_a = float(np.dot(fwd, to_c / max(dist, 1e-12)))
        if cos_a > 0.6 and 0.3 * radius < dist < 200 * radius:      # sanity: it must actually look at the model
            look["camera"] = {"name": cam_prim.GetName(), "pos": pos.tolist(), "dir": fwd.tolist(), "up": up.tolist(),
                              "fov_h": math.degrees(2 * math.atan(h_ap / (2 * focal))), "focal": focal, "aperture": h_ap}
        else:
            warnings.append(f"project camera '{cam_prim.GetName()}' was ignored: it does not point at the model "
                            f"(aim {cos_a:.2f}, distance {dist / max(radius, 1e-9):.1f}x model size)")
    # ---- dome light strength (Omniverse intensities are ~1000 for "normal"; plain USD uses ~1)
    for prim in stage.Traverse():
        if prim.IsA(UsdLux.DomeLight):
            inten = _val(prim.GetAttribute("inputs:intensity"))
            expo = _val(prim.GetAttribute("inputs:exposure")) or 0.0
            raw = float(inten) if inten is not None else 1.0
            scale = (raw / 1000.0 if raw >= 100.0 else raw) * (2.0 ** float(expo))
            M = xf_cache.GetLocalToWorldTransform(prim) * to_unit
            rot = M.RemoveScaleShear().ExtractRotation().Decompose(
                Gf.Vec3d(1, 0, 0), Gf.Vec3d(0, 1, 0), Gf.Vec3d(0, 0, 1))
            look["env"] = {"intensity_raw": raw, "exposure": float(expo), "scale": scale,
                           "rotation_xyz_deg": [round(float(x), 1) for x in rot]}
            break
    return look


def default_k(mesh_name: str, tint: list[float]) -> float:
    """Thickness/attenuation ratio k so the glass or liquid comes out at a sensible brightness.
    Transmittance = tint ** k (Beer-Lambert). Thin glass walls stay light; liquids are deeper."""
    lum = 0.2126 * tint[0] + 0.7152 * tint[1] + 0.0722 * tint[2]
    if lum >= 0.98:
        return 0.0                                   # colourless
    liquid = any(w in mesh_name.lower() for w in ("liquid", "cola", "drink", "juice", "beer", "wine", "milk", "water", "fluid"))
    target = 0.22 if liquid else 0.6
    lum = max(lum, 1e-4)
    return float(min(max(math.log(target) / math.log(lum), 0.03), 1.0))


def patch_glb_glass(glb: bytes, glass: dict[str, tuple]) -> bytes:
    """Mark materials of the named nodes as transmissive (KHR_materials_transmission / ior).
    `glass` maps node name -> (transmission factor, index of refraction, tint colour, thickness ratio k)."""
    if not glass:
        return glb
    off, chunks = 12, []
    while off < len(glb):
        clen, ctype = struct.unpack_from("<II", glb, off)
        chunks.append([ctype, glb[off + 8: off + 8 + clen]])
        off += 8 + clen
    doc = json.loads(chunks[0][1].decode("utf-8").rstrip(" \x00"))
    mats = doc.get("materials", [])
    hit: dict[int, tuple] = {}
    for node in doc.get("nodes", []):
        if node.get("name") in glass and "mesh" in node:
            for prim in doc["meshes"][node["mesh"]].get("primitives", []):
                if "material" in prim:
                    hit[prim["material"]] = glass[node["name"]]
    for i, (tr, ior, tint, k) in hit.items():
        ext = mats[i].setdefault("extensions", {})
        ext["KHR_materials_transmission"] = {"transmissionFactor": float(tr)}
        ext["KHR_materials_ior"] = {"ior": float(ior)}
        if k > 0:                                    # absorption: transmittance = tint ** k
            ext["KHR_materials_volume"] = {"thicknessFactor": float(k), "attenuationDistance": 1.0,
                                           "attenuationColor": [max(float(c), 1e-4) for c in tint]}
        mats[i].setdefault("pbrMetallicRoughness", {})["metallicFactor"] = 0.0
    if hit:
        used = doc.setdefault("extensionsUsed", [])
        for e in ("KHR_materials_transmission", "KHR_materials_ior", "KHR_materials_volume"):
            if e not in used:
                used.append(e)
    raw = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    raw += b" " * (-len(raw) % 4)
    chunks[0][1] = raw
    body = b"".join(struct.pack("<II", len(d), t) + d for t, d in chunks)
    return struct.pack("<4sII", b"glTF", 2, 12 + len(body)) + body


def convert(root: Path, variants: dict | None = None) -> tuple[bytes, dict]:
    stage = Usd.Stage.Open(str(root))
    if not stage:
        raise ValueError(f"OpenUSD could not open {root.name}")
    available_variants = list_variants(stage)
    variants = dict(variants or {})
    # Grip ships three print versions (Clean / Optimized / Original). "Original" carries the complete label (claims,
    # juice badge, QR code) and is what the reference renders show, so open on it unless the user chose another.
    art = next((v for v in available_variants if v["set"] == "Artwork"), None)
    if art and "Artwork" not in variants and "original" in art["options"]:
        variants["Artwork"] = "original"
    apply_variants(stage, variants)
    for v in available_variants:                       # report what is selected now
        v["selected"] = (variants or {}).get(v["set"], v["selected"])
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
    glass_nodes: dict[str, tuple] = {}
    t0 = time.perf_counter()
    seen_names: dict[str, int] = {}
    pred = Usd.TraverseInstanceProxies(Usd.PrimDefaultPredicate)
    skipped: list[dict] = []          # parts that are not shown, and why (reported to the viewer)
    for prim in stage.Traverse(pred):
        if not prim.IsA(UsdGeom.Mesh):
            if prim.IsA(UsdGeom.Gprim):
                skipped.append({"part": prim.GetName(), "path": str(prim.GetPath()),
                                "why": f"unsupported shape type {prim.GetTypeName()}", "problem": True})
            continue
        img = UsdGeom.Imageable(prim)
        if img.ComputeVisibility() == UsdGeom.Tokens.invisible:
            skipped.append({"part": prim.GetName(), "path": str(prim.GetPath()), "why": "hidden in this state", "problem": False})
            continue
        if img.ComputePurpose() in (UsdGeom.Tokens.guide, UsdGeom.Tokens.proxy):
            skipped.append({"part": prim.GetName(), "path": str(prim.GetPath()),
                            "why": f"purpose={img.ComputePurpose()}", "problem": False})
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
            skipped.append({"part": prim.GetName(), "path": str(prim.GetPath()), "why": f"error {type(e).__name__}: {e}", "problem": True})
            continue
        if tm is None:
            skipped.append({"part": prim.GetName(), "path": str(prim.GetPath()), "why": "no triangles (empty mesh)", "problem": True})
            continue
        name = prim.GetName()
        seen_names[name] = seen_names.get(name, 0) + 1
        if seen_names[name] > 1:
            name = f"{name}_{seen_names[name]}"
        scene.add_geometry(tm, node_name=name, geom_name=name)
        if material.get("glass"):
            tint = material.get("tint_lin") or [1.0, 1.0, 1.0]
            material.setdefault("_k", {})[name] = default_k(name, tint)
            glass_nodes[name] = (material.get("transmission", 1.0), material.get("ior", 1.45), tint, material["_k"][name])
        print(f"[material] {name:32s} mat={material.get('name')} glass={bool(material.get('glass'))} "
              f"transmission={material.get('transmission')} ior={material.get('ior')} depth={material.get('depth')} "
              f"tint_fallback={material.get('tc_fallback')} tint_mean_sRGB={material.get('tint_srgb')} "
              f"tint_alpha_min={material.get('tint_alpha_min')} base={[round(c, 3) for c in material['base']]} "
              f"texture={material.get('image') is not None} opacity_map={material.get('opacity') is not None}", flush=True)
        diag.append({"tint": material.get("tint_srgb"), "tint_lin": material.get("tint_lin"),
                     "k": (material.get("_k") or {}).get(name), "mesh": name, "material": material.get("name"), "texture": material.get("image") is not None, "atlas": bool(material.get("atlas")), "glass": bool(material.get("glass")),
                     "uv": material.get("uv"), "alpha": bool(material.get("alpha"))})
        n_meshes += 1; n_tris += len(tm.faces)

    if not n_meshes:
        raise ValueError(
            f"OpenUSD composed '{root.name}' but found no visible meshes. "
            "Check that the referenced/payload files (e.g. resources/layers/geometry.usdc) were included.")
    t1 = time.perf_counter()
    glb = patch_glb_glass(scene.export(file_type="glb"), glass_nodes)
    print(f"[convert] {root.name}: {n_meshes} meshes, {n_tris} tris, meshes+materials {t1 - t0:.1f}s, "
          f"export {time.perf_counter() - t1:.1f}s, glb {len(glb) / 1e6:.1f} MB", flush=True)
    env_info = None
    env_path = find_environment(stage)
    if env_path:
        data = encode_environment(env_path)
        if data:
            eid = uuid.uuid4().hex
            if len(ENV_CACHE) >= 6:
                ENV_CACHE.pop(next(iter(ENV_CACHE)))
            ENV_CACHE[eid] = data
            env_info = {"id": eid, "w": 1024, "h": 512, "name": Path(env_path).name}
    look = {}
    try:
        look = extract_look(stage, xf_cache, to_unit, scene.bounds, warnings)
    except Exception as e:  # noqa: BLE001
        warnings.append(f"project camera/lighting not read: {type(e).__name__}: {e}")
    print(f"[look] {json.dumps(look)[:300]}", flush=True)
    bad = [x for x in skipped if x["problem"]]
    if bad:
        warnings.append(f"{len(bad)} part(s) could not be shown: " +
                        ", ".join(f"{x['part']} ({x['why']})" for x in bad[:6]))
    for x in skipped:
        print(f"[skipped] {x['path']}: {x['why']}", flush=True)
    unresolved = []
    try:
        _, _, unresolved = UsdUtils.ComputeAllDependencies(str(root))
    except Exception:
        pass
    if unresolved:
        names = sorted({Path(u).name for u in unresolved})
        warnings.append(f"{len(names)} referenced file(s) not included in the upload (e.g. {names[0]})")
    return glb, {"root": root.name, "meshes": n_meshes, "triangles": n_tris, "warnings": sorted(set(warnings))[:20], "meshes": diag, "version": VERSION,
                "variants": available_variants, "env": env_info, "skipped": skipped[:60], "look": look}
