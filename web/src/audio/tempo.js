// BPM estimation: spectral-flux onset envelope + autocorrelation with a
// log-normal prior around 120 BPM (the same prior librosa uses). Not a full
// beat_track port — same clamping semantics as transcribe.estimate_tempo,
// and the user can always edit the BPM afterwards.

import { SAMPLE_RATE } from "./decode.js";

const N_FFT = 2048;
const HOP = 512;
const FPS = SAMPLE_RATE / HOP; // 31.25 envelope frames per second

/** In-place iterative radix-2 FFT on interleaved re/im arrays. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

function onsetEnvelope(audio) {
  const nFrames = Math.max(0, Math.floor((audio.length - N_FFT) / HOP) + 1);
  const nBins = N_FFT / 2 + 1;
  const window = new Float32Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);
  const env = new Float32Array(nFrames);
  let prev = new Float32Array(nBins);
  const re = new Float32Array(N_FFT);
  const im = new Float32Array(N_FFT);
  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP;
    for (let i = 0; i < N_FFT; i++) {
      re[i] = audio[off + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    let flux = 0;
    const cur = new Float32Array(nBins);
    for (let b = 0; b < nBins; b++) {
      const mag = Math.log1p(1000 * Math.hypot(re[b], im[b]));
      cur[b] = mag;
      const diff = mag - prev[b];
      if (diff > 0) flux += diff; // half-wave rectified
    }
    env[f] = f === 0 ? 0 : flux;
    prev = cur;
  }
  return env;
}

export function estimateTempo(audio) {
  const env = onsetEnvelope(audio);
  if (env.length < FPS * 2) return 120.0; // too short to say anything
  // remove DC so the autocorrelation peaks reflect periodicity, not loudness
  let mean = 0;
  for (const v of env) mean += v;
  mean /= env.length;
  const minLag = Math.max(1, Math.round((60 / 220) * FPS));
  const maxLag = Math.min(env.length - 1, Math.round((60 / 40) * FPS));
  let bestBpm = 120.0;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let acf = 0;
    for (let i = lag; i < env.length; i++) acf += (env[i] - mean) * (env[i - lag] - mean);
    acf /= env.length - lag;
    const bpm = (60 * FPS) / lag;
    // librosa's log-normal tempo prior: exp(-0.5 * (log2(bpm/120) / 1)^2)
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120), 2));
    const score = acf * prior;
    if (score > bestScore) {
      bestScore = score;
      bestBpm = bpm;
    }
  }
  if (bestBpm < 40 || bestBpm > 220) return 120.0;
  return Math.round(bestBpm * 10) / 10;
}
