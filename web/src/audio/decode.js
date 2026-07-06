// Decode any audio file/blob to 16 kHz mono Float32Array, all in the browser.
// Mirrors transcribe.load_audio (ffmpeg -ac 1 -ar 16000) using WebAudio.

export const SAMPLE_RATE = 16000;

export async function decodeToMono16k(arrayBuffer) {
  const probe = new AudioContext();
  let decoded;
  try {
    decoded = await probe.decodeAudioData(arrayBuffer);
  } finally {
    probe.close();
  }
  const frames = Math.ceil(decoded.duration * SAMPLE_RATE);
  const offline = new OfflineAudioContext(1, frames, SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded; // mono downmix + resampling happen in the render
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}
