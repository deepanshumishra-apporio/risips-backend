// Domain types: users, orders, plans, consents. Type-only: Node strips this file to nothing at runtime.
import type { StoredFp } from '../integrations/fp.schemas.ts';

/**
 * JSON from a FintechPrimitives endpoint without a model (onboarding, reports, pre-verification) and from the other
 * partner APIs: loose, read defensively (`?.`, `||`). Orders, plans, payments and mandates have models
 * (integrations/fp.schemas.ts).
 */
 
export type FpObject = Record<string, any>;

/** Order kinds stored in the `orders` table (one-time orders and the three plan types). */
export type OrderKind = 'purchase' | 'redemption' | 'switch' | 'sip' | 'stp' | 'swp';

/** FP pre-verification check result ({ status: 'verified' | 'failed' | …, code }). */
export interface PvCheck { status?: string; code?: string | null; [k: string]: unknown }
export interface PanChecks { readiness?: PvCheck; pan?: PvCheck; name?: PvCheck; date_of_birth?: PvCheck }

/** Parsed JSON whose shape isn't modelled (content files, third-party replies). */
 
export type JsonObject = Record<string, any>;

/** The OTP approval kept with an order or profile change (txnotp.ts requireTxnOtp). */
export interface TxnConsent { at: string; action: string; via: string; mobile: string | null; email: string | null; opted_out?: boolean }

export interface Address { line1: string; line2?: string | null; pincode: string; city?: string | null; state?: string | null; [k: string]: unknown }

export interface BankDetails {
  account_number: string; ifsc: string; bank_name?: string; branch?: string; city?: string;
  pv_id?: string; status?: string; code?: string | null; verified?: boolean;
}

export interface Nominee { name: string; dob: string; relationship: string; pan: string }

/** FP identifiers created at eSign (onboarding.ts). */
export interface FpIds {
  invp?: string; phone?: string; email?: string; addr?: string; bank?: string; bank_old_id?: number;
  relp?: string; mfia?: string; mfia_old_id?: number; [k: string]: unknown;
}

export interface Mandate {
  id: string | number; status?: string | null; type?: string | null; limit?: number | null; umrn?: string | null; valid_from?: string | null;
  valid_to?: string | null; created_at?: string | null; bank_account_id?: number | null; auth_url?: string; [k: string]: unknown;
}

export interface Deletion {
  status: 'requested' | 'cancelled' | 'deleted'; reason?: string | null; requested_at?: string; purge_after?: string;
  cancelled_at?: string; deleted_at?: string; consent?: TxnConsent;
}

export interface CartLine { id: string; isin: string; mode: 'sip' | 'lumpsum'; amount: number; added_at?: string }

export interface Callback { id: string; at: string; status: string; topic: string }

/** An MF Central import in progress (routes/external.ts). */
export interface ExtRequest {
  provider: string; client_ref: string; req_id: string | null; started_at: number; sent_to: string | null; journey_url: string;
  qr_at?: number; extent?: string | null; done_at?: number;
}

/** users.data.ext: the MF Central import state (routes/external.ts). */
export interface ExtState {
  status?: 'none' | 'otp_sent' | 'importing' | 'ready' | 'failed'; hidden?: boolean; pan?: string; error?: string | null;
  request?: ExtRequest | null; consent?: Record<string, unknown>;
}

/** Everything kept in the users.data JSON column. */
export interface UserData {
  email_verified?: boolean;
  mobile_verified?: boolean;
  bank_consent?: boolean;
  pin_set?: boolean;
  pin_fails?: number;
  pin_changed_at?: string;
  biometric?: boolean;
  pan?: string;
  name?: string;
  dob?: string;
  pan_verified?: boolean;
  pan_confirmed?: boolean;
  pan_pv_id?: string;
  pan_checks?: PanChecks;
  pan_attempt?: { pan: string; pv_id: string; checks: PanChecks };
  occupation?: string;
  income_slab?: string;
  marital_status?: string;
  father_name?: string;
  gender?: string;
  address?: Address;
  aadhaar_pending?: string;
  aadhaar_verified?: boolean;
  aadhaar_verified_at?: string;
  aadhaar_last4?: string;
  bank?: BankDetails;
  bank_attempt?: BankDetails;
  selfie?: string;
  selfie_at?: string;
  signature?: string;
  signature_at?: string;
  fatca_declared?: boolean;
  running_account_auth?: boolean;
  nominee?: Nominee | null;
  nominee_skipped?: boolean;
  nominee_consent?: TxnConsent;
  /** When a nominee was added after onboarding (Profile > Nominee). */
  nominee_added_at?: string;
  /** A nominee whose related party exists at FP but isn't on the account yet (a retry reuses it). */
  nominee_pending?: Nominee & { relp: string };
  esign_consent_at?: string;
  onboarded_at?: string;
  fp?: FpIds;
  mandate?: Mandate;
  cart?: CartLine[];
  callbacks?: Callback[];
  notify_prefs?: Record<string, boolean>;
  notif_read?: string[];
  modals_seen?: string[];
  deletion?: Deletion;
  ext?: ExtState;
  [k: string]: unknown;
}

