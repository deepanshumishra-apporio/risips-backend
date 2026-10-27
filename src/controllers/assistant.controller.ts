import type { Request, Response } from 'express';
import { valid } from '../middleware/validate.ts';
import { assistantSchemas as s } from '../validation/assistant.validation.ts';
import * as assistant from '../services/assistant.service.ts';

export const welcome = async (req: Request, res: Response) => { res.json(assistant.welcome(req.user)); };

export async function ask(req: Request, res: Response) {
  const { action, text } = valid(req, s.ask).body;
  res.json(action === 'book_call' ? await assistant.bookCall(req.user) : await assistant.answer(req.user, text));
}
