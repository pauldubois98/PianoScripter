import { describe, it, expect } from "vitest";
import { decomposeDuration, buildMeasures } from "../src/engine/score.js";
import { buildMusicXml } from "../src/engine/musicxml.js";
import { detectKey } from "../src/engine/keydetect.js";
import { quantize } from "../src/engine/quantize.js";
import { buildMidi } from "../src/engine/midi.js";
import fixture from "./fixtures/quantize.json";

const qn = (over) => ({ id: 0, hand: "R", onsetQl: 0, durQl: 1, pitch: 72, velocity: 80, ...over });

describe("decomposeDuration", () => {
  it("keeps expressible durations whole", () => {
    for (const d of [4, 3, 2, 1.5, 1, 0.75, 0.5, 0.25]) {
      expect(decomposeDuration(d)).toEqual([d]);
    }
  });
  it("splits awkward durations largest-first", () => {
    expect(decomposeDuration(3.5)).toEqual([3, 0.5]);
    expect(decomposeDuration(1.25)).toEqual([1, 0.25]);
    expect(decomposeDuration(2.75)).toEqual([2, 0.75]);
  });
});

describe("buildMeasures", () => {
  it("ties notes across barlines", () => {
    const { measures, nMeasures } = buildMeasures([qn({ onsetQl: 3, durQl: 2 })]);
    expect(nMeasures).toBe(2);
    const m1 = measures.R[0].filter((i) => i.kind === "chord");
    const m2 = measures.R[1].filter((i) => i.kind === "chord");
    expect(m1).toHaveLength(1);
    expect(m1[0].tieStart).toBe(true);
    expect(m2[0].tieStop).toBe(true);
    expect(m1[0].durQl + m2[0].durQl).toBe(2);
  });

  it("pads both hands to the same measure count with rests", () => {
    const { measures } = buildMeasures([qn({ onsetQl: 6 })]);
    expect(measures.L).toHaveLength(2);
    expect(measures.L[0][0]).toMatchObject({ kind: "rest", wholeMeasure: true });
  });

  it("groups same-onset notes into one chord", () => {
    const { measures } = buildMeasures([qn({ pitch: 60 }), qn({ pitch: 64 })]);
    const chords = measures.R[0].filter((i) => i.kind === "chord");
    expect(chords).toHaveLength(1);
    expect(chords[0].pitches).toEqual([60, 64]);
  });
});

describe("detectKey", () => {
  it("finds C major for a C major scale", () => {
    const scale = [60, 62, 64, 65, 67, 69, 71, 72].map((p, i) => qn({ pitch: p, onsetQl: i }));
    const got = detectKey(scale);
    expect(got.name).toBe("C major");
    expect(got.fifths).toBe(0);
  });
  it("returns null for no notes", () => {
    expect(detectKey([])).toBeNull();
  });
});

describe("buildMusicXml", () => {
  const qnotes = quantize(fixture.notes, fixture.bpm);
  const { musicxml, key } = buildMusicXml(qnotes, fixture.bpm, {
    title: "Test <Title>",
    composer: "A & B",
  });

  it("emits well-formed escaped XML with both parts", () => {
    expect(musicxml).toContain("<score-partwise");
    expect(musicxml).toContain('<part id="P1">');
    expect(musicxml).toContain('<part id="P2">');
    expect(musicxml).toContain("Test &lt;Title&gt;");
    expect(musicxml).toContain("A &amp; B");
    expect(musicxml).toContain(`${Math.round(fixture.bpm)} BPM`);
    expect(key).toBeTruthy();
  });

  it("balances measures across parts", () => {
    const count = (part) =>
      (musicxml.split(`<part id="${part}">`)[1].split("</part>")[0].match(/<measure /g) || [])
        .length;
    expect(count("P1")).toBe(count("P2"));
    expect(count("P1")).toBeGreaterThan(0);
  });

  it("accounts for every quantized note as a note or tied pair", () => {
    // every qnote produces >= 1 <pitch> entry; ties add more
    const pitchCount = (musicxml.match(/<pitch>/g) || []).length;
    expect(pitchCount).toBeGreaterThanOrEqual(qnotes.length);
  });
});

describe("buildMidi", () => {
  it("produces a parseable MIDI file with all notes", () => {
    const qnotes = quantize(fixture.notes, fixture.bpm);
    const bytes = buildMidi(qnotes, fixture.bpm);
    expect(bytes.length).toBeGreaterThan(50);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("MThd");
  });
});
