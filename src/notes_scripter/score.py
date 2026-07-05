"""Quantized, editable notes -> two-staff score -> MusicXML / MIDI (music21)."""

from __future__ import annotations

import copy
from dataclasses import dataclass
from pathlib import Path

import structlog
from music21 import chord as m21chord
from music21 import clef, instrument, key, metadata, meter, note, stream, tempo

from .transcribe import NoteEvent

log = structlog.get_logger()

HAND_SPLIT_PITCH = 60  # middle C: below -> left hand (bass clef)
GRID = 0.25  # quantize onsets/durations to sixteenth notes
MIN_QL = 0.25  # shortest written duration (quarterLength)
MAX_QL = 8.0


@dataclass
class QuantNote:
    """One quantized note: the unit the score is built from."""

    id: int
    hand: str  # "R" (treble) | "L" (bass)
    onset_ql: float
    dur_ql: float
    pitch: int
    velocity: int


def _snap(value: float, grid: float = GRID) -> float:
    return round(value / grid) * grid


def quantize(notes: list[NoteEvent], bpm: float) -> list[QuantNote]:
    """Snap events to the grid, drop leading silence, group chords, clip overlaps."""
    sec_to_ql = bpm / 60.0
    qnotes = [
        QuantNote(
            id=0,
            hand="R" if n.pitch >= HAND_SPLIT_PITCH else "L",
            onset_ql=_snap(n.onset * sec_to_ql),
            dur_ql=max(MIN_QL, min(_snap((n.offset - n.onset) * sec_to_ql) or MIN_QL, MAX_QL)),
            pitch=n.pitch,
            velocity=n.velocity,
        )
        for n in notes
    ]
    if not qnotes:
        return []

    # start the score on beat 1 (removes leading silence)
    shift = min(q.onset_ql for q in qnotes)
    for q in qnotes:
        q.onset_ql -= shift

    # drop duplicate pitches landing on the same beat
    qnotes.sort(key=lambda q: (q.onset_ql, q.pitch))
    seen: set[tuple] = set()
    qnotes = [
        q for q in qnotes if (k := (q.hand, q.onset_ql, q.pitch)) not in seen and not seen.add(k)
    ]

    # per hand: unify chord durations, then clip anything overlapping the next onset
    for hand in "RL":
        hand_notes = [q for q in qnotes if q.hand == hand]
        onsets = sorted({q.onset_ql for q in hand_notes})
        next_onset = dict(zip(onsets, onsets[1:]))
        by_onset: dict[float, list[QuantNote]] = {}
        for q in hand_notes:
            by_onset.setdefault(q.onset_ql, []).append(q)
        for onset, group in by_onset.items():
            dur = max(q.dur_ql for q in group)
            if onset in next_onset:
                dur = max(MIN_QL, min(dur, next_onset[onset] - onset))
            for q in group:
                q.dur_ql = dur

    for i, q in enumerate(qnotes):
        q.id = i
    return qnotes


def build_score(
    qnotes: list[QuantNote], bpm: float, title: str = "Transcription", composer: str = ""
) -> tuple[stream.Score, str | None]:
    right, left = stream.Part(), stream.Part()
    parts = {"R": right, "L": left}

    # notes sharing (hand, onset, duration) render as one chord; other overlaps become voices
    groups: dict[tuple, list[QuantNote]] = {}
    for q in qnotes:
        groups.setdefault((q.hand, q.onset_ql, q.dur_ql), []).append(q)
    for (hand, onset, dur), group in groups.items():
        pitches = sorted(q.pitch for q in group)
        el = note.Note(pitches[0]) if len(pitches) == 1 else m21chord.Chord(pitches)
        el.quarterLength = dur
        el.volume.velocity = max(q.velocity for q in group)
        parts[hand].insert(onset, el)

    # keep the Piano instrument for MIDI playback, but hide its name on the score
    piano = instrument.Piano()
    piano.instrumentName = ""
    piano.instrumentAbbreviation = ""
    right.insert(0, piano)
    right.insert(0, clef.TrebleClef())
    # text-only mark: the glyph form uses SMuFL private-use chars that break PDF export
    right.insert(0, tempo.MetronomeMark(text=f"{round(bpm)} BPM"))
    left.insert(0, clef.BassClef())
    for part in (right, left):
        part.insert(0, meter.TimeSignature("4/4"))

    score = stream.Score()
    score.insert(0, metadata.Metadata(title=title, composer=composer))
    score.insert(0, right)
    score.insert(0, left)

    detected_key = None
    if qnotes:
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


def score_to_midi(score: stream.Score, bpm: float, path: Path) -> Path:
    """MIDI mirrors the (possibly edited) score; a real tempo mark sets playback speed."""
    playable = copy.deepcopy(score)
    playable.parts[0].insert(0, tempo.MetronomeMark(number=round(bpm)))
    playable.write("midi", fp=str(path))
    return path
