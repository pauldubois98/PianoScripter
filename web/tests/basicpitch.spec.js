import { describe, it, expect } from "vitest";
import { outputToNotes, eventsToNotes } from "../src/engine/basicpitch-dsp.js";
import fixture from "./fixtures/basicpitch.json";

const note = Float32Array.from(fixture.note);
const onset = Float32Array.from(fixture.onset);

function checkEvents(got, expected) {
  expect(got.length).toBe(expected.length);
  got.forEach(([start, end, pitch, amp], i) => {
    const [rs, re, rp, ra] = expected[i];
    expect(start).toBe(rs);
    expect(end).toBe(re);
    expect(pitch).toBe(rp);
    expect(amp).toBeCloseTo(ra, 4);
  });
}

describe("Basic Pitch note creation port", () => {
  it("matches Python events with the melodia trick", () => {
    checkEvents(outputToNotes(note, onset, fixture.rows, true), fixture.expectedEvents);
  });

  it("matches Python events in streaming mode (no melodia trick)", () => {
    checkEvents(outputToNotes(note, onset, fixture.rows, false), fixture.expectedEventsStream);
  });

  it("produces the same final note events (times + velocities)", () => {
    const events = outputToNotes(note, onset, fixture.rows, true);
    const notes = eventsToNotes(events, fixture.rows);
    expect(notes.length).toBe(fixture.expectedNotes.length);
    notes.forEach((n, i) => {
      const ref = fixture.expectedNotes[i];
      expect(n.pitch).toBe(ref.pitch);
      expect(n.onset).toBeCloseTo(ref.onset, 4);
      expect(n.offset).toBeCloseTo(ref.offset, 4);
      expect(n.velocity).toBe(ref.velocity);
    });
  });
});
