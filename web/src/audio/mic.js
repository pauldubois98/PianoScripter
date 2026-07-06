// Microphone capture into a growing 16 kHz mono Float32Array buffer.
// Replaces the server-era MediaRecorder->webm->decode loop: the same buffer
// feeds both the live passes and the final full-quality transcription.

import { SAMPLE_RATE } from "./decode.js";
import { resampleLinear } from "./resample.js";
import workletUrl from "./capture-worklet.js?url";

const MIC_CONSTRAINTS = {
  audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
};

export class MicCapture {
  constructor() {
    this.stream = null;
    this.context = null;
    this.chunks = [];
    this.length = 0; // total samples at 16 kHz
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    // Ask for 16 kHz directly; browsers that refuse fall back to resampling below.
    try {
      this.context = new AudioContext({ sampleRate: SAMPLE_RATE });
    } catch {
      this.context = new AudioContext();
    }
    await this.context.audioWorklet.addModule(workletUrl);
    const source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, "capture-processor");
    this.node.port.onmessage = (e) => {
      let frame = e.data;
      if (this.context.sampleRate !== SAMPLE_RATE) {
        frame = resampleLinear(frame, this.context.sampleRate, SAMPLE_RATE);
      }
      this.chunks.push(frame);
      this.length += frame.length;
    };
    source.connect(this.node);
    // no connection to destination: we only capture, never play back
  }

  /** All audio captured so far, as one 16 kHz Float32Array. */
  snapshot() {
    const out = new Float32Array(this.length);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    this.chunks = [out];
    return out;
  }

  async stop() {
    const audio = this.snapshot();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.context?.close();
    return audio;
  }
}
