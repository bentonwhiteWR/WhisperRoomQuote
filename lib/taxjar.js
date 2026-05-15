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

async function calculateTaxProper(toState, toZip, toCity, amount, shipping, toStreet = '', installShipping = 0, lineItems = null) {
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
    shipping: parseFloat(taxableShipping.toFixed(2))
  };

  // Line-item mode is preferred — lets TaxJar apply state-specific per-item
  // rules natively (FL's $5k discretionary surtax cap, TN's single-article
  // local tax cap, MA's $175 clothing exemption, etc.). In aggregate-`amount`
  // mode TaxJar can only return a flat blended rate which we'd then multiply
  // against the whole taxable basis — over-charging on capped items.
  // Aggregate mode kept as fallback for any historical caller that still
  // passes only a subtotal (e.g. admin tools, older snapshots).
  let mode;
  if (Array.isArray(lineItems) && lineItems.length > 0) {
    body.line_items = lineItems.map((li, i) => {
      const item = {
        id: String(li.id != null ? li.id : i + 1),
        quantity: parseInt(li.quantity || 1, 10) || 1,
        unit_price: parseFloat(parseFloat(li.unit_price || 0).toFixed(2)),
      };
      const disc = parseFloat(li.discount || 0);
      if (disc > 0) item.discount = parseFloat(disc.toFixed(2));
      if (li.product_tax_code) item.product_tax_code = String(li.product_tax_code);
      return item;
    });
    mode = 'line_items';
  } else {
    body.amount = parseFloat((amount || 0).toFixed(2));
    mode = 'amount';
  }

  // Only add city/street if present — omitting is cleaner than sending empty string
  if (toCity && toCity.trim()) body.to_city = toCity.trim();
  if (toStreet && toStreet.trim()) body.to_street = toStreet.trim();

  console.log(`[tax] calculating for ${toCity||'(no city)'}, ${stateUpper} ${toZip} — mode=${mode}, shipping: ${taxableShipping} (freight: ${shipping||0}, install: ${installShipping||0})`);

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
    let taxAmt = res.body.tax.amount_to_collect || 0;
    const headlineRate = res.body.tax.rate || 0;
    const stateRate = (res.body.tax.breakdown && res.body.tax.breakdown.state_tax_rate) || 0;

    // Compute the taxable basis TaxJar saw — used both for effective-rate
    // back-computation AND for the FL surtax cap recompute below.
    let taxableBasis;
    if (body.line_items) {
      const linesTotal = body.line_items.reduce((s, li) =>
        s + (li.quantity * li.unit_price) - (li.discount || 0), 0);
      taxableBasis = linesTotal + (body.shipping || 0);
    } else {
      taxableBasis = (body.amount || 0) + (body.shipping || 0);
    }

    // FL discretionary sales surtax cap (FL Stat §212.054(2)(b)):
    // county/special-district surtax only applies to the first $5,000 of each
    // "single item of tangible personal property." State 6% has no cap.
    // TaxJar's /v2/taxes returns the UNCAPPED total even in line-item mode
    // (verified 2026-05-15 with W-1105142605 Pinellas County order:
    // returned $558.93 instead of QB's $552.00). We recompute here from the
    // state/local rate split TaxJar provided + the per-line basis.
    // Only triggers when state=FL, line-item mode, and there's a non-zero
    // local surtax (some FL counties have 0% local). Single-state special-
    // case for now — TN single-article and other state-specific caps would
    // each need their own block here when surfaced.
    let capped = null;
    if (stateUpper === 'FL' && body.line_items && body.line_items.length > 0) {
      const localRate = headlineRate - stateRate;
      if (localRate > 0.0001) {
        const FL_CAP_PER_ITEM = 5000;
        let recomputed = 0;
        for (const li of body.line_items) {
          const lineTaxable = (li.quantity * li.unit_price) - (li.discount || 0);
          if (lineTaxable <= 0) continue;
          // Per FL DOR: the cap is per individual item, so for qty>1 each
          // unit gets its own $5k cap separately. Compute per-unit post-
          // discount price, cap at $5k, multiply by quantity.
          const perUnitDisc = (li.discount || 0) / li.quantity;
          const perUnitPostDisc = li.unit_price - perUnitDisc;
          const cappedPerUnit = Math.min(perUnitPostDisc, FL_CAP_PER_ITEM);
          // Round per-component (state portion, local portion) before summing
          // so we match QB's invoice math to the cent — QB rounds each
          // jurisdiction's tax separately then sums.
          recomputed += Math.round(lineTaxable * stateRate * 100) / 100;
          recomputed += Math.round(cappedPerUnit * localRate * li.quantity * 100) / 100;
        }
        // Shipping: surtax cap doesn't apply to freight, so headline rate on
        // taxable shipping (which is 0 in FL since FL doesn't tax freight,
        // but kept for consistency with other capped states that might).
        recomputed += Math.round((body.shipping || 0) * headlineRate * 100) / 100;
        recomputed = Math.round(recomputed * 100) / 100;
        if (Math.abs(recomputed - taxAmt) >= 0.01) {
          console.log(`[tax] FL §212.054 surtax cap applied: ${taxAmt.toFixed(2)} → ${recomputed.toFixed(2)} (saved $${(taxAmt - recomputed).toFixed(2)})`);
          taxAmt = recomputed;
          capped = 'FL_5K';
        }
      }
    }

    // Back-compute an EFFECTIVE rate from the (possibly post-cap) tax amount
    // and the taxable basis. Client's getTaxAmount() does live recompute as
    // `rate × taxableBase` whenever products / freight / discount change, so
    // the rate we return has to be one that yields the correct dollar figure
    // when multiplied against the same base. For a FL Pinellas order that hit
    // the $5k cap, the effective rate will be slightly under the 7% headline
    // (e.g. 6.913%) — exactly the rate that makes the math come out right.
    const effectiveRate = taxableBasis > 0 ? (taxAmt / taxableBasis) : headlineRate;
    return {
      tax: taxAmt,
      rate: effectiveRate,
      headlineRate,
      inNexus: true,
      freightTaxed: inNexus.taxFreight,
      stateRate,
      mode,
      capped,
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
