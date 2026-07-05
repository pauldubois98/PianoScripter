# NotesScripter — State of the Art & Research Report

*Piano audio → sheet music transcription. Survey date: July 2026.*

## 1. Goal recap

Record someone playing the piano with a smartphone microphone and produce sheet music
(PDF + MIDI export), with the ability to fine-tune the system for the user's own piano.

## 2. Existing solutions

### 2.1 Commercial / SaaS products

| Product | What it does | Notes |
|---|---|---|
| [Klangio / Piano2Notes](https://klang.io/piano2notes/) | Piano audio → sheet music (PDF, MIDI, MusicXML) | Cloud-based, subscription. Handles polyphony, can isolate piano in a mix. |
| [Ivory](https://ivory-app.com/) | Audio → MIDI / PDF / MusicXML, piano-focused | Mobile-friendly. |
| [Songscription AI](https://www.songscription.ai/) | Audio → sheet music, MIDI, MusicXML | Strong on single-instrument piano recordings. |
| [PianoConvert (La Touche Musicale)](https://latouchemusicale.com/en/apps/pianoconvert/) | Piano audio → PDF/MIDI/MusicXML | Online converter. |
| [AnthemScore](https://lunaverus.com/) | Audio → sheet music desktop app | Runs locally (Win/Mac/Linux), one-time license; spectrogram + NN. |
| [Melody Scanner](https://melodyscanner.com/) | Audio → score, mobile + web | Consumer-oriented. |
| [Music-To-Sheet](https://musictosheet.com/), [Soundslice](https://www.soundslice.com/transcribe/) | Multi-instrument transcription / assisted transcription | Soundslice is human-in-the-loop oriented. |

Takeaway: the product category exists and works "okay" — but all are cloud/black-box,
none offer **per-instrument adaptation**, and score quality (rhythm quantization,
voicing, hand separation) is the usual weak point users complain about.

### 2.2 Open-source building blocks

**Audio → MIDI (the ML core):**

- [ByteDance `piano_transcription`](https://github.com/bytedance/piano_transcription) /
  [`piano-transcription-inference`](https://pypi.org/project/piano-transcription-inference/) —
  "High-resolution piano transcription with pedals by regressing onset/offset times"
  (Kong et al. 2020). Piano-specific, PyTorch, detects onset, offset, pitch, **velocity and
  sustain pedal**. Still the de-facto open-source reference for piano; ~0.97 onset F1 on MAESTRO.
- [Spotify `basic-pitch`](https://github.com/spotify/basic-pitch) — lightweight (~20k params),
  instrument-agnostic, pitch-bend aware, runs faster than real-time on CPU; has a
  [TypeScript/TF.js port](https://github.com/spotify/basic-pitch-ts) that runs **in the browser**.
  Less accurate on dense piano polyphony than the ByteDance model.
- [Onsets and Frames](https://magenta.withgoogle.com/onsets-frames) (Magenta, 2018) — the
  classic dual-objective CNN+LSTM piano model; superseded but historically important.
- [MT3](https://arxiv.org/pdf/2107.09142) (Google, seq2seq Transformer, tokens out) and
  [MR-MT3](https://arxiv.org/html/2403.10024v1) — multi-instrument, token-based transcription.
- [Streaming piano transcription with pedal detection](https://arxiv.org/html/2503.01362v1)
  (2025) — recent work on **real-time/streaming** decoding, relevant for live feedback UX.
- [NeuralNote](https://github.com/DamRsn/NeuralNote) — C++/JUCE plugin wrapping basic-pitch
  via ONNXRuntime/RTNeural; proof that these models deploy fine in real-time native apps.

**Performance-MIDI → score (the neglected half):**

Raw transcribed MIDI has expressive (non-metronomic) timing; turning it into readable
notation needs beat tracking, rhythm quantization, voice/hand separation, key & time
signature estimation. This is where most products fall down.

- [PM2S](https://github.com/cheriell/PM2S) (Liu et al., ISMIR 2022) — CRNN beat tracking +
  quantization + key/time signature + hand-part prediction from performance MIDI.
- [End-to-end Performance-MIDI → MusicXML with Transformers](https://www.researchgate.net/publication/384563350_End-to-end_Piano_Performance-MIDI_to_Score_Conversion_with_Transformers)
  (Beyer et al., ISMIR 2024, RoFormer) — directly emits MusicXML tokens, handling
  quantization, voicing, stems, ornaments implicitly.
- [Transformer beat/downbeat tracking in performance MIDI](https://arxiv.org/html/2507.00466v1) (2025)
  and [transformer rhythm quantization with beat annotations](https://arxiv.org/html/2604.22290) (2026) —
  current SOTA components.

**Engraving / export:**

- [MuseScore](https://musescore.org) — imports MusicXML/MIDI, exports PDF; has a CLI for batch conversion.
- [Verovio](https://www.verovio.org/) — C++/JS/Python engraving library (MEI, MusicXML) — renders
  scores **client-side in a browser/app**, ideal for interactive display.
- [LilyPond](https://lilypond.org) — best-quality PDF engraving, text-based input.
- `music21` / `partitura` (Python) — symbolic manipulation, MusicXML I/O.

**Datasets (for training/fine-tuning):**

- **MAESTRO** — ~200h of piano audio + aligned MIDI from Disklavier competition recordings; the standard.
- **MAPS** — older, includes synthesized + real Disklavier.
- [Aria-MIDI](https://arxiv.org/pdf/2504.15071) (2025) — very large piano MIDI corpus (symbolic).
- Note: MAESTRO is clean/close-miked concert grands — a **domain gap** vs. a smartphone mic
  in a living room (reverb, noise, upright pianos, out-of-tune strings).

## 3. The standard technology pipeline

```
smartphone mic audio
  → (1) preprocessing: mono, resample 16–44.1kHz, log-mel spectrogram / CQT
  → (2) neural acoustic model: onset/offset/pitch/velocity/pedal
        (CNN+RNN à la ByteDance, or seq2seq Transformer à la MT3)
  → (3) performance MIDI
  → (4) MIDI-to-score: beat tracking, rhythm quantization, key/time signature,
        voice & hand separation (PM2S / transformer MusicXML generation)
  → (5) MusicXML
  → (6) engraving: Verovio (interactive display) / MuseScore or LilyPond (PDF)
  → exports: PDF, MIDI, MusicXML
```

Stages (2) and (4) are the two ML problems; everything else is plumbing with mature
open-source tools. Almost all existing products do (2) well and (4) poorly.

## 4. Where a better system can be built — suggested paths

### 4.1 Per-piano calibration (the differentiator nobody offers)

The stated requirement "fine tune for their piano" is essentially absent from every
product surveyed, yet research shows [domain adaptation of transcription models is cheap
and effective](https://arxiv.org/pdf/2402.15258) (guitar via fine-tuning at lr≈1e-5) and
[synthetic-data + domain-confusion training works without annotations](https://arxiv.org/html/2312.10402v3).
Concrete approach:

1. **Guided calibration recording**: app asks the user to play a chromatic scale, some
   chords, and pedal on/off — self-labeling, since the app *knows* what was asked.
2. Build a per-note template bank (tuning offset per key, inharmonicity, mic/room response).
   Even a non-ML use: correct the model's frequency bins for the piano's actual tuning
   (uprights are often 10–30 cents off and stretched).
3. **On-device fine-tuning or feature adaptation**: freeze the acoustic model, learn a small
   input adapter (per-channel spectral EQ / FiLM layers) from the calibration data.
   Alternatively resynthesize training data through the measured piano+room response and
   fine-tune offline.
4. Feedback loop: user corrects notes in the editor → corrections become fine-tuning data.

### 4.2 Take MIDI→score seriously

Ship stage (4) as a first-class model (PM2S or the ISMIR-2024 transformer approach), not
an afterthought heuristic. Readable rhythm, correct hand split, and sensible key signature
matter more to a pianist than +1% onset F1. An interactive "tempo/quantization grid"
slider (like NeuralNote's live re-transcription) would let users fix the score in seconds.

### 4.3 Robustness to the smartphone domain

Fine-tune the acoustic model on MAESTRO **augmented with room impulse responses, phone-mic
EQ curves, background noise, and detuned resynthesis** — directly attacks the
concert-grand-vs-living-room gap that hurts every MAESTRO-trained model in the field.

### 4.4 Architecture / deployment options

- **On-device first** (privacy, no subscription): basic-pitch-class models run real-time on
  phones (TF.js/ONNX/CoreML); the ByteDance model can be distilled or exported to ONNX.
  NeuralNote proves the native path; basic-pitch-ts proves the browser/PWA path.
- A pragmatic MVP: **Vue PWA** using microphone via WebAudio, basic-pitch-ts (or an ONNX
  export of the ByteDance model via onnxruntime-web) for audio→MIDI, PM2S-style
  quantization compiled to WASM or run on a small Python backend, Verovio for on-screen
  score, MuseScore-CLI/LilyPond server-side for PDF.
- **Streaming UX**: notes appear on the staff as you play (see the 2025 streaming
  transcription paper) — much better feedback than record-then-wait.

### 4.5 Longer-shot research directions

- **End-to-end audio→MusicXML** (skip performance MIDI): combine ByteDance-style encoder
  with the ISMIR-2024 MusicXML decoder; no published system does this well yet.
- **Score-aware language-model rescoring**: use a symbolic music LM (trained on Aria-MIDI)
  to prune acoustically-plausible-but-musically-absurd notes, analogous to LM rescoring in
  speech recognition.
- **Test-time adaptation**: self-supervised adaptation on each recording (entropy
  minimization / pseudo-labeling) instead of one-off calibration.

## 5. Recommendation (MVP)

1. Pipeline prototype in Python (`uv`): ByteDance `piano-transcription-inference` →
   PM2S → MusicXML via `partitura`/`music21` → MuseScore CLI for PDF, MIDI written directly.
2. Evaluate on recordings of *your own piano via a phone mic* — this immediately quantifies
   the domain gap and validates path 4.3/4.1.
3. Then decide native app vs. PWA based on how small the acoustic model must get.

## Sources

Products: [Klangio](https://klang.io/) · [Piano2Notes](https://klang.io/piano2notes/) · [Ivory](https://ivory-app.com/) · [Songscription](https://www.songscription.ai/) · [PianoConvert](https://latouchemusicale.com/en/apps/pianoconvert/) · [AnthemScore](https://lunaverus.com/) · [Melody Scanner](https://melodyscanner.com/) · [Music-To-Sheet](https://musictosheet.com/) · [Soundslice](https://www.soundslice.com/transcribe/)

Models & papers: [ByteDance piano_transcription](https://github.com/bytedance/piano_transcription) · [basic-pitch](https://github.com/spotify/basic-pitch) · [basic-pitch-ts](https://github.com/spotify/basic-pitch-ts) · [Onsets and Frames](https://arxiv.org/pdf/1710.11153) · [MT3 / seq2seq transcription](https://arxiv.org/pdf/2107.09142) · [MR-MT3](https://arxiv.org/html/2403.10024v1) · [Streaming piano transcription](https://arxiv.org/html/2503.01362v1) · [PM2S](https://github.com/cheriell/PM2S) · [PM2S paper (ISMIR 2022)](https://archives.ismir.net/ismir2022/paper/000047.pdf) · [End-to-end MIDI→MusicXML transformers (ISMIR 2024)](https://www.researchgate.net/publication/384563350_End-to-end_Piano_Performance-MIDI_to_Score_Conversion_with_Transformers) · [Transformer beat tracking in MIDI (2025)](https://arxiv.org/html/2507.00466v1) · [Transformer rhythm quantization (2026)](https://arxiv.org/html/2604.22290) · [Guitar domain adaptation](https://arxiv.org/pdf/2402.15258) · [Annotation-free AMT with synthetic data](https://arxiv.org/html/2312.10402v3) · [Aria-MIDI dataset](https://arxiv.org/pdf/2504.15071)

Tools: [NeuralNote](https://github.com/DamRsn/NeuralNote) · [Verovio](https://www.verovio.org/) · [awesome-sheet-music](https://github.com/ad-si/awesome-sheet-music) · [AMT notes (0xdevalias)](https://gist.github.com/0xdevalias/f2c6e52824b3bbd4fb4c84c603a3f4bd)
