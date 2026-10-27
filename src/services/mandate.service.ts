// AutoPay mandates (UPI AutoPay / eNACH): later SIP instalments are debited from them.
import { config } from '../config/env.ts';
import { usersRepo } from '../db/repositories/users.repository.ts';
import { fp } from '../integrations/fp.client.ts';
import { ApiError } from '../utils/errors.ts';
import { requireInvestor } from './orders.service.ts';
import type { FpObject, Mandate, User } from '../types/domain.ts';

const mandateView = (m: FpObject | null): Mandate | null => m && ({
  id: m.id, status: m.mandate_status, type: m.mandate_type, limit: m.mandate_limit, umrn: m.umrn || null,
  valid_from: m.valid_from, valid_to: m.valid_to, created_at: m.created_at, bank_account_id: m.bank_account_id,
});

/** Current mandate for the user (refreshed from FP). */
export async function currentMandate(user: User): Promise<Mandate | null> {
  const m = user.data.mandate;
  if (!m?.id) return null;
  const f = await fp.raw('GET', `/api/pg/mandates/${m.id}`, undefined, { label: 'mandate status' });
  if (f.status !== 200) return m;
  const next = { ...m, ...mandateView(f.json) };
  await usersRepo.merge(user.id, { mandate: next });
  return next;
}

export async function getMandate(user: User) {
  const m = await currentMandate(user);
  const bank = user.data.bank;
  return { mandate: m, bank: bank ? { bank_name: bank.bank_name, account_masked: `****${bank.account_number.slice(-4)}`, ifsc: bank.ifsc, branch: bank.branch } : null };
}

/** Creates an autopay mandate and returns the authorisation URL to open in the WebView. */
export async function createMandate(user: User, b: { type: 'UPI' | 'E_MANDATE'; limit?: number; need?: number }) {
  const ids = requireInvestor(user);
  const limit = Math.max(Number(b.limit) || 100000, 1000);
  const type = b.type;
  let m = await currentMandate(user);
  const usable = m?.status === 'APPROVED' && !String(m.umrn || '').startsWith('cyb_');
  // reuse only if its limit covers the SIP being set up (a debit above the limit always fails)
  if (usable && !(Number(b.need) > Number(m!.limit))) return { mandate: m, auth_url: null };
  // A single-use auth link can't be reopened, so start a fresh mandate unless one is still CREATED of the same type.
  if (!m || m.status !== 'CREATED' || m.type !== type || usable) {
    const created = await fp.post('/api/pg/mandates', {
      mandate_type: type, bank_account_id: ids.bank_old_id, mandate_limit: type === 'UPI' ? Math.min(limit, 100000) : limit, provider_name: 'CYBRILLAPOA',
    }, { label: 'mandate: create' });
    m = mandateView(await fp.get(`/api/pg/mandates/${created.id}`, { label: 'mandate: fetch' })) || { id: created.id, status: 'CREATED', type };
    await usersRepo.merge(user.id, { mandate: m });
  }
  const a = await fp.post('/api/pg/payments/emandate/auth', {
    mandate_id: m.id, payment_postback_url: `${config.publicUrl}/mandate/return?mandate=${m.id}`,
  }, { label: 'mandate: authorisation link' });
  await usersRepo.merge(user.id, { mandate: { ...m, auth_url: a.token_url } });
  return { mandate: m, auth_url: a.token_url, return_url_prefix: `${config.publicUrl}/mandate/return` };
}

/** The approved AutoPay mandate that can carry `need` a month, else a 409 telling the app to set one up. */
export async function usableMandate(user: User, need: number): Promise<Mandate> {
  const m = await currentMandate(user);
  if (m?.status !== 'APPROVED') throw new ApiError(409, 'Set up AutoPay first.', { need_mandate: true });
  // umrn cyb_* = approved via the simulate API; no gateway mandate exists and every debit fails.
  if (String(m.umrn || '').startsWith('cyb_')) throw new ApiError(409, 'This AutoPay cannot be debited. Please set up AutoPay again.', { need_mandate: true });
  if (need > Number(m.limit)) throw new ApiError(409, `This is above your AutoPay limit of ₹${Number(m.limit).toLocaleString('en-IN')}. Set up a new AutoPay with a higher limit.`, { need_mandate: true, limit: Number(m.limit) });
  return m;
}
