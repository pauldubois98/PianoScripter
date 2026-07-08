import { describe, it, expect } from "vitest";
import { lastEndBefore, silenceGapBefore, shiftFrom } from "../src/engine/quantize.js";

function note(hand, onsetQl, durQl, pitch = 60) {
  return { id: 0, hand, onsetQl, durQl, pitch, velocity: 80 };
}

describe("lastEndBefore / silenceGapBefore", () => {
  it("finds the true cross-hand gap before a point", () => {
    const qnotes = [note("R", 0, 1), note("R", 2, 1), note("L", 0, 1)];
    // nothing ends past QL 1 before onset 2 -> gap of 1 QL
    expect(lastEndBefore(qnotes, 2)).toBe(1);
    expect(silenceGapBefore(qnotes, 2)).toBe(1);
  });

  it("is 0 when a note from the other hand is still sounding through the pivot", () => {
    const qnotes = [note("L", 0, 4), note("R", 3, 1)]; // L holds through 0..4, R's gap-check point is at 3
    expect(lastEndBefore(qnotes, 3)).toBe(4);
    expect(silenceGapBefore(qnotes, 3)).toBe(0); // no true silence: L is still sounding
  });

  it("is 0 right at the very first note (nothing precedes it)", () => {
    const qnotes = [note("R", 0, 1)];
    expect(silenceGapBefore(qnotes, 0)).toBe(0);
  });

  it("never goes negative", () => {
    const qnotes = [note("R", 0, 10)]; // ends at 10, long past the pivot
    expect(silenceGapBefore(qnotes, 2)).toBe(0);
  });
});

describe("shiftFrom", () => {
  it("shifts every qnote (either hand) at or after the pivot, leaving earlier ones untouched", () => {
    const qnotes = [note("R", 0, 1), note("L", 0, 1), note("R", 2, 1), note("L", 2.5, 1)];
    shiftFrom(qnotes, 2, 1);
    expect(qnotes[0].onsetQl).toBe(0); // R before pivot: untouched
    expect(qnotes[1].onsetQl).toBe(0); // L before pivot: untouched
    expect(qnotes[2].onsetQl).toBe(3); // R at pivot: shifted
    expect(qnotes[3].onsetQl).toBe(3.5); // L after pivot: shifted
  });

  it("leaves a note that starts before the pivot untouched even if it sounds through it", () => {
    const qnotes = [note("L", 0, 4)]; // spans 0..4, pivot at 3 is mid-note
    shiftFrom(qnotes, 3, 1);
    expect(qnotes[0].onsetQl).toBe(0); // onset unaffected; note keeps sounding through the new gap
    expect(qnotes[0].durQl).toBe(4); // duration untouched too
  });

  it("supports negative deltas (closing a gap)", () => {
    const qnotes = [note("R", 0, 1), note("R", 3, 1)];
    shiftFrom(qnotes, 3, -1);
    expect(qnotes[1].onsetQl).toBe(2);
  });
});

describe("insert/delete silence workflow", () => {
  it("delete removes exactly the existing gap when it's smaller than a full step", () => {
    const qnotes = [note("R", 0, 1), note("R", 1.5, 1)]; // 0.5 QL gap between them
    const gap = silenceGapBefore(qnotes, 1.5);
    expect(gap).toBe(0.5);
    shiftFrom(qnotes, 1.5, -Math.min(1, gap)); // mirrors deleteSilence's capped delta
    expect(qnotes[1].onsetQl).toBe(1); // gap fully closed, no overshoot into the previous note
  });

  it("insert then delete round-trips back to the original layout", () => {
    const qnotes = [note("R", 0, 1), note("R", 1, 1)];
    shiftFrom(qnotes, 1, 1); // insert a beat of silence before the second note
    expect(qnotes[1].onsetQl).toBe(2);
    const gap = silenceGapBefore(qnotes, 2);
    expect(gap).toBe(1);
    shiftFrom(qnotes, 2, -Math.min(1, gap));
    expect(qnotes[1].onsetQl).toBe(1);
  });
});
