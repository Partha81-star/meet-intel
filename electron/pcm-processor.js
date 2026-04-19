/**
 * electron/pcm-processor.js
 * MeetIntel — AudioWorkletProcessor: Float32 → Int16 PCM converter
 *
 * Loaded via AudioContext.audioWorklet.addModule() in audioStreamer.js.
 *
 * Why an AudioWorklet?
 *   The Web Audio API delivers audio as Float32 (-1.0 to 1.0).
 *   Deepgram expects linear16 (signed 16-bit PCM integers).
 *   The worklet runs on a dedicated audio thread for zero-latency conversion.
 *
 * Message protocol:
 *   → port.onmessage receives { data: Int16Array } buffers
 *   The AudioStreamer's worklet.port.onmessage forwards them over WebSocket.
 */

class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // Target chunk size in samples (chunkMs @ sampleRate)
    const { chunkMs = 100, sampleRate = 16000 } = options.processorOptions || {};
    this._chunkSize   = Math.floor((chunkMs / 1000) * sampleRate);
    this._buffer      = new Float32Array(this._chunkSize * 2); // double-buffer
    this._bufferIndex = 0;
  }

  /**
   * Called by the audio engine for each render quantum (~128 samples / 2.7 ms at 48 kHz).
   * We accumulate samples until we have a full chunkMs worth, then post as Int16.
   */
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    // Mix down to mono: average all input channels
    const numChannels = input.length;
    const numSamples  = input[0].length;

    for (let i = 0; i < numSamples; i++) {
      let sample = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        sample += input[ch][i];
      }
      sample /= numChannels;

      this._buffer[this._bufferIndex++] = sample;

      if (this._bufferIndex >= this._chunkSize) {
        this._flush();
      }
    }

    return true; // Keep processor alive
  }

  _flush() {
    if (this._bufferIndex === 0) return;

    const floatChunk = this._buffer.subarray(0, this._bufferIndex);
    const int16      = new Int16Array(this._bufferIndex);

    for (let i = 0; i < this._bufferIndex; i++) {
      // Clamp to [-1, 1] then scale to Int16 range
      const clamped = Math.max(-1, Math.min(1, floatChunk[i]));
      int16[i] = clamped < 0
        ? Math.round(clamped * 32768)
        : Math.round(clamped * 32767);
    }

    // Transfer ownership of the underlying buffer for zero-copy postMessage
    this.port.postMessage(int16.buffer, [int16.buffer]);
    this._bufferIndex = 0;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
