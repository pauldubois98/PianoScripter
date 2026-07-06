# 🎹 PianoScripter

Play the piano, get the sheet music — **entirely on your device**. The app is a
**static website**: audio is recorded (or uploaded) in the browser, transcribed
in-browser with ONNX models (WebAssembly), quantized into notation, engraved with
Verovio, and exported as **PDF, MIDI and MusicXML**. Nothing is ever sent to a
server — there is no server.

## Quick start (web app)

```bash
cd web
npm install
npm run dev        # http://localhost:5173
```

Record from the microphone, start a **live session** (notes appear on a piano roll
about a second after you play them, with a full-quality pass when you stop), or drop
an audio file (WAV, MP3, FLAC, OGG, WebM…). Leading/trailing silence is trimmed
automatically. Title, author and BPM are editable after transcription; switching
back to an already-computed effort swaps the score instantly.

`npm run build` emits a fully static `dist/` deployable to GitHub Pages, Netlify or
any static host (a workflow in `.github/workflows/deploy.yml` deploys `main` to Pages).

## How it works

```mermaid
flowchart LR
    A[🎙️ Audio<br/>mic or file] -->|WebAudio decode| B[16 kHz mono]
    B -->|ByteDance CRNN ONNX<br/>fast · balanced · best| C[Note events<br/>onset · offset · pitch · velocity]
    B -->|Basic Pitch ONNX<br/>ultra · live roll| C
    B -->|onset autocorrelation| D[Tempo estimate]
    C --> E[JS score engine<br/>quantization · hand split · key]
    D --> E
    E --> F[MusicXML]
    F -->|Verovio WASM| G[SVG score]
    G -->|jsPDF + svg2pdf| H[📄 PDF]
    E -->|@tonejs/midi| I[🎹 MIDI]
```

Everything above runs in the browser: the models via **onnxruntime-web** (WASM, in a
web worker), the engraving via the **Verovio** WASM toolkit (in a second worker).

### Effort levels

The **ultra** tier uses Spotify's tiny Basic Pitch model (~230 kB, bundled with the
site) — ~50× faster than real time, which is what makes the live view possible. The
other tiers slide the ByteDance model's 10-second window over the recording; the
effort setting controls how much the windows overlap and get averaged:

| Effort | Engine | Model download | When to use |
|---|---|---|---|
| 🚀 Ultra | Basic Pitch | bundled (~230 kB) | Live sessions, instant drafts |
| ⚡ Fast | ByteDance fp16, no overlap | ~90 MB (shared with Balanced) | Quick drafts |
| ⚖️ Balanced (default) | ByteDance fp16, 50% hop | ~90 MB (shared with Fast) | Everyday use |
| ✨ Best | ByteDance fp32, 25% hop | ~175 MB | Final scores, dense passages |

Models are fetched on first use (same-origin `models/` first, then Hugging Face Hub),
cached with the Cache API, and work offline afterwards. Multi-threaded WASM is enabled
via COOP/COEP headers (`public/_headers` for Netlify) or `coi-serviceworker` on hosts
that cannot set headers (GitHub Pages), with a single-threaded fallback.

### Layout

- `web/` — the static site (Vue 3 + Vite)
  - `src/audio/` — decoding, silence trim, tempo estimation, mic capture (AudioWorklet)
  - `src/engine/` — the two workers plus the ports: `basicpitch(-dsp).js`,
    `bytedance(-post).js`, `quantize.js`, `score.js`, `musicxml.js`, `keydetect.js`, `midi.js`
  - `tests/` — vitest suite checking the JS ports against Python-generated fixtures
- `tools/export_onnx.py` — exports the ByteDance PyTorch checkpoint to
  `bytedance-fp32/fp16.onnx` (+ optional int8) with a PyTorch-parity gate
- `tools/make_fixtures.py` — regenerates the JS test fixtures from the Python reference
- `src/piano_scripter/` — the original Python implementation, kept as the reference
  and for the CLI (`uv run piano-scripter transcribe recording.wav --out output/`);
  the FastAPI server (`piano-scripter serve`) is legacy, superseded by the web app

## Development

```bash
cd web
npm test                                    # unit + parity tests
npm run smoke -- --effort ultra song.wav    # real-browser end-to-end (needs Chrome)

# Python reference / tooling
uv run pytest
uv run python tools/export_onnx.py --out web/public/models --verify clip.wav
uv run python tools/make_fixtures.py
```

The exported ByteDance models are not committed (see `.gitignore`); regenerate them
locally with `tools/export_onnx.py`, or let the deployed site download them from the
Hugging Face Hub mirror configured in `web/src/engine/models.js`.

## Roadmap

See `docs/research-report.md` — notably per-piano calibration, smartphone-domain
robustness, a real MIDI-to-score model (PM2S-style), and WebGPU acceleration once
its GRU support lands in onnxruntime-web.
