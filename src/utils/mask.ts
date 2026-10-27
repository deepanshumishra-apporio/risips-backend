// Masking for values shown back to the investor (the app never receives a full PAN or account number it didn't send).

/** Keeps the last `keep` characters: 'ABCPX1234K' -> '*******34K'. */
export const maskTail = (s: string | null | undefined, keep = 4, ch = '*') => (s ? ch.repeat(Math.max(0, s.length - keep)) + s.slice(-keep) : null);

/** Keeps the first and last characters with at most 4 dots between: '9876543210' -> '98••••210'. */
export const maskMiddle = (s: string | null, keepStart: number, keepEnd: number) =>
  (s ? `${s.slice(0, keepStart)}${'•'.repeat(Math.min(4, Math.max(0, s.length - keepStart - keepEnd)))}${keepEnd ? s.slice(-keepEnd) : ''}` : null);
