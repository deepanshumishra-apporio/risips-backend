// The tables, for Drizzle's typed queries. migrations.ts creates them (the same schema as the JS backend, plus
// migration 2); test/schema.test.ts fails if this file and the migrated database ever disagree.
import { sql } from 'drizzle-orm';
import { bigint, customType, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core';
import type { CheckoutData, OrderData, OrderKind, UserData } from '../types/domain.ts';

/**
 * TIMESTAMPTZ, read as 'YYYY-MM-DD HH:MM:SS' in UTC: the format the app and the Admin API have always had. Both drivers
 * hand Drizzle the raw text ('2026-10-22 09:51:37.161+00'); it is parsed with its offset, so the session time zone
 * doesn't matter. Written by the database (now()) only.
 */
const utcTime = customType<{ data: string; driverData: string | Date }>({
  dataType: () => 'timestamp with time zone',
  fromDriver: (v) => {
    const d = v instanceof Date ? v : new Date(String(v).replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
    return Number.isNaN(d.getTime()) ? String(v).slice(0, 19) : d.toISOString().replace('T', ' ').slice(0, 19);
  },
});

export const users = pgTable('users', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  email: text('email').unique(),
  mobile: text('mobile'),
  pin_hash: text('pin_hash'),
  data: jsonb('data').$type<UserData>().notNull().default({}),
  created_at: utcTime('created_at').notNull().default(sql`now()`),
});

export const sessions = pgTable('sessions', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  /** The JS backend's plain token; always NULL here (migration 2 hashed it into token_hash). */
  token: text('token').unique(),
  token_hash: text('token_hash'),
  user_id: integer('user_id').notNull().references(() => users.id),
  device: text('device'),
  os: text('os'),
  ip: text('ip'),
  created_at: utcTime('created_at').notNull().default(sql`now()`),
  last_seen: utcTime('last_seen'),
}, (t) => [index('sessions_user').on(t.user_id), uniqueIndex('sessions_token_hash').on(t.token_hash)]);

export const otps = pgTable('otps', {
  purpose: text('purpose').notNull(),
  target: text('target').notNull(),
  /** The JS backend's plain code; always NULL here. */
  code: text('code'),
  code_hash: text('code_hash'),
  /** Epoch milliseconds. */
  expires_at: bigint('expires_at', { mode: 'number' }).notNull(),
  attempts: integer('attempts').notNull().default(0),
}, (t) => [primaryKey({ columns: [t.purpose, t.target] })]);

export const orders = pgTable('orders', {
  id: text('id').primaryKey(),
  user_id: integer('user_id').notNull().references(() => users.id),
  kind: text('kind').$type<OrderKind>().notNull(),
  isin: text('isin'),
  isin_to: text('isin_to'),
  amount: doublePrecision('amount'),
  state: text('state'),
  data: jsonb('data').$type<OrderData>().notNull().default({}),
  created_at: utcTime('created_at').notNull().default(sql`now()`),
  updated_at: utcTime('updated_at').notNull().default(sql`now()`),
  /** Insertion order: breaks created_at ties (two orders in the same instant). */
  seq: bigint('seq', { mode: 'number' }).generatedByDefaultAsIdentity().unique(),
}, (t) => [index('orders_user').on(t.user_id, t.created_at), index('orders_kind_state').on(t.kind, t.state)]);

export const checkouts = pgTable('checkouts', {
  id: text('id').primaryKey(),
  user_id: integer('user_id').notNull().references(() => users.id),
  data: jsonb('data').$type<CheckoutData>().notNull().default({} as CheckoutData),
  created_at: utcTime('created_at').notNull().default(sql`now()`),
});

export const watchlist = pgTable('watchlist', {
  user_id: integer('user_id').notNull().references(() => users.id),
  isin: text('isin').notNull(),
}, (t) => [primaryKey({ columns: [t.user_id, t.isin] })]);

export const extImports = pgTable('ext_imports', {
  user_id: integer('user_id').primaryKey().references(() => users.id),
  data: jsonb('data').notNull().default({}),
  updated_at: utcTime('updated_at').notNull().default(sql`now()`),
});

export const mfcSandbox = pgTable('mfc_sandbox', {
  token: text('token').primaryKey(),
  data: jsonb('data').notNull(),
  created_at: utcTime('created_at').notNull().default(sql`now()`),
});

export const meta = pgTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
