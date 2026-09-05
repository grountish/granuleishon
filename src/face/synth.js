// A paraphonic two-oscillator synth. Every voice is osc A + osc B (own wave,
// octave and detune, crossfaded by mix) into its own envelope; the voices sum
// into one low-pass (cutoff, resonance) → amp → pan → out. Chords arrive as
// MIDI lists: common tones hold, new tones attack, dropped tones release.

export const OSC_WAVES = ['sawtooth', 'square', 'triangle', 'sine'];
const VOICE_LEVEL = 0.2; // four voices peak just under 1 before the filter
const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

export function createFaceSynth(ctx, out) {
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 600;
  filter.Q.value = 1;
  const amp = ctx.createGain();
  amp.gain.value = 1;
  const pan = ctx.createStereoPanner();
  const master = ctx.createGain();
  master.gain.value = 0.5;
  filter.connect(amp);
  amp.connect(pan);
  pan.connect(master);
  master.connect(out);

  const patch = {
    waveA: 'sawtooth',
    waveB: 'square',
    octaveB: -1,
    detune: 8, // cents, osc B against osc A
    mix: 0.5, // 0 = only A, 1 = only B
    attack: 0.05,
    release: 0.4,
  };
  const voices = new Map(); // midi → { a, b, gainA, gainB, env }

  const mixGains = (mix) => [Math.cos((mix * Math.PI) / 2), Math.sin((mix * Math.PI) / 2)];

  function tuneVoice(v, midi, t) {
    const hz = midiToHz(midi);
    v.a.frequency.setTargetAtTime(hz, t, 0.01);
    v.b.frequency.setTargetAtTime(hz * Math.pow(2, patch.octaveB), t, 0.01);
    v.b.detune.setTargetAtTime(patch.detune, t, 0.01);
  }

  function spawn(midi) {
    const t = ctx.currentTime;
    const a = ctx.createOscillator();
    a.type = patch.waveA;
    const b = ctx.createOscillator();
    b.type = patch.waveB;
    const [ga, gb] = mixGains(patch.mix);
    const gainA = ctx.createGain();
    gainA.gain.value = ga;
    const gainB = ctx.createGain();
    gainB.gain.value = gb;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(VOICE_LEVEL, t + patch.attack);
    a.connect(gainA);
    b.connect(gainB);
    gainA.connect(env);
    gainB.connect(env);
    env.connect(filter);
    const v = { a, b, gainA, gainB, env };
    tuneVoice(v, midi, t);
    a.frequency.value = midiToHz(midi);
    b.frequency.value = midiToHz(midi) * Math.pow(2, patch.octaveB);
    a.start(t);
    b.start(t);
    voices.set(midi, v);
  }

  function release(midi) {
    const v = voices.get(midi);
    if (!v) return;
    voices.delete(midi);
    const t = ctx.currentTime;
    v.env.gain.cancelScheduledValues(t);
    v.env.gain.setValueAtTime(Math.max(v.env.gain.value, 0.0001), t);
    v.env.gain.linearRampToValueAtTime(0, t + patch.release);
    const stopAt = t + patch.release + 0.05;
    v.a.stop(stopAt);
    v.b.stop(stopAt);
    setTimeout(() => {
      [v.a, v.b, v.gainA, v.gainB, v.env].forEach((n) => {
        try {
          n.disconnect();
        } catch (e) {}
      });
    }, (patch.release + 0.1) * 1000);
  }

  return {
    patch,
    setPatch(next) {
      Object.assign(patch, next);
      const t = ctx.currentTime;
      const [ga, gb] = mixGains(patch.mix);
      voices.forEach((v, midi) => {
        v.a.type = patch.waveA;
        v.b.type = patch.waveB;
        v.gainA.gain.setTargetAtTime(ga, t, 0.02);
        v.gainB.gain.setTargetAtTime(gb, t, 0.02);
        tuneVoice(v, midi, t);
      });
    },
    setChord(midis, { retrigger = false } = {}) {
      const want = new Set(midis);
      [...voices.keys()].forEach((m) => {
        if (retrigger || !want.has(m)) release(m);
      });
      want.forEach((m) => {
        if (!voices.has(m)) spawn(m);
      });
    },
    allOff() {
      [...voices.keys()].forEach(release);
    },
    // cutoff Hz; resonance Q; pan -1..1; mix 0..1 (osc B share).
    set({ cutoff, resonance, pan: p, mix }) {
      const t = ctx.currentTime;
      if (Number.isFinite(cutoff)) filter.frequency.setTargetAtTime(cutoff, t, 0.03);
      if (Number.isFinite(resonance)) filter.Q.setTargetAtTime(resonance, t, 0.05);
      if (Number.isFinite(p)) pan.pan.setTargetAtTime(p, t, 0.08);
      if (Number.isFinite(mix) && Math.abs(mix - patch.mix) > 0.005) {
        patch.mix = mix;
        const [ga, gb] = mixGains(mix);
        voices.forEach((v) => {
          v.gainA.gain.setTargetAtTime(ga, t, 0.05);
          v.gainB.gain.setTargetAtTime(gb, t, 0.05);
        });
      }
    },
    setVolume(v) {
      master.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
    },
    voiceCount() {
      return voices.size;
    },
    dispose() {
      [...voices.keys()].forEach(release);
      setTimeout(() => {
        [filter, amp, pan, master].forEach((n) => {
          try {
            n.disconnect();
          } catch (e) {}
        });
      }, (patch.release + 0.2) * 1000);
    },
  };
}
