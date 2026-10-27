// Every route of the API. Each feature file maps paths to middleware (auth, rate limits, validation) and a controller.
import { Router } from 'express';
import system from './system.routes.ts';
import auth from './auth.routes.ts';
import otp from './otp.routes.ts';
import onboarding from './onboarding.routes.ts';
import funds from './funds.routes.ts';
import orders from './orders.routes.ts';
import sip from './sip.routes.ts';
import plans from './plans.routes.ts';
import cart from './cart.routes.ts';
import reports from './reports.routes.ts';
import settings from './settings.routes.ts';
import assistant from './assistant.routes.ts';
import external from './external.routes.ts';
import admin from './admin.routes.ts';

export const routes = Router();
for (const r of [system, auth, otp, onboarding, funds, orders, sip, plans, cart, reports, settings, assistant, external, admin]) routes.use(r);
