export function parseValue(input) {
  const normalized = input.trim();
  if (normalized.length === 0) {
    return 'empty';
  }

  return normalized.toLowerCase();
}

export function untouchedLine() {
  return true;
}
