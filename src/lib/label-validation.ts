const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export const MAX_LABEL_NAME_LENGTH = 100;

export function isValidColor(color: string): boolean {
  return HEX_COLOR_RE.test(color);
}
