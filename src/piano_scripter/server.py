"""Local-only FastAPI server. Binds to 127.0.0.1 — audio never leaves the machine."""

from __future__ import annotations

import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import structlog
from fastapi import FastAPI, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import pipeline, score, transcribe, ultra
from .transcribe import DEFAULT_EFFORT, EFFORTS, SAMPLE_RATE

log = structlog.get_logger()

STATIC_DIR = Path(__file__).parent / "static"
LIVE_CONTEXT_SECONDS = 2.0  # reprocessed tail: lets note offsets refine on later passes
LIVE_MIN_NEW_SECONDS = 0.3  # skip a pass when almost no new audio arrived
LIVE_ENGRAVE_INTERVAL = 3.0  # seconds between engraved-draft refreshes

app = FastAPI(title="PianoScripter", docs_url=None, redoc_url=None)

_work_root = Path(tempfile.mkdtemp(prefix="piano-scripter-"))


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
    # keyed by (pitch, onset in 50 ms ticks): re-detections refine still-sounding notes
    events: dict[tuple[int, int], transcribe.NoteEvent] = field(default_factory=dict)
    bpm: float | None = None
    svg_pages: list[str] = field(default_factory=list)
    last_engrave: float = 0.0
    engraved_notes: int = 0
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
        "cached_efforts": [e for e in EFFORTS if e in job.cache],
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
    if effort not in EFFORTS:
        raise HTTPException(status_code=422, detail=f"effort must be one of {sorted(EFFORTS)}")
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
    if effort is not None and effort not in EFFORTS:
        raise HTTPException(status_code=422, detail=f"effort must be one of {sorted(EFFORTS)}")
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
    """Decode the recording so far; run Basic Pitch on the trailing window (~50x real-time)."""
    audio_path = session.dir / "live.webm"
    audio_path.write_bytes(blob)
    audio = transcribe.load_audio(audio_path)
    if len(audio) - session.processed_samples < LIVE_MIN_NEW_SECONDS * SAMPLE_RATE:
        return
    start = max(0, session.processed_samples - int(LIVE_CONTEXT_SECONDS * SAMPLE_RATE))
    # melodia_trick off: it invents onset-less notes, re-triggering held notes every pass
    notes = ultra.transcribe_events(audio[start:], melodia_trick=False)
    offset = start / SAMPLE_RATE
    for n in notes:
        event = transcribe.NoteEvent(n.onset + offset, n.offset + offset, n.pitch, n.velocity)
        tick = round(event.onset * 20)
        keys = ((n.pitch, tick), (n.pitch, tick - 1), (n.pitch, tick + 1))
        key = next((k for k in keys if k in session.events), keys[0])
        session.events[key] = event
    session.processed_samples = len(audio)
    if session.bpm is None and len(audio) >= SAMPLE_RATE * 5:
        session.bpm = transcribe.estimate_tempo(audio)

    now = time.monotonic()
    stale = len(session.events) != session.engraved_notes
    if session.events and stale and now - session.last_engrave >= LIVE_ENGRAVE_INTERVAL:
        qnotes = score.quantize(list(session.events.values()), session.bpm or 120.0)
        session.svg_pages = pipeline.draft_svgs(qnotes, session.bpm or 120.0, session.dir)
        session.last_engrave = now
        session.engraved_notes = len(session.events)


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
    events = sorted(session.events.values(), key=lambda n: (n.onset, n.pitch))
    return {
        "svg_pages": session.svg_pages,
        "notes": [[round(n.onset, 3), round(n.offset, 3), n.pitch, n.velocity] for n in events],
        "n_notes": len(events),
        "processed_seconds": session.processed_samples / SAMPLE_RATE,
    }


@app.delete("/api/live/{session_id}")
async def live_end(session_id: str):
    _live.pop(session_id, None)
    return {"ok": True}


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
