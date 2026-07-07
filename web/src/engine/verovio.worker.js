// Engraving worker: MusicXML -> per-page SVG strings with Verovio (WASM).
// Mirrors render.musicxml_to_svgs, including the composer pgHead injection.

import createVerovioModule from "verovio/wasm";
import { VerovioToolkit } from "verovio/esm";

const VEROVIO_OPTIONS = {
  scale: 40,
  adjustPageHeight: false,
  footer: "none",
  pageMarginTop: 60,
  pageMarginBottom: 60,
  pageMarginLeft: 60,
  pageMarginRight: 60,
};

let toolkitPromise = null;

function getToolkit() {
  if (!toolkitPromise) {
    toolkitPromise = createVerovioModule().then((module) => {
      const tk = new VerovioToolkit(module);
      tk.setOptions(VEROVIO_OPTIONS);
      return tk;
    });
  }
  return toolkitPromise;
}

function escapeXml(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function render(tk, musicxml, title, composer) {
  if (!tk.loadData(musicxml)) throw new Error("Verovio could not load the MusicXML");
  if (composer) {
    // Verovio's auto header drops the composer: inject an explicit pgHead via MEI
    const pghead =
      '<pgHead func="first">' +
      `<rend halign="center" valign="top" fontsize="x-large">${escapeXml(title || "")}</rend>` +
      `<rend halign="right" valign="bottom">${escapeXml(composer)}</rend>` +
      "</pgHead>";
    const mei = tk.getMEI().replace(/<scoreDef[^>]*>/, (m) => m + pghead);
    if (!tk.loadData(mei)) throw new Error("Verovio could not reload the MEI with the header");
  }
  const pages = [];
  for (let i = 1; i <= tk.getPageCount(); i++) pages.push(tk.renderToSVG(i));
  return pages;
}

self.onmessage = async (e) => {
  const { id, type, musicxml, title, composer, ms } = e.data;
  try {
    const tk = await getToolkit();
    if (type === "render") {
      self.postMessage({ id, type: "done", svgPages: render(tk, musicxml, title, composer) });
    } else if (type === "elementsAtTime") {
      // Reads from whatever score was last loaded by "render" above.
      self.postMessage({ id, type: "done", elements: tk.getElementsAtTime(ms) });
    }
  } catch (err) {
    self.postMessage({ id, type: "error", message: err?.message || String(err) });
  }
};
