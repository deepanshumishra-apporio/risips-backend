// Delivers one-time codes through MSG91: SMS with the Flow API (a template linked to the client's DLT-approved text),
// email with the Email API. A channel is used only when its MSG91 settings are present and demo mode is off (the demo
// returns codes to the app instead); otherwise the code is written to the server log, as before MSG91.
//
// Both templates take the same variables:
//   otp      the code
//   purpose  what it confirms, e.g. "a redemption", "signing in to Risips" (DLT variables are at most 30 characters)
//   minutes  how long it is valid
// SMS text to register on DLT: "{#var#} is your Risips OTP for {#var#}. It is valid for {#var#} minutes. Do not share
// it with anyone. - Arthasuta Finedu", mapped in MSG91 to ##otp##, ##purpose##, ##minutes##.
import { config } from '../config/env.ts';
import { ApiError } from '../utils/errors.ts';
import { errMsg, log } from '../utils/logger.ts';

const API = 'https://control.msg91.com/api/v5';
const m = config.msg91;
export const channels = {
  sms: !config.demoMode && !!(m.authKey && m.smsTemplateId),
  email: !config.demoMode && !!(m.authKey && m.emailTemplateId && m.emailDomain && m.emailFrom),
};

type Channel = keyof typeof channels;
type Vars = { otp: string; purpose: string; minutes: string };
/** Per channel: 'sent' (MSG91 accepted it), 'logged' (channel not set up, the code went to the server log) or 'failed'. */
export type Delivery = Partial<Record<Channel, 'sent' | 'logged' | 'failed'>>;

async function post(path: string, body: unknown) {
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { authkey: m.authKey!, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10e3),
  });
  const j = await r.json().catch(() => ({})) as { type?: string; message?: unknown; hasError?: boolean; errors?: unknown };
  // Flow answers {type: "success" | "error", message}; Email answers {status, hasError, errors}
  if (!r.ok || j.type === 'error' || j.hasError) throw new Error(`HTTP ${r.status} ${JSON.stringify(j.message || j.errors || j).slice(0, 200)}`);
  return j;
}

const sendSms = (mobile: string, vars: Vars) =>
  post('/flow', { template_id: m.smsTemplateId, short_url: '0', recipients: [{ mobiles: `91${mobile}`, ...vars }] });

const sendEmail = (email: string, vars: Vars) =>
  post('/email/send', {
    template_id: m.emailTemplateId, domain: m.emailDomain, from: { email: m.emailFrom, name: 'Risips' },
    recipients: [{ to: [{ email }], variables: vars }],
  });

/**
 * Sends `code` to each contact given. 'sent' means MSG91 accepted it: Flow answers success even for an unknown
 * template_id (seen 2026-10-27), and delivery failures show only in MSG91's delivery reports. Throws 503 when every
 * channel failed, so the investor can retry.
 */
export async function deliverOtp(
  to: { mobile?: string | null; email?: string | null },
  code: string,
  { purpose, ttl, label }: { purpose: string; ttl: number; label: string },
): Promise<Delivery> {
  const vars: Vars = { otp: code, purpose, minutes: String(Math.round(ttl / 60)) };
  const jobs = ([['sms', to.mobile, sendSms], ['email', to.email, sendEmail]] as const)
    .filter((j): j is typeof j & [Channel, string, unknown] => !!j[1]);
  const out: Delivery = {};
  let logged = false;
  await Promise.all(jobs.map(async ([ch, addr, send]) => {
    if (!channels[ch]) {
      out[ch] = 'logged';
      logged = true;
      return;
    }
    try {
      await send(addr, vars);
      out[ch] = 'sent';
    } catch (e) {
      out[ch] = 'failed';
      log.error(`OTP ${label}: MSG91 ${ch} failed`, { err: errMsg(e) });
    }
  }));
  if (logged && config.logOtps) log.info(`OTP ${label} -> ${code}`);
  if (jobs.length && jobs.every(([ch]) => out[ch] === 'failed')) {
    throw new ApiError(503, "We couldn't send the code. Please try again in a minute.");
  }
  return out;
}
