// ONNX Runtime session management + model fetching with progress and
// Cache API storage. Runs inside the transcribe worker.

import * as ort from "onnxruntime-web";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import mjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";

ort.env.wasm.wasmPaths = { wasm: new URL(wasmUrl, self.location.href).href, mjs: new URL(mjsUrl, self.location.href).href };
ort.env.wasm.numThreads = self.crossOriginIsolated
  ? Math.min(4, navigator.hardwareConcurrency || 1)
  : 1;

export { ort };

const CACHE_NAME = "piano-scripter-models-v2";

// The ByteDance exports are too large for the repo; they are downloaded on
// demand. Order: same-origin models/ dir (local dev / self-hosting), then the
// remote release. Sizes are shown to the user before the first download.
// fast and balanced share the fp16 file (effort = window hop, not weights),
// so one ~90 MB download covers both; best uses the full-precision weights.
export const BYTEDANCE_MODELS = {
  fast: { file: "bytedance-fp16.onnx", mb: 90 },
  balanced: { file: "bytedance-fp16.onnx", mb: 90 },
  best: { file: "bytedance-fp32.onnx", mb: 175 },
};
const REMOTE_BASE = "https://huggingface.co/pauldubois98/piano-quantized/resolve/main/";

const sessions = new Map();

async function fetchWithProgress(url, onProgress) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  // static hosts answer missing paths with the SPA's index.html and a 200:
  // never hand HTML to the ONNX parser
  const type = resp.headers.get("Content-Type") || "";
  if (type.includes("text/html")) throw new Error(`not a model file: ${url}`);
  const total = Number(resp.headers.get("Content-Length")) || 0;
  if (!resp.body || !total) return new Uint8Array(await resp.arrayBuffer());
  const reader = resp.body.getReader();
  const buf = new Uint8Array(total);
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf.set(value, received);
    received += value.length;
    onProgress?.(received / total);
  }
  return buf.subarray(0, received);
}

async function loadModelBytes(file, onProgress) {
  const localUrl = new URL(`models/${file}`, self.location.origin + basePath()).href;
  const remoteUrl = REMOTE_BASE + file;
  let cache = null;
  try {
    cache = await caches.open(CACHE_NAME);
    for (const url of [localUrl, remoteUrl]) {
      const hit = await cache.match(url);
      if (hit) return new Uint8Array(await hit.arrayBuffer());
    }
  } catch {
    // Cache API unavailable (e.g. private browsing): plain fetch below
  }
  let lastError;
  for (const url of [localUrl, remoteUrl]) {
    try {
      const bytes = await fetchWithProgress(url, onProgress);
      try {
        await cache?.put(url, new Response(bytes.slice().buffer));
      } catch {
        // quota exceeded: keep going without caching
      }
      return bytes;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

function basePath() {
  // worker URL lives under the deploy base; models/ sits next to index.html
  const path = self.location.pathname;
  return path.slice(0, path.lastIndexOf("/assets/") + 1) || "/";
}

/** Get (or create) an inference session for a model file. */
export async function getSession(file, onProgress) {
  if (sessions.has(file)) return sessions.get(file);
  const bytes = await loadModelBytes(file, onProgress);
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: ["wasm"],
  });
  sessions.set(file, session);
  return session;
}
