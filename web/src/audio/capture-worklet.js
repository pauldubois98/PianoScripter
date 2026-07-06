// AudioWorklet processor: forwards mono input frames to the main thread.
// Registered from mic.js via audioWorklet.addModule().

class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel && channel.length) {
      // copy: the input buffer is reused by the audio engine
      this.port.postMessage(new Float32Array(channel));
    }
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
