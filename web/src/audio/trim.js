// Port of librosa.effects.trim(top_db=35): drop leading/trailing silence,
// measured as frame RMS relative to the loudest frame.

const FRAME_LENGTH = 2048;
const HOP_LENGTH = 512;
const TOP_DB = 35;

function frameRms(audio) {
  // librosa pads by frame_length/2 on both sides (center=True)
  const half = FRAME_LENGTH >> 1;
  const nFrames = 1 + Math.floor(audio.length / HOP_LENGTH);
  const rms = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    const center = f * HOP_LENGTH;
    const start = Math.max(0, center - half);
    const end = Math.min(audio.length, center + half);
    let sum = 0;
    for (let i = start; i < end; i++) sum += audio[i] * audio[i];
    rms[f] = Math.sqrt(sum / FRAME_LENGTH);
  }
  return rms;
}

// [start, end) sample range to keep, matching librosa.effects.trim's edge
// cases: empty input keeps nothing, all-silent input keeps everything (no
// frame ever crosses the threshold, so there's nothing to trim relative to),
// and audio with only sub-threshold content keeps nothing.
function silenceBounds(audio) {
  if (!audio.length) return [0, 0];
  const rms = frameRms(audio);
  let max = 0;
  for (const v of rms) if (v > max) max = v;
  if (max === 0) return [0, audio.length];
  const threshold = max * Math.pow(10, -TOP_DB / 20);
  let first = -1;
  let last = -1;
  for (let f = 0; f < rms.length; f++) {
    if (rms[f] > threshold) {
      if (first < 0) first = f;
      last = f;
    }
  }
  if (first < 0) return [0, 0];
  const start = first * HOP_LENGTH;
  const end = Math.min(audio.length, (last + 1) * HOP_LENGTH);
  return [start, end];
}

export function trimSilence(audio) {
  const [start, end] = silenceBounds(audio);
  return audio.slice(start, end);
}

/** Sample offset trimSilence would cut from the front -- for callers that
 * need to re-anchor timestamps already computed against the untrimmed
 * buffer (e.g. a live session's incrementally-detected note onsets). */
export function trimSilenceOffset(audio) {
  return silenceBounds(audio)[0];
}
