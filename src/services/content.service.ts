// Content files the client edits without a code change (src/content/*.json): promos, announcements, holiday fallback.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config/env.ts';
import type { JsonObject } from '../types/domain.ts';

const ALLOWED = new Set(['promos.json', 'announcements.json', 'market-holidays.json']);

export function readContent(file: string): JsonObject {
  if (!ALLOWED.has(file)) throw new Error(`Unknown content file ${file}`);
  return JSON.parse(fs.readFileSync(path.join(paths.content, file), 'utf8'));
}
