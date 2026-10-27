// Small tables: cart checkouts, the watchlist, imported external holdings, and the MF Central sandbox's requests.
import { and, eq, sql } from 'drizzle-orm';
import { orm } from '../connection.ts';
import { checkouts, extImports, mfcSandbox, watchlist } from '../schema.ts';
import { randomHex } from '../../utils/crypto.ts';
import type { Checkout, CheckoutData } from '../../types/domain.ts';

export const checkoutsRepo = {
  create: async (userId: number, data: CheckoutData): Promise<Checkout> =>
    (await orm.insert(checkouts).values({ id: `chk_${randomHex(8)}`, user_id: userId, data }).returning())[0],
  get: async (id: string): Promise<Checkout | null> => (await orm.select().from(checkouts).where(eq(checkouts.id, id)))[0] ?? null,
  save: (id: string, data: CheckoutData) => orm.update(checkouts).set({ data }).where(eq(checkouts.id, id)),
};

export const watchlistRepo = {
  list: async (userId: number) => (await orm.select({ isin: watchlist.isin }).from(watchlist).where(eq(watchlist.user_id, userId))).map((r) => r.isin),
  /** Adds or removes the fund; returns whether it is now watchlisted. */
  toggle: async (userId: number, isin: string) => {
    const removed = await orm.delete(watchlist).where(and(eq(watchlist.user_id, userId), eq(watchlist.isin, isin))).returning({ isin: watchlist.isin });
    if (removed.length) return false;
    await orm.insert(watchlist).values({ user_id: userId, isin }).onConflictDoNothing();
    return true;
  },
};

/** One stored statement per user: { source, as_of, imported_at, investor, holdings: [...], transactions: [...] }. */
export const extImportsRepo = {
  get: async <T>(userId: number): Promise<(T & { updated_at: string }) | null> => {
    const [r] = await orm.select({ data: extImports.data, updated_at: extImports.updated_at }).from(extImports).where(eq(extImports.user_id, userId));
    return r ? { ...(r.data as T), updated_at: r.updated_at } : null;
  },
  save: (userId: number, data: unknown) => orm.insert(extImports).values({ user_id: userId, data })
    .onConflictDoUpdate({ target: extImports.user_id, set: { data: sql`excluded.data`, updated_at: sql`now()` } }),
  drop: (userId: number) => orm.delete(extImports).where(eq(extImports.user_id, userId)),
};

export const mfcSandboxRepo = {
  get: async <T>(token: string): Promise<T | null> =>
    ((await orm.select({ data: mfcSandbox.data }).from(mfcSandbox).where(eq(mfcSandbox.token, String(token))))[0]?.data as T | undefined) ?? null,
  put: (token: string, data: unknown) => orm.insert(mfcSandbox).values({ token, data })
    .onConflictDoUpdate({ target: mfcSandbox.token, set: { data: sql`excluded.data` } }),
  byReq: async <T>(reqId: unknown): Promise<(T & { token: string }) | null> => {
    const [r] = await orm.select({ token: mfcSandbox.token, data: mfcSandbox.data }).from(mfcSandbox)
      .where(sql`${mfcSandbox.data}->>'reqId' = ${String(reqId)}`);
    return r ? { token: r.token, ...(r.data as T) } : null;
  },
};