/** A row of the users table, with `data` parsed. */
export interface User {
  id: number;
  email: string | null;
  mobile: string | null;
  pin_hash: string | null;
  data: UserData;
  created_at: string;
}

/** A plan instalment as stored on the plan (routes/sip.ts refreshPlan). */
export interface Instalment {
  id: string; old_id?: number | null; state: string; amount?: number | null; scheduled_on?: string | null; traded_on?: string | null;
  units?: number | null; nav?: number | null; folio?: string | null; failure_code?: string | null; [k: string]: unknown;
}

/** A pause (FP skip instruction) as stored on a plan (routes/sip.ts skipView). */
export interface Skip { id: string; state: string; from: string; to: string; remaining: number; skipped: number }

/** A purchase's checkout payment as kept on the order (FP payment id and its last status). */
export interface PaymentRef { id: number; status?: string | null; reference?: string | null }

/** A SIP's up-front first-instalment payment: a UPI checkout or a NACH debit on the mandate. */
export interface FirstPayment {
  /** None when FP refused the debit (`failed` then says why). */
  id?: number; status?: string | null; method?: string; order_old_id?: number | null; failed?: string; [k: string]: unknown;
}

/** orders.data: the last FP object plus our own extras. */
export interface OrderData {
  fp?: StoredFp;
  payment?: PaymentRef;
  token_url?: string;
  batch_payment?: string | number;
  amc_id?: number;
  twofa?: TxnConsent;
  cancel_twofa?: TxnConsent;
  pause_twofa?: TxnConsent;
  resume_twofa?: TxnConsent;
  checkout?: string;
  installments?: Instalment[];
  skips?: Skip[];
  start_skip?: { id: string; from: string; to: string };
  first_payment?: FirstPayment;
  first_payment_failed?: boolean;
  replaced_by?: string;
  replaces?: string;
  cancellation_code?: string;
  paused_at?: string;
  resumed_at?: string;
  until_stopped?: boolean;
  start_offset?: number;
  [k: string]: unknown;
}

/** A row of the orders table, with `data` parsed. */
export interface Order {
  id: string;
  user_id: number;
  kind: OrderKind;
  isin: string | null;
  isin_to: string | null;
  amount: number | null;
  /** FP's state, copied on every upsert. */
  state: string;
  data: OrderData;
  created_at: string;
  updated_at: string;
  /** Open all-units redemption / switch: units held x latest NAV, set by withEstimates() for view(). Not stored. */
  estimate?: number | null;
}

/** orders.upsert input: a new or refreshed order; `data` is merged into what is stored. */
export interface OrderInput {
  id: string; user_id: number; kind: OrderKind; isin: string | null; isin_to?: string | null; amount: number | null;
  state: string; data: OrderData;
}

/** Settings > Active devices row (id = rowid). `token_hash` is the SHA-256 of the session token. */
export interface SessionRow {
  id: number; token_hash: string; device: string | null; os: string | null; ip: string | null; created_at: string; last_seen: string | null;
}

/** One line of a cart checkout (services/cart.service.ts). */
export interface CheckoutItem {
  cart_id: string; isin: string; mode: 'sip' | 'lumpsum'; amount: number;
  state: 'queued' | 'placing' | 'placed' | 'failed' | 'skipped'; started_at?: string; order_id?: string; error?: string;
}
export interface CheckoutData { twofa?: TxnConsent; sip_day: number | null; items: CheckoutItem[] }
export interface Checkout { id: string; user_id: number; data: CheckoutData; created_at: string }
