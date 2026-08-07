import assert from 'node:assert/strict';

const camelCase = (key) => key.replace(/_([a-z0-9])/g, (_match, character) => character.toUpperCase());

export function normalizeAnchorEventName(name) {
  assert.match(String(name), /^[A-Za-z][A-Za-z0-9]*$/, 'Anchor event name is invalid');
  const text = String(name);
  return `${text[0].toUpperCase()}${text.slice(1)}`;
}

/**
 * Anchor 1.0 decodes event fields with the exact snake_case names in the IDL.
 * The production projections use JavaScript camelCase names. Normalize once at
 * the parser boundary so a decoded event can never silently project round 0.
 */
export function normalizeAnchorEventData(data) {
  assert.ok(data && typeof data === 'object' && !Array.isArray(data), 'Anchor event data must be an object');
  const normalized = { ...data };
  for (const [key, value] of Object.entries(data)) {
    const alias = camelCase(key);
    if (!(alias in normalized)) normalized[alias] = value;
  }
  return normalized;
}
