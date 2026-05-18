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

  const res = await _httpsRequest({
    hostname: 'api.taxjar.com',
    path: '/v2/taxes',
    method: 'POST',
    headers: {
      'Authorization': `Token token="${TAXJAR_KEY}"`,
      'Content-Type': 'application/json'
    }
  }, body);

  console.log(`[tax] TaxJar response status: ${res.status}, body:`, JSON.stringify(res.body));

  if (res.body && res.body.tax) {
    return {
      tax: res.body.tax.amount_to_collect || 0,
      rate: res.body.tax.rate || 0,
      inNexus: true,
      freightTaxed: inNexus.taxFreight,
      stateRate: res.body.tax.breakdown && res.body.tax.breakdown.state_tax_rate || 0
    };
  }
  // Log the error for debugging
  console.error('TaxJar error response:', JSON.stringify(res.body));
  return { tax: 0, rate: 0, inNexus: true, error: typeof res.body === 'object' ? (res.body.error || res.body.detail || JSON.stringify(res.body)) : String(res.body) };
}

module.exports = {
  init,
  TAXJAR_KEY,
  calculateTaxProper,
};
