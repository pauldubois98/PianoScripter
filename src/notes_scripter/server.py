"""Local-only FastAPI server. Binds to 127.0.0.1 — audio never leaves the machine."""

from __future__ import annotations

import tempfile
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import structlog
from fastapi import FastAPI, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import pipeline, score, transcribe
from .transcribe import DEFAULT_EFFORT, EFFORT_HOP, SAMPLE_RATE

log = structlog.get_logger()

STATIC_DIR = Path(__file__).parent / "static"
LIVE_BLOCK_SAMPLES = SAMPLE_RATE * 10  # the model's native 10 s window

app = FastAPI(title="NotesScripter", docs_url=None, redoc_url=None)

_work_root = Path(tempfile.mkdtemp(prefix="notes-scripter-"))


@dataclass
class Job:
    dir: Path
    audio_path: Path
    effort: str
    duration: float = 0.0
    title: str = "Transcription"
    author: str = ""
    bpm_override: float | None = None
    out: pipeline.PipelineOutput | None = None
    # model output per effort level: switching back to a computed effort is instant
    cache: dict[str, transcribe.TranscriptionResult] = field(default_factory=dict)
    lock: threading.Lock = field(default_factory=threading.Lock)


@dataclass
class LiveSession:
    dir: Path
    processed_samples: int = 0
    events: list[transcribe.NoteEvent] = field(default_factory=list)
    bpm: float | None = None
    svg_pages: list[str] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)


_jobs: dict[str, Job] = {}
_live: dict[str, LiveSession] = {}

_DOWNLOADS = {
    "midi": ("midi", "transcription.mid", "audio/midi"),
    "musicxml": ("musicxml", "transcription.musicxml", "application/vnd.recordare.musicxml+xml"),
    "pdf": ("pdf", "transcription.pdf", "application/pdf"),
}


def _job_payload(job_id: str, job: Job) -> dict:
    return {
        "id": job_id,
        "effort": job.effort,
        "cached_efforts": [e for e in EFFORT_HOP if e in job.cache],
        "svg_pages": job.out.svg_pages,
        "tempo_bpm": job.out.tempo_bpm,
        "key": job.out.key,
        "n_notes": job.out.n_notes,
        "duration": round(job.duration, 1),
        "title": job.title,
        "author": job.author,
    }


def _apply_update(job: Job, effort: str | None = None) -> None:
    """Blocking: run the model if this effort is new, then re-engrave all outputs."""
    with job.lock:
        if effort:
            if effort not in job.cache:
                job.cache[effort] = transcribe.transcribe(job.audio_path, effort=effort)
            job.effort = effort
        res = job.cache[job.effort]
        bpm = job.bpm_override or res.tempo_bpm
        qnotes = score.quantize(res.notes, bpm)
        out = pipeline.rebuild(qnotes, bpm, job.dir, title=job.title, composer=job.author)
        out.duration = res.duration
        job.out = out
        job.duration = res.duration


@app.post("/api/transcribe")
async def transcribe_endpoint(
    file: UploadFile,
    effort: str = Form(DEFAULT_EFFORT),
    title: str = Form("Transcription"),
    author: str = Form(""),
):
    if effort not in EFFORT_HOP:
        raise HTTPException(status_code=422, detail=f"effort must be one of {sorted(EFFORT_HOP)}")
    title = title.strip() or "Transcription"
    author = author.strip()
    job_id = uuid.uuid4().hex[:12]
    job_dir = _work_root / job_id
    job_dir.mkdir(parents=True)
    suffix = Path(file.filename or "audio").suffix or ".webm"
    audio_path = job_dir / f"input{suffix}"
    audio_path.write_bytes(await file.read())
    log.info("job_received", job=job_id, filename=file.filename, effort=effort)

    job = Job(dir=job_dir, audio_path=audio_path, effort=effort, title=title, author=author)
    try:
        await run_in_threadpool(_apply_update, job, effort)
    except Exception:
        log.exception("job_failed", job=job_id)
        raise HTTPException(status_code=500, detail="Transcription failed") from None

    _jobs[job_id] = job
    return _job_payload(job_id, job)


@app.post("/api/jobs/{job_id}/update")
async def update_job(
    job_id: str,
    title: str = Form("Transcription"),
    author: str = Form(""),
    bpm: float | None = Form(None),
    effort: str | None = Form(None),
):
    """Re-engrave with new title/author/BPM and/or rerun the model at another effort."""
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404)
    if effort is not None and effort not in EFFORT_HOP:
        raise HTTPException(status_code=422, detail=f"effort must be one of {sorted(EFFORT_HOP)}")
    job.title = title.strip() or "Transcription"
    job.author = author.strip()
    if bpm is not None:
        job.bpm_override = min(max(bpm, 20.0), 300.0)
    try:
        await run_in_threadpool(_apply_update, job, effort)
    except Exception:
        log.exception("job_update_failed", job=job_id)
        raise HTTPException(status_code=500, detail="Update failed") from None
    return _job_payload(job_id, job)


@app.get("/api/download/{job_id}/{kind}")
async def download(job_id: str, kind: str):
    if job_id not in _jobs or kind not in _DOWNLOADS:
        raise HTTPException(status_code=404)
    attr, filename, media_type = _DOWNLOADS[kind]
    path: Path = getattr(_jobs[job_id].out, attr)
    return FileResponse(path, filename=filename, media_type=media_type)


@app.post("/api/live/start")
async def live_start():
    session_id = uuid.uuid4().hex[:12]
    session_dir = _work_root / f"live-{session_id}"
    session_dir.mkdir(parents=True)
    _live[session_id] = LiveSession(dir=session_dir)
    log.info("live_started", session=session_id)
    return {"id": session_id}


def _live_process(session: LiveSession, blob: bytes) -> None:
    """Decode the full recording so far; transcribe any new complete 10 s blocks."""
    audio_path = session.dir / "live.webm"
    audio_path.write_bytes(blob)
    audio = transcribe.load_audio(audio_path)
    while len(audio) - session.processed_samples >= LIVE_BLOCK_SAMPLES:
        start = session.processed_samples
        block = audio[start : start + LIVE_BLOCK_SAMPLES]
        notes, _ = transcribe.transcribe_array(block, effort="fast")
        offset = start / SAMPLE_RATE
        for n in notes:
            session.events.append(
                transcribe.NoteEvent(n.onset + offset, n.offset + offset, n.pitch, n.velocity)
            )
        session.processed_samples += LIVE_BLOCK_SAMPLES
        if session.bpm is None:
            session.bpm = transcribe.estimate_tempo(audio[: session.processed_samples])
    if session.events:
        qnotes = score.quantize(session.events, session.bpm or 120.0)
        session.svg_pages = pipeline.draft_svgs(qnotes, session.bpm or 120.0, session.dir)


@app.post("/api/live/{session_id}/chunk")
async def live_chunk(session_id: str, file: UploadFile):
    session = _live.get(session_id)
    if session is None:
        raise HTTPException(status_code=404)
    blob = await file.read()
    if session.lock.acquire(blocking=False):  # still busy? just return the current draft
        try:
            await run_in_threadpool(_live_process, session, blob)
        except Exception:
            log.exception("live_chunk_failed", session=session_id)
        finally:
            session.lock.release()
    return {
        "svg_pages": session.svg_pages,
        "n_notes": len(session.events),
        "processed_seconds": session.processed_samples / SAMPLE_RATE,
    }


@app.delete("/api/live/{session_id}")
async def live_end(session_id: str):
    _live.pop(session_id, None)
    return {"ok": True}


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
