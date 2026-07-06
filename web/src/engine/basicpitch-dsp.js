// Pure DSP half of the Basic Pitch port (no onnxruntime dependency, so it is
// unit-testable in Node). Ported from ultra.py, itself ported from
// https://github.com/spotify/basic-pitch (Apache-2.0).

export const BP_SAMPLE_RATE = 22050;
export const FFT_HOP = 256;
const AUDIO_WINDOW_LENGTH = 2; // seconds
const ANNOTATIONS_FPS = Math.floor(BP_SAMPLE_RATE / FFT_HOP); // 86
export const ANNOT_N_FRAMES = ANNOTATIONS_FPS * AUDIO_WINDOW_LENGTH; // 172
export const AUDIO_N_SAMPLES = BP_SAMPLE_RATE * AUDIO_WINDOW_LENGTH - FFT_HOP; // 43844
const N_OVERLAPPING_FRAMES = 30;
export const OVERLAP_LEN = N_OVERLAPPING_FRAMES * FFT_HOP;
export const HOP_SIZE = AUDIO_N_SAMPLES - OVERLAP_LEN;
const MAGIC_ALIGNMENT_OFFSET = 0.0018;

const MIDI_OFFSET = 21;
const MAX_FREQ_IDX = 87;
export const N_FREQS = 88;
const ONSET_THRESHOLD = 0.5;
const FRAME_THRESHOLD = 0.3;
const MIN_NOTE_LEN_FRAMES = 11;
const ENERGY_TOL = 11;

// Matrices are row-major Float32Array of shape (rows, N_FREQS).

/** Stitch per-window (172, 88) frames into one (nTimes, 88) matrix. */
export function unwrap(perWindow, originalLength) {
  const nOlap = N_OVERLAPPING_FRAMES / 2;
  const framesPerWindow = ANNOT_N_FRAMES - N_OVERLAPPING_FRAMES;
  const nExpected = Math.floor((originalLength / HOP_SIZE) * framesPerWindow);
  const out = new Float32Array(nExpected * N_FREQS);
  let row = 0;
  outer: for (const win of perWindow) {
    for (let f = nOlap; f < ANNOT_N_FRAMES - nOlap; f++, row++) {
      if (row >= nExpected) break outer;
      out.set(win.subarray(f * N_FREQS, (f + 1) * N_FREQS), row * N_FREQS);
    }
  }
  return { data: out, rows: nExpected };
}

/** Frame index -> seconds, compensating per-window drift. */
export function framesToTime(nFrames) {
  const windowOffset =
    (FFT_HOP / BP_SAMPLE_RATE) * (ANNOT_N_FRAMES - AUDIO_N_SAMPLES / FFT_HOP) +
    MAGIC_ALIGNMENT_OFFSET;
  const times = new Float64Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    times[i] = (i * FFT_HOP) / BP_SAMPLE_RATE - windowOffset * Math.floor(i / ANNOT_N_FRAMES);
  }
  return times;
}

/** Add onsets where frame amplitudes jump (bp get_infered_onsets). */
export function inferOnsets(onsets, frames, rows, nDiff = 2) {
  const n = rows * N_FREQS;
  const frameDiff = new Float32Array(n);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < N_FREQS; c++) {
      const i = r * N_FREQS + c;
      let minDiff = Infinity;
      for (let d = 1; d <= nDiff; d++) {
        const prev = r - d >= 0 ? frames[(r - d) * N_FREQS + c] : 0;
        minDiff = Math.min(minDiff, frames[i] - prev);
      }
      frameDiff[i] = r < nDiff ? 0 : Math.max(0, minDiff);
    }
  }
  let frameMax = 0;
  let onsetMax = 0;
  for (let i = 0; i < n; i++) {
    if (frameDiff[i] > frameMax) frameMax = frameDiff[i];
    if (onsets[i] > onsetMax) onsetMax = onsets[i];
  }
  const out = new Float32Array(n);
  const scale = frameMax > 0 ? onsetMax / frameMax : 0;
  for (let i = 0; i < n; i++) out[i] = Math.max(onsets[i], frameDiff[i] * scale);
  return out;
}

/**
 * Activations -> [startFrame, endFrame, midiPitch, amplitude] events.
 * Port of bp output_to_notes_polyphonic (without the pitch-bend path).
 */
