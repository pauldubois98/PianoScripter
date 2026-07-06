import { describe, it, expect } from "vitest";
import { quantize, quantizeAdaptive, HAND_SPLIT_PITCH, MIN_QL, MAX_QL } from "../src/engine/quantize.js";

// Deterministic pseudo-random jitter so the test is reproducible.
function jitter(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1; // [-1, 1)
}

describe("quantizeAdaptive", () => {
  it("recovers a clean eighth-note grid despite a mis-estimated tempo and small jitter", () => {
    const trueBpm = 120;
    const misestimatedBpm = 123; // ~2.5% off, within the calibration search range
    const notes = [];
    for (let i = 0; i < 24; i++) {
      const onset = i * 0.25 + jitter(i) * 0.02; // eighth notes at true tempo, +-20ms jitter
      notes.push({ onset, offset: onset + 0.2, pitch: 72, velocity: 80 });
    }

    const adaptive = quantizeAdaptive(notes, misestimatedBpm);
    const naive = quantize(notes, misestimatedBpm);

    for (const q of adaptive) {
      expect(Math.abs(q.onsetQl / 0.5 - Math.round(q.onsetQl / 0.5))).toBeLessThan(1e-9);
    }
    const naiveOffGrid = naive.filter(
      (q) => Math.abs(q.onsetQl / 0.5 - Math.round(q.onsetQl / 0.5)) > 1e-9
    );
    expect(naiveOffGrid.length).toBeGreaterThan(0);
  });

  it("fills a note's duration to the next onset when the gap is small (legato)", () => {
    const notes = [
      { onset: 0, offset: 0.47, pitch: 72, velocity: 80 }, // ~40ms short of the next onset
      { onset: 0.5, offset: 0.97, pitch: 72, velocity: 80 },
    ];
    const [first] = quantizeAdaptive(notes, 120);
    expect(first.durQl).toBeCloseTo(1, 9); // filled to the next onset (0.5s -> 1 QL @120bpm)
  });

  it("keeps the raw short duration when there's a real gap (staccato)", () => {
    const notes = [
      { onset: 0, offset: 0.2, pitch: 72, velocity: 80 }, // clear gap before the next onset
      { onset: 0.5, offset: 0.97, pitch: 72, velocity: 80 },
    ];
    const [first] = quantizeAdaptive(notes, 120);
    expect(first.durQl).toBeLessThan(1);
  });

  it("returns [] for no notes", () => {
    expect(quantizeAdaptive([], 120)).toEqual([]);
  });

  it("matches quantize()'s hand-split, MIN_QL and MAX_QL clamping", () => {
    const notes = [
      { onset: 0, offset: 0.01, pitch: HAND_SPLIT_PITCH - 1, velocity: 80 }, // left hand, tiny dur
      { onset: 0, offset: 100, pitch: HAND_SPLIT_PITCH, velocity: 80 }, // right hand, huge dur
    ];
    const [left, right] = quantizeAdaptive(notes, 120).sort((a, b) => a.hand.localeCompare(b.hand));
    expect(left.hand).toBe("L");
    expect(left.durQl).toBeGreaterThanOrEqual(MIN_QL);
    expect(right.hand).toBe("R");
    expect(right.durQl).toBeLessThanOrEqual(MAX_QL);
  });
});
