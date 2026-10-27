// Sessions are opaque random tokens. Only their SHA-256 is stored, and a session ends after SESSION_IDLE_DAYS without
// use or SESSION_MAX_DAYS in total (the investor then signs in again with an email OTP).
import { and, desc, eq, getTableColumns, isNull, lt, not, or, sql } from 'drizzle-orm';
import { intId, orm } from '../connection.ts';
import { sessions, users } from '../schema.ts';
import { config } from '../../config/env.ts';
import { randomToken, sha256Hex } from '../../utils/crypto.ts';
import type { SessionRow, User } from '../../types/domain.ts';

export interface DeviceInfo { device: string | null; os: string | null; ip: string | null }

/** Not idle for too long, and not too old. */
const live = () => and(
  sql`COALESCE(${sessions.last_seen}, ${sessions.created_at}) > now() - make_interval(days => ${config.session.idleDays}::int)`,
  sql`${sessions.created_at} > now() - make_interval(days => ${config.session.maxDays}::int)`,
)!;

const ROW = {
  id: sessions.id, token_hash: sessions.token_hash, device: sessions.device, os: sessions.os, ip: sessions.ip,
  created_at: sessions.created_at, last_seen: sessions.last_seen,
};
const lastActive = sql`COALESCE(${sessions.last_seen}, ${sessions.created_at})`;

export const sessionsRepo = {
  /** Starts a session; returns the token (the only time it exists in clear). */
  create: async (userId: number, d: DeviceInfo): Promise<string> => {
    const token = randomToken(24);
    await orm.insert(sessions).values({ token_hash: sha256Hex(token), user_id: userId, device: d.device, os: d.os, ip: d.ip, last_seen: sql`now()` });
    return token;
  },

  /** The signed-in user for a token, or null when it is unknown or expired. */
  user: async (token: string): Promise<User | null> => (await orm.select(getTableColumns(users)).from(sessions)
    .innerJoin(users, eq(users.id, sessions.user_id))
    .where(and(eq(sessions.token_hash, sha256Hex(token)), live())))[0] ?? null,

  /** Records activity (at most once a minute per session) and the latest device details. */
  touch: (token: string, d: DeviceInfo) => orm.update(sessions)
    .set({
      last_seen: sql`now()`,
      device: sql`COALESCE(${d.device}, ${sessions.device})`,
      os: sql`COALESCE(${d.os}, ${sessions.os})`,
      ip: sql`COALESCE(${d.ip}, ${sessions.ip})`,
    })
    .where(and(eq(sessions.token_hash, sha256Hex(token)), or(isNull(sessions.last_seen), lt(sessions.last_seen, sql`now() - interval '1 minute'`)))),

  /** Live sessions, newest activity first. */
  forUser: (userId: number) => orm.select(ROW).from(sessions)
    .where(and(eq(sessions.user_id, userId), live()))
    .orderBy(desc(lastActive), desc(sessions.id)) as Promise<SessionRow[]>,

  /** Every session (security alerts list sign-ins, including ones since ended). */
  recentForUser: (userId: number) => orm.select(ROW).from(sessions)
    .where(eq(sessions.user_id, userId))
    .orderBy(desc(sessions.created_at), desc(sessions.id)) as Promise<SessionRow[]>,

  isToken: (row: SessionRow, token: string) => row.token_hash === sha256Hex(token),

  drop: (token: string) => orm.delete(sessions).where(eq(sessions.token_hash, sha256Hex(token))),
  /** Ends one of the user's sessions; returns how many were ended (0 or 1). */
  dropById: async (userId: number, id: unknown) => {
    const n = intId(id);
    if (!n) return 0;
    return (await orm.delete(sessions).where(and(eq(sessions.user_id, userId), eq(sessions.id, n))).returning({ id: sessions.id })).length;
  },
  /** Ends every other session of the user; returns how many. */
  dropOthers: async (userId: number, keepToken: string) => (await orm.delete(sessions)
    .where(and(eq(sessions.user_id, userId), sql`${sessions.token_hash} IS DISTINCT FROM ${sha256Hex(keepToken)}`))
    .returning({ id: sessions.id })).length,
  dropAll: (userId: number) => orm.delete(sessions).where(eq(sessions.user_id, userId)),

  /** Deletes sessions past their idle or total lifetime; returns how many. */
  purgeExpired: async () => (await orm.delete(sessions).where(not(live())).returning({ id: sessions.id })).length,
};
