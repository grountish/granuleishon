const BUFFER_SECONDS = 10;

const DEFAULT_PARAMS = {
  grainSizeMs: 120,
  density: 20,
  positionSec: 0.5,
  spraySec: 0.05,
  pitch: 0,
  pitchJitter: 0,
  spread: 0.5,
  gain: 0.8,
};

class GranularProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.liveBufferLength = Math.floor(sampleRate * BUFFER_SECONDS);
    this.liveBuffer = new Float32Array(this.liveBufferLength);
    this.writePos = 0;
    this.filled = 0;

    // Two independent generators sharing the same source buffer.
    // freezeBuffer: pre-allocated snapshot copied from the active source on freeze.
    // frozenAt: source anchor at the moment of freeze — null when live.
    this.gens = [
      {
        params: { ...DEFAULT_PARAMS },
        grains: [],
        spawnCountdown: 0,
        frozenAt: null,
        sourceMode: 'live',
        sourceBuffer: null,
        sourceLength: this.liveBufferLength,
        freezeBuffer: new Float32Array(this.liveBufferLength),
      },
      {
        params: { ...DEFAULT_PARAMS },
        grains: [],
        spawnCountdown: 0,
        frozenAt: null,
        sourceMode: 'live',
        sourceBuffer: null,
        sourceLength: this.liveBufferLength,
        freezeBuffer: new Float32Array(this.liveBufferLength),
      },
    ];

    this.vizCounter = 0;

    this.port.onmessage = (e) => {
      if (!e.data) return;
      if (e.data.type === 'params') {
        const gen = this.gens[e.data.gen];
        const wasFreeze = gen.params.freeze;
        Object.assign(gen.params, e.data.value);
        if (!wasFreeze && gen.params.freeze) {
          const sourceBuffer = this.getGenSourceBuffer(gen);
          const sourceLength = this.getGenSourceLength(gen);
          gen.frozenAt = gen.sourceMode === 'live' ? this.writePos : sourceLength;
          this.ensureFreezeBufferLength(gen, sourceLength);
          gen.freezeBuffer.set(sourceBuffer);
        } else if (!gen.params.freeze) {
          gen.frozenAt = null;
        }
      } else if (e.data.type === 'set-gen-source-buffer' && e.data.buffer) {
        this.setGenSourceBuffer(e.data.gen, e.data.buffer);
      } else if (e.data.type === 'set-gen-source-mode') {
        this.setGenSourceMode(e.data.gen, e.data.mode);
      }
    };
  }

  getGenSourceLength(gen) {
    return Math.max(1, gen.sourceMode === 'live' ? this.liveBufferLength : gen.sourceLength || 1);
  }

  getGenSourceBuffer(gen) {
    return gen.sourceMode === 'live' ? this.liveBuffer : gen.sourceBuffer || this.liveBuffer;
  }

  ensureFreezeBufferLength(gen, length) {
    if (gen.freezeBuffer.length !== length) gen.freezeBuffer = new Float32Array(length);
  }

  clearGenState(gen) {
    gen.grains.length = 0;
    gen.spawnCountdown = 0;
    gen.frozenAt = null;
    gen.params.freeze = false;
    this.ensureFreezeBufferLength(gen, this.getGenSourceLength(gen));
  }

  setGenSourceBuffer(genIdx, buffer) {
    const gen = this.gens[genIdx];
    if (!gen) return;
    gen.sourceMode = 'sample';
    gen.sourceBuffer = buffer;
    gen.sourceLength = buffer.length || 1;
    this.clearGenState(gen);
  }

  setGenSourceMode(genIdx, mode) {
    const gen = this.gens[genIdx];
    if (!gen) return;
    gen.sourceMode = mode === 'sample' ? 'sample' : 'live';
    if (gen.sourceMode === 'live') {
      gen.sourceBuffer = null;
      gen.sourceLength = this.liveBufferLength;
    }
    this.clearGenState(gen);
  }

  spawnGrain(gen) {
    if (gen.grains.length >= 128) return;

    const p = gen.params;
    const length = Math.max(1, Math.floor((p.grainSizeMs / 1000) * sampleRate));
    const posSamples = p.positionSec * sampleRate;
    const spray = Math.random() * p.spraySec * sampleRate;
    const sourceLength = this.getGenSourceLength(gen);

    const anchor = gen.frozenAt !== null ? gen.frozenAt : gen.sourceMode === 'live' ? this.writePos : sourceLength;
    let start = anchor - posSamples - spray;
    start = ((start % sourceLength) + sourceLength) % sourceLength;

    const semis = p.pitch + (Math.random() * 2 - 1) * p.pitchJitter;
    const rate = Math.pow(2, semis / 12);

    const pan = 0.5 + (Math.random() * 2 - 1) * p.spread * 0.5;
    const panClamped = Math.min(1, Math.max(0, pan));
    const gainL = Math.cos(panClamped * Math.PI * 0.5);
    const gainR = Math.sin(panClamped * Math.PI * 0.5);

    gen.grains.push({ pos: start, phase: 0, length, rate, gainL, gainR });
  }

  _sendVizData() {
    const VIZ_N = 4096;
    const transferable = [];

    const gens = this.gens.map((gen) => {
      const frozen = gen.frozenAt !== null;
      // Frozen gens read from their snapshot so their waveform never changes.
      const sourceBuf = frozen ? gen.freezeBuffer : this.getGenSourceBuffer(gen);
      const sourceLength = frozen ? Math.max(1, gen.freezeBuffer.length) : this.getGenSourceLength(gen);
      const durationSec = Math.max(0.01, sourceLength / sampleRate);
      const refPos = gen.sourceMode === 'live' ? (frozen ? gen.frozenAt : this.writePos) : 0;

      const waveform = new Float32Array(VIZ_N);
      for (let i = 0; i < VIZ_N; i++) {
        const idx = (refPos + Math.floor((i * sourceLength) / VIZ_N)) % sourceLength;
        waveform[i] = sourceBuf[idx];
      }
      transferable.push(waveform.buffer);

      // posX is always relative to refPos — stays fixed when frozen.
      const posX = Math.max(0, Math.min(1, 1 - gen.params.positionSec / durationSec));
      const sprayNorm = Math.min(0.5, gen.params.spraySec / durationSec);
      return { waveform, posX, sprayNorm, frozen };
    });

    this.port.postMessage({ type: 'viz', gens }, transferable);
  }

  readInterpolated(buf, pos, length) {
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = buf[i0 % length];
    const b = buf[(i0 + 1) % length];
    return a + (b - a) * frac;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const inChannel = input && input.length > 0 ? input[0] : null;

    const output = outputs[0];
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : output[0];
    const blockSize = outL.length;

    for (let i = 0; i < blockSize; i++) {
      if (inChannel) {
        this.liveBuffer[this.writePos] = inChannel[i];
        this.writePos = (this.writePos + 1) % this.liveBufferLength;
        if (this.filled < this.liveBufferLength) this.filled++;
      }

      let sumL = 0;
      let sumR = 0;

      for (let gi = 0; gi < 2; gi++) {
        const gen = this.gens[gi];
        const spawnInterval = sampleRate / Math.max(0.01, gen.params.density);
        const sourceLength = this.getGenSourceLength(gen);
        const activeFilled = gen.sourceMode === 'live' ? this.filled : sourceLength;

        gen.spawnCountdown -= 1;
        while (gen.spawnCountdown <= 0) {
          if (activeFilled > 0) this.spawnGrain(gen);
          gen.spawnCountdown += spawnInterval;
        }

        for (let g = 0; g < gen.grains.length; g++) {
          const grain = gen.grains[g];
          const win = 0.5 * (1 - Math.cos((2 * Math.PI * grain.phase) / grain.length));
          const buf = gen.frozenAt !== null ? gen.freezeBuffer : this.getGenSourceBuffer(gen);
          const s = this.readInterpolated(buf, grain.pos, sourceLength) * win;
          sumL += s * grain.gainL * gen.params.gain;
          sumR += s * grain.gainR * gen.params.gain;

          grain.pos += grain.rate;
          if (grain.pos >= sourceLength) grain.pos -= sourceLength;
          grain.phase += 1;
        }

        // Compact finished grains.
        let w = 0;
        for (let g = 0; g < gen.grains.length; g++) {
          if (gen.grains[g].phase < gen.grains[g].length) gen.grains[w++] = gen.grains[g];
        }
        gen.grains.length = w;
      }

      outL[i] = sumL;
      outR[i] = sumR;
    }

    if (++this.vizCounter >= 20) {
      this.vizCounter = 0;
      this._sendVizData();
    }

    return true;
  }
}

registerProcessor('granular-processor', GranularProcessor);
