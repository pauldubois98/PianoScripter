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

// Bumped whenever a caching bug is fixed, so every user gets a guaranteed
// clean slate on next load instead of relying solely on the runtime
// self-heal in getSession() below (which can only catch corruption that
// actually fails to parse).
const CACHE_NAME = "piano-scripter-models-v3";

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
  // We already do our own long-lived, integrity-checked caching via the
  // Cache API below; letting the browser's HTTP cache (or a service worker
  // sitting in front of it, e.g. coi-serviceworker on GitHub Pages) also
  // cache/replay these large responses only adds a second place a bad
  // response can get stuck and served back on retry.
  const resp = await fetch(url, { cache: "no-store" });
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
  // A stream can end early (dropped connection, flaky CDN) without the
  // reader ever surfacing an error -- catch that here instead of handing a
  // truncated model to the ONNX parser (and, worse, caching it forever).
  if (received !== total) {
    throw new Error(`incomplete download for ${url}: got ${received} of ${total} bytes`);
  }
  return buf;
}

async function readFromCache(cache, urls) {
  for (const url of urls) {
    const hit = await cache?.match(url).catch(() => null);
    if (hit) return { url, bytes: new Uint8Array(await hit.arrayBuffer()) };
  }
  return null;
}

const TRANSIENT_RETRIES = 2; // extra attempts per URL, beyond the first
const RETRY_DELAY_MS = 700;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchFresh(cache, urls, onProgress) {
  let lastError;
  for (const url of urls) {
    for (let attempt = 0; attempt <= TRANSIENT_RETRIES; attempt++) {
      try {
        const bytes = await fetchWithProgress(url, onProgress);
        try {
          await cache?.put(url, new Response(bytes.slice().buffer));
        } catch {
          // quota exceeded: keep going without caching
        }
        return { url, bytes };
      } catch (err) {
        lastError = err;
        // A dropped connection or a CDN hiccup mid-stream is transient --
        // silently retry a couple of times before moving on to the next
        // candidate URL (or giving up), instead of surfacing a one-off
        // network blip as a hard failure to the user.
        if (attempt < TRANSIENT_RETRIES) await sleep(RETRY_DELAY_MS);
      }
    }
  }
  throw lastError;
}

function candidateUrls(file) {
  const localUrl = new URL(`models/${file}`, self.location.origin + basePath()).href;
  const remoteUrl = REMOTE_BASE + file;
  return [localUrl, remoteUrl];
}

async function loadModelBytes(file, onProgress, { skipCache = false } = {}) {
  const urls = candidateUrls(file);
  let cache = null;
  try {
    cache = await caches.open(CACHE_NAME);
  } catch {
    // Cache API unavailable (e.g. private browsing): plain fetch below
  }
  if (cache && !skipCache) {
    const hit = await readFromCache(cache, urls);
    if (hit) return { ...hit, cache };
  }
  const fresh = await fetchFresh(cache, urls, onProgress);
  return { ...fresh, cache };
}

function basePath() {
  // worker URL lives under the deploy base; models/ sits next to index.html
  const path = self.location.pathname;
  return path.slice(0, path.lastIndexOf("/assets/") + 1) || "/";
}

async function createSession(file, url, bytes) {
  try {
    return await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] });
  } catch (err) {
    // Surface enough context (which file/url/size) that this doesn't read
    // as an opaque parser error with no way to tell what actually failed.
    throw new Error(`ONNX parse failed for ${file} (${bytes.length} bytes from ${url}): ${err.message}`);
  }
}

/** Get (or create) an inference session for a model file. */
export async function getSession(file, onProgress) {
  if (sessions.has(file)) return sessions.get(file);
  const { bytes, url, cache } = await loadModelBytes(file, onProgress);
  try {
    const session = await createSession(file, url, bytes);
    sessions.set(file, session);
    return session;
  } catch (err) {
    // The bytes we just tried may be a truncated/corrupted entry cached by
    // an older build (before the download-integrity check above existed).
    // Drop every candidate cache entry for this file and retry once
    // straight from the network so users self-heal instead of failing
    // forever on every reload.
    for (const candidate of candidateUrls(file)) {
      await cache?.delete(candidate).catch(() => {});
    }
    let retry;
    try {
      retry = await loadModelBytes(file, onProgress, { skipCache: true });
    } catch {
      throw err; // the retry's own fetch failure is less informative than the parse error
    }
    const session = await createSession(file, retry.url, retry.bytes);
    sessions.set(file, session);
    return session;
  }
}