export function outputToNotes(frames, onsetsIn, rows, melodiaTrick) {
  const nFrames = rows;
  const onsets = inferOnsets(onsetsIn, frames, rows);

  // local maxima along time (scipy argrelmax semantics: strictly greater
  // than both neighbours, borders excluded), collected in row-major order
  const onsetIdx = [];
  for (let r = 1; r < nFrames - 1; r++) {
    for (let c = 0; c < N_FREQS; c++) {
      const v = onsets[r * N_FREQS + c];
      if (
        v >= ONSET_THRESHOLD &&
        v > onsets[(r - 1) * N_FREQS + c] &&
        v > onsets[(r + 1) * N_FREQS + c]
      ) {
        onsetIdx.push([r, c]);
      }
    }
  }
  onsetIdx.reverse(); // go backwards in time

  const remaining = frames.slice();
  const events = [];
  for (const [noteStartIdx, freqIdx] of onsetIdx) {
    if (noteStartIdx >= nFrames - 1) continue;
    // walk forward until the energy stays below threshold for ENERGY_TOL frames
    let i = noteStartIdx + 1;
    let k = 0;
    while (i < nFrames - 1 && k < ENERGY_TOL) {
      k = remaining[i * N_FREQS + freqIdx] < FRAME_THRESHOLD ? k + 1 : 0;
      i++;
    }
    i -= k;
    if (i - noteStartIdx <= MIN_NOTE_LEN_FRAMES) continue;
    for (let r = noteStartIdx; r < i; r++) {
      remaining[r * N_FREQS + freqIdx] = 0;
      if (freqIdx < MAX_FREQ_IDX) remaining[r * N_FREQS + freqIdx + 1] = 0;
      if (freqIdx > 0) remaining[r * N_FREQS + freqIdx - 1] = 0;
    }
    let sum = 0;
    for (let r = noteStartIdx; r < i; r++) sum += frames[r * N_FREQS + freqIdx];
    events.push([noteStartIdx, i, freqIdx + MIDI_OFFSET, sum / (i - noteStartIdx)]);
  }

  if (melodiaTrick) {
    // pick up sustained notes whose onset the onset head missed
    for (;;) {
      let maxVal = -Infinity;
      let maxIdx = 0;
      for (let i = 0; i < remaining.length; i++) {
        if (remaining[i] > maxVal) {
          maxVal = remaining[i];
          maxIdx = i;
        }
      }
      if (maxVal <= FRAME_THRESHOLD) break;
      const iMid = Math.floor(maxIdx / N_FREQS);
      const freqIdx = maxIdx % N_FREQS;
      remaining[iMid * N_FREQS + freqIdx] = 0;

      let i = iMid + 1;
      let k = 0;
      while (i < nFrames - 1 && k < ENERGY_TOL) {
        k = remaining[i * N_FREQS + freqIdx] < FRAME_THRESHOLD ? k + 1 : 0;
        remaining[i * N_FREQS + freqIdx] = 0;
        if (freqIdx < MAX_FREQ_IDX) remaining[i * N_FREQS + freqIdx + 1] = 0;
        if (freqIdx > 0) remaining[i * N_FREQS + freqIdx - 1] = 0;
        i++;
      }
      const iEnd = i - 1 - k;

      i = iMid - 1;
      k = 0;
      while (i > 0 && k < ENERGY_TOL) {
        k = remaining[i * N_FREQS + freqIdx] < FRAME_THRESHOLD ? k + 1 : 0;
        remaining[i * N_FREQS + freqIdx] = 0;
        if (freqIdx < MAX_FREQ_IDX) remaining[i * N_FREQS + freqIdx + 1] = 0;
        if (freqIdx > 0) remaining[i * N_FREQS + freqIdx - 1] = 0;
        i--;
      }
      const iStart = i + 1 + k;

      if (iEnd - iStart <= MIN_NOTE_LEN_FRAMES) continue;
      let sum = 0;
      for (let r = iStart; r < iEnd; r++) sum += frames[r * N_FREQS + freqIdx];
      events.push([iStart, iEnd, freqIdx + MIDI_OFFSET, sum / (iEnd - iStart)]);
    }
  }
  return events;
}

/** Frame events -> note events {onset, offset, pitch, velocity}, sorted. */
export function eventsToNotes(events, nFrames) {
  const times = framesToTime(nFrames);
  const notes = events.map(([start, end, pitch, amplitude]) => ({
    onset: times[start],
    offset: times[Math.min(end, times.length - 1)],
    pitch,
    velocity: Math.min(127, Math.max(1, Math.round(amplitude * 127))),
  }));
  notes.sort((a, b) => a.onset - b.onset || a.pitch - b.pitch);
  return notes;
}
