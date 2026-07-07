// Live-grade piano transcription with Magenta's realtime Onsets and Frames
// (uni-directional LSTM, wav-input). Converted from the TFLite release with
// tools/oaf/patch_bias.py (tf2onnx drops the FULLY_CONNECTED biases).
// The model is stateless across chunks: each 17920-sample (1.12 s @ 16 kHz)
// window is independent, so it streams by construction.

import { getSession, ort } from "./models.js";

export const OAF_MODEL = { file: "oaf-fp16.onnx", mb: 50 };

const CHUNK = 17920; // model input length, 1.12 s @ 16 kHz
const FRAMES_PER_CHUNK = 32; // -> 35 ms per frame
const FRAME_SECONDS = CHUNK / 16000 / FRAMES_PER_CHUNK;
const N_PITCHES = 88;
const MIDI_LOW = 21; // A0

const ONSET_THRESHOLD = 0.5;
const FRAME_THRESHOLD = 0.5;

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

async function runChunks(audio16k, onProgress) {
  const session = await getSession(OAF_MODEL.file, (p) => onProgress?.("download", p));
  const nChunks = Math.ceil(audio16k.length / CHUNK);
  const frames = nChunks * FRAMES_PER_CHUNK;
  const onsetP = new Float32Array(frames * N_PITCHES);
  const frameP = new Float32Array(frames * N_PITCHES);
  const velocity = new Float32Array(frames * N_PITCHES);
  for (let c = 0; c < nChunks; c++) {
    const window = new Float32Array(CHUNK);
    window.set(audio16k.subarray(c * CHUNK, Math.min((c + 1) * CHUNK, audio16k.length)));
    const out = await session.run({ Placeholder: new ort.Tensor("float32", window, [CHUNK]) });
    const base = c * FRAMES_PER_CHUNK * N_PITCHES;
    const on = out.onset_logits.data;
    const fr = out.frame_logits.data;
    const vel = out.velocity_values.data;
    for (let i = 0; i < FRAMES_PER_CHUNK * N_PITCHES; i++) {
      onsetP[base + i] = sigmoid(on[i]);
      frameP[base + i] = sigmoid(fr[i]);
      velocity[base + i] = vel[i];
    }
    onProgress?.("infer", (c + 1) / nChunks);
  }
  return { onsetP, frameP, velocity, frames };
}

/** Standard O&F decoding: an onset starts a note, the frame head sustains it. */
function decodeNotes({ onsetP, frameP, velocity, frames }) {
  const notes = [];
  const activeStart = new Int32Array(N_PITCHES).fill(-1);
  const activeVel = new Float32Array(N_PITCHES);
  const emit = (pitch, start, end) => {
    const v = Math.min(1, Math.max(0, activeVel[pitch]));
    notes.push({
      onset: start * FRAME_SECONDS,
      offset: end * FRAME_SECONDS,
      pitch: pitch + MIDI_LOW,
      velocity: Math.min(127, Math.max(1, Math.round(v * 127))),
    });
  };
  for (let t = 0; t < frames; t++) {
    for (let p = 0; p < N_PITCHES; p++) {
      const i = t * N_PITCHES + p;
      const onset =
        onsetP[i] > ONSET_THRESHOLD && (t === 0 || onsetP[i - N_PITCHES] <= ONSET_THRESHOLD);
      const sounding = frameP[i] > FRAME_THRESHOLD;
      if (activeStart[p] >= 0) {
        if (onset && t - activeStart[p] > 1) {
          emit(p, activeStart[p], t); // retrigger: close and restart
          activeStart[p] = t;
          activeVel[p] = velocity[i];
        } else if (!sounding) {
          emit(p, activeStart[p], t);
          activeStart[p] = -1;
        }
      } else if (onset) {
        activeStart[p] = t;
        activeVel[p] = velocity[i];
      }
    }
  }
  for (let p = 0; p < N_PITCHES; p++) {
    if (activeStart[p] >= 0) emit(p, activeStart[p], frames);
  }
  notes.sort((a, b) => a.onset - b.onset || a.pitch - b.pitch);
  return notes;
}

/**
 * 16 kHz mono audio -> sorted note events {onset, offset, pitch, velocity}
 * in seconds on the input timeline.
 */
export async function transcribeOaf(audio16k, onProgress) {
  if (audio16k.length < 1600) return [];
  return decodeNotes(await runChunks(audio16k, onProgress));
}
