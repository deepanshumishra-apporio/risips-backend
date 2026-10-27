import type { Request, Response } from 'express';
import { valid } from '../middleware/validate.ts';
import { onboardingSchemas as s } from '../validation/onboarding.validation.ts';
import * as onb from '../services/onboarding.service.ts';
import { clientIp } from '../utils/request.ts';

export const verifyPan = async (req: Request, res: Response) => { res.json(await onb.verifyPan(req.user, valid(req, s.pan).body)); };
export const confirmPan = async (req: Request, res: Response) => { res.json(await onb.confirmPan(req.user)); };
export const resetPan = async (req: Request, res: Response) => { res.json(await onb.resetPan(req.user)); };
export const updateProfile = async (req: Request, res: Response) => { res.json(await onb.updateProfile(req.user, valid(req, s.profile).body)); };
export const pincode = async (req: Request, res: Response) => { res.json(await onb.pincodeLookup(valid(req, s.pincode).params.pin)); };
export const address = async (req: Request, res: Response) => { res.json(await onb.saveAddress(req.user, valid(req, s.address).body)); };
export const aadhaarStart = async (req: Request, res: Response) => { res.json(await onb.startAadhaar(req.user, valid(req, s.aadhaarStart).body.aadhaar)); };
export const aadhaarVerify = async (req: Request, res: Response) => { res.json(await onb.verifyAadhaar(req.user, valid(req, s.aadhaarVerify).body.code)); };
export const ifsc = async (req: Request, res: Response) => { res.json(await onb.ifscLookup(valid(req, s.ifsc).params.ifsc)); };
export const bank = async (req: Request, res: Response) => { res.json(await onb.verifyBank(req.user, valid(req, s.bank).body)); };
export const selfie = async (req: Request, res: Response) => { res.json(await onb.saveSelfie(req.user, valid(req, s.image).body.image)); };
export const signature = async (req: Request, res: Response) => { res.json(await onb.saveSignature(req.user, valid(req, s.image).body.image)); };
export const declarations = async (req: Request, res: Response) => { res.json(await onb.saveDeclarations(req.user, valid(req, s.declarations).body.running_account)); };
export const nominee = async (req: Request, res: Response) => { res.json(await onb.saveNominee(req.user, valid(req, s.nominee).body)); };
export const kycForm = async (req: Request, res: Response) => { res.json(onb.kycForm(req.user)); };

export async function esign(req: Request, res: Response) {
  valid(req, s.esign);
  res.json(await onb.esign(req.user, clientIp(req)));
}
