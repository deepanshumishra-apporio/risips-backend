// Entry point: starts the HTTP server and the background jobs, and shuts both down cleanly on SIGTERM / SIGINT
// (deploys and restarts), letting in-flight requests finish first.
import { createApp } from './app.ts';
import { config, STATE_DIR } from './config/env.ts';
import { db } from './db/connection.ts';
import { startJobs, stopJobs } from './jobs/scheduler.ts';
import { errMsg, log } from './utils/logger.ts';

const app = createApp();
const server = app.listen(config.port, '0.0.0.0', () => {
  log.info(`Risips backend on http://localhost:${config.port}`, { public_url: config.publicUrl, fp: config.fpEnv, demo: config.demoMode, state: STATE_DIR });
});
// FP calls can take ~45 s (order review polling); keep sockets open a little longer than that
server.requestTimeout = 120e3;
server.headersTimeout = 65e3;
server.keepAliveTimeout = 61e3;

startJobs();

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info(`${signal}: shutting down`);
  stopJobs();
  server.close(() => {
    db.close().catch((e) => log.error('Closing the database failed', { err: errMsg(e) })).finally(() => process.exit(0));
  });
  // don't wait forever on a hung request
  setTimeout(() => process.exit(1), 30e3).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => log.error('Unhandled promise rejection', { err: errMsg(e) }));
