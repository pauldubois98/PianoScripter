"""PianoScripter CLI."""

from __future__ import annotations

import webbrowser
from enum import Enum
from pathlib import Path

import structlog
import typer
from rich.console import Console
from rich.table import Table

structlog.configure(processors=[structlog.processors.KeyValueRenderer()])

app = typer.Typer(help="Transcribe piano audio to sheet music — fully on-device.")
console = Console()


@app.command()
def serve(
    port: int = typer.Option(8321, help="Port on localhost."),
    open_browser: bool = typer.Option(True, help="Open the UI in your browser."),
):
    """Start the local web app (127.0.0.1 only — nothing leaves your machine)."""
    import uvicorn

    url = f"http://127.0.0.1:{port}"
    console.print(f"[bold green]PianoScripter[/] running at [link]{url}[/link] (local only)")
    if open_browser:
        webbrowser.open(url)
    uvicorn.run("piano_scripter.server:app", host="127.0.0.1", port=port, log_level="warning")


class Effort(str, Enum):
    ultra = "ultra"
    fast = "fast"
    balanced = "balanced"
    best = "best"


@app.command()
def transcribe(
    audio: Path = typer.Argument(..., exists=True, help="Audio file (wav/mp3/flac/webm/...)."),
    out: Path = typer.Option(Path("output"), help="Output directory."),
    title: str = typer.Option("Transcription", help="Score title."),
    effort: Effort = typer.Option(
        Effort.balanced,
        help="ultra: near-instant, roughest | fast: ~2x faster | balanced | "
        "best: ~2x slower, most accurate.",
    ),
):
    """Transcribe an audio file to MIDI + MusicXML + PDF."""
    from . import pipeline

    with console.status("Transcribing (first run downloads the ~165 MB model)..."):
        result = pipeline.run(audio, out, title=title, effort=effort.value)

    table = Table(title="Transcription complete")
    table.add_column("What")
    table.add_column("Value")
    table.add_row("Notes", str(result.n_notes))
    table.add_row("Tempo", f"{result.tempo_bpm} BPM")
    table.add_row("Key", result.key or "?")
    table.add_row("MIDI", str(result.midi))
    table.add_row("MusicXML", str(result.musicxml))
    table.add_row("PDF", str(result.pdf))
    console.print(table)


if __name__ == "__main__":
    app()
