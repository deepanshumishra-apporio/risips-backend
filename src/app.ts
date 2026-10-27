// The Express app: security headers, request ids and logging, body limits, rate limits, routes, errors.
// server.ts starts it; tests import it directly.
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config/env.ts';
import { jsonBody } from './middleware/bodyParser.ts';
import { errorHandler, notFound } from './middleware/errorHandler.ts';
import { limits } from './middleware/rateLimit.ts';
import { requestContext } from './middleware/requestContext.ts';
import { securityHeaders } from './middleware/security.ts';
import { routes } from './routes/index.ts';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // req.ip is the client's address only when this matches the proxies in front (rate limits and FP's user_ip use it)
  app.set('trust proxy', config.trustProxy);
  app.set('query parser', 'simple'); // no nested objects from ?a[b]=c

  app.use(requestContext);
  app.use(securityHeaders);
  app.use((req: Request, res: Response, next: NextFunction) => (req.path.startsWith('/fp/webhook/') || /^\/admin\/v1(\/|$)/.test(req.path) || req.path === '/health' ? next() : limits.global(req, res, next)));
  app.use(jsonBody);

  app.use(routes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
