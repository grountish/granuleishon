// Comb resonator: a tuned feedback comb at `freq` plus two extra comb voices
// pitched int2/int3 semitones away (levels harm2/harm3) — a three-note chord
// ringing off the input. Runs as a worklet because a feedback loop through
// native DelayNodes is clamped to one render quantum (~344Hz max at 44.1k) —
// far too low for a musical resonator.
const MIN_FREQ = 40;
const MAX_FREQ = 2000;
const MAX_VOICE_FREQ = 8000; // +24st above the root ceiling

class ResonatorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'freq', defaultValue: 220, minValue: MIN_FREQ, maxValue: MAX_FREQ, automationRate: 'k-rate' },
      { name: 'decay', defaultValue: 0.85, minValue: 0, maxValue: 0.98, automationRate: 'k-rate' },
      { name: 'damp', defaultValue: 4200, minValue: 200, maxValue: 12000, automationRate: 'k-rate' },
      { name: 'int2', defaultValue: 12, minValue: -24, maxValue: 24, automationRate: 'k-rate' },
      { name: 'int3', defaultValue: 7, minValue: -24, maxValue: 24, automationRate: 'k-rate' },
      { name: 'harm2', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'harm3', defaultValue: 0.3, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    // 2 channels x 3 combs (root + two chord voices). Each buffer fits the
    // longest possible period (MIN_FREQ) plus interpolation headroom.
    this.bufLen = Math.ceil(sampleRate / MIN_FREQ) + 4;
    this.combs = [];
    for (let ch = 0; ch < 2; ch++) {
      for (let c = 0; c < 3; c++) {
        this.combs.push({
          buf: new Float32Array(this.bufLen),
          write: 0,
          lpState: 0,
          delay: sampleRate / 220, // smoothed toward target per sample
        });
      }
    }
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    const outChannels = output.length;
    if (!outChannels) return true;

    const frameCount = output[0].length;
    const freq = Math.max(MIN_FREQ, Math.min(MAX_FREQ, parameters.freq[0]));
    const fb = Math.max(0, Math.min(0.98, parameters.decay[0]));
    const damp = Math.max(200, Math.min(12000, parameters.damp[0]));
    const int2 = Math.max(-24, Math.min(24, parameters.int2[0]));
    const int3 = Math.max(-24, Math.min(24, parameters.int3[0]));
    const harm2 = parameters.harm2[0];
    const harm3 = parameters.harm3[0];
    // Chord-voice frequencies clamp to the buffer's reach on the low side.
    const voiceFreq = (st) =>
      Math.max(MIN_FREQ, Math.min(MAX_VOICE_FREQ, freq * Math.pow(2, st / 12)));
    const freqs = [freq, voiceFreq(int2), voiceFreq(int3)];

    // One-pole lowpass coefficient in each feedback loop (damping).
    const lpCoef = Math.exp((-2 * Math.PI * damp) / sampleRate);
    // Per-sample glide toward the target period keeps retunes click-free.
    const glide = 1 - Math.exp(-1 / (0.008 * sampleRate));
    // Resonance makeup: steady-state comb gain grows as 1/(1-fb).
    const makeup = 1 - fb * 0.6;
    const levels = [1, harm2, harm3];
    const bufLen = this.bufLen;

    for (let ch = 0; ch < outChannels; ch++) {
      const inChannel = input[ch] || input[0];
      const out = output[ch];
      for (let c = 0; c < 3; c++) {
        const comb = this.combs[ch * 3 + c];
        const level = levels[c];
        const targetDelay = Math.max(2, sampleRate / freqs[c]);
        const buf = comb.buf;
        let write = comb.write;
        let lpState = comb.lpState;
        let delay = comb.delay;

        for (let i = 0; i < frameCount; i++) {
          delay += (targetDelay - delay) * glide;
          // Fractional read with linear interpolation.
          let readPos = write - delay;
          if (readPos < 0) readPos += bufLen;
          const i0 = readPos | 0;
          const i1 = i0 + 1 === bufLen ? 0 : i0 + 1;
          const frac = readPos - i0;
          const tap = buf[i0] + (buf[i1] - buf[i0]) * frac;

          lpState += (1 - lpCoef) * (tap - lpState);
          const dry = inChannel ? inChannel[i] : 0;
          buf[write] = dry + lpState * fb;
          write = write + 1 === bufLen ? 0 : write + 1;

          const wet = tap * level * makeup;
          // First comb overwrites, partials accumulate; soft-clip keeps
          // high-feedback ringing inside sane bounds.
          if (c === 0) out[i] = wet;
          else out[i] += wet;
          if (c === 2) out[i] = Math.tanh(out[i]);
        }

        comb.write = write;
        comb.lpState = lpState;
        comb.delay = delay;
      }
    }

    return true;
  }
}

registerProcessor('resonator-processor', ResonatorProcessor);
