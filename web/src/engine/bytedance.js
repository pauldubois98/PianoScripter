// ByteDance high-resolution piano transcription, in the browser.
// Model execution half: ports transcribe._run_model (Hann overlap-averaged
// windowed inference). Postprocessing lives in bytedance-post.js.
// The ONNX models are produced by tools/export_onnx.py.

import { getSession, ort, BYTEDANCE_MODELS } from "./models.js";
import { postprocess, FRAMES_PER_SECOND, CLASSES_NUM } from "./bytedance-post.js";

const SAMPLE_RATE = 16000;
const SEGMENT_SAMPLES = SAMPLE_RATE * 10; // 10 s windows
const SAMPLES_PER_FRAME = SAMPLE_RATE / FRAMES_PER_SECOND; // 160
const SEG_FRAMES = SEGMENT_SAMPLES / SAMPLES_PER_FRAME; // 1000

export const EFFORT_HOP = { fast: 1.0, balanced: 0.5, best: 0.25 };

// output head name -> classes per frame (names set by the export wrapper)
const HEADS = {
  reg_onset: CLASSES_NUM,
  reg_offset: CLASSES_NUM,
  frame: CLASSES_NUM,
  velocity: CLASSES_NUM,
  reg_pedal_onset: 1,
  reg_pedal_offset: 1,
  pedal_frame: 1,
};

/** Windowed inference with overlap-averaged predictions (hop = effort). */
async function runModel(audio, effort, onProgress) {
  const model = BYTEDANCE_MODELS[effort];
  const session = await getSession(model.file, (p) => onProgress?.("download", p));

  let padded = audio;
  if (padded.length < SEGMENT_SAMPLES) {
    padded = new Float32Array(SEGMENT_SAMPLES);
    padded.set(audio);
  }
  const hop = Math.floor(SEGMENT_SAMPLES * EFFORT_HOP[effort]);
  const starts = [];
  for (let s = 0; s + SEGMENT_SAMPLES <= padded.length; s += hop) starts.push(s);
  if (starts[starts.length - 1] + SEGMENT_SAMPLES < padded.length) {
    starts.push(padded.length - SEGMENT_SAMPLES);
  }

  const nFrames = starts[starts.length - 1] / SAMPLES_PER_FRAME + SEG_FRAMES;
  const window = new Float32Array(SEG_FRAMES); // de-emphasize segment edges
  for (let i = 0; i < SEG_FRAMES; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (SEG_FRAMES - 1)) + 1e-2;
  }

  const acc = {};
  const weight = new Float32Array(nFrames);
  for (const head in HEADS) acc[head] = new Float32Array(nFrames * HEADS[head]);

  for (let idx = 0; idx < starts.length; idx++) {
    const s = starts[idx];
    // slice() so each segment is exactly SEGMENT_SAMPLES starting at s
    const segment = padded.slice(s, s + SEGMENT_SAMPLES);
    const input = new ort.Tensor("float32", segment, [1, SEGMENT_SAMPLES]);
    const result = await session.run({ audio: input });
    const f0 = s / SAMPLES_PER_FRAME;
    for (const head in HEADS) {
      const cols = HEADS[head];
      const data = result[head].data; // (1, SEG_FRAMES+1, cols); extra frame ignored
      const out = acc[head];
      for (let f = 0; f < SEG_FRAMES; f++) {
        const w = window[f];
        for (let c = 0; c < cols; c++) {
          out[(f0 + f) * cols + c] += data[f * cols + c] * w;
        }
      }
    }
    for (let f = 0; f < SEG_FRAMES; f++) weight[f0 + f] += window[f];
    onProgress?.("infer", (idx + 1) / starts.length);
  }

  for (const head in HEADS) {
    const cols = HEADS[head];
    const out = acc[head];
    for (let f = 0; f < nFrames; f++) {
      for (let c = 0; c < cols; c++) out[f * cols + c] /= weight[f];
    }
  }
  return { outputs: acc, nFrames };
}

/** 16 kHz mono audio -> sorted note events + pedal events at the given effort. */
export async function transcribeByteDance(audio16k, effort, onProgress) {
  const { outputs, nFrames } = await runModel(audio16k, effort, onProgress);
  return postprocess(outputs, nFrames);
}
