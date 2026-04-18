// Freight/tracking helpers
// Host must call init({ httpsRequest, getDb, writelog, puppeteer }) before use.

let _httpsRequest;
let _getDb;
let _writelog;
let _puppeteer;

function init(deps) {
  _httpsRequest = deps.httpsRequest;
  _getDb        = deps.getDb;
  _writelog     = deps.writelog;
  _puppeteer    = deps.puppeteer;
}

const ABF_ID       = 'Q8MZK7K1';
const ABF_ACCT     = '189059-248A';
const SHIP_CITY    = 'Morristown';
const SHIP_STATE   = 'TN';
const SHIP_ZIP     = '37813';
const NMFC_ITEM    = '027880';
const NMFC_SUB     = '02';
const FREIGHT_CLASS = '100';

async function initTrackingCache() {
  const db = _getDb();
  if (!db) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS tracking_cache (
      tracking_number TEXT PRIMARY KEY,
      slug            TEXT,
      status          TEXT,
      label           TEXT,
      location        TEXT,
      last_event      TEXT,
      last_event_time TEXT,
      eta             TEXT,
      delivered_at    TEXT,
      signed_by       TEXT,
      dest_city       TEXT,
      dest_state      TEXT,
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(e => console.warn('tracking_cache init error:', e.message));
  await db.query(`ALTER TABLE tracking_cache ADD COLUMN IF NOT EXISTS dest_city TEXT`).catch(()=>{});
  await db.query(`ALTER TABLE tracking_cache ADD COLUMN IF NOT EXISTS dest_state TEXT`).catch(()=>{});
  console.log('Tracking cache ready');
  try {
    const today = new Date().toISOString().split('T')[0];
    const wiped = await db.query(
      "DELETE FROM tracking_cache WHERE status = 'delivered' AND (delivered_at IS NULL OR delivered_at = $1)",
      [today]
    );
    if (wiped.rowCount > 0) console.log(`[tracking] cleared ${wiped.rowCount} stale/bogus cache entries`);
  } catch(e) { /* silent */ }
}

async function getTrackingFromCache(trackingNumber) {
  const db = _getDb();
  if (!db) return null;
  try {
    const r = await db.query('SELECT * FROM tracking_cache WHERE tracking_number = $1', [trackingNumber]);
    return r.rows[0] || null;
  } catch(e) { return null; }
}

async function saveTrackingToCache(trackingNumber, slug, data) {
  const db = _getDb();
  if (!db) return;
  try {
    await db.query(`
      INSERT INTO tracking_cache (tracking_number, slug, status, label, location, last_event, last_event_time, eta, delivered_at, signed_by, dest_city, dest_state, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
      ON CONFLICT (tracking_number) DO UPDATE SET
        slug=$2, status=$3, label=$4, location=$5, last_event=$6,
        last_event_time=$7, eta=$8, delivered_at=$9, signed_by=$10,
        dest_city=$11, dest_state=$12, updated_at=NOW()
    `, [trackingNumber, slug, data.status||null, data.label||null, data.location||null,
        data.lastEvent||null, data.lastEventTime||null, data.eta||null,
        data.deliveredAt||null, data.signedBy||null,
        data.destCity||null, data.destState||null]);
  } catch(e) { console.warn('tracking cache save error:', e.message); }
}

async function fetchABFTracking(trackingNumber, apiKey) {
  try {
    const url = `https://www.abfs.com/xml/tracexml.asp?DL=2&ID=${encodeURIComponent(apiKey)}&RefNum=${encodeURIComponent(trackingNumber)}&RefType=A`;
    const res = await _httpsRequest({ hostname: 'www.abfs.com', path: url.replace('https://www.abfs.com', ''), method: 'GET', headers: { 'Accept': 'application/xml' } });
    const xml = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    const get = (tag) => { const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i')); return m ? m[1].trim() : null; };

    const errors = get('NUMERRORS');
    if (errors && errors !== '0') {
      console.warn(`[ABF] tracking error for ${trackingNumber}: ${get('ERRORMESSAGE')}`);
      return null;
    }

    const shortStatus = get('SHORTSTATUS2') || get('SHORTSTATUS') || '';
    const longStatus  = get('LONGSTATUS') || '';
    const deliveryDate = get('DELIVERYDATE');
    const deliveryTime = get('DELIVERYTIME');
    const dueDate      = get('DUEDATE');
    const expectedDate = get('EXPECTEDDELIVERYDATE');
    const pickupDate   = get('PICKUP');
    const pickupTime   = get('PICKUPTIME');

    let status = 'in_transit', label = 'In Transit';
    const ss = shortStatus.toUpperCase();
    const ls = longStatus.toLowerCase();
    const hasDeliveryDate = !!deliveryDate;
    if ((ss === 'D' && hasDeliveryDate) || (ls.includes('delivered') && !ls.includes('out for delivery') && !ls.includes('arrived'))) {
      status = 'delivered'; label = 'Delivered';
    } else if (ss === 'OD' || ss === 'OFD' || ls.includes('out for delivery')) {
      status = 'out_for_delivery'; label = 'Out for Delivery';
    } else if (ls.includes('arrived') || ss === 'ARR') {
      status = 'in_transit'; label = 'Arrived at Terminal';
    } else if (ss === 'P' || ls.includes('picked up')) {
      status = 'in_transit'; label = 'Picked Up';
    } else if (ss === 'E' || ls.includes('exception')) {
      status = 'exception'; label = 'Exception';
    }

    const etaRaw = dueDate || expectedDate || null;
    let eta = null;
    if (etaRaw) { try { const d = new Date(etaRaw); if (!isNaN(d)) eta = d.toISOString().split('T')[0]; } catch(e) {} }

    let deliveredAt = null;
    if (status === 'delivered' && deliveryDate) {
      try { const d = new Date(deliveryDate); if (!isNaN(d)) deliveredAt = d.toISOString().split('T')[0]; } catch(e) {}
    }

    const sigFirst = get('DELIVSIGFIRSTNAME') || '';
    const sigLast  = get('DELIVSIGLASTNAME')  || '';
    const signedBy = [sigFirst, sigLast].filter(Boolean).join(' ') || null;
    const destCity  = get('CONSIGNEECITY')  || null;
    const destState = get('CONSIGNEESTATE') || null;

    let lastEvent = longStatus || null;
    let lastEventTime = null;
    if (pickupDate) {
      const pickupStr = [pickupDate, pickupTime].filter(Boolean).join(' ');
      lastEventTime = pickupDate;
      if (!lastEvent && pickupStr) lastEvent = `Picked up ${pickupStr}`;
    }

    return { status, label, lastEvent, lastEventTime, eta, deliveredAt, signedBy,
             location: destCity ? [destCity, destState].filter(Boolean).join(', ') : null,
             destCity, destState };
  } catch(e) {
    console.warn(`[ABF] API error for ${trackingNumber}: ${e.message}`);
    return null;
  }
}

async function fetchABFTransitDays(destZip, pickupDate, apiKey) {
  try {
    const pd = pickupDate ? new Date(pickupDate) : new Date();
    const month = String(pd.getMonth() + 1).padStart(2, '0');
    const day   = String(pd.getDate()).padStart(2, '0');
    const year  = String(pd.getFullYear());
    const path  = `/xml/transitxml.asp?DL=2&ID=${encodeURIComponent(apiKey)}&Shipper=Y&OriginZip=37813&OriginCountry=US&DestZip=${encodeURIComponent(destZip)}&DestCountry=US&PickupMonth=${month}&PickupDay=${day}&PickupYear=${year}`;
    const res = await _httpsRequest({ hostname: 'www.abfs.com', path, method: 'GET', headers: { 'Accept': 'application/xml' } });
    const xml = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    const get = (tag) => { const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i')); return m ? m[1].trim() : null; };
    const errors = get('NUMERRORS');
    if (errors && errors !== '0') return null;
    const trDays  = get('TRDAYS');
    const dueDate = get('DUEDATE');
    let eta = null;
    if (dueDate) { try { const d = new Date(dueDate); if (!isNaN(d)) eta = d.toISOString().split('T')[0]; } catch(e) {} }
    return { transitDays: trDays ? parseInt(trDays) : null, eta };
  } catch(e) {
    console.warn(`[ABF] transit time error for ${destZip}: ${e.message}`);
    return null;
  }
}

async function fetchAndCacheTracking(trackingNumber, carrier) {
  if (!trackingNumber) return null;
  const carrierUpper = (carrier || '').toUpperCase();

  if (carrierUpper === 'OD' || carrierUpper.includes('DOMINION')) {
    const OD_USER = process.env.OD_USER || '';
    const OD_PASS = process.env.OD_PASS || '';
    if (!OD_USER || !OD_PASS) { console.warn('[tracking] OD credentials not set'); return null; }
    try {
      console.log(`[tracking] OD API for ${trackingNumber}`);
      const authRes = await _httpsRequest({
        hostname: 'api.odfl.com', path: '/auth/v1.0/token', method: 'GET',
        headers: { 'Authorization': 'Basic ' + Buffer.from(`${OD_USER}:${OD_PASS}`).toString('base64'), 'Accept': 'application/json' }
      });
      const token = authRes.body?.access_token || authRes.body?.sessionToken || authRes.body?.token;
      if (!token) { console.warn('[tracking] OD auth failed:', JSON.stringify(authRes.body)?.slice(0, 200)); return null; }

      const trackRes = await _httpsRequest({
        hostname: 'api.odfl.com', path: '/tracking/v2.0/shipment.track', method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' }
      }, { referenceType: 'PRO', referenceNumber: trackingNumber });

      const data = trackRes.body;
      if (!data || trackRes.status >= 400) { console.warn('[tracking] OD track failed:', JSON.stringify(data)?.slice(0, 200)); return null; }

      const trace = Array.isArray(data.traceInfo) ? data.traceInfo[0] : (data.traceInfo || data);
      const events = trace.trackTraceDetail || [];
      const latestEvt = events[0];

      let status = 'in_transit', label = 'In Transit';
      if (latestEvt) {
        const evtStatus = (latestEvt.status || '').toLowerCase();
        if (evtStatus.includes('delivery confirmed') || evtStatus.includes('delivered')) { status = 'delivered'; label = 'Delivered'; }
        else if (evtStatus.includes('out for delivery')) { status = 'out_for_delivery'; label = 'Out for Delivery'; }
        else if (evtStatus.includes('arrived at consignee')) { status = 'out_for_delivery'; label = 'Out for Delivery'; }
        else if (evtStatus.includes('exception')) { status = 'exception'; label = 'Exception'; }
      }

      let lastEvent = null, lastEventTime = null;
      const evtWithLocation = events.find(e => e.city && e.state);
      const evtToShow = evtWithLocation || latestEvt;
      if (evtToShow) {
        lastEvent = [evtToShow.status, evtToShow.desc].filter(Boolean).join(' — ') || null;
        if (evtToShow.city && evtToShow.state) lastEvent = lastEvent ? `${lastEvent} (${evtToShow.city}, ${evtToShow.state})` : `${evtToShow.city}, ${evtToShow.state}`;
        lastEventTime = evtToShow.dateTime ? evtToShow.dateTime.split('T')[0] : null;
      }

      const eta = trace.updatedEta || trace.standardEta || null;
      const destCity  = trace.consigneeCity  || trace.destSvcCity  || null;
      const destState = trace.consigneeState || trace.destSvcState || null;

      let deliveredAt = null;
      if (status === 'delivered') {
        const delEvt = events.find(e => (e.status || '').toLowerCase().includes('delivered') && e.dateTime);
        if (delEvt) deliveredAt = delEvt.dateTime.split('T')[0];
      }

      const cacheData = {
        status, label, lastEvent, lastEventTime,
        eta: eta ? eta.split('T')[0] : null,
        deliveredAt, signedBy: trace.deliverySign || null,
        location: destCity ? [destCity, destState].filter(Boolean).join(', ') : null,
        destCity, destState,
      };
      await saveTrackingToCache(trackingNumber, 'OD', cacheData);
      console.log(`[tracking] OD ${trackingNumber} → ${label}${lastEvent ? ' | ' + lastEvent.slice(0, 60) : ''}`);
      return cacheData;
    } catch(e) { console.warn(`[tracking] OD error (${trackingNumber}): ${e.message}`); return null; }
  }

  if (carrierUpper === 'ABF') {
    const ARCBEST_KEY = process.env.ARCBEST_API_KEY || '';
    if (!ARCBEST_KEY) { console.warn('[tracking] ARCBEST_API_KEY not set'); return null; }
    console.log(`[tracking] ABF API for ${trackingNumber}`);
    const result = await fetchABFTracking(trackingNumber, ARCBEST_KEY);
    if (!result) return null;
    const cacheData = {
      status: result.status, label: result.label,
      lastEvent: result.lastEvent || null, lastEventTime: result.lastEventTime || null,
      eta: result.eta || null, deliveredAt: result.deliveredAt || null,
      signedBy: result.signedBy || null, location: result.location || null,
      destCity: result.destCity || null, destState: result.destState || null,
    };
    await saveTrackingToCache(trackingNumber, 'ABF', cacheData);
    console.log(`[tracking] ABF ${trackingNumber} → ${result.label}${result.lastEvent ? ' | ' + result.lastEvent.slice(0, 80) : ''}`);
    return cacheData;
  }

  if (['UPS','FEDEX','USPS'].includes(carrierUpper)) {
    if (!_puppeteer) {
      await saveTrackingToCache(trackingNumber, carrierUpper, { status: 'pending', label: 'Pending' });
      return { status: 'pending', label: 'Pending' };
    }
    const urlMap = {
      'UPS':   `https://www.ups.com/track?tracknum=${encodeURIComponent(trackingNumber)}&requester=ST/trackdetails`,
      'FEDEX': `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(trackingNumber)}`,
      'USPS':  `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(trackingNumber)}`,
    };
    let browser = null;
    try {
      console.log(`[tracking] ${carrierUpper} scrape for ${trackingNumber}`);
      browser = await _puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] });
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      await page.goto(urlMap[carrierUpper], { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 3000));
      const body = await page.evaluate(() => document.body.innerText);
      const bodyLower = body.toLowerCase();
      let status = 'in_transit', label = 'In Transit';
      if (bodyLower.includes('delivered'))             { status = 'delivered';        label = 'Delivered'; }
      else if (bodyLower.includes('out for delivery')) { status = 'out_for_delivery'; label = 'Out for Delivery'; }
      else if (bodyLower.includes('in transit') || bodyLower.includes('on the way')) { status = 'in_transit'; label = 'In Transit'; }
      const lines = body.split('\n').map(l => l.trim()).filter(l => l.length > 10);
      const dateRx = /\d{1,2}\/\d{1,2}\/\d{4}|\w+ \d{1,2},? \d{4}/;
      const evtLine = lines.find(l => dateRx.test(l) && l.length < 200);
      const cacheData = { status, label, lastEvent: evtLine || null, lastEventTime: null, eta: null,
        deliveredAt: null, signedBy: null, location: null, destCity: null, destState: null };
      await saveTrackingToCache(trackingNumber, carrierUpper, cacheData);
      console.log(`[tracking] ${carrierUpper} ${trackingNumber} → ${label}`);
      return cacheData;
    } catch(e) {
      console.warn(`[tracking] ${carrierUpper} error (${trackingNumber}): ${e.message}`);
      return null;
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  }

  await saveTrackingToCache(trackingNumber, carrierUpper, { status: 'pending', label: 'Pending' });
  return { status: 'pending', label: 'Pending' };
}

async function startTrackingPoller() {
  const db = _getDb();
  if (!db) return;
  const HS_TOKEN = process.env.HS_TOKEN || '';
  const poll = async () => {
    try {
      const hsRes = await _httpsRequest({
        hostname: 'api.hubapi.com', path: '/crm/v3/objects/deals/search', method: 'POST',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
      }, {
        filterGroups: [{ filters: [
          { propertyName: 'dealstage', operator: 'EQ', value: '845719' },
          { propertyName: 'tracking_number', operator: 'HAS_PROPERTY' }
        ]}],
        properties: ['tracking_number', 'freight_carrier'],
        limit: 100
      });

      const deals = hsRes.body?.results || [];
      let refreshed = 0;
      for (const deal of deals) {
        const tracking = deal.properties.tracking_number;
        const carrier  = deal.properties.freight_carrier || '';
        if (!tracking) continue;
        const cached = await getTrackingFromCache(tracking);
        if (cached?.status === 'delivered' && cached?.delivered_at) continue;
        if (cached?.updated_at) {
          const age = Date.now() - new Date(cached.updated_at).getTime();
          const minAge = (cached.status && cached.status !== 'pending') ? 25 * 60 * 1000 : 4 * 60 * 60 * 1000;
          if (age < minAge) continue;
        }
        await fetchAndCacheTracking(tracking, carrier);
        refreshed++;
        await new Promise(r => setTimeout(r, 5000));
      }
      if (refreshed > 0) console.log(`Tracking poller: refreshed ${refreshed} shipments`);
    } catch(e) {
      console.warn('Tracking poller error:', e.message);
      _writelog('error', 'error.tracking-poller', `Tracking poller failed: ${e.message}`, {});
    }
  };
  setTimeout(poll, 10000);
  setInterval(poll, 30 * 60 * 1000);
  console.log('Tracking poller started (30min interval)');
}

function buildAbfUrl(pallets, totalWeight, consCity, consState, consZip, isCanadian, accessories, servType) {
  const today = new Date();
  const cleanZip = (consZip || '').replace(/\s+/g, '');
  const nmfcItem = isCanadian ? '027880' : NMFC_ITEM;
  const nmfcSub  = isCanadian ? '02'     : NMFC_SUB;
  const parts = ['DL=2', `ID=${ABF_ID}`, `ShipAcct=${ABF_ACCT}`, 'ShipPay=Y', 'Acc=ARR=Y'];
  if (servType) parts.push(`ServType=${servType}`);
  if (accessories.residential)   parts.push('Acc_RDEL=Y');
  if (accessories.liftgate)      parts.push('Acc_GRD_DEL=Y');
  if (accessories.limitedaccess) { parts.push('Acc_LAD=Y'); parts.push('LADType=M'); }
  parts.push(
    `ShipCity=${encodeURIComponent(SHIP_CITY)}`, `ShipState=${SHIP_STATE}`,
    `ShipZip=${SHIP_ZIP}`, 'ShipCountry=US',
    `ConsCity=${encodeURIComponent(consCity)}`, `ConsState=${consState}`,
    `ConsZip=${cleanZip}`, `ConsCountry=${isCanadian ? 'CA' : 'US'}`,
    'FrtLWHType=IN'
  );
  pallets.forEach((pl, i) => {
    const n = i + 1;
    parts.push(
      `FrtLng${n}=${pl.l}`, `FrtWdth${n}=${pl.w}`, `FrtHght${n}=${pl.h}`,
      `UnitType${n}=PLT`, `Wgt${n}=${pl.weight}`, `UnitNo${n}=1`,
      `Class${n}=${FREIGHT_CLASS}`, `NMFCItem${n}=${nmfcItem}`, `NMFCSub${n}=${nmfcSub}`
    );
  });
  parts.push('ShipAff=Y', `ShipMonth=${today.getMonth()+1}`, `ShipDay=${today.getDate()}`, `ShipYear=${today.getFullYear()}`);
  return 'https://www.abfs.com/xml/aquotexml.asp?' + parts.join('&');
}

function parseAbfXml(xmlText) {
  const errMatch = xmlText.match(/<ERROR[^>]*>([^<]*)<\/ERROR>/i)
                || xmlText.match(/<ERRORDESC[^>]*>([^<]*)<\/ERRORDESC>/i)
                || xmlText.match(/<MSG[^>]*>([^<]*)<\/MSG>/i);
  if (errMatch && errMatch[1].trim()) {
    const abfMsg = errMatch[1].trim();
    if (/zip|postal|destination/i.test(abfMsg)) throw new Error(`Invalid destination ZIP code — please verify and try again`);
    if (/city/i.test(abfMsg))                    throw new Error(`Invalid destination city — please verify and try again`);
    if (/state/i.test(abfMsg))                   throw new Error(`Invalid destination state — please verify and try again`);
    if (/weight/i.test(abfMsg))                  throw new Error(`Invalid shipment weight — please verify and try again`);
    if (/class/i.test(abfMsg))                   throw new Error(`Invalid freight class — contact Benton`);
    throw new Error(`ABF error: ${abfMsg}`);
  }
  let cost = 0, dynDisc = 0, transit = '—';
  const itemRe = /<ITEM[^>]+FOR="([^"]*)"[^>]+AMOUNT="([^"]*)"[^>]*/gi;
  let m;
  while ((m = itemRe.exec(xmlText)) !== null) {
    const forAttr = m[1].toUpperCase();
    const amount = parseFloat(m[2]);
    if (forAttr === 'DYNDISC') dynDisc = Math.abs(amount);
    else cost += amount;
  }
  const tMatch = xmlText.match(/<ADVERTISEDTRANSIT>([^<]*)<\/ADVERTISEDTRANSIT>/i);
  if (tMatch) transit = tMatch[1].trim();
  if (cost === 0) throw new Error('No rate returned from ABF — please verify the destination ZIP, city, and state are correct');
  return { cost: Math.round(cost * 100) / 100, dynDisc, transit };
}

function buildOdBookUrl({ city, state, zip, pallets, totalWeight, acc }) {
  const base = 'https://www.odfl.com/us/en/tools/ship-ltl-freight.html';
  const params = new URLSearchParams();
  if (zip)   params.set('destPostalCode', zip);
  if (state) params.set('destState', state);
  if (city)  params.set('destCity', city);
  params.set('originPostalCode', '37813');
  params.set('originState', 'TN');
  params.set('originCity', 'Morristown');
  return `${base}?${params.toString()}`;
}

function buildAbfBookingUrl(params) {
  const {
    pallets, totalWeight,
    consName, consAddr, consCity, consState, consZip, consCountry,
    consPhone, consTaxId,
    pickupDate, bolNumber, specialInstructions, accessories,
  } = params;
  const today = pickupDate ? new Date(pickupDate) : new Date();
  const parts = [
    'DL=2', `ID=${ABF_ID}`, `ShipAcct=${ABF_ACCT}`, 'ShipPay=Y',
    `ShipName=${encodeURIComponent('WhisperRoom Inc')}`,
    `ShipAddr=${encodeURIComponent('322 Nancy Lynn Lane Suite 14')}`,
    `ShipCity=${encodeURIComponent(SHIP_CITY)}`, `ShipState=${SHIP_STATE}`,
    `ShipZip=${SHIP_ZIP}`, 'ShipCountry=US',
    `ShipPhone=${encodeURIComponent('8655585364')}`,
    `ConsName=${encodeURIComponent(consName || '')}`,
    `ConsAddr=${encodeURIComponent(consAddr || '')}`,
    `ConsCity=${encodeURIComponent(consCity || '')}`,
    `ConsState=${consState || ''}`, `ConsZip=${consZip || ''}`,
    `ConsCountry=${consCountry || 'US'}`,
    `ConsPhone=${encodeURIComponent(consPhone || '')}`,
    `ShipMonth=${today.getMonth()+1}`, `ShipDay=${today.getDate()}`, `ShipYear=${today.getFullYear()}`,
    `BOLRef1=${encodeURIComponent(bolNumber || '')}`,
    'FrtLWHType=IN', 'Acc=ARR=Y',
  ];
  if (accessories?.residential)   parts.push('Acc_RDEL=Y');
  if (accessories?.liftgate)      parts.push('Acc_GRD_DEL=Y');
  if (accessories?.limitedaccess) { parts.push('Acc_LAD=Y'); parts.push('LADType=M'); }
  if (specialInstructions)        parts.push(`SpcInst=${encodeURIComponent(specialInstructions)}`);
  pallets.forEach((pl, i) => {
    const n = i + 1;
    parts.push(
      `FrtLng${n}=${pl.l}`, `FrtWdth${n}=${pl.w}`, `FrtHght${n}=${pl.h}`,
      `UnitType${n}=PLT`, `Wgt${n}=${pl.weight}`, `UnitNo${n}=1`,
      `Class${n}=${FREIGHT_CLASS}`, `NMFCItem${n}=${NMFC_ITEM}`, `NMFCSub${n}=${NMFC_SUB}`,
    );
  });
  return 'https://www.abfs.com/xml/ashipxml.asp?' + parts.join('&');
}

function parseAbfBookingXml(xmlText) {
  const proMatch = xmlText.match(/<PRO[^>]*>([^<]*)<\/PRO>/i)
    || xmlText.match(/PRO["\s]*[:=]["\s]*([0-9-]+)/i)
    || xmlText.match(/<PRONUMBER[^>]*>([^<]*)<\/PRONUMBER>/i);
  const proNumber = proMatch ? proMatch[1].trim() : null;
  const bolMatch = xmlText.match(/<BOL[^>]*>([^<]*)<\/BOL>/i)
    || xmlText.match(/<BOLNUMBER[^>]*>([^<]*)<\/BOLNUMBER>/i);
  const bolNumber = bolMatch ? bolMatch[1].trim() : null;
  const errMatch = xmlText.match(/<ERROR[^>]*>([^<]*)<\/ERROR>/i)
    || xmlText.match(/<ERRORMSG[^>]*>([^<]*)<\/ERRORMSG>/i);
  const error = errMatch ? errMatch[1].trim() : null;
  const pickupMatch = xmlText.match(/<PICKUP[^>]*>([^<]*)<\/PICKUP>/i)
    || xmlText.match(/<CONFIRMNO[^>]*>([^<]*)<\/CONFIRMNO>/i);
  const pickupConfirm = pickupMatch ? pickupMatch[1].trim() : null;
  return { proNumber, bolNumber, pickupConfirm, error, raw: xmlText.slice(0, 500) };
}

module.exports = {
  init,
  ABF_ID, ABF_ACCT, SHIP_CITY, SHIP_STATE, SHIP_ZIP, NMFC_ITEM, NMFC_SUB, FREIGHT_CLASS,
  initTrackingCache,
  getTrackingFromCache,
  saveTrackingToCache,
  fetchABFTracking,
  fetchABFTransitDays,
  fetchAndCacheTracking,
  startTrackingPoller,
  buildAbfUrl,
  parseAbfXml,
  buildOdBookUrl,
  buildAbfBookingUrl,
  parseAbfBookingXml,
};
