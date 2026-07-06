"""Tests for the ultra (Basic Pitch) engine. The default tests need no model/network."""

from pathlib import Path

import numpy as np
import pytest

from notes_scripter import ultra


def synth_posteriors(n_frames: int = 200):
    """Activation matrices with two clean notes: pitch 60 @ frames 10-60, 64 @ 80-120."""
    frames = np.zeros((n_frames, 88), dtype=np.float32)
    onsets = np.zeros((n_frames, 88), dtype=np.float32)
    for start, end, pitch in [(10, 60, 60), (80, 120, 64)]:
        frames[start:end, pitch - ultra.MIDI_OFFSET] = 0.8
        onsets[start, pitch - ultra.MIDI_OFFSET] = 0.9
    return frames, onsets


def test_output_to_notes_finds_onset_notes():
    frames, onsets = synth_posteriors()
    events = ultra._output_to_notes(frames, onsets, melodia_trick=False)
    assert sorted(e[2] for e in events) == [60, 64]
    (start, end, _, amplitude) = next(e for e in events if e[2] == 60)
    assert abs(start - 10) <= 1 and abs(end - 60) <= ultra.ENERGY_TOL
    assert 0.7 <= amplitude <= 0.9


def test_melodia_trick_catches_onsetless_notes():
    frames, _ = synth_posteriors()
    no_onsets = np.zeros_like(frames)
    assert ultra._output_to_notes(frames, no_onsets, melodia_trick=False) == []
    events = ultra._output_to_notes(frames, no_onsets, melodia_trick=True)
    assert sorted(e[2] for e in events) == [60, 64]


def test_short_notes_dropped():
    frames = np.zeros((100, 88), dtype=np.float32)
    onsets = np.zeros((100, 88), dtype=np.float32)
    frames[10:15, 40] = 0.9  # 5 frames < MIN_NOTE_LEN_FRAMES
    onsets[10, 40] = 0.9
    assert ultra._output_to_notes(frames, onsets) == []


def test_frames_to_time_monotonic():
    times = ultra._frames_to_time(500)
    assert times[0] == 0.0
    assert all(d > 0 for d in np.diff(times))
    # ~86 fps: 500 frames is a bit under 6 seconds
    assert 5.0 < times[-1] < 6.0


def test_empty_audio():
    assert ultra.transcribe_events(np.zeros(100, dtype=np.float32)) == []


@pytest.mark.slow
def test_ultra_end_to_end(tmp_path: Path):
    import time

    import librosa

    from test_pipeline_e2e import synth_song

    from notes_scripter import transcribe

    wav = tmp_path / "song.wav"
    synth_song(wav)
    audio, _ = librosa.load(str(wav), sr=transcribe.SAMPLE_RATE, mono=True)

    t0 = time.time()
    notes = ultra.transcribe_events(audio)
    elapsed = time.time() - t0
    duration = len(audio) / transcribe.SAMPLE_RATE
    assert elapsed < duration, f"ultra must be faster than real time, took {elapsed:.2f}s"

    pitches = {n.pitch for n in notes}
    assert {60, 64, 67, 72} <= pitches
    first = min(n.onset for n in notes)
    assert first < 0.15, "first note should be detected at the start"

    # the effort dispatcher goes through the same engine
    result = transcribe.transcribe(wav, effort="ultra")
    assert len(result.notes) >= 4
