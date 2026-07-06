import { describe, it, expect } from "vitest";
import createVerovioModule from "verovio/wasm";
import { VerovioToolkit } from "verovio/esm";
import { quantize } from "../src/engine/quantize.js";
import { buildMusicXml } from "../src/engine/musicxml.js";
import fixture from "./fixtures/quantize.json";

describe("Verovio renders our MusicXML", () => {
  it("loads and engraves at least one SVG page", async () => {
    const module = await createVerovioModule();
    const tk = new VerovioToolkit(module);
    tk.setOptions({ scale: 40, footer: "none" });
    const qnotes = quantize(fixture.notes, fixture.bpm);
    const { musicxml } = buildMusicXml(qnotes, fixture.bpm, {
      title: "Fixture", composer: "Tester",
    });
    expect(tk.loadData(musicxml)).toBeTruthy();
    expect(tk.getPageCount()).toBeGreaterThan(0);
    const svg = tk.renderToSVG(1);
    expect(svg).toContain("<svg");
    expect(svg).toContain("Fixture");
  }, 60000);
});
