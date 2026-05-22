// TaxJar sales tax integration
// Extracted from quote-server.js — named exports, no behavior changes.
// Host must call `init({ httpsRequest, NEXUS_STATES, toStateAbbr })` before use.

let _httpsRequest;
let _NEXUS_STATES;
let _toStateAbbr;

function init(deps) {
  _httpsRequest  = deps.httpsRequest;
  _NEXUS_STATES  = deps.NEXUS_STATES;
  _toStateAbbr   = deps.toStateAbbr;
}

const TAXJAR_KEY = process.env.TAXJAR_KEY || '';

async function calculateTaxProper(toState, toZip, toCity, amount, shipping, toStreet = '', installShipping = 0) {
  const stateUpper = _toStateAbbr(toState);
  const inNexus = _NEXUS_STATES[stateUpper];
  if (!inNexus) return { tax: 0, rate: 0, inNexus: false };

  // TaxJar requires at minimum: to_state + to_zip
  // City and street improve accuracy but are not required
  if (!toZip) {
    console.warn(`[tax] no zip for ${stateUpper} — cannot calculate`);
    return { tax: 0, rate: 0, inNexus: true, error: 'No zip code provided' };
  }

  // Install/delivery is classified as freight for nexus taxability purposes.
  // Client passes them separately so install shows as its own line, but they
  // combine into TaxJar's single `shipping` field when the state taxes freight.
  const combinedShipping = (parseFloat(shipping) || 0) + (parseFloat(installShipping) || 0);
  const taxableShipping = inNexus.taxFreight ? combinedShipping : 0;
  const body = {
    from_country: 'US', from_state: 'TN', from_zip: '37813', from_city: 'Morristown',
    from_street: '1313 S Davy Crockett Pkwy',
    to_country: 'US', to_state: stateUpper, to_zip: String(toZip).trim(),
    amount: parseFloat(amount.toFixed(2)),
    shipping: parseFloat(taxableShipping.toFixed(2))
  };
  // Only add city/street if present — omitting is cleaner than sending empty string
  if (toCity && toCity.trim()) body.to_city = toCity.trim();
  if (toStreet && toStreet.trim()) body.to_street = toStreet.trim();

  console.log(`[tax] calculating for ${toCity||'(no city)'}, ${stateUpper} ${toZip} — amount: ${amount}, shipping: ${taxableShipping} (freight: ${shipping||0}, install: ${installShipping||0})`);

  console.log(`[tax] sending to TaxJar:`, JSON.stringify(body));

  async function _post(b) {
    return _httpsRequest({
      hostname: 'api.taxjar.com',
      path: '/v2/taxes',
      method: 'POST',
      headers: {
        'Authorization': `Token token="${TAXJAR_KEY}"`,
        'Content-Type': 'application/json'
      }
    }, b);
  }

  let res = await _post(body);
  console.log(`[tax] TaxJar response status: ${res.status}, body:`, JSON.stringify(res.body));

  // Auto-fallback: when TaxJar rejects the ZIP as "not used within
  // the state" (e.g. 33104 in FL — retired or business-only ZIPs),
  // retry the request with a known-good ZIP for that state's largest
  // commercial market (NEXUS_STATES[state].fallbackZip). TaxJar
  // requires to_zip for US shipments, so simply dropping it returns
  // "No to zip, required when country is US" — substitution is the
  // working path. The returned rate reflects the fallback ZIP's local
  // surtax (e.g. FL 33101 → Miami-Dade 7%), so it's approximate but
  // far better than $0 / a dead-end error.
  let usedStateFallback = false;
  let fallbackReason    = null;
  const detailMsg = typeof res.body === 'object' ? (res.body.detail || '') : '';
  const isZipNotInState = res.status === 400 && /to_zip\s+\S+\s+is not used within to_state/i.test(detailMsg);
  if (isZipNotInState) {
    const fallbackZip = inNexus.fallbackZip;
    if (fallbackZip) {
      console.log(`[tax] ZIP ${toZip} rejected for ${stateUpper} — retrying with state fallback ZIP ${fallbackZip}. (${detailMsg})`);
      const fallbackBody = { ...body, to_zip: fallbackZip };
      // Strip street (it was tied to the original invalid ZIP) so TaxJar
      // doesn't combine the new ZIP with a mismatched street and 400 again.
      delete fallbackBody.to_street;
      res = await _post(fallbackBody);
      console.log(`[tax] fallback response status: ${res.status}, body:`, JSON.stringify(res.body));
      usedStateFallback = true;
      fallbackReason    = `ZIP ${toZip} not recognized — using ${stateUpper} state-level rate (via fallback ZIP ${fallbackZip})`;
    } else {
      console.warn(`[tax] ZIP ${toZip} rejected for ${stateUpper} and no fallbackZip configured — returning original error`);
    }
  }

  if (res.body && res.body.tax) {
    return {
      tax: res.body.tax.amount_to_collect || 0,
      rate: res.body.tax.rate || 0,
      inNexus: true,
      freightTaxed: inNexus.taxFreight,
      stateRate: res.body.tax.breakdown && res.body.tax.breakdown.state_tax_rate || 0,
      usedStateFallback,
      fallbackReason,
    };
  }
  // Log the error for debugging
  console.error('TaxJar error response:', JSON.stringify(res.body));
  // Prefer `detail` over `error`. TaxJar puts the actually-useful
  // explanation in `detail` (e.g. "to_zip 33104 is not used within
  // to_state FL"); `error` is just the HTTP status text ("Bad Request").
  // Without this swap the rep saw a generic "Tax calculation failed"
  // toast and had no idea the ZIP was the problem.
  const msg = typeof res.body === 'object'
    ? (res.body.detail || res.body.error || JSON.stringify(res.body))
    : String(res.body);
  return { tax: 0, rate: 0, inNexus: true, error: msg };
}

module.exports = {
  init,
  TAXJAR_KEY,
  calculateTaxProper,
};
