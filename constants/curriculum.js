/** School board options (enterprise + admin resources). */
export const BOARDS = ['CBSE', 'ICSE'];

export const CLASS_LEVELS = ['5', '6', '7', '8', '9', '10', '11', '12'];

export function normalizeBoard(value) {
  const b = String(value || '').trim().toUpperCase();
  return BOARDS.includes(b) ? b : '';
}

export function normalizeClassLevel(value) {
  const c = String(value || '').trim();
  return CLASS_LEVELS.includes(c) ? c : '';
}
