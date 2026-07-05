# 🎹 NotesScripter

Play the piano, get the sheet music — **entirely on your device**. Audio is recorded (or
uploaded) in a local web app, transcribed with the ByteDance high-resolution piano
transcription model, quantized into notation, and exported as **PDF, MIDI and MusicXML**.
Nothing is ever sent to a server: the app binds to `127.0.0.1` only.

## Quick start

```bash
uv sync
uv run notes-scripter serve   # opens http://127.0.0.1:8321 in your browser
```

Record from the microphone or drop an audio file (WAV, MP3, FLAC, OGG, WebM…). The first
transcription downloads the model checkpoint (~165 MB) to
`~/piano_transcription_inference_data/`; after that everything works offline.

There is also a CLI:

```bash
uv run notes-scripter transcribe recording.wav --out output/
```

## How it works

```
audio ──ByteDance CRNN──▶ note events (onset/offset/pitch/velocity, seconds)
      ──librosa beat tracking──▶ tempo estimate
      ──quantization + hand split + key analysis (music21)──▶ MusicXML
      ──Verovio──▶ SVG score  ──cairosvg──▶ PDF
```

- `src/notes_scripter/transcribe.py` — audio decoding (ffmpeg), tempo estimation, model inference
- `src/notes_scripter/score.py` — 16th-note quantization, chord grouping, hand split at middle C, key detection
- `src/notes_scripter/render.py` — MusicXML → SVG pages → PDF
- `src/notes_scripter/server.py` — local FastAPI app + static UI (`static/index.html`, Vue 3 vendored)
- `src/notes_scripter/cli.py` — `serve` and `transcribe` commands

## Development

```bash
uv run pytest              # fast tests (no model needed)
uv run pytest -m slow      # full end-to-end test (downloads the model)
uv run ruff format . && uv run ruff check .
git config core.hooksPath .githooks   # enable the pre-commit checks
```

## Roadmap

See `docs/research-report.md` — notably per-piano calibration, smartphone-domain
robustness, a real MIDI-to-score model (PM2S-style), and precision-tiered "effort" levels.
