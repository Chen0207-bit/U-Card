export function hasExactValues(input, expected) {
  if (!input || typeof input !== 'object') return false;
  return Object.entries(expected).every(([key, value]) => input[key] === value);
}
