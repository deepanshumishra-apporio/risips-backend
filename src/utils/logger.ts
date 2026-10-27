// Minimal levelled logger: one JSON object per line in production (easy to ship to a log service), readable text
// otherwise. Never pass PAN, bank numbers, OTPs or tokens in `meta`.
import { config } from '../config/env.ts';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function write(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (ORDER[level] < ORDER[config.logLevel]) return;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  if (config.production) {
    out(JSON.stringify({ t: new Date().toISOString(), level, msg, ...meta }));
  } else {
    const extra = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    out(`${new Date().toISOString().slice(11, 19)} ${level === 'info' ? '' : `${level.toUpperCase()} `}${msg}${extra}`);
  }
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => write('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => write('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => write('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => write('error', msg, meta),
};

/** The message of anything thrown. */
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
