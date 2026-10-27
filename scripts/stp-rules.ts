// Adds STP, SWP and switch-in rules to data/catalog.json without rebuilding it (build-catalog.ts also sets them).
// FP validates switch plans against the OMS master's stp_frequency_specific_data, on BOTH legs:
// a scheme with {} there rejects STP ("frequency not supported") even when cybrillapoa lists stp_in/stp_out.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config } from '../src/config/env.ts';
import { fp } from '../src/integrations/fp.client.ts';
import type { PlanRule, Scheme, StpRule } from '../src/types/catalog.ts';
import type { JsonObject } from '../src/types/domain.ts';

/** OMS fund_scheme -> catalog `stp` field (monthly only: ONDC switch plans support monthly). */
export function stpRules(s: JsonObject): StpRule | null {
  const m = s.stp_frequency_specific_data?.monthly;
  if (!m || (!s.stp_in_allowed && !s.stp_out_allowed)) return null;
  return {
    in: !!s.stp_in_allowed, out: !!s.stp_out_allowed, frequency: 'monthly',
    min: m.min_installment_amount, multiples: m.amount_multiples, installments_min: m.min_installments, dates: m.dates,
  };
}

/** OMS fund_scheme -> catalog `swp` field. FP answers `frequency "not allowed"` when monthly data is {}
 *  (Nifty50 Value 20 Growth), even though swp_allowed is true. */
export function swpRules(s: JsonObject): PlanRule | null {
  const m = s.swp_frequency_specific_data?.monthly;
  if (!m || !s.swp_allowed) return null;
  return { frequency: 'monthly', min: m.min_installment_amount, multiples: m.amount_multiples, installments_min: m.min_installments, dates: m.dates };
}

/** cybrillapoa switch_in threshold -> catalog `switch_in` field. FP rejects smaller switches with
 *  "amount is less than the min switch in amount" (Flexi Cap ₹500, Nifty50 Value 20 ₹100; verified 2026-09-25). */
export function switchInRule(t: JsonObject | undefined): Scheme['switch_in'] {
  return t ? { min: t.amount_min, multiples: t.amount_multiples } : null;
}

if (process.argv[1]?.endsWith('stp-rules.ts')) {
  // production's OMS master is empty, so this would clear every STP/SWP rule; production uses scripts/prod-rules.ts
  if (config.production) throw new Error('stp-rules runs on the sandbox only (unset FP_ENV)');
  const file = path.join(ROOT, 'data', 'catalog.json');
  const cat: { schemes: Scheme[] } = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const s of cat.schemes) {
    const oms = await fp.get(`/api/oms/fund_schemes/${s.isin}`, { quiet: true });
    s.stp = stpRules(oms);
    s.swp = swpRules(oms);
    const v2 = await fp.get(`/v2/mf_scheme_plans/cybrillapoa/${s.isin}?expand=mf_scheme,mf_fund`, { quiet: true });
    s.switch_in = switchInRule((v2.thresholds || []).find((t: JsonObject) => t.type === 'switch_in'));
    console.log(s.isin, s.name, 'STP', s.stp ? `min ${s.stp.min} x${s.stp.installments_min}` : '-', 'SWP', s.swp ? `min ${s.swp.min} x${s.swp.installments_min}` : '-', 'switch-in min', s.switch_in?.min ?? '-');
  }
  fs.writeFileSync(file, JSON.stringify(cat));
}
