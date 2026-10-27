// Test harness: a fresh state folder and a sandbox config per test file (node --test runs each file in its own
// process, and config is read once at import), then the app on a random port.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

export interface TestServer {
  base: string;
  stateDir: string;
  close: () => Promise<void>;
  call: (method: string, p: string, body?: unknown, token?: string | null, headers?: Record<string, string>) => Promise<{ status: number; json: Record<string, unknown> | null; headers: Headers; text: string }>;
}

export async function startServer(env: Record<string, string> = {}): Promise<TestServer> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'risips-test-'));
  Object.assign(process.env, {
    RISIPS_ENV: path.join(stateDir, 'no.env'),
    RISIPS_STATE_DIR: stateDir,
    FP_SANDBOX_CLIENT_ID: 'x', FP_SANDBOX_CLIENT_SECRET: 'x', FP_PV_SANDBOX_CLIENT_ID: 'x', FP_PV_SANDBOX_CLIENT_SECRET: 'x',
    FP_SANDBOX_BASE_URL: 'http://127.0.0.1:9', FP_PV_SANDBOX_BASE_URL: 'http://127.0.0.1:9',
    LOG_LEVEL: 'error',
    ...env,
  });
  const { createApp } = await import('../src/app.ts');
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    stateDir,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await (await import('../src/db/connection.ts')).db.close(); // releases the embedded Postgres and its lock
    },
    async call(method, p, body, token, headers = {}) {
      const r = await fetch(base + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
      const text = await r.text();
      let json: Record<string, unknown> | null = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: r.status, json, headers: r.headers, text };
    },
  };
}

/** The app's database (embedded Postgres in the test's state folder; only after startServer()). */
export const testDb = async () => (await import('../src/db/connection.ts')).db;

/** Signs up a fresh user through email OTP (demo mode returns the code) and returns the session token. */
export async function signUp(t: TestServer, email = `t${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`) {
  const start = await t.call('POST', '/auth/email/start', { email });
  const verify = await t.call('POST', '/auth/email/verify', { email, code: start.json!.dev_otp });
  return { token: verify.json!.token as string, user: verify.json!.user as Record<string, unknown>, email };
}

/** A real (tiny) PNG as a data URL, padded past the 500-byte minimum with an ancillary chunk. */
export function pngDataUrl() {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return `data:image/png;base64,${Buffer.concat([sig, Buffer.alloc(600, 7)]).toString('base64')}`;
}
