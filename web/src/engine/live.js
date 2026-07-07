// Live session: mirrors server.py's LiveSession/_live_process, but feeds on
// the mic's rolling 16 kHz buffer directly (no webm re-decoding).

import { SAMPLE_RATE } from "../audio/decode.js";
import { estimateTempo } from "../audio/tempo.js";
import { transcribeAudio, renderScore } from "./engine.js";
import { quantize } from "./quantize.js";
import { buildMusicXml } from "./musicxml.js";

const CONTEXT_SECONDS = 2.0; // reprocessed tail: lets note offsets refine
const MIN_NEW_SECONDS = 0.3; // skip a pass when almost no new audio arrived
const ENGRAVE_INTERVAL = 3000; // ms between engraved-draft refreshes

export class LiveSession {
  constructor(mic, { engine = "ultra", onProgress } = {}) {
    this.mic = mic;
    this.engine = engine; // "ultra" (Basic Pitch) or "oaf" (Onsets and Frames)
    this.onProgress = onProgress;
    this.processedSamples = 0;
    // keyed by "pitch|tick" (50 ms ticks): re-detections refine sounding notes
    this.events = new Map();
    this.bpm = null;
    this.svgPages = [];
    this.lastEngrave = 0;
    this.engravedNotes = 0;
    this.busy = false;
  }

  /** One pass: transcribe the trailing window, merge events, maybe engrave. */
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const audio = this.mic.snapshot();
      if (audio.length - this.processedSamples < MIN_NEW_SECONDS * SAMPLE_RATE) return;
      const start = Math.max(0, this.processedSamples - CONTEXT_SECONDS * SAMPLE_RATE);
      // melodiaTrick off: it invents onset-less notes, re-triggering held notes
      const { notes } = await transcribeAudio(audio.subarray(start), this.engine, {
        melodiaTrick: false,
        onProgress: this.onProgress,
      });
      const offset = start / SAMPLE_RATE;
      for (const n of notes) {
        const event = {
          onset: n.onset + offset,
          offset: n.offset + offset,
          pitch: n.pitch,
          velocity: n.velocity,
        };
        const tick = Math.round(event.onset * 20);
        const keys = [`${n.pitch}|${tick}`, `${n.pitch}|${tick - 1}`, `${n.pitch}|${tick + 1}`];
        const key = keys.find((k) => this.events.has(k)) ?? keys[0];
        this.events.set(key, event);
      }
      this.processedSamples = audio.length;
      if (this.bpm === null && audio.length >= SAMPLE_RATE * 5) {
        this.bpm = estimateTempo(audio);
      }

      const now = performance.now();
      const stale = this.events.size !== this.engravedNotes;
      if (this.events.size && stale && now - this.lastEngrave >= ENGRAVE_INTERVAL) {
        const qnotes = quantize(this.sortedEvents(), this.bpm || 120.0);
        const { musicxml } = buildMusicXml(qnotes, this.bpm || 120.0);
        this.svgPages = await renderScore(musicxml);
        this.lastEngrave = now;
        this.engravedNotes = this.events.size;
      }
    } finally {
      this.busy = false;
    }
  }

  sortedEvents() {
    return [...this.events.values()].sort((a, b) => a.onset - b.onset || a.pitch - b.pitch);
  }
}
