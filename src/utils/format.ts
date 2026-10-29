// Date and money formatting shared by the services. Dates are 'YYYY-MM-DD' strings in IST unless said otherwise.

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Local calendar date of a Date, as yyyy-mm-dd. */
export const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Today's IST calendar date plus `days`, as yyyy-mm-dd (independent of the server's time zone). */
export const istToday = (days = 0) => new Date(Date.now() + 5.5 * 3600e3 + days * 86400e3).toISOString().slice(0, 10);

const parseDay = (s: string) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };

/** The monthly instalment date `n` months after `from` (a yyyy-mm-dd instalment date), on the plan's day. */
export function addMonths(from: string, n: number, day?: number | null): string {
  const d = parseDay(from);
  return isoDay(new Date(d.getFullYear(), d.getMonth() + n, day || d.getDate()));
}

export const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
export const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

/** '2026-10-05' -> '5 Oct' */
export const dm = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
/** '2026-10-05' -> '5 Oct 2026' */
export const dmy = (iso: string) => `${dm(iso)} ${iso.slice(0, 4)}`;

/** Stored timestamps ('YYYY-MM-DD HH:MM:SS', db/connection.ts) are UTC without a zone: make one an ISO time. */
export const dbUtcToIso = (s: string) => (s && !/[zZ+]/.test(s.slice(10)) ? `${s.replace(' ', 'T')}Z` : s);

/** yyyy-mm-dd -> age in whole years, or null when it is not a real calendar date in the past (after 1900). */
export function ageOf(iso: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null; // e.g. 31/02
  const now = new Date();
  if (y < 1900 || dt > now) return null;
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() < mo - 1 || (now.getUTCMonth() === mo - 1 && now.getUTCDate() < d)) age -= 1;
  return age;
}

/** ₹ with up to 2 decimals: '₹1,234.5' */
export const inrExact = (n: unknown) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
/** ₹ rounded to the rupee: '₹1,235' */
export const inrRounded = (n: unknown) => `₹${Math.round(Number(n)).toLocaleString('en-IN')}`;
