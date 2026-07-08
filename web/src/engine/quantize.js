// Port of score.quantize: snap note events to a sixteenth-note grid, drop
// leading silence, dedupe, unify chord durations, clip overlaps.
// Note events are {onset, offset, pitch, velocity} (seconds / MIDI numbers);
// quantized notes are {id, hand, onsetQl, durQl, pitch, velocity}.

import { MEASURE_QL } from "./score.js";

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

// Shared by quantize() and quantizeAdaptive(): dedupe, unify chord durations
// per (hand, onset), clip against the next onset, drop leading silence.
function finalizeQuantized(qnotes) {
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
  return finalizeQuantized(qnotes);
}

// ---------------------------------------------------------------------------
// Adaptive quantizer: biases toward the rhythms a human would actually write
// down (quarter/half/whole/eighth, beat and half-beat onsets) instead of
// treating every sixteenth-note grid point as equally likely. Used by the
// live app; quantize() above is left untouched as a regression/parity check.

const SCALE_MIN = 0.985;
const SCALE_MAX = 1.015;
const SCALE_STEP = 0.001;
const CALIBRATION_GRID = 0.5; // eighth notes: what the tempo fit aligns to
const CALIBRATION_ERROR_CAP = 0.25; // caps the influence of stray/syncopated notes
const PHASE_STEP = 0.01; // QL: fine enough to matter, coarse enough to stay cheap

function gridError(value, grid) {
  const frac = value / grid - Math.floor(value / grid);
  const dist = Math.min(frac, 1 - frac) * grid;
  return Math.min(dist, CALIBRATION_ERROR_CAP);
}

/**
 * Finds a small tempo correction (±1.5% scale) and a phase offset (a
 * fraction of an eighth note) that jointly best align note onsets to the
 * eighth-note grid. A phase term matters alongside scale: forcing the very
 * first onset to be exactly on-grid (the previous approach) assumes that
 * note's own detected timing has no error -- it's just as noisy as any
 * other note's. If it happens to carry, say, 0.3 QL of drift, every later
 * note inherits that same offset relative to it, even when the whole piece
 * is otherwise a clean grid. That residual is exactly what later decides
 * which snapAdaptive tolerance tier a note falls into, so a few
 * milliseconds of jitter can tip one note into "on the beat" while an
 * equally-drifted neighbor tips the other way. Fitting phase directly
 * against the same absolute grid snapAdaptive snaps against removes that
 * shared drift up front instead of leaving each note's fate to chance.
 */
export function calibrateGrid(notes, bpm) {
  if (notes.length < 2) return { scale: 1, phase: 0 };
  let best = { scale: 1, phase: 0 };
  let bestCost = Infinity;
  for (let scale = SCALE_MIN; scale <= SCALE_MAX + 1e-9; scale += SCALE_STEP) {
    const secToQl = (bpm * scale) / 60;
    for (let phase = 0; phase < CALIBRATION_GRID - 1e-9; phase += PHASE_STEP) {
      let cost = 0;
      for (const n of notes) cost += gridError(n.onset * secToQl - phase, CALIBRATION_GRID);
      if (cost < bestCost) {
        bestCost = cost;
        best = { scale, phase };
      }
    }
  }
  return best;
}

const TIER1_GRID = 1; // quarter note / beat
const TIER2_GRID = 0.5; // eighth note

// How hard the "realistic" mode pushes notes onto beat/eighth-note
// positions, on a 0..1 scale. 0 stays close to the sixteenth-note grid
// (closest to the raw acoustic timing); 1 snaps aggressively to
// beats/eighths even when that costs more timing accuracy. The tolerances
// below are chosen so DEFAULT_AGGRESSIVENESS reproduces the previous fixed
// behavior (TIER1_TOL 0.2, TIER2_TOL 0.12).
export const DEFAULT_AGGRESSIVENESS = 0.5;
const TIER1_TOL_RANGE = [0.1, 0.3]; // at aggressiveness 0 / 1
const TIER2_TOL_RANGE = [0.04, 0.2];
const MERGE_THRESHOLD_MAX = 0.5; // QL: largest barline sliver eligible for merging, at aggressiveness 1

function lerp([lo, hi], t) {
  return lo + (hi - lo) * t;
}

