// FP's pincode master has junk rows (seen 2026-10-30: 999999 -> Nizamabad, Telangana; 123456 -> Delhi). An Indian
// pincode's first two digits name its postal region, so a lookup is trusted only when FP's state is one that region
// covers. Region -> words in the state name (FP spells states in mixed case and a few ways).
const REGIONS: [string[], string[]][] = [
  [['11'], ['DELHI']],
  [['12', '13'], ['HARYANA']],
  [['14', '15', '16'], ['PUNJAB', 'CHANDIGARH', 'HARYANA']],
  [['17'], ['HIMACHAL']],
  [['18', '19'], ['JAMMU', 'KASHMIR', 'LADAKH']],
  [['20', '21', '22', '23', '24', '25', '26', '27', '28'], ['UTTAR']], // Uttar Pradesh and Uttarakhand
  [['30', '31', '32', '33', '34'], ['RAJASTHAN']],
  [['36', '37', '38', '39'], ['GUJARAT', 'DAMAN', 'DADRA', 'DIU']],
  [['40', '41', '42', '43', '44'], ['MAHARASHTRA', 'GOA']],
  [['45', '46', '47', '48'], ['MADHYA']],
  [['49'], ['CHHATTISGARH', 'CHATTISGARH']],
  [['50', '51', '52', '53'], ['TELANGANA', 'ANDHRA', 'PUDUCHERRY', 'PONDICHERRY']], // Yanam is 533 (Puducherry)
  [['56', '57', '58', '59'], ['KARNATAKA']],
  [['60', '61', '62', '63', '64'], ['TAMIL', 'PUDUCHERRY', 'PONDICHERRY']],
  [['67', '68', '69'], ['KERALA', 'LAKSHADWEEP', 'PUDUCHERRY', 'PONDICHERRY']], // Mahe is 673 (Puducherry)
  [['70', '71', '72', '73', '74'], ['BENGAL', 'SIKKIM', 'ANDAMAN']],
  [['75', '76', '77'], ['ODISHA', 'ORISSA']],
  [['78'], ['ASSAM']],
  [['79'], ['ARUNACHAL', 'MANIPUR', 'MEGHALAYA', 'MIZORAM', 'NAGALAND', 'TRIPURA', 'ASSAM']],
  [['80', '81', '82', '83', '84', '85'], ['BIHAR', 'JHARKHAND']],
];

/** True when the pincode's postal region covers the state FP returned for it. */
export function pincodeMatchesState(pin: string, state: string | null | undefined): boolean {
  const words = REGIONS.find(([prefixes]) => prefixes.includes(pin.slice(0, 2)))?.[1];
  const s = String(state || '').toUpperCase();
  return !!words && words.some((w) => s.includes(w));
}
