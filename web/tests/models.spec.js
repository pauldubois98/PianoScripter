// Regression test for a production bug: a download that was truncated
// mid-stream (dropped connection, flaky CDN) got cached anyway, permanently
// breaking transcription on every reload with an ONNX parse error ("Error in
// input stream") until the user manually cleared site data.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("onnxruntime-web", () => ({
  ort: undefined,
  env: { wasm: {} },
  InferenceSession: { create: vi.fn() },
}));
vi.mock("onnxruntime-web/ort-wasm-simd-threaded.wasm?url", () => ({ default: "wasm-url" }));
vi.mock("onnxruntime-web/ort-wasm-simd-threaded.mjs?url", () => ({ default: "mjs-url" }));

// A fake Cache API good enough for loadModelBytes/getSession's usage.
function makeFakeCaches() {
  const store = new Map();
  const cache = {
    match: vi.fn(async (url) => store.get(url) ?? null),
    put: vi.fn(async (url, response) => {
      store.set(url, response);
    }),
    delete: vi.fn(async (url) => store.delete(url)),
  };
  return { caches: { open: vi.fn(async () => cache) }, cache, store };
}

// A fetch Response whose body reader reports `done` after only `truncateAt`
// bytes, without ever throwing -- the exact "silent truncation" this bug
// depended on (a real network error would already have been caught).
function truncatedResponse(total, truncateAt) {
  const chunk = new Uint8Array(truncateAt).fill(7);
  let read = false;
  return {
    ok: true,
    headers: new Map([["Content-Length", String(total)]]),
    body: {
      getReader: () => ({
        read: async () => {
          if (read) return { done: true, value: undefined };
          read = true;
          return { done: false, value: chunk };
        },
      }),
    },
  };
}

function fullResponse(bytes) {
  let read = false;
  return {
    ok: true,
    headers: new Map([["Content-Length", String(bytes.length)]]),
    body: {
      getReader: () => ({
        read: async () => {
          if (read) return { done: true, value: undefined };
          read = true;
          return { done: false, value: bytes };
        },
      }),
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  globalThis.self = globalThis;
  self.location = new URL("http://localhost/PianoScripter/assets/index.js");
  self.crossOriginIsolated = false;
});

describe("models.js download integrity", () => {
  it("throws on a truncated download instead of returning partial bytes", async () => {
    const { caches, store } = makeFakeCaches();
    globalThis.caches = caches;
    globalThis.fetch = vi.fn(async () => truncatedResponse(100, 40));

    const { getSession } = await import("../src/engine/models.js");
    const ort = await import("onnxruntime-web");
    ort.InferenceSession.create.mockResolvedValue({});

    await expect(getSession("bytedance-fp16.onnx")).rejects.toThrow();
    // the truncated bytes must never have been written to the cache
    expect(store.size).toBe(0);
  });

  it("caches a fully-downloaded model and reuses it without re-fetching", async () => {
    const { caches } = makeFakeCaches();
    globalThis.caches = caches;
    const bytes = new Uint8Array(64).fill(9);
    const fetchMock = vi.fn(async () => fullResponse(bytes));
    globalThis.fetch = fetchMock;

    const { getSession } = await import("../src/engine/models.js");
    const ort = await import("onnxruntime-web");
    ort.InferenceSession.create.mockResolvedValue({ ok: true });

    await getSession("bytedance-fp16.onnx");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("self-heals a corrupted cache entry instead of failing forever", async () => {
    const { caches, cache } = makeFakeCaches();
    globalThis.caches = caches;
    // Pre-seed the cache with a "corrupted" entry, as if an earlier build
    // (without the truncation check) had stored a partial download.
    const localUrl = "http://localhost/PianoScripter/models/bytedance-fp16.onnx";
    await cache.put(localUrl, new Response(new Uint8Array([1, 2, 3]).buffer));

    const goodBytes = new Uint8Array(64).fill(9);
    const fetchMock = vi.fn(async () => fullResponse(goodBytes));
    globalThis.fetch = fetchMock;

    const { getSession } = await import("../src/engine/models.js");
    const ort = await import("onnxruntime-web");
    // First call (corrupted cached bytes) fails to parse; second (fresh
    // network bytes) succeeds.
    ort.InferenceSession.create.mockRejectedValueOnce(new Error("Error in input stream"));
    ort.InferenceSession.create.mockResolvedValueOnce({ ok: true });

    const session = await getSession("bytedance-fp16.onnx");
    expect(session).toEqual({ ok: true });
    expect(cache.delete).toHaveBeenCalledWith(localUrl);
    expect(fetchMock).toHaveBeenCalledTimes(1); // fell through to the network once
  });
});
