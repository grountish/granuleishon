// Beat Repeat — captures a short slice of the recent past and loops it
// rhythmically (stutter / glitch), with tempo-aligned re-trigger, pitch,
// per-repeat decay and a probability gate. Dry/wet is handled in the graph.
class BeatRepeatProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // How often a new repeat may be (re)triggered, in seconds.
      { name: 'interval', defaultValue: 0.5, minValue: 0.02, maxValue: 30, automationRate: 'k-rate' },
      // Length of the looped slice, in seconds.
      { name: 'grid', defaultValue: 0.125, minValue: 0.005, maxValue: 1, automationRate: 'k-rate' },
      // How many times the slice repeats before the dry signal returns.
      { name: 'gate', defaultValue: 8, minValue: 1, maxValue: 64, automationRate: 'k-rate' },
      // Transposition of the repeats, in semitones (playback rate of the slice).
      { name: 'pitch', defaultValue: 0, minValue: -24, maxValue: 24, automationRate: 'k-rate' },
      // Per-repeat gain multiplier (1 = no decay, <1 fades the repeats out).
      { name: 'decay', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      // Probability (0..1) that a repeat fires on each interval boundary.
      { name: 'chance', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    // Circular buffer holding the most recent audio, sized to the largest grid.
    this.bufLen = Math.max(1, Math.ceil(sampleRate * 1.0));
    this.record = [new Float32Array(this.bufLen), new Float32Array(this.bufLen)];
    this.slice = [new Float32Array(this.bufLen), new Float32Array(this.bufLen)];
    this.writePos = 0;
    this.intervalTimer = 0; // samples until the next interval evaluation
    this.repeating = false;
    this.repeatsLeft = 0;
    this.readPos = 0; // float read head into the captured slice
    this.sliceLen = 0;
    this.gain = 1; // current per-repeat gain
    // Transport start realigns the interval clock so repeats land on the bar.
    this.port.onmessage = (e) => {
      if (e.data === 'reset') {
        this.intervalTimer = 0;
        this.repeating = false;
      }
    };
  }

  // Copy the most recent `len` samples (ending at writePos) into the slice buffer
  // so it stays stable while new input keeps overwriting the record buffer.
  captureSlice(len) {
    const n = Math.max(1, Math.min(this.bufLen, len | 0));
    for (let ch = 0; ch < 2; ch++) {
      const rec = this.record[ch];
      const sl = this.slice[ch];
      let idx = this.writePos - n;
      while (idx < 0) idx += this.bufLen;
      for (let i = 0; i < n; i++) {
        sl[i] = rec[idx];
        if (++idx >= this.bufLen) idx -= this.bufLen;
      }
    }
    this.sliceLen = n;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    const outCh = output.length;
    if (!outCh) return true;
    const frames = output[0].length;

    const interval = parameters.interval[0];
    const grid = parameters.grid[0];
    const gate = Math.max(1, Math.round(parameters.gate[0]));
    const decay = parameters.decay[0];
    const chance = parameters.chance[0];
    const intervalSamples = Math.max(1, Math.floor(interval * sampleRate));
    const gridSamples = Math.max(1, Math.floor(grid * sampleRate));
    const rate = Math.pow(2, parameters.pitch[0] / 12);

    for (let i = 0; i < frames; i++) {
      // Always record the live input so a freshly triggered repeat has history.
      for (let ch = 0; ch < 2; ch++) {
        const inCh = input[ch] || input[0];
        this.record[ch][this.writePos] = inCh ? inCh[i] : 0;
      }
      if (++this.writePos >= this.bufLen) this.writePos = 0;

      // Interval clock — on each boundary, roll the chance to (re)trigger.
      if (--this.intervalTimer <= 0) {
        this.intervalTimer = intervalSamples;
        if (chance >= 1 || Math.random() < chance) {
          this.captureSlice(gridSamples);
          this.repeating = true;
          this.repeatsLeft = gate;
          this.readPos = 0;
          this.gain = 1;
        }
      }

      if (this.repeating && this.sliceLen > 0) {
        const p = this.readPos;
        const i0 = p | 0;
        const frac = p - i0;
        const i1 = i0 + 1 >= this.sliceLen ? 0 : i0 + 1;
        for (let ch = 0; ch < 2; ch++) {
          const sl = this.slice[ch];
          output[ch][i] = (sl[i0] + (sl[i1] - sl[i0]) * frac) * this.gain;
        }
        this.readPos += rate;
        if (this.readPos >= this.sliceLen) {
          this.readPos -= this.sliceLen;
          this.gain *= decay;
          if (--this.repeatsLeft <= 0) this.repeating = false;
        }
      } else {
        // Passthrough when idle (the dry/wet crossfade lives in the graph).
        for (let ch = 0; ch < outCh; ch++) {
          const inCh = input[ch] || input[0];
          output[ch][i] = inCh ? inCh[i] : 0;
        }
      }
    }

    return true;
  }
}

registerProcessor('beat-repeat-processor', BeatRepeatProcessor);
