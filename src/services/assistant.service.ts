// "Ri" assistant (Figma 8:8681 welcome, 8:8713 conversation, 8:8741 advice guardrail).
// There is no LLM key on this deployment, so answers come from intent matching over the investor's real data (SIPs,
// orders, KYC, holdings) plus fixed explainers. answer() is the single entry point, so an LLM (e.g. the Claude API with
// these lookups as tools) can replace the matcher later without changing the app contract:
//   { messages: [{kind:'text', text} | {kind:'sips', items} | {kind:'order', order}], chips: [], actions: [{label, route?, kind}] }
// It never recommends a fund: advice questions get the guardrail reply (SEBI: advice needs a registered adviser).
import crypto from 'node:crypto';
import { ordersRepo } from '../db/repositories/orders.repository.ts';
import { usersRepo } from '../db/repositories/users.repository.ts';
import { ApiError } from '../utils/errors.ts';
import { dm, dmy, inrRounded as inr } from '../utils/format.ts';
import { log } from '../utils/logger.ts';
import { PATHS, refresh, TERMINAL, view } from './orders.service.ts';
import { portfolio } from './portfolio.service.ts';
import { planView, refreshPlan } from './sip.service.ts';
import type { Callback, User } from '../types/domain.ts';

type PlanView = ReturnType<typeof planView>;
/** One bubble in the reply. */
type Message =
  | { kind: 'text'; text: string }
  | { kind: 'sips'; items: { id: string; name: string | null; amount: number | null; next: string | null; status: string; route: string }[] }
  | { kind: 'order'; order: Record<string, unknown> };
interface Action { label: string; route?: string; kind: string }
/** The app contract: answer() always fills chips and actions (an intent may leave them out). */
interface Reply { messages: Message[]; chips?: string[]; actions?: Action[] }
interface Intent { test?: (t: string) => boolean; re?: RegExp; run: (u: User, t: string) => Reply | Promise<Reply> }


/** IST calendar date of a timestamp (stored 'YYYY-MM-DD HH:MM:SS' and bare ISO times are UTC). */
const istDay = (s: unknown) => {
  const t = String(s);
  if (t.length <= 10) return t;
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t.replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? t.slice(0, 10) : new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);
};

const WELCOME = [
  { title: 'YOUR ACCOUNT', chips: ['How are my SIPs doing?', 'When is my next SIP debit?', 'Track my last order', 'What’s my KYC status?'] },
  { title: 'STATEMENTS', chips: ['Capital gains statement', 'Account statement (CAS)'] },
  { title: 'LEARN', chips: ['What is XIRR?', 'SIP vs lump sum', 'How do exit loads work?'] },
];
const LEARN_CHIPS = ['What is XIRR?', 'SIP vs lump sum', 'How do exit loads work?', 'Explain risk levels', 'What is an expense ratio?'];

const text = (t: string): Message => ({ kind: 'text', text: t });

const LEARN: Record<string, string> = {
  xirr: 'XIRR is your yearly return when money goes in at different times, like SIP instalments. It gives each instalment credit only for the time it has actually been invested, so it is the fair way to measure a SIP. The absolute return simply compares today’s value with the total you put in and ignores time.',
  sipvslump: 'A SIP invests a fixed amount every month, so you buy more units when prices are low and fewer when they are high, without having to time the market. A lump sum puts all the money in at once: it does better if markets rise after you invest and worse if they fall soon after. Many investors use SIPs for monthly savings and lump sums for bonuses or windfalls.',
  exitload: 'An exit load is a fee some funds charge if you redeem within a set period, for example 1% of the amount if you redeem an equity fund within a year. It is deducted from what you receive. Each SIP instalment has its own clock, so older units can be free of the load while newer ones are not. Liquid funds have a small load only in the first 6 days, and ELSS funds have no exit load but a 3-year lock-in. The fund page shows each fund’s exit load.',
  risk: 'Every fund carries SEBI’s riskometer, with six levels: Low, Low to Moderate, Moderate, Moderately High, High and Very High. The level comes from what the fund holds (how much equity, the credit quality and interest-rate sensitivity of its bonds) and is reviewed every month. Higher-risk funds can swing more in value and suit goals that are 5 years or more away.',
  expense: 'The expense ratio is the yearly fee a fund charges for running it, as a percentage of your investment. It is taken out of the NAV every day, so you never pay it separately and the returns you see are already after it. SEBI caps it by fund size and type. Our data feed does not include expense ratios yet; each fund house publishes them in the fund’s factsheet.',
  nav: 'NAV (net asset value) is the price of one unit of a fund, worked out once every business day from the market value of everything the fund holds. Orders placed before the cut-off (3 pm for most funds, once the money reaches the fund house) get that day’s NAV; later ones get the next business day’s.',
  elss: 'ELSS funds are equity funds with a 3-year lock-in. Under the old tax regime, up to ₹1.5 lakh a year invested in them can be deducted under Section 80C. Each SIP instalment is locked for 3 years from its own date.',
};

