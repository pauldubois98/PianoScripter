import { describe, it, expect } from "vitest";
import { postprocess } from "../src/engine/bytedance-post.js";
import fixture from "./fixtures/bytedance_post.json";

describe("ByteDance RegressionPostProcessor port", () => {
  const outputs = Object.fromEntries(
    Object.entries(fixture.heads).map(([k, v]) => [k, Float32Array.from(v)])
  );
  const { notes, pedals } = postprocess(outputs, fixture.nFrames);

  it("detects the same notes as the Python reference", () => {
    // the Python fixture is pitch-major; the JS port pre-sorts by onset
    // (like transcribe_array does), so align the reference before comparing
    const expected = [...fixture.expectedNotes].sort(
      (a, b) => a.onset - b.onset || a.pitch - b.pitch
    );
    expect(notes.length).toBe(expected.length);
    notes.forEach((n, i) => {
      const ref = expected[i];
      expect(n.pitch).toBe(ref.pitch);
      expect(n.onset).toBeCloseTo(ref.onset, 3);
      expect(n.offset).toBeCloseTo(ref.offset, 3);
      expect(Math.abs(n.velocity - ref.velocity)).toBeLessThanOrEqual(1);
    });
  });

  it("detects the same pedal events", () => {
    expect(pedals.length).toBe(fixture.expectedPedals.length);
    pedals.forEach((p, i) => {
      expect(p.onset_time).toBeCloseTo(fixture.expectedPedals[i].onset, 3);
      expect(p.offset_time).toBeCloseTo(fixture.expectedPedals[i].offset, 3);
    });
  });
});
