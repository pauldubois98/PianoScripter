"""Ultra-fast audio -> note events with Spotify's Basic Pitch model (ONNX, on-device).

The model (<20k parameters, ~230 kB) runs orders of magnitude faster than the
ByteDance checkpoint, fast enough for a truly live view. Windowing and
post-processing are ported from https://github.com/spotify/basic-pitch
(Apache License 2.0, Copyright 2022 Spotify AB); the nmp.onnx model file is
downloaded from that repository on first use.
"""

from __future__ import annotations

import threading
import urllib.request
from pathlib import Path

import librosa
import numpy as np
import scipy.signal
import structlog

from .transcribe import SAMPLE_RATE, NoteEvent

log = structlog.get_logger()

MODEL_URL = (
    "https://raw.githubusercontent.com/spotify/basic-pitch/main/"
    "basic_pitch/saved_models/icassp_2022/nmp.onnx"
)
MODEL_PATH = Path.home() / ".cache" / "piano-scripter" / "nmp.onnx"

# Constants from basic_pitch/constants.py and inference.py
BP_SAMPLE_RATE = 22050
FFT_HOP = 256
AUDIO_WINDOW_LENGTH = 2  # seconds
ANNOTATIONS_FPS = BP_SAMPLE_RATE // FFT_HOP  # 86
ANNOT_N_FRAMES = ANNOTATIONS_FPS * AUDIO_WINDOW_LENGTH  # 172
AUDIO_N_SAMPLES = BP_SAMPLE_RATE * AUDIO_WINDOW_LENGTH - FFT_HOP  # 43844
N_OVERLAPPING_FRAMES = 30
OVERLAP_LEN = N_OVERLAPPING_FRAMES * FFT_HOP
HOP_SIZE = AUDIO_N_SAMPLES - OVERLAP_LEN
MAGIC_ALIGNMENT_OFFSET = 0.0018

# Constants from basic_pitch/note_creation.py
MIDI_OFFSET = 21
MAX_FREQ_IDX = 87
ONSET_THRESHOLD = 0.5
FRAME_THRESHOLD = 0.3
MIN_NOTE_LEN_FRAMES = 11  # = the default 127.7 ms at 86 fps
ENERGY_TOL = 11

_ONNX_INPUT = "serving_default_input_2:0"
_ONNX_OUTPUTS = ["StatefulPartitionedCall:1", "StatefulPartitionedCall:2"]  # note, onset

_session = None
_session_lock = threading.Lock()


def _get_session():
    global _session
    with _session_lock:
        if _session is None:
            import onnxruntime

            if not MODEL_PATH.exists():
                MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
                log.info("downloading_ultra_model", url=MODEL_URL, dest=str(MODEL_PATH))
                urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)
            _session = onnxruntime.InferenceSession(
                str(MODEL_PATH), providers=["CPUExecutionProvider"]
            )
        return _session


def _unwrap(output: np.ndarray, original_length: int) -> np.ndarray:
    """Stitch per-window frames into one (n_times, n_freqs) matrix (bp unwrap_output)."""
    n_olap = N_OVERLAPPING_FRAMES // 2
    output = output[:, n_olap:-n_olap, :]
    unwrapped = output.reshape(-1, output.shape[2])
    n_expected_windows = original_length / HOP_SIZE
    n_frames_per_window = ANNOT_N_FRAMES - N_OVERLAPPING_FRAMES
    return unwrapped[: int(n_expected_windows * n_frames_per_window)]


