// A tiny synchronous event bus. It exists so a feature module can announce
// that something changed without importing the code that reacts — which is
// what would otherwise force import cycles back into app.js.
//
// Handlers run in registration order, synchronously, so an emit behaves like
// the direct call it replaced. A throwing handler is reported and skipped
// rather than stopping the ones after it.

const handlers = new Map();

export function on(event, fn) {
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event).add(fn);
  return () => off(event, fn);
}

export function off(event, fn) {
  handlers.get(event)?.delete(fn);
}

export function emit(event, payload) {
  const set = handlers.get(event);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn(payload);
    } catch (err) {
      console.error(`[events] handler for "${event}" threw`, err);
    }
  }
}
