// Vocoder — a channel vocoder. The modulator (input 0, summed to mono) is
// split into log-spaced bands by 4th-order bandpass filters and each band's
// envelope is followed; the carrier — input 1, or an internal noise, saw or
// pitch-tracked saw — runs through the same bank, and every carrier band is
// scaled by the modulator envelope of the matching band.
//
// The carrier is levelled as a whole (one peak follower, not one per band)
// so a quiet synth drives the vocoder as hard as a loud one, then tilted a
// fixed amount toward the highs to make up for the 6 dB/oct a saw loses
// with each octave. Levelling per band was tried first and smears: each
// bank stage is a 2nd-order bandpass, so a two-stage cascade's skirts fall
// only 12 dB/oct, and a band holding nothing but its neighbour's skirt gets
// boosted to full level — every band between two synth harmonics then
// speaks the fundamental, and every band above the synth's reach speaks
// hiss. Bands the carrier leaves empty are meant to stay empty; the `noise`
// param fills them with high-passed white noise only while the voice is
// itself sibilant, so consonants come through without a constant hiss.
//
// Runs as a worklet because a native-node bank is (bandpass ×2, rectifier,
// smoother, gain) × bands × two signals — several hundred nodes per bus.

const MAX_BANDS = 32;
// Carrier leveller: a peak follower — instant attack, so an onset is never
// divided by a still-empty envelope; slow release, so it rides a note's
// decay. Below the floor the carrier fades out instead of being boosted, so
// a note's tail or a noise floor never blows up.
const LEVEL_FLOOR = 0.02;
const LEVEL_RELEASE_S = 0.15;
const MAKEUP = 2;
// Fixed brightening of the levelled carrier, (f / TILT_REF_HZ) ^ TILT_EXP:
// 0.5 would flatten a saw completely; 0.15 keeps most of the classic
// vocoder's darkness (the analysis bands already leak formants upward).
const TILT_EXP = 0.15;
const TILT_REF_HZ = 300;
// Hiss gate: share of the modulator's band energy above UNVOICED_HZ that
// counts as a consonant. Smoothstepped between the two bounds.
const NOISE_HP_HZ = 2500;
const UNVOICED_HZ = 3000;
const UNVOICED_LO = 0.12;
const UNVOICED_HI = 0.45;
// Bandpass stages per band. Each 2nd-order stage adds 6 dB/oct of skirt on
// either side; fewer than three lets a formant leak into the bands an
// octave above it, which the tilt then boosts. A cascade of N identical
// stages is narrower than one, so each stage is designed wider by
// 1 / sqrt(2^(1/N) - 1) to keep the band's -3 dB width where asked.
const STAGES = 3;
const CASCADE_WIDEN = 1 / Math.sqrt(Math.pow(2, 1 / STAGES) - 1);
const OSC_DETUNE_CENTS = 6;
const OSC_GLIDE_S = 0.012;

// Pitch tracker for the TRACK carrier — the YIN detector from
// autotune-processor.js, on a 2x-decimated mono sum.
const DETECT_WINDOW = 1024;
const DETECT_HALF = DETECT_WINDOW / 2;
const DETECT_HOP = 256;
const RING_SIZE = 4096;
const RING_MASK = RING_SIZE - 1;
const YIN_THRESHOLD = 0.12;
const VOICED_MAX_CMND = 0.4;
const GATE_POWER = 1e-6;

const SOURCE_BUS = 0;
const SOURCE_NOISE = 1;
const SOURCE_OSC = 2;
const SOURCE_TRACK = 3;

class VocoderProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'bands', defaultValue: 16, minValue: 4, maxValue: MAX_BANDS, automationRate: 'k-rate' },
      { name: 'lo', defaultValue: 100, minValue: 40, maxValue: 1000, automationRate: 'k-rate' },
      { name: 'hi', defaultValue: 8000, minValue: 1000, maxValue: 16000, automationRate: 'k-rate' },
      { name: 'width', defaultValue: 1, minValue: 0.3, maxValue: 3, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 5, minValue: 0.5, maxValue: 200, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 60, minValue: 5, maxValue: 1000, automationRate: 'k-rate' },
      { name: 'formant', defaultValue: 0, minValue: -24, maxValue: 24, automationRate: 'k-rate' },
      { name: 'noise', defaultValue: 0.15, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'note', defaultValue: 60, minValue: 24, maxValue: 96, automationRate: 'k-rate' },
      { name: 'source', defaultValue: 0, minValue: 0, maxValue: 3, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    // One set of bandpass coefficients per band, shared by the modulator and
    // carrier banks (b1 is 0 and b2 = -b0 for a bandpass).
    this.b0 = new Float64Array(MAX_BANDS);
    this.a1 = new Float64Array(MAX_BANDS);
    this.a2 = new Float64Array(MAX_BANDS);
    this.bankKey = '';
    this.octPerBand = 0.4;
    this.centers = new Float64Array(MAX_BANDS);
    this.tilt = new Float64Array(MAX_BANDS);
    // Filter states: STAGES cascaded stages × (z1, z2) per band. The
    // modulator bank is mono; the carrier bank runs per output channel.
    this.modZ = new Float64Array(MAX_BANDS * STAGES * 2);
    this.carZ = new Float64Array(2 * MAX_BANDS * STAGES * 2);
    this.modEnv = new Float64Array(MAX_BANDS);
    this.shifted = new Float64Array(MAX_BANDS);

    this.carPeak = 0;
    this.levelRelease = 1 - Math.exp(-1 / (LEVEL_RELEASE_S * sampleRate));

    // Internal carriers.
    this.noiseSeed = 0x9e3779b9;
    this.noiseHpCoef = 1 / (1 + (2 * Math.PI * NOISE_HP_HZ) / sampleRate);
    this.hpX = [0, 0];
    this.hpY = [0, 0];
    this.oscPhase = [0, 0];
    this.oscFreq = 0; // glided toward the target so pitch changes never click
    this.oscGlide = 1 - Math.exp(-1 / (OSC_GLIDE_S * sampleRate));

    // Pitch tracker (TRACK mode only).
    this.decRate = sampleRate / 2;
    this.decRing = new Float32Array(RING_SIZE);
    this.decWrite = 0;
    this.decHold = 0;
    this.decHasHold = false;
    this.decSinceDetect = 0;
    this.detectFrame = new Float32Array(DETECT_WINDOW);
    this.yinDiff = new Float32Array(Math.floor(this.decRate / 55) + 2);
    this.tauMin = Math.max(2, Math.floor(this.decRate / 1100));
    this.tauMax = Math.min(this.yinDiff.length - 1, DETECT_HALF - 1);
    this.trackedMidi = null; // last voiced pitch; held through unvoiced input
  }

  // Recompute the bank when its shape changes. Centers are log-spaced across
  // lo..hi; each band is as wide as the spacing, times `width`.
  updateBank(bands, lo, hi, width) {
    const key = `${bands}|${lo}|${hi}|${width}`;
    if (key === this.bankKey) return;
    this.bankKey = key;
    const octaves = Math.log2(hi / lo);
    this.octPerBand = octaves / bands;
    const stageOctaves = this.octPerBand * width * CASCADE_WIDEN;
    const q = Math.pow(2, stageOctaves / 2) / (Math.pow(2, stageOctaves) - 1);
    for (let k = 0; k < bands; k++) {
      const freq = lo * Math.pow(hi / lo, (k + 0.5) / bands);
      this.centers[k] = freq;
      this.tilt[k] = Math.pow(freq / TILT_REF_HZ, TILT_EXP);
      const w0 = (2 * Math.PI * freq) / sampleRate;
      const alpha = Math.sin(w0) / (2 * q);
      const a0 = 1 + alpha;
      this.b0[k] = alpha / a0;
      this.a1[k] = (-2 * Math.cos(w0)) / a0;
      this.a2[k] = (1 - alpha) / a0;
    }
  }

  noise() {
    // xorshift32 → white noise in [-1, 1).
    let x = this.noiseSeed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.noiseSeed = x >>> 0;
    return (this.noiseSeed / 4294967296) * 2 - 1;
  }

  // YIN over the newest DETECT_WINDOW decimated samples → f0 in Hz, or 0.
  detectF0() {
    const frame = this.detectFrame;
    const start = this.decWrite - DETECT_WINDOW;
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
        cmndAtBestNext = 1;
      } else if (bestTau === tau - 1) {
        cmndAtBestNext = cmnd;
      }
      prevPrevCmnd = prevCmnd;
      prevCmnd = cmnd;
    }
    const tau = thresholdTau >= 0 ? thresholdTau : bestTau;
    if (tau < this.tauMin || bestVal > VOICED_MAX_CMND) return 0;

    let refined = tau;
    const denom = cmndAtBestPrev - 2 * bestVal + cmndAtBestNext;
    if (Math.abs(denom) > 1e-12) {
      const shift = (0.5 * (cmndAtBestPrev - cmndAtBestNext)) / denom;
      if (shift > -1 && shift < 1) refined = tau + shift;
    }
    return this.decRate / refined;
  }

  // Feed one modulator sample to the tracker; runs YIN every DETECT_HOP.
  track(mono) {
    if (!this.decHasHold) {
      this.decHold = mono;
      this.decHasHold = true;
      return;
    }
    this.decRing[this.decWrite & RING_MASK] = (this.decHold + mono) * 0.5;
    this.decWrite += 1;
    this.decHasHold = false;
    this.decSinceDetect += 1;
    if (this.decSinceDetect >= DETECT_HOP && this.decWrite >= DETECT_WINDOW) {
      this.decSinceDetect = 0;
      const f0 = this.detectF0();
      if (f0 > 0) this.trackedMidi = 69 + 12 * Math.log2(f0 / 440);
    }
  }

  // PolyBLEP saw in [-1, 1] for one channel.
  saw(ch, inc) {
    let phase = this.oscPhase[ch] + inc;
    if (phase >= 1) phase -= 1;
    this.oscPhase[ch] = phase;
    let s = 2 * phase - 1;
    if (phase < inc) {
      const t = phase / inc;
      s -= t + t - t * t - 1;
    } else if (phase > 1 - inc) {
      const t = (phase - 1) / inc;
      s -= t * t + t + t + 1;
    }
    return s;
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output?.length) return true;
    const frames = output[0].length;
    const mod = inputs[0] || [];
    const car = inputs[1] || [];
    const modL = mod[0];
    const modR = mod[1] || modL;
    const carL = car[0];
    const carR = car[1] || carL;

    const bands = Math.max(4, Math.min(MAX_BANDS, Math.round(parameters.bands[0])));
    const lo = Math.max(40, Math.min(1000, parameters.lo[0]));
    // At least two octaves of range, and clear of Nyquist.
    const hi = Math.max(lo * 4, Math.min(sampleRate * 0.45, parameters.hi[0]));
    const width = Math.max(0.3, Math.min(3, parameters.width[0]));
    this.updateBank(bands, lo, hi, width);

    const attack = 1 - Math.exp(-1 / (Math.max(0.5, parameters.attack[0]) * 0.001 * sampleRate));
    const release = 1 - Math.exp(-1 / (Math.max(5, parameters.release[0]) * 0.001 * sampleRate));
    // Formant shift in bands: carrier band k reads the modulator envelope of
    // band k - shift, so energy at a modulator band appears `shift` higher.
    const shift = parameters.formant[0] / 12 / this.octPerBand;
    const noiseLevel = Math.max(0, Math.min(1, parameters.noise[0]));
    const note = parameters.note[0];
    const source = Math.round(parameters.source[0]);

    // Internal oscillator pitch: the note itself, or the tracked voice
    // transposed by the note's distance from C4.
    let oscTarget = 0;
    if (source === SOURCE_OSC) oscTarget = 440 * Math.pow(2, (note - 69) / 12);
    else if (source === SOURCE_TRACK) {
      const midi = (this.trackedMidi ?? 60) + (note - 60);
      oscTarget = Math.max(30, Math.min(4000, 440 * Math.pow(2, (midi - 69) / 12)));
    }
    if (this.oscFreq === 0) this.oscFreq = oscTarget;
    const detune = Math.pow(2, OSC_DETUNE_CENTS / 1200);

    const b0 = this.b0;
    const a1 = this.a1;
    const a2 = this.a2;
    const modZ = this.modZ;
    const carZ = this.carZ;
    const modEnv = this.modEnv;
    const shifted = this.shifted;
    const tilt = this.tilt;
    const levelRelease = this.levelRelease;
    const outChannels = Math.min(2, output.length);

    // How sibilant the voice is right now (per block is plenty: envelopes
    // move slower than a render quantum): hiss only opens on consonants.
    let hissGain = 0;
    if (noiseLevel > 0 && source !== SOURCE_NOISE) {
      let all = 0;
      let high = 0;
      for (let k = 0; k < bands; k++) {
        all += modEnv[k];
        if (this.centers[k] >= UNVOICED_HZ) high += modEnv[k];
      }
      const ratio = all > 1e-6 ? high / all : 0;
      const t = Math.max(0, Math.min(1, (ratio - UNVOICED_LO) / (UNVOICED_HI - UNVOICED_LO)));
      hissGain = noiseLevel * t * t * (3 - 2 * t);
    }

    for (let i = 0; i < frames; i++) {
      const m = ((modL ? modL[i] : 0) + (modR ? modR[i] : 0)) * 0.5;
      if (source === SOURCE_TRACK) this.track(m);

      // Carrier sample per channel.
      let c0;
      let c1;
      if (source === SOURCE_BUS) {
        c0 = carL ? carL[i] : 0;
        c1 = carR ? carR[i] : c0;
      } else if (source === SOURCE_NOISE) {
        c0 = this.noise();
        c1 = this.noise();
      } else {
        this.oscFreq += (oscTarget - this.oscFreq) * this.oscGlide;
        const inc = this.oscFreq / sampleRate;
        c0 = this.saw(0, inc * detune);
        c1 = this.saw(1, inc / detune);
      }
      // Level the carrier as a whole, then add the hiss on top so its
      // amount does not depend on how loud the synth happens to be.
      const peak = Math.max(c0 < 0 ? -c0 : c0, c1 < 0 ? -c1 : c1);
      if (peak > this.carPeak) this.carPeak = peak;
      else this.carPeak += levelRelease * (peak - this.carPeak);
      const gain = MAKEUP / (this.carPeak + LEVEL_FLOOR);
      c0 *= gain;
      c1 *= gain;
      if (hissGain > 0) {
        // High-passed hiss for the consonants, independent per channel.
        for (let ch = 0; ch < 2; ch++) {
          const x = this.noise();
          const y = this.noiseHpCoef * (this.hpY[ch] + x - this.hpX[ch]);
          this.hpX[ch] = x;
          this.hpY[ch] = y;
          if (ch === 0) c0 += y * hissGain;
          else c1 += y * hissGain;
        }
      }

      // Modulator analysis: the cascaded bandpasses, then an envelope.
      for (let k = 0; k < bands; k++) {
        const bk = b0[k];
        const a1k = a1[k];
        const a2k = a2[k];
        let x = m;
        for (let st = 0; st < STAGES; st++) {
          const z = (k * STAGES + st) * 2;
          const y = bk * x + modZ[z];
          modZ[z] = -a1k * y + modZ[z + 1];
          modZ[z + 1] = -bk * x - a2k * y;
          x = y;
        }
        const a = x < 0 ? -x : x;
        modEnv[k] += (a > modEnv[k] ? attack : release) * (a - modEnv[k]);
      }

      // Formant-shifted envelope per carrier band (linear between bands,
      // silent past either edge).
      for (let k = 0; k < bands; k++) {
        const pos = k - shift;
        const j = Math.floor(pos);
        const f = pos - j;
        const e0 = j >= 0 && j < bands ? modEnv[j] : 0;
        const e1 = j + 1 >= 0 && j + 1 < bands ? modEnv[j + 1] : 0;
        shifted[k] = e0 + (e1 - e0) * f;
      }

      // Carrier synthesis: same bank per channel, each band tilted and
      // scaled by the modulator's envelope.
      for (let ch = 0; ch < outChannels; ch++) {
        const c = ch === 0 ? c0 : c1;
        let sum = 0;
        for (let k = 0; k < bands; k++) {
          const bk = b0[k];
          const a1k = a1[k];
          const a2k = a2[k];
          let x = c;
          for (let st = 0; st < STAGES; st++) {
            const z = ((ch * MAX_BANDS + k) * STAGES + st) * 2;
            const y = bk * x + carZ[z];
            carZ[z] = -a1k * y + carZ[z + 1];
            carZ[z + 1] = -bk * x - a2k * y;
            x = y;
          }
          sum += x * tilt[k] * shifted[k];
        }
        output[ch][i] = sum;
      }
    }
    return true;
  }
}

registerProcessor('vocoder-processor', VocoderProcessor);
