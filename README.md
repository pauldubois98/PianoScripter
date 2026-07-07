# 🎹 PianoScripter

https://pauldubois98.github.io/PianoScripter/

Play the piano, get the sheet music **entirely on your device**.
The app records audio (or uploads audio) in the browser, transcribed in-browser with ONNX models (WebAssembly), quantized into notation, engraved with Verovio, and exported as **PDF, MIDI and MusicXML**.
Nothing is ever sent to a server.

## Quick start

### Dev mode
```bash
cd web
npm install
npm run dev        # http://localhost:5173
```

### Build
```bash
cd web
npm run build
```
A workflow in `.github/workflows/deploy.yml` deploys `main` to GitHub Pages.

## How it works
```mermaid
flowchart LR
    A[🎙️ Audio<br/>mic or file] -->|WebAudio decode| B[16 kHz mono]
    B -->|ByteDance CRNN ONNX<br/>fast · balanced · best| C[Note events<br/>onset · offset · pitch · velocity]
    B -->|Basic Pitch ONNX<br/>ultra · live roll| C
    B -->|onset autocorrelation| D[Tempo estimate]
    C --> E[JS score engine<br/>quantization · hand split · key]
    E --> F[MusicXML]
    F -->|Verovio WASM| G[SVG score]
    G -->|jsPDF + svg2pdf| H[📄 PDF]
    E -->|@tonejs/midi| I[🎹 MIDI]
```

### Effort levels

| Effort | Engine | Model download | When to use |
|---|---|---|---|
| 🚀 Ultra | Basic Pitch | bundled (~230 kB) | Live sessions, instant drafts |
| ⚡ Fast | ByteDance fp16, no overlap | ~90 MB (shared with Balanced) | Quick drafts |
| ⚖️ Balanced (default) | ByteDance fp16, 50% hop | ~90 MB (shared with Fast) | Everyday use |
| ✨ Best | ByteDance fp32, 25% hop | ~175 MB | Final scores, dense passages |

Models are fetched on first use (same-origin `models/` first, then Hugging Face Hub), cached with the Cache API, and work offline afterwards.
Multi-threaded WASM is enabled via COOP/COEP headers `coi-serviceworker` on hosts that cannot set headers (GitHub Pages), with a single-threaded fallback.

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

The exported ByteDance models are not committed (see `.gitignore`).
Regenerate them locally with `tools/export_onnx.py`, or let the deployed site download them from the Hugging Face Hub mirror configured in `web/src/engine/models.js`.

## Roadmap
See `docs/research-report.md` — notably per-piano calibration, smartphone-domain robustness, a real MIDI-to-score model (PM2S-style), and WebGPU acceleration once its GRU support lands in onnxruntime-web.
