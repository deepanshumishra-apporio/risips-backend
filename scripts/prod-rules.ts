// Writes data/catalog-rules.production.json: the trading rules (lumpsum, SIP, switch-in, STP, SWP) of every catalogue
// scheme as the PRODUCTION tenant's cybrillapoa scheme plans state them. catalog.ts lays them over data/catalog.json
// when FP_ENV=production. Read-only against FP.  Run: FP_ENV=production node scripts/prod-rules.ts
//
// Why not the sandbox rules: the production OMS fund-scheme master is empty (every /api/oms/fund_schemes/:isin is a 404
// on 2026-10-16), and the scheme plans differ from the sandbox. The gold FoFs have no lumpsum/SIP threshold there,
// ABSL Liquid has no STP/SWP, ICICI Large Cap's STP minimum is ₹100, not ₹1,000.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config } from '../src/config/env.ts';
import { fp } from '../src/integrations/fp.client.ts';
import { switchInRule } from './stp-rules.ts';
import type { SchemeRules } from '../src/types/catalog.ts';
import type { JsonObject } from '../src/types/domain.ts';

if (!config.production) throw new Error('Run with FP_ENV=production: these are the live tenant\'s rules');

/** cybrillapoa thresholds -> the catalogue's rule fields (same shapes build-catalog.ts and stp-rules.ts produce). */
export function rulesFrom(thresholds: JsonObject[] = []): SchemeRules {
  const one = (type: string, frequency?: string) => thresholds.find((t) => t.type === type && (!frequency || t.frequency === frequency));
  const lump = one('lumpsum');
  const sips = thresholds.filter((t) => t.type === 'sip' && ['monthly', 'weekly', 'quarterly'].includes(t.frequency));
  // ONDC plans are monthly only. One catalogue `stp` serves both legs (stp.ts takes the larger of the two schemes' rules).
  const sIn = one('stp_in', 'monthly'), sOut = one('stp_out', 'monthly'), swp = one('swp', 'monthly');
  const legs = [sIn, sOut].filter(Boolean) as JsonObject[];
  return {
    lumpsum: lump
      ? { allowed: true, min: lump.amount_min, additional_min: lump.additional_amount_min, multiples: lump.amount_multiples ?? 1, max: lump.amount_max ?? null }
      : { allowed: false, min: null, additional_min: null, multiples: 1, max: null },
    sip: sips.map((t) => ({ frequency: t.frequency, min: t.amount_min, multiples: t.amount_multiples, installments_min: t.installments_min, dates: t.dates })),
    switch_in: switchInRule(one('switch_in')),
    switch_in_allowed: !!one('switch_in'),
    switch_out_allowed: !!one('switch_out'),
    redemption_allowed: !!one('withdrawal'),
    stp: legs.length ? {
      in: !!sIn, out: !!sOut, frequency: 'monthly',
      min: Math.max(...legs.map((t) => t.amount_min)), multiples: Math.max(...legs.map((t) => t.amount_multiples || 1)),
      installments_min: Math.max(...legs.map((t) => t.installments_min || 1)),
      dates: legs.map((t) => t.dates).reduce((a, b) => a.filter((d: number) => b.includes(d))),
    } : null,
    swp: swp ? { frequency: 'monthly', min: swp.amount_min, multiples: swp.amount_multiples, installments_min: swp.installments_min, dates: swp.dates } : null,
  };
}

if (process.argv[1]?.endsWith('prod-rules.ts')) {
  const cat = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog.json'), 'utf8'));
  const schemes: Record<string, SchemeRules> = {};
  for (const s of cat.schemes) {
    const v2 = await fp.raw('GET', `/v2/mf_scheme_plans/cybrillapoa/${s.isin}?expand=mf_scheme,mf_fund`, undefined, { quiet: true });
    if (v2.status !== 200 || v2.json?.active === false) { console.log('-', s.isin, s.name, `(HTTP ${v2.status}, not tradable)`); continue; }
    const r = rulesFrom(v2.json.thresholds);
    schemes[s.isin] = r;
    console.log('+', s.isin, s.name.slice(0, 45), 'lump', r.lumpsum.allowed ? r.lumpsum.min : '-', 'SIP', r.sip.find((x) => x.frequency === 'monthly')?.min ?? '-',
      'STP', r.stp ? `${r.stp.out ? 'out' : ''}${r.stp.in ? ' in' : ''} ${r.stp.min}` : '-', 'SWP', r.swp?.min ?? '-');
  }
  const file = path.join(ROOT, 'data', 'catalog-rules.production.json');
  fs.writeFileSync(file, JSON.stringify({ tenant: config.fp.tenant, generated_at: new Date().toISOString(), source: 'GET /v2/mf_scheme_plans/cybrillapoa/:isin', schemes }, null, 1));
  console.log(`\n${Object.keys(schemes).length}/${cat.schemes.length} schemes -> ${file}`);
}
