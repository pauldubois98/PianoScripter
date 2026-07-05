from pathlib import Path

from notes_scripter.score import events_to_score, score_to_musicxml
from notes_scripter.transcribe import NoteEvent


def make_events() -> list[NoteEvent]:
    # C major arpeggio (right hand) over a simple bass, slightly imprecise timing
    events = []
    for i, p in enumerate([60, 64, 67, 72, 67, 64, 60, 64]):
        jitter = 0.02 if i % 3 else 0.0
        events.append(
            NoteEvent(onset=i * 0.51 + jitter, offset=i * 0.51 + 0.48, pitch=p, velocity=70)
        )
    for i, p in enumerate([48, 43, 48, 43]):
        events.append(NoteEvent(onset=i * 1.02, offset=i * 1.02 + 0.95, pitch=p, velocity=60))
    return events


def test_events_to_score_two_hands():
    score, detected_key = events_to_score(make_events(), bpm=118.0)
    assert len(score.parts) == 2
    assert detected_key == "C major"
    flat = score.flatten().notes
    assert len(flat) > 0


def test_score_quantized_to_grid():
    score, _ = events_to_score(make_events(), bpm=118.0)
    for n in score.flatten().notes:
        assert (float(n.offset) * 4) % 1 == 0, f"onset {n.offset} not on 16th grid"


def test_musicxml_written(tmp_path: Path):
    score, _ = events_to_score(make_events(), bpm=118.0)
    out = score_to_musicxml(score, tmp_path / "t.musicxml")
    assert out.exists() and out.stat().st_size > 1000


def test_empty_events():
    score, detected_key = events_to_score([], bpm=120.0)
    assert detected_key is None
    assert len(score.parts) == 2
