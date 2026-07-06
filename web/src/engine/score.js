// Quantized notes -> measure structure ready for MusicXML serialization.
// Replaces music21's build_score/makeMeasures/makeRests for our constrained
// case: fixed 4/4, sixteenth grid, one chord stream per hand (quantize
// guarantees non-overlapping events per hand, so no multi-voice logic).

export const MEASURE_QL = 4;

// single-symbol durations available on the sixteenth grid, largest first
const EXPRESSIBLE = [4, 3, 2, 1.5, 1, 0.75, 0.5, 0.25];

/** Split a duration into tie-able expressible components, largest first. */
export function decomposeDuration(ql) {
  const parts = [];
  let remaining = Math.round(ql * 4) / 4;
  while (remaining > 0) {
    const part = EXPRESSIBLE.find((d) => d <= remaining + 1e-9);
    if (!part) break; // sub-grid residue: drop it
    parts.push(part);
    remaining = Math.round((remaining - part) * 4) / 4;
  }
  return parts;
}

/**
 * Build per-hand measures.
 * Returns { measures: {R: Measure[], L: Measure[]}, nMeasures }
 * where Measure is a list of items:
 *   { kind: "chord", pitches, velocity, durQl, tieStart, tieStop }
 *   { kind: "rest", durQl, wholeMeasure }
 */
export function buildMeasures(qnotes) {
  // one chord event per (hand, onset): quantize unified durations per onset
  const events = { R: new Map(), L: new Map() };
  for (const q of qnotes) {
    const byOnset = events[q.hand];
    if (!byOnset.has(q.onsetQl)) {
      byOnset.set(q.onsetQl, { onset: q.onsetQl, dur: q.durQl, pitches: [], velocity: 0 });
    }
    const ev = byOnset.get(q.onsetQl);
    ev.pitches.push(q.pitch);
    ev.velocity = Math.max(ev.velocity, q.velocity);
  }

  let totalQl = 0;
  for (const hand of ["R", "L"]) {
    for (const ev of events[hand].values()) totalQl = Math.max(totalQl, ev.onset + ev.dur);
  }
  const nMeasures = Math.max(1, Math.ceil((totalQl - 1e-9) / MEASURE_QL));

  const measures = { R: [], L: [] };
  for (const hand of ["R", "L"]) {
    const sorted = [...events[hand].values()].sort((a, b) => a.onset - b.onset);
    for (const ev of sorted) ev.pitches.sort((a, b) => a - b);

    // slice each event at barlines into (measure, offsetInMeasure, dur, tieStart, tieStop)
    const slices = []; // per measure index -> [{offset, dur, pitches, velocity, tieStart, tieStop}]
    for (let m = 0; m < nMeasures; m++) slices.push([]);
    for (const ev of sorted) {
      let start = ev.onset;
      const end = ev.onset + ev.dur;
      while (start < end - 1e-9) {
        const m = Math.floor(start / MEASURE_QL + 1e-9);
        if (m >= nMeasures) break;
        const barEnd = (m + 1) * MEASURE_QL;
        const sliceEnd = Math.min(end, barEnd);
        slices[m].push({
          offset: start - m * MEASURE_QL,
          dur: sliceEnd - start,
          pitches: ev.pitches,
          velocity: ev.velocity,
          tieStop: start > ev.onset + 1e-9,
          tieStart: sliceEnd < end - 1e-9,
        });
        start = sliceEnd;
      }
    }

    for (let m = 0; m < nMeasures; m++) {
      const items = [];
      let cursor = 0;
      for (const s of slices[m]) {
        if (s.offset > cursor + 1e-9) {
          for (const restDur of decomposeDuration(s.offset - cursor)) {
            items.push({ kind: "rest", durQl: restDur, wholeMeasure: false });
          }
        }
        // decompose the slice itself; components are tied together
        const parts = decomposeDuration(s.dur);
        parts.forEach((durQl, i) => {
          items.push({
            kind: "chord",
            pitches: s.pitches,
            velocity: s.velocity,
            durQl,
            tieStop: s.tieStop || i > 0,
            tieStart: s.tieStart || i < parts.length - 1,
          });
        });
        cursor = s.offset + s.dur;
      }
      if (cursor < MEASURE_QL - 1e-9) {
        if (cursor === 0) {
          items.push({ kind: "rest", durQl: MEASURE_QL, wholeMeasure: true });
        } else {
          for (const restDur of decomposeDuration(MEASURE_QL - cursor)) {
            items.push({ kind: "rest", durQl: restDur, wholeMeasure: false });
          }
        }
      }
      measures[hand].push(items);
    }
  }
  return { measures, nMeasures };
}
