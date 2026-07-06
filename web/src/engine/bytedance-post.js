// Pure postprocessing half of the ByteDance port (no onnxruntime dependency).
// Ports piano_transcription_inference's RegressionPostProcessor + piano_vad
// (Apache-2.0, Copyright Qiuqiang Kong).

export const FRAMES_PER_SECOND = 100;
export const CLASSES_NUM = 88;
const BEGIN_NOTE = 21;
const VELOCITY_SCALE = 128;
const ONSET_THRESHOLD = 0.3;
const OFFSET_THRESHOLD = 0.3;
const FRAME_THRESHOLD = 0.1;
const PEDAL_OFFSET_THRESHOLD = 0.2;

function isMonotonicNeighbour(x, n, neighbour) {
  for (let i = 0; i < neighbour; i++) {
    if (x[n - i] < x[n - i - 1]) return false;
    if (x[n + i] < x[n + i + 1]) return false;
  }
  return true;
}

/** Binarize a regression head by local-max + monotonic test; sub-frame shifts. */
export function binarize(reg, nFrames, cols, threshold, neighbour) {
  const binary = new Uint8Array(nFrames * cols);
  const shift = new Float32Array(nFrames * cols);
  const x = new Float32Array(nFrames);
  for (let k = 0; k < cols; k++) {
    for (let f = 0; f < nFrames; f++) x[f] = reg[f * cols + k];
    for (let n = neighbour; n < nFrames - neighbour; n++) {
      if (x[n] > threshold && isMonotonicNeighbour(x, n, neighbour)) {
        binary[n * cols + k] = 1;
        shift[n * cols + k] =
          x[n - 1] > x[n + 1]
            ? (x[n + 1] - x[n - 1]) / (x[n] - x[n + 1]) / 2
            : (x[n + 1] - x[n - 1]) / (x[n] - x[n - 1]) / 2;
      }
    }
  }
  return { binary, shift };
}

/**
 * Port of piano_vad.note_detection_with_onset_offset_regress for one pitch
 * column. Deliberately preserves the upstream `if bgn:` falsiness quirk
 * (an onset exactly on frame 0 is ignored) for parity with the Python side.
 */
function detectNotes(col, nFrames, arrays) {
  const { frame, onsetBin, onsetShift, offsetBin, offsetShift, velocity } = arrays;
  const at = (arr, i) => arr[i * CLASSES_NUM + col];
  const tuples = [];
  let bgn = null;
  let frameDisappear = null;
  let offsetOccur = null;
  for (let i = 0; i < nFrames; i++) {
    if (at(onsetBin, i) === 1) {
      if (bgn) {
        const fin = Math.max(i - 1, 0);
        tuples.push([bgn, fin, at(onsetShift, bgn), 0, at(velocity, bgn)]);
        frameDisappear = null;
        offsetOccur = null;
      }
      bgn = i;
    }
    if (bgn && i > bgn) {
      if (at(frame, i) <= FRAME_THRESHOLD && !frameDisappear) frameDisappear = i;
      if (at(offsetBin, i) === 1 && !offsetOccur) offsetOccur = i;
      if (frameDisappear) {
        const fin =
          offsetOccur && offsetOccur - bgn > frameDisappear - offsetOccur
            ? offsetOccur
            : frameDisappear;
        tuples.push([bgn, fin, at(onsetShift, bgn), at(offsetShift, fin), at(velocity, bgn)]);
        bgn = frameDisappear = offsetOccur = null;
      }
      if (bgn && (i - bgn >= 600 || i === nFrames - 1)) {
        tuples.push([bgn, i, at(onsetShift, bgn), at(offsetShift, i), at(velocity, bgn)]);
        bgn = frameDisappear = offsetOccur = null;
      }
    }
  }
  tuples.sort((a, b) => a[0] - b[0]);
  return tuples;
}

/** Port of piano_vad.pedal_detection_with_onset_offset_regress. */
function detectPedals(frame, offsetBin, offsetShift, nFrames) {
  const tuples = [];
  let bgn = null;
  let frameDisappear = null;
  let offsetOccur = null;
  for (let i = 1; i < nFrames; i++) {
    if (frame[i] >= 0.5 && frame[i] > frame[i - 1] && !bgn) bgn = i;
    if (bgn && i > bgn) {
      if (frame[i] <= 0.5 && !frameDisappear) frameDisappear = i;
      if (offsetBin[i] === 1 && !offsetOccur) offsetOccur = i;
      if (offsetOccur) {
        tuples.push([bgn, offsetOccur, 0, offsetShift[offsetOccur]]);
        bgn = frameDisappear = offsetOccur = null;
      }
      if (frameDisappear && i - frameDisappear >= 10) {
        tuples.push([bgn, frameDisappear, 0, offsetShift[frameDisappear]]);
        bgn = frameDisappear = offsetOccur = null;
      }
    }
  }
  tuples.sort((a, b) => a[0] - b[0]);
  return tuples;
}

/**
 * Model output matrices -> { notes, pedals }.
 * outputs: { reg_onset, reg_offset, frame, velocity,
 *            reg_pedal_onset, reg_pedal_offset, pedal_frame } row-major.
 */
export function postprocess(outputs, nFrames) {
  const onset = binarize(outputs.reg_onset, nFrames, CLASSES_NUM, ONSET_THRESHOLD, 2);
  const offset = binarize(outputs.reg_offset, nFrames, CLASSES_NUM, OFFSET_THRESHOLD, 4);

  const notes = [];
  for (let pitch = 0; pitch < CLASSES_NUM; pitch++) {
    const tuples = detectNotes(pitch, nFrames, {
      frame: outputs.frame,
      onsetBin: onset.binary,
      onsetShift: onset.shift,
      offsetBin: offset.binary,
      offsetShift: offset.shift,
      velocity: outputs.velocity,
    });
    for (const [bgn, fin, onShift, offShift, vel] of tuples) {
      notes.push({
        onset: (bgn + onShift) / FRAMES_PER_SECOND,
        offset: (fin + offShift) / FRAMES_PER_SECOND,
        pitch: pitch + BEGIN_NOTE,
        velocity: Math.trunc(vel * VELOCITY_SCALE),
      });
    }
  }
  notes.sort((a, b) => a.onset - b.onset || a.pitch - b.pitch);

  const pedalOffset = binarize(outputs.reg_pedal_offset, nFrames, 1, PEDAL_OFFSET_THRESHOLD, 4);
  const pedals = detectPedals(
    outputs.pedal_frame, pedalOffset.binary, pedalOffset.shift, nFrames
  ).map(([bgn, fin, onShift, offShift]) => ({
    onset_time: (bgn + onShift) / FRAMES_PER_SECOND,
    offset_time: (fin + offShift) / FRAMES_PER_SECOND,
  }));

  return { notes, pedals };
}
