// Lets the main thread ask "will picking this effort trigger a download?"
// without importing engine/models.js, which pulls in onnxruntime-web (only
// appropriate inside the transcribe worker).
//
// CACHE_NAME/REMOTE_BASE and the file/mb pairs below are duplicated from
// models.js/oaf.js by hand (not imported, for the reason above) -- keep them
// in sync if those change.
export const MODEL_DOWNLOAD_INFO = {
  oaf: { file: "oaf-fp16.onnx", mb: 50 },
  fast: { file: "bytedance-fp16.onnx", mb: 90 },
  balanced: { file: "bytedance-fp16.onnx", mb: 90 },
  best: { file: "bytedance-fp32.onnx", mb: 175 },
};

const CACHE_NAME = "piano-scripter-models-v4";
const REMOTE_BASE = "https://huggingface.co/pauldubois98/piano-quantized/resolve/main/";

/** Whether `file` has already been downloaded and cached (no network call). */
export async function isModelCached(file) {
  try {
    const cache = await caches.open(CACHE_NAME);
    return !!(await cache.match(REMOTE_BASE + file));
  } catch {
    return false; // Cache API unavailable (e.g. private browsing): treat as uncached
  }
}
