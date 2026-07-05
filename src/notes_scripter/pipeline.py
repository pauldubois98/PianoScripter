"""End-to-end pipeline: audio file -> MIDI + MusicXML + SVG pages + PDF in an output dir."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import structlog

from . import render, score, transcribe

log = structlog.get_logger()


@dataclass
class PipelineOutput:
    midi: Path
    musicxml: Path
    pdf: Path
    svg_pages: list[str] = field(repr=False, default_factory=list)
    tempo_bpm: float = 120.0
    key: str | None = None
    n_notes: int = 0
    duration: float = 0.0


def run(
    audio_path: Path,
    out_dir: Path,
    title: str = "Transcription",
    effort: str = transcribe.DEFAULT_EFFORT,
) -> PipelineOutput:
    out_dir.mkdir(parents=True, exist_ok=True)
    midi_path = out_dir / "transcription.mid"
    musicxml_path = out_dir / "transcription.musicxml"
    pdf_path = out_dir / "transcription.pdf"

    result = transcribe.transcribe(audio_path, midi_path=midi_path, effort=effort)
    m21_score, detected_key = score.events_to_score(result.notes, result.tempo_bpm, title=title)
    score.score_to_musicxml(m21_score, musicxml_path)
    svg_pages = render.musicxml_to_svgs(musicxml_path)
    render.svgs_to_pdf(svg_pages, pdf_path)

    return PipelineOutput(
        midi=midi_path,
        musicxml=musicxml_path,
        pdf=pdf_path,
        svg_pages=svg_pages,
        tempo_bpm=result.tempo_bpm,
        key=detected_key,
        n_notes=len(result.notes),
        duration=result.duration,
    )
