"""Note events -> quantized two-staff score -> MusicXML (music21)."""

from __future__ import annotations

from pathlib import Path

import structlog
from music21 import chord as m21chord
from music21 import clef, instrument, key, metadata, meter, note, stream, tempo

from .transcribe import NoteEvent

log = structlog.get_logger()

HAND_SPLIT_PITCH = 60  # middle C: below -> left hand (bass clef)
GRID = 0.25  # quantize onsets to sixteenth notes
MIN_QL = 0.25  # shortest written duration (quarterLength)
MAX_QL = 8.0


def _quantize(value: float, grid: float = GRID) -> float:
    return round(value / grid) * grid


def _build_hand(notes: list[NoteEvent], bpm: float) -> stream.Part:
    """Group quantized-simultaneous notes into chords and lay them on a Part."""
    sec_to_ql = bpm / 60.0
    by_onset: dict[float, list[NoteEvent]] = {}
    for n in notes:
        by_onset.setdefault(_quantize(n.onset * sec_to_ql), []).append(n)

    part = stream.Part()
    onsets = sorted(by_onset)
    for i, onset_ql in enumerate(onsets):
        group = by_onset[onset_ql]
        raw_ql = max((n.offset - n.onset) * sec_to_ql for n in group)
        dur = max(MIN_QL, min(_quantize(raw_ql) or MIN_QL, MAX_QL))
        # keep notation readable: clip a note that would overlap the next onset
        if i + 1 < len(onsets):
            gap = onsets[i + 1] - onset_ql
            if dur > gap:
                dur = max(MIN_QL, gap)
        pitches = sorted({n.pitch for n in group})
        el = note.Note(pitches[0]) if len(pitches) == 1 else m21chord.Chord(pitches)
        el.quarterLength = dur
        el.volume.velocity = max(n.velocity for n in group)
        part.insert(onset_ql, el)
    return part


def events_to_score(
    notes: list[NoteEvent], bpm: float, title: str = "Transcription"
) -> tuple[stream.Score, str | None]:
    right = _build_hand([n for n in notes if n.pitch >= HAND_SPLIT_PITCH], bpm)
    left = _build_hand([n for n in notes if n.pitch < HAND_SPLIT_PITCH], bpm)

    right.insert(0, instrument.Piano())
    right.insert(0, clef.TrebleClef())
    # text-only mark: the glyph form uses SMuFL private-use chars that break PDF export
    right.insert(0, tempo.MetronomeMark(text=f"{round(bpm)} BPM"))
    left.insert(0, clef.BassClef())
    for part in (right, left):
        part.insert(0, meter.TimeSignature("4/4"))

    score = stream.Score()
    score.insert(0, metadata.Metadata(title=title, composer=""))
    score.insert(0, right)
    score.insert(0, left)

    detected_key = None
    if notes:
        try:
            detected_key = score.analyze("key")
            for part in (right, left):
                part.insert(0, key.KeySignature(detected_key.sharps))
        except Exception:  # key analysis can fail on tiny inputs
            log.warning("key_analysis_failed")

    for part in (right, left):
        part.makeVoices(inPlace=True)
        part.makeMeasures(inPlace=True)
        part.makeRests(fillGaps=True, inPlace=True, timeRangeFromBarDuration=True)

    return score, str(detected_key) if detected_key else None


def score_to_musicxml(score: stream.Score, path: Path) -> Path:
    score.write("musicxml", fp=str(path))
    return path
