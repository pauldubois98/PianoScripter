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

# "ultra" runs Spotify's tiny Basic Pitch model (see ultra.py): ~50x real-time, roughest.
# The other tiers = ByteDance segment hop fraction. Inference runs 10 s windows; smaller
# hop means more overlapping passes averaged together: better predictions, slower.
EFFORT_HOP = {"fast": 1.0, "balanced": 0.5, "best": 0.25}
EFFORTS = ("ultra", *EFFORT_HOP)
DEFAULT_EFFORT = "balanced"

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


def trim_silence(audio: np.ndarray) -> np.ndarray:
    """Drop leading/trailing silence so the score starts on the first note."""
    trimmed, _ = librosa.effects.trim(audio, top_db=35)
    return trimmed


def estimate_tempo(audio: np.ndarray) -> float:
    tempo, _ = librosa.beat.beat_track(y=audio, sr=SAMPLE_RATE)
    bpm = float(np.atleast_1d(tempo)[0])
    if not 40 <= bpm <= 220:
        bpm = 120.0
    return round(bpm, 1)


def _run_model(transcriptor, audio: np.ndarray, hop_fraction: float) -> dict:
    """Windowed inference with overlap-averaged predictions (hop controls the effort)."""
    from piano_transcription_inference.pytorch_utils import forward

    segment = transcriptor.segment_samples
    samples_per_frame = SAMPLE_RATE // transcriptor.frames_per_second
    seg_frames = segment // samples_per_frame

    x = audio[None, :].astype(np.float32)
    if x.shape[1] < segment:
        x = np.concatenate([x, np.zeros((1, segment - x.shape[1]), dtype=np.float32)], axis=1)
    hop = int(segment * hop_fraction)
    starts = list(range(0, x.shape[1] - segment + 1, hop))
    if starts[-1] + segment < x.shape[1]:
        starts.append(x.shape[1] - segment)

    segments = np.concatenate([x[:, s : s + segment] for s in starts], axis=0)
    raw = forward(transcriptor.model, segments, batch_size=1)

    window = (np.hanning(seg_frames) + 1e-2)[:, None]  # de-emphasize segment edges
    n_frames = starts[-1] // samples_per_frame + seg_frames
    output_dict = {}
    for key, val in raw.items():
        val = val[:, :seg_frames, :]  # drop the extra spectrogram frame (center=True)
        acc = np.zeros((n_frames, val.shape[2]), dtype=np.float32)
        weight = np.zeros((n_frames, 1), dtype=np.float32)
        for i, s in enumerate(starts):
            f = s // samples_per_frame
            acc[f : f + seg_frames] += val[i] * window
            weight[f : f + seg_frames] += window
        output_dict[key] = acc / weight
    return output_dict


def _postprocess(
    transcriptor, output_dict: dict, midi_path: Path | None
) -> tuple[list[dict], list[dict]]:
    from piano_transcription_inference.utilities import (
        RegressionPostProcessor,
        write_events_to_midi,
    )

    post = RegressionPostProcessor(
        transcriptor.frames_per_second,
        classes_num=transcriptor.classes_num,
        onset_threshold=transcriptor.onset_threshold,
        offset_threshold=transcriptor.offset_threshod,  # upstream typo
        frame_threshold=transcriptor.frame_threshold,
        pedal_offset_threshold=transcriptor.pedal_offset_threshold,
    )
    note_events, pedal_events = post.output_dict_to_midi_events(output_dict)
    if midi_path:
        write_events_to_midi(0, note_events, pedal_events, str(midi_path))
    return note_events, pedal_events


def transcribe_array(
    audio: np.ndarray, effort: str = DEFAULT_EFFORT, midi_path: Path | None = None
) -> tuple[list[NoteEvent], list[dict]]:
    """Audio samples (16 kHz mono) -> sorted note events + pedal events."""
    if effort not in EFFORTS:
        raise ValueError(f"effort must be one of {sorted(EFFORTS)}, got {effort!r}")
    if effort == "ultra":
        from . import ultra  # deferred: avoids a circular import

        return ultra.transcribe_events(audio), []
    transcriptor = _get_transcriptor()
    output_dict = _run_model(transcriptor, audio, EFFORT_HOP[effort])
    note_events, pedal_events = _postprocess(transcriptor, output_dict, midi_path)
    notes = [
        NoteEvent(
            onset=float(e["onset_time"]),
            offset=float(e["offset_time"]),
            pitch=int(e["midi_note"]),
            velocity=int(e["velocity"]),
        )
        for e in note_events
    ]
    notes.sort(key=lambda n: (n.onset, n.pitch))
    return notes, pedal_events


def transcribe(
    audio_path: Path, midi_path: Path | None = None, effort: str = DEFAULT_EFFORT
) -> TranscriptionResult:
    """Run the full audio -> note-events step and optionally write raw performance MIDI."""
    if effort not in EFFORTS:
        raise ValueError(f"effort must be one of {sorted(EFFORTS)}, got {effort!r}")
    audio = trim_silence(load_audio(audio_path))
    duration = len(audio) / SAMPLE_RATE
    tempo = estimate_tempo(audio)
    log.info("transcribing", duration_s=round(duration, 1), tempo_bpm=tempo, effort=effort)

    notes, pedal_events = transcribe_array(audio, effort, midi_path)
    log.info("transcribed", n_notes=len(notes))
    return TranscriptionResult(
        notes=notes,
        pedals=pedal_events,
        tempo_bpm=tempo,
        duration=duration,
    )
