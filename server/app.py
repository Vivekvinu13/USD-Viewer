"""3D Viewer server: serves the built site and converts USD projects to GLB with real OpenUSD.

    pip install -r server/requirements.txt
    npm run build
    python server/app.py            # http://localhost:8000
"""
from __future__ import annotations

import json
import shutil
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from usd_to_glb import VERSION, convert, pick_root

ROOT = Path(__file__).resolve().parent.parent
MAX_BYTES = 2 * 1024**3
app = FastAPI(title="3D Viewer API")


def _safe(rel: str) -> PurePosixPath:
    p = PurePosixPath(rel.replace("\\", "/").lstrip("/"))
    if ".." in p.parts or not p.parts:
        raise HTTPException(400, f"Invalid path: {rel}")
    return p


@app.get("/api/health")
def health():
    from pxr import Usd
    return {"ok": True, "usd": ".".join(map(str, Usd.GetVersion())), "converter": VERSION}


@app.post("/api/convert")
async def convert_usd(files: list[UploadFile] = File(...), paths: list[str] = Form(default=[])):
    work = Path(tempfile.mkdtemp(prefix="usdconv-"))
    try:
        total = 0
        for i, up in enumerate(files):
            rel = _safe(paths[i] if i < len(paths) else (up.filename or f"file{i}"))
            dest = work.joinpath(*rel.parts)
            dest.parent.mkdir(parents=True, exist_ok=True)
            with dest.open("wb") as fh:
                while chunk := await up.read(1 << 20):
                    total += len(chunk)
                    if total > MAX_BYTES:
                        raise HTTPException(413, "Upload too large")
                    fh.write(chunk)
            if dest.suffix.lower() == ".zip":
                with zipfile.ZipFile(dest) as z:
                    for n in z.namelist():
                        _safe(n)                      # zip-slip guard
                    z.extractall(work)
                dest.unlink()
        try:
            root = pick_root(work)
            glb, info = convert(root)
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001
            raise HTTPException(422, str(e)) from e
        return Response(glb, media_type="model/gltf-binary", headers={"X-Convert-Info": json.dumps(info)})
    finally:
        shutil.rmtree(work, ignore_errors=True)


dist = ROOT / "dist"
if dist.is_dir():
    app.mount("/", StaticFiles(directory=dist, html=True), name="site")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
