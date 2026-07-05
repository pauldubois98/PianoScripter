"""End-to-end pipeline: audio -> quantized notes -> MIDI + MusicXML + SVG + PDF."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import structlog

from . import render, score, transcribe
from .score import QuantNote

log = structlog.get_logger()


@dataclass
class PipelineOutput:
    midi: Path
    musicxml: Path
    pdf: Path
    svg_pages: list[str] = field(repr=False, default_factory=list)
    qnotes: list[QuantNote] = field(repr=False, default_factory=list)
    tempo_bpm: float = 120.0
    key: str | None = None
    n_notes: int = 0
    duration: float = 0.0


def rebuild(
    qnotes: list[QuantNote], bpm: float, out_dir: Path, title: str = "Transcription"
) -> PipelineOutput:
    """Generate score and every export from the quantized note list."""
    out_dir.mkdir(parents=True, exist_ok=True)
    midi_path = out_dir / "transcription.mid"
    musicxml_path = out_dir / "transcription.musicxml"
    pdf_path = out_dir / "transcription.pdf"

    m21_score, detected_key = score.build_score(qnotes, bpm, title=title)
    score.score_to_musicxml(m21_score, musicxml_path)
    score.score_to_midi(m21_score, bpm, midi_path)
    svg_pages = render.musicxml_to_svgs(musicxml_path)
    render.svgs_to_pdf(svg_pages, pdf_path)

    return PipelineOutput(
        midi=midi_path,
        musicxml=musicxml_path,
        pdf=pdf_path,
        svg_pages=svg_pages,
        qnotes=qnotes,
        tempo_bpm=bpm,
        key=detected_key,
        n_notes=len(qnotes),
    )


def draft_svgs(qnotes: list[QuantNote], bpm: float, work_dir: Path) -> list[str]:
    """Fast score-only rendering for the live preview (no PDF/MIDI)."""
    work_dir.mkdir(parents=True, exist_ok=True)
    m21_score, _ = score.build_score(qnotes, bpm, title="Live transcription")
    musicxml_path = score.score_to_musicxml(m21_score, work_dir / "draft.musicxml")
    return render.musicxml_to_svgs(musicxml_path)


def run(
    audio_path: Path,
    out_dir: Path,
    title: str = "Transcription",
    effort: str = transcribe.DEFAULT_EFFORT,
) -> PipelineOutput:
    result = transcribe.transcribe(audio_path, midi_path=None, effort=effort)
    qnotes = score.quantize(result.notes, result.tempo_bpm)
    out = rebuild(qnotes, result.tempo_bpm, out_dir, title=title)
    out.duration = result.duration
    return out
