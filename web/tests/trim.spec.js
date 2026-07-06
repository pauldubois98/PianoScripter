import { describe, it, expect } from "vitest";
import { trimSilence } from "../src/audio/trim.js";
import { estimateTempo } from "../src/audio/tempo.js";
import fixture from "./fixtures/trim.json";

function buildFixtureSignal() {
  const { sampleRate, durationS, toneStartS, toneEndS, toneHz, amplitude } = fixture;
  const audio = new Float32Array(sampleRate * durationS);
  for (let i = sampleRate * toneStartS; i < sampleRate * toneEndS; i++) {
    const t = (i - sampleRate * toneStartS) / sampleRate;
    audio[i] = Math.fround(amplitude * Math.sin(2 * Math.PI * toneHz * t));
  }
  return audio;
}

describe("trimSilence", () => {
  it("matches librosa.effects.trim on the reference signal", () => {
    const trimmed = trimSilence(buildFixtureSignal());
    expect(trimmed.length).toBe(fixture.expectedLength);
  });

  it("keeps loud audio untouched", () => {
    const audio = new Float32Array(16000).fill(0.4);
    expect(trimSilence(audio).length).toBe(audio.length);
  });
});

describe("estimateTempo", () => {
  it("finds the tempo of a click track within tolerance", () => {
    const sr = 16000;
    const bpm = 100;
    const audio = new Float32Array(sr * 10);
    const period = Math.round((60 / bpm) * sr);
    for (let i = 0; i < audio.length; i += period) {
      for (let j = 0; j < 400 && i + j < audio.length; j++) {
        audio[i + j] = (1 - j / 400) * Math.sin((2 * Math.PI * 880 * j) / sr);
      }
    }
    const got = estimateTempo(audio);
    expect(Math.abs(got - bpm)).toBeLessThanOrEqual(3);
  });

  it("falls back to 120 for tiny inputs", () => {
    expect(estimateTempo(new Float32Array(1000))).toBe(120);
  });
});
