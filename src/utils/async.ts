export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll fn() until pred(value) or timeout; returns the last value. */
export async function poll<T>(fn: () => Promise<T>, pred: (v: T) => boolean, { every = 2500, max = 60000 } = {}): Promise<T> {
  const t0 = Date.now();
  let v: T;
  for (;;) {
    v = await fn();
    if (pred(v) || Date.now() - t0 > max) return v;
    await sleep(every);
  }
}
