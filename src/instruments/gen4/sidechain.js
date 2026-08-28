// Sidechain ducking: the kick lane and any trig source can duck the mix.

export const KICK_SC = {
  envelope: 0,
  release: 0.2,
  amount: 1.0,
};

// Second trigger envelope (mod source 4): like Kick SC, but the drum lane that
// fires it is selectable, and `invert` flips the polarity — a normal mapping
// ducks the target on each hit, an inverted one pushes it up (gate-style
// sidechain: the target only opens while the chosen lane is hitting).
export const TRIG_SC = {
  envelope: 0,
  release: 0.2,
  amount: 1.0,
  source: 'fm',
  invert: false,
};
