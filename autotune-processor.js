// Autotune — monophonic pitch corrector. A YIN detector tracks the input's
// fundamental on a 2x-decimated mono sum; the correction stage re-tunes the
// audio to the nearest allowed pitch class with the same dual-tap delay-line
// shifter as pitch-autopan. The allowed set arrives as a 12-bit mask
// (bit n = pitch class n allowed), so scale/root/tonic modes are all just
// different masks. Unvoiced or out-of-range input glides back to unity.

const DETECT_WINDOW = 1024; // decimated samples (~43 ms at 48k input)
const DETECT_HALF = DETECT_WINDOW / 2;
const DETECT_HOP = 256; // decimated samples between analyses (~10.7 ms)
const RING_SIZE = 4096; // power of two, > DETECT_WINDOW
const RING_MASK = RING_SIZE - 1;
const YIN_THRESHOLD = 0.12;
const VOICED_MAX_CMND = 0.4;
const GATE_POWER = 1e-6; // mean-square gate: below this the input is silence

class AutotuneProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'speed', defaultValue: 40, minValue: 0, maxValue: 500, automationRate: 'k-rate' },
      { name: 'amount', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      // C major (bits 0,2,4,5,7,9,11) until the app pushes the real scale.
      { name: 'mask', defaultValue: 2741, minValue: 1, maxValue: 4095, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    // Shifter (same structure as pitch-autopan-processor).
    this.bufferSize = 32768;
    this.bufferMask = this.bufferSize - 1;
    this.buffers = [new Float32Array(this.bufferSize), new Float32Array(this.bufferSize)];
    this.writeIndex = 0;
    this.pitchPhase = 0;
    this.ratio = 1;
    this.ratioTarget = 1;
    this.windowSamples = Math.max(512, Math.min(8192, Math.round(sampleRate * 0.05)));

    // Detector: input decimated by 2 into a ring buffer.
    this.decRate = sampleRate / 2;
    this.decRing = new Float32Array(RING_SIZE);
    this.decWrite = 0;
    this.decHold = 0; // pending odd sample of the decimation pair
    this.decHasHold = false;
    this.decSinceDetect = 0;
    this.detectFrame = new Float32Array(DETECT_WINDOW);
    this.yinDiff = new Float32Array(Math.floor(this.decRate / 55) + 2);
    this.tauMin = Math.max(2, Math.floor(this.decRate / 1100));
    this.tauMax = Math.min(this.yinDiff.length - 1, DETECT_HALF - 1);
  }

  read(channel, position) {
    const buffer = this.buffers[channel];
    const base = Math.floor(position);
    const fraction = position - base;
    const a = buffer[base & this.bufferMask];
    const b = buffer[(base + 1) & this.bufferMask];
    return a + (b - a) * fraction;
  }

  // YIN over the newest DETECT_WINDOW decimated samples → f0 in Hz, or 0.
  detectF0() {
    const frame = this.detectFrame;
    let start = this.decWrite - DETECT_WINDOW;
    let power = 0;
    for (let i = 0; i < DETECT_WINDOW; i++) {
      const s = this.decRing[(start + i) & RING_MASK];
      frame[i] = s;
      power += s * s;
    }
    if (power / DETECT_WINDOW < GATE_POWER) return 0;

    const diff = this.yinDiff;
    const tauMax = this.tauMax;
    for (let tau = this.tauMin; tau <= tauMax; tau++) {
      let sum = 0;
      for (let j = 0; j < DETECT_HALF; j++) {
        const d = frame[j] - frame[j + tau];
        sum += d * d;
      }
      diff[tau] = sum;
    }

    // Cumulative-mean normalization, tracking threshold hit and global min.
    let running = 0;
    let bestTau = -1;
    let bestVal = Infinity;
    let thresholdTau = -1;
    let prevCmnd = 1;
    let prevPrevCmnd = 1;
    let cmndAtBestPrev = 1;
    let cmndAtBestNext = 1;
    for (let tau = this.tauMin; tau <= tauMax; tau++) {
      running += diff[tau];
      const cmnd = running > 0 ? (diff[tau] * (tau - this.tauMin + 1)) / running : 1;
      if (thresholdTau < 0 && cmnd < YIN_THRESHOLD && prevCmnd < cmnd) {
        // Passed a local minimum below threshold on the previous tau.
        thresholdTau = tau - 1;
        bestVal = prevCmnd;
        cmndAtBestPrev = prevPrevCmnd;
        cmndAtBestNext = cmnd;
        break;
      }
      if (cmnd < bestVal) {
        bestVal = cmnd;
        bestTau = tau;
        cmndAtBestPrev = prevCmnd;
        cmndAtBestNext = 1; // patched on the next iteration
      } else if (bestTau === tau - 1) {
        cmndAtBestNext = cmnd;
      }
      prevPrevCmnd = prevCmnd;
      prevCmnd = cmnd;
    }
    const tau = thresholdTau >= 0 ? thresholdTau : bestTau;
    if (tau < this.tauMin || bestVal > VOICED_MAX_CMND) return 0;

    // Parabolic refinement around the picked lag.
    let refined = tau;
    const denom = cmndAtBestPrev - 2 * bestVal + cmndAtBestNext;
    if (Math.abs(denom) > 1e-12) {
      const shift = (0.5 * (cmndAtBestPrev - cmndAtBestNext)) / denom;
      if (shift > -1 && shift < 1) refined = tau + shift;
    }
    return this.decRate / refined;
  }

  // Nearest MIDI note whose pitch class is allowed by the mask.
  static nearestAllowedMidi(midi, mask) {
    const rounded = Math.round(midi);
    let best = rounded;
    let bestDist = Infinity;
    for (let c = rounded - 11; c <= rounded + 11; c++) {
      if (!(mask & (1 << (((c % 12) + 12) % 12)))) continue;
      const dist = Math.abs(c - midi);
      if (dist < bestDist) {
        bestDist = dist;
        best = c;
      }
    }
    return best;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output?.length) return true;

    const speed = Math.max(0, parameters.speed[0] || 0);
    const amount = Math.max(0, Math.min(1, parameters.amount[0] ?? 1));
    const mask = Math.max(1, Math.min(4095, Math.round(parameters.mask[0] || 4095)));
    // Per-sample glide toward the target ratio; speed 0 = instant snap.
    const glide = speed <= 0 ? 1 : 1 - Math.exp(-1 / ((sampleRate * speed) / 1000));
    const frames = output[0].length;

    for (let i = 0; i < frames; i++) {
      const inL = input[0]?.[i] || 0;
      const inR = input[1]?.[i] ?? inL;
      const mono = (inL + inR) * 0.5;

      // Decimate ×2 into the detection ring (average of each sample pair).
      if (this.decHasHold) {
        this.decRing[this.decWrite & RING_MASK] = (this.decHold + mono) * 0.5;
        this.decWrite += 1;
        this.decHasHold = false;
        this.decSinceDetect += 1;
        if (this.decSinceDetect >= DETECT_HOP && this.decWrite >= DETECT_WINDOW) {
          this.decSinceDetect = 0;
          const f0 = this.detectF0();
          if (f0 > 0) {
            const midi = 69 + 12 * Math.log2(f0 / 440);
            const target = AutotuneProcessor.nearestAllowedMidi(midi, mask);
            this.ratioTarget = Math.pow(2, ((target - midi) * amount) / 12);
          } else {
            this.ratioTarget = 1;
          }
        }
      } else {
        this.decHold = mono;
        this.decHasHold = true;
      }

      this.ratio += (this.ratioTarget - this.ratio) * glide;

      const phaseA = this.pitchPhase;
      const phaseB = (phaseA + 0.5) % 1;
      const weightA = 0.5 - 0.5 * Math.cos(phaseA * Math.PI * 2);
      const weightB = 1 - weightA;
      const delayA = 64 + phaseA * this.windowSamples;
      const delayB = 64 + phaseB * this.windowSamples;

      for (let channel = 0; channel < output.length; channel++) {
        const source = input[channel] || input[0];
        this.buffers[channel][this.writeIndex] = source?.[i] || 0;
        output[channel][i] =
          this.read(channel, this.writeIndex - delayA) * weightA +
          this.read(channel, this.writeIndex - delayB) * weightB;
      }

      this.writeIndex = (this.writeIndex + 1) & this.bufferMask;
      const drift = 1 - this.ratio;
      if (Math.abs(drift) < 1e-4 && this.pitchPhase !== 0) {
        // At unity two frozen taps would comb-filter unvoiced input — glide
        // the crossfade to phase 0, where all weight sits on a single tap.
        const step = 1 / (sampleRate * 0.35);
        this.pitchPhase =
          this.pitchPhase < 0.5
            ? Math.max(0, this.pitchPhase - step)
            : (this.pitchPhase + step) % 1;
      } else {
        this.pitchPhase += drift / this.windowSamples;
        this.pitchPhase -= Math.floor(this.pitchPhase);
      }
    }
    return true;
  }
}

registerProcessor('autotune-processor', AutotuneProcessor);
