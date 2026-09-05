// Recording and offline-bounce state.

export const REC = {
  isRecording: false,
  left: [],
  right: [],
  sampleCount: 0,
  processor: null,
  sink: null,
  downloadName: null, // one-shot override used by the song bounce
};

export const BOUNCE = {
  active: false,
  muted: false,
  pollTimer: null,
  progressTimer: null,
  tailTimer: null,
  phase: 'idle',
  songSeconds: 0,
  capSeconds: 0,
  renderedSeconds: 0,
  tailStartedAt: 0,
  stems: false,
  prevMode: 'loop',
  prevSongLoop: true,
  prevScheduleAheadTime: 0.15,
};
