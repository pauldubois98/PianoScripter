// Main-thread facade over the two workers: promise-per-request messaging.

import TranscribeWorker from "./transcribe.worker.js?worker";
import VerovioWorker from "./verovio.worker.js?worker";

function makeClient(WorkerCtor) {
  const worker = new WorkerCtor();
  const pending = new Map();
  let nextId = 1;
  worker.onmessage = (e) => {
    const { id, type } = e.data;
    const req = pending.get(id);
    if (!req) return;
    if (type === "progress") {
      req.onProgress?.(e.data.stage, e.data.value);
    } else if (type === "done") {
      pending.delete(id);
      req.resolve(e.data);
    } else if (type === "error") {
      pending.delete(id);
      req.reject(new Error(e.data.message));
    }
  };
  return {
    request(payload, { transfer = [], onProgress } = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, onProgress });
        worker.postMessage({ id, ...payload }, transfer);
      });
    },
  };
}

const transcriber = makeClient(TranscribeWorker);
const engraver = makeClient(VerovioWorker);

/**
 * 16 kHz mono Float32Array -> { notes, pedals }.
 * The buffer is copied, not transferred: callers keep ownership.
 */
export async function transcribeAudio(audio, effort, { melodiaTrick = true, onProgress } = {}) {
  const copy = audio.slice();
  const { notes, pedals } = await transcriber.request(
    { type: "transcribe", audio: copy, effort, melodiaTrick },
    { onProgress, transfer: [copy.buffer] }
  );
  return { notes, pedals };
}

/** MusicXML -> per-page SVG strings. */
export async function renderScore(musicxml, { title = "", composer = "" } = {}) {
  const { svgPages } = await engraver.request({ type: "render", musicxml, title, composer });
  return svgPages;
}

/**
 * IDs of the notes/rests sounding at `ms` milliseconds into the currently
 * rendered score (per the tempo baked into its MusicXML by buildMusicXml).
 */
export async function elementsAtTime(ms) {
  const { elements } = await engraver.request({ type: "elementsAtTime", ms: Math.round(ms) });
  return elements;
}
