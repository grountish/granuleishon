// Stereo flanger for the Face rack. The left and right delay taps sweep in
// opposite directions, so even a held chord keeps moving across the field.

const SHAPES = ['sine', 'triangle', 'square', 'sawtooth'];

export default {
  id: 'flanger',
  label: 'Flanger',
  modeRows: [
    {
      key: 'shape',
      options: [
        ['sine', 'SIN'],
        ['triangle', 'TRI'],
        ['square', 'SQR'],
        ['sawtooth', 'SAW'],
      ],
    },
  ],
  params: [
    { key: 'rate', label: 'Rate', min: 0.03, max: 8, step: 0.01, unit: 'Hz' },
    { key: 'delay', label: 'Delay', min: 0.2, max: 8, step: 0.1, unit: 'ms' },
    { key: 'depth', label: 'Sweep', min: 0, max: 12, step: 0.1, unit: 'ms' },
    { key: 'feedback', label: 'Feedback', min: -0.9, max: 0.9, step: 0.01, unit: '' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, step: 0.01, unit: '' },
  ],
  defaults: () => ({
    enabled: true,
    shape: 'sine',
    rate: 0.16,
    delay: 1.2,
    depth: 5.5,
    feedback: 0.16,
    mix: 1,
  }),

  apply(nodes, key, val, { ac, state }) {
    const now = ac.currentTime;
    if (key === 'rate') nodes.lfo.frequency.setTargetAtTime(val, now, 0.02);
    if (key === 'feedback') {
      nodes.feedbackL.gain.setTargetAtTime(val, now, 0.02);
      nodes.feedbackR.gain.setTargetAtTime(val, now, 0.02);
    }
    if (key === 'delay' || key === 'depth') {
      // The AudioParam is the sweep centre. Offsetting it by the modulation
      // depth keeps the whole cycle above zero delay time.
      const centre = (state.delay + state.depth) / 1000;
      const depth = state.depth / 1000;
      nodes.delayL.delayTime.setTargetAtTime(centre, now, 0.02);
      nodes.delayR.delayTime.setTargetAtTime(centre, now, 0.02);
      nodes.depthL.gain.setTargetAtTime(depth, now, 0.02);
      nodes.depthR.gain.setTargetAtTime(-depth, now, 0.02);
    }
  },
  applyAll(nodes, { state }) {
    nodes.lfo.type = SHAPES.includes(state.shape) ? state.shape : 'sine';
  },
  build(ac, st, { input, wet }) {
    const splitter = ac.createChannelSplitter(2);
    const merger = ac.createChannelMerger(2);
    const delayL = ac.createDelay(0.05);
    const delayR = ac.createDelay(0.05);
    const feedbackL = ac.createGain();
    const feedbackR = ac.createGain();
    const lfo = ac.createOscillator();
    const depthL = ac.createGain();
    const depthR = ac.createGain();
    const centre = (st.delay + st.depth) / 1000;

    delayL.delayTime.value = centre;
    delayR.delayTime.value = centre;
    feedbackL.gain.value = st.feedback;
    feedbackR.gain.value = st.feedback;
    lfo.type = SHAPES.includes(st.shape) ? st.shape : 'sine';
    lfo.frequency.value = st.rate;
    depthL.gain.value = st.depth / 1000;
    depthR.gain.value = -st.depth / 1000;

    input.connect(splitter);
    splitter.connect(delayL, 0);
    splitter.connect(delayR, 1);
    delayL.connect(feedbackL);
    feedbackL.connect(delayL);
    delayR.connect(feedbackR);
    feedbackR.connect(delayR);
    delayL.connect(merger, 0, 0);
    delayR.connect(merger, 0, 1);
    merger.connect(wet);
    lfo.connect(depthL);
    lfo.connect(depthR);
    depthL.connect(delayL.delayTime);
    depthR.connect(delayR.delayTime);
    lfo.start();

    return { delayL, delayR, feedbackL, feedbackR, lfo, depthL, depthR };
  },
};
