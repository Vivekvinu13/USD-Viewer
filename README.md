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

## Open anything
Drop any file. Files are recognised by name **or by content**, so a misnamed `.dat` that is really a JPEG, or an OBJ with no
extension, still opens. Images (PNG, JPG, GIF, WebP, BMP, SVG, EXR, HDR) and PDFs are shown as flat sheets in the 3D
scene. Things with no 3D or picture form (Word, Excel, random binaries) get a clear message instead.

## Supported formats
`.usd` `.usda` `.usdc` `.usdz` · `.gltf` `.glb` (Draco/Meshopt) · `.dae` · `.obj` (+`.mtl`) · `.fbx` · `.stl` · `.ply` · `.3mf` · `.wrl` · `.3ds` · `.amf` · `.kmz` · point clouds `.pcd` `.xyz` · images · PDF

## USD limitations
USD is parsed in-browser by Three.js's `USDLoader`. It handles meshes, transforms, hierarchy, common
`UsdPreviewSurface` materials and textures, and `.usdz` packages, but it is not full OpenUSD:
heavy composition (cross-file references/payloads/variants), Omniverse-specific MDL materials, and
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
object nested inside another transmissive object (liquid in a bottle) is shown as a tinted solid; Big textures are downsampled to 2048 px while decoding, and switching Wet/Dry reuses the
files already on the server, so it no longer re-uploads or re-decodes them.

### Why dark transmission colours are normal
Grip's `transmission_color` is an *absorption* colour (the colour reached after light has travelled through the
material), so values like (0.01, 0.07, 0.015) are expected for thin green glass. The converter turns it into glTF
`KHR_materials_volume` (transmittance = tint ^ k). `k` is chosen so glass stays light and liquids stay deeper; the
**Glass/liquid tint** slider scales it.

## Performance notes
Meshes are triangulated and welded with vectorised NumPy (a 3M-triangle bottle converts in ~7 s and ~1.5 GB, with a GLB
~4x smaller than before); EXR textures are decoded and downsampled a few rows at a time; opaque textures are stored as
JPEG; only one conversion runs at a time (others wait in a queue), off the web server's main thread; a request the
browser has abandoned is skipped. If a conversion runs out of memory the server now says so instead of an empty error.

## Reference render and skipped parts
If a project ships a picture of the intended look (a `render/`, `reference/` or `preview/` folder, or a file named like
`render`, `preview`, `beauty`), the viewer shows it in a **Reference render** card with an *Overlay on 3D view* option, so
the 3D can be compared against it. A reference image cannot be turned into 3D geometry; it is a visual target only.
Parts the converter could not show (unsupported shape types, empty meshes, errors) are listed in the Notes line, and every
part hidden by the current state is listed in 
## Project camera and lighting ("Grip camera")
The converter reads the project's own camera (position, direction, lens, aperture) and its dome-light strength from the
composed USD. The viewer opens on that camera (**Fit view** frames the model automatically), keeps the lens correct when the window is resized, and scales the *Grip studio* lighting by the file's
dome intensity (Omniverse-style values such as 1136 are read as ×1.136). A camera that does not point at the model is
ignored with a note. The dome's *rotation* is read and listed in convention cannot be verified without Omniverse); use the **Light angle** slider to turn the lighting.

## Sharp label artwork
Ordinary textures are capped at 2048 px for speed, but Grip's artwork sheet (four quarters, each spanning the whole can) is
read at up to 4096 px, so the label colour quarter is 2048 px and fine print stays legible. The viewer also uses the
maximum texture anisotropy so small text stays readable on curved or angled surfaces.


## Label transparency
The artwork's opacity data is cleaned (hairline gaps closed, edges softened) so specks in the print data do not show the
bare metal as thin pale lines; large genuinely transparent regions are kept.

## Thin streaks when zoomed out (depth fighting)
A printed label (and droplets) is a separate shell a hair above the surface beneath it. From a distance the depth buffer
cannot tell the two apart, so the metal flickers through as thin vertical lines that vanish when you zoom in. Label and
droplet shells are now pulled slightly toward the camera (polygon offset), and the camera's near/far range is tighter for
better depth precision.

## Default artwork and droplets
Projects that offer an *Original* artwork version open on it (it carries the complete label: claims, juice badge, QR
code); the **Artwork file** menu still switches to Clean or Optimized. Droplets and glass use a physically sized
thickness (a fraction of a millimetre for droplets, a few millimetres for glass walls) so beads look like clear water,
showing the can through them, instead of milky or mercury-like.

## Water droplets
Droplets whose shape comes from an opacity mask are cut out cleanly (alpha mask) instead of being faded like a film, which
gave frosted white blobs; they are refractive (IOR ~1.33) with a physically sized thickness, no roughness and only small
reflected glints, so they read as clear water beads that magnify the can colour beneath.
