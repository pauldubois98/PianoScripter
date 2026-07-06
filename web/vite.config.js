import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// COOP/COEP headers give the dev server cross-origin isolation, which lets
// onnxruntime-web use multi-threaded WASM. In production the same is achieved
// by public/_headers (Netlify) or public/coi-serviceworker.min.js (GitHub Pages).
const isolationHeaders = (server) => {
  server.middlewares.use((_req, res, next) => {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
    next();
  });
};
const crossOriginIsolation = {
  name: "cross-origin-isolation",
  configureServer: isolationHeaders,
  configurePreviewServer: isolationHeaders,
};

export default defineConfig({
  base: "./",
  plugins: [vue(), crossOriginIsolation],
  worker: { format: "es" },
  optimizeDeps: { exclude: ["onnxruntime-web", "verovio"] },
  // assetsInlineLimit 0: the audio worklet must stay a real file —
  // audioWorklet.addModule() rejects data: URIs in some browsers
  build: { target: "es2022", chunkSizeWarningLimit: 4000, assetsInlineLimit: 0 },
  test: { environment: "node" },
});
