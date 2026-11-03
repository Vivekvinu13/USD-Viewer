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
