from pathlib import Path

import pytest

from notes_scripter.score import build_score, quantize, score_to_midi, score_to_musicxml
from notes_scripter.transcribe import NoteEvent


def make_events(lead_silence: float = 0.0) -> list[NoteEvent]:
    # C major arpeggio (right hand) over a simple bass, slightly imprecise timing
    events = []
    for i, p in enumerate([60, 64, 67, 72, 67, 64, 60, 64]):
        jitter = 0.02 if i % 3 else 0.0
        onset = lead_silence + i * 0.51 + jitter
        events.append(NoteEvent(onset=onset, offset=onset + 0.48, pitch=p, velocity=70))
    for i, p in enumerate([48, 43, 48, 43]):
        onset = lead_silence + i * 1.02
        events.append(NoteEvent(onset=onset, offset=onset + 0.95, pitch=p, velocity=60))
    return events


def test_quantize_grid_and_hands():
    qnotes = quantize(make_events(), bpm=118.0)
    assert {q.hand for q in qnotes} == {"R", "L"}
    for q in qnotes:
        assert (q.onset_ql * 4) % 1 == 0, f"onset {q.onset_ql} not on 16th grid"
        assert (q.dur_ql * 4) % 1 == 0


def test_quantize_removes_leading_silence():
    qnotes = quantize(make_events(lead_silence=3.0), bpm=120.0)
    assert min(q.onset_ql for q in qnotes) == 0.0


def test_build_score_two_hands_and_key():
    qnotes = quantize(make_events(), bpm=118.0)
    score, detected_key = build_score(qnotes, bpm=118.0)
    assert len(score.parts) == 2
    assert detected_key == "C major"
    assert len(score.flatten().notes) > 0


def test_exports_written(tmp_path: Path):
    qnotes = quantize(make_events(), bpm=118.0)
    score, _ = build_score(qnotes, bpm=118.0)
    xml = score_to_musicxml(score, tmp_path / "t.musicxml")
    assert xml.exists() and xml.stat().st_size > 1000
    midi = score_to_midi(score, 118.0, tmp_path / "t.mid")
    assert midi.read_bytes()[:4] == b"MThd"


def test_invalid_effort_rejected():
    from notes_scripter.transcribe import transcribe

    with pytest.raises(ValueError, match="effort"):
        transcribe(Path("whatever.wav"), effort="turbo")


def test_empty_events():
    assert quantize([], bpm=120.0) == []
    score, detected_key = build_score([], bpm=120.0)
    assert detected_key is None
    assert len(score.parts) == 2
