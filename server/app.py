"""3D Viewer server: serves the built site and converts USD projects to GLB with real OpenUSD.

    pip install -r server/requirements.txt
    npm run build
    python server/app.py            # http://localhost:8000
"""
from __future__ import annotations

import asyncio
import gc
import json
import shutil
import tempfile
import time
import uuid
import zipfile
from pathlib import Path, PurePosixPath

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from starlette.concurrency import run_in_threadpool
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from usd_to_glb import ENV_CACHE, VERSION, _img_cache, convert, pick_root

ROOT = Path(__file__).resolve().parent.parent
MAX_BYTES = 2 * 1024**3
app = FastAPI(title="3D Viewer API")

CONVERT_SLOT = asyncio.Semaphore(1)      # one conversion at a time: big projects use lots of memory
PROJECTS: dict[str, dict] = {}        # id -> {"dir": Path, "t": last use}; lets a state switch skip the re-upload
PROJECT_TTL = 3600
MAX_PROJECTS = 3


def _evict() -> None:
    now = time.time()
    gone = [k for k, v in PROJECTS.items() if now - v["t"] > PROJECT_TTL]
    while len(PROJECTS) - len(gone) > MAX_PROJECTS:
        gone.append(min((k for k in PROJECTS if k not in gone), key=lambda k: PROJECTS[k]["t"]))
    for pid in gone:
        shutil.rmtree(PROJECTS.pop(pid)["dir"], ignore_errors=True)
    if gone:
        _img_cache.clear()                 # cached textures may point into deleted folders


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
async def convert_usd(request: Request, files: list[UploadFile] = File(default=[]), paths: list[str] = Form(default=[]),
                      variants: str = Form(default=""), project: str = Form(default="")):
    _evict()
    reuse = PROJECTS.get(project) if project else None
    if project and not reuse:
        raise HTTPException(410, "project expired")          # client re-sends the files
    work = reuse["dir"] if reuse else Path(tempfile.mkdtemp(prefix="usdconv-"))
    ok = False
    try:
        total = 0
        for i, up in enumerate([] if reuse else files):
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
                    if len(z.infolist()) > 20000 or sum(i.file_size for i in z.infolist()) > 2 * MAX_BYTES:
                        raise HTTPException(413, "Archive too large when unpacked")        # zip-bomb guard
                    for n in z.namelist():
                        _safe(n)                      # zip-slip guard
                    z.extractall(work)
                dest.unlink()
        try:
            sel = json.loads(variants) if variants else {}
        except ValueError:
            sel = {}
        sel = {str(k): str(v) for k, v in sel.items()} if isinstance(sel, dict) else {}
        pid = project or uuid.uuid4().hex
        PROJECTS[pid] = {"dir": work, "t": time.time()}        # kept so a retry or state switch need not re-upload
        ok = True
        async with CONVERT_SLOT:                                # queue behind any running conversion
            if await request.is_disconnected():                 # the user already gave up on this request
                raise HTTPException(499, "client closed the request")
            try:
                root = await run_in_threadpool(pick_root, work)
                glb, info = await run_in_threadpool(convert, root, sel)
            except HTTPException:
                raise
            except MemoryError as e:
                raise HTTPException(507, "The server ran out of memory converting this project. Close other programs "
                                         "or use a machine with more RAM.") from e
            except Exception as e:  # noqa: BLE001
                raise HTTPException(422, f"{type(e).__name__}: {e}" if str(e) else type(e).__name__) from e
            finally:
                gc.collect()
        info["project"] = pid
        return Response(glb, media_type="model/gltf-binary", headers={"X-Convert-Info": json.dumps(info)})
    finally:
        if not ok and not reuse:
            shutil.rmtree(work, ignore_errors=True)


@app.get("/api/env/{env_id}")
def get_env(env_id: str):
    data = ENV_CACHE.get(env_id)
    if data is None:
        raise HTTPException(404, "environment expired")
    return Response(data, media_type="application/octet-stream")


dist = ROOT / "dist"
if dist.is_dir():
    app.mount("/", StaticFiles(directory=dist, html=True), name="site")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
