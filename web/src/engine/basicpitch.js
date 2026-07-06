// Ultra-fast note detection with Spotify's Basic Pitch model (nmp.onnx).
// Model execution half; the pure DSP lives in basicpitch-dsp.js.

import { getSession, ort } from "./models.js";
import { resampleLinear } from "../audio/resample.js";
import {
  BP_SAMPLE_RATE,
  AUDIO_N_SAMPLES,
  OVERLAP_LEN,
  HOP_SIZE,
  unwrap,
  outputToNotes,
  eventsToNotes,
} from "./basicpitch-dsp.js";

export const SAMPLE_RATE = 16000;

const ONNX_INPUT = "serving_default_input_2:0";
const ONNX_NOTE = "StatefulPartitionedCall:1";
const ONNX_ONSET = "StatefulPartitionedCall:2";
const MODEL_FILE = "nmp.onnx";

async function runModel(audio22k) {
  const session = await getSession(MODEL_FILE);
  const originalLength = audio22k.length;
  const padded = new Float32Array(OVERLAP_LEN / 2 + originalLength);
  padded.set(audio22k, OVERLAP_LEN / 2);
  const noteWindows = [];
  const onsetWindows = [];
  for (let i = 0; i < padded.length; i += HOP_SIZE) {
    const window = new Float32Array(AUDIO_N_SAMPLES);
    window.set(padded.subarray(i, Math.min(i + AUDIO_N_SAMPLES, padded.length)));
    const input = new ort.Tensor("float32", window, [1, AUDIO_N_SAMPLES, 1]);
    const result = await session.run({ [ONNX_INPUT]: input });
    noteWindows.push(result[ONNX_NOTE].data);
    onsetWindows.push(result[ONNX_ONSET].data);
  }
  return {
    note: unwrap(noteWindows, originalLength),
    onset: unwrap(onsetWindows, originalLength),
  };
}

/**
 * 16 kHz mono audio -> sorted note events {onset, offset, pitch, velocity}
 * in seconds on the input timeline. melodiaTrick=false when streaming.
 */
export async function transcribeUltra(audio16k, { melodiaTrick = true } = {}) {
  if (audio16k.length < SAMPLE_RATE / 10) return [];
  const audio22k = resampleLinear(audio16k, SAMPLE_RATE, BP_SAMPLE_RATE);
  const { note, onset } = await runModel(audio22k);
  const events = outputToNotes(note.data, onset.data, note.rows, melodiaTrick);
  return eventsToNotes(events, note.rows);
}
