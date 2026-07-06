// Linear-interpolation resampler. Used to upsample 16 kHz audio to the
// 22 050 Hz Basic Pitch expects; upsampling loses nothing audible here.

export function resampleLinear(audio, fromRate, toRate) {
  if (fromRate === toRate) return audio;
  const outLength = Math.round((audio.length * toRate) / fromRate);
  const out = new Float32Array(outLength);
  const step = fromRate / toRate;
  for (let i = 0; i < outLength; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, audio.length - 1);
    const frac = pos - i0;
    out[i] = audio[i0] * (1 - frac) + audio[i1] * frac;
  }
  return out;
}
