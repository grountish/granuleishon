// Microcosm-style grain arp: the input runs into a rolling capture ring; every
// tempo-synced step the just-recorded slice is replayed as a pitched grain,
// stepping through an interval pattern (octaves/fifths, up/down/random).
// `chance` is the Activity control (probability a step fires), `shape` skews
// the grain envelope, `feedback` writes the wet grains back into the ring so
// arps re-arp into evolving cascades.
const RING_SECONDS = 4;
const MAX_VOICES = 8;
const PATTERNS = [
  [0, 12], // oct
  [0, 7, 12, 19], // up
  [12, 7, 0, -5], // down
  null, // random pick
];
const RANDOM_INTERVALS = [-12, -5, 0, 7, 12];

class GrainArpProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'grid', defaultValue: 0.25, minValue: 0.005, maxValue: 1, automationRate: 'k-rate' },
      { name: 'pattern', defaultValue: 0, minValue: 0, maxValue: 3, automationRate: 'k-rate' },
      { name: 'chance', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'shape', defaultValue: 0.3, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'feedback', defaultValue: 0, minValue: 0, maxValue: 0.85, automationRate: 'k-rate' },
      { name: 'scatter', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'reverse', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'hold', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.ringLen = Math.ceil(sampleRate * RING_SECONDS);
    this.ring = [new Float32Array(this.ringLen), new Float32Array(this.ringLen)];
    this.write = 0;
    this.stepCounter = 0;
    this.patternStep = 0;
    this.panFlip = false;
    // Voice: { srcStart, srcSpan, pos, len, attackFrac, gainL, gainR, rate }
    this.voices = [];
  }

  spawnGrain(lenSamples, semitones, shape) {
    const rate = Math.pow(2, semitones / 12);
    const srcSpan = lenSamples * rate;
    if (srcSpan >= this.ringLen - 1) return; // out of the ring's reach
    let srcStart = this.write - srcSpan;
    if (srcStart < 0) srcStart += this.ringLen;
    if (this.voices.length >= MAX_VOICES) this.voices.shift(); // steal oldest
    this.panFlip = !this.panFlip;
    const wide = 0.35; // gentle alternate-pan width
    this.voices.push({
      srcStart,
      pos: 0,
      len: lenSamples,
      rate,
      attackFrac: Math.min(0.98, Math.max(0.02, shape)),
      gainL: this.panFlip ? 1 : 1 - wide,
      gainR: this.panFlip ? 1 - wide : 1,
    });
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output.length) return true;
    const frameCount = output[0].length;

    const grid = Math.max(0.005, Math.min(1, parameters.grid[0]));
    const patternIdx = Math.max(0, Math.min(3, Math.round(parameters.pattern[0])));
    const chance = parameters.chance[0];
    const shape = parameters.shape[0];
    const fb = Math.max(0, Math.min(0.85, parameters.feedback[0]));

    const stepSamples = Math.max(64, Math.round(grid * sampleRate));
    const pattern = PATTERNS[patternIdx];
    const ringLen = this.ringLen;
    const outL = output[0];
    const outR = output[1] || output[0];
    const inL = input[0] || null;
    const inR = input[1] || input[0] || null;

    for (let i = 0; i < frameCount; i++) {
      // Step clock — fire (or skip, per Activity) a grain each grid step.
      if (++this.stepCounter >= stepSamples) {
        this.stepCounter = 0;
        const st = pattern
          ? pattern[this.patternStep % pattern.length]
          : RANDOM_INTERVALS[(Math.random() * RANDOM_INTERVALS.length) | 0];
        this.patternStep++;
        if (Math.random() < chance) this.spawnGrain(stepSamples, st, shape);
      }

      // Sum active grain voices.
      let wetL = 0;
      let wetR = 0;
      for (let v = this.voices.length - 1; v >= 0; v--) {
        const voice = this.voices[v];
        const t = voice.pos / voice.len;
        const a = voice.attackFrac;
        const env = t < a ? t / a : (1 - t) / (1 - a);
        let readPos = voice.srcStart + voice.pos * voice.rate;
        readPos %= ringLen;
        const i0 = readPos | 0;
        const i1 = i0 + 1 === ringLen ? 0 : i0 + 1;
        const frac = readPos - i0;
        const sL = this.ring[0][i0] + (this.ring[0][i1] - this.ring[0][i0]) * frac;
        const sR = this.ring[1][i0] + (this.ring[1][i1] - this.ring[1][i0]) * frac;
        wetL += sL * env * voice.gainL;
        wetR += sR * env * voice.gainR;
        if (++voice.pos >= voice.len) this.voices.splice(v, 1);
      }

      outL[i] = wetL;
      outR[i] = wetR;

      // Capture input plus fed-back grains; soft clip keeps recursion sane.
      const dryL = inL ? inL[i] : 0;
      const dryR = inR ? inR[i] : 0;
      this.ring[0][this.write] = Math.tanh(dryL + wetL * fb);
      this.ring[1][this.write] = Math.tanh(dryR + wetR * fb);
      this.write = this.write + 1 === ringLen ? 0 : this.write + 1;
    }

    return true;
  }
}

registerProcessor('grain-arp-processor', GrainArpProcessor);
