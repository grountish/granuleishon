// Delay — parameter definitions, defaults and factory presets.
// fx/registry.js composes these into the tables the app reads.

import { clamp } from '../../core/util.js';

export const MAX_DELAY_SECONDS = 16;

import { formatBackValue } from '../../core/util.js';
import { getFxParamDef } from '../registry.js';

export default {
  id: 'delay',
  label: 'Delay',
  idleBypass: false,
  params: [
    { key: 'time', label: 'Time', min: 0, max: 1, step: 0.01, value: 0.3, unit: 's' },
    { key: 'feedback', label: 'Feedback', min: 0, max: 0.95, step: 0.01, value: 0.35, unit: '' },
    { key: 'hp', label: 'HP Cut', min: 20, max: 2000, step: 10, value: 20, unit: 'Hz' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, value: 0, unit: '' },
  ],
  // A factory, not a shared object: each bus owns its own state.
  defaults: () => ({
    enabled: true,
    time: 0.3,
    feedback: 0.35,
    mix: 0,
    sync: false,
    syncIndex: 4,
    hp: 20,
    mode: 'stereo',
  }),
  presets: [
    {
      name: 'Off',
      values: { time: 0.3, feedback: 0.35, hp: 20, mix: 0, sync: false, syncIndex: 4, mode: 'stereo' },
    },
    {
      name: 'Slapback',
      values: { time: 0.12, feedback: 0.18, hp: 120, mix: 0.28, sync: false, syncIndex: 4, mode: 'stereo' },
    },
    {
      name: 'Dub Echo',
      values: { time: 0.375, feedback: 0.72, hp: 350, mix: 0.45, sync: false, syncIndex: 4, mode: 'stereo' },
    },
    {
      name: 'Ping Pong',
      values: { time: 0.5, feedback: 0.65, hp: 180, mix: 0.42, sync: true, syncIndex: 4, mode: 'pingpong' },
    },
  ],

  apply(nodes, key, val, { ac }) {
    if (key === 'time')
      [nodes.tap, nodes.pingL, nodes.pingR].forEach((tap) =>
        tap.delayTime.setTargetAtTime(clamp(val, 0, MAX_DELAY_SECONDS), ac.currentTime, 0.02),
      );
    if (key === 'feedback')
      [nodes.fb, nodes.pingLFb, nodes.pingRFb].forEach((gain) =>
        gain.gain.setTargetAtTime(Math.min(0.98, val), ac.currentTime, 0.02),
      );
    if (key === 'hp')
      [nodes.hpf, nodes.pingLHpf, nodes.pingRHpf].forEach((f) =>
        f.frequency.setTargetAtTime(clamp(val, 20, 2000), ac.currentTime, 0.02),
      );
  },
  // Stereo and ping-pong share one graph; the mode gates which path is live.
  applyAll(nodes, { ac, state }) {
    const ping = state.mode === 'pingpong' ? 1 : 0;
    const normal = 1 - ping;
    [nodes.normalSend, nodes.normalFeedbackMode, nodes.normalWetMode].forEach((g) =>
      g.gain.setValueAtTime(normal, ac.currentTime),
    );
    [nodes.pingInputMode, nodes.pingLFeedbackMode, nodes.pingRFeedbackMode, nodes.pingWetMode].forEach(
      (g) => g.gain.setValueAtTime(ping, ac.currentTime),
    );
  },
  // Scaffold (in/dry/wet/out) is the rack's; this wires the wet path.
  // Stereo and ping-pong graphs are both built; applyAll gates which is live.
  build(ac, st, { input, wet }) {
    const normalSend = ac.createGain();
    const normalFeedbackMode = ac.createGain();
    const normalWetMode = ac.createGain();
    const tap = ac.createDelay(MAX_DELAY_SECONDS);
    const fb = ac.createGain();
    const hpf = ac.createBiquadFilter();
    hpf.type = 'highpass';
    hpf.frequency.value = st.hp;
    hpf.Q.value = 0.5;
    const pingSplit = ac.createChannelSplitter(2);
    const pingMonoIn = ac.createGain();
    pingMonoIn.channelCount = 1;
    pingMonoIn.channelCountMode = 'explicit';
    const pingInputMode = ac.createGain();
    const pingL = ac.createDelay(MAX_DELAY_SECONDS);
    const pingR = ac.createDelay(MAX_DELAY_SECONDS);
    const pingLFb = ac.createGain();
    const pingRFb = ac.createGain();
    const pingLFeedbackMode = ac.createGain();
    const pingRFeedbackMode = ac.createGain();
    const pingLHpf = ac.createBiquadFilter();
    pingLHpf.type = 'highpass';
    pingLHpf.frequency.value = st.hp;
    pingLHpf.Q.value = 0.5;
    const pingRHpf = ac.createBiquadFilter();
    pingRHpf.type = 'highpass';
    pingRHpf.frequency.value = st.hp;
    pingRHpf.Q.value = 0.5;
    const pingMerge = ac.createChannelMerger(2);
    const pingWetMode = ac.createGain();

    input.connect(normalSend);
    normalSend.connect(tap);
    tap.connect(normalFeedbackMode);
    normalFeedbackMode.connect(fb);
    fb.connect(hpf);
    hpf.connect(tap); // filtered feedback loop
    tap.connect(normalWetMode);
    normalWetMode.connect(wet);

    input.connect(pingSplit);
    pingSplit.connect(pingMonoIn, 0);
    pingSplit.connect(pingMonoIn, 1);
    pingMonoIn.connect(pingInputMode);
    pingInputMode.connect(pingL);
    pingL.connect(pingMerge, 0, 0);
    pingL.connect(pingLFeedbackMode);
    pingLFeedbackMode.connect(pingLFb);
    pingLFb.connect(pingLHpf);
    pingLHpf.connect(pingR);
    pingR.connect(pingMerge, 0, 1);
    pingR.connect(pingRFeedbackMode);
    pingRFeedbackMode.connect(pingRFb);
    pingRFb.connect(pingRHpf);
    pingRHpf.connect(pingL);
    pingMerge.connect(pingWetMode);
    pingWetMode.connect(wet);
    return { tap, fb, hpf, normalSend, normalFeedbackMode, normalWetMode, pingInputMode, pingL, pingR, pingLFb, pingRFb, pingLFeedbackMode, pingRFeedbackMode, pingLHpf, pingRHpf, pingWetMode };
  },
  // Back-panel line for this unit.
  subtitle(st) {
    return `${st.mode === 'pingpong' ? 'PINGPONG' : 'STEREO'} • ${formatBackValue(getFxParamDef('delay', 'mix'), st.mix)} wet`;
  },
};
