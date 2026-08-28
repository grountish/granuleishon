// LAN Link: Ableton-Link-style tempo and phase sync with one peer.

// ── LAN Link ── Ableton-Link-style tempo/phase sync with one other machine on
// the same network. A WebRTC data channel carries clock pings and the shared
// grid (PeerJS's public broker does signaling only — audio never leaves the
// machine). The host's performance clock is the shared timeline; the joiner
// measures its offset NTP-style (min-RTT filtered) and both machines schedule
// every step at an absolute grid time, so correction is continuous and
// drift can never accumulate.
export const LINK = {
  peer: null,
  conn: null,
  role: null, // 'host' | 'join'
  active: false, // data channel open
  room: '',
  offset: 0, // join only: host clock − local clock, seconds
  rtt: 0,
  samples: [], // recent {offset, rtt} pairs; best (lowest rtt) wins
  pingTimer: null,
  grid: { bpm: 120, origin: 0, playing: false }, // origin = shared time of absolute step 0
  stepAbs: 0, // next absolute grid step this machine will schedule
  applyingRemote: false, // guards echo loops on remote-driven transport/bpm
};
