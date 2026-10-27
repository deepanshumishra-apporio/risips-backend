// Masks personal data in objects before they are written to logs (FP call log, API log screen).
// PAN, bank account, phone, email, address, names and dates of birth: an investor's identity must not end up in a
// log file a developer or a log service can read.

const SECRET_KEYS = new Set(['access_token', 'client_secret', 'password', 'otp', 'enteredOtp', 'consent_otp', 'token_url']);
const PII_KEYS = new Set([
  'pan', 'taxid_number', 'account_number', 'primary_account_holder_name', 'number', 'mobile', 'phone', 'email',
  'line1', 'line2', 'line3', 'name', 'father_name', 'mother_name', 'spouse_name', 'date_of_birth', 'dob',
  'value', 'investor_identifier', 'umrn', 'vpa', 'upi_id', 'ip_address', 'user_ip', 'server_ip',
]);
/** Keys whose numbers are personal too (a NAV `value` is not). */
const NUMERIC_PII = new Set(['account_number', 'number', 'mobile', 'phone']);

/** 'ABCPX1234K' -> 'AB******4K'; short values are fully masked. */
export function maskValue(v: unknown): unknown {
  if (v === null || v === undefined || typeof v === 'boolean') return v;
  const s = String(v);
  if (s.length <= 4) return '****';
  return `${s.slice(0, 2)}${'*'.repeat(Math.min(8, s.length - 4))}${s.slice(-2)}`;
}

/** A deep copy with personal and secret fields masked. Leaves the input untouched. */
export function redact<T>(input: T, depth = 0): T {
  if (depth > 12 || input === null || typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map((x) => redact(x, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (SECRET_KEYS.has(k)) out[k] = v == null ? v : '[redacted]';
    else if (PII_KEYS.has(k) && (typeof v === 'string' || (typeof v === 'number' && NUMERIC_PII.has(k)))) out[k] = maskValue(v);
    else out[k] = redact(v, depth + 1);
  }
  return out as T;
}
