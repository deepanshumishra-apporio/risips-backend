// Orders and plans (one row each, keyed by FP's id). `data` keeps the last FP object plus our extras.
import { and, count, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { orm, removeKeys } from '../connection.ts';
import { orders } from '../schema.ts';
import type { Order, OrderInput, OrderKind } from '../../types/domain.ts';

const newestFirst = [desc(orders.created_at), desc(orders.seq)];
/** The created date in UTC, for date filters. */
const createdDay = sql`(${orders.created_at} AT TIME ZONE 'UTC')::date`;

// The row type with the stored state (never null for rows we write) as the domain type says.
const asOrders = (rows: (typeof orders.$inferSelect)[]) => rows as Order[];

export const ordersRepo = {
  /** Inserts or updates an order; `data` is merged into the stored data in the same statement. */
  upsert: async ({ id, user_id, kind, isin, isin_to = null, amount, state, data }: OrderInput): Promise<Order> => {
    const patch = data || {};
    const [row] = await orm.insert(orders)
      .values({ id, user_id, kind, isin, isin_to, amount, state, data: patch })
      .onConflictDoUpdate({
        target: orders.id,
        set: {
          state: sql`excluded.state`,
          amount: sql`excluded.amount`,
          data: sql`(${orders.data} || excluded.data) - ${removeKeys(patch)}`,
          updated_at: sql`now()`,
        },
      })
      .returning();
    return row as Order;
  },

  get: async (id: string): Promise<Order | null> => asOrders(await orm.select().from(orders).where(eq(orders.id, id)))[0] ?? null,

  forUser: async (userId: number, kind?: OrderKind | null): Promise<Order[]> => asOrders(await orm.select().from(orders)
    .where(and(eq(orders.user_id, userId), kind ? eq(orders.kind, kind) : undefined))
    .orderBy(...newestFirst)),

  /** Running SIPs created in the last few days (the first-payment sweep). */
  recentRunningSipIds: async () => (await orm.select({ id: orders.id }).from(orders)
    .where(and(eq(orders.kind, 'sip'), inArray(orders.state, ['active', 'confirmed']), sql`${orders.created_at} > now() - interval '4 days'`)))
    .map((r) => r.id),

  // ---------- Admin API ----------

  /** Order and plan counts per user and kind. */
  countsByUserKind: () => orm.select({ user_id: orders.user_id, kind: orders.kind, n: count() }).from(orders)
    .groupBy(orders.user_id, orders.kind),

  /** Count and amount per kind and state. */
  totalsByKindState: () => orm.select({
    kind: orders.kind,
    state: sql<string>`${orders.state}`,
    n: count(),
    amt: sql<number | null>`SUM(${orders.amount})`.mapWith(Number),
  }).from(orders).groupBy(orders.kind, orders.state),

  /** Filtered page across investors, newest first; dates are the created date in UTC (YYYY-MM-DD). */
  search: async (f: { kind?: string; state?: string; user_id?: number; from?: string; to?: string }, limit: number, offset: number) => {
    const conds: (SQL | undefined)[] = [
      f.kind ? eq(orders.kind, f.kind as OrderKind) : undefined,
      f.state ? eq(orders.state, f.state) : undefined,
      f.user_id ? eq(orders.user_id, f.user_id) : undefined,
      f.from ? gte(createdDay, sql`${f.from}::date`) : undefined,
      f.to ? lte(createdDay, sql`${f.to}::date`) : undefined,
    ];
    const where = and(...conds);
    const [{ n: total }] = await orm.select({ n: count() }).from(orders).where(where);
    const rows = asOrders(await orm.select().from(orders).where(where).orderBy(...newestFirst).limit(limit).offset(offset));
    return { total, rows };
  },
};
