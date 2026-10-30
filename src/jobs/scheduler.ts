// Background jobs. Each runs on a timer inside the API process; a run is skipped while the previous one is still going,
// and a failure is logged without stopping the timer. With more than one server instance, run these in one instance
// only (or move them to a worker), or they run once per instance.
import { otpsRepo } from '../db/repositories/otps.repository.ts';
import { sessionsRepo } from '../db/repositories/sessions.repository.ts';
import { navIndex } from '../integrations/amfi.ts';
import { sweepImports } from '../services/external.service.ts';
import { sweepPendingKyc } from '../services/kyc.service.ts';
import { purgeDueDeletions } from '../services/settings.service.ts';
import { sweepFirstPayments } from '../services/sip.service.ts';
import { errMsg, log } from '../utils/logger.ts';

interface Job { name: string; everyMs: number; run: () => unknown }

const JOBS: Job[] = [
  // cancel SIPs whose first payment failed even when nobody opens the app (FP would debit the mandate otherwise)
  { name: 'sip-first-payments', everyMs: 10 * 60e3, run: sweepFirstPayments },
  // accounts whose 30-day deletion window has passed (Settings > Delete account)
  { name: 'account-purge', everyMs: 60 * 60e3, run: purgeDueDeletions },
  // imports waiting on MF Central to release the statement (it takes 10-15 min)
  { name: 'mfc-imports', everyMs: 60e3, run: sweepImports },
  // fresh KYCs waiting for the KRA: orders open once the PAN shows as compliant (checkKra throttles per investor)
  { name: 'kyc-approvals', everyMs: 30 * 60e3, run: sweepPendingKyc },
  // expired sessions and OTPs
  { name: 'session-cleanup', everyMs: 6 * 60 * 60e3, run: async () => ({ sessions: await sessionsRepo.purgeExpired(), otps: await otpsRepo.purgeExpired() }) },
];

const timers: NodeJS.Timeout[] = [];

export function startJobs() {
  for (const job of JOBS) {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await job.run();
      } catch (e) {
        log.error(`Job ${job.name} failed`, { err: errMsg(e) });
      } finally {
        running = false;
      }
    };
    timers.push(setInterval(tick, job.everyMs).unref());
  }
  // AMFI NAVs value imported (external) funds; load them once now so the first portfolio view doesn't wait
  navIndex().catch((e) => log.warn('AMFI warm-up failed', { err: errMsg(e) }));
}

export function stopJobs() {
  for (const t of timers.splice(0)) clearInterval(t);
}
