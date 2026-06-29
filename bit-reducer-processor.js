class BitReducerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'bits', defaultValue: 8, minValue: 1, maxValue: 16, automationRate: 'k-rate' },
      { name: 'rate', defaultValue: 1, minValue: 0.02, maxValue: 1, automationRate: 'a-rate' },
    ];
  }

  constructor() {
    super();
    this.phase = 0;
    this.held = [0, 0];
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    const outChannels = output.length;
    if (!outChannels) return true;

    const frameCount = output[0].length;
    const bitsValues = parameters.bits;
    const rateValues = parameters.rate;

    // bits is k-rate (constant for the whole block) — derive the quantization
    // levels once per block instead of recomputing 2**bits for every sample.
    const clampedBits = Math.max(1, Math.min(16, Math.round(bitsValues[0])));
    const levelsMinus1 = Math.max(2, 2 ** clampedBits) - 1;

    for (let i = 0; i < frameCount; i++) {
      const rate = Math.max(0.02, Math.min(1, rateValues.length > 1 ? rateValues[i] : rateValues[0]));

      this.phase += rate;
      if (this.phase >= 1) {
        this.phase -= 1;
        for (let ch = 0; ch < outChannels; ch++) {
          const inChannel = input[ch] || input[0];
          const sample = inChannel ? inChannel[i] : 0;
          const normalized = (Math.max(-1, Math.min(1, sample)) + 1) * 0.5;
          this.held[ch] = (Math.round(normalized * levelsMinus1) / levelsMinus1) * 2 - 1;
        }
      }

      for (let ch = 0; ch < outChannels; ch++) {
        output[ch][i] = this.held[ch] || 0;
      }
    }

    return true;
  }
}

registerProcessor('bit-reducer-processor', BitReducerProcessor);
