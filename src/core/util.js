// Numeric helpers shared by every module. No app state, no DOM.

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function quantize(value, step, decimals) {
  return parseFloat((Math.round(value / step) * step).toFixed(decimals));
}

export function formatNumericValue(value, decimals) {
  return parseFloat(value.toFixed(decimals));
}

// Renders a value the way its control's step implies: step 0.01 → 2 decimals.
export function formatControlValue(spec, value) {
  const decimals = (spec.step.toString().split('.')[1] || '').length;
  return `${formatNumericValue(value, decimals)}${spec.unit ? ' ' + spec.unit : ''}`;
}