/** Active and paused SIPs (refreshed from FP), with the monthly total and the earliest next debit. */
async function sipSummary(user: User) {
  const list = await ordersRepo.forUser(user.id, 'sip');
  const open = list.filter((o) => !['cancelled', 'completed', 'failed'].includes(o.state)).slice(0, 12);
  await Promise.all(open.map((o) => refreshPlan(o).catch(() => {})));
  const sips = (await ordersRepo.forUser(user.id, 'sip')).map(planView).filter((p) => p.state === 'active' || p.state === 'awaiting_payment');
  const running = sips.filter((p) => p.state === 'active' && !p.pause);
  const next = running.filter((p): p is PlanView & { next_debit: string } => !!p.next_debit).sort((a, b) => a.next_debit.localeCompare(b.next_debit))[0] || null;
  return { sips, running, next, monthly: running.reduce((a, p) => a + Number(p.amount), 0) };
}

const sipCard = (sips: PlanView[]): Message => ({
  kind: 'sips',
  items: sips.map((p) => ({ id: p.id, name: p.fund?.short_name || p.isin, amount: p.amount, next: p.next_debit, status: p.status, route: `/sip/${p.id}` })),
});

const noSips = (): Reply => ({
  messages: [text('You don’t have a running SIP yet. Pick a fund in Explore and choose “Start SIP” to set one up.')],
  actions: [{ label: 'Explore funds', route: '/(tabs)/explore', kind: 'primary' }],
  chips: ['SIP vs lump sum', 'Explain risk levels'],
});

/** Opens the SIP directly when there is one; otherwise lists them to choose from. */
function pickSip(s: Awaited<ReturnType<typeof sipSummary>>, verb: string): Reply {
  if (!s.sips.length) return noSips();
  if (s.sips.length === 1) {
    const p = s.sips[0];
    return { messages: [text(`Open your ${p.fund?.short_name} SIP and tap “${verb}”.`)], actions: [{ label: `Open ${p.fund?.short_name} SIP`, route: `/sip/${p.id}`, kind: 'primary' }], chips: [] };
  }
  return { messages: [text(`Which SIP? Open it and tap “${verb}”.`), sipCard(s.sips)], chips: [], actions: [] };
}

