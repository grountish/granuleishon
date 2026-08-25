// Combined pitch shifter + stereo auto-pan. The pitch stage uses two
// overlapping delay taps; at zero shift it takes the direct path so auto-pan
// remains latency-free.

class PitchAutoPanProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'pitch', defaultValue: 0, minValue: -24, maxValue: 24, automationRate: 'k-rate' },
      { name: 'pitchDepth', defaultValue: 0, minValue: 0, maxValue: 24, automationRate: 'k-rate' },
      { name: 'fine', defaultValue: 0, minValue: -100, maxValue: 100, automationRate: 'k-rate' },
      { name: 'rate', defaultValue: 4, minValue: 0.02, maxValue: 20, automationRate: 'k-rate' },
      { name: 'depth', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'shape', defaultValue: 0, minValue: 0, maxValue: 3, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.bufferSize = 32768;
    this.bufferMask = this.bufferSize - 1;
    this.buffers = [new Float32Array(this.bufferSize), new Float32Array(this.bufferSize)];
    this.writeIndex = 0;
    this.pitchPhase = 0;
    this.panPhase = 0;
    this.smoothedWave = 0;
    this.pitchRatio = 1;
    this.pitchRatioTarget = 1;
    this.pitchRatioCountdown = 0;
    this.windowSamples = Math.max(512, Math.min(8192, Math.round(sampleRate * 0.05)));
    this.waveSmoothing = 1 - Math.exp(-1 / (sampleRate * 0.003));
  }

  read(channel, position) {
    const buffer = this.buffers[channel];
    const base = Math.floor(position);
    const fraction = position - base;
    const a = buffer[base & this.bufferMask];
    const b = buffer[(base + 1) & this.bufferMask];
    return a + (b - a) * fraction;
  }

  panWave(phase, shape) {
    if (shape === 1) return 1 - 4 * Math.abs(phase - 0.5); // triangle
    if (shape === 2) return phase < 0.5 ? 1 : -1; // square
    if (shape === 3) return phase * 2 - 1; // saw
    return Math.sin(phase * Math.PI * 2);
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output?.length) return true;

    const pitch = parameters.pitch[0] || 0;
    const pitchDepth = Math.max(0, Math.min(24, parameters.pitchDepth[0] || 0));
    const fine = parameters.fine[0] || 0;
    const rate = Math.max(0.02, parameters.rate[0] || 0.02);
    const depth = Math.max(0, Math.min(1, parameters.depth[0] || 0));
    const shape = Math.max(0, Math.min(3, Math.round(parameters.shape[0] || 0)));
    const shifted =
      Math.abs(pitch) > 0.0001 || pitchDepth > 0.0001 || Math.abs(fine) > 0.01;
    const panAdvance = rate / sampleRate;
    const frames = output[0].length;

    for (let i = 0; i < frames; i++) {
      const phaseA = this.pitchPhase;
      const phaseB = (phaseA + 0.5) % 1;
      const weightA = 0.5 - 0.5 * Math.cos(phaseA * Math.PI * 2);
      const weightB = 1 - weightA;
      const delayA = 64 + phaseA * this.windowSamples;
      const delayB = 64 + phaseB * this.windowSamples;
      const rawWave = this.panWave(this.panPhase, shape);
      this.smoothedWave += (rawWave - this.smoothedWave) * this.waveSmoothing;
      const sharedWave = this.smoothedWave;
      const pan = depth * sharedWave;
      const instantPitch = pitch + fine / 100 + pitchDepth * sharedWave;
      if (this.pitchRatioCountdown <= 0) {
        this.pitchRatioTarget = Math.pow(2, instantPitch / 12);
        this.pitchRatioCountdown = 8;
      }
      this.pitchRatio += (this.pitchRatioTarget - this.pitchRatio) * 0.25;
      this.pitchRatioCountdown -= 1;
      const pitchAdvance = (1 - this.pitchRatio) / this.windowSamples;
      const panGains = [Math.sqrt(1 - pan), Math.sqrt(1 + pan)];

      for (let channel = 0; channel < output.length; channel++) {
        const source = input[channel] || input[0];
        const sample = source?.[i] || 0;
        this.buffers[channel][this.writeIndex] = sample;
        const wet = shifted
          ? this.read(channel, this.writeIndex - delayA) * weightA +
            this.read(channel, this.writeIndex - delayB) * weightB
          : sample;
        output[channel][i] = wet * (panGains[channel] ?? 1);
      }

      this.writeIndex = (this.writeIndex + 1) & this.bufferMask;
      this.pitchPhase += pitchAdvance;
      this.pitchPhase -= Math.floor(this.pitchPhase);
      this.panPhase += panAdvance;
      this.panPhase -= Math.floor(this.panPhase);
    }
    return true;
  }
}

registerProcessor('pitch-autopan-processor', PitchAutoPanProcessor);
