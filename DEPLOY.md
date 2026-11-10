# Hosting the 3D Viewer internally (note for IT)

A browser-based viewer for packaging 3D files (USD, glTF, OBJ, FBX …) and artwork (PNG, PDF, TIFF) that rolls label artwork onto default cans and bottles.

## What runs
One Docker container, no database, no external services, no outbound calls.
- Serves the website and a small Python API (FastAPI + OpenUSD) that converts USD files for the browser.
- Image, PDF, TIFF, glTF and OBJ files are processed in the user's browser and never reach the server.
- USD files are uploaded to the container, converted in a temporary folder, and deleted automatically after 1 hour (at most 3 projects are kept). Stopping the container clears everything. Nothing is logged or sent elsewhere.

## Build and run
```
git clone https://github.com/Vivekvinu13/USD-Viewer.git
cd USD-Viewer
docker build -t usd-viewer .
docker run -d --name usd-viewer --restart unless-stopped -p 8000:8000 usd-viewer
```
Health check: `GET /api/health` returns `{"ok":true,...}`. The container listens on `PORT` (default 8000).

## Sizing
- Suggested: 2 vCPU and 4 GB RAM or more (large USD packages with EXR textures are memory-heavy).
- One USD conversion runs at a time; others queue.
- Needs no persistent storage.

## Security recommendations
- The app has **no login**. Put it behind your reverse proxy / SSO (or VPN) so only employees can reach it.
- Serve over HTTPS at the proxy and set a request-size limit that fits your largest USD packages.
- Base images are `node:22-slim` (build only) and `python:3.12-slim`; Python dependencies are listed in `server/requirements.txt`.
