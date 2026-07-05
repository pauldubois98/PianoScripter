"""Local-only FastAPI server. Binds to 127.0.0.1 — audio never leaves the machine."""

from __future__ import annotations

import tempfile
import uuid
from pathlib import Path

import structlog
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import pipeline

log = structlog.get_logger()

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(title="NotesScripter", docs_url=None, redoc_url=None)

_jobs: dict[str, pipeline.PipelineOutput] = {}
_work_root = Path(tempfile.mkdtemp(prefix="notes-scripter-"))

_DOWNLOADS = {
    "midi": ("midi", "transcription.mid", "audio/midi"),
    "musicxml": ("musicxml", "transcription.musicxml", "application/vnd.recordare.musicxml+xml"),
    "pdf": ("pdf", "transcription.pdf", "application/pdf"),
}


@app.post("/api/transcribe")
async def transcribe_endpoint(file: UploadFile):
    job_id = uuid.uuid4().hex[:12]
    job_dir = _work_root / job_id
    job_dir.mkdir(parents=True)
    suffix = Path(file.filename or "audio").suffix or ".webm"
    audio_path = job_dir / f"input{suffix}"
    audio_path.write_bytes(await file.read())
    log.info("job_received", job=job_id, filename=file.filename)

    try:
        out = await run_in_threadpool(pipeline.run, audio_path, job_dir)
    except Exception:
        log.exception("job_failed", job=job_id)
        raise HTTPException(status_code=500, detail="Transcription failed") from None

    _jobs[job_id] = out
    return {
        "id": job_id,
        "svg_pages": out.svg_pages,
        "tempo_bpm": out.tempo_bpm,
        "key": out.key,
        "n_notes": out.n_notes,
        "duration": round(out.duration, 1),
    }


@app.get("/api/download/{job_id}/{kind}")
async def download(job_id: str, kind: str):
    if job_id not in _jobs or kind not in _DOWNLOADS:
        raise HTTPException(status_code=404)
    attr, filename, media_type = _DOWNLOADS[kind]
    path: Path = getattr(_jobs[job_id], attr)
    return FileResponse(path, filename=filename, media_type=media_type)


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
