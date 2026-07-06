import { describe, it, expect } from "vitest";
import { quantize, roundHalfEven } from "../src/engine/quantize.js";
import fixture from "./fixtures/quantize.json";

describe("roundHalfEven", () => {
  it("matches Python round() on halves", () => {
    expect(roundHalfEven(0.5)).toBe(0);
    expect(roundHalfEven(1.5)).toBe(2);
    expect(roundHalfEven(2.5)).toBe(2);
    expect(roundHalfEven(3.5)).toBe(4);
    expect(roundHalfEven(2.4)).toBe(2);
    expect(roundHalfEven(2.6)).toBe(3);
  });
});

describe("quantize", () => {
  it("reproduces the Python reference exactly", () => {
    const got = quantize(fixture.notes, fixture.bpm);
    expect(got.length).toBe(fixture.expected.length);
    got.forEach((q, i) => {
      const ref = fixture.expected[i];
      expect(q.hand).toBe(ref.hand);
      expect(q.onsetQl).toBeCloseTo(ref.onset_ql, 9);
      expect(q.durQl).toBeCloseTo(ref.dur_ql, 9);
      expect(q.pitch).toBe(ref.pitch);
      expect(q.velocity).toBe(ref.velocity);
      expect(q.id).toBe(ref.id);
    });
  });

  it("returns [] for no notes", () => {
    expect(quantize([], 120)).toEqual([]);
  });
});