const INTENTS: Intent[] = [
  // advice guardrail first: "which fund should I buy" must never reach a data lookup that reads like a recommendation
  {
    // "top up my SIP" is a modify request, and "SIP or lump sum, which is better?" gets the neutral explainer
    test: (t) => /\b(recommend|suggest|advi[cs]e|should (i|we)|best|top(?![- ]?up)|good|better|safe(st|r)?|highest|high[- ]returns?|most (returns?|profitable)|worth (buying|investing|it)|which (mutual )?(fund|scheme|one|sip)s?|what to (buy|invest)|where (to|should i) (invest|put)|pick (a|one|some|the|me)|kaunsa|konsa)\b/i.test(t)
      && /\b(funds?|invest\w*|buy|sips?|schemes?|put|pick|returns?)\b/i.test(t)
      && !(/lump ?sum/i.test(t) && !/\b(funds?|schemes?)\b/i.test(t)),
    run: () => ({
      messages: [
        text('I can’t recommend specific funds — choosing what fits your goals is a decision for you and your advisor.'),
        text('I can compare fund facts like returns, risk level and expense ratio, or set up a call with your advisor.'),
      ],
      actions: [{ label: 'Book a call with my advisor', kind: 'book_call' }, { label: 'Compare funds myself', route: '/compare', kind: 'secondary' }],
      chips: ['Explain risk levels', 'What is an expense ratio?'],
    }),
  },
  { re: /\b(book|schedule|arrange)\b.*\bcall\b|\bcall (me|back)\b|\b(talk|speak) (to|with) (an? |my )?(advis|person|human|someone|somebody|agent)/i, run: (u) => bookCall(u) },
  {
    re: /\b(change|modify|edit|increase|decrease|step.?up|top.?up|reduce)\b.*\b(sips?|amount|date)\b/i,
    run: async (u) => pickSip(await sipSummary(u), 'Modify SIP'),
  },
  { re: /\b(pause|skip|stop for|hold)\b.*\bsips?\b|\bpause\b/i, run: async (u) => pickSip(await sipSummary(u), 'Pause SIP') },
  {
    re: /\b(resume|restart|unpause)\b.*\bsips?\b/i,
    run: async (u) => {
      const s = await sipSummary(u);
      const paused = s.sips.filter((p) => p.pause);
      if (!paused.length) return { messages: [text(s.sips.length ? 'None of your SIPs is paused, so there is nothing to resume.' : 'You don’t have a running SIP yet.')], chips: ['When is my next SIP debit?'], actions: [] };
      return pickSip({ ...s, sips: paused }, 'Resume SIP');
    },
  },
  { re: /\b(cancel|stop|end|close)\b.*\bsips?\b/i, run: async (u) => pickSip(await sipSummary(u), 'Cancel SIP') },
  { re: /\b(start|new|begin|set up|setup)\b.*\bsip\b/i, run: () => ({ messages: [text('Pick a fund in Explore and choose “Start SIP”. You set the amount and date, and AutoPay debits it every month.')], actions: [{ label: 'Explore funds', route: '/(tabs)/explore', kind: 'primary' }], chips: ['SIP vs lump sum'] }) },
  // explainers before the account lookups, so "SIP vs lump sum" is not read as "show my SIPs"
  { re: /xirr|annuali[sz]ed/i, run: () => learn('xirr') },
  { re: /lump ?sum|sip vs|vs\.? sip/i, run: () => learn('sipvslump') },
  { re: /exit load/i, run: () => learn('exitload') },
  { re: /\brisk/i, run: () => learn('risk') },
  { re: /expense ratio|\bter\b|\bfees?\b|\bcharges?\b/i, run: () => learn('expense') },
  { re: /\bnav\b/i, run: () => learn('nav') },
  { re: /\belss\b|80c|tax sav/i, run: () => learn('elss') },
  {
    re: /\bnext\b.*\b(debit|sip|instal|payment|deduct)|\bwhen\b.*\b(debit|deduct|sip)|\bdue\b/i,
    run: async (u) => {
      const s = await sipSummary(u);
      if (!s.sips.length) return noSips();
      if (!s.next) return { messages: [text('None of your SIPs has a debit coming up (they are paused or waiting for their first payment).'), sipCard(s.sips)], chips: [], actions: [] };
      const same = s.running.filter((p) => p.next_debit === s.next.next_debit);
      const total = same.reduce((a, p) => a + Number(p.amount), 0);
      return {
        messages: [text(`Your next SIP debit is ${inr(total)} on ${dmy(s.next.next_debit)}${same.length > 1 ? ` (${same.length} SIPs)` : ` for ${s.next.fund?.short_name}`}. Keep enough balance in your bank account for AutoPay.`), sipCard(same)],
        chips: ['How are my SIPs doing?', 'Pause a SIP'], actions: [],
      };
    },
  },
  {
    re: /\bsips?\b/i,
    run: async (u) => {
      const s = await sipSummary(u);
      if (!s.sips.length) return noSips();
      const n = s.running.length;
      const parts = [n ? `You have ${n} active SIP${n > 1 ? 's' : ''} totalling ${inr(s.monthly)} a month.` : 'None of your SIPs is debiting right now.'];
      if (s.next) parts.push(`Your next debit is ${inr(s.next.amount)} on ${dm(s.next.next_debit)}.`);
      const paused = s.sips.filter((p) => p.pause).length;
      if (paused) parts.push(`${paused} ${paused > 1 ? 'are' : 'is'} paused.`);
      const waiting = s.sips.filter((p) => p.state === 'awaiting_payment').length;
      if (waiting) parts.push(`${waiting} ${waiting > 1 ? 'are' : 'is'} waiting for the first payment.`);
      const paid = s.sips.reduce((a, p) => a + (p.invested || 0), 0);
      const cur = s.sips.reduce((a, p) => a + (p.current_value || 0), 0);
      if (paid && cur) parts.push(`So far ${inr(paid)} has gone in, worth ${inr(cur)} today.`);
      return {
        messages: [text(parts.join(' ')), sipCard(s.sips)],
        actions: [{ label: 'View all SIPs', route: '/(tabs)/holdings?tab=SIPs', kind: 'link' }],
        chips: ['Change SIP amount', 'Pause a SIP', 'Start a new SIP'],
      };
    },
  },
  {
    re: /\border/i,
    run: async (u) => {
      let o = (await ordersRepo.forUser(u.id)).find((x) => PATHS[x.kind]);
      if (!o) return { messages: [text('You haven’t placed an order yet.')], actions: [{ label: 'Explore funds', route: '/(tabs)/explore', kind: 'primary' }], chips: [] };
      if (!TERMINAL.includes(o.state)) o = await refresh(o).catch(() => o!);
      const v = view(o);
      const what = { purchase: 'purchase', redemption: 'withdrawal', switch: 'switch' }[v.kind as 'purchase'];
      const amt = v.amount != null ? `${inr(v.amount)} ` : '';
      return {
        messages: [
          text(`Your last order is a ${amt}${what} ${v.kind === 'purchase' ? 'in' : 'from'} ${v.fund.short_name}, placed ${dmy(istDay(v.created_at))}. Status: ${v.status}.`),
          { kind: 'order', order: { id: v.id, ref: v.ref, kind: v.kind, name: v.fund.short_name, amount: v.amount, units: v.units, status: v.status, state: v.state, created_at: v.created_at, route: v.kind === 'purchase' ? `/invest/result?id=${v.id}` : `/order/${v.id}` } },
        ],
        actions: [{ label: 'View all orders', route: '/orders', kind: 'link' }], chips: ['How are my SIPs doing?'],
      };
    },
  },
  {
    re: /\bkyc\b|\bverif/i,
    run: (u) => {
      const d = u.data;
      if (d.onboarded_at) {
        return { messages: [text(`Your KYC is complete: PAN, Aadhaar, bank account, selfie and signature are verified, and your investment account has been active since ${dmy(istDay(d.onboarded_at))}.`)], chips: ['Track my last order'], actions: [{ label: 'View account details', route: '/profile/account', kind: 'link' }] };
      }
      return { messages: [text('Your KYC isn’t finished yet. Pick up where you left off; it takes a few minutes.')], actions: [{ label: 'Continue KYC', kind: 'kyc' }], chips: [] };
    },
  },
  {
    re: /capital gain|\b(stcg|ltcg|tax(es)?|taxed|taxable)\b/i,
    run: () => ({ messages: [text('Your capital gains statement lists every redemption with its short- and long-term gains for the financial year, ready to download as a PDF.')], actions: [{ label: 'Open capital gains statement', route: '/reports/capital-gains', kind: 'primary' }], chips: ['Account statement (CAS)'] }),
  },
  {
    re: /\b(cas|account statement|statement|holding statement)\b/i,
    run: () => ({
      messages: [text('Your holdings statement lists every folio you hold through Risips, with units, cost and current value, as a downloadable PDF. A consolidated account statement (CAS) covering funds bought anywhere is issued by CAMS and KFintech.')],
      actions: [{ label: 'Open holdings statement', route: '/reports/holdings', kind: 'primary' }], chips: ['Capital gains statement'],
    }),
  },
  {
    re: /\b(portfolio|holdings?|worth|invested|returns?|profit|gain)\b/i,
    run: async (u) => {
      const p = await portfolio(u);
      if (!p.holdings.length) return { messages: [text('You don’t hold any funds yet.')], actions: [{ label: 'Explore funds', route: '/(tabs)/explore', kind: 'primary' }], chips: [] };
      const s = p.summary;
      const sign = s.gain >= 0 ? '+' : '−';
      return {
        messages: [text(`Your ${p.holdings.length} fund${p.holdings.length > 1 ? 's are' : ' is'} worth ${inr(s.current)} against ${inr(s.invested)} invested: ${sign}${inr(Math.abs(s.gain))} (${sign}${Math.abs(s.gain_pct).toFixed(2)}%).`)],
        actions: [{ label: 'View portfolio', route: '/(tabs)/holdings', kind: 'link' }], chips: ['What is XIRR?', 'Capital gains statement'],
      };
    },
  },
  { re: /^(hi|hello|hey|namaste|good (morning|afternoon|evening))\b/i, run: (u) => ({ messages: [text(`Hi ${u.data.name?.split(' ')[0] || 'there'}! Ask me about your SIPs, orders, KYC or statements, or about how mutual funds work.`)], chips: WELCOME[0].chips, actions: [] }) },
  { re: /^(thanks|thank you|thx|ok|okay|great|cool)\b/i, run: () => ({ messages: [text('Happy to help. Anything else?')], chips: WELCOME[0].chips.slice(0, 2), actions: [] }) },
];

