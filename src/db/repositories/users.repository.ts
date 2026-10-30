import { desc, eq, sql } from 'drizzle-orm';
import { intId, orm, removeKeys } from '../connection.ts';
import { extImports, sessions, users, watchlist } from '../schema.ts';
import type { Orm } from '../connection.ts';
import type { User, UserData } from '../../types/domain.ts';

/** data = (data || patch) - keys set to undefined in the patch: one statement, so merges of different keys both land. */
const mergeInto = (q: Orm, id: number, patch: Partial<UserData>) => q.update(users)
  .set({ data: sql`(${users.data} || ${JSON.stringify(patch)}::jsonb) - ${removeKeys(patch)}` })
  .where(eq(users.id, id))
  .returning();

const first = <T>(rows: T[]): T | null => rows[0] ?? null;

export const usersRepo = {
  byId: async (id: unknown): Promise<User | null> => {
    const n = intId(id);
    return n ? first(await orm.select().from(users).where(eq(users.id, n))) : null;
  },
  byEmail: async (email: string): Promise<User | null> => first(await orm.select().from(users).where(eq(users.email, email))),
  create: async (email: string): Promise<User> => (await orm.insert(users).values({ email }).returning())[0],

  /** Another live account that has verified this mobile (an erased account keeps its number but doesn't count). */
  mobileTakenBy: async (mobile: string, exceptId: number): Promise<number | null> => first(await orm.select({ id: users.id }).from(users)
    .where(sql`${users.mobile} = ${mobile} AND ${users.id} <> ${exceptId} AND coalesce(${users.data}->'deletion'->>'status', '') <> 'deleted'`))?.id ?? null,

  setMobile: (id: number, mobile: string) => orm.update(users).set({ mobile }).where(eq(users.id, id)),
  setPinHash: (id: number, pinHash: string) => orm.update(users).set({ pin_hash: pinHash }).where(eq(users.id, id)),

  /** Shallow-merge into the JSON data in one statement; keys set to undefined are removed. Returns the updated user. */
  merge: async (id: number, patch: Partial<UserData>): Promise<User> => (await mergeInto(orm, id, patch))[0],

  /**
   * Read-modify-write of the JSON data with the row locked, for a patch built from the current value (a list or a nested
   * object): fn(data) returns the patch to merge, or throws to change nothing. fn must not query the database.
   * Returns the updated user, or null when there is no such user.
   */
  update: (id: number, fn: (data: UserData) => Partial<UserData>): Promise<User | null> => orm.transaction(async (tx) => {
    const row = first(await tx.select({ data: users.data }).from(users).where(eq(users.id, id)).for('update'));
    if (!row) return null;
    return first(await mergeInto(tx, id, fn(row.data)));
  }),

  /** Accounts whose 30-day deletion window has passed. */
  dueForPurge: async (nowIso: string) => (await orm.select({ id: users.id }).from(users)
    .where(sql`${users.data}->'deletion'->>'status' = 'requested' AND ${users.data}->'deletion'->>'purge_after' <= ${nowIso}`))
    .map((r) => r.id),

  /**
   * Erases one account if its deletion is still requested (a sign-in since cancels it), under the row lock: the login
   * (email freed, PIN), the given keys of the data, the watchlist, imported holdings and sessions. Returns when the
   * deletion was requested, or null when nothing was erased.
   */
  purge: (id: number, erase: string[], nowIso: string) => orm.transaction(async (tx) => {
    const u = first(await tx.select({ data: users.data }).from(users).where(eq(users.id, id)).for('update'));
    if (u?.data.deletion?.status !== 'requested') return null;
    const data: UserData = { ...u.data };
    for (const k of erase) delete data[k];
    data.deletion = { ...u.data.deletion, status: 'deleted', deleted_at: nowIso };
    await tx.update(users).set({ email: null, pin_hash: null, data }).where(eq(users.id, id));
    await tx.delete(watchlist).where(eq(watchlist.user_id, id));
    await tx.delete(extImports).where(eq(extImports.user_id, id));
    await tx.delete(sessions).where(eq(sessions.user_id, id));
    return u.data.deletion.requested_at ?? null;
  }),

  /** Users with an MF Central import waiting on the statement. */
  importingIds: async () => (await orm.select({ id: users.id }).from(users)
    .where(sql`${users.data}->'ext'->>'status' = 'importing'`)).map((x) => x.id),

  /** Users whose fresh KYC is with the KRA and not yet approved (kyc.service.ts sweepPendingKyc). */
  pendingKycIds: async () => (await orm.select({ id: users.id }).from(users)
    .where(sql`${users.data}->'kyc_form'->>'status' = 'submitted' AND ${users.data}->>'kyc_approved_at' IS NULL`)).map((x) => x.id),

  /** Every user, newest first (Admin API). */
  all: (): Promise<User[]> => orm.select().from(users).orderBy(desc(users.id)),
};
