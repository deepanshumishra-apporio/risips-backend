// Local stand-in for MF Central while the client's MF Central partner credentials (MFC_*) are pending.
// It mirrors both halves of the real v2 flow so the app's code path is the same:
//   partner API   startRequest -> { reqId, redirectUrl }, submitQr, fetchDocument (null = 422 "in process")
//   hosted pages  /mfc-sandbox/journey/:token  OTP -> "what to share" -> QR, then the same WebView messages MF Central's
//                 page sends (window.ReactNativeWebView.postMessage {type:'mfc-cas-download'|'mfc-cas-complete'})
// The statement it returns is SAMPLE data (real schemes, made-up units), flagged `sample: true` and shown as such in
// the app. Only used when DEMO_MODE is on and MFC_* is not configured (services/external.service.ts).
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { mfcSandboxRepo } from '../db/repositories/misc.repository.ts';
import { ApiError } from '../utils/errors.ts';
import { navIndex } from './amfi.ts';
import type { NavRec } from './amfi.ts';

/** One sandbox import request, keyed by the journey token. */
interface SandboxReq {
  reqId: string; clientRefNo: string; pan: string; mobile?: string | null; email?: string | null; otp: string; tries: number;
  verified: boolean; qr: string | null; released_at: number | null; plan_type?: string; extent?: string; token?: string;
}

const store = {
  get: (t: string) => mfcSandboxRepo.get<SandboxReq>(t),
  put: (t: string, d: SandboxReq) => mfcSandboxRepo.put(t, d),
  byReq: (reqId: unknown) => mfcSandboxRepo.byReq<SandboxReq>(reqId),
};

const READY_AFTER_MS = 20e3; // MF Central takes minutes; 20 s keeps the demo moving but still exercises the polling

// ---------- partner API ----------

export async function startRequest({ clientRefNo, pan, mobile, email }: { clientRefNo: string; pan: string; mobile?: string | null; email?: string | null }, { publicUrl }: { publicUrl: string }) {
  const token = crypto.randomBytes(16).toString('hex');
  const reqId = String(crypto.randomInt(10_000_000, 99_999_999));
  const otp = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  await store.put(token, { reqId, clientRefNo, pan, mobile, email, otp, tries: 0, verified: false, qr: null, released_at: null });
  return { reqId, redirectUrl: `${publicUrl}/mfc-sandbox/journey/${token}`, otpRef: null };
}

export async function submitQr({ reqId, clientRefNo, qrCode }: { reqId: string | null; clientRefNo: string; qrCode: string }) {
  const s = await store.byReq(reqId);
  if (!s || s.clientRefNo !== clientRefNo) throw Object.assign(new Error('Unknown request'), { status: 404 });
  if (!s.qr || s.qr !== qrCode) throw Object.assign(new Error('Invalid QR code'), { status: 422 });
  if (!s.released_at) await store.put(s.token, { ...s, token: undefined, released_at: Date.now() });
  return { reqId, status: 'accepted' };
}

export async function fetchDocument({ reqId, clientRefNo }: { reqId: string | null; clientRefNo: string }) {
  const s = await store.byReq(reqId);
  if (!s || s.clientRefNo !== clientRefNo) throw Object.assign(new Error('Unknown request'), { status: 404 });
  if (!s.released_at || Date.now() - s.released_at < READY_AFTER_MS) return null;
  return sampleCas(s);
}

// Real schemes from five fund houses (one, ICICI Pru Flexi Cap, is also sold on Risips); units and gains are made up.
const SAMPLE = [
  { isin: 'INF879O01027', folio: '15938274', units: 412.553, gain: 0.31, plan: 'DIRECT' },
  { isin: 'INF179K01CR2', folio: '28173645/22', units: 61.204, gain: 0.18, plan: 'REGULAR' },
  { isin: 'INF200K01T28', folio: '39201846', units: 88.917, gain: -0.04, plan: 'REGULAR' },
  { isin: 'INF769K01AX2', folio: '79912030512', units: 120.66, gain: 0.12, plan: 'DIRECT' },
  { isin: 'INF109KC1Q80', folio: '6281937/41', units: 140.075, gain: 0.09, plan: 'REGULAR' },
];

async function sampleCas(s: SandboxReq) {
  const navs = await navIndex().catch(() => ({})) as Record<string, NavRec>;
  // m is the month as text; JS turns it into a number for the subtraction
  const fmt = (iso: string) => { const [y, m, d] = iso.split('-'); return `${d}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][(m as unknown as number) - 1]}-${y}`; };
  const schemes = SAMPLE.filter((x) => navs[x.isin]?.nav && (s.plan_type === 'BOTH' || !s.plan_type || x.plan === s.plan_type)).map((x) => {
    const a = navs[x.isin];
    const value = x.units * a.nav!;
    const cost = value / (1 + x.gain);
    return {
      amcName: a.amc, folio: x.folio, schemeCode: '', schemeName: a.name, schemeOption: a.option, assetType: a.category.toUpperCase(),
      schemeType: '', nav: a.nav, navDate: fmt(a.nav_date!), closingBalance: x.units, availableUnits: x.units, availableAmount: value,
      currentMktValue: value.toFixed(2), costValue: cost.toFixed(2), gainLoss: (value - cost).toFixed(2), gainLossPercentage: (x.gain * 100).toFixed(2),
      isin: x.isin, decimalUnits: 3, decimalAmount: 2, decimalNav: 4, isDemat: 'N', planMode: x.plan,
    };
  });
  return { reqId: s.reqId, pan: s.pan, mobile: s.mobile, email: s.email, sample: true, data: [{ portfolio: [], summary: [], schemes }] };
}