function learn(key: string): Reply {
  return { messages: [text(LEARN[key])], chips: LEARN_CHIPS.filter((c) => !c.toLowerCase().includes({ xirr: 'xirr', sipvslump: 'lump', exitload: 'exit', risk: 'risk', expense: 'expense' }[key as 'xirr'] || '~')).slice(0, 3), actions: [] };
}

/** Stores a callback request for the client's advisory desk. */
export async function bookCall(user: User): Promise<Reply> {
  const cb = { id: `cb_${crypto.randomBytes(4).toString('hex')}`, at: new Date().toISOString(), status: 'requested', topic: 'Fund selection' };
  // checked and added under the row lock: a double tap can't book two calls
  let open: Callback | null = null;
  const u = (await usersRepo.update(user.id, (d) => {
    open = (d.callbacks || []).find((c) => c.status === 'requested') || null;
    return open ? {} : { callbacks: [...(d.callbacks || []), cb] };
  }))!;
  const existing = open as Callback | null;
  if (existing) return { messages: [text(`You already have a call request from ${dmy(istDay(existing.at))}. An advisor will call you on ${maskMobile(u.mobile)}.`)], chips: [], actions: [] };
  log.info('Advisor callback requested', { uid: user.id, cb: cb.id });
  return {
    messages: [text(`Done. An advisor will call you on ${maskMobile(u.mobile)} to talk through your goals. Meanwhile you can compare funds side by side.`)],
    actions: [{ label: 'Compare funds myself', route: '/compare', kind: 'secondary' }], chips: ['Explain risk levels'],
  };
}
const maskMobile = (m: string | null) => (m ? `+91 ••••• ${String(m).slice(-5)}` : 'your registered mobile');

export async function answer(user: User, input: unknown) {
  const t = String(input || '').trim();
  if (!t) throw new ApiError(400, 'Type a question.');
  for (const i of INTENTS) if (i.test ? i.test(t) : i.re!.test(t)) return { chips: [], actions: [], ...(await i.run(user, t)) };
  return {
    messages: [text('I can help with your SIPs, orders, KYC and statements, and explain how mutual funds work. Try one of these:')],
    chips: [...WELCOME[0].chips.slice(0, 3), 'What is XIRR?'], actions: [],
  };
}

/** The welcome screen: first name, intro and suggestion chips. */
export const welcome = (user: User) => ({
  name: user.data.name?.split(' ')[0] || null,
  intro: 'I can pull up your holdings, SIPs, orders and KYC status, and explain how mutual funds work.',
  groups: WELCOME,
});
