// Port of score.quantize: snap note events to a sixteenth-note grid, drop
// leading silence, dedupe, unify chord durations, clip overlaps.
// Note events are {onset, offset, pitch, velocity} (seconds / MIDI numbers);
// quantized notes are {id, hand, onsetQl, durQl, pitch, velocity}.

export const HAND_SPLIT_PITCH = 60; // middle C: below -> left hand (bass clef)
export const GRID = 0.25; // sixteenth notes, in quarterLength units
export const MIN_QL = 0.25;
export const MAX_QL = 8.0;

/** Python round(): banker's rounding (round-half-to-even). */
export function roundHalfEven(x) {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

function snap(value, grid = GRID) {
  return roundHalfEven(value / grid) * grid;
}

export function quantize(notes, bpm) {
  const secToQl = bpm / 60.0;
  const qnotes = notes.map((n) => {
    const snappedDur = snap((n.offset - n.onset) * secToQl) || MIN_QL;
    return {
      id: 0,
      hand: n.pitch >= HAND_SPLIT_PITCH ? "R" : "L",
      onsetQl: snap(n.onset * secToQl),
      durQl: Math.max(MIN_QL, Math.min(snappedDur, MAX_QL)),
      pitch: n.pitch,
      velocity: n.velocity,
    };
  });
  if (!qnotes.length) return [];

  // start the score on beat 1 (removes leading silence)
  const shift = Math.min(...qnotes.map((q) => q.onsetQl));
  for (const q of qnotes) q.onsetQl -= shift;

  // drop duplicate pitches landing on the same beat
  qnotes.sort((a, b) => a.onsetQl - b.onsetQl || a.pitch - b.pitch);
  const seen = new Set();
  const unique = qnotes.filter((q) => {
    const k = `${q.hand}|${q.onsetQl}|${q.pitch}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // per hand: unify chord durations, then clip anything overlapping the next onset
  for (const hand of ["R", "L"]) {
    const handNotes = unique.filter((q) => q.hand === hand);
    const onsets = [...new Set(handNotes.map((q) => q.onsetQl))].sort((a, b) => a - b);
    const nextOnset = new Map();
    for (let i = 0; i + 1 < onsets.length; i++) nextOnset.set(onsets[i], onsets[i + 1]);
    const byOnset = new Map();
    for (const q of handNotes) {
      if (!byOnset.has(q.onsetQl)) byOnset.set(q.onsetQl, []);
      byOnset.get(q.onsetQl).push(q);
    }
    for (const [onset, group] of byOnset) {
      let dur = Math.max(...group.map((q) => q.durQl));
      if (nextOnset.has(onset)) {
        dur = Math.max(MIN_QL, Math.min(dur, nextOnset.get(onset) - onset));
      }
      for (const q of group) q.durQl = dur;
    }
  }

  unique.forEach((q, i) => (q.id = i));
  return unique;
}
