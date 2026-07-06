// Transcription worker: runs the ONNX models off the main thread.
// Protocol: { id, type: "transcribe", audio, effort, melodiaTrick } ->
//   progress: { id, type: "progress", stage, value }
//   done:     { id, type: "done", notes, pedals }
//   error:    { id, type: "error", message }

import { transcribeUltra } from "./basicpitch.js";
import { transcribeByteDance, EFFORT_HOP } from "./bytedance.js";

self.onmessage = async (e) => {
  const { id, type, audio, effort, melodiaTrick } = e.data;
  if (type !== "transcribe") return;
  try {
    let notes;
    let pedals = [];
    if (effort === "ultra") {
      notes = await transcribeUltra(audio, { melodiaTrick });
    } else if (effort in EFFORT_HOP) {
      const result = await transcribeByteDance(audio, effort, (stage, value) =>
        self.postMessage({ id, type: "progress", stage, value })
      );
      notes = result.notes;
      pedals = result.pedals;
    } else {
      throw new Error(`unknown effort: ${effort}`);
    }
    self.postMessage({ id, type: "done", notes, pedals });
  } catch (err) {
    self.postMessage({ id, type: "error", message: err?.message || String(err) });
  }
};
