// End-to-end API smoke test of onboarding against the running backend (FP sandbox).
const B = process.env.API || 'http://localhost:8080';
let T = null;
async function call(m, p, body) {
  const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', ...(T ? { Authorization: 'Bearer ' + T } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  console.log(`${m} ${p} -> ${r.status}`, JSON.stringify(j).slice(0, 300));
  if (r.status >= 300 && !process.env.SOFT) throw new Error(p + ' failed');
  return j;
}
const L = 'ABCDEFGHJKLMNRSTUVWYZ', rl = () => L[Math.floor(Math.random() * L.length)], rnd = (n) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, '0');
(async () => {
  const email = `demo.${rnd(5)}@example.com`, mobile = `98${rnd(8)}`, pan = `${rl()}${rl()}${rl()}PX3751${rl()}`;
  let j = await call('POST', '/auth/email/start', { email });
  j = await call('POST', '/auth/email/verify', { email, code: j.dev_otp }); T = j.token;
  j = await call('POST', '/auth/mobile/start', { mobile });
  await call('POST', '/auth/mobile/verify', { mobile, code: j.dev_otp, bank_consent: true });
  await call('POST', '/auth/pin/set', { pin: '1234' });
  await call('POST', '/onb/pan', { pan, name: 'Ravi Kumar Verma', dob: '1990-04-12' });
  await call('POST', '/onb/pan/confirm', {});
  await call('POST', '/onb/profile', { occupation: 'private_sector_service' });
  await call('POST', '/onb/profile', { income_slab: 'above_5lakh_upto_10lakh' });
  await call('POST', '/onb/profile', { marital_status: 'single' });
  await call('POST', '/onb/profile', { father_name: 'Suresh Verma' });
  await call('POST', '/onb/address', { line1: '12 MG Road', line2: 'Hazratganj', pincode: '226001', gender: 'male' });
  j = await call('POST', '/onb/aadhaar/start', { aadhaar: '234567892789' });
  await call('POST', '/onb/aadhaar/verify', { code: j.dev_otp });
  await call('POST', '/onb/bank', { account_number: `501001${rnd(4)}1195`, ifsc: 'HDFC0000001' });
  // a real PNG signature: the backend checks the bytes, not just the data: prefix
  const png = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(800, 1)]).toString('base64');
  await call('POST', '/onb/selfie', { image: png });
  await call('POST', '/onb/declarations', { fatca: true, running_account: true });
  await call('POST', '/onb/signature', { image: png });
  j = await call('POST', '/txn/otp', { action: 'nominee' });
  await call('POST', '/onb/nominee', { name: 'Sita Verma', dob: '1965-06-01', relationship: 'mother', pan: `${rl()}${rl()}${rl()}PV${rnd(4)}${rl()}`, otp: j.dev_otp });
  j = await call('POST', '/onb/esign', { consent: true });
  console.log('\nTOKEN', T, '\nFP', JSON.stringify(j.fp), '\nnext_step', j.user.next_step);
  require('fs').writeFileSync(__dirname + '/.last_user.json', JSON.stringify({ token: T, email, mobile, pan }));
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
