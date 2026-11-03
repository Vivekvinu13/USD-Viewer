# 3D Viewer (USD · glTF · Collada · OBJ · FBX · STL · PLY)

A lightweight website for opening 3D files in the browser — no Omniverse, no install.
Everything runs client-side (Three.js); files are **never uploaded** anywhere.

## Run

```bash
cd usd-viewer
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/ – host on any static host (Netlify, GitHub Pages, S3, nginx…)
```

## Use
Drag & drop a file (or a whole folder) onto the page, or click **Open file…**. Click **Load sample** for a demo.
For formats with sidecar files (OBJ + `.mtl`, glTF + `.bin`/textures, textures for USD/DAE) select/drop them together.

Viewer controls: orbit / pan / zoom, grid, wireframe, axes, auto-rotate, Z-up→Y-up fix, double-sided, background,
light level, fit view, PNG screenshot, glTF/Collada/FBX animation playback, and model stats.

## Supported formats
`.usd` `.usda` `.usdc` `.usdz` · `.gltf` `.glb` (Draco/Meshopt) · `.dae` · `.obj` (+`.mtl`) · `.fbx` · `.stl` · `.ply` · `.3mf` · `.wrl`

## USD limitations
USD is parsed in-browser by Three.js's `USDLoader`. It handles meshes, transforms, hierarchy, common
`UsdPreviewSurface` materials and textures, and `.usdz` packages, but it is not full OpenUSD:
heavy composition (cross-file references/payloads/variants), Omniverse-specific MDL materials, and
RTX path-traced lighting are not supported. Primitive shapes (`Cube`/`Sphere`/…) ignore `displayColor`.
Tip: packaging as `.usdz` (self-contained) gives the best results. For full-fidelity USD, a server-side
`usd-core` conversion to glTF could be added.

## Full-fidelity USD (recommended for Omniverse / Arnold / production assets)
Real-world USD projects use payloads, nested variants, layered materials and large binary `.usdc` files that a
browser-only loader can't compose. The optional server uses real OpenUSD (`usd-core`) to compose the scene and
streams back a GLB that the viewer renders. The viewer detects it automatically and falls back to the in-browser
loader when it isn't running.

```bash
cd usd-viewer
npm install && npm run build                 # once (the zip already includes dist/)
pip install -r server/requirements.txt
python server/app.py                         # http://localhost:8000  (site + API)
```
Drop a **folder** or **.zip** of the whole USD project (root layer + `resources/…`). The root layer is detected
automatically. Textures in `.exr` can't be shown in GLB and fall back to the material's base colour.

## Look & lighting
- **Lighting** presets (Studio / Soft room), **ground shadow**, light and exposure sliders.
- **Path tracing** (checkbox): a progressive, photo-like render using your graphics card (`three-gpu-pathtracer`).
  The image starts noisy and sharpens while you leave the camera still; moving the camera restarts it.
  It needs a reasonably modern GPU; on weak hardware keep it off.
- **Layers** panel: show/hide each mesh. Hover a layer to see which material, texture and UV set it uses.

## Grip artwork textures
Grip's artwork images are 2×2 atlases (label colour / reflection+gloss+metalness / opacity / normal map).
The converter decodes them the same way Grip's `artwork_texture` shader does, using the material's own
`roughness_black`, `base_color_black/white` and `use_refractive_artwork` settings.

## Configurations, artwork and lighting (USD projects with Grip-style variants)
- **State**: Dry / Wet / Open cap · dry / Open cap · wet. These switch the file's own `Visibility` variant on the
  server, so the right cap and droplet meshes appear. Droplets are exported as transmissive glass.
- **Artwork file**: Clean / Optimized / Original (the file's `Artwork` variant).
- **Show artwork**: untick to see the bare aluminium can.
- **Lighting**: Bright studio, Dark studio, Soft room, and *Grip studio (from file)* when the project has a
  DomeLight image. **Light angle** rotates the environment.

## Glass and liquids
Transmissive materials (bottles, liquids, droplets) use the material's *transmission colour* texture as their tint,
plus its real index of refraction. A model with clear glass opens on a white background. In the normal view an
object nested inside another transmissive object (liquid in a bottle) is shown as a tinted solid; **Path tracing**
renders true refraction. Big textures are downsampled to 2048 px while decoding, and switching Wet/Dry reuses the
files already on the server, so it no longer re-uploads or re-decodes them.