def _run_model(audio: np.ndarray) -> dict[str, np.ndarray]:
    """22050 Hz mono audio -> {'note','onset'} activation matrices (n_times, 88)."""
    session = _get_session()
    original_length = len(audio)
    padded = np.concatenate(
        [np.zeros(OVERLAP_LEN // 2, dtype=np.float32), audio.astype(np.float32)]
    )
    windows = []
    for i in range(0, len(padded), HOP_SIZE):
        w = padded[i : i + AUDIO_N_SAMPLES]
        if len(w) < AUDIO_N_SAMPLES:
            w = np.pad(w, (0, AUDIO_N_SAMPLES - len(w)))
        windows.append(w)
    batch = np.stack(windows)[..., None].astype(np.float32)
    note, onset = session.run(_ONNX_OUTPUTS, {_ONNX_INPUT: batch})
    return {
        "note": _unwrap(np.asarray(note), original_length),
        "onset": _unwrap(np.asarray(onset), original_length),
    }


def _frames_to_time(n_frames: int) -> np.ndarray:
    """Frame index -> seconds, compensating per-window drift (bp model_frames_to_time)."""
    original_times = np.arange(n_frames) * FFT_HOP / BP_SAMPLE_RATE
    window_numbers = np.floor(np.arange(n_frames) / ANNOT_N_FRAMES)
    window_offset = (FFT_HOP / BP_SAMPLE_RATE) * (
        ANNOT_N_FRAMES - (AUDIO_N_SAMPLES / FFT_HOP)
    ) + MAGIC_ALIGNMENT_OFFSET
    return original_times - (window_offset * window_numbers)


def _infer_onsets(onsets: np.ndarray, frames: np.ndarray, n_diff: int = 2) -> np.ndarray:
    """Add onsets where frame amplitudes jump (bp get_infered_onsets)."""
    diffs = []
    for n in range(1, n_diff + 1):
        frames_appended = np.concatenate([np.zeros((n, frames.shape[1])), frames])
        diffs.append(frames_appended[n:, :] - frames_appended[:-n, :])
    frame_diff = np.min(diffs, axis=0)
    frame_diff[frame_diff < 0] = 0
    frame_diff[:n_diff, :] = 0
    frame_max = np.max(frame_diff)
    if frame_max > 0:
        frame_diff = np.max(onsets) * frame_diff / frame_max
    return np.max([onsets, frame_diff], axis=0)


def _output_to_notes(
    frames: np.ndarray, onsets: np.ndarray, melodia_trick: bool = True
) -> list[tuple[int, int, int, float]]:
    """Activations -> [(start_frame, end_frame, midi_pitch, amplitude)] events.

    Port of bp output_to_notes_polyphonic (without the pitch-bend path).
    """
    n_frames = frames.shape[0]
    onsets = _infer_onsets(onsets, frames)

    peak_thresh_mat = np.zeros(onsets.shape)
    peaks = scipy.signal.argrelmax(onsets, axis=0)
    peak_thresh_mat[peaks] = onsets[peaks]

    onset_idx = np.where(peak_thresh_mat >= ONSET_THRESHOLD)
    onset_time_idx = onset_idx[0][::-1]  # go backwards in time
    onset_freq_idx = onset_idx[1][::-1]

    remaining_energy = frames.copy()

    note_events = []
    for note_start_idx, freq_idx in zip(onset_time_idx, onset_freq_idx):
        if note_start_idx >= n_frames - 1:
            continue
        # walk forward until the frame energy stays below threshold for ENERGY_TOL frames
        i = note_start_idx + 1
        k = 0
        while i < n_frames - 1 and k < ENERGY_TOL:
            k = k + 1 if remaining_energy[i, freq_idx] < FRAME_THRESHOLD else 0
            i += 1
        i -= k
        if i - note_start_idx <= MIN_NOTE_LEN_FRAMES:
            continue
        remaining_energy[note_start_idx:i, freq_idx] = 0
        if freq_idx < MAX_FREQ_IDX:
            remaining_energy[note_start_idx:i, freq_idx + 1] = 0
        if freq_idx > 0:
            remaining_energy[note_start_idx:i, freq_idx - 1] = 0
        amplitude = float(np.mean(frames[note_start_idx:i, freq_idx]))
        note_events.append((int(note_start_idx), int(i), int(freq_idx) + MIDI_OFFSET, amplitude))

    if melodia_trick:
        # pick up sustained notes whose onset the onset head missed
        energy_shape = remaining_energy.shape
        while np.max(remaining_energy) > FRAME_THRESHOLD:
            i_mid, freq_idx = np.unravel_index(np.argmax(remaining_energy), energy_shape)
            remaining_energy[i_mid, freq_idx] = 0

            i = i_mid + 1
            k = 0
            while i < n_frames - 1 and k < ENERGY_TOL:
                k = k + 1 if remaining_energy[i, freq_idx] < FRAME_THRESHOLD else 0
                remaining_energy[i, freq_idx] = 0
                if freq_idx < MAX_FREQ_IDX:
                    remaining_energy[i, freq_idx + 1] = 0
                if freq_idx > 0:
                    remaining_energy[i, freq_idx - 1] = 0
                i += 1
            i_end = i - 1 - k

            i = i_mid - 1
            k = 0
            while i > 0 and k < ENERGY_TOL:
                k = k + 1 if remaining_energy[i, freq_idx] < FRAME_THRESHOLD else 0
                remaining_energy[i, freq_idx] = 0
                if freq_idx < MAX_FREQ_IDX:
                    remaining_energy[i, freq_idx + 1] = 0
                if freq_idx > 0:
                    remaining_energy[i, freq_idx - 1] = 0
                i -= 1
            i_start = i + 1 + k

            if i_end - i_start <= MIN_NOTE_LEN_FRAMES:
                continue
            amplitude = float(np.mean(frames[i_start:i_end, freq_idx]))
            note_events.append((int(i_start), int(i_end), int(freq_idx) + MIDI_OFFSET, amplitude))

    return note_events


def transcribe_events(audio: np.ndarray, melodia_trick: bool = True) -> list[NoteEvent]:
    """16 kHz mono audio -> sorted note events, in seconds on the input timeline.

    Set melodia_trick=False when streaming: it invents onset-less notes for anything
    still sounding, which would re-trigger held notes on every trailing window.
    """
    if len(audio) < SAMPLE_RATE // 10:
        return []
    audio_22k = librosa.resample(
        audio.astype(np.float32), orig_sr=SAMPLE_RATE, target_sr=BP_SAMPLE_RATE
    )
    output = _run_model(audio_22k)
    events = _output_to_notes(output["note"], output["onset"], melodia_trick=melodia_trick)
    times = _frames_to_time(output["note"].shape[0])
    notes = [
        NoteEvent(
            onset=float(times[start]),
            offset=float(times[min(end, len(times) - 1)]),
            pitch=pitch,
            velocity=min(127, max(1, round(amplitude * 127))),
        )
        for start, end, pitch, amplitude in events
    ]
    notes.sort(key=lambda n: (n.onset, n.pitch))
    return notes