/** aggressiveness (0..1) -> the tier tolerances and merge threshold it implies. */
export function aggressivenessParams(aggressiveness) {
  const clamped = Math.max(0, Math.min(1, aggressiveness));
  return {
    tier1Tol: lerp(TIER1_TOL_RANGE, clamped),
    tier2Tol: lerp(TIER2_TOL_RANGE, clamped),
    mergeThreshold: clamped * MERGE_THRESHOLD_MAX,
  };
}

/** Snaps to the coarsest grid (beat, then eighth, then sixteenth) that plausibly fits. */
export function snapAdaptive(value, tier1Tol, tier2Tol) {
  let snapped = roundHalfEven(value / TIER1_GRID) * TIER1_GRID;
  if (Math.abs(value - snapped) <= tier1Tol) return snapped;
  snapped = roundHalfEven(value / TIER2_GRID) * TIER2_GRID;
  if (Math.abs(value - snapped) <= tier2Tol) return snapped;
  return snap(value, GRID);
}

// Dotted-eighth family (0.75, 1.75, 2.75, ... QL): as legitimate a duration
// as a plain eighth, but it sits exactly halfway between two TIER1_GRID
// points (e.g. 0.75 is equidistant from 0 and 1), so it's invisible to
// snapAdaptive's plain quarter/eighth grids and reads as noise near the
// nearest quarter note once the tier-1 tolerance grows past 0.25 QL.
const DOTTED_EIGHTH_OFFSET = 0.75;

function nearestDottedEighth(value) {
  return Math.round(value - DOTTED_EIGHTH_OFFSET) + DOTTED_EIGHTH_OFFSET;
}

/**
 * Like snapAdaptive, but for note DURATIONS: also treats the dotted-eighth
 * family as a tier-2-level "nice" value alongside plain eighths, so a real
 * dotted-eighth duration doesn't get rounded away into the nearest plain
 * quarter/half at high aggressiveness (see DOTTED_EIGHTH_OFFSET above).
 * Onset snapping doesn't need this: an onset a sixteenth off the beat is
 * genuinely timing noise to push onto the grid, not a value with its own
 * notated meaning the way a note's length has.
 */
export function snapDurationAdaptive(value, tier1Tol, tier2Tol) {
  const tier1 = roundHalfEven(value / TIER1_GRID) * TIER1_GRID;
  const tier1Dist = Math.abs(value - tier1);
  const dottedEighth = nearestDottedEighth(value);
  const dottedDist = Math.abs(value - dottedEighth);
  // Only accept the plain tier-1 grid when it's unambiguously the closer
  // match -- otherwise a genuine dotted-eighth reading is being discarded.
  if (tier1Dist <= tier1Tol && tier1Dist <= dottedDist) return tier1;
  const tier2 = roundHalfEven(value / TIER2_GRID) * TIER2_GRID;
  const tier2Dist = Math.abs(value - tier2);
  if (dottedDist <= tier2Dist && dottedDist <= tier2Tol) return dottedEighth;
  if (tier2Dist <= tier2Tol) return tier2;
  return snap(value, GRID);
}

/**
 * A note tied across a barline sometimes leaves a musically-insignificant
 * sliver on one side (an artifact of quantization, not something a person
 * would actually write down). When that sliver is at or below `threshold`
 * (in quarter-lengths), trim it away so the note sits cleanly on one side
 * of the barline instead of being split by a tie. Mutates qnotes in place.
 */
export function mergeBarlineSlivers(qnotes, threshold) {
  if (threshold <= 0) return qnotes;
  for (const q of qnotes) {
    const onset = q.onsetQl;
    const end = onset + q.durQl;
    const firstBar = Math.ceil((onset + 1e-9) / MEASURE_QL) * MEASURE_QL;
    if (firstBar >= end - 1e-9) continue; // doesn't cross a barline
    const lastBar = Math.floor((end - 1e-9) / MEASURE_QL) * MEASURE_QL;
    const preSliver = firstBar - onset;
    const postSliver = end - lastBar;
    let newOnset = onset;
    let newEnd = end;
    if (preSliver > 1e-9 && preSliver <= threshold) newOnset = firstBar;
    if (lastBar >= firstBar - 1e-9 && postSliver > 1e-9 && postSliver <= threshold) newEnd = lastBar;
    if (newEnd - newOnset >= MIN_QL) {
      q.onsetQl = newOnset;
      q.durQl = newEnd - newOnset;
    }
  }
  return qnotes;
}

