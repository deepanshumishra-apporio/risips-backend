// NSE's market-holiday calendar (MF segment). NSE answers without cookies when sent browser-like headers (checked
// 2026-09-25). Fetched at most once a day; src/content/market-holidays.json is the fallback.
import { readContent } from '../services/content.service.ts';
import { errMsg, log } from '../utils/logger.ts';
import type { JsonObject } from '../types/domain.ts';

export interface Holiday { date: string; name: string }

const MON: Record<string, number> = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
let cache: { at: number; list: Holiday[] | null } = { at: 0, list: null };

async function fetchNse(): Promise<Holiday[]> {
  const res = await fetch('https://www.nseindia.com/api/holiday-master?type=trading', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      Accept: 'application/json', 'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://www.nseindia.com/resources/exchange-communication-holidays',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`NSE ${res.status}`);
  const j = await res.json() as JsonObject;
  const rows = j.MF?.length ? j.MF : j.CM;
  if (!rows?.length) throw new Error('NSE: no MF/CM holidays');
  return rows.map((x: JsonObject) => {
    const [d, m, y] = x.tradingDate.split('-');
    return { date: `${y}-${String(MON[m]).padStart(2, '0')}-${d.padStart(2, '0')}`, name: x.description.replace(/\*$/, '').trim() };
  });
}

export async function holidays(): Promise<Holiday[]> {
  if (cache.list && Date.now() - cache.at < 24 * 3600e3) return cache.list;
  let list: Holiday[];
  try {
    list = await fetchNse();
  } catch (e) {
    log.warn('NSE holiday fetch failed, using src/content/market-holidays.json', { err: errMsg(e) });
    list = readContent('market-holidays.json').holidays;
    // retry NSE in an hour rather than a day
    cache = { at: Date.now() - 23 * 3600e3, list };
    return list;
  }
  cache = { at: Date.now(), list };
  return list;
}
