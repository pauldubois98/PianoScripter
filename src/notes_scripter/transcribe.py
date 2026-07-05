"""Audio -> note events, entirely on-device (ByteDance high-resolution piano model)."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

import librosa
import numpy as np
import structlog

log = structlog.get_logger()

SAMPLE_RATE = 16000  # the model's expected sample rate

_transcriptor = None  # lazily-loaded singleton (the checkpoint is ~165 MB)


@dataclass
class NoteEvent:
    onset: float  # seconds
    offset: float  # seconds
    pitch: int  # MIDI note number
    velocity: int


@dataclass
class TranscriptionResult:
    notes: list[NoteEvent]
    pedals: list[dict]
    tempo_bpm: float
    duration: float  # seconds


def _get_transcriptor():
    global _transcriptor
    if _transcriptor is None:
        import torch
        from piano_transcription_inference import PianoTranscription

        log.info("loading_model", note="first call downloads the ~165 MB checkpoint")
        _transcriptor = PianoTranscription(device=torch.device("cpu"))
    return _transcriptor


def load_audio(path: Path) -> np.ndarray:
    """Decode any audio format to 16 kHz mono float32, via ffmpeg when available."""
    if shutil.which("ffmpeg"):
        with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
            subprocess.run(
                ["ffmpeg", "-y", "-i", str(path), "-ac", "1", "-ar", str(SAMPLE_RATE), tmp.name],
                check=True,
                capture_output=True,
            )
            audio, _ = librosa.load(tmp.name, sr=SAMPLE_RATE, mono=True)
    else:
        audio, _ = librosa.load(str(path), sr=SAMPLE_RATE, mono=True)
    return audio


def estimate_tempo(audio: np.ndarray) -> float:
    tempo, _ = librosa.beat.beat_track(y=audio, sr=SAMPLE_RATE)
    bpm = float(np.atleast_1d(tempo)[0])
    if not 40 <= bpm <= 220:
        bpm = 120.0
    return round(bpm, 1)


def transcribe(audio_path: Path, midi_path: Path | None = None) -> TranscriptionResult:
    """Run the full audio -> note-events step and optionally write raw performance MIDI."""
    audio = load_audio(audio_path)
    duration = len(audio) / SAMPLE_RATE
    tempo = estimate_tempo(audio)
    log.info("transcribing", duration_s=round(duration, 1), tempo_bpm=tempo)

    result = _get_transcriptor().transcribe(audio, str(midi_path) if midi_path else None)
    notes = [
        NoteEvent(
            onset=float(e["onset_time"]),
            offset=float(e["offset_time"]),
            pitch=int(e["midi_note"]),
            velocity=int(e["velocity"]),
        )
        for e in result["est_note_events"]
    ]
    notes.sort(key=lambda n: (n.onset, n.pitch))
    log.info("transcribed", n_notes=len(notes))
    return TranscriptionResult(
        notes=notes,
        pedals=result["est_pedal_events"],
        tempo_bpm=tempo,
        duration=duration,
    )