const CHORD_ONSET_TOL = 0.03; // seconds: onsets this close are one attack, not two

/**
 * snapAdaptive snaps each note's onset independently. That's fine for notes
 * played apart, but two notes of the same chord are never detected at the
 * exact same instant -- a few milliseconds of jitter is normal. At low
 * aggressiveness both usually land on the same coarse grid point anyway, but
 * as the tier-1 tolerance widens toward its max, one note can end up just
 * inside it while its chord-mate (a few ms away, and so a few thousandths of
 * a quarter-length away) falls just outside -- snapping the "same" chord to
 * two different beats. Clustering near-simultaneous raw onsets onto one
 * shared value before snapping means they can never straddle that boundary
 * differently. 30ms comfortably covers natural chord asynchrony while
 * staying well under the gap between genuinely separate fast notes.
 */
function clusterOnsets(notes) {
  const order = notes.map((_, i) => i).sort((a, b) => notes[a].onset - notes[b].onset);
  const clustered = new Array(notes.length);
  let i = 0;
  while (i < order.length) {
    let j = i + 1;
    while (j < order.length && notes[order[j]].onset - notes[order[j - 1]].onset <= CHORD_ONSET_TOL) j++;
    const idxs = order.slice(i, j);
    const mean = idxs.reduce((sum, k) => sum + notes[k].onset, 0) / idxs.length;
    for (const k of idxs) clustered[k] = mean;
    i = j;
  }
  return clustered;
}

const LEGATO_GAP_TOL = 0.06; // seconds: small enough to assume the note was held through

/**
 * For each note, prefer the gap to the next onset in the same hand as its
 * duration (assume it was held until then) when the acoustic offset is
 * already close to that next onset -- offset detection is noisier than
 * onset detection, and this avoids that noise fragmenting otherwise-clean
 * legato passages into odd tied durations. Falls back to the raw acoustic
 * duration when there's a real gap (staccato/rest).
 */
function legatoDurations(notes) {
  const byHand = { R: [], L: [] };
  notes.forEach((n, i) => {
    const hand = n.pitch >= HAND_SPLIT_PITCH ? "R" : "L";
    byHand[hand].push({ i, onset: n.onset });
  });
  const nextOnsetSec = new Array(notes.length).fill(null);
  for (const hand of ["R", "L"]) {
    const sorted = [...byHand[hand]].sort((a, b) => a.onset - b.onset);
    for (let k = 0; k + 1 < sorted.length; k++) {
      let j = k + 1;
      while (j < sorted.length && sorted[j].onset <= sorted[k].onset + 1e-9) j++;
      if (j < sorted.length) nextOnsetSec[sorted[k].i] = sorted[j].onset;
    }
  }
  return notes.map((n, i) => {
    const next = nextOnsetSec[i];
    if (next != null) {
      const gap = next - n.offset;
      if (Math.abs(gap) <= LEGATO_GAP_TOL) return next - n.onset;
    }
    return n.offset - n.onset;
  });
}

export function quantizeAdaptive(notes, bpm, aggressiveness = DEFAULT_AGGRESSIVENESS) {
  if (!notes.length) return [];
  const { tier1Tol, tier2Tol, mergeThreshold } = aggressivenessParams(aggressiveness);
  const { scale, phase } = calibrateGrid(notes, bpm);
  const secToQl = (bpm * scale) / 60;
  const durSec = legatoDurations(notes);
  const onsetSec = clusterOnsets(notes);
  const qnotes = notes.map((n, i) => {
    const snappedDur = snapDurationAdaptive(durSec[i] * secToQl, tier1Tol, tier2Tol) || MIN_QL;
    return {
      id: 0,
      hand: n.pitch >= HAND_SPLIT_PITCH ? "R" : "L",
      onsetQl: snapAdaptive(onsetSec[i] * secToQl - phase, tier1Tol, tier2Tol),
      durQl: Math.max(MIN_QL, Math.min(snappedDur, MAX_QL)),
      pitch: n.pitch,
      velocity: n.velocity,
    };
  });
  const finalized = finalizeQuantized(qnotes);
  return mergeBarlineSlivers(finalized, mergeThreshold);
}
