// Control specs for the mastering rack and the draggable EQ bands.
// Pure data — no state, no DOM.

export const MASTERING_CONTROL_SPECS = [
  {
    id: 'comp',
    section: 'Glue Comp',
    controls: [
      { key: 'compThreshold', label: 'Thresh', min: -40, max: 0, step: 0.5, unit: 'dB' },
      { key: 'compRatio', label: 'Ratio', min: 1, max: 10, step: 0.5, unit: '' },
      { key: 'compAttack', label: 'Attack', min: 0.001, max: 0.1, step: 0.001, unit: 's' },
      { key: 'compRelease', label: 'Release', min: 0.05, max: 1, step: 0.01, unit: 's' },
      { key: 'compMakeup', label: 'Makeup', min: 0, max: 12, step: 0.5, unit: 'dB' },
    ],
  },
  {
    id: 'opto',
    section: 'Opto',
    controls: [
      { key: 'optoReduction', label: 'Reduction', min: 0, max: 40, step: 0.5, unit: 'dB' },
      { key: 'optoMakeup', label: 'Gain', min: 0, max: 24, step: 0.5, unit: 'dB' },
    ],
  },
  {
    id: 'ott',
    section: 'OTT',
    controls: [
      { key: 'ottDepth', label: 'Depth', min: 0, max: 100, step: 1, unit: '%' },
      { key: 'ottTime', label: 'Time', min: 0.33, max: 3, step: 0.01, unit: 'x' },
      { key: 'ottIn', label: 'In', min: -12, max: 12, step: 0.5, unit: 'dB' },
      { key: 'ottOut', label: 'Out', min: -12, max: 12, step: 0.5, unit: 'dB' },
      { key: 'ottLow', label: 'Low', min: -12, max: 12, step: 0.5, unit: 'dB' },
      { key: 'ottMid', label: 'Mid', min: -12, max: 12, step: 0.5, unit: 'dB' },
      { key: 'ottHigh', label: 'High', min: -12, max: 12, step: 0.5, unit: 'dB' },
    ],
  },
  {
    id: 'tape',
    section: 'Tape',
    controls: [
      { key: 'tapeDrive', label: 'Drive', min: 0, max: 18, step: 0.5, unit: 'dB' },
      { key: 'tapeBump', label: 'Bump', min: 0, max: 6, step: 0.5, unit: 'dB' },
      { key: 'tapeRolloff', label: 'Rolloff', min: 8, max: 20, step: 0.5, unit: 'kHz' },
      { key: 'tapeLevel', label: 'Level', min: -12, max: 12, step: 0.5, unit: 'dB' },
    ],
  },
  {
    id: 'sub',
    section: 'Sub',
    controls: [
      { key: 'subTune', label: 'Tune', min: 40, max: 160, step: 1, unit: 'Hz' },
      { key: 'subAmount', label: 'Amount', min: 0, max: 24, step: 0.5, unit: 'dB' },
      { key: 'subMix', label: 'Mix', min: 0, max: 100, step: 1, unit: '%' },
    ],
  },
  {
    id: 'exciter',
    section: 'Exciter',
    controls: [
      { key: 'excTune', label: 'Tune', min: 1000, max: 8000, step: 100, unit: 'Hz' },
      { key: 'excHarmonics', label: 'Harmonics', min: 0, max: 24, step: 0.5, unit: 'dB' },
      { key: 'excMix', label: 'Mix', min: 0, max: 50, step: 1, unit: '%' },
    ],
  },
  {
    id: 'width',
    section: 'Width',
    controls: [
      { key: 'width', label: 'Width', min: 0, max: 2, step: 0.05, unit: '' },
      { key: 'widthBassFreq', label: 'Bass Mono', min: 0, max: 300, step: 5, unit: 'Hz' },
    ],
  },
  {
    id: 'limit',
    section: 'Limit',
    controls: [
      { key: 'drive', label: 'Drive', min: 0, max: 12, step: 0.5, unit: 'dB' },
      { key: 'ceiling', label: 'Ceiling', min: -6, max: -0.1, step: 0.1, unit: 'dB' },
      { key: 'outGain', label: 'Output', min: -12, max: 6, step: 0.5, unit: 'dB' },
    ],
  },
];

export const MASTERING_EQ_BANDS = [
  {
    gainKey: 'lowGain',
    threshKey: 'lowDynThresh',
    rangeKey: 'lowDynRange',
    freqKey: 'lowFreq',
    qKey: 'lowQ',
    label: 'LOW',
    fmin: 20,
    fmax: 300,
    defaultQ: 0.7,
  },
  {
    gainKey: 'lowMidGain',
    threshKey: 'lowMidDynThresh',
    rangeKey: 'lowMidDynRange',
    freqKey: 'lowMidFreq',
    qKey: 'lowMidQ',
    label: 'LOW MID',
    fmin: 80,
    fmax: 1500,
    defaultQ: 1,
  },
  {
    gainKey: 'midGain',
    threshKey: 'midDynThresh',
    rangeKey: 'midDynRange',
    freqKey: 'midFreq',
    qKey: 'midQ',
    label: 'MID',
    fmin: 200,
    fmax: 5000,
    defaultQ: 0.7,
  },
  {
    gainKey: 'highMidGain',
    threshKey: 'highMidDynThresh',
    rangeKey: 'highMidDynRange',
    freqKey: 'highMidFreq',
    qKey: 'highMidQ',
    label: 'HIGH MID',
    fmin: 800,
    fmax: 12000,
    defaultQ: 1,
  },
  {
    gainKey: 'highGain',
    threshKey: 'highDynThresh',
    rangeKey: 'highDynRange',
    freqKey: 'highFreq',
    qKey: 'highQ',
    label: 'HIGH',
    fmin: 3000,
    fmax: 18000,
    defaultQ: 0.7,
  },
];
