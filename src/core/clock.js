// One authority for musical time. The AudioContext owns time; intervals and
// animation frames merely wake code that reads it. Keeping that distinction
// explicit prevents a throttled UI frame from becoming a second transport.

export const MUSICAL_CLOCK = {
  ctx: null,
  origin: 0,
  revision: 0,
};

export function bindMusicalClock(ctx) {
  if (!ctx || MUSICAL_CLOCK.ctx === ctx) return;
  MUSICAL_CLOCK.ctx = ctx;
  MUSICAL_CLOCK.origin = ctx.currentTime;
  MUSICAL_CLOCK.revision += 1;
}

export function unbindMusicalClock(ctx = null) {
  if (ctx && MUSICAL_CLOCK.ctx !== ctx) return;
  MUSICAL_CLOCK.ctx = null;
  MUSICAL_CLOCK.origin = 0;
  MUSICAL_CLOCK.revision += 1;
}

export function musicalNow() {
  return MUSICAL_CLOCK.ctx?.currentTime || 0;
}

// Re-anchor phase-locked consumers at a transport or section boundary.
export function resetMusicalClock(at = musicalNow()) {
  MUSICAL_CLOCK.origin = Number.isFinite(at) ? at : musicalNow();
  MUSICAL_CLOCK.revision += 1;
}

export function musicalElapsed(at = musicalNow()) {
  return Math.max(0, at - MUSICAL_CLOCK.origin);
}

export function createMusicalClockCursor() {
  return { time: null, revision: -1 };
}

export function resetMusicalClockCursor(cursor) {
  cursor.time = null;
  cursor.revision = -1;
}

// Delta for state that genuinely integrates (for example an LFO whose rate
// can change without resetting phase). A revision reset produces no jump.
// When the origin is slightly in the future, time stays pinned there until
// the audio clock reaches it.
export function readMusicalClock(cursor) {
  const now = Math.max(musicalNow(), MUSICAL_CLOCK.origin);
  const reset = cursor.revision !== MUSICAL_CLOCK.revision || cursor.time === null;
  const delta = reset ? 0 : Math.max(0, now - cursor.time);
  cursor.time = now;
  cursor.revision = MUSICAL_CLOCK.revision;
  return { now, delta, elapsed: musicalElapsed(now), reset };
}