// ---------- a small PNG "QR" (the app only hands the bytes back; nobody scans it) ----------

function png(size: number, cell: number, bits: number[]) {
  const w = size * cell + 8 * cell;
  const rows: Buffer[] = [];
  for (let y = 0; y < w; y++) {
    const row = Buffer.alloc(w + 1);
    for (let x = 0; x < w; x++) {
      const cx = Math.floor(x / cell) - 4;
      const cy = Math.floor(y / cell) - 4;
      const inside = cx >= 0 && cy >= 0 && cx < size && cy < size;
      const finder = (fx: number, fy: number) => { const dx = cx - fx; const dy = cy - fy; return dx >= 0 && dy >= 0 && dx < 7 && dy < 7 && (dx === 0 || dy === 0 || dx === 6 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4)); };
      const nearFinder = (fx: number, fy: number) => cx >= fx - 1 && cy >= fy - 1 && cx <= fx + 7 && cy <= fy + 7;
      let dark = false;
      if (inside) {
        if (nearFinder(0, 0) || nearFinder(size - 7, 0) || nearFinder(0, size - 7)) dark = finder(0, 0) || finder(size - 7, 0) || finder(0, size - 7);
        else dark = bits[(cy * size + cx) % bits.length] === 1;
      }
      row[x + 1] = dark ? 0 : 255;
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(w, 4); ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

function qrFor(token: string) {
  const h = crypto.createHash('sha512').update(`mfc-sandbox:${token}:${Date.now()}`).digest();
  const bits = [...h, ...crypto.createHash('sha512').update(h).digest()].flatMap((b) => [...Array(8)].map((_, i) => (b >> i) & 1));
  return png(29, 8, bits).toString('base64');
}

// ---------- hosted pages ----------

const mask = (s: string | null | undefined) => (s ? s.replace(/^(.{2})(.*)(.{3})$/, (_, a, b, c) => a + '*'.repeat(b.length) + c) : '');

const page = (body: string, script = '') => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>MFC CAS Flow (sandbox)</title><style>
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#eef1f6;color:#0f141f}
.top{background:#fff;padding:14px 18px;border-bottom:1px solid #e3e6ec;display:flex;align-items:center;gap:10px}
.logo{font-weight:800;color:#0b3a8a;font-size:18px}.tag{font-size:11px;background:#fff3d6;color:#8a5a00;padding:3px 8px;border-radius:20px;font-weight:600}
.wrap{padding:18px}.card{background:#fff;border-radius:16px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
h2{font-size:18px;margin:0 0 6px}p{font-size:14px;color:#5b6270;margin:0 0 14px;line-height:1.4}
.otp{display:flex;gap:8px;margin:16px 0}.otp input{width:100%;height:46px;border:1px solid #cfd5df;border-radius:10px;text-align:center;font-size:20px}
button{width:100%;height:48px;border:0;border-radius:10px;background:#0b55b1;color:#fff;font-size:15px;font-weight:600}
button.sec{background:#fff;color:#0b55b1;border:1px solid #0b55b1;margin-top:10px}button:disabled{opacity:.5}
.err{color:#b72e2e;font-size:13px;min-height:18px;margin-top:8px}.hint{background:#fff3d6;color:#6b4a00;border-radius:10px;padding:10px 12px;font-size:13px;margin-bottom:14px}
label.opt{display:flex;gap:10px;align-items:center;padding:12px;border:1px solid #dfe3ea;border-radius:10px;margin-bottom:8px;font-size:14px}
.sec-t{font-size:13px;font-weight:700;color:#3b4250;margin:16px 0 8px}img.qr{display:block;margin:10px auto 16px;width:220px;height:220px;image-rendering:pixelated}
</style></head><body><div class="top"><span class="logo">MFCentral</span><span class="tag">SANDBOX</span></div><div class="wrap">${body}</div>
<script>

function post(m){try{if(window.ReactNativeWebView){window.ReactNativeWebView.postMessage(JSON.stringify(m));return}}catch(e){}
 if(window.parent!==window)window.parent.postMessage(m,'*')}
async function api(p,b){const r=await fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'Request failed');return j}
${script}</script></body></html>`;

// ---------- hosted pages (served by routes/mfcSandbox.routes.ts in demo mode only) ----------

/** MF Central's hosted journey: OTP -> what to share -> QR. */
export async function journeyPage(token: string): Promise<{ status: number; html: string }> {
  const s = await store.get(token);
  if (!s) return { status: 404, html: page('<div class="card"><h2>Link expired</h2><p>Start the import again from the app.</p></div>') };
  const to = s.mobile ? `+91 ${mask(s.mobile.slice(-10))}` : mask(s.email);
  return { status: 200, html: page(`
<div class="card" id="s1"><h2>Enter your 6-digit OTP</h2><p>MF Central sent a one-time password to ${to}, the contact registered in your folios for PAN ${mask(s.pan)}.</p>
<div class="hint">Sandbox: no SMS is sent. Your OTP is <b>${s.otp}</b>.</div>
<div class="otp">${[0, 1, 2, 3, 4, 5].map(() => '<input inputmode="numeric" maxlength="1">').join('')}</div>
<button id="auth" disabled>Authenticate with OTP</button><div class="err" id="e1"></div></div>
<div class="card" id="s2" style="display:none"><h2>Share your portfolio</h2><p>Choose what Risips may read from MF Central.</p>
<div class="sec-t">What type of data can be shared?</div>
<label class="opt"><input type="radio" name="plan" value="BOTH" checked> Regular + Direct</label>
<label class="opt"><input type="radio" name="plan" value="REGULAR"> Regular</label>
<label class="opt"><input type="radio" name="plan" value="DIRECT"> Direct</label>
<div class="sec-t">What extent of data?</div>
<label class="opt"><input type="radio" name="ext" value="SUMMARY" checked> Summary of holdings</label>
<label class="opt"><input type="radio" name="ext" value="TRANSACTIONS"> Transactions</label>
<div class="sec-t">Fund houses</div><label class="opt"><input type="checkbox" checked disabled> All AMCs</label>
<button id="gen">Generate QR code</button><div class="err" id="e2"></div></div>
<div class="card" id="s3" style="display:none"><h2>CAS Request QR Code</h2><p>Download the QR code, then tap Continue to send it to the app that requested it.</p>
<img class="qr" id="qr" alt="QR"><button id="dl">Download QR</button><button class="sec" id="cont" disabled>Continue</button><div class="err" id="e3"></div></div>`, `
const tok=${JSON.stringify(token)};let qr=null,ext='SUMMARY',reqId=${JSON.stringify(s.reqId)};
const ins=[...document.querySelectorAll('.otp input')];
ins.forEach((el,i)=>el.addEventListener('input',()=>{el.value=el.value.replace(/\\D/g,'').slice(-1);if(el.value&&ins[i+1])ins[i+1].focus();document.getElementById('auth').disabled=ins.some(x=>!x.value)}));
document.getElementById('auth').onclick=async()=>{const b=document.getElementById('auth');b.disabled=true;document.getElementById('e1').textContent='';
 try{await api('/mfc-sandbox/api/verify',{token:tok,otp:ins.map(x=>x.value).join('')});s1.style.display='none';s2.style.display='block'}catch(e){document.getElementById('e1').textContent=e.message;b.disabled=false}};
document.getElementById('gen').onclick=async()=>{const b=document.getElementById('gen');b.disabled=true;
 ext=document.querySelector('input[name=ext]:checked').value;
 try{const j=await api('/mfc-sandbox/api/generate-qr',{token:tok,planType:document.querySelector('input[name=plan]:checked').value,extentOfData:ext});
 qr=j.qr;document.getElementById('qr').src='data:image/png;base64,'+qr;s2.style.display='none';s3.style.display='block'}catch(e){document.getElementById('e2').textContent=e.message;b.disabled=false}};
document.getElementById('dl').onclick=()=>{post({type:'mfc-cas-download',data:{base64:qr,filename:'cas-request-qr.png'}});document.getElementById('cont').disabled=false;
 if(!window.ReactNativeWebView){const a=document.createElement('a');a.href='data:image/png;base64,'+qr;a.download='cas-request-qr.png';a.click()}};
document.getElementById('cont').onclick=()=>post({type:'mfc-cas-complete',data:{status:'success',reqId:reqId,type:ext}});
`) };
}

export async function verifyJourneyOtp(token: string, otp: string) {
  const s = await store.get(token);
  if (!s) throw new ApiError(404, 'This link has expired. Start again from the app.');
  if (s.tries >= 5) throw new ApiError(429, 'Too many attempts. Start again from the app.');
  if (String(otp) !== s.otp) { await store.put(token, { ...s, tries: s.tries + 1 }); throw new ApiError(422, 'Incorrect OTP. Please try again.'); }
  await store.put(token, { ...s, verified: true });
  return { ok: true };
}

export async function generateQr(token: string, planType?: string, extentOfData?: string) {
  const s = await store.get(token);
  if (!s?.verified) throw new ApiError(403, 'Verify the OTP first.');
  const qr = qrFor(token);
  await store.put(token, { ...s, qr, plan_type: planType || 'BOTH', extent: extentOfData || 'SUMMARY' });
  return { qr };
}
