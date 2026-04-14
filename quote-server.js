// WhisperRoom Quote Builder
// Node.js server with HubSpot, TaxJar, and ABF integration

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const url     = require('url');
const crypto  = require('crypto');

// ── Puppeteer PDF generation ──────────────────────────────────────
let puppeteer;
try {
  puppeteer = require('puppeteer');
  console.log('Puppeteer loaded');
} catch(e) {
  console.warn('Puppeteer not available:', e.message);
}


// ── Google Drive Integration ──────────────────────────────────────
const GDRIVE_ROOT_FOLDER    = process.env.GDRIVE_ROOT_FOLDER || '';
const SHARED_ORDERS_FOLDER  = '0AKEFNM5_Dl8jUk9PVA'; // WhisperRoom Orders folder

let _gdriveToken = null;
let _gdriveTokenExpiry = 0;

async function getGDriveToken() {
  if (_gdriveToken && Date.now() < _gdriveTokenExpiry) return _gdriveToken;

  const sa = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!sa) { console.warn('GOOGLE_SERVICE_ACCOUNT_JSON not set'); return null; }

  let creds;
  try {
    // Handle both escaped \n and literal newlines in private key
    const cleaned = sa.replace(/\\n/g, '\n');
    creds = JSON.parse(cleaned);
  } catch(e) {
    try { creds = JSON.parse(sa); } catch(e2) {
      console.warn('Invalid service account JSON:', e2.message); return null;
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');

  const crypto = require('crypto');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(creds.private_key).toString('base64url');
  const jwt = `${header}.${payload}.${sig}`;

  const tokenRes = await httpsRequest({
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  }, `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`);

  _gdriveToken = tokenRes.body?.access_token;
  _gdriveTokenExpiry = Date.now() + 3500000;
  return _gdriveToken;
}

async function gdriveRequest(method, path, body) {
  const token = await getGDriveToken();
  if (!token) return null;
  const res = await httpsRequest({
    hostname: 'www.googleapis.com',
    path,
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    }
  }, body || undefined);
  return res.body;
}

async function gdriveCreateFolder(name, parentId) {
  const res = await gdriveRequest('POST', '/drive/v3/files?supportsAllDrives=true', {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parentId],
  });
  return res;
}

async function gdriveFindFolder(name, parentId) {
  const q = encodeURIComponent(`name='${name.replace(/'/g,"\\'")}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const res = await gdriveRequest('GET', `/drive/v3/files?q=${q}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives`);
  return res?.files?.[0] || null;
}

async function gdriveEnsureFolder(name, parentId) {
  const existing = await gdriveFindFolder(name, parentId);
  if (existing) return existing;
  return await gdriveCreateFolder(name, parentId);
}

async function gdriveRenameFolder(folderId, newName) {
  return await gdriveRequest('PATCH', `/drive/v3/files/${folderId}?supportsAllDrives=true`, { name: newName });
}

async function gdriveUploadFile(filename, mimeType, content, parentId) {
  const token = await getGDriveToken();
  if (!token) return null;
  // Multipart upload
  const boundary = 'wr_boundary_' + Date.now();
  const meta = JSON.stringify({ name: filename, parents: [parentId] });
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    meta,
    `--${boundary}`,
    `Content-Type: ${mimeType}`,
    '',
    typeof content === 'string' ? content : content.toString('base64'),
    `--${boundary}--`,
  ].join('\r\n');

  const res = await httpsRequest({
    hostname: 'www.googleapis.com',
    path: '/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    }
  }, body, true);
  return res.body;
}

// Create the standard deal folder structure
function getCompanyFolderName(dealName, companyName) {
  // Use company name if available, otherwise strip " - Mon YYYY" date suffix from deal name
  if (companyName && companyName.trim()) return companyName.trim();
  // Strip date suffix e.g. "GloNova - Apr 2026" → "GloNova"
  return (dealName || '').replace(/\s*[·—\-–]\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s*$/i, '').trim() || dealName;
}


// Map full carrier names to HubSpot freight_carrier enum values
function hsCarrierEnum(carrier) {
  if (!carrier) return '';
  const c = carrier.toLowerCase();
  if (c.includes('abf'))          return 'ABF';
  if (c.includes('old dominion') || c === 'od') return 'OD';
  if (c.includes('fedex'))        return 'FedEx';
  if (c.includes('ups'))          return 'UPS';
  if (c.includes('usps'))         return 'USPS';
  if (c.includes('saia'))         return 'SAIA';
  if (c.includes('yrc'))          return 'YRC';
  return 'Other';
}

async function gdriveCreateDealFolders(dealName, quoteNumber, companyName) {
  try {
    const folderName = getCompanyFolderName(dealName, companyName);
    const safeName = folderName.replace(/[/\:*?"<>|]/g, '-').trim();
    const dealFolder = await gdriveEnsureFolder(safeName, GDRIVE_ROOT_FOLDER);
    if (!dealFolder?.id) { console.warn('GDrive: failed to create deal folder'); return null; }

    // Save folder ID to DB
    if (db && quoteNumber) {
      await db.query(
        'UPDATE quotes SET gdrive_folder_id = $1 WHERE quote_number = $2',
        [dealFolder.id, quoteNumber]
      ).catch(e => console.warn('GDrive folder ID save failed:', e.message));
    }

    console.log(`GDrive: folder created/found for "${safeName}" — ${dealFolder.id}`);
    return dealFolder;
  } catch(e) {
    console.warn('GDrive createDealFolders error:', e.message);
    return null;
  }
}


// Upload a PDF directly to a deal's folder (flat — no subfolders)
async function gdriveSavePdfToDeal(quoteNumber, _subfolderName, filename, pdfBuffer) {
  try {
    if (!db) { console.warn('GDrive: no DB connection'); return; }
    let row = await db.query('SELECT gdrive_folder_id FROM quotes WHERE quote_number = $1', [quoteNumber]);
    let dealFolderId = row.rows[0]?.gdrive_folder_id;
    // Retry once after a short delay — folder ID write may not have committed yet
    if (!dealFolderId) {
      await new Promise(r => setTimeout(r, 1500));
      row = await db.query('SELECT gdrive_folder_id FROM quotes WHERE quote_number = $1', [quoteNumber]);
      dealFolderId = row.rows[0]?.gdrive_folder_id;
    }
    if (!dealFolderId) {
      console.warn(`GDrive: no folder ID for quote ${quoteNumber} — skipping upload`);
      writelog('error', 'error.gdrive', `No folder ID for ${quoteNumber} — PDF not uploaded: ${filename}`, { quoteNum: quoteNumber });
      return;
    }

    console.log(`GDrive: uploading "${filename}" to folder ${dealFolderId}`);
    const result = await gdriveUploadFilePdf(filename, pdfBuffer, dealFolderId);
    if (result?.error) {
      console.warn(`GDrive upload error:`, JSON.stringify(result.error));
      writelog('error', 'error.gdrive', `Drive upload failed for ${filename}: ${JSON.stringify(result.error)}`, { quoteNum: quoteNumber });
    } else {
      console.log(`GDrive: uploaded "${filename}" — id:`, result?.id);
    }
  } catch(e) {
    console.warn(`GDrive savePdf error:`, e.message);
    writelog('error', 'error.gdrive', `Drive savePdf threw: ${e.message}`, { quoteNum: quoteNumber });
  }
}

// PDF-specific upload using proper binary multipart
async function gdriveUploadFilePdf(filename, pdfBuffer, parentId) {
  const token = await getGDriveToken();
  if (!token) return null;

  const boundary = 'wr_pdf_' + Date.now();
  const meta = JSON.stringify({ name: filename, parents: [parentId], mimeType: 'application/pdf' });

  // Build multipart body with binary PDF
  const metaPart = Buffer.from(
    `--${boundary}
Content-Type: application/json; charset=UTF-8

${meta}
--${boundary}
Content-Type: application/pdf

`
  );
  const closePart = Buffer.from(`
--${boundary}--`);
  const body = Buffer.concat([metaPart, pdfBuffer, closePart]);

  return new Promise((resolve, reject) => {
    const req = require('https').request({
      hostname: 'www.googleapis.com',
      path: '/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': body.length,
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch(e) { resolve(d); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}


// Generate PDF buffer from an internal page URL (uses Puppeteer)
async function generatePdfBuffer(pageUrl) {
  if (!puppeteer) throw new Error('Puppeteer not available');
  console.log(`GDrive: generating PDF for ${pageUrl}`);
  let browser;
  try {
    browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox',
             '--disable-dev-shm-usage', '--disable-gpu',
             '--single-process', '--no-zygote',
             '--disable-web-security', '--disable-features=IsolateOrigins'],
      defaultViewport: { width: 1200, height: 900 },
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });
    const page = await browser.newPage();
    // Block fonts/images/analytics to speed up load on Railway
    await page.setRequestInterception(true);
    page.on('request', req => {
      const rt = req.resourceType();
      if (['image','media','font'].includes(rt)) { req.abort(); }
      else { req.continue(); }
    });
    await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    await page.addStyleTag({ content: '.action-bar{display:none!important}body{padding-bottom:0!important}' });
    const pdfBuffer = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
    return pdfBuffer;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}


// ── Tracking Status Cache ─────────────────────────────────────────
// Caches AfterShip status in DB, refreshes in background every 30min
// so page loads never hit AfterShip directly

async function initTrackingCache() {
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
  // Add new columns if they don't exist (safe migration)
  await db.query(`ALTER TABLE tracking_cache ADD COLUMN IF NOT EXISTS dest_city TEXT`).catch(()=>{});
  await db.query(`ALTER TABLE tracking_cache ADD COLUMN IF NOT EXISTS dest_state TEXT`).catch(()=>{});
  console.log('Tracking cache ready');
  // Clear entries with bogus delivered_at = today (fallback bug) or no delivered_at
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
  if (!db) return null;
  try {
    const r = await db.query('SELECT * FROM tracking_cache WHERE tracking_number = $1', [trackingNumber]);
    return r.rows[0] || null;
  } catch(e) { return null; }
}

async function saveTrackingToCache(trackingNumber, slug, data) {
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
    const res = await httpsRequest({ hostname: 'www.abfs.com', path: url.replace('https://www.abfs.com', ''), method: 'GET', headers: { 'Accept': 'application/xml' } });
    const xml = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);

    // Parse XML fields with simple regex — ABF returns flat XML
    const get = (tag) => { const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i')); return m ? m[1].trim() : null; };

    const errors = get('NUMERRORS');
    if (errors && errors !== '0') {
      const errMsg = get('ERRORMESSAGE');
      console.warn(`[ABF] tracking error for ${trackingNumber}: ${errMsg}`);
      return null;
    }

    const shortStatus = get('SHORTSTATUS2') || get('SHORTSTATUS') || '';
    const longStatus  = get('LONGSTATUS') || '';

    // Dates — fetch these first so status logic can use them
    const deliveryDate = get('DELIVERYDATE');   // actual delivery (delivered only)
    const deliveryTime = get('DELIVERYTIME');
    const dueDate      = get('DUEDATE');        // scheduled delivery date
    const expectedDate = get('EXPECTEDDELIVERYDATE');
    const pickupDate   = get('PICKUP');
    const pickupTime   = get('PICKUPTIME');

    // Map ABF status codes to normalized status
    let status = 'in_transit', label = 'In Transit';
    const ss = shortStatus.toUpperCase();
    const ls = longStatus.toLowerCase();
    // Use exact short-status code match OR unambiguous past-tense long status
    // IMPORTANT: 'deliver' partial match is too broad — 'out for delivery', 'arrived for delivery' etc.
    // Only mark delivered if short status is exactly 'D' AND there's an actual delivery date,
    // OR the long status unambiguously says 'delivered' (past tense, not 'out for delivery')
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

    // ETA — prefer DUEDATE, fall back to EXPECTEDDELIVERYDATE
    const etaRaw = dueDate || expectedDate || null;
    let eta = null;
    if (etaRaw) {
      // ABF returns dates as MM/DD/YYYY
      try {
        const d = new Date(etaRaw);
        if (!isNaN(d)) eta = d.toISOString().split('T')[0];
      } catch(e) {}
    }

    // Delivery date (only when actually delivered)
    let deliveredAt = null;
    if (status === 'delivered' && deliveryDate) {
      try {
        const d = new Date(deliveryDate);
        if (!isNaN(d)) deliveredAt = d.toISOString().split('T')[0];
      } catch(e) {}
    }

    // Signature
    const sigFirst = get('DELIVSIGFIRSTNAME') || '';
    const sigLast  = get('DELIVSIGLASTNAME')  || '';
    const signedBy = [sigFirst, sigLast].filter(Boolean).join(' ') || null;

    // Destination
    const destCity  = get('CONSIGNEECITY')  || null;
    const destState = get('CONSIGNEESTATE') || null;

    // Build last event from longStatus + pickup info
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
  // WhisperRoom always ships from Morristown TN 37813
  try {
    const pd = pickupDate ? new Date(pickupDate) : new Date();
    const month = String(pd.getMonth() + 1).padStart(2, '0');
    const day   = String(pd.getDate()).padStart(2, '0');
    const year  = String(pd.getFullYear());
    const path  = `/xml/transitxml.asp?DL=2&ID=${encodeURIComponent(apiKey)}&Shipper=Y&OriginZip=37813&OriginCountry=US&DestZip=${encodeURIComponent(destZip)}&DestCountry=US&PickupMonth=${month}&PickupDay=${day}&PickupYear=${year}`;
    const res = await httpsRequest({ hostname: 'www.abfs.com', path, method: 'GET', headers: { 'Accept': 'application/xml' } });
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

  // ── OD: REST API ────────────────────────────────────────────────
  if (carrierUpper === 'OD' || carrierUpper.includes('DOMINION')) {
    const OD_USER = process.env.OD_USER || '';
    const OD_PASS = process.env.OD_PASS || '';
    if (!OD_USER || !OD_PASS) {
      console.warn('[tracking] OD credentials not set');
      return null;
    }
    try {
      console.log(`[tracking] OD API for ${trackingNumber}`);

      // Step 1: Get session token
      const authRes = await httpsRequest({
        hostname: 'api.odfl.com',
        path: '/auth/v1.0/token',
        method: 'GET',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${OD_USER}:${OD_PASS}`).toString('base64'),
          'Accept': 'application/json',
        }
      });

      const token = authRes.body?.access_token || authRes.body?.sessionToken || authRes.body?.token;
      if (!token) {
        console.warn('[tracking] OD auth failed:', JSON.stringify(authRes.body)?.slice(0, 200));
        return null;
      }

      // Step 2: Track shipment
      const trackRes = await httpsRequest({
        hostname: 'api.odfl.com',
        path: '/tracking/v2.0/shipment.track',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        }
      }, {
        referenceType: 'PRO',
        referenceNumber: trackingNumber,
      });

      const data = trackRes.body;
      if (!data || trackRes.status >= 400) {
        console.warn('[tracking] OD track failed:', JSON.stringify(data)?.slice(0, 200));
        return null;
      }

      // Parse response — traceInfo is an array, first element is the shipment
      const trace = Array.isArray(data.traceInfo) ? data.traceInfo[0] : (data.traceInfo || data);
      const events = trace.trackTraceDetail || [];
      // Events are newest-first — index 0 is the most recent
      const latestEvt = events[0];

      // Status from most recent event
      let status = 'in_transit';
      let label = 'In Transit';
      if (latestEvt) {
        const evtStatus = (latestEvt.status || '').toLowerCase();
        if (evtStatus.includes('delivery confirmed') || evtStatus.includes('delivered')) {
          status = 'delivered'; label = 'Delivered';
        } else if (evtStatus.includes('out for delivery')) {
          status = 'out_for_delivery'; label = 'Out for Delivery';
        } else if (evtStatus.includes('arrived at consignee')) {
          status = 'out_for_delivery'; label = 'Out for Delivery';
        } else if (evtStatus.includes('exception')) {
          status = 'exception'; label = 'Exception';
        }
      }

      // Last event — find the most recent one with a city/location for context
      let lastEvent = null;
      let lastEventTime = null;
      const evtWithLocation = events.find(e => e.city && e.state);
      const evtToShow = evtWithLocation || latestEvt;
      if (evtToShow) {
        lastEvent = [evtToShow.status, evtToShow.desc].filter(Boolean).join(' — ') || null;
        if (evtToShow.city && evtToShow.state) {
          lastEvent = lastEvent ? `${lastEvent} (${evtToShow.city}, ${evtToShow.state})` : `${evtToShow.city}, ${evtToShow.state}`;
        }
        lastEventTime = evtToShow.dateTime ? evtToShow.dateTime.split('T')[0] : null;
      }

      // ETA
      const eta = trace.updatedEta || trace.standardEta || null;

      // Destination — use consignee city/state if available
      const destCity  = trace.consigneeCity  || trace.destSvcCity  || null;
      const destState = trace.consigneeState || trace.destSvcState || null;

      // Delivered date — find the actual "Delivered" event
      let deliveredAt = null;
      if (status === 'delivered') {
        const delEvt = events.find(e => (e.status || '').toLowerCase().includes('delivered') && e.dateTime);
        if (delEvt) deliveredAt = delEvt.dateTime.split('T')[0];
      }

      // Delivery signature
      const signedBy = trace.deliverySign || null;

      const cacheData = {
        status, label, lastEvent, lastEventTime,
        eta:         eta ? eta.split('T')[0] : null,
        deliveredAt,
        signedBy,
        location:    destCity ? [destCity, destState].filter(Boolean).join(', ') : null,
        destCity,
        destState,
      };

      await saveTrackingToCache(trackingNumber, 'OD', cacheData);
      console.log(`[tracking] OD ${trackingNumber} → ${label}${lastEvent ? ' | ' + lastEvent.slice(0, 60) : ''}`);
      return cacheData;

    } catch(e) {
      console.warn(`[tracking] OD error (${trackingNumber}): ${e.message}`);
      return null;
    }
  }

  // ── ABF: REST API ────────────────────────────────────────────────
  if (carrierUpper === 'ABF') {
    const ARCBEST_KEY = process.env.ARCBEST_API_KEY || '';
    if (!ARCBEST_KEY) {
      console.warn('[tracking] ARCBEST_API_KEY not set');
      return null;
    }
    console.log(`[tracking] ABF API for ${trackingNumber}`);
    const result = await fetchABFTracking(trackingNumber, ARCBEST_KEY);
    if (!result) return null;

    const cacheData = {
      status:        result.status,
      label:         result.label,
      lastEvent:     result.lastEvent || null,
      lastEventTime: result.lastEventTime || null,
      eta:           result.eta || null,
      deliveredAt:   result.deliveredAt || null,
      signedBy:      result.signedBy || null,
      location:      result.location || null,
      destCity:      result.destCity || null,
      destState:     result.destState || null,
    };

    await saveTrackingToCache(trackingNumber, 'ABF', cacheData);
    console.log(`[tracking] ABF ${trackingNumber} → ${result.label}${result.lastEvent ? ' | ' + result.lastEvent.slice(0, 80) : ''}`);
    return cacheData;
  }

  // ── UPS / FedEx / USPS: use Puppeteer to scrape tracking page ────
  if (['UPS','FEDEX','USPS'].includes(carrierUpper)) {
    if (!puppeteer) {
      await saveTrackingToCache(trackingNumber, carrierUpper, { status: 'pending', label: 'Pending' });
      return { status: 'pending', label: 'Pending' };
    }
    const urlMap = {
      'UPS':   `https://www.ups.com/track?tracknum=${encodeURIComponent(trackingNumber)}&requester=ST/trackdetails`,
      'FEDEX': `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(trackingNumber)}`,
      'USPS':  `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(trackingNumber)}`,
    };
    const trackUrl = urlMap[carrierUpper];
    let browser = null;
    try {
      console.log(`[tracking] ${carrierUpper} scrape for ${trackingNumber}`);
      browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] });
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      await page.goto(trackUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 3000));
      const body = await page.evaluate(() => document.body.innerText);
      const bodyLower = body.toLowerCase();

      let status = 'in_transit', label = 'In Transit';
      if (bodyLower.includes('delivered'))              { status = 'delivered';        label = 'Delivered'; }
      else if (bodyLower.includes('out for delivery'))  { status = 'out_for_delivery'; label = 'Out for Delivery'; }
      else if (bodyLower.includes('in transit') || bodyLower.includes('on the way')) { status = 'in_transit'; label = 'In Transit'; }

      // Try to get a last event line
      const lines = body.split('\n').map(l => l.trim()).filter(l => l.length > 10);
      let lastEvent = null;
      const dateRx = /\d{1,2}\/\d{1,2}\/\d{4}|\w+ \d{1,2},? \d{4}/;
      const evtLine = lines.find(l => dateRx.test(l) && l.length < 200);
      if (evtLine) lastEvent = evtLine;

      const cacheData = { status, label, lastEvent, lastEventTime: null, eta: null,
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

  // ── Other carriers: save pending ─────────────────────────────────
  await saveTrackingToCache(trackingNumber, carrierUpper, { status: 'pending', label: 'Pending' });
  return { status: 'pending', label: 'Pending' };
}

// Background poller — refreshes non-delivered shipments every 30 minutes
async function startTrackingPoller() {
  if (!db) return;
  const poll = async () => {
    try {
      // Get active trackings from HubSpot shipped deals
      const hsRes = await httpsRequest({
        hostname: 'api.hubapi.com',
        path: '/crm/v3/objects/deals/search',
        method: 'POST',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
      }, {
        filterGroups: [{
          filters: [
            { propertyName: 'dealstage', operator: 'EQ', value: '845719' },
            { propertyName: 'tracking_number', operator: 'HAS_PROPERTY' }
          ]
        }],
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

        // Skip delivered shipments that have confirmed delivery date — they're done
        if (cached?.status === 'delivered' && cached?.delivered_at) continue;

        // Skip if refreshed recently — 25 min for active, 4 hours for pending/no data
        if (cached?.updated_at) {
          const age = Date.now() - new Date(cached.updated_at).getTime();
          const minAge = (cached.status && cached.status !== 'pending') ? 25 * 60 * 1000 : 4 * 60 * 60 * 1000;
          if (age < minAge) continue;
        }

        await fetchAndCacheTracking(tracking, carrier);
        refreshed++;
        // 5 second gap between calls (Puppeteer scrapes are resource-heavy)
        await new Promise(r => setTimeout(r, 5000));
      }

      if (refreshed > 0) console.log(`Tracking poller: refreshed ${refreshed} shipments`);
    } catch(e) {
      console.warn('Tracking poller error:', e.message);
      writelog('error', 'error.tracking-poller', `Tracking poller failed: ${e.message}`, {});
    }
  };

  // Run immediately on startup, then every 30 minutes
  setTimeout(poll, 10000); // 10s delay on startup
  setInterval(poll, 30 * 60 * 1000);
  console.log('Tracking poller started (30min interval)');
}

// ── Token validator for public quote/invoice/order links ─────────
function validateShareToken(quoteData, requestedToken) {
  if (!quoteData) return false;
  const storedToken = quoteData._shareToken || quoteData.shareToken;
  if (!storedToken) return true; // legacy quotes without token — allow during transition
  if (!requestedToken) return false;
  return storedToken === requestedToken;
}

// ── Rate limiter for public routes ───────────────────────────────
const rateLimitMap = new Map(); // ip → { count, resetAt }
function checkRateLimit(ip, max=30, windowMs=60000) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}
// Clean up old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 300000);

// Semaphore — only one PDF at a time to stay within Hobby memory limits
let _pdfBusy = false;
async function generatePdf(pageUrl, filename, res, req) {
  if (!puppeteer) {
    res.writeHead(503); res.end('PDF generation not available'); return;
  }
  let waited = 0;
  while (_pdfBusy) {
    await new Promise(r => setTimeout(r, 300));
    waited += 300;
    if (waited > 30000) { res.writeHead(503); res.end('PDF busy — try again'); return; }
  }
  _pdfBusy = true;
  let browser;
  try {
    const cookies = req.headers.cookie || '';
    const sessionCookie = cookies.split(';')
      .map(c => c.trim())
      .find(c => c.startsWith('wr_qt_session=') || c.startsWith('wr_oauth_session='));

    browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox',
             '--disable-dev-shm-usage', '--disable-gpu',
             '--single-process', '--no-zygote'],
      defaultViewport: { width: 1200, height: 900 },
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });

    const page = await browser.newPage();

    if (sessionCookie) {
      const eqIdx = sessionCookie.indexOf('=');
      const name  = sessionCookie.slice(0, eqIdx).trim();
      const value = sessionCookie.slice(eqIdx + 1).trim();
      await page.setCookie({ name, value, domain: 'sales.whisperroom.com', path: '/', httpOnly: true });
    }

    // Block fonts/images to speed up load
    await page.setRequestInterception(true);
    page.on('request', req => {
      const rt = req.resourceType();
      if (['image','media','font'].includes(rt)) { req.abort(); }
      else { req.continue(); }
    });
    await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    await page.addStyleTag({ content: '.action-bar{display:none!important}body{padding-bottom:0!important}' });

    const pdfBuffer = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });

    const asciiName = filename.replace(/[^\x20-\x7E]/g, '-');
    const encodedName = encodeURIComponent(filename);
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
      'Content-Length': pdfBuffer.length,
    });
    res.end(pdfBuffer);
  } finally {
    _pdfBusy = false;
    if (browser) await browser.close().catch(() => {});
  }
}
// ── Fix 3: Catch unhandled crashes — log and keep running ────────────
process.on('uncaughtException', (err) => {
  console.error('[CRASH] uncaughtException:', err.message, err.stack?.split('\n')[1]);
  // Don't exit — Railway will restart if truly unrecoverable
});
process.on('unhandledRejection', (reason) => {
  console.error('[CRASH] unhandledRejection:', reason?.message || reason);
});

// ── Fix 4: Detect HubSpot 401 and force re-auth ──────────────────────
// Wrap httpsRequest responses — if HubSpot returns 401, invalidate session
async function hsRequest(options, body, rawBody) {
  const res = await httpsRequest(options, body, rawBody);
  if (res.status === 401 && options.hostname === 'api.hubapi.com') {
    console.warn('[HubSpot] 401 received — private app token may be expired');
    // Don't throw — let callers handle gracefully
  }
  return res;
}


let Pool, db;
try {
  Pool = require('pg').Pool;
  if (process.env.DATABASE_URL) {
    db = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 10,                  // max concurrent connections
      idleTimeoutMillis: 30000, // close idle connections after 30s
      connectionTimeoutMillis: 5000, // fail fast if can't connect
    });
    console.log('PostgreSQL connected');
  } else {
    console.log('No DATABASE_URL — using HubSpot Notes for history');
  }
} catch(e) {
  console.log('pg module not available — using HubSpot Notes for history');
  db = null;
}

async function initDb() {
  try {
    // Migrations — add columns if they don't exist yet
    await db.query(`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS payment_link  TEXT`).catch(() => {});
    await db.query(`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS order_link    TEXT`).catch(() => {});
    await db.query(`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS share_token      TEXT`).catch(() => {});
    await db.query(`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS gdrive_folder_id TEXT`).catch(() => {});
    // Backfill share tokens for existing quotes (using Node crypto — no pgcrypto needed)
    // (handled below in the per-row backfill loop)

    await db.query(`
      CREATE TABLE IF NOT EXISTS quotes (
        id            SERIAL PRIMARY KEY,
        quote_number  TEXT UNIQUE NOT NULL,
        deal_id       TEXT,
        contact_id    TEXT,
        deal_name     TEXT,
        customer_name TEXT,
        company       TEXT,
        rep_id        TEXT,
        total         NUMERIC(12,2),
        date          TEXT,
        quote_link    TEXT,
        json_snapshot JSONB NOT NULL,
        payment_link  TEXT,
        order_link    TEXT,
        share_token      TEXT,
        gdrive_folder_id TEXT,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_quotes_quote_number ON quotes(quote_number)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_quotes_deal_id      ON quotes(deal_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_quotes_contact_id   ON quotes(contact_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_quotes_rep_id       ON quotes(rep_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_quotes_created_at   ON quotes(created_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_quotes_company      ON quotes(lower(company))`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_quotes_customer_name ON quotes(lower(customer_name))`);
    // Sessions table for persistent auth (survives redeploys)
    await db.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        token      TEXT PRIMARY KEY,
        email      TEXT,
        name       TEXT,
        owner_id   TEXT,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(()=>{});
    await db.query(`CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`).catch(()=>{});
    // Clean expired sessions on startup
    await db.query(`DELETE FROM sessions WHERE expires_at < NOW()`).catch(()=>{});

    // Notifications table
    await db.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id         SERIAL PRIMARY KEY,
        owner_id   TEXT NOT NULL,
        type       TEXT NOT NULL,
        title      TEXT NOT NULL,
        body       TEXT,
        deal_id    TEXT,
        deal_name  TEXT,
        quote_num  TEXT,
        read       BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(()=>{});
    await db.query(`CREATE INDEX IF NOT EXISTS idx_notif_owner ON notifications(owner_id, read, created_at DESC)`).catch(()=>{});

    // Logs table — activity + error feed
    await db.query(`
      CREATE TABLE IF NOT EXISTS logs (
        id        SERIAL PRIMARY KEY,
        at        TIMESTAMPTZ DEFAULT NOW(),
        level     TEXT NOT NULL DEFAULT 'info',
        event     TEXT NOT NULL,
        rep       TEXT,
        quote_num TEXT,
        deal_id   TEXT,
        deal_name TEXT,
        message   TEXT NOT NULL,
        meta      JSONB
      )
    `).catch(()=>{});
    await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_at    ON logs(at DESC)`).catch(()=>{});
    await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level, at DESC)`).catch(()=>{});
    await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_event ON logs(event, at DESC)`).catch(()=>{});

    // Logs table — activity + error feed
    await db.query(`
      CREATE TABLE IF NOT EXISTS logs (
        id        SERIAL PRIMARY KEY,
        at        TIMESTAMPTZ DEFAULT NOW(),
        version   TEXT,
        level     TEXT NOT NULL DEFAULT 'info',
        event     TEXT NOT NULL,
        rep       TEXT,
        quote_num TEXT,
        deal_id   TEXT,
        deal_name TEXT,
        message   TEXT NOT NULL,
        meta      JSONB
      )
    `).catch(() => {});
    await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_at    ON logs(at DESC)`).catch(() => {});
    await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level, at DESC)`).catch(() => {});

    console.log('Database ready');
    await initTrackingCache();
    startTrackingPoller();
    // Clean expired sessions every hour
    setInterval(async () => {
      try { await db.query('DELETE FROM sessions WHERE expires_at < NOW()'); }
      catch(e) { /* non-fatal */ }
    }, 3600000);

    // Backfill missing share tokens for any old quotes
    try {
      const missing = await db.query(
        `SELECT id FROM quotes WHERE share_token IS NULL OR share_token = ''`
      );
      if (missing.rows.length > 0) {
        for (const row of missing.rows) {
          const tok = require('crypto').randomBytes(6).toString('hex');
          await db.query(`UPDATE quotes SET share_token = $1 WHERE id = $2`, [tok, row.id]);
        }
        console.log(`[startup] backfilled share tokens for ${missing.rows.length} quotes`);
      }
    } catch(e) { console.warn('[startup] token backfill error:', e.message); }
  } catch(e) {
    console.warn('DB init skipped (no DATABASE_URL?):', e.message);
  }
}







// Rep notified via HubSpot task

const SERVER_REP_NUMBERS = {
  '36303670':  '16', // Benton White
  '38732178':  '17', // Kim Dalton
  '36330944':  '11', // Jill Holdway
  '38143901':  '18', // Sarah Smith
  '117442978': '13', // Travis Singleton
  '36320208':  '19', // Gabe White
};

// Generate a quote number that doesn't already exist in the DB.
// Starts from the client-provided number's sequence and increments until free.
async function generateFreeQuoteNumber(clientNumber, ownerId, dealId, contactId) {
  if (!db) return clientNumber; // no DB — fall back to client number
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const yy = String(now.getFullYear()).slice(-2);
  const repNum = SERVER_REP_NUMBERS[String(ownerId)] || '00';
  const dateKey = repNum + mm + dd + yy;

  // Parse starting seq from client number, default to 1
  let seq = 1;
  if (clientNumber) {
    const suffix = clientNumber.replace(/^W-/, '').replace(dateKey, '');
    const parsed = parseInt(suffix);
    if (!isNaN(parsed) && parsed > 0) seq = parsed;
  }

  // Try seq, seq+1, seq+2 ... until we find one not taken by a different deal/contact
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = `W-${dateKey}${String(seq).padStart(2, '0')}`;
    const existing = await db.query(
      `SELECT deal_id, contact_id FROM quotes WHERE quote_number = $1 LIMIT 1`,
      [candidate]
    );
    if (existing.rows.length === 0) return candidate; // free
    const ex = existing.rows[0];
    const sameDeal    = dealId    && ex.deal_id    && ex.deal_id    === dealId;
    const sameContact = contactId && ex.contact_id && ex.contact_id === contactId;
    if (sameDeal || sameContact) return candidate; // revision of same deal — OK
    seq++; // collision with different deal — try next
  }
  // Fallback: timestamp-based to guarantee uniqueness
  return `W-${dateKey}${String(Date.now()).slice(-4)}`;
}

async function saveQuoteToDb(quoteData) {
  if (!db || !process.env.DATABASE_URL) return null;
  try {
    const { quoteNumber, dealId, contactId, dealName, customer, total, date, ownerId } = quoteData;
    const customerName = customer ? [customer.firstName, customer.lastName].filter(Boolean).join(' ') : '';
    const company = customer ? (customer.company || '') : '';
    const quoteLink = quoteNumber ? `https://sales.whisperroom.com/q/${quoteNumber}` : null;

    // ── Collision guard ─────────────────────────────────────────────
    // Check if this quote number already exists for a DIFFERENT deal or contact
    // Legitimate revisions share the same deal_id — those are fine to update
    if (quoteNumber) {
      const existing = await db.query(
        `SELECT deal_id, contact_id, customer_name FROM quotes WHERE quote_number = $1 LIMIT 1`,
        [quoteNumber]
      );
      if (existing.rows.length > 0) {
        const ex = existing.rows[0];
        const sameDeal    = dealId    && ex.deal_id    && ex.deal_id    === dealId;
        const sameContact = contactId && ex.contact_id && ex.contact_id === contactId;
        // If neither deal nor contact matches — this is a collision, not a revision
        if (!sameDeal && !sameContact) {
          console.error(`[saveQuoteToDb] COLLISION: quote ${quoteNumber} already exists for "${ex.customer_name}" (deal ${ex.deal_id}). Rejecting save.`);
          throw new Error(`Quote number ${quoteNumber} already exists for a different customer. Please refresh and push again to get a new number.`);
        }
      }
    }
    // ── End collision guard ─────────────────────────────────────────

    const res = await db.query(`
      INSERT INTO quotes
        (quote_number, deal_id, contact_id, deal_name, customer_name, company, rep_id, total, date, quote_link, json_snapshot, share_token)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (quote_number) DO UPDATE SET
        deal_id       = EXCLUDED.deal_id,
        contact_id    = EXCLUDED.contact_id,
        deal_name     = EXCLUDED.deal_name,
        customer_name = EXCLUDED.customer_name,
        company       = EXCLUDED.company,
        rep_id        = EXCLUDED.rep_id,
        total         = EXCLUDED.total,
        date          = EXCLUDED.date,
        quote_link    = EXCLUDED.quote_link,
        payment_link  = COALESCE(EXCLUDED.payment_link, quotes.payment_link),
        order_link    = COALESCE(EXCLUDED.order_link, quotes.order_link),
        share_token   = COALESCE(quotes.share_token, EXCLUDED.share_token),
        json_snapshot = EXCLUDED.json_snapshot
      RETURNING id
    `, (() => {
      // Strip shareToken from snapshot — DB column is sole source of truth
      const { shareToken: _s1, _shareToken: _s2, ...snapData } = quoteData;
      return [
        quoteNumber, dealId || null, contactId || null, dealName || null,
        customerName, company, ownerId || null,
        total ? parseFloat(total) : null,
        date || null, quoteLink, JSON.stringify(snapData),
        quoteData.shareToken || require('crypto').randomBytes(6).toString('hex')
      ];
    })());

    return res.rows[0]?.id;
  } catch(e) {
    console.warn('DB save failed:', e.message);
    return null;
  }
}

async function getQuoteFromDb(quoteNumber) {
  if (!db || !process.env.DATABASE_URL) return null;
  try {
    const res = await db.query(
      'SELECT json_snapshot, share_token, deal_id FROM quotes WHERE quote_number = $1',
      [quoteNumber]
    );
    if (res.rows.length === 0) return null;
    if (!res.rows[0]) return null;
    const snap = res.rows[0].json_snapshot || {};
    snap._shareToken = res.rows[0].share_token;
    // Ensure dealId is populated from DB column (more reliable than snapshot)
    if (res.rows[0].deal_id && !snap.dealId) {
      snap.dealId = res.rows[0].deal_id;
    }
    return snap;
  } catch(e) {
    console.warn('DB get failed:', e.message);
    return null;
  }
}

async function searchQuotesInDb(query, repId, limit = 100, offset = 0) {
  if (!db || !process.env.DATABASE_URL) return null;
  try {
    let where = 'WHERE 1=1';
    const params = [];
    let p = 1;

    if (query) {
      params.push(`%${query.toLowerCase()}%`);
      where += ` AND (lower(customer_name) LIKE $${p} OR lower(company) LIKE $${p} OR lower(deal_name) LIKE $${p} OR quote_number LIKE $${p})`;
      p++;
    }
    if (repId) {
      params.push(repId);
      where += ` AND rep_id = $${p}`;
      p++;
    }

    params.push(limit, offset);
    const res = await db.query(`
      SELECT id, quote_number, deal_id, deal_name, customer_name, company, rep_id, total, date, quote_link, share_token, created_at, json_snapshot
      FROM quotes
      ${where}
      ORDER BY created_at DESC
      LIMIT $${p} OFFSET $${p+1}
    `, params);

    const countRes = await db.query(`SELECT COUNT(*) FROM quotes ${where}`, params.slice(0, p-1));
    return { results: res.rows, total: parseInt(countRes.rows[0].count) };
  } catch(e) {
    console.warn('DB search failed:', e.message);
    return null;
  }
}

// ── Quote History via HubSpot Notes ──────────────────────────────
async function fetchQuoteHistory() {
  // DB-only — notes system removed
  if (!db) return [];
  try {
    const res = await db.query(`
      SELECT quote_number, deal_id, deal_name, customer_name, company,
             rep_id, total, date, quote_link, share_token, json_snapshot, created_at
      FROM quotes ORDER BY created_at DESC LIMIT 200
    `);
    return res.rows.map(r => {
      const snap = r.json_snapshot || {};
      return {
        id:          snap.id || r.quote_number,
        quoteNumber: r.quote_number,
        dealId:      r.deal_id,
        dealName:    r.deal_name,
        customer: {
          firstName: r.customer_name?.split(' ')[0] || '',
          lastName:  r.customer_name?.split(' ').slice(1).join(' ') || '',
          company:   r.company || '',
          ...snap.customer,
        },
        ownerId:    r.rep_id,
        total:      r.total,
        date:       r.date,
        quoteLink:  r.quote_link,
        shareToken: r.share_token,   // DB column wins — not overwritten by snapshot
        savedAt:    r.created_at,
        // Spread snapshot but never let it overwrite shareToken
        ...snap,
        shareToken: r.share_token,   // Re-assert after spread
      };
    });
  } catch(e) {
    console.warn('fetchQuoteHistory:', e.message);
    return [];
  }
}

const PORT         = process.env.PORT || 3457;
const PASSWORD     = process.env.WR_PASSWORD || '';
const HS_TOKEN     = process.env.HS_TOKEN || '';
const APP_VERSION  = (() => { try { return require('./package.json').version; } catch(e) { return '1.0.0'; } })();

// ── Activity + Error Logger ───────────────────────────────────────
// setImmediate defers the DB write until after the response is sent.
// A failure here CANNOT affect any request — fully isolated.
function writelog(level, event, message, opts) {
  setImmediate(() => {
    if (!db) return;
    const o = opts || {};
    db.query(
      `INSERT INTO logs (version,level,event,rep,quote_num,deal_id,deal_name,message,meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ APP_VERSION, level, event,
        o.rep      || null,
        o.quoteNum || null,
        o.dealId   || null,
        o.dealName || null,
        message,
        o.meta ? JSON.stringify(o.meta) : null ]
    ).catch(() => {});
  });
}

// ── Products cache (avoids hammering HubSpot on every price book open) ──
let _productsCache     = null;
let _productsCacheTime = 0;
const PRODUCTS_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

async function fetchAllProducts() {
  let all = [], after = null, page = 0;
  do {
    let path = '/crm/v3/objects/products?limit=100&properties=name,price,description,weight,hs_sku,category';
    if (after) path += `&after=${encodeURIComponent(after)}`;
    const r = await httpsRequest({
      hostname: 'api.hubapi.com', path, method: 'GET',
      headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
    });
    const results = r.body?.results || [];
    all.push(...results);
    after = r.body?.paging?.next?.after || null;
    page++;
    if (!after || results.length === 0) break;
  } while (page < 20);
  all.sort((a,b) => (a.properties?.name||'').localeCompare(b.properties?.name||''));
  console.log(`[products cache] loaded ${all.length} products`);
  return all;
}

async function getProductsCached() {
  const now = Date.now();
  if (_productsCache && (now - _productsCacheTime) < PRODUCTS_CACHE_TTL) {
    return _productsCache;
  }
  _productsCache = await fetchAllProducts();
  _productsCacheTime = Date.now();
  return _productsCache;
}

// Warm cache on startup (after a short delay to let DB connect first)
setTimeout(async () => {
  if (!HS_TOKEN) return;
  try { await getProductsCached(); }
  catch(e) { console.warn('[products cache] warm failed:', e.message); }
}, 8000);

// Auto-refresh every 15 minutes
setInterval(async () => {
  if (!HS_TOKEN) return;
  try {
    _productsCache = await fetchAllProducts();
    _productsCacheTime = Date.now();
  } catch(e) { console.warn('[products cache] refresh failed:', e.message); }
}, PRODUCTS_CACHE_TTL);



const REPS = {
  '36330944':'Jill','38143901':'Sarah','117442978':'Travis',
  '36303670':'Benton','36320208':'Gabe','38732178':'Kim',
  '38900892':'Chet','38732186':'Jeromy'
};

// Rep email addresses for notifications
const REP_EMAILS = {
  '36330944': 'jill@whisperroom.com',
  '38143901': 'sarah@whisperroom.com',
  '117442978':'travis@whisperroom.com',
  '36303670': 'bentonwhite@whisperroom.com',
  '36320208': 'gabe@whisperroom.com',
  '38732178': 'kim@whisperroom.com',
  '38900892': 'chet@whisperroom.com',
  '38732186': 'jeromy@whisperroom.com',
};

async function createNotification(ownerId, type, title, body, { dealId, dealName, quoteNum } = {}) {
  if (!db || !ownerId) return;
  try {
    await db.query(
      `INSERT INTO notifications (owner_id, type, title, body, deal_id, deal_name, quote_num)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [String(ownerId), type, title, body || null, dealId || null, dealName || null, quoteNum || null]
    );
  } catch(e) { console.warn('[notify] DB insert failed:', e.message); }
}

async function notifyRep(ownerId, subject, bodyText, meta = {}) {
  if (!ownerId) return;
  // Create internal notification
  await createNotification(ownerId, meta.type || 'info', subject, bodyText, meta);
  // Log email intent (add SMTP later if needed)
  const email = REP_EMAILS[String(ownerId)];
  if (email) console.log(`[notify] ${email} — ${subject}`);
}

const TAXJAR_KEY   = process.env.TAXJAR_KEY || '';
const ABF_ID       = 'Q8MZK7K1';
const ABF_ACCT     = '189059-248A';
const SHIP_CITY    = 'Morristown';
const SHIP_STATE   = 'TN';
const SHIP_ZIP     = '37813';
const NMFC_ITEM    = '027880';
const NMFC_SUB     = '02';
const FREIGHT_CLASS = '100';

const sessions      = new Set();       // password sessions (kept in-memory, rarely used)
const oauthStates   = new Set();       // CSRF state tokens (short-lived, in-memory is fine)

// DB-backed session helpers
async function dbSessionSet(token, data) {
  if (!db) return;
  try {
    await db.query(
      `INSERT INTO sessions (token, email, name, owner_id, expires_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (token) DO UPDATE SET expires_at=$5`,
      [token, data.email||'', data.name||'', data.ownerId||null, new Date(data.expiresAt)]
    );
  } catch(e) { console.warn('dbSessionSet:', e.message); }
}
async function dbSessionGet(token) {
  if (!db) return null;
  try {
    const r = await db.query(
      'SELECT email, name, owner_id, expires_at FROM sessions WHERE token=$1 AND expires_at > NOW()',
      [token]
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    return { email: row.email, name: row.name, ownerId: row.owner_id, expiresAt: new Date(row.expires_at).getTime() };
  } catch(e) { return null; }
}
async function dbSessionDelete(token) {
  if (!db) return;
  try { await db.query('DELETE FROM sessions WHERE token=$1', [token]); } catch(e) {}
}

// In-memory cache to avoid DB hit on every request (cleared on expiry)
const _sessionCache = new Map();

function isAuth(req) {
  const c = parseCookies(req);
  // Password session (in-memory fallback)
  if (c.wr_qt_session && sessions.has(c.wr_qt_session)) return true;
  // OAuth session — check cache first, then DB
  if (c.wr_oauth_session) {
    const cached = _sessionCache.get(c.wr_oauth_session);
    if (cached) {
      if (cached.expiresAt > Date.now()) return true;
      _sessionCache.delete(c.wr_oauth_session);
    }
    // Will be resolved async — optimistic true if token exists in cache
    return _sessionCache.has(c.wr_oauth_session);
  }
  return false;
}

async function isAuthAsync(req) {
  const c = parseCookies(req);
  if (c.wr_qt_session && sessions.has(c.wr_qt_session)) return true;
  if (c.wr_oauth_session) {
    // Check memory cache
    const cached = _sessionCache.get(c.wr_oauth_session);
    if (cached && cached.expiresAt > Date.now()) return true;
    // Check DB
    const sess = await dbSessionGet(c.wr_oauth_session);
    if (sess) { _sessionCache.set(c.wr_oauth_session, sess); return true; }
  }
  return false;
}

function getSession(req) {
  const c = parseCookies(req);
  if (c.wr_oauth_session) {
    const cached = _sessionCache.get(c.wr_oauth_session);
    if (cached && cached.expiresAt > Date.now()) return cached;
  }
  return null;
}

async function getSessionAsync(req) {
  const c = parseCookies(req);
  if (c.wr_oauth_session) {
    const cached = _sessionCache.get(c.wr_oauth_session);
    if (cached && cached.expiresAt > Date.now()) return cached;
    const sess = await dbSessionGet(c.wr_oauth_session);
    if (sess) { _sessionCache.set(c.wr_oauth_session, sess); return sess; }
  }
  return null;
}

// Quick helper — returns ownerId string for writelog rep field, never throws
// Accepts optional pre-parsed body so error handlers can pass ownerId directly
function getRepFromReq(req, body) {
  try {
    const fromSession = getSession(req)?.ownerId || null;
    if (fromSession) return fromSession;
    // Fall back to ownerId in pre-parsed body (available in route error handlers)
    if (body?.ownerId) return String(body.ownerId);
    return null;
  } catch(e) { return null; }
}


const HS_CLIENT_ID     = process.env.HS_CLIENT_ID     || '';
const HS_CLIENT_SECRET = process.env.HS_CLIENT_SECRET || '';
const HS_REDIRECT_URI  = process.env.HS_REDIRECT_URI  || 'https://sales.whisperroom.com/auth/callback';

// ── Nexus states (freight taxability per state) ───────────────────
const NEXUS_STATES = {
  AZ: { taxFreight: true  },
  CA: { taxFreight: true  },
  CO: { taxFreight: true  },
  FL: { taxFreight: false },
  GA: { taxFreight: false },
  IL: { taxFreight: true  },
  MA: { taxFreight: false },
  NC: { taxFreight: true  },
  OH: { taxFreight: true  },
  PA: { taxFreight: true  },
  TN: { taxFreight: true  },
  TX: { taxFreight: true  },
  UT: { taxFreight: true  },
  VA: { taxFreight: false },
  WI: { taxFreight: true  },
  WA: { taxFreight: true  },
};

// ── HTTPS helper ──────────────────────────────────────────────────
function httpsRequest(options, body, rawBody) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error(`HubSpot API timeout: ${options.path?.slice(0,60)}`));
    });
    req.on('error', reject);
    if (rawBody) req.write(rawBody);
    else if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function httpsGet(urlStr, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(urlStr, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('Freight API request timed out after 15 seconds'));
    });
  });
}

// ── HubSpot API ───────────────────────────────────────────────────
async function hsSearchProducts(query, limit = 100, offset = 0) {
  const body = {
    limit,
    after: offset,
    properties: ['name', 'price', 'hs_sku', 'description', 'weight', 'category'],
    sorts: [{ propertyName: 'name', direction: 'ASCENDING' }]
  };
  if (query && query.trim()) body.query = query.trim();
  const res = await httpsRequest({
    hostname: 'api.hubapi.com',
    path: '/crm/v3/objects/products/search',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  }, body);
  return res.body;
}

// Search deals by name
async function hsSearchDeals(query) {
  const body = {
    query: query.trim(),
    limit: 10,
    properties: ['dealname', 'dealstage', 'amount', 'hubspot_owner_id', 'pipeline', 'closedate'],
    sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }]
  };
  const res = await httpsRequest({
    hostname: 'api.hubapi.com',
    path: '/crm/v3/objects/deals/search',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  }, body);
  return res.body;
}

// Bidirectional state lookup
const STATE_ABBR_MAP = {
  'alabama':'AL','alaska':'AK','arizona':'AZ','arkansas':'AR','california':'CA',
  'colorado':'CO','connecticut':'CT','delaware':'DE','florida':'FL','georgia':'GA',
  'hawaii':'HI','idaho':'ID','illinois':'IL','indiana':'IN','iowa':'IA',
  'kansas':'KS','kentucky':'KY','louisiana':'LA','maine':'ME','maryland':'MD',
  'massachusetts':'MA','michigan':'MI','minnesota':'MN','mississippi':'MS',
  'missouri':'MO','montana':'MT','nebraska':'NE','nevada':'NV','new hampshire':'NH',
  'new jersey':'NJ','new mexico':'NM','new york':'NY','north carolina':'NC',
  'north dakota':'ND','ohio':'OH','oklahoma':'OK','oregon':'OR','pennsylvania':'PA',
  'rhode island':'RI','south carolina':'SC','south dakota':'SD','tennessee':'TN',
  'texas':'TX','utah':'UT','vermont':'VT','virginia':'VA','washington':'WA',
  'west virginia':'WV','wisconsin':'WI','wyoming':'WY','washington dc':'DC',
  'alberta':'AB','british columbia':'BC','manitoba':'MB','new brunswick':'NB',
  'newfoundland and labrador':'NL','newfoundland':'NL','nova scotia':'NS',
  'ontario':'ON','prince edward island':'PE','quebec':'QC','saskatchewan':'SK',
};

const STATE_FULL_NAME = {
  'AL':'Alabama','AK':'Alaska','AZ':'Arizona','AR':'Arkansas','CA':'California',
  'CO':'Colorado','CT':'Connecticut','DE':'Delaware','FL':'Florida','GA':'Georgia',
  'HI':'Hawaii','ID':'Idaho','IL':'Illinois','IN':'Indiana','IA':'Iowa',
  'KS':'Kansas','KY':'Kentucky','LA':'Louisiana','ME':'Maine','MD':'Maryland',
  'MA':'Massachusetts','MI':'Michigan','MN':'Minnesota','MS':'Mississippi',
  'MO':'Missouri','MT':'Montana','NE':'Nebraska','NV':'Nevada','NH':'New Hampshire',
  'NJ':'New Jersey','NM':'New Mexico','NY':'New York','NC':'North Carolina',
  'ND':'North Dakota','OH':'Ohio','OK':'Oklahoma','OR':'Oregon','PA':'Pennsylvania',
  'RI':'Rhode Island','SC':'South Carolina','SD':'South Dakota','TN':'Tennessee',
  'TX':'Texas','UT':'Utah','VT':'Vermont','VA':'Virginia','WA':'Washington',
  'WV':'West Virginia','WI':'Wisconsin','WY':'Wyoming','DC':'Washington DC',
  'AB':'Alberta','BC':'British Columbia','MB':'Manitoba','NB':'New Brunswick',
  'NL':'Newfoundland and Labrador','NS':'Nova Scotia','ON':'Ontario',
  'PE':'Prince Edward Island','QC':'Quebec','SK':'Saskatchewan',
};

// Always returns 2-letter abbreviation - used for freight/tax APIs
function toStateAbbr(val) {
  if (!val) return '';
  const trimmed = val.trim();
  if (trimmed.length === 2) return trimmed.toUpperCase();
  return STATE_ABBR_MAP[trimmed.toLowerCase()] || trimmed.toUpperCase();
}

// Always returns full name - used for HubSpot contact creation
function toStateFull(val) {
  if (!val) return '';
  const trimmed = val.trim();
  // Already a full name
  if (trimmed.length > 2) {
    // Capitalize properly and return as-is if not in our map
    const lower = trimmed.toLowerCase();
    const abbr = STATE_ABBR_MAP[lower];
    if (abbr) return STATE_FULL_NAME[abbr] || trimmed;
    return trimmed;
  }
  // It's an abbreviation
  const upper = trimmed.toUpperCase();
  return STATE_FULL_NAME[upper] || trimmed;
}

// Returns true if the state/province abbreviation is Canadian
function isCanadianProvince(stateAbbr) {
  const CA_PROVINCES = new Set(['AB','BC','MB','NB','NL','NS','ON','PE','QC','SK','NT','NU','YT']);
  return CA_PROVINCES.has((stateAbbr || '').toUpperCase().trim());
}
async function hsSearchContacts(query) {
  const body = {
    query: query.trim(),
    limit: 10,
    properties: ['firstname', 'lastname', 'email', 'phone', 'company', 'address', 'city', 'state', 'zip'],
    sorts: [{ propertyName: 'lastname', direction: 'ASCENDING' }]
  };
  const res = await httpsRequest({
    hostname: 'api.hubapi.com',
    path: '/crm/v3/objects/contacts/search',
    method: 'POST',
    headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
  }, body);

  if (!res.body || !res.body.results) return res.body;

  // For contacts missing company name, fetch associated company
  const enriched = await Promise.all(res.body.results.map(async contact => {
    if (contact.properties.company) return contact;
    try {
      const assoc = await httpsRequest({
        hostname: 'api.hubapi.com',
        path: `/crm/v3/objects/contacts/${contact.id}/associations/companies`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
      });
      if (assoc.body && assoc.body.results && assoc.body.results.length > 0) {
        const companyId = assoc.body.results[0].id;
        const company = await httpsRequest({
          hostname: 'api.hubapi.com',
          path: `/crm/v3/objects/companies/${companyId}?properties=name`,
          method: 'GET',
          headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
        });
        if (company.body && company.body.properties && company.body.properties.name) {
          contact.properties.company = company.body.properties.name;
        }
      }
    } catch(e) {}
    return contact;
  }));

  return { ...res.body, results: enriched };
}

// Get deal with associated contact and owner
async function hsGetDealWithDetails(dealId) {
  const deal = await httpsRequest({
    hostname: 'api.hubapi.com',
    path: `/crm/v3/objects/deals/${dealId}?properties=dealname,hubspot_owner_id,dealstage,amount`,
    method: 'GET',
    headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
  });

  if (!deal.body || !deal.body.id) return null;

  // Get associated contacts
  let contact = null;
  try {
    const assoc = await httpsRequest({
      hostname: 'api.hubapi.com',
      path: `/crm/v3/objects/deals/${dealId}/associations/contacts`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
    });
    if (assoc.body && assoc.body.results && assoc.body.results.length > 0) {
      const contactId = assoc.body.results[0].id;
      const contactRes = await httpsRequest({
        hostname: 'api.hubapi.com',
        path: `/crm/v3/objects/contacts/${contactId}?properties=firstname,lastname,email,phone,company,address,city,state,zip`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
      });
      if (contactRes.body && contactRes.body.properties) {
        contact = contactRes.body;
        // Fetch company if missing
        if (!contact.properties.company) {
          const compAssoc = await httpsRequest({
            hostname: 'api.hubapi.com',
            path: `/crm/v3/objects/contacts/${contactId}/associations/companies`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
          });
          if (compAssoc.body && compAssoc.body.results && compAssoc.body.results.length > 0) {
            const compRes = await httpsRequest({
              hostname: 'api.hubapi.com',
              path: `/crm/v3/objects/companies/${compAssoc.body.results[0].id}?properties=name`,
              method: 'GET',
              headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
            });
            if (compRes.body && compRes.body.properties && compRes.body.properties.name) {
              contact.properties.company = compRes.body.properties.name;
            }
          }
        }
      }
    }
  } catch(e) {}

  return { deal: deal.body, contact };
}

async function hsCreateContact(data) {
  const res = await httpsRequest({
    hostname: 'api.hubapi.com',
    path: '/crm/v3/objects/contacts',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  }, { properties: data });
  return res.body;
}

async function hsSearchContact(email) {
  const body = {
    filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
    properties: ['firstname', 'lastname', 'email', 'phone', 'company', 'address', 'city', 'state', 'zip', 'hubspot_owner_id'],
    limit: 1
  };
  const res = await httpsRequest({
    hostname: 'api.hubapi.com',
    path: '/crm/v3/objects/contacts/search',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  }, body);
  return res.body;
}

async function hsCreateDeal(data) {
  const res = await httpsRequest({
    hostname: 'api.hubapi.com',
    path: '/crm/v3/objects/deals',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  }, { properties: data });
  return res.body;
}

async function hsCreateLineItem(data) {
  const res = await httpsRequest({
    hostname: 'api.hubapi.com',
    path: '/crm/v3/objects/line_items',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  }, { properties: data });
  return res.body;
}

async function hsAssociate(fromType, fromId, toType, toId, assocType) {
  const res = await httpsRequest({
    hostname: 'api.hubapi.com',
    path: `/crm/v3/objects/${fromType}/${fromId}/associations/${toType}/${toId}/${assocType}`,
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${HS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
  return res;
}

async function hsBatchAssociateLineItems(dealId, lineItemIds) {
  const inputs = lineItemIds.map(id => ({
    from: { id: String(id) },
    to: { id: String(dealId) },
    type: 'line_item_to_deal'
  }));
  const res = await httpsRequest({
    hostname: 'api.hubapi.com',
    path: '/crm/v3/associations/line_items/deals/batch/create',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  }, { inputs });
  return res.body;
}

// Fetch and delete all existing line items on a deal — call before creating new ones
async function hsClearDealLineItems(dealId) {
  try {
    // Fetch associated line item IDs
    const assocRes = await httpsRequest({
      hostname: 'api.hubapi.com',
      path: `/crm/v3/objects/deals/${dealId}/associations/line_items`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
    });
    const ids = (assocRes.body?.results || []).map(r => r.id).filter(Boolean);
    if (!ids.length) return;
    // Batch delete all line items
    await httpsRequest({
      hostname: 'api.hubapi.com',
      path: '/crm/v3/objects/line_items/batch/archive',
      method: 'POST',
      headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
    }, { inputs: ids.map(id => ({ id: String(id) })) });
    console.log(`[line items] cleared ${ids.length} from deal ${dealId}`);
  } catch(e) {
    console.warn(`[line items] clear failed for deal ${dealId}: ${e.message}`);
  }
}
// Build consistent PDF filename: "Company Label QuoteNumber (Type).pdf"
function buildPdfFilename(quoteData, quoteNumber, type) {
  const c = quoteData?.customer || {};
  const company = (c.company || '').trim();
  const name = company || [c.firstName, c.lastName].filter(Boolean).join(' ');
  const label = (quoteData?.quoteLabel || '').trim();
  const parts = [name, label, quoteNumber].filter(Boolean);
  const safe = parts.join(' ').replace(/[/\\:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
  return type ? `${safe} (${type}).pdf` : `${safe}.pdf`;
}
async function calculateTaxProper(toState, toZip, toCity, amount, shipping, toStreet = '') {
  const stateUpper = toStateAbbr(toState);
  const inNexus = NEXUS_STATES[stateUpper];
  if (!inNexus) return { tax: 0, rate: 0, inNexus: false };

  // TaxJar requires at minimum: to_state + to_zip
  // City and street improve accuracy but are not required
  if (!toZip) {
    console.warn(`[tax] no zip for ${stateUpper} — cannot calculate`);
    return { tax: 0, rate: 0, inNexus: true, error: 'No zip code provided' };
  }

  const taxableShipping = inNexus.taxFreight ? shipping : 0;
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

  console.log(`[tax] calculating for ${toCity||'(no city)'}, ${stateUpper} ${toZip} — amount: ${amount}, shipping: ${taxableShipping}`);

  console.log(`[tax] sending to TaxJar:`, JSON.stringify(body));

  const res = await httpsRequest({
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

// ── ABF Freight ───────────────────────────────────────────────────
function buildAbfUrl(pallets, totalWeight, consCity, consState, consZip, isCanadian, accessories, servType) {
  const today = new Date();
  // Strip spaces from postal code — Canadian codes often entered as "M4W 1B7"
  const cleanZip = (consZip || '').replace(/\s+/g, '');
  // Canadian shipments use different NMFC codes
  const nmfcItem = isCanadian ? '027880' : NMFC_ITEM;
  const nmfcSub  = isCanadian ? '02'     : NMFC_SUB;

  const parts = [
    'DL=2', `ID=${ABF_ID}`, `ShipAcct=${ABF_ACCT}`,
    'ShipPay=Y', 'Acc=ARR=Y'
  ];
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

  parts.push('ShipAff=Y', `ShipMonth=${today.getMonth()+1}`,
    `ShipDay=${today.getDate()}`, `ShipYear=${today.getFullYear()}`);

  return 'https://www.abfs.com/xml/aquotexml.asp?' + parts.join('&');
}

function parseAbfXml(xmlText) {
  // Check for ABF error response first
  const errMatch = xmlText.match(/<ERROR[^>]*>([^<]*)<\/ERROR>/i)
                || xmlText.match(/<ERRORDESC[^>]*>([^<]*)<\/ERRORDESC>/i)
                || xmlText.match(/<MSG[^>]*>([^<]*)<\/MSG>/i);
  if (errMatch && errMatch[1].trim()) {
    const abfMsg = errMatch[1].trim();
    // Translate common ABF error codes into actionable messages
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


// ── OD Book URL builder ───────────────────────────────────────────
function buildOdBookUrl({ city, state, zip, pallets, totalWeight, acc }) {
  // OD doesn't support fully pre-filled booking via URL params,
  // but we can open their LTL booking page with dest zip pre-filled
  // https://www.odfl.com/us/en/tools/ship-ltl-freight.html
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

// ── ABF Shipment Booking ──────────────────────────────────────────
function buildAbfBookingUrl(params) {
  const {
    pallets, totalWeight,
    consName, consAddr, consCity, consState, consZip, consCountry,
    consPhone, consTaxId,
    pickupDate, // YYYY-MM-DD
    bolNumber,  // our reference number
    specialInstructions,
    accessories,
  } = params;

  const today = pickupDate ? new Date(pickupDate) : new Date();
  const parts = [
    'DL=2',
    `ID=${ABF_ID}`,
    `ShipAcct=${ABF_ACCT}`,
    'ShipPay=Y',
    // Shipper info
    `ShipName=${encodeURIComponent('WhisperRoom Inc')}`,
    `ShipAddr=${encodeURIComponent('322 Nancy Lynn Lane Suite 14')}`,
    `ShipCity=${encodeURIComponent(SHIP_CITY)}`,
    `ShipState=${SHIP_STATE}`,
    `ShipZip=${SHIP_ZIP}`,
    'ShipCountry=US',
    `ShipPhone=${encodeURIComponent('8655585364')}`,
    // Consignee info
    `ConsName=${encodeURIComponent(consName || '')}`,
    `ConsAddr=${encodeURIComponent(consAddr || '')}`,
    `ConsCity=${encodeURIComponent(consCity || '')}`,
    `ConsState=${consState || ''}`,
    `ConsZip=${consZip || ''}`,
    `ConsCountry=${consCountry || 'US'}`,
    `ConsPhone=${encodeURIComponent(consPhone || '')}`,
    // Pickup date
    `ShipMonth=${today.getMonth()+1}`,
    `ShipDay=${today.getDate()}`,
    `ShipYear=${today.getFullYear()}`,
    // Reference
    `BOLRef1=${encodeURIComponent(bolNumber || '')}`,
    'FrtLWHType=IN',
    'Acc=ARR=Y',
  ];

  // Accessorials
  if (accessories?.residential)   parts.push('Acc_RDEL=Y');
  if (accessories?.liftgate)      parts.push('Acc_GRD_DEL=Y');
  if (accessories?.limitedaccess) { parts.push('Acc_LAD=Y'); parts.push('LADType=M'); }
  // Loading dock: no param needed — ABF auto-applies based on destination zip
  if (specialInstructions)        parts.push(`SpcInst=${encodeURIComponent(specialInstructions)}`);

  // Freight pieces
  pallets.forEach((pl, i) => {
    const n = i + 1;
    parts.push(
      `FrtLng${n}=${pl.l}`,
      `FrtWdth${n}=${pl.w}`,
      `FrtHght${n}=${pl.h}`,
      `UnitType${n}=PLT`,
      `Wgt${n}=${pl.weight}`,
      `UnitNo${n}=1`,
      `Class${n}=${FREIGHT_CLASS}`,
      `NMFCItem${n}=${NMFC_ITEM}`,
      `NMFCSub${n}=${NMFC_SUB}`,
    );
  });

  return 'https://www.abfs.com/xml/ashipxml.asp?' + parts.join('&');
}

function parseAbfBookingXml(xmlText) {
  // Extract PRO number
  const proMatch = xmlText.match(/<PRO[^>]*>([^<]*)<\/PRO>/i)
    || xmlText.match(/PRO["\s]*[:=]["\s]*([0-9-]+)/i)
    || xmlText.match(/<PRONUMBER[^>]*>([^<]*)<\/PRONUMBER>/i);
  const proNumber = proMatch ? proMatch[1].trim() : null;

  // Extract confirmation/BOL number
  const bolMatch = xmlText.match(/<BOL[^>]*>([^<]*)<\/BOL>/i)
    || xmlText.match(/<BOLNUMBER[^>]*>([^<]*)<\/BOLNUMBER>/i);
  const bolNumber = bolMatch ? bolMatch[1].trim() : null;

  // Check for errors
  const errMatch = xmlText.match(/<ERROR[^>]*>([^<]*)<\/ERROR>/i)
    || xmlText.match(/<ERRORMSG[^>]*>([^<]*)<\/ERRORMSG>/i);
  const error = errMatch ? errMatch[1].trim() : null;

  // Extract pickup confirmation
  const pickupMatch = xmlText.match(/<PICKUP[^>]*>([^<]*)<\/PICKUP>/i)
    || xmlText.match(/<CONFIRMNO[^>]*>([^<]*)<\/CONFIRMNO>/i);
  const pickupConfirm = pickupMatch ? pickupMatch[1].trim() : null;

  return { proNumber, bolNumber, pickupConfirm, error, raw: xmlText.slice(0, 500) };
}

// ── Auth ──────────────────────────────────────────────────────────
function generateToken() { return crypto.randomBytes(32).toString('hex'); }
function parseCookies(req) {
  const list = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const parts = p.split('=');
    if (parts[0]) list[parts[0].trim()] = (parts[1] || '').trim();
  });
  return list;
}
// ── Request body parser ───────────────────────────────────────────
function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
  });
}

// ── Login page HTML ───────────────────────────────────────────────
const LOGIN_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhisperRoom — Login</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='%231a1a1a'/><text x='50%25' y='54%25' dominant-baseline='middle' text-anchor='middle' font-family='Arial Black,sans-serif' font-size='18' font-weight='900' fill='%23e8531a'>W</text></svg>">
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@800&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0a;color:#f0ede8;font-family:'DM Mono',monospace;min-height:100vh;display:flex;align-items:center;justify-content:center}
.box{width:360px;padding:40px}
.logo{font-family:'Syne',sans-serif;font-size:30px;font-weight:800;margin-bottom:4px}
.logo span{color:#e8531a}
.sub{font-size:11px;color:#7a7672;text-transform:uppercase;letter-spacing:.1em;margin-bottom:32px}
.hs-btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:13px 20px;background:#ff7a59;border:none;border-radius:6px;color:#fff;font-family:'Syne',sans-serif;font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;text-decoration:none;margin-bottom:20px;transition:background .15s}
.hs-btn:hover{background:#ff6a45}
.divider{display:flex;align-items:center;gap:12px;margin-bottom:20px;color:#444;font-size:11px;text-transform:uppercase;letter-spacing:.08em}
.divider::before,.divider::after{content:'';flex:1;height:1px;background:#2e2e2e}
label{font-size:11px;color:#7a7672;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:6px}
input{width:100%;background:#181818;border:1px solid #2e2e2e;border-radius:4px;color:#f0ede8;font-family:'DM Mono',monospace;font-size:14px;padding:12px;outline:none}
input:focus{border-color:#e8531a}
.pw-btn{margin-top:16px;width:100%;padding:14px;background:#333;border:none;border-radius:4px;color:#f0ede8;font-family:'Syne',sans-serif;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;transition:background .15s}
.pw-btn:hover{background:#444}
.err{margin-top:12px;color:#e74c3c;font-size:12px;text-align:center}
</style></head><body>
<div class="box">
  <div class="logo">Whisper<span>Room</span></div>
  <div class="sub">Internal Tools</div>
  {{HS_BTN}}
  <div class="divider">or password</div>
  <form method="POST" action="/login">
    <label>Password</label>
    <input type="password" name="password" placeholder="Enter password" autofocus>
    <button type="submit" class="pw-btn">Sign In</button>
    {{ERROR}}
  </form>
</div></body></html>`;

// ── Main HTML (served from file) ──────────────────────────────────
const HSO_BTN = `<a href="/auth/hubspot" class="hs-btn"><svg width="18" height="18" viewBox="0 0 512 512" fill="white"><path d="M267.4 211.6c-25.1 23.7-40.8 57-40.8 93.8 0 29.3 9.7 56.3 26 78L203.1 434c-4.4-1.6-9.1-2.5-14-2.5-21.9 0-39.7 17.8-39.7 39.7S167.2 511 189.1 511s39.7-17.8 39.7-39.7c0-4.9-.9-9.6-2.5-14l49.2-50.4c22 16.4 49.2 26.1 78.7 26.1 73.5 0 133.1-59.6 133.1-133.1 0-67.7-50.6-123.5-116.1-131.8v-65.2c13.4-6.8 22.6-20.7 22.6-36.7 0-22.8-18.5-41.3-41.3-41.3-22.8 0-41.3 18.5-41.3 41.3 0 16 9.2 29.9 22.6 36.7v65.7c-22.5 2.9-43.1 11.5-60.4 24.6zM354.2 439.8c-46.6 0-84.4-37.8-84.4-84.4s37.8-84.4 84.4-84.4 84.4 37.8 84.4 84.4-37.8 84.4-84.4 84.4z"/></svg> Sign in with HubSpot</a>`;
const MAIN_HTML_PATH = path.join(__dirname, 'quote-builder.html');

// ── Server ────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const search = parsed.search || '';

  const allowedOrigin = (req.headers.origin || '').includes('sales.whisperroom.com')
    ? req.headers.origin
    : 'https://sales.whisperroom.com';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const json = (data, status=200) => {
    res.writeHead(status, {'Content-Type':'application/json'});
    res.end(JSON.stringify(data));
  };

  // ── API: Admin — backfill missing share tokens ───────────────────
  if (pathname === '/api/admin/backfill-tokens' && req.method === 'POST') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    try {
      if (!db) { json({ error: 'No DB' }, 500); return; }
      const missing = await db.query(
        `SELECT id, quote_number FROM quotes WHERE share_token IS NULL OR share_token = ''`
      );
      let count = 0;
      for (const row of missing.rows) {
        const tok = require('crypto').randomBytes(6).toString('hex');
        await db.query(`UPDATE quotes SET share_token = $1 WHERE id = $2`, [tok, row.id]);
        count++;
      }
      json({ success: true, updated: count });
    } catch(e) { json({ error: e.message }, 500); }
    return;
  }


  if (pathname === '/api/pricebook-export' && req.method === 'GET') {
    if (!isAuth(req)) { res.writeHead(302, { Location: '/' }); res.end(); return; }
    try {
      // Fetch all products from HubSpot
      let all = [], after = null;
      for (let page = 0; page < 20; page++) {
        let path = '/crm/v3/objects/products?limit=100&properties=name,price,description,hs_sku,hs_product_type';
        if (after) path += `&after=${after}`;
        const r = await httpsRequest({ hostname:'api.hubapi.com', path, method:'GET', headers:{ 'Authorization':`Bearer ${HS_TOKEN}` } });
        const results = r.body?.results || [];
        all.push(...results);
        after = r.body?.paging?.next?.after || null;
        if (!after || results.length < 100) break;
      }

      // Sort by name
      all.sort((a,b) => (a.properties?.name||'').localeCompare(b.properties?.name||''));

      // Auto-category helper
      const getCategory = name => {
        if (/^MDL\b/.test(name))                              return 'Booth';
        if (/^WDO\b|^IEP WDO/.test(name))                    return 'Window';
        if (/^EFP\b|^IEP\b|RAMP|^STEP\b/.test(name))         return 'Floor';
        if (/^HX\b|^DWC\b|^LT\b|CBL UPG/.test(name))        return 'Electrical';
        if (/^HEPA\b|^VENT\b|^REMOTE\b|^AP\b/.test(name))    return 'Ventilation';
        if (/^SL\b|^VSS\b|^EFS\b|^CP\b|^MJP|BASS TRAP|^AUDI|^FOAM|Desk|^WA\b|^RM\b|^ADA\b/.test(name)) return 'Accessories';
        return 'Other';
      };

      // Build CSV
      const esc = v => `"${String(v||'').replace(/"/g,'""')}"`;
      const rows = [
        ['HubSpot ID','Name','Price','Description','SKU','Product Type','Category'],
        ...all.map(p => {
          const pr = p.properties || {};
          return [
            p.id,
            pr.name || '',
            pr.price || '',
            pr.description || '',
            pr.hs_sku || '',
            pr.hs_product_type || '',
            getCategory(pr.name || ''),
          ];
        })
      ];
      const csv = rows.map(r => r.map(esc).join(',')).join('\r\n');

      res.writeHead(200, {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="whisperroom-pricebook-${new Date().toISOString().slice(0,10)}.csv"`,
      });
      res.end(csv);
    } catch(e) {
      res.writeHead(500); res.end('Export failed: ' + e.message);
    }
    return;
  }


  const host = req.headers.host || '';
  if (host.includes('railway.app') && !pathname.startsWith('/auth/')) {
    res.writeHead(301, { Location: `https://sales.whisperroom.com${req.url}` });
    res.end(); return;
  }

  if (pathname === '/auth/hubspot') {
    if (!HS_CLIENT_ID) { res.writeHead(302, { Location: '/' }); res.end(); return; }
    const state = generateToken();
    oauthStates.add(state);
    setTimeout(() => oauthStates.delete(state), 600000);
    const scopes = 'crm.objects.owners.read oauth';
    const authUrl = `https://app.hubspot.com/oauth/authorize?client_id=${HS_CLIENT_ID}&redirect_uri=${encodeURIComponent(HS_REDIRECT_URI)}&scope=${encodeURIComponent(scopes)}&state=${state}`;
    res.writeHead(302, { Location: authUrl });
    res.end();
    return;
  }

  // ── HubSpot OAuth: Callback ───────────────────────────────────────
  if (pathname === '/auth/callback') {
    const { code, state, error } = parsed.query;
    if (error || !code) {
      console.warn('[OAuth] callback error:', error || 'no code');
      res.writeHead(302, { Location: '/?auth_error=1' }); res.end(); return;
    }
    // Validate state if present in our set; warn but don't hard-fail if missing (could be server restart)
    if (state && oauthStates.has(state)) {
      oauthStates.delete(state);
    } else if (state && !oauthStates.has(state)) {
      console.warn('[OAuth] state mismatch — server may have restarted, proceeding anyway');
    }
    try {
      // Exchange code for tokens
      const tokenRes = await httpsRequest({
        hostname: 'api.hubapi.com', path: '/oauth/v1/token', method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }, null, `grant_type=authorization_code&client_id=${HS_CLIENT_ID}&client_secret=${HS_CLIENT_SECRET}&redirect_uri=${encodeURIComponent(HS_REDIRECT_URI)}&code=${code}`);
      const { access_token, expires_in } = tokenRes.body;

      // Get user info from token
      const tokenInfoRes = await httpsRequest({
        hostname: 'api.hubapi.com', path: `/oauth/v1/access-tokens/${access_token}`,
        method: 'GET', headers: { 'Authorization': `Bearer ${access_token}` }
      });
      const { user, hub_id } = tokenInfoRes.body;

      // Verify correct portal
      if (String(hub_id) !== '5764220') {
        res.writeHead(302, { Location: '/?auth_error=wrong_portal' }); res.end(); return;
      }

      // Look up their owner record for name + ownerId
      let ownerId = null; let displayName = user.split('@')[0];
      try {
        const ownerRes = await httpsRequest({
          hostname: 'api.hubapi.com',
          path: `/crm/v3/owners?email=${encodeURIComponent(user)}&limit=1`,
          method: 'GET', headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
        });
        const owners = ownerRes.body?.results || [];
        if (owners.length) {
          ownerId = owners[0].id;
          displayName = [owners[0].firstName, owners[0].lastName].filter(Boolean).join(' ') || displayName;
        }
      } catch(e) { /* non-fatal */ }

      const sessionToken = generateToken();
      const sessionData = {
        email: user, name: displayName, ownerId,
        expiresAt: Date.now() + (30 * 24 * 60 * 60 * 1000) // 30 days
      };
      // Save to DB (survives redeploys) + memory cache (fast access)
      _sessionCache.set(sessionToken, sessionData);
      await dbSessionSet(sessionToken, sessionData);
      res.writeHead(302, {
        'Set-Cookie': `wr_oauth_session=${sessionToken}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`,
        'Location': '/deals'
      });
      res.end();
    } catch(e) {
      console.error('OAuth error:', e.message);
      res.writeHead(302, { Location: '/?auth_error=1' }); res.end();
    }
    return;
  }

  // ── Logout ────────────────────────────────────────────────────────
  if (pathname === '/auth/logout') {
    const c = parseCookies(req);
    if (c.wr_oauth_session) {
      _sessionCache.delete(c.wr_oauth_session);
      await dbSessionDelete(c.wr_oauth_session);
    }
    if (c.wr_qt_session) sessions.delete(c.wr_qt_session);
    res.writeHead(302, {
      'Set-Cookie': ['wr_oauth_session=; HttpOnly; Path=/; Max-Age=0', 'wr_qt_session=; HttpOnly; Path=/; Max-Age=0'],
      'Location': '/'
    });
    res.end(); return;
  }

  // ── Session info ──────────────────────────────────────────────────
  if (pathname === '/api/me' && req.method === 'GET') {
    if (!await isAuthAsync(req)) { json({ error: 'Unauthorized' }, 401); return; }
    const sess = await getSessionAsync(req);
    json({ name: sess?.name || 'User', email: sess?.email || '', ownerId: sess?.ownerId || null });
    return;
  }

  // ── Login ──
  if (pathname === '/login' && req.method === 'POST') {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    if (params.get('password') === PASSWORD) {
      const token = generateToken();
      sessions.add(token);
      res.writeHead(302, {
        'Set-Cookie': `wr_qt_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`,
        'Location': '/deals'
      });
      res.end();
    } else {
      res.writeHead(200, {'Content-Type':'text/html'});
      res.end(LOGIN_HTML.replace('{{ERROR}}', '<div class="err">Incorrect password.</div>').replace('{{HS_BTN}}', HS_CLIENT_ID ? HSO_BTN : ''));
    }
    return;
  }

  // ── Auth gate ──
  // Public routes — no auth required but rate limited + token validated
  const isPublicRoute = pathname.startsWith('/q/') || pathname.startsWith('/i/') || pathname.startsWith('/o/') || pathname === '/api/accept-quote';
  if (isPublicRoute) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    if (!checkRateLimit(ip, 30, 60000)) {
      res.writeHead(429, { 'Content-Type': 'text/html' });
      res.end('<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;text-align:center"><h2>Too many requests</h2><p>Please wait a moment and try again.</p></body></html>');
      return;
    }
  }
  if (!await isAuthAsync(req) && pathname !== '/login' && !isPublicRoute) {
    if (pathname.startsWith('/api/')) {
      json({ error: 'Unauthorized' }, 401); return;
    }
    res.writeHead(200, {'Content-Type':'text/html'});
    res.end(LOGIN_HTML.replace('{{ERROR}}','').replace('{{HS_BTN}}', HS_CLIENT_ID ? HSO_BTN : ''));
    return;
  }

  // ── Main app ──
  // ── Static assets for quote page ────────────────────────────────
  if (pathname === '/assets/favicon.avif') {
    const buf = Buffer.from('data:image/avif;base64,AAAAHGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZgAAAOptZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAAA5waXRtAAAAAAABAAAAImlsb2MAAAAAREAAAQABAAAAAAEOAAEAAAAAAAAEWwAAACNpaW5mAAAAAAABAAAAFWluZmUCAAAAAAEAAGF2MDEAAAAAamlwcnAAAABLaXBjbwAAABNjb2xybmNseAACAAIABoAAAAAMYXYxQ4EgAgAAAAAUaXNwZQAAAAAAAAEAAAABAAAAABBwaXhpAAAAAAMICAgAAAAXaXBtYQAAAAAAAAABAAEEgYIDhAAABGNtZGF0EgAKBjgd///YJDLOCBIABBAw8UAGIRbCP2Gqdn8HfO9TMEGnJGRjZw9Mb4mjfTDfVN2dM0jWqVBVM57Ct5rAa+QHMLcTkDkeJZHGUtBBisuhTaGr7Vbbzf1zOAH8Jt+Lvxl4eFr/5y1jvQIR4rT41ZvevOW/lr+WJs2HE4IxxBb0urDK0cbBMfHONPepkSfipaigF7bTe38Ne9FYwYrL6Yuk4EHkb1emHCOQ5sOmJ3HLMHz8hSlqgpypL2w8PHxIuv5VuyC0O1r0BF1M2zA6jwcwuldU0eDx53zZla8iWoxfa+dHo0gr1YyLov4eROg5HMBzXg7LzSL45gAKWDxrakGCg3dmmsDqifhUOcbsg9MyiU2EoWDQ+fkAKt3oFJ4iYtiBIu1hixAJOgEev6dPpTCltdruOMP+jFreCXzwSU7CW/kpQ/LhmIvgUsdagyPqzaxkrTv8X4LxHwcyt+IBwNefMcY7tmp3r16AUoSa91HL3pZgNaURVZ8s8ZAyBJwfD1GkAXHyYaqORZXZQWdEfQaRHMn1+4ly4za3SgC7X6YlaMeBlmf7rHURLiDlEFtCY/Qa5Rc6KCf2zbR9LRSxAd2rAN9/0PcawKuxXUhaf0lOTokdEa3nxjtOV0iAUgGBdddT+eDwgY+GQKs5O4o9B+GkQdX0ERjgZQ9f8zXIwVPa9Pe30y9V2JF3hzX1dpAztS8MwKshyk9wFy9j22Cwhj69vkNRpWXMlsG8dKxPRKHOEPH1GXN8or60LAwsKQhjlrbxeabgdLLrRwOiJfnGbZBW1f+6CioMN9TqldFA+11ymwUsVnGCIFBz85PwO2l3Y6sH+1X8CsbwOWC0WG/qDSqLhVUc9DopKPblZkHzjX/bwFeDwj6bgkHgAkTC8Up3v44GOSJf+hktbhMQEqyN20zsEbIHrPO6zwMWRUli2a3QrYFJsKCruYYWYK4EkcuaIamnvLzJBavF9s06wOfHEhg/FQVcd8MRQSp79s4NHTjfSRmi/yE5qYh1RRdnY03Pyo+wFu3lWuXAII9QUsOeOfLuM8GW2W/W7m05ohBuwDTzBLKfze/RgvYwXv9BXaGrhMsPjMNE99mEy33QJLu1SeqTddTIJMz71/0o6jci4IIPHSwqsNLZyb94rL8uI2N2q6Q+He6VuK6C2jUYHDrvAM6f9JchrctvJT2N36jE1i5U5ap3dkACxGFcaohpXr8v8LGWQ4WuzgQXL2H4iKs5GGSiOOPDobB6yNn71fV1y5OPWHF1aEDoZxMa6ra/QKM5ktIqxE8DJarBhSRm53jkfAH/HgGwB43N4PrLyCkNePgQ03mcl2FA2ZXY0jNfh/TG9rsVDH4SlRGcFP5SSFa5BtYYwbU86KptE6B4eU+Cq+6vgZpNfTL/J30LXl2VRWnHspTqu1epSDbmVe2/CgONQysTmbbwdbinnpOxC5zhuylSEimmAIjBWbqGB5uQUlW+mY2rnt+vXgKk69Q='.replace('data:image/avif;base64,',''), 'base64');
    res.writeHead(200, {'Content-Type':'image/avif','Cache-Control':'public,max-age=86400'});
    res.end(buf); return;
  }
  if (pathname === '/assets/logo-orange.svg') {
    const buf = Buffer.from('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTUwIiBoZWlnaHQ9IjMxIiB2aWV3Qm94PSIwIDAgMTUwIDMxIiBmaWxsPSJub25lIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPgo8cGF0aCBkPSJNNDMuNzg4NiAxNC45NjdDNDMuNjI0MiAxNC43OTgzIDQzLjUwOTEgMTQuNTQ1MSA0My40NTk4IDE0LjMwODhDNDMuMzYxMSAxMy44MzYzIDQzLjQ3NjIgMTMuMzYzNyA0My42NzM2IDEyLjk0MThDNDQuMDAyNCAxMi4yNDk4IDQ0LjU5NDMgMTEuNzA5OCA0NS4yNTIgMTEuMzcyM0M0NS43NDUzIDExLjEzNiA0Ni4yODc5IDExLjAwMSA0Ni44MzA1IDExLjA1MTZDNDcuMjQxNiAxMS4xMDIyIDQ3LjY2OTEgMTEuMjU0MSA0Ny45NDg2IDExLjU0MUM0OC4xMjk1IDExLjcyNjcgNDguMjYxMSAxMS45Nzk4IDQ4LjMyNjggMTIuMjMzQzQ4LjQ0MTkgMTIuNzM5MyA0OC4zMTA0IDEzLjMzIDQ4LjAzMDkgMTMuNzY4OEM0Ny43NTEzIDE0LjIyNDQgNDcuMzA3NCAxNC41MjgyIDQ2Ljg0NyAxNC43ODE0QzQ2LjI3MTUgMTUuMDg1MiA0NS42Nzk2IDE1LjMwNDYgNDUuMDA1NCAxNS4zMzgzQzQ0LjU3NzkgMTUuMzU1MiA0NC4wODQ2IDE1LjI4NzcgNDMuNzg4NiAxNC45NjdaIiBmaWxsPSIjZWU2MjE2Ii8+CjxwYXRoIGQ9Ik0zMi4xMzc3IDEyLjM1MjdDMzIuMjIxNCAxMi4zMzYxIDMyLjMyMTggMTIuMzE5NSAzMi4zODg3IDEyLjM1MjdDMzIuNTIyNSAxMi40MDI1IDMyLjU3MjggMTIuNTg1MSAzMi42MDYyIDEyLjczNDZDMzIuNjM5NyAxMi44Njc0IDMyLjY1NjQgMTIuOTgzNiAzMi42NzMxIDEzLjA5OTlDMzIuNzA2NiAxMy40MTU0IDMyLjc0MDEgMTMuNzQ3NSAzMi43NTY4IDE0LjA3OTVDMzIuODIzNyAxNC45NTk2IDMyLjg0MDUgMTUuODIzIDMyLjg3MzkgMTYuNjg2NEMzMi45MDc0IDE4LjE2NDIgMzIuOTQwOSAxOS42NDIgMzIuOTI0MSAyMS4xMTk4QzMyLjkyNDEgMjEuODY3IDMyLjkwNzQgMjIuNTk3NiAzMi44OTA3IDIzLjM0NDhDMzIuODkwNyAyMy42MTA1IDMyLjg5MDcgMjMuODc2MSAzMi44NzM5IDI0LjE0MThDMzIuODU3MiAyNC4zMDc4IDMyLjg1NzIgMjQuNDkwNSAzMi44MjM3IDI0LjY1NjVDMzIuODA3IDI0LjgyMjYgMzIuNzU2OCAyNC45ODg2IDMyLjY4OTkgMjUuMTIxNUMzMi42MjMgMjUuMjcwOSAzMi41MDU4IDI1LjQwMzcgMzIuMzg4NyAyNS41MkMzMi4zMDUgMjUuNjAzIDMyLjIyMTQgMjUuNjg2IDMyLjEzNzcgMjUuNzY5QzMzLjg3NzkgMjUuNzY5IDM1LjYwMTQgMjUuNzY5IDM3LjM0MTYgMjUuNzY5QzM3LjIwNzcgMjUuNjUyOCAzNy4wOTA2IDI1LjUyIDM2Ljk3MzUgMjUuMzg3MUMzNi44NTYzIDI1LjI1NDMgMzYuNzU1OSAyNS4xMDQ5IDM2LjcwNTcgMjQuOTM4OEMzNi42NTU1IDI0Ljc1NjIgMzYuNjM4OCAyNC41NzM1IDM2LjYzODggMjQuMzkwOUMzNi42Mzg4IDIzLjk5MjQgMzYuNjM4OCAyMy42MTA1IDM2LjY1NTUgMjMuMjI4NkMzNi42NzIzIDIyLjQ4MTQgMzYuNjU1NSAyMS43MTc2IDM2LjY1NTUgMjAuOTcwNEMzNi42NTU1IDIwLjUzODYgMzYuNjcyMyAyMC4xMjM1IDM2LjY1NTUgMTkuNjkxOEMzNi42NTU1IDE5LjU1OSAzNi42NTU1IDE5LjQyNjEgMzYuNjU1NSAxOS4yNzY3QzM2LjY3MjMgMTkuMTEwNyAzNi42ODkgMTguOTQ0NiAzNi43NTU5IDE4Ljc5NTJDMzYuODIyOSAxOC42NDU3IDM2LjkyMzMgMTguNTEyOSAzNy4wNDA0IDE4LjM5NjdDMzcuMjU3OSAxOC4xOTc0IDM3LjU1OTEgMTguMTE0NCAzNy44NjAzIDE4LjA5NzhDMzguMDc3OCAxOC4wOTc4IDM4LjI5NTQgMTguMTMxIDM4LjQ3OTQgMTguMjMwNkMzOC42ODAyIDE4LjMzMDMgMzguODQ3NSAxOC40OTYzIDM4Ljk0NzkgMTguNjk1NkMzOS4wNjUxIDE4LjkxMTQgMzkuMDk4NSAxOS4xNDM5IDM5LjExNTMgMTkuMzkyOUMzOS4xMzIgMTkuNTU5IDM5LjExNTMgMTkuNzI1IDM5LjExNTMgMTkuODkxMUMzOS4xMTUzIDIwLjIwNjYgMzkuMTE1MyAyMC41MDU0IDM5LjExNTMgMjAuODIwOUMzOS4xMTUzIDIxLjE4NjIgMzkuMTE1MyAyMS41NjgxIDM5LjExNTMgMjEuOTMzNEMzOS4xMTUzIDIyLjM2NTEgMzkuMTE1MyAyMi44MTM0IDM5LjExNTMgMjMuMjQ1MkMzOS4xMTUzIDIzLjYxMDUgMzkuMTE1MyAyMy45NTkxIDM5LjExNTMgMjQuMzI0NEMzOS4xMTUzIDI0LjQ3MzkgMzkuMTE1MyAyNC42MjMzIDM5LjA4MTggMjQuNzcyOEMzOS4wNDgzIDI0LjkzODggMzguOTY0NyAyNS4wODgyIDM4Ljg2NDMgMjUuMjIxMUMzOC43NDcxIDI1LjM4NzEgMzguNjMgMjUuNTM2NiAzOC40Nzk0IDI1LjY2OTRDMzguNDQ1OSAyNS43MDI2IDM4LjM5NTcgMjUuNzM1OCAzOC4zNjIzIDI1Ljc2OUM0MC44ODg5IDI1Ljc2OSA0My40MzIzIDI1Ljc2OSA0NS45NTkgMjUuNzY5QzQ2LjQ5NDQgMjUuNzY5IDQ3LjAxMzEgMjUuNzY5IDQ3LjU0ODYgMjUuNzY5QzQ3Ljk1MDIgMjUuNzY5IDQ4LjMzNSAyNS43NjkgNDguNzM2NiAyNS43NjlDNDguODcwNCAyNS43NjkgNDguOTg3NiAyNS43NjkgNDkuMTIxNCAyNS43NjlDNDkuMDcxMiAyNS42ODYgNDkuMDIxIDI1LjYwMyA0OC45NzA4IDI1LjUzNjZDNDguODg3MiAyNS40MjAzIDQ4Ljc3MDEgMjUuMzIwNyA0OC42ODY0IDI1LjIyMTFDNDguNjE5NSAyNS4xNTQ3IDQ4LjU2OTMgMjUuMDcxNiA0OC41MzU4IDI0Ljk4ODZDNDguNDM1NCAyNC43NTYyIDQ4LjQwMTkgMjQuNTA3MSA0OC4zODUyIDI0LjI1OEM0OC4zODUyIDI0LjE3NSA0OC4zNjg1IDI0LjA5MiA0OC4zNjg1IDI0LjAwOUM0OC4zNTE3IDIzLjgwOTcgNDguMzY4NSAyMy41OTM4IDQ4LjM2ODUgMjMuMzk0NkM0OC4zNjg1IDIzLjA0NTkgNDguMzY4NSAyMi43MTM4IDQ4LjM2ODUgMjIuMzY1MUM0OC4zNTE3IDIwLjgyMDkgNDguMzY4NSAxOS4yNjAxIDQ4LjM2ODUgMTcuNzE1OUM0OC4zNjg1IDE3LjU4MzEgNDguMzY4NSAxNy40NTAyIDQ4LjM2ODUgMTcuMzE3NEM0OC4zNjg1IDE3LjA2ODMgNDguMzg1MiAxNi44MTkzIDQ4LjQxODcgMTYuNTcwMkM0OC40MzU0IDE2LjQzNzQgNDguNDUyMSAxNi4zMDQ1IDQ4LjQ2ODkgMTYuMTU1MUM0OC40ODU2IDE2LjAyMjMgNDguNTAyMyAxNS44NzI4IDQ4LjQzNTQgMTUuNzU2NkM0OC4zODUyIDE1LjY1NyA0OC4yODQ4IDE1LjU5MDUgNDguMTY3NyAxNS41NTczQzQ4LjAzMzggMTUuNTI0MSA0Ny44ODMyIDE1LjU1NzMgNDcuNzQ5NCAxNS41OTA1QzQ3LjU0ODYgMTUuNjQwMyA0Ny4zODEyIDE1LjY3MzYgNDcuMTYzNyAxNS42OTAyQzQ3LjA2MzMgMTUuNzA2OCA0Ni45NDYyIDE1LjcwNjggNDYuODI5MSAxNS43MDY4QzQ2LjE1OTcgMTUuNzQgNDUuNTc0MSAxNS43NTY2IDQ0Ljk3MTcgMTUuNzU2NkM0NC43NTQyIDE1Ljc1NjYgNDQuNTUzNCAxNS43NTY2IDQ0LjMzNTkgMTUuNzU2NkM0NC4yMDIgMTUuNzU2NiA0NC4wNjgxIDE1Ljc1NjYgNDMuOTM0MyAxNS43NTY2QzQzLjg1MDYgMTUuNzU2NiA0My43NjcgMTUuNzU2NiA0My42ODMzIDE1Ljc3MzJDNDMuNjE2NCAxNS43ODk4IDQzLjU0OTQgMTUuNzg5OCA0My40OTkyIDE1LjgzOTZDNDMuNDMyMyAxNS45MDYgNDMuMzk4OCAxNi4wMDU2IDQzLjM5ODggMTYuMTA1M0M0My40MTU2IDE2LjI3MTMgNDMuNTE2IDE2LjM4NzUgNDMuNjE2NCAxNi41MDM4QzQzLjczMzUgMTYuNjUzMiA0My44MzM5IDE2Ljc4NiA0My45MTc2IDE2LjkxODlDNDMuOTY3OCAxNi45ODUzIDQ0LjAxOCAxNy4wNTE3IDQ0LjA1MTQgMTcuMjE3OEM0NC4wNjgxIDE3LjMzNCA0NC4wODQ5IDE3LjUxNjYgNDQuMTAxNiAxNy42NjYxQzQ0LjEzNTEgMTguMDQ4IDQ0LjExODQgMTguMTgwOCA0NC4xMTg0IDE4LjMzMDNDNDQuMTAxNiAxOS4wNDQyIDQ0LjExODQgMjAuMDU3MSA0NC4xMTg0IDIxLjA1MzRDNDQuMTE4NCAyMS4zODU1IDQ0LjExODQgMjEuNzAxIDQ0LjExODQgMjIuMDMzQzQ0LjExODQgMjIuNTQ3OCA0NC4xMTg0IDIzLjA0NTkgNDQuMTE4NCAyMy41NjA2QzQ0LjExODQgMjMuNjkzNSA0NC4xMTg0IDIzLjgyNjMgNDQuMTE4NCAyMy45NDI1QzQ0LjExODQgMjQuMDkyIDQ0LjEwMTYgMjQuMjQxNCA0NC4wNjgyIDI0LjM5MDlDNDQuMDM0NyAyNC41NTY5IDQ0LjAwMTIgMjQuNzA2MyA0My45MTc2IDI0Ljg3MjRDNDMuODE3MiAyNS4wNTUgNDMuNjY2NiAyNS4yNTQzIDQzLjUzMjcgMjUuMjU0M0M0My4zOTg4IDI1LjIzNzcgNDMuMjgxNyAyNS4wMzg0IDQzLjE5OCAyNC44NzI0QzQzLjEzMTEgMjQuNzIzIDQzLjA5NzYgMjQuNTkwMSA0My4wOTc2IDI0LjQ1NzNDNDMuMDgwOSAyNC4zMDc4IDQzLjA4MDkgMjQuMTI1MiA0My4wODA5IDIzLjk1OTFDNDMuMDgwOSAyMi44NjMzIDQzLjA4MDkgMjEuODAwNiA0My4wODA5IDIwLjczNzlDNDMuMDgwOSAyMC4zMDYyIDQzLjA4MDkgMTkuODU3OSA0My4wODA5IDE5LjQyNjFDNDMuMDgwOSAxOS4yNzY3IDQzLjA4MDkgMTkuMTQzOSA0My4wODA5IDE4Ljk5NDRDNDMuMDY0MiAxOC41NDYxIDQzLjAxNCAxOC4wOTc4IDQyLjg0NjcgMTcuNjgyN0M0Mi41NDU1IDE2Ljk2ODcgNDEuODkyOSAxNi4zODc1IDQxLjE1NjcgMTYuMDM4OUM0MC42NzE0IDE1LjgwNjQgNDAuMTUyNyAxNS42OTAyIDM5LjYxNzIgMTUuNjU3QzM4Ljk5ODEgMTUuNjIzNyAzOC4zNjIzIDE1LjcwNjggMzcuNzU5OSAxNS44NzI4QzM3LjQwODUgMTUuOTU1OCAzNy4wNzM5IDE2LjA3MjEgMzYuNzU1OSAxNi4yMDQ5QzM2Ljc1NTkgMTUuNDkwOSAzNi43NzI3IDE0Ljc3NjkgMzYuNzcyNyAxNC4wNzk1QzM2Ljc3MjcgMTMuNzgwNyAzNi43NzI3IDEzLjQ5ODQgMzYuNzg5NCAxMy4xOTk1QzM2Ljc4OTQgMTMuMDgzMyAzNi44MDYxIDEyLjk4MzYgMzYuODA2MSAxMi44Njc0QzM2LjgyMjkgMTIuNjY4MiAzNi44MjI5IDEyLjQ2ODkgMzYuODU2MyAxMi4yNjk3QzM2Ljg3MzEgMTIuMDcwNCAzNi45MDY1IDExLjg1NDUgMzYuODM5NiAxMS43MzgzQzM2LjgwNjEgMTEuNjcxOSAzNi43NTU5IDExLjYzODcgMzYuNjcyMyAxMS42MDU1QzM2LjUzODQgMTEuNTU1NyAzNi4zNzExIDExLjU4ODkgMzYuMjAzOCAxMS42MjIxQzM2LjA1MzIgMTEuNjU1MyAzNS45MTkzIDExLjY3MTkgMzUuNzY4NyAxMS43MDUxQzM1LjYwMTQgMTEuNzM4MyAzNS40MzQgMTEuNzM4MyAzNS4yNjY3IDExLjc1NDlDMzQuOTMyMSAxMS43NzE1IDM0LjYxNDIgMTEuNzcxNSAzNC4yNzk1IDExLjc3MTVDMzMuNjQzNyAxMS43ODgxIDMzLjAwNzggMTEuNzg4MSAzMi4zNzIgMTEuNzg4MUMzMi4yNTQ4IDExLjk3MDggMzIuMjA0NiAxMi4xNTM0IDMyLjEzNzcgMTIuMzUyN1oiIGZpbGw9IiNlZTYyMTYiLz4KPHBhdGggZD0iTTEyLjg0ODYgMTguMDkyOEMxMy40NDMgMTUuODc4NyAxNC4wMTM3IDEzLjY4ODMgMTQuNTM2OCAxMS40NzQyQzE0LjY1NTcgMTAuOTc0MiAxNC43NzQ2IDEwLjQ3NDMgMTQuODkzNSA5Ljk5ODExQzE1LjA2IDkuMzU1MjkgMTUuMjI2NCA4LjczNjI4IDE1LjM5MjkgOC4xMTcyN0MxNS41MTE3IDcuNjY0OTIgMTUuNjA2OSA3LjIxMjU3IDE1LjcyNTcgNi43NjAyMkMxNS43OTcxIDYuNDUwNzIgMTUuODY4NCA2LjE2NTAyIDE1LjkxNiA1Ljg1NTUxQzE1Ljk2MzUgNS41OTM2MiAxNi4wMTExIDUuMzU1NTUgMTYuMDExMSA1LjA5MzY2QzE2LjAxMTEgNC43ODQxNiAxNS45NjM1IDQuNDUwODQgMTUuODkyMiA0LjE0MTM0QzE1LjgyMDkgMy43ODQyMiAxNS43MjU3IDMuNDUwOSAxNS41ODMxIDMuMTE3NTlDMTUuMjc0IDIuMzA4MTIgMTQuNzc0NiAxLjU3MDA3IDE0LjE1NjQgMC45NzQ4NzNDMTYuOTg2IDAuOTc0ODczIDE5LjgzOTQgMC45NzQ4NzMgMjIuNjY5IDAuOTc0ODczQzIyLjU5NzYgMS4wOTM5MSAyMi41MjYzIDEuMjEyOTUgMjIuNTAyNSAxLjM1NThDMjIuNDMxMiAxLjYxNzY5IDIyLjQwNzQgMS44Nzk1OCAyMi40MDc0IDIuMTY1MjdDMjIuNDMxMiAyLjg3OTUxIDIyLjU3MzkgMy41Njk5NSAyMi43NjQxIDQuMjM2NTdDMjIuOTc4MSA1LjA0NjA0IDIzLjIxNTkgNS44NTU1MiAyMy40NTM3IDYuNjY0OTlDMjMuODEwMyA3Ljg1NTM5IDI0LjE5MDggOS4wNjk1OSAyNC41NDc1IDEwLjI2QzI1LjMwODQgMTIuNzU5OCAyNi4wMjE3IDE1LjI1OTcgMjYuNzM1IDE3Ljc1OTVDMjcuMzUzMyAxNS4zNTQ5IDI3Ljk5NTMgMTIuOTUwMyAyOC43MzI0IDEwLjU2OTVDMjguODUxMyAxMC4xNDEgMjguOTk0IDkuNzEyNDEgMjkuMTEyOSA5LjI4Mzg3QzI5LjMyNjkgOC41NDU4MiAyOS41MTcxIDcuNzgzOTYgMjkuNzMxMSA3LjA0NTkxQzI5Ljg3MzggNi41Njk3NSAzMC4wMTY0IDYuMDkzNTkgMzAuMTM1MyA1LjYxNzQzQzMwLjIzMDQgNS4xODg4OSAzMC4zMjU2IDQuNzYwMzUgMzAuMzQ5MyA0LjMzMThDMzAuMzczMSAzLjk5ODQ5IDMwLjM3MzEgMy42NjUxOCAzMC4zMjU2IDMuMzMxODdDMzAuMjU0MiAyLjkyNzEzIDMwLjA4NzggMi41MjI0IDI5Ljg3MzggMi4xNDE0N0MyOS43MDczIDEuODc5NTggMjkuNTQwOSAxLjYxNzY5IDI5LjMyNjkgMS4zNzk2MUMyOS4yMDggMS4yMTI5NiAyOS4wNjUzIDEuMDcwMTEgMjguOTIyNiAwLjkyNzI2MkMzMC42MzQ3IDAuOTI3MjYyIDMyLjMyMjkgMC45MjcyNjIgMzQuMDM1IDAuOTI3MjYyQzM0LjMyMDMgMC45MjcyNjIgMzQuNTgxOSAwLjkyNzI2MiAzNC44NjcyIDAuOTI3MjYyQzM1LjEyODggMC45MjcyNjIgMzUuMzY2NSAwLjkwMzQ1MSAzNS42MjgxIDAuOTk4NjgzQzM1LjY3NTcgMS4wMjI0OSAzNS43MjMyIDEuMDIyNDkgMzUuNzQ3IDEuMDQ2M0MzNS44NDIxIDEuMTQxNTMgMzUuNzcwOCAxLjMzMiAzNS43MjMyIDEuNDk4NjVDMzUuNjI4MSAxLjc4NDM1IDM1LjU1NjggMi4wMjI0MyAzNS40NjE3IDIuMjM2N0MzMy4zNDU0IDguNjY0ODYgMzAuOTQzOCAxNi40NzM5IDI4Ljc4IDIzLjYxNjNDMjguNjYxMSAyNC4wNDQ4IDI4LjUxODQgMjQuNDQ5NiAyOC4zOTk1IDI0Ljg3ODFDMjguMzI4MiAyNS4wOTI0IDI4LjI4MDYgMjUuMzA2NiAyOC4yMDkzIDI1LjQ5NzFDMjguMTYxNyAyNS42MTYxIDI4LjExNDIgMjUuNzM1MiAyOC4wNjY2IDI1Ljg1NDJDMjguMDE5MSAyNS45NzMzIDI3Ljk3MTUgMjYuMTE2MSAyNy44NzY0IDI2LjE2MzdDMjcuNzU3NSAyNi4yMzUyIDI3LjU2NzMgMjYuMTg3NSAyNy40MDA4IDI2LjEzOTlDMjYuODc3NyAyNS45OTcxIDI2LjQ5NzMgMjUuODU0MiAyNi4wNjkzIDI1LjY2MzhDMjUuMzU1OSAyNS4zNTQzIDI0LjU5NSAyNC45NzMzIDIzLjg4MTcgMjQuNTQ0OEMyMy4yODcyIDI0LjE4NzcgMjIuNjkyOCAyMy44MDY3IDIyLjI2NDcgMjMuMjgzQzIxLjkwODEgMjIuODU0NCAyMS42NzAzIDIyLjMzMDYgMjEuNDU2MyAyMS44MDY5QzIxLjA3NTggMjAuOTAyMiAyMC43OTA1IDE5Ljk3MzcgMjAuNDgxNCAxOS4wNDUxQzIwLjA3NzIgMTcuODA3MSAxOS42NzI5IDE2LjU0NTMgMTkuMjkyNSAxNS4zMDczQzE4Ljg4ODIgMTMuOTc0IDE4LjUwNzggMTIuNjQwOCAxOC4xNzQ5IDExLjI4MzdDMTcuOTg0NyAxMS45NTA0IDE3Ljc5NDQgMTIuNjQwOCAxNy42MDQyIDEzLjMwNzRDMTcuMjk1MSAxNC40MDI2IDE3LjAwOTggMTUuNDczOSAxNi43MjQ0IDE2LjU2OTFDMTYuNDYyOSAxNy41NjkgMTYuMjI1MSAxOC41NDUyIDE1Ljk2MzUgMTkuNTQ1MUMxNS43NDk1IDIwLjQwMjIgMTUuNTExNyAyMS4yNTkzIDE1LjI3NCAyMi4wOTI2QzE1LjEwNzUgMjIuNzExNiAxNC45NjQ4IDIzLjMzMDYgMTQuODIyMiAyMy45MjU4QzE0Ljc1MDggMjQuMjM1MyAxNC42NTU3IDI0LjU2ODYgMTQuNTg0NCAyNC44NzgxQzE0LjUzNjggMjUuMTE2MiAxNC40NjU1IDI1LjMzMDUgMTQuNDE3OSAyNS41Njg1QzE0LjM5NDIgMjUuNjYzOCAxNC4zNzA0IDI1LjczNTIgMTQuMzQ2NiAyNS44MDY2QzE0LjMyMjggMjUuODU0MiAxNC4yNzUzIDI1LjkwMTggMTQuMjI3NyAyNS45NDk1QzE0LjA4NTEgMjYuMDY4NSAxMy44NDczIDI2LjA0NDcgMTMuNjA5NSAyNS45OTcxQzEzLjAzODggMjUuODc4IDEyLjU2MzIgMjUuNzExNCAxMi4wODc3IDI1LjQ5NzFDMTEuMjMxNyAyNS4xNCAxMC4zNTE5IDI0LjY4NzYgOS41NDM0MSAyNC4xNDAxQzkuMTg2NzQgMjMuOTAyIDguODUzODQgMjMuNjE2MyA4LjU2ODUgMjMuMzA2OEM4LjE4ODA1IDIyLjkwMiA3Ljg1NTE2IDIyLjQwMjEgNy41OTM2IDIxLjkwMjFDNy4xMTgwMyAyMS4wMjEyIDYuODA4OTIgMjAuMDkyNyA2LjQ3NjAzIDE5LjE0MDRDNi4wOTU1NyAxOC4wNDUyIDUuNzE1MTIgMTYuOTczOCA1LjMzNDY3IDE1Ljg3ODdDNC40MDczMiAxMy4xNDA4IDMuNTk4ODYgMTAuMzU1MiAyLjk1Njg1IDcuNTQ1ODhDMi43OTA0IDYuODU1NDUgMi42NDc3MyA2LjE2NTAyIDIuNTI4ODQgNS40NzQ1OUMyLjQ4MTI5IDUuMjEyNyAyLjQzMzczIDQuOTc0NjIgMi4zNjIzOSA0LjcxMjczQzIuMjY3MjggNC40MDMyMyAyLjEyNDYyIDQuMTQxMzQgMS45ODE5NSAzLjg1NTY0QzEuNjQ5MDUgMy4xODkwMiAxLjMzOTkzIDIuNDk4NTkgMC44NjQzNjggMS45NTFDMC42NzQxNDIgMS43MzY3MyAwLjQ2MDEzNiAxLjUyMjQ2IDAuMjIyMzU0IDEuMzMxOTlDMC4xNTEwMTkgMS4yNjA1NyAwLjA3OTY4ODcgMS4yMTI5NSAwLjA1NTkxMDUgMS4xMTc3MkMwLjAwODM1NDEzIDEuMDIyNDkgLTAuMDE1NDI3IDAuOTI3MjYzIDAuMDA4MzUxMjMgMC44MzIwMzFDMS43Njc5NCAwLjgzMjAzMSAzLjUwMzc1IDAuODMyMDMxIDUuMjYzMzQgMC44MzIwMzFDNS45MjkxMiAwLjgzMjAzMSA2LjU3MTE0IDAuODMyMDMxIDcuMjEzMTUgMC44MzIwMzFDNy40MDMzOCAwLjgzMjAzMSA3LjU5MzYgMC44MzIwMzEgNy44MDc2MSAwLjgzMjAzMUM3Ljk1MDI3IDAuODMyMDMxIDguMDkyOTQgMC44MzIwMjcgOC4yMTE4MyAwLjg3OTY0M0M4LjMzMDcyIDAuOTI3MjU5IDguNDI1ODQgMS4wNDYzIDguNDk3MTcgMS4xODkxNUM4LjYxNjA2IDEuMzc5NjIgOC42NjM2MiAxLjYxNzY5IDguNzExMTcgMS44MzE5NkM4LjkyNTE4IDIuNzEyODYgOS4xNjI5NiAzLjU0NjE0IDkuNDI0NTIgNC4zNzk0MkMxMC43MzIzIDkuMDIxOTggMTEuNjgzNCAxMy41OTMxIDEyLjg0ODYgMTguMDkyOFoiIGZpbGw9IiNlZTYyMTYiLz4KPHBhdGggZD0iTTQ4LjY4OTUgMjMuMTUzOUM0OS4wMzg0IDIzLjM0NyA0OS40MjYgMjMuNTQwMSA0OS43NzQ5IDIzLjY5NDZDNTAuMDQ2MyAyMy44NDkgNTAuMzU2NCAyMy45NjQ5IDUwLjYyNzggMjQuMDgwN0M1MS4wMTU1IDI0LjE5NjYgNTEuNDAzMSAyNC4yNzM4IDUxLjc5MDggMjQuMzEyNEM1Mi4yOTQ4IDI0LjM4OTcgNTIuODM3NSAyNC40MjgzIDUzLjM0MTUgMjQuMjM1MkM1My41MzUzIDI0LjE1OCA1My43MjkyIDI0LjA4MDcgNTMuODQ1NSAyMy45MjYzQzUzLjkyMyAyMy43NzE4IDUzLjk2MTggMjMuNjE3MyA1My45NjE4IDIzLjQyNDJDNTMuOTYxOCAyMy4yNjk4IDUzLjg4NDIgMjMuMTE1MyA1My44MDY3IDIyLjk5OTRDNTMuNjkwNCAyMi44NDUgNTMuNDk2NiAyMi43Njc3IDUzLjMwMjcgMjIuNjkwNUM1Mi43OTg4IDIyLjQ1ODggNTIuMzMzNiAyMi4yMjcxIDUxLjg2ODMgMjEuOTk1NEM1MS40NDE5IDIxLjgwMjMgNTAuOTc2NyAyMS42MDkyIDUwLjU1MDMgMjEuMzc3NUM1MC4yNDAxIDIxLjE4NDQgNDkuOTMgMjAuOTkxMyA0OS42NTg2IDIwLjcyMUM0OS4zNDg1IDIwLjQxMjEgNDkuMTE1OSAyMC4wMjU5IDQ4Ljk5OTYgMTkuNjAxMUM0OC44ODMzIDE5LjE3NjMgNDguOTIyMSAxOC43MTI5IDQ5LjAzODQgMTguMjQ5NUM0OS4xOTM0IDE3Ljc4NjEgNDkuNDY0OCAxNy4zNjEzIDQ5Ljc3NDkgMTcuMDEzN0M1MC4zOTUyIDE2LjM5NTggNTEuMjA5MyAxNi4wMDk3IDUyLjA2MjIgMTUuODE2NkM1Mi42NDM3IDE1LjcwMDcgNTMuMTg2NCAxNS42NjIxIDUzLjc2NzkgMTUuNjYyMUM1NC4zNDk0IDE1LjY2MjEgNTQuOTY5NyAxNS43MDA3IDU1LjQ3MzcgMTUuNzc4QzU1LjY2NzUgMTUuODE2NiA1NS44NjEzIDE1Ljg1NTIgNTYuMTMyNyAxNS44OTM4QzU2LjMyNjYgMTUuOTMyNCA1Ni41NTkyIDE2LjAwOTcgNTYuNzE0MiAxNi4wODY5QzU2Ljc5MTggMTYuMTI1NSA1Ni44NjkzIDE2LjIwMjggNTYuOTQ2OCAxNi4zMTg2QzU2Ljk4NTYgMTYuMzk1OCA1Ny4wMjQ0IDE2LjQ3MzEgNTcuMDI0NCAxNi41ODg5QzU3LjAyNDQgMTYuNjY2MiA1Ny4wMjQ0IDE2Ljc0MzQgNTcuMDI0NCAxNi44MjA2QzU3LjAyNDQgMTcuMzk5OSA1Ny4wMjQ0IDE3Ljk0MDYgNTcuMDI0NCAxOC41MTk4QzU2Ljc5MTcgMTguMzY1MyA1Ni41OTc5IDE4LjI0OTUgNTYuMzY1MyAxOC4xMzM2QzU2LjA5MzkgMTguMDE3OCA1NS44MjI2IDE3LjkwMTkgNTUuNTUxMiAxNy44MjQ3QzU1LjA4NiAxNy43MDg4IDU0LjY1OTYgMTcuNjcwMiA1NC4xOTQ0IDE3LjY3MDJDNTMuOTYxOCAxNy42NzAyIDUzLjcyOTIgMTcuNzA4OCA1My40OTY2IDE3Ljc4NjFDNTMuMzAyNyAxNy44NjMzIDUzLjEwODkgMTguMDE3OCA1My4wNzAxIDE4LjIxMDlDNTMuMDMxMyAxOC4zNjUzIDUzLjEwODkgMTguNTk3IDUzLjE4NjQgMTguNzEyOUM1My4zNDE1IDE4Ljk0NDYgNTMuNjEyOSAxOS4wMjE4IDUzLjg4NDIgMTkuMTM3N0M1NC40MjcgMTkuMzMwOCA1NC45Njk3IDE5LjQ4NTMgNTUuNTEyNSAxOS42NzgzQzU1LjkzODkgMTkuODMyOCA1Ni4zNjUzIDIwLjAyNTkgNTYuNzUzIDIwLjI1NzZDNTcuMjk1NyAyMC42MDUyIDU3Ljc5OTcgMjEuMTA3MiA1OC4wNzExIDIxLjcyNTFDNTguMzQyNCAyMi4zODE2IDU4LjMwMzcgMjMuMTUzOSA1OC4wMzIzIDIzLjc3MThDNTcuNzYwOSAyNC4zODk3IDU3LjI1NyAyNC44OTE3IDU2LjY3NTUgMjUuMjM5M0M1Ni4xMzI3IDI1LjU4NjggNTUuNTEyNCAyNS43Nzk5IDU0Ljg5MjIgMjUuODk1N0M1NC4xOTQ0IDI2LjA1MDIgNTMuNDU3OCAyNi4wODg4IDUyLjc2IDI2LjA4ODhDNTEuOTQ1OSAyNi4wODg4IDUxLjEzMTggMjUuOTczIDUwLjM5NTIgMjUuODU3MUM1MC4xMjM4IDI1LjgxODUgNDkuODUyNSAyNS43Nzk5IDQ5LjU0MjMgMjUuNzAyN0M0OS40MjYgMjUuNjY0IDQ5LjM0ODUgMjUuNjI1NCA0OS4yNzEgMjUuNTQ4MkM0OS4yMzIyIDI1LjQ3MSA0OS4xOTM0IDI1LjM1NTEgNDkuMTkzNCAyNS4yNzc5QzQ5LjE1NDcgMjUuMTIzNCA0OS4xNTQ3IDI1LjAwNzYgNDkuMTE1OSAyNC44OTE3QzQ4Ljk5OTYgMjQuNDI4MyA0OC44NDQ1IDIzLjg0OSA0OC42ODk1IDIzLjE1MzlaIiBmaWxsPSIjZWU2MjE2Ii8+CjxwYXRoIGQ9Ik02Mi44ODM3IDI0LjAwMTVDNjMuMDI0NiAyNC4zNzg0IDYzLjE2NTQgMjQuNzU1MyA2My4zMDYyIDI1LjEzMjJDNjMuMzUzMiAyNS4zMjA3IDYzLjQ0NzEgMjUuNDYyIDYzLjQ5NCAyNS42NTA1QzYzLjU0MSAyNS43NDQ3IDYzLjU4NzkgMjUuODg2MSA2My42ODE4IDI1LjkzMzJDNjMuODIyNiAyNi4wMjc0IDY0LjAxMDQgMjYuMDc0NSA2NC4xOTgyIDI2LjA3NDVDNjQuNDc5OSAyNi4wNzQ1IDY0LjcxNDYgMjYuMDc0NSA2NC45OTYzIDI2LjA3NDVDNjUuMjMxIDI2LjA3NDUgNjUuNDY1NyAyNi4wNzQ1IDY1LjY1MzUgMjYuMDc0NUM2Ni4wNzYgMjYuMDI3NCA2Ni40NTE2IDI1Ljg4NjEgNjYuODI3MiAyNS42OTc2QzY3LjIwMjcgMjUuNTA5MiA2Ny41MzEzIDI1LjMyMDcgNjcuODYgMjUuMDM4QzY4LjMyOTQgMjQuNjE0IDY4Ljc1MTkgMjQuMDk1NyA2OC45ODY2IDIzLjUzMDNDNjkuMzYyMiAyMi43Mjk0IDY5LjU1IDIxLjc4NzEgNjkuNTUgMjAuODkxOUM2OS41NSAyMC4yMzIzIDY5LjUwMyAxOS42MTk4IDY5LjMxNTMgMTkuMDA3M0M2OS4xMjc1IDE4LjQ0MTkgNjguODkyNyAxNy44NzY1IDY4LjUxNzIgMTcuNDA1NEM2OC4wOTQ3IDE2Ljg0IDY3LjU3ODMgMTYuMzY4OCA2Ni45NjggMTYuMDM5QzY2LjQwNDYgMTUuODAzNSA2NS43OTQ0IDE1LjcwOTIgNjUuMTg0MSAxNS42NjIxQzY0LjgwODUgMTUuNjYyMSA2NC40MzI5IDE1LjY2MjEgNjQuMTA0MyAxNS43NTYzQzYzLjkxNjUgMTUuODAzNSA2My42ODE4IDE1Ljg5NzcgNjMuNDk0IDE2LjAzOUM2My4zMDYyIDE2LjEzMzMgNjMuMTE4NSAxNi4yMjc1IDYyLjkzMDcgMTYuMjI3NUM2Mi44MzY4IDE2LjIyNzUgNjIuNjk1OSAxNi4xMzMzIDYyLjY0OSAxNi4wODYyQzYyLjYwMiAxNS45OTE5IDYyLjYwMjEgMTUuODUwNiA2Mi41MDgyIDE1Ljc1NjNDNjIuNDYxMiAxNS43MDkyIDYyLjM2NzMgMTUuNjYyMSA2Mi4yNzM0IDE1LjY2MjFDNjIuMTc5NSAxNS42NjIxIDYyLjA4NTcgMTUuNzU2MyA2MS45OTE4IDE1LjgwMzVDNjEuODA0IDE1Ljg5NzcgNjEuNjE2MiAxNS44OTc3IDYxLjQyODQgMTUuOTQ0OEM2MS4yNDA2IDE1Ljk0NDggNjEuMDk5OCAxNS45NDQ4IDYwLjkxMiAxNS45NDQ4QzYwLjIwNzggMTUuOTQ0OCA1OS41MDM3IDE1Ljk0NDggNTguODQ2NCAxNS45NDQ4QzU4LjcwNTYgMTUuOTQ0OCA1OC42MTE3IDE1Ljk0NDggNTguNDcwOSAxNS45NDQ4QzU4LjMzIDE1Ljk0NDggNTguMTg5MiAxNS45NDQ4IDU4LjE0MjIgMTUuOTkxOUM1OC4wOTUzIDE2LjAzOSA1OC4wNDgzIDE2LjA4NjEgNTguMDQ4MyAxNi4xODA0QzU4LjA0ODMgMTYuMjI3NSA1OC4wOTUzIDE2LjI3NDYgNTguMTQyMiAxNi4zNjg4QzU4LjIzNjEgMTYuNTU3MyA1OC4zNzcgMTYuNjk4NiA1OC41MTc4IDE2Ljg4NzFDNTguNjExNyAxNy4wMjg0IDU4LjcwNTYgMTcuMTIyNyA1OC43NTI1IDE3LjI2NEM1OC44NDY0IDE3LjQ1MjUgNTguNzk5NSAxNy42ODgxIDU4Ljc5OTUgMTcuOTIzNkM1OC43OTk1IDE4LjA2NSA1OC43OTk1IDE4LjIwNjMgNTguNzk5NSAxOC4zOTQ4QzU4Ljc5OTUgMTguOTEzMSA1OC43OTk1IDE5LjQzMTMgNTguNzk5NSAxOS45NDk2QzU4Ljc5OTUgMjAuNTYyMSA1OC43OTk1IDIxLjEyNzUgNTguNzk5NSAyMS43NEM1OC43OTk1IDIzLjY3MTcgNTguNzUyNSAyNS42NTA1IDU4Ljc5OTUgMjcuNTgyMkM1OC43OTk1IDI3LjkxMiA1OC43OTk1IDI4LjI0MTggNTguNzk5NSAyOC41NzE2QzU4Ljc5OTUgMjguNzYwMSA1OC43OTk1IDI4Ljk0ODUgNTguNzUyNSAyOS4wODk5QzU4LjcwNTYgMjkuMjc4MyA1OC42MTE3IDI5LjQ2NjggNTguNDcwOSAyOS42NTUzQzU4LjMzIDI5Ljg0MzcgNTguMjM2MSAyOS45ODUxIDU4LjA0ODMgMzAuMTczNUM1OS43ODUzIDMwLjE3MzUgNjEuNDc1NCAzMC4xNzM1IDYzLjIxMjMgMzAuMTczNUM2My4xMTg1IDMwLjA3OTMgNjMuMDI0NiAyOS45ODUxIDYyLjkzMDcgMjkuODkwOEM2Mi43NDI5IDI5LjcwMjQgNjIuNjAyMSAyOS40NjY4IDYyLjUwODIgMjkuMTg0MUM2Mi40NjEyIDI4Ljk5NTcgNjIuNDE0MyAyOC44MDcyIDYyLjQxNDMgMjguNjE4N0M2Mi40MTQzIDI4LjM4MzIgNjIuNDE0MyAyOC4xMDA1IDYyLjQxNDMgMjcuODY0OUM2Mi40MTQzIDI3LjQ4OCA2Mi40MTQzIDI3LjE1ODIgNjIuNDE0MyAyNi43ODEyQzYyLjQxNDMgMjQuNzU1MyA2Mi40MTQzIDIyLjc3NjUgNjIuNDE0MyAyMC43NTA1QzYyLjQxNDMgMjAuNTYyMSA2Mi40MTQzIDIwLjM3MzYgNjIuNDE0MyAyMC4xODUyQzYyLjQxNDMgMTkuOTQ5NiA2Mi40MTQzIDE5LjcxNCA2Mi40NjEyIDE5LjUyNTVDNjIuNTA4MiAxOS4yOSA2Mi41NTUxIDE5LjA1NDQgNjIuNjQ5IDE4Ljg2NTlDNjIuNzQyOSAxOC42MzA0IDYyLjkzMDcgMTguNDQxOSA2My4xNjU0IDE4LjM0NzdDNjMuMzUzMiAxOC4yNTM0IDYzLjU0MSAxOC4yMDYzIDYzLjcyODcgMTguMjA2M0M2My45MTY1IDE4LjIwNjMgNjQuMTUxMyAxOC4yMDYzIDY0LjMzOSAxOC4zMDA2QzY0LjYyMDcgMTguMzk0OCA2NC44MDg1IDE4LjU4MzIgNjQuOTk2MyAxOC44MTg4QzY1LjEzNzEgMTkuMDU0NCA2NS4yMzEgMTkuMzM3MSA2NS4zMjQ5IDE5LjYxOThDNjUuNDE4OCAxOS45OTY3IDY1LjUxMjcgMjAuMzczNiA2NS41NTk2IDIwLjc5NzdDNjUuNjA2NiAyMS4yNjg4IDY1LjYwNjYgMjEuNzM5OSA2NS41MTI3IDIyLjI1ODJDNjUuNDY1NyAyMi42ODIyIDY1LjM3MTggMjMuMDU5MiA2NS4xODQxIDIzLjM4OUM2NS4wOTAyIDIzLjU3NzQgNjQuOTAyNCAyMy43NjU5IDY0LjcxNDYgMjMuOTA3MkM2NC40Nzk5IDI0LjA0ODYgNjQuMTk4MiAyNC4xNDI4IDYzLjkxNjUgMjQuMTg5OUM2My41ODc5IDI0LjA5NTcgNjMuMjU5MyAyNC4wOTU3IDYyLjg4MzcgMjQuMDAxNVoiIGZpbGw9IiNlZTYyMTYiLz4KPHBhdGggZD0iTTgwLjQ5NzUgMjMuMDExMkM4MC40OTM2IDIzLjAzMzEgODAuNDkzNiAyMy4wNTEgODAuNDg5NiAyMy4wNjY5QzgwLjQ1NzggMjMuMTYyMyA4MC40MjYgMjMuMjU1NyA4MC4zOTQyIDIzLjM1MTFDODAuMzY0MyAyMy40Mzg2IDgwLjMzMDYgMjMuNTI2MSA4MC4zMDA3IDIzLjYxNTVDODAuMjcwOSAyMy43MDMgODAuMjQ1MSAyMy43OTI0IDgwLjIxNTMgMjMuODgxOUM4MC4xNzM1IDI0LjAwMzEgODAuMTI3OCAyNC4xMjQ0IDgwLjA4NDEgMjQuMjQ1N0M4MC4wNDIzIDI0LjM2MjkgODAuMDAwNiAyNC40NzgyIDc5Ljk1NjkgMjQuNTk1NUM3OS45MjExIDI0LjY5NDkgNzkuODgxMyAyNC43OTQzIDc5Ljg0NTUgMjQuODkzN0M3OS44MTU3IDI0Ljk3OTEgNzkuNzgzOSAyNS4wNjI2IDc5Ljc2MDEgMjUuMTUwMUM3OS43MDQ0IDI1LjM0MjkgNzkuNTg5MSAyNS40ODYgNzkuNDEwMiAyNS41Nzc1Qzc5LjI1NTIgMjUuNjU5IDc5LjA5NjEgMjUuNzMwNSA3OC45MzEyIDI1Ljc5MjFDNzguODQxNyAyNS44MjU5IDc4Ljc1MDMgMjUuODQ5OCA3OC42NTg4IDI1Ljg3OTZDNzguNTgxMyAyNS45MDM1IDc4LjUwNTggMjUuOTI5MyA3OC40MjgyIDI1Ljk1MTJDNzguMzY4NiAyNS45NjkxIDc4LjMwNyAyNS45ODMgNzguMjQ3NCAyNS45OTY5Qzc4LjE3OTggMjYuMDE0OCA3OC4xMTQyIDI2LjAzMjcgNzguMDQ2NiAyNi4wNDg2Qzc4LjAwNjggMjYuMDU4NSA3Ny45NjcxIDI2LjA2NjUgNzcuOTI1MyAyNi4wNzQ0Qzc3Ljg3MzcgMjYuMDg2MyA3Ny44MjIgMjYuMDk2MyA3Ny43NzAzIDI2LjEwODJDNzcuNzMyNSAyNi4xMTYyIDc3LjY5NjcgMjYuMTI0MSA3Ny42NTkgMjYuMTMwMUM3Ny42MDMzIDI2LjE0IDc3LjU0NzcgMjYuMTQ2IDc3LjQ5MiAyNi4xNTU5Qzc3LjQyNDQgMjYuMTY1OCA3Ny4zNTg4IDI2LjE3NzggNzcuMjkxMiAyNi4xODc3Qzc3LjI4NzMgMjYuMTg3NyA3Ny4yODEzIDI2LjE4OTcgNzcuMjc3MyAyNi4xODk3Qzc3LjE5NTggMjYuMTk3NyA3Ny4xMTIzIDI2LjIwNTYgNzcuMDMwOCAyNi4yMTU1Qzc2LjkzMTQgMjYuMjI1NSA3Ni44MzAxIDI2LjIzNTQgNzYuNzMwNyAyNi4yNDczQzc2LjcyMDcgMjYuMjQ5MyA3Ni43MTA4IDI2LjI0OTMgNzYuNzAwOSAyNi4yNTEzQzc2LjQwNDcgMjYuMjYxMyA3Ni4xMDg1IDI2LjI4MzEgNzUuODEyMyAyNi4yNzEyQzc1LjY4MTEgMjYuMjY1MiA3NS41NDk5IDI2LjI2MTMgNzUuNDIwNyAyNi4yNTEzQzc1LjMxNTQgMjYuMjQzNCA3NS4yMSAyNi4yMjk1IDc1LjEwNDcgMjYuMjE5NUM3NS4wMjMyIDI2LjIxMTYgNzQuOTM5NyAyNi4yMDU2IDc0Ljg1ODIgMjYuMTk1N0M3NC43ODg2IDI2LjE4NzcgNzQuNzE5IDI2LjE3MzggNzQuNjQ3NSAyNi4xNjE5Qzc0LjYwMzggMjYuMTUzOSA3NC41NiAyNi4xNDYgNzQuNTE2MyAyNi4xNEM3NC40NjQ2IDI2LjEzMjEgNzQuNDEwOSAyNi4xMjQxIDc0LjM1OTMgMjYuMTE0MkM3NC4zMTE1IDI2LjEwNjIgNzQuMjY1OCAyNi4wOTIzIDc0LjIyMDEgMjYuMDgyNEM3NC4xODQzIDI2LjA3NDQgNzQuMTQ4NiAyNi4wNjY1IDc0LjExNDggMjYuMDU4NUM3NC4wMTU0IDI2LjAzMjcgNzMuOTE0IDI2LjAwODggNzMuODE0NiAyNS45ODFDNzMuNzE5MiAyNS45NTUxIDczLjYyMTggMjUuOTI3MyA3My41MjY0IDI1Ljg5NTVDNzMuNDI1IDI1Ljg2MTcgNzMuMzIzNiAyNS44MjIgNzMuMjIyMiAyNS43ODIyQzczLjEwMyAyNS43MzQ1IDcyLjk4MzcgMjUuNjg4OCA3Mi44Njg0IDI1LjYzNTFDNzIuNTc2MiAyNS40OTk5IDcyLjI5MzkgMjUuMzQ0OSA3Mi4wMjc2IDI1LjE2QzcxLjY5MzYgMjQuOTI5NCA3MS4zODU1IDI0LjY2OSA3MS4xMjEyIDI0LjM2MDlDNzAuODkyNiAyNC4wOTQ2IDcwLjY5OTcgMjMuODAyNCA3MC41NDY3IDIzLjQ4NjNDNzAuNDc1MSAyMy4zMzcyIDcwLjQxMTUgMjMuMTg0MiA3MC4zNTU5IDIzLjAyOTFDNzAuMzIyMSAyMi45MzU3IDcwLjI5NjIgMjIuODM4MyA3MC4yNzA0IDIyLjc0MDlDNzAuMjQ0NSAyMi42NDk1IDcwLjIxODcgMjIuNTU4IDcwLjE5NjggMjIuNDY0NkM3MC4xNzg5IDIyLjM4MTEgNzAuMTY1IDIyLjI5NTYgNzAuMTUxMSAyMi4yMTIxQzcwLjE0MTIgMjIuMTUyNSA3MC4xMjkzIDIyLjA5MjkgNzAuMTE5MyAyMi4wMzEzQzcwLjExOTMgMjIuMDI3MyA3MC4xMTczIDIyLjAyNTMgNzAuMTE3MyAyMi4wMjEzQzcwLjEwOTQgMjEuOTU5NyA3MC4xMDE0IDIxLjg5NjEgNzAuMDk1NSAyMS44MzQ1QzcwLjA2OTYgMjEuNTg0IDcwLjA2NzYgMjEuMzMxNiA3MC4wNzM2IDIxLjA4MTFDNzAuMDc3NiAyMC45NDM5IDcwLjA4NTUgMjAuODA2OCA3MC4wOTc0IDIwLjY2OTZDNzAuMTA1NCAyMC41NjIzIDcwLjExOTMgMjAuNDU2OSA3MC4xMzcyIDIwLjM0OTZDNzAuMTUxMSAyMC4yNTQyIDcwLjE3MyAyMC4xNTg4IDcwLjE5MDkgMjAuMDYzNEM3MC4yMDQ4IDE5Ljk4NTggNzAuMjE4NyAxOS45MDgzIDcwLjIzNjYgMTkuODMwOEM3MC4yNTI1IDE5Ljc2MzIgNzAuMjcyNCAxOS42OTc2IDcwLjI5MDMgMTkuNjNDNzAuMzEyMSAxOS41NDg1IDcwLjMzMiAxOS40NjcgNzAuMzU1OSAxOS4zODc1QzcwLjM3NzcgMTkuMzE0IDcwLjQwMzYgMTkuMjQwNCA3MC40Mjc0IDE5LjE2ODlDNzAuNDUzMyAxOS4wOTEzIDcwLjQ4MTEgMTkuMDEzOCA3MC41MDg5IDE4LjkzODNDNzAuNTU2NiAxOC44MTcgNzAuNjAwNCAxOC42OTE4IDcwLjY1NiAxOC41NzQ1QzcwLjczNzUgMTguMzk5NiA3MC44MjEgMTguMjI0NyA3MC45MTY0IDE4LjA1NzdDNzEuMTQzIDE3LjY1NjIgNzEuNDE5MyAxNy4yODg0IDcxLjc1MzMgMTYuOTY4NEM3Mi4wOTEyIDE2LjY0MjQgNzIuNDY4OSAxNi4zNzIgNzIuODgyMyAxNi4xNTM0QzczLjA0MTQgMTYuMDY5OSA3My4yMDQ0IDE1Ljk5MjQgNzMuMzcxMyAxNS45MjQ4QzczLjQ5MDYgMTUuODc3MSA3My42MTE4IDE1LjgzNzMgNzMuNzMzMSAxNS43OTc2QzczLjgzNjUgMTUuNzYzOCA3My45Mzk4IDE1LjczMiA3NC4wNDMyIDE1LjcwNDFDNzQuMTE0OCAxNS42ODQzIDc0LjE4ODMgMTUuNjcyMyA3NC4yNTk5IDE1LjY1ODRDNzQuMzQ5MyAxNS42NDA1IDc0LjQ0MDggMTUuNjIwNyA3NC41MzAyIDE1LjYwNDhDNzQuNTkzOCAxNS41OTQ4IDc0LjY1NzQgMTUuNTg2OSA3NC43MjEgMTUuNTgwOUM3NC44NjAyIDE1LjU2OSA3NS4wMDEzIDE1LjU1OSA3NS4xNDI0IDE1LjU1MzFDNzUuMjUzOCAxNS41NDkxIDc1LjM2NTEgMTUuNTUxMSA3NS40NzQ0IDE1LjU1MzFDNzUuNTA4MiAxNS41NTMxIDc1LjU0NCAxNS41NTUxIDc1LjU3NzggMTUuNTU5Qzc1LjY5NSAxNS41NjcgNzUuODEyMyAxNS41NzEgNzUuOTI5NiAxNS41ODQ5Qzc2LjAzNSAxNS41OTY4IDc2LjEzODMgMTUuNjE4NyA3Ni4yNDE3IDE1LjYzNjZDNzYuMjg5NCAxNS42NDQ1IDc2LjMzOTEgMTUuNjUyNSA3Ni4zODY4IDE1LjY2MjRDNzYuNDI4NSAxNS42NzA0IDc2LjQ3MDMgMTUuNjgyMyA3Ni41MTIgMTUuNjkyMkM3Ni41NDc4IDE1LjcwMDIgNzYuNTgxNiAxNS43MTAxIDc2LjYxNzQgMTUuNzIwMUM3Ni43MDQ4IDE1Ljc0MzkgNzYuNzkwMyAxNS43Njc4IDc2Ljg3NzggMTUuNzk1NkM3Ni45NTkzIDE1LjgyMTQgNzcuMDM4OCAxNS44NTEyIDc3LjEyMDMgMTUuODc5MUM3Ny4yNTc0IDE1LjkyNDggNzcuMzg4NiAxNS45ODI0IDc3LjUxNzggMTYuMDQ0MUM3Ny43NDY0IDE2LjE1MzQgNzcuOTY3MSAxNi4yNzY2IDc4LjE3NzggMTYuNDE5N0M3OC41NDk1IDE2LjY3MDIgNzguODg1NCAxNi45NjI0IDc5LjE4MTYgMTcuMzAyM0M3OS40NTIgMTcuNjEyNCA3OS42Nzg2IDE3Ljk1MDMgNzkuODU3NSAxOC4zMjIxQzc5LjkzMSAxOC40NzUxIDc5Ljk5MjYgMTguNjMwMiA4MC4wNDgzIDE4Ljc4OTJDODAuMDg2MSAxOC44OTY1IDgwLjExNzkgMTkuMDA3OCA4MC4xNDc3IDE5LjExOTJDODAuMTczNSAxOS4yMTg1IDgwLjE5MzQgMTkuMzIxOSA4MC4yMTMzIDE5LjQyMzNDODAuMjMxMiAxOS41MTQ3IDgwLjI0OTEgMTkuNjA4MiA4MC4yNjY5IDE5LjY5OTZDODAuMjc2OSAxOS43NDkzIDgwLjI4MjggMTkuODAxIDgwLjI4ODggMTkuODUwN0M4MC4yOTg4IDE5Ljk0NjEgODAuMzAyNyAyMC4wNDE1IDgwLjMxNDcgMjAuMTM2OUM4MC4zMzI1IDIwLjI4NiA4MC4zMzQ1IDIwLjQzNTEgODAuMzM0NSAyMC41ODIyQzgwLjMzNDUgMjAuNzE1MyA4MC4zMzI1IDIwLjg1MDUgODAuMzMyNSAyMC45ODM3QzgwLjMzMjUgMjEuMDAzNiA4MC4zMjg2IDIxLjAyMzUgODAuMzI2NiAyMS4wNDUzQzgwLjMwMDcgMjEuMDQ3MyA4MC4yNzY5IDIxLjA0OTMgODAuMjU1IDIxLjA0OTNDNzkuMTUzOCAyMS4wNDkzIDc4LjA1MjYgMjEuMDQ5MyA3Ni45NTEzIDIxLjA1MTNDNzUuOTI5NiAyMS4wNTEzIDc0LjkwNzkgMjEuMDUzMyA3My44ODYyIDIxLjA1NTNDNzMuODA0NyAyMS4wNTUzIDczLjgwNDcgMjEuMDU3MiA3My44MDA3IDIxLjEzODdDNzMuNzkwNyAyMS4yODc4IDczLjgwODYgMjEuNDM2OSA3My44MjA2IDIxLjU4NEM3My44Mjg1IDIxLjY4MzQgNzMuODUyNCAyMS43ODI4IDczLjg3NDIgMjEuODgwMkM3My44OTQxIDIxLjk2OTYgNzMuOTEyIDIyLjA2MTEgNzMuOTM5OCAyMi4xNDY2Qzc0LjAwOTQgMjIuMzYxMiA3NC4xMDI4IDIyLjU2NCA3NC4yMjQxIDIyLjc1NDhDNzQuNDYwNiAyMy4xMjQ1IDc0Ljc2NjggMjMuNDIwNyA3NS4xMzQ1IDIzLjY1OTNDNzUuMjk3NSAyMy43NjQ2IDc1LjQ2ODQgMjMuODUyMSA3NS42NDczIDIzLjkyMzZDNzUuNzU2NyAyMy45Njc0IDc1Ljg2OCAyNC4wMDUxIDc1Ljk4NTMgMjQuMDMxQzc2LjA1NjggMjQuMDQ2OSA3Ni4xMjg0IDI0LjA2ODcgNzYuMTk5OSAyNC4wODI3Qzc2LjI1NzYgMjQuMDk0NiA3Ni4zMTcyIDI0LjEwMDUgNzYuMzc2OSAyNC4xMDg1Qzc2LjQ3NjIgMjQuMTIwNCA3Ni41NzM2IDI0LjEzMDQgNzYuNjczIDI0LjEzODNDNzYuODA0MiAyNC4xNDgyIDc2LjkzNzQgMjQuMTQ4MiA3Ny4wNzA2IDI0LjEzNjNDNzcuMTA2NCAyNC4xMzIzIDc3LjE0NDEgMjQuMTMwNCA3Ny4xNzk5IDI0LjEyODRDNzcuMjc1MyAyNC4xMjA0IDc3LjM3MDcgMjQuMTE2NCA3Ny40NjYyIDI0LjEwMjVDNzcuNTYzNiAyNC4wODg2IDc3LjY2MSAyNC4wNjg3IDc3Ljc1NjQgMjQuMDUwOEM3Ny44MzM5IDI0LjAzNjkgNzcuOTExNCAyNC4wMjMgNzcuOTg4OSAyNC4wMDUxQzc4LjA1NDUgMjMuOTkxMiA3OC4xMTgyIDIzLjk3MTMgNzguMTgzNyAyMy45NTM0Qzc4LjI0MTQgMjMuOTM3NSA3OC4zMDEgMjMuOTIzNiA3OC4zNTg3IDIzLjkwNzdDNzguNDEwNCAyMy44OTM4IDc4LjQ2MiAyMy44Nzc5IDc4LjUxMzcgMjMuODZDNzguNTgzMyAyMy44MzgyIDc4LjY1MDkgMjMuODE0MyA3OC43MTg1IDIzLjc5MDRDNzguNzkgMjMuNzY0NiA3OC44NTk2IDIzLjczODggNzguOTI5MiAyMy43MTI5Qzc5LjAwMjcgMjMuNjg1MSA3OS4wNzYzIDIzLjY1OTMgNzkuMTQ5OCAyMy42MzE0Qzc5LjI1NTIgMjMuNTg5NyA3OS4zNjA1IDIzLjU0NzkgNzkuNDYzOSAyMy41MDQyQzc5LjU3NzIgMjMuNDU2NSA3OS42ODg1IDIzLjQwNjggNzkuNzk3OCAyMy4zNTMxQzc5Ljk3MDggMjMuMjcxNiA4MC4xNDE3IDIzLjE4NjIgODAuMzE0NyAyMy4xMDI3QzgwLjM2ODMgMjMuMDc2OCA4MC40MTggMjMuMDQ3IDgwLjQ3MTcgMjMuMDIxMkM4MC40NzM3IDIzLjAxMzIgODAuNDgxNiAyMy4wMTUyIDgwLjQ5NzUgMjMuMDExMlpNNzMuNzc0OCAxOS4yMzA1Qzc0Ljc1ODggMTkuMjMwNSA3NS43MzQ4IDE5LjIzMDUgNzYuNzE0OCAxOS4yMzA1Qzc2LjcxNjggMTkuMjEwNiA3Ni43MTg4IDE5LjE5NDcgNzYuNzIyNyAxOS4xNzg4Qzc2LjczMjcgMTkuMDk5MyA3Ni43MjI3IDE5LjAxOTggNzYuNzIwNyAxOC45NDAzQzc2LjcxNjggMTguODQ0OCA3Ni42OTY5IDE4Ljc1MzQgNzYuNjc1IDE4LjY2MkM3Ni42NDcyIDE4LjU1NjYgNzYuNjA5NCAxOC40NTUyIDc2LjU1OTcgMTguMzU5OEM3Ni40NzYyIDE4LjE5MjkgNzYuMzY2OSAxOC4wNDc3IDc2LjIxOTggMTcuOTMwNUM3Ni4xNTQyIDE3Ljg3ODggNzYuMDg0NyAxNy44MzUxIDc2LjAwOTEgMTcuNzk3M0M3NS45MzU2IDE3Ljc2MTUgNzUuODYyIDE3LjcyNzcgNzUuNzg2NSAxNy42OTk5Qzc1LjcxMjkgMTcuNjc0IDc1LjYzNTQgMTcuNjU0MiA3NS41NTc5IDE3LjYzODNDNzUuNDcyNCAxNy42MjA0IDc1LjM4NSAxNy42MTI0IDc1LjI5NzUgMTcuNjA4NEM3NS4yNDk4IDE3LjYwNjUgNzUuMjAyMSAxNy42MTg0IDc1LjE1NDQgMTcuNjIwNEM3NS4wNzA5IDE3LjYyNDMgNzQuOTkxNCAxNy42NDQyIDc0LjkxMTkgMTcuNjY4MUM3NC43NzI3IDE3LjcwOTggNzQuNjM3NSAxNy43Njc1IDc0LjUxNDMgMTcuODQ1Qzc0LjI4OTcgMTcuOTgyMSA3NC4xMTQ4IDE4LjE2NSA3My45OTM1IDE4LjM5NzZDNzMuOTQ1OCAxOC40OTEgNzMuOTAwMSAxOC41ODQ0IDczLjg3MjIgMTguNjg1OEM3My44NTQ0IDE4Ljc0OTQgNzMuODMyNSAxOC44MTExIDczLjgxODYgMTguODc0N0M3My44MDI3IDE4Ljk0NjIgNzMuNzkyNyAxOS4wMTk4IDczLjc4MjggMTkuMDkzM0M3My43NzY4IDE5LjEzOSA3My43NzY4IDE5LjE4MjggNzMuNzc0OCAxOS4yMzA1WiIgZmlsbD0iI2VlNjIxNiIvPgo8cGF0aCBkPSJNODAuNTA2OCAyNS43NjY0QzgwLjYwNTggMjUuNjc5NSA4MC42OTkgMjUuNTg2OCA4MC43ODY0IDI1LjQ4ODNDODAuOTI2MSAyNS4zMjYxIDgxLjA0ODQgMjUuMTUyMyA4MS4xMjk5IDI0Ljk2MTFDODEuMjU4MSAyNC42NDgzIDgxLjI1ODEgMjQuMzAwNyA4MS4yNjM5IDIzLjk1MzFDODEuMjY5NyAyMy4xODI1IDgxLjI2MzkgMjIuNDQ2OCA4MS4yNjM5IDIxLjY5OTVDODEuMjYzOSAyMC42MjE5IDgxLjI2OTcgMTkuNTI3IDgxLjI2MzkgMTguNDM3OEM4MS4yNjM5IDE4LjI1ODIgODEuMjYzOSAxOC4wNzg2IDgxLjI2MzkgMTcuOTA0OEM4MS4yNjM5IDE3Ljc4MzIgODEuMjY5NyAxNy42NjE1IDgxLjI2MzkgMTcuNTM5OUM4MS4yNjM5IDE3LjQ2NDYgODEuMjU4MSAxNy4zODkyIDgxLjIzNDggMTcuMzEzOUM4MS4xODgyIDE3LjE0MDEgODEuMDQ4NCAxNy4wMDExIDgwLjkyNjEgMTYuODU2M0M4MC44MDk3IDE2LjcyMyA4MC43MDQ4IDE2LjU4NCA4MC42NDA4IDE2LjQyMThDODAuNTg4NCAxNi4yODg1IDgwLjU3NjcgMTYuMTM3OSA4MC41ODI1IDE1LjkzNTFDODEuMjM0OCAxNS45MzUxIDgxLjg4MTIgMTUuOTM1MSA4Mi41MzM0IDE1LjkzNTFDODIuODAxMiAxNS45MzUxIDgzLjA2OTEgMTUuOTM1MSA4My4zMTM3IDE1LjkzNTFDODMuNTE3NSAxNS45MzUxIDgzLjcwOTcgMTUuOTM1MSA4My45MzY4IDE1Ljg5NDZDODQuMTExNSAxNS44NjU2IDg0LjMxNTMgMTUuODEzNSA4NC40OTU4IDE1Ljc3ODdDODQuNjEyMyAxNS43NTU1IDg0LjcyMyAxNS43MzgyIDg0LjgzOTQgMTUuNzQzOUM4NC45MDkzIDE1Ljc0OTcgODQuOTc5MiAxNS43NjEzIDg1LjAzMTYgMTUuODAxOUM4NS4wNzgyIDE1Ljg0MjQgODUuMTAxNSAxNS45MDYyIDg1LjExODkgMTUuOTY0MUM4NS4xMzA2IDE2LjAxNjIgODUuMTMwNiAxNi4wNjg0IDg1LjEzMDYgMTYuMTI2M0M4NS4xMzY0IDE2LjI4ODUgODUuMTQyMiAxNi40NTA3IDg1LjEzMDYgMTYuNjEyOUM4NS4yMzU0IDE2LjUwMjkgODUuMzQ2MSAxNi4zOTg2IDg1LjQ2MjUgMTYuMjk0M0M4NS42MTM5IDE2LjE2MTEgODUuNzc3IDE2LjAzOTQgODUuOTUxNyAxNS45NDY3Qzg2LjEzMjIgMTUuODU0IDg2LjMzMDIgMTUuNzkwMyA4Ni41MjI0IDE1Ljc0MzlDODYuNzg0NCAxNS42ODYgODcuMDQwNyAxNS42NTcgODcuMzI2IDE1LjY2MjhDODcuNTI0IDE1LjY2MjggODcuNzM5NSAxNS42ODAyIDg3Ljg3MzQgMTUuODA3N0M4Ny45NDkxIDE1Ljg4MyA4Ny45OTU3IDE1Ljk4NzMgODguMDEzMiAxNi4wOTczQzg4LjAzNjUgMTYuMTk1OCA4OC4wMzA2IDE2LjMwMDEgODguMDMwNiAxNi4zOTg2Qzg4LjAzMDYgMTYuNjY1MSA4OC4wMzA2IDE2LjkzMTYgODguMDMwNiAxNy4yMDM5Qzg4LjAzMDYgMTcuNjI2OCA4OC4wMjQ4IDE4LjA0MzkgODguMDI0OCAxOC40MjYyQzg3LjQ4MzIgMTguNDIwNSA4Ny4wNzU2IDE4LjM5NzMgODYuNzAyOSAxOC40MTQ3Qzg2LjQ5MzMgMTguNDI2MiA4Ni4zMDExIDE4LjQ0OTQgODYuMDk3MyAxOC41MTg5Qzg1LjkxMDkgMTguNTgyNyA4NS43MTI5IDE4LjY4MTEgODUuNTQ5OSAxOC44MjAyQzg1LjM3NTIgMTguOTY1IDg1LjIzNTQgMTkuMTU2MiA4NS4xNDgxIDE5LjM2NDhDODUuMDQzMiAxOS42MjU1IDg1LjAzMTYgMTkuOTIwOSA4NS4wMzE2IDIwLjIwNDhDODUuMDMxNiAyMC40MTMzIDg1LjAzMTYgMjAuNjE2MSA4NS4wMzE2IDIwLjgxODlDODUuMDM3NCAyMS41MzE1IDg1LjA0OTEgMjIuMjQ0IDg1LjAzMTYgMjIuOTE2MUM4NS4wMTk5IDIzLjM4NTMgODQuOTk2NyAyMy44MzcyIDg1LjA1NDkgMjQuMzkzM0M4NS4wNzI0IDI0LjU0OTggODUuMDg5OCAyNC43MTIgODUuMTM2NCAyNC44NTY4Qzg1LjIwMDUgMjUuMDc3IDg1LjMxMTEgMjUuMjUwOCA4NS40Mjc2IDI1LjQxODhDODUuNTA5MSAyNS41MzQ2IDg1LjU5NjUgMjUuNjQ0NyA4NS42ODk2IDI1Ljc0OUM4My45NjAxIDI1Ljc2NjQgODIuMjM2NCAyNS43NjY0IDgwLjUwNjggMjUuNzY2NFoiIGZpbGw9IiNlZTYyMTYiLz4KPHBhdGggZD0iTTk4LjIwNzMgMjUuNzU4MkM5NC43ODA5IDI1Ljc1ODIgOTEuMzU0NiAyNS43NTgyIDg3LjkxNSAyNS43NTgyQzg3Ljk0MTQgMjUuNzI1MiA4Ny45NjEzIDI1LjY5MjEgODcuOTgxMSAyNS42Nzg5Qzg4LjMxMTkgMjUuNDA3NyA4OC41ODk3IDI1LjA5MDIgODguODM0NCAyNC43Mzk2Qzg4Ljk5MzIgMjQuNTE0NyA4OS4xMTg4IDI0LjI4MzIgODkuMjExNCAyNC4wMzE4Qzg5LjI3NzYgMjMuODQ2NiA4OS4zMTczIDIzLjY1NDggODkuMzYzNiAyMy40NjNDODkuNDI5NyAyMy4yMDUgODkuNDI5NyAyMi45NDA0IDg5LjQ1NjIgMjIuNjc1OUM4OS41MDkxIDIyLjE4NjQgODkuNDg5MyAyMS43MDM1IDg5LjQ4OTMgMjEuMjE0Qzg5LjQ4OTMgMjAuMDk2MiA4OS40ODkzIDE4Ljk3ODMgODkuNDc2IDE3Ljg2MDRDODkuNDY5NCAxNi45MDEzIDg5LjQ0OTYgMTUuOTQ4OCA4OS40Mjk3IDE0Ljk4OTdDODkuNDE2NSAxNC4zMzQ5IDg5LjQxNjUgMTMuNjggODkuMzkgMTMuMDE4NkM4OS4zNTcgMTIuMDI2NCA4OS4zNzAyIDExLjAyNzYgODkuMzM3MSAxMC4wMzU0Qzg5LjI4NDIgOC4zMzU0NiA4OS4zMTczIDYuNjI4OSA4OS4zMDQgNC45Mjg5NUM4OS4zMDQgNC42NjQzNyA4OS4zMTczIDQuNDA2NCA4OS4yNzEgNC4xNDE4MkM4OS4yNTc3IDQuMDgyMjkgODkuMjY0NCA0LjAxNjE0IDg5LjI2NDQgMy45NDk5OUM4OS4yNjQ0IDMuNzQ0OTQgODkuMjMxMyAzLjUzOTg5IDg5LjE4NSAzLjM0MTQ1Qzg5LjE1MTkgMy4yMDI1NSA4OS4xMjU1IDMuMDU3MDMgODkuMDg1OCAyLjkxODEyQzg4Ljk2MDEgMi40NzQ5NCA4OC43NjgzIDIuMDc4MDcgODguNDE3NyAxLjc2NzE4Qzg4LjI4NTQgMS42NDgxMiA4OC4xNTk3IDEuNTI5MDYgODguMDIwOCAxLjQxNjYxQzg3Ljk0MTQgMS4zNTA0NiA4Ny44ODE5IDEuMjcxMDkgODcuODQyMiAxLjE3ODQ5Qzg3Ljc3NjEgMS4wMTMxMiA4Ny44MTU4IDAuOTAwNjc0IDg4LjAyNzQgMC44Njc2MDFDODguMDg3IDAuODU0MzcyIDg4LjE0NjUgMC44NjA5ODYgODguMjA2IDAuODYwOTg2Qzg5LjI4NDIgMC44NjA5ODYgOTAuMzYyNCAwLjg2NzYwMiA5MS40MzM5IDAuODQ3NzU4QzkxLjkzIDAuODQxMTQzIDkyLjQzMjcgMC44MjEyOTkgOTIuOTI4OCAwLjgzNDUyOEM5NS40MjkxIDAuODk0MDU5IDk3LjkyOTUgMC44NDExNDMgMTAwLjQzNiAwLjg2NzYwMUMxMDAuNTYyIDAuODY3NjAxIDEwMC42ODEgMC44ODc0NDUgMTAwLjgwNyAwLjkwMDY3NEMxMDAuODQgMC45MDA2NzQgMTAwLjg2NiAwLjkwNzI4OSAxMDAuODk5IDAuOTA3Mjg5QzEwMS4xMzEgMC45MjcxMzMgMTAxLjM2MiAwLjk0MDM2MSAxMDEuNTk0IDAuOTY2ODJDMTAxLjcyNiAwLjk4MDA0OSAxMDEuODU5IDEuMDE5NzQgMTAxLjk4NCAxLjAzOTU4QzEwMi4wOTcgMS4wNTk0MiAxMDIuMjAyIDEuMDcyNjUgMTAyLjMxNSAxLjA5MjVDMTAyLjQxNCAxLjExMjM0IDEwMi41MDcgMS4xMzg4IDEwMi42MDYgMS4xNjUyNkMxMDIuNjcyIDEuMTg1MSAxMDIuNzMyIDEuMjA0OTQgMTAyLjc5OCAxLjIxODE3QzEwMy4xMDkgMS4yOTA5MyAxMDMuNDA2IDEuNDEgMTAzLjY5NyAxLjUzNTY3QzEwNC4yODYgMS43ODcwMyAxMDQuODE1IDIuMTMwOTkgMTA1LjI5OCAyLjU1NDMyQzEwNS43NzQgMi45NzEwNCAxMDYuMTg0IDMuNDQ3MjkgMTA2LjUyOCAzLjk3NjQ1QzEwNi43MzMgNC4yOTM5NSAxMDYuOTE5IDQuNjI0NjggMTA3LjA1OCA0Ljk3NTI1QzEwNy4xMyA1LjE2MDQ2IDEwNy4yMDMgNS4zNDU2NyAxMDcuMjY5IDUuNTM3NDlDMTA3LjMxNiA1LjY3NjQgMTA3LjM0MiA1LjgyMTkyIDEwNy4zNzUgNS45Njc0NEMxMDcuNDIxIDYuMTc5MTEgMTA3LjQ1NCA2LjM5MDc3IDEwNy40OTQgNi42MDI0NEMxMDcuNDk0IDYuNjE1NjcgMTA3LjUwMSA2LjYyMjI4IDEwNy41MDEgNi42MzU1MUMxMDcuNTE0IDYuOTU5NjMgMTA3LjUzNCA3LjI4Mzc0IDEwNy41NCA3LjYxNDQ3QzEwNy41NCA3LjgxOTUyIDEwNy41MjcgOC4wMTc5NiAxMDcuNTAxIDguMjIzMDFDMTA3LjQ3NCA4LjQ0MTI5IDEwNy40MjEgOC42NTk1NyAxMDcuMzgyIDguODg0NDdDMTA3LjMzNSA5LjE2ODg5IDEwNy4yNDMgOS40NDAwOSAxMDcuMTQ0IDkuNzA0NjdDMTA2LjkzMiAxMC4yNTM3IDEwNi42NDEgMTAuNzYzIDEwNi4yNjQgMTEuMjE5NEMxMDUuOTk5IDExLjU0MzUgMTA1LjY4OCAxMS44MjEzIDEwNS4zNzEgMTIuMDkyNUMxMDQuODY4IDEyLjUyMjUgMTA0LjMzMiAxMi45MDYxIDEwMy43NTcgMTMuMjQzNUMxMDMuNTUyIDEzLjM2MjUgMTAzLjMzNCAxMy40NjE4IDEwMy4xMjIgMTMuNTY3NkMxMDMuMDQ5IDEzLjYwMDcgMTAzLjA0MyAxMy42MTM5IDEwMy4wODIgMTMuNjhDMTAzLjMwNyAxNC4wMzA2IDEwMy41MzIgMTQuMzg3OCAxMDMuNzU3IDE0LjczODRDMTAzLjkyMiAxNS4wMDMgMTA0LjA5NCAxNS4yNjc1IDEwNC4yNTMgMTUuNTMyMUMxMDQuNTQ0IDE2LjAwODQgMTA0LjgzNSAxNi40NzggMTA1LjExOSAxNi45NTQzQzEwNS4zODQgMTcuMzkwOCAxMDUuNjU1IDE3LjgzNCAxMDUuOTIgMTguMjc3MkMxMDYuMjExIDE4Ljc2IDEwNi41MDIgMTkuMjQ5NSAxMDYuNzkzIDE5LjczOUMxMDcuMTgzIDIwLjM4NzIgMTA3LjU2NyAyMS4wMzU0IDEwNy45NTcgMjEuNjgzN0MxMDguMjIyIDIyLjEyNjggMTA4LjQ5MyAyMi41NjM0IDEwOC43NzEgMjNDMTA5LjA2MiAyMy40NDMxIDEwOS4zOTkgMjMuODUzMyAxMDkuNzUgMjQuMjUwMUMxMTAuMTczIDI0LjcxOTggMTEwLjYyMyAyNS4xNTYzIDExMS4xMTIgMjUuNTU5OEMxMTEuMTE5IDI1LjU2NjQgMTExLjExOSAyNS41NzMgMTExLjEzOSAyNS41ODYzQzExMS4wNzMgMjUuNjA2MSAxMTEuMDA2IDI1LjYzMjYgMTEwLjk0NyAyNS42MzI2QzExMC42ODkgMjUuNjUyNCAxMTAuNDMxIDI1LjY1OSAxMTAuMTggMjUuNjkyMUMxMDkuOTc1IDI1LjcxODYgMTA5Ljc3IDI1LjcwNTMgMTA5LjU2NCAyNS43Mzg0QzEwOS4zOTMgMjUuNzY0OSAxMDkuMjIxIDI1Ljc1MTYgMTA5LjA0OSAyNS43NzgxQzEwOC43OTEgMjUuODE3OCAxMDguNTMzIDI1Ljc5MTMgMTA4LjI3NSAyNS44MzFDMTA3LjkzNyAyNS44NzczIDEwNy42IDI1Ljg1MDkgMTA3LjI2MyAyNS44NzA3QzEwNi4yNjQgMjUuOTQzNSAxMDUuMjcyIDI1Ljg5MDUgMTA0LjI3MyAyNS45MDM4QzEwNC4wNzQgMjUuOTAzOCAxMDMuODY5IDI1Ljg5MDUgMTAzLjY3MSAyNS44NTA5QzEwMy4wNDkgMjUuNzM4NCAxMDIuNTEzIDI1LjQ1NCAxMDIuMDM3IDI1LjAzNzNDMTAxLjcgMjQuNzM5NiAxMDEuNDIyIDI0LjM5NTYgMTAxLjE5NyAyNC4wMTJDMTAwLjk5MiAyMy42NzQ3IDEwMC44IDIzLjMyNDEgMTAwLjYwOCAyMi45ODAxQzEwMC40NDMgMjIuNjg5MSAxMDAuMjc4IDIyLjM5OCAxMDAuMTE5IDIyLjEwN0M5OS44NjA5IDIxLjYzNzQgOTkuNjAyOSAyMS4xNjExIDk5LjM1MTYgMjAuNjkxNUM5OS4wNDczIDIwLjEyMjYgOTguNzQ5NyAxOS41NTM4IDk4LjQ1MiAxOC45ODQ5Qzk4LjEzNDUgMTguMzgzIDk3LjgxNyAxNy43ODc3IDk3LjQ3MyAxNy4yMDU2Qzk3LjE2MjIgMTYuNjc2NCA5Ni44NjQ1IDE2LjEzNCA5Ni41NjAyIDE1LjU5ODNDOTYuNTQ3IDE1LjU3ODQgOTYuNTMzOCAxNS41NjUyIDk2LjQ5NDEgMTUuNTU4NkM5Ni40OTQxIDE1LjU5MTYgOTYuNDk0MSAxNS42MjQ3IDk2LjQ5NDEgMTUuNjU3OEM5Ni40OTQxIDE3LjY4ODUgOTYuNDk0MSAxOS43MjU4IDk2LjQ5NDEgMjEuNzU2NEM5Ni40OTQxIDIyLjEzMzUgOTYuNTAwNyAyMi41MDM5IDk2LjUyMDUgMjIuODgwOUM5Ni41MjcyIDIzLjA0NjMgOTYuNTY2OSAyMy4yMDUgOTYuNTkzMyAyMy4zNzA0Qzk2LjYxMzIgMjMuNDgyOCA5Ni42MjY0IDIzLjU4ODcgOTYuNjU5NSAyMy43MDExQzk2LjY5OTEgMjMuODQgOTYuNzQ1NCAyMy45ODU1IDk2LjgwNSAyNC4xMTc4Qzk2LjkxNzQgMjQuMzgyNCA5Ny4wNTYzIDI0LjYzMzggOTcuMjI4MyAyNC44NjUzQzk3LjQ3OTcgMjUuMTg5NCA5Ny43NjQxIDI1LjQ2NzIgOTguMTE0NyAyNS42ODU1Qzk4LjE0NzcgMjUuNzA1MyA5OC4xODA4IDI1LjczMTggOTguMjEzOSAyNS43NTE2Qzk4LjIxMzkgMjUuNzQ1IDk4LjIxMzkgMjUuNzUxNiA5OC4yMDczIDI1Ljc1ODJaTTk2LjQ0MTIgNC42MTE0NUM5Ni40MTQ3IDQuNzcwMiA5Ni40MTQ3IDEzLjAzMTggOTYuNDQxMiAxMy4xMTEyQzk2LjQ1NDQgMTMuMTExMiA5Ni40Njc2IDEzLjExNzggOTYuNDgwOSAxMy4xMTc4Qzk2LjU2MDIgMTMuMTA0NiA5Ni42Mzk2IDEzLjA5MTMgOTYuNzE5IDEzLjA3MTVDOTYuODExNiAxMy4wNTE3IDk2LjkxMDggMTMuMDQ1IDk3LjAwMzQgMTMuMDE4NkM5Ny4xNjg4IDEyLjk2NTcgOTcuMzI3NSAxMi45MDYxIDk3LjQ5MjkgMTIuODUzMkM5Ny43NDQyIDEyLjc2NzIgOTcuOTgyNCAxMi42NDgyIDk4LjIxMzkgMTIuNTA5M0M5OC42NDM4IDEyLjI1MTMgOTkuMDIwOSAxMS45MjcyIDk5LjM1MTYgMTEuNTU2OEM5OS43MDIyIDExLjE1OTkgOTkuOTg2NiAxMC43Mjk5IDEwMC4xOTggMTAuMjQ3MUMxMDAuMjc4IDEwLjA2ODUgMTAwLjMzNyA5Ljg4MzI3IDEwMC4zOTcgOS42OTE0NUMxMDAuNDM2IDkuNTY1NzcgMTAwLjQ2MyA5LjQzMzQ4IDEwMC40OTYgOS4zMDExOUMxMDAuNTM2IDkuMTIyNTkgMTAwLjU3NSA4Ljk0NCAxMDAuNTc1IDguNzU4NzlDMTAwLjU3NSA4LjY5MjY0IDEwMC41ODIgOC42MjY1IDEwMC41ODIgOC41NTM3NEMxMDAuNTg5IDguMTYzNDggMTAwLjU4OSA3Ljc3MzIyIDEwMC40ODkgNy4zOTYxOUMxMDAuNDM2IDcuMjEwOTggMTAwLjQwMyA3LjAxOTE2IDEwMC4zMzcgNi44NDA1NkMxMDAuMjExIDYuNDg5OTkgMTAwLjAzMyA2LjE2NTg4IDk5Ljc5NDggNS44NjgyMkM5OS41NTY2IDUuNTc3MTggOTkuMjg1NCA1LjMyNTgzIDk4Ljk1NDcgNS4xMjczOUM5OC43Njk1IDUuMDE0OTQgOTguNTcxMSA0LjkyODk1IDk4LjM3MjYgNC44NDI5NkM5OC4yNzM0IDQuNzk2NjYgOTguMTYxIDQuNzcwMiA5OC4wNTUxIDQuNzQzNzRDOTcuOTY5MSA0LjcyMzkgOTcuODgzMiA0LjcwNDA1IDk3Ljc5NzIgNC42OTA4M0M5Ny42NzE1IDQuNjY0MzcgOTcuNTUyNCA0LjYxODA3IDk3LjQyNjcgNC42MTgwN0M5Ny4xMDkyIDQuNTk4MjIgOTYuNzc4NSA0LjYxMTQ1IDk2LjQ0MTIgNC42MTE0NVoiIGZpbGw9IiNlZTYyMTYiLz4KPHBhdGggZD0iTTExNC43ODcgMTUuNzcxOEMxMTUuMDU5IDE1Ljc2MzkgMTE1LjMyOCAxNS43NzcgMTE1LjU5NSAxNS44MDU4QzExNS43OTkgMTUuODI5MyAxMTYuMDAzIDE1Ljg2MzMgMTE2LjIwNyAxNS45QzExNi4zNDMgMTUuOTIzNSAxMTYuNDgyIDE1Ljk1MjMgMTE2LjYxNiAxNS45ODg5QzExNi44NTYgMTYuMDU0MyAxMTcuMDkyIDE2LjEzOCAxMTcuMzE5IDE2LjI0QzExNy43ODcgMTYuNDQ2NyAxMTguMjE3IDE2LjcxNjEgMTE4LjU5OCAxNy4wNTFDMTE4Ljk5MyAxNy4zOTYzIDExOS4zMiAxNy43OTkyIDExOS41ODUgMTguMjU0NEMxMTkuNzEzIDE4LjQ3MTUgMTE5LjgyMyAxOC42OTkxIDExOS45MTcgMTguOTMxOUMxMTkuOTcyIDE5LjA2NTMgMTIwLjAxNCAxOS4yMDQgMTIwLjA1NiAxOS4zNDI2QzEyMC4wOTIgMTkuNDU1MSAxMjAuMTI0IDE5LjU3MDIgMTIwLjE1MiAxOS42ODUzQzEyMC4xNjggMTkuNzQ1NSAxMjAuMTc2IDE5LjgwODMgMTIwLjE4NiAxOS44NzFDMTIwLjIwMiAxOS45NDY5IDEyMC4yMTUgMjAuMDIyOCAxMjAuMjMxIDIwLjEwMTJDMTIwLjIzMyAyMC4xMDkxIDEyMC4yMzMgMjAuMTE5NiAxMjAuMjM2IDIwLjEyNzRDMTIwLjI0NCAyMC4xOTU0IDEyMC4yNTcgMjAuMjY2MSAxMjAuMjYgMjAuMzM0MUMxMjAuMjY1IDIwLjU2OTUgMTIwLjMwMSAyMC44MDIzIDEyMC4yNzMgMjEuMDM3OEMxMjAuMjY3IDIxLjA3OTYgMTIwLjI3IDIxLjEyMTUgMTIwLjI2NyAyMS4xNjA3QzEyMC4yNTcgMjEuMjkxNSAxMjAuMjUyIDIxLjQyMjMgMTIwLjIzMyAyMS41NTA1QzEyMC4yMTggMjEuNjc2MSAxMjAuMTg5IDIxLjc5NjQgMTIwLjE2NSAyMS45MjJDMTIwLjE0NyAyMi4wMTYyIDEyMC4xMjkgMjIuMTEyOSAxMjAuMTA1IDIyLjIwNzFDMTIwLjA3NiAyMi4zMTQ0IDEyMC4wNDUgMjIuNDE5IDEyMC4wMDggMjIuNTIzN0MxMTkuOTY3IDIyLjY0OTIgMTE5LjkyMiAyMi43NzIyIDExOS44NzUgMjIuODk1MUMxMTkuNzcgMjMuMTY0NiAxMTkuNjQyIDIzLjQyMDkgMTE5LjQ5IDIzLjY2OTVDMTE5LjAwNyAyNC40NTQzIDExOC4zMzkgMjUuMDM1IDExNy41MSAyNS40M0MxMTcuMjIyIDI1LjU2ODcgMTE2LjkyNCAyNS42ODEyIDExNi42MTggMjUuNzY3NUMxMTYuNDE0IDI1LjgyMjQgMTE2LjIwNyAyNS44Nzc0IDExNS45OTggMjUuOTIxOEMxMTUuODI4IDI1Ljk1ODUgMTE1LjY1OCAyNS45OTI1IDExNS40ODUgMjYuMDE2QzExNS4xMzcgMjYuMDYwNSAxMTQuNzg3IDI2LjA5NDUgMTE0LjQzNiAyNi4wNjgzQzExNC4xOSAyNi4wNSAxMTMuOTQ3IDI2LjAyMzkgMTEzLjcwNCAyNS45ODk5QzExMy40NzYgMjUuOTU1OCAxMTMuMjQ5IDI1LjkxNjYgMTEzLjAyNCAyNS44NjE3QzExMi40ODcgMjUuNzMzNSAxMTEuOTcyIDI1LjU1MDQgMTExLjUwNCAyNS4yNDk1QzExMS4wNDEgMjQuOTQ4NyAxMTAuNjQzIDI0LjU4MjQgMTEwLjMwNiAyNC4xNDU2QzExMC4wODkgMjMuODYwNCAxMDkuOTA1IDIzLjU1NDQgMTA5Ljc1MSAyMy4yM0MxMDkuNjY3IDIzLjA1MjEgMTA5LjU5NCAyMi44NzE2IDEwOS41MjkgMjIuNjg1OUMxMDkuNDkyIDIyLjU4OTEgMTA5LjQ2OSAyMi40ODcgMTA5LjQ0IDIyLjM4NzZDMTA5LjQwNiAyMi4yNjk5IDEwOS4zNzQgMjIuMTQ5NiAxMDkuMzQ2IDIyLjAzMTlDMTA5LjMzIDIxLjk3MTcgMTA5LjMyMiAyMS45MDg5IDEwOS4zMTIgMjEuODQ2MUMxMDkuMjk5IDIxLjc3MDMgMTA5LjI4MyAyMS42OTE4IDEwOS4yNyAyMS42MTU5QzEwOS4yNyAyMS42MTA3IDEwOS4yNjcgMjEuNjAyOCAxMDkuMjY1IDIxLjU5NzZDMTA5LjI1NCAyMS40OTMgMTA5LjI0MSAyMS4zODU3IDEwOS4yMzMgMjEuMjgxMUMxMDkuMjIzIDIxLjEwMzIgMTA5LjIxIDIwLjkyNTMgMTA5LjIxMiAyMC43NDc0QzEwOS4yMTIgMjAuNTk1NyAxMDkuMjI1IDIwLjQ0MzkgMTA5LjI0MSAyMC4yOTIyQzEwOS4yNTEgMjAuMTc3MSAxMDkuMjcgMjAuMDY0NiAxMDkuMjkzIDE5Ljk1MjFDMTA5LjMyIDE5LjgyNCAxMDkuMzU0IDE5LjY5NTggMTA5LjM4OCAxOS41Njc2QzEwOS40MTkgMTkuNDUyNSAxMDkuNDU4IDE5LjM0MjYgMTA5LjQ5NSAxOS4yMzAxQzEwOS41NTIgMTkuMDU0OCAxMDkuNjI4IDE4Ljg4NDggMTA5LjcxNSAxOC43MkMxMTAuMDI4IDE4LjExMDUgMTEwLjQ0NCAxNy41Nzk0IDExMC45NTcgMTcuMTI0MkMxMTEuMzg5IDE2LjczOTcgMTExLjg2NyAxNi40MzM2IDExMi4zOTkgMTYuMjA2QzExMi42NDIgMTYuMTAxNCAxMTIuODkzIDE2LjAxNzcgMTEzLjE1MiAxNS45NTc1QzExMy4zODUgMTUuOTA1MiAxMTMuNjIgMTUuODYwNyAxMTMuODU4IDE1LjgyOTNDMTE0LjE2NCAxNS43Nzk2IDExNC40NzYgMTUuNzY5MiAxMTQuNzg3IDE1Ljc3MThaTTExNi42NjUgMjEuMjUyM0MxMTYuNjYzIDIxLjI1MjMgMTE2LjY2IDIxLjI1MjMgMTE2LjY1NyAyMS4yNTIzQzExNi42NTcgMjEuMDE5NSAxMTYuNjYgMjAuNzg2NiAxMTYuNjU3IDIwLjU1MzhDMTE2LjY1NSAyMC4zNzU5IDExNi42MzkgMjAuMTk4IDExNi42MjkgMjAuMDIwMkMxMTYuNjI5IDIwLjAwOTcgMTE2LjYyNiAxOS45OTkyIDExNi42MjMgMTkuOTg4OEMxMTYuNjA4IDE5LjkwNSAxMTYuNTk1IDE5LjgyMTMgMTE2LjU3OSAxOS43NDAyQzExNi41NjEgMTkuNjQzNCAxMTYuNTQ4IDE5LjU0NCAxMTYuNTE5IDE5LjQ0NzJDMTE2LjQ3OSAxOS4zMDYgMTE2LjQzIDE5LjE2NzMgMTE2LjM3MiAxOS4wMzM5QzExNi4yNTIgMTguNzUxNCAxMTYuMDg3IDE4LjQ5NzYgMTE1Ljg3IDE4LjI3NzlDMTE1LjcwOCAxOC4xMTMxIDExNS41MjIgMTcuOTgyMyAxMTUuMzA4IDE3Ljg5ODZDMTE1LjA0NiAxNy43OTY2IDExNC43NzEgMTcuNzcwNCAxMTQuNDk0IDE3Ljc3M0MxMTQuNDI2IDE3Ljc3MyAxMTQuMzU1IDE3Ljc4MDkgMTE0LjI4NyAxNy43OTM5QzExNC4xNDMgMTcuODI1MyAxMTQuMDA3IDE3Ljg3NzcgMTEzLjg4NCAxNy45NTYxQzExMy41OTEgMTguMTQ0NSAxMTMuMzY2IDE4LjM5MyAxMTMuMjA3IDE4LjY5OTFDMTEzLjA4NCAxOC45MzE5IDExMi45OSAxOS4xNzc4IDExMi45NCAxOS40Mzk0QzExMi45MTQgMTkuNTcwMiAxMTIuODg1IDE5LjcwMzYgMTEyLjg2OSAxOS44MzQ0QzExMi44NTEgMjAuMDIwMiAxMTIuODMgMjAuMjA1OSAxMTIuODMzIDIwLjM5NDJDMTEyLjgzMyAyMC41MDQxIDExMi44MjUgMjAuNjExNCAxMTIuODIyIDIwLjcyMTJDMTEyLjgyIDIwLjgyODUgMTEyLjgxMiAyMC45MzU3IDExMi44MjIgMjEuMDQwNEMxMTIuODQzIDIxLjIyODcgMTEyLjgzMyAyMS40MTk3IDExMi44NTkgMjEuNjA4MUMxMTIuODc3IDIxLjczMzYgMTEyLjg5IDIxLjg2MTggMTEyLjkxNCAyMS45ODc0QzExMi45MzUgMjIuMTA3NyAxMTIuOTU4IDIyLjIyODEgMTEyLjk5NSAyMi4zNDg0QzExMy4wMzQgMjIuNDgxOCAxMTMuMDY2IDIyLjYxNTIgMTEzLjExIDIyLjc0NkMxMTMuMTYyIDIyLjkwMDQgMTEzLjIzIDIzLjA0OTUgMTEzLjMxNCAyMy4xOTA3QzExMy40MjcgMjMuMzc5MSAxMTMuNTYzIDIzLjU0OTEgMTEzLjc0NiAyMy42NzczQzExNC4xMiAyMy45MzM3IDExNC41MzYgMjQuMDYxOSAxMTQuOTg4IDI0LjA2OTdDMTE1LjE2NiAyNC4wNzIzIDExNS4zMzQgMjQuMDM1NyAxMTUuNDk4IDIzLjk3MjlDMTE1LjgxIDIzLjg1MjYgMTE2LjA1MyAyMy42NDU5IDExNi4yNDQgMjMuMzc2NUMxMTYuNDA0IDIzLjE1MTUgMTE2LjUgMjIuOTAwNCAxMTYuNTU4IDIyLjYzMDlDMTE2LjU2OCAyMi41ODEyIDExNi41ODIgMjIuNTI4OSAxMTYuNTg5IDIyLjQ3OTJDMTE2LjYwNSAyMi4zOTI5IDExNi42MjYgMjIuMzAzOSAxMTYuNjMxIDIyLjIxNUMxMTYuNjQyIDIxLjg5MzIgMTE2LjY1MiAyMS41NzQxIDExNi42NjUgMjEuMjUyM1oiIGZpbGw9IiNlZTYyMTYiLz4KPHBhdGggZD0iTTEyNi4zOTQgMTUuNzcxOEMxMjYuNjY2IDE1Ljc2MzkgMTI2LjkzNiAxNS43NzcgMTI3LjIwMyAxNS44MDU4QzEyNy40MDcgMTUuODI5MyAxMjcuNjExIDE1Ljg2MzMgMTI3LjgxNSAxNS45QzEyNy45NTEgMTUuOTIzNSAxMjguMDkgMTUuOTUyMyAxMjguMjIzIDE1Ljk4ODlDMTI4LjQ2NCAxNi4wNTQzIDEyOC42OTkgMTYuMTM4IDEyOC45MjcgMTYuMjRDMTI5LjM5NSAxNi40NDY3IDEyOS44MjQgMTYuNzE2MSAxMzAuMjA2IDE3LjA1MUMxMzAuNjAxIDE3LjM5NjMgMTMwLjkyOCAxNy43OTkyIDEzMS4xOTIgMTguMjU0NEMxMzEuMzIgMTguNDcxNSAxMzEuNDMgMTguNjk5MSAxMzEuNTI0IDE4LjkzMTlDMTMxLjU3OSAxOS4wNjUzIDEzMS42MjEgMTkuMjA0IDEzMS42NjMgMTkuMzQyNkMxMzEuNyAxOS40NTUxIDEzMS43MzEgMTkuNTcwMiAxMzEuNzYgMTkuNjg1M0MxMzEuNzc1IDE5Ljc0NTUgMTMxLjc4MyAxOS44MDgzIDEzMS43OTQgMTkuODcxQzEzMS44MDkgMTkuOTQ2OSAxMzEuODIzIDIwLjAyMjggMTMxLjgzOCAyMC4xMDEyQzEzMS44NDEgMjAuMTA5MSAxMzEuODQxIDIwLjExOTYgMTMxLjg0MyAyMC4xMjc0QzEzMS44NTEgMjAuMTk1NCAxMzEuODY0IDIwLjI2NjEgMTMxLjg2NyAyMC4zMzQxQzEzMS44NzIgMjAuNTY5NSAxMzEuOTA5IDIwLjgwMjMgMTMxLjg4IDIxLjAzNzhDMTMxLjg3NSAyMS4wNzk2IDEzMS44NzcgMjEuMTIxNSAxMzEuODc1IDIxLjE2MDdDMTMxLjg2NCAyMS4yOTE1IDEzMS44NTkgMjEuNDIyMyAxMzEuODQxIDIxLjU1MDVDMTMxLjgyNSAyMS42NzYxIDEzMS43OTYgMjEuNzk2NCAxMzEuNzczIDIxLjkyMkMxMzEuNzU1IDIyLjAxNjIgMTMxLjczNiAyMi4xMTI5IDEzMS43MTMgMjIuMjA3MUMxMzEuNjg0IDIyLjMxNDQgMTMxLjY1MyAyMi40MTkgMTMxLjYxNiAyMi41MjM3QzEzMS41NzQgMjIuNjQ5MiAxMzEuNTMgMjIuNzcyMiAxMzEuNDgyIDIyLjg5NTFDMTMxLjM3OCAyMy4xNjQ2IDEzMS4yNSAyMy40MjA5IDEzMS4wOTggMjMuNjY5NUMxMzAuNjE0IDI0LjQ1NDMgMTI5Ljk0NyAyNS4wMzUgMTI5LjExOCAyNS40M0MxMjguODMgMjUuNTY4NyAxMjguNTMyIDI1LjY4MTIgMTI4LjIyNiAyNS43Njc1QzEyOC4wMjIgMjUuODIyNCAxMjcuODE1IDI1Ljg3NzQgMTI3LjYwNiAyNS45MjE4QzEyNy40MzYgMjUuOTU4NSAxMjcuMjY1IDI1Ljk5MjUgMTI3LjA5MyAyNi4wMTZDMTI2Ljc0NSAyNi4wNjA1IDEyNi4zOTQgMjYuMDk0NSAxMjYuMDQ0IDI2LjA2ODNDMTI1Ljc5OCAyNi4wNSAxMjUuNTU1IDI2LjAyMzkgMTI1LjMxMSAyNS45ODk5QzEyNS4wODQgMjUuOTU1OCAxMjQuODU2IDI1LjkxNjYgMTI0LjYzMSAyNS44NjE3QzEyNC4wOTUgMjUuNzMzNSAxMjMuNTggMjUuNTUwNCAxMjMuMTExIDI1LjI0OTVDMTIyLjY0OCAyNC45NDg3IDEyMi4yNTEgMjQuNTgyNCAxMjEuOTEzIDI0LjE0NTZDMTIxLjY5NiAyMy44NjA0IDEyMS41MTMgMjMuNTU0NCAxMjEuMzU5IDIzLjIzQzEyMS4yNzUgMjMuMDUyMSAxMjEuMjAyIDIyLjg3MTYgMTIxLjEzNiAyMi42ODU5QzEyMS4xIDIyLjU4OTEgMTIxLjA3NiAyMi40ODcgMTIxLjA0NyAyMi4zODc2QzEyMS4wMTMgMjIuMjY5OSAxMjAuOTgyIDIyLjE0OTYgMTIwLjk1MyAyMi4wMzE5QzEyMC45MzcgMjEuOTcxNyAxMjAuOTMgMjEuOTA4OSAxMjAuOTE5IDIxLjg0NjFDMTIwLjkwNiAyMS43NzAzIDEyMC44OSAyMS42OTE4IDEyMC44NzcgMjEuNjE1OUMxMjAuODc3IDIxLjYxMDcgMTIwLjg3NSAyMS42MDI4IDEyMC44NzIgMjEuNTk3NkMxMjAuODYyIDIxLjQ5MyAxMjAuODQ4IDIxLjM4NTcgMTIwLjg0MSAyMS4yODExQzEyMC44MyAyMS4xMDMyIDEyMC44MTcgMjAuOTI1MyAxMjAuODIgMjAuNzQ3NEMxMjAuODIgMjAuNTk1NyAxMjAuODMzIDIwLjQ0MzkgMTIwLjg0OCAyMC4yOTIyQzEyMC44NTkgMjAuMTc3MSAxMjAuODc3IDIwLjA2NDYgMTIwLjkwMSAxOS45NTIxQzEyMC45MjcgMTkuODI0IDEyMC45NjEgMTkuNjk1OCAxMjAuOTk1IDE5LjU2NzZDMTIxLjAyNiAxOS40NTI1IDEyMS4wNjYgMTkuMzQyNiAxMjEuMTAyIDE5LjIzMDFDMTIxLjE2IDE5LjA1NDggMTIxLjIzNiAxOC44ODQ4IDEyMS4zMjIgMTguNzJDMTIxLjYzNiAxOC4xMTA1IDEyMi4wNTIgMTcuNTc5NCAxMjIuNTY1IDE3LjEyNDJDMTIyLjk5NiAxNi43Mzk3IDEyMy40NzUgMTYuNDMzNiAxMjQuMDA2IDE2LjIwNkMxMjQuMjQ5IDE2LjEwMTQgMTI0LjUgMTYuMDE3NyAxMjQuNzU5IDE1Ljk1NzVDMTI0Ljk5MiAxNS45MDUyIDEyNS4yMjggMTUuODYwNyAxMjUuNDY2IDE1LjgyOTNDMTI1Ljc3MiAxNS43Nzk2IDEyNi4wODMgMTUuNzY5MiAxMjYuMzk0IDE1Ljc3MThaTTEyOC4yNzMgMjEuMjUyM0MxMjguMjcgMjEuMjUyMyAxMjguMjY3IDIxLjI1MjMgMTI4LjI2NSAyMS4yNTIzQzEyOC4yNjUgMjEuMDE5NSAxMjguMjY3IDIwLjc4NjYgMTI4LjI2NSAyMC41NTM4QzEyOC4yNjIgMjAuMzc1OSAxMjguMjQ2IDIwLjE5OCAxMjguMjM2IDIwLjAyMDJDMTI4LjIzNiAyMC4wMDk3IDEyOC4yMzMgMTkuOTk5MiAxMjguMjMxIDE5Ljk4ODhDMTI4LjIxNSAxOS45MDUgMTI4LjIwMiAxOS44MjEzIDEyOC4xODYgMTkuNzQwMkMxMjguMTY4IDE5LjY0MzQgMTI4LjE1NSAxOS41NDQgMTI4LjEyNiAxOS40NDcyQzEyOC4wODcgMTkuMzA2IDEyOC4wMzcgMTkuMTY3MyAxMjcuOTggMTkuMDMzOUMxMjcuODU5IDE4Ljc1MTQgMTI3LjY5NSAxOC40OTc2IDEyNy40NzcgMTguMjc3OUMxMjcuMzE1IDE4LjExMzEgMTI3LjEyOSAxNy45ODIzIDEyNi45MTUgMTcuODk4NkMxMjYuNjUzIDE3Ljc5NjYgMTI2LjM3OSAxNy43NzA0IDEyNi4xMDEgMTcuNzczQzEyNi4wMzMgMTcuNzczIDEyNS45NjMgMTcuNzgwOSAxMjUuODk1IDE3Ljc5MzlDMTI1Ljc1MSAxNy44MjUzIDEyNS42MTUgMTcuODc3NyAxMjUuNDkyIDE3Ljk1NjFDMTI1LjE5OSAxOC4xNDQ1IDEyNC45NzQgMTguMzkzIDEyNC44MTQgMTguNjk5MUMxMjQuNjkxIDE4LjkzMTkgMTI0LjU5NyAxOS4xNzc4IDEyNC41NDcgMTkuNDM5NEMxMjQuNTIxIDE5LjU3MDIgMTI0LjQ5MyAxOS43MDM2IDEyNC40NzcgMTkuODM0NEMxMjQuNDU5IDIwLjAyMDIgMTI0LjQzOCAyMC4yMDU5IDEyNC40NCAyMC4zOTQyQzEyNC40NCAyMC41MDQxIDEyNC40MzIgMjAuNjExNCAxMjQuNDMgMjAuNzIxMkMxMjQuNDI3IDIwLjgyODUgMTI0LjQxOSAyMC45MzU3IDEyNC40MyAyMS4wNDA0QzEyNC40NTEgMjEuMjI4NyAxMjQuNDQgMjEuNDE5NyAxMjQuNDY2IDIxLjYwODFDMTI0LjQ4NSAyMS43MzM2IDEyNC40OTggMjEuODYxOCAxMjQuNTIxIDIxLjk4NzRDMTI0LjU0MiAyMi4xMDc3IDEyNC41NjYgMjIuMjI4MSAxMjQuNjAyIDIyLjM0ODRDMTI0LjY0MiAyMi40ODE4IDEyNC42NzMgMjIuNjE1MiAxMjQuNzE4IDIyLjc0NkMxMjQuNzcgMjIuOTAwNCAxMjQuODM4IDIzLjA0OTUgMTI0LjkyMiAyMy4xOTA3QzEyNS4wMzQgMjMuMzc5MSAxMjUuMTcgMjMuNTQ5MSAxMjUuMzUzIDIzLjY3NzNDMTI1LjcyNyAyMy45MzM3IDEyNi4xNDMgMjQuMDYxOSAxMjYuNTk2IDI0LjA2OTdDMTI2Ljc3NCAyNC4wNzIzIDEyNi45NDEgMjQuMDM1NyAxMjcuMTA2IDIzLjk3MjlDMTI3LjQxNyAyMy44NTI2IDEyNy42NjEgMjMuNjQ1OSAxMjcuODUxIDIzLjM3NjVDMTI4LjAxMSAyMy4xNTE1IDEyOC4xMDggMjIuOTAwNCAxMjguMTY1IDIyLjYzMDlDMTI4LjE3NiAyMi41ODEyIDEyOC4xODkgMjIuNTI4OSAxMjguMTk3IDIyLjQ3OTJDMTI4LjIxMiAyMi4zOTI5IDEyOC4yMzMgMjIuMzAzOSAxMjguMjM5IDIyLjIxNUMxMjguMjQ5IDIxLjg5MzIgMTI4LjI2IDIxLjU3NDEgMTI4LjI3MyAyMS4yNTIzWiIgZmlsbD0iI2VlNjIxNiIvPgo8cGF0aCBkPSJNMTMyLjEwOCAyNS43MjY0QzEzMi4yMjkgMjUuNjE5OSAxMzIuMzM1IDI1LjUxMzQgMTMyLjQ0MiAyNS4zOTM2QzEzMi41NjIgMjUuMjYwNSAxMzIuNjU2IDI1LjExNCAxMzIuNzM2IDI0Ljk1NDNDMTMyLjgwMyAyNC44MjEyIDEzMi44NDMgMjQuNjYxNSAxMzIuODY5IDI0LjUxNUMxMzIuOTEgMjQuMjYyMSAxMzIuOTEgMjQuMDA5MiAxMzIuOTEgMjMuNzQzQzEzMi45MSAyMi40Nzg0IDEzMi45MSAyMS4yMjcxIDEzMi45MSAxOS45NjI2QzEzMi45MSAxOS40NTY4IDEzMi44OTYgMTguOTUwOSAxMzIuOTEgMTguNDQ1MUMxMzIuOTEgMTguMTc4OSAxMzIuOTIzIDE3LjkxMjYgMTMyLjg5NiAxNy42NDY0QzEzMi44ODMgMTcuNDA2OCAxMzIuODQzIDE3LjE2NzIgMTMyLjc0OSAxNi45NTQyQzEzMi42NTYgMTYuNzU0NiAxMzIuNTA5IDE2LjU2ODIgMTMyLjM3NSAxNi4zOTUyQzEzMi4yOTUgMTYuMjg4NyAxMzIuMjE1IDE2LjE5NTUgMTMyLjEzNSAxNi4xMDIzQzEzMi4zMjIgMTYuMTAyMyAxMzIuNTIyIDE2LjExNTYgMTMyLjcwOSAxNi4xMTU2QzEzMy4xNjMgMTYuMTI4OSAxMzMuNjA0IDE2LjEyODkgMTM0LjA1OCAxNi4xMjg5QzEzNC40NTggMTYuMTI4OSAxMzQuODU5IDE2LjExNTYgMTM1LjI1OSAxNi4wNzU3QzEzNS40NzMgMTYuMDYyNCAxMzUuNjg3IDE2LjAzNTggMTM1LjkgMTUuOTgyNUMxMzYuMTI3IDE1LjkyOTMgMTM2LjM1NCAxNS44NjI3IDEzNi41ODEgMTUuNzY5NUMxMzYuNTgxIDE2LjE0MjIgMTM2LjU4MSAxNi41MTUgMTM2LjU4MSAxNi44NzQ0QzEzNi42MjEgMTYuODg3NyAxMzYuNjQ4IDE2Ljg4NzcgMTM2LjY4OCAxNi44NzQ0QzEzNi43MjggMTYuODYxMSAxMzYuNzY4IDE2LjgzNDQgMTM2LjgwOCAxNi44MDc4QzEzNi45OTUgMTYuNjYxNCAxMzcuMTQyIDE2LjQ3NSAxMzcuMzE2IDE2LjM0MTlDMTM3LjUyOSAxNi4xNjg5IDEzNy43OTYgMTYuMDQ5MSAxMzguMDYzIDE1Ljk2OTJDMTM4LjQxMSAxNS44NjI3IDEzOC43NTggMTUuODIyOCAxMzkuMTMyIDE1LjgyMjhDMTM5LjU5OSAxNS44MjI4IDE0MC4wOCAxNS44NzYgMTQwLjQ1MyAxNi4wNDkxQzE0MC42NCAxNi4xNDIyIDE0MC44MDEgMTYuMjYyMSAxNDAuOTg3IDE2LjQyMThDMTQxLjE4OCAxNi41OTQ4IDE0MS40NDEgMTYuODA3OCAxNDEuNjQyIDE2Ljk2NzVDMTQxLjgyOSAxNi43OTQ1IDE0Mi4wMjkgMTYuNjM0OCAxNDIuMjQzIDE2LjUwMTdDMTQyLjYwMyAxNi4yNzU0IDE0Mi45OSAxNi4xMDIzIDE0My40MDQgMTYuMDA5MUMxNDMuNzc4IDE1LjkxNiAxNDQuMTY1IDE1Ljg2MjcgMTQ0LjU1MiAxNS44NjI3QzE0NC45NjYgMTUuODQ5NCAxNDUuMzk0IDE1Ljg4OTMgMTQ1LjgwOCAxNS45ODI1QzE0Ni4zNTUgMTYuMTE1NiAxNDYuODc2IDE2LjM1NTIgMTQ3LjMwMyAxNi43MTQ2QzE0Ny41NTcgMTYuOTE0MyAxNDcuNzcgMTcuMTUzOSAxNDcuOTQ0IDE3LjQyMDFDMTQ4LjExNyAxNy42ODY0IDE0OC4yMzggMTcuOTkyNSAxNDguMjkxIDE4LjMxMkMxNDguMzMxIDE4LjU2NDkgMTQ4LjMzMSAxOC44MzExIDE0OC4zMzEgMTkuMDg0QzE0OC4zMzEgMTkuODQyOCAxNDguMzMxIDIwLjU4ODIgMTQ4LjMzMSAyMS4zMzM2QzE0OC4zMzEgMjEuNjUzMSAxNDguMzMxIDIxLjk3MjYgMTQ4LjMzMSAyMi4zMDU0QzE0OC4zMzEgMjIuNjM4MSAxNDguMzMxIDIyLjk1NzYgMTQ4LjMzMSAyMy4yOTA0QzE0OC4zMzEgMjMuNTU2NiAxNDguMzMxIDIzLjgwOTUgMTQ4LjMzMSAyNC4wNzU4QzE0OC4zMzEgMjQuMzE1NCAxNDguMzQ0IDI0LjU2ODMgMTQ4LjQxMSAyNC43OTQ2QzE0OC40NzggMjUuMDA3NiAxNDguNjI1IDI1LjIwNzIgMTQ4Ljc1OCAyNS4zOTM2QzE0OC44MzggMjUuNTAwMSAxNDguOTMyIDI1LjYwNjYgMTQ5LjA5MiAyNS43Mzk3QzE0Ny4zNTYgMjUuNzM5NyAxNDUuNjIxIDI1LjczOTcgMTQzLjg3MiAyNS43Mzk3QzE0My45OTIgMjUuNjE5OSAxNDQuMDk4IDI1LjUwMDEgMTQ0LjIwNSAyNS4zODAzQzE0NC4zMTIgMjUuMjQ3MiAxNDQuNDA2IDI1LjEyNzQgMTQ0LjQ3MiAyNC45ODA5QzE0NC41MzkgMjQuODQ3OCAxNDQuNTY2IDI0LjY4ODEgMTQ0LjU5MyAyNC41MjgzQzE0NC42MDYgMjQuNDM1MiAxNDQuNjE5IDI0LjMyODcgMTQ0LjYxOSAyNC4yMzU1QzE0NC42MTkgMjQuMTQyMyAxNDQuNjE5IDI0LjA0OTEgMTQ0LjYxOSAyMy45NTZDMTQ0LjYwNiAyMy4xNDQgMTQ0LjYxOSAyMi4zMTg3IDE0NC42MTkgMjEuNTA2N0MxNDQuNjE5IDIxLjE0NzMgMTQ0LjYxOSAyMC44MDEyIDE0NC42MTkgMjAuNDQxOEMxNDQuNjE5IDIwLjA4MjQgMTQ0LjYzMyAxOS43MDk3IDE0NC42MTkgMTkuMzUwM0MxNDQuNjE5IDE5LjIxNzIgMTQ0LjYwNiAxOS4wOTczIDE0NC41OTMgMTguOTc3NUMxNDQuNTY2IDE4LjgxNzggMTQ0LjQ4NiAxOC42NTgxIDE0NC4zOTIgMTguNTI1QzE0NC4yODUgMTguMzc4NSAxNDQuMTUyIDE4LjI1ODcgMTQ0LjAwNSAxOC4xNzg5QzE0My44NDUgMTguMDk5IDE0My42NDUgMTguMDU5MSAxNDMuNDcxIDE4LjA3MjRDMTQzLjIzMSAxOC4wODU3IDE0My4wMDQgMTguMTkyMiAxNDIuODQzIDE4LjM1MTlDMTQyLjY5NyAxOC40OTgzIDE0Mi41OSAxOC42ODQ3IDE0Mi41MzYgMTguODg0NEMxNDIuNDk2IDE5LjA0NDEgMTQyLjQ5NiAxOS4yMDM4IDE0Mi40OTYgMTkuMzYzNkMxNDIuNDk2IDE5LjUxIDE0Mi40OTYgMTkuNjQzMSAxNDIuNDk2IDE5Ljc4OTVDMTQyLjQ5NiAyMC4xNzU2IDE0Mi40OTYgMjAuNTc0OSAxNDIuNDk2IDIwLjk2MDlDMTQyLjQ5NiAyMS45NDYgMTQyLjUxIDIyLjkzMSAxNDIuNDk2IDIzLjkwMjdDMTQyLjQ5NiAyNC4wMzU4IDE0Mi40OTYgMjQuMTgyMyAxNDIuNDk2IDI0LjMxNTRDMTQyLjUxIDI0LjUwMTcgMTQyLjUyMyAyNC43MDE0IDE0Mi42MDMgMjQuODc0NEMxNDIuNjgzIDI1LjA3NDEgMTQyLjgxNyAyNS4yNDcyIDE0Mi45NjQgMjUuNDIwMkMxNDMuMDU3IDI1LjU0IDE0My4xNjQgMjUuNjQ2NSAxNDMuMjcxIDI1Ljc1M0MxNDEuNTIyIDI1Ljc1MyAxMzkuNzg2IDI1Ljc1MyAxMzguMDM3IDI1Ljc1M0MxMzguMTU3IDI1LjYzMzIgMTM4LjI2NCAyNS41MTM0IDEzOC4zNyAyNS4zOTM2QzEzOC40NzcgMjUuMjYwNSAxMzguNTcxIDI1LjE0MDcgMTM4LjYzOCAyNC45OTQyQzEzOC43MDQgMjQuODYxMSAxMzguNzMxIDI0LjcwMTQgMTM4Ljc1OCAyNC41NDE3QzEzOC43NzEgMjQuNDQ4NSAxMzguNzg0IDI0LjM0MiAxMzguNzg0IDI0LjI0ODhDMTM4Ljc4NCAyNC4xNTU2IDEzOC43ODQgMjQuMDYyNCAxMzguNzg0IDIzLjk2OTNDMTM4Ljc3MSAyMy4xNTczIDEzOC43ODQgMjIuMzMyIDEzOC43ODQgMjEuNTJDMTM4Ljc4NCAyMS4xNjA2IDEzOC43ODQgMjAuODE0NSAxMzguNzg0IDIwLjQ1NTFDMTM4Ljc4NCAyMC4wOTU3IDEzOC43OTggMTkuNzIzIDEzOC43ODQgMTkuMzYzNkMxMzguNzg0IDE5LjIzMDUgMTM4Ljc3MSAxOS4xMTA3IDEzOC43NTggMTguOTkwOUMxMzguNzMxIDE4LjgzMTEgMTM4LjY1MSAxOC42NzE0IDEzOC41NTcgMTguNTM4M0MxMzguNDUxIDE4LjM5MTkgMTM4LjMxNyAxOC4yNzIxIDEzOC4xNyAxOC4xOTIyQzEzOC4wMSAxOC4xMTIzIDEzNy44MSAxOC4wNzI0IDEzNy42MzYgMTguMDg1N0MxMzcuMzk2IDE4LjA5OSAxMzcuMTY5IDE4LjIwNTUgMTM3LjAwOSAxOC4zNjUyQzEzNi44NjIgMTguNTExNyAxMzYuNzU1IDE4LjY5OCAxMzYuNzAxIDE4Ljg5NzdDMTM2LjY2MSAxOS4wNTc0IDEzNi42NjEgMTkuMjE3MSAxMzYuNjYxIDE5LjM3NjlDMTM2LjY2MSAxOS41MjMzIDEzNi42NjEgMTkuNjU2NCAxMzYuNjYxIDE5LjgwMjhDMTM2LjY2MSAyMC4xODg5IDEzNi42NjEgMjAuNTg4MiAxMzYuNjYxIDIwLjk3NDJDMTM2LjY2MSAyMS45NTkzIDEzNi42NzUgMjIuOTQ0MyAxMzYuNjYxIDIzLjkxNkMxMzYuNjYxIDI0LjA0OTEgMTM2LjY2MSAyNC4xOTU2IDEzNi42NjEgMjQuMzI4N0MxMzYuNjc1IDI0LjUxNSAxMzYuNjg4IDI0LjcxNDcgMTM2Ljc2OCAyNC44ODc3QzEzNi44NDggMjUuMDg3NCAxMzYuOTgyIDI1LjI2MDUgMTM3LjEyOSAyNS40MzM1QzEzNy4yMjIgMjUuNTUzMyAxMzcuMzI5IDI1LjY1OTggMTM3LjQzNiAyNS43NjYzQzEzNS42MDcgMjUuNzI2NCAxMzMuODU4IDI1LjcyNjQgMTMyLjEwOCAyNS43MjY0WiIgZmlsbD0iI2VlNjIxNiIvPgo8L3N2Zz4='.replace('data:image/svg+xml;base64,',''), 'base64');
    res.writeHead(200, {'Content-Type':'image/svg+xml','Cache-Control':'public,max-age=86400'});
    res.end(buf); return;
  }
  if (pathname === '/assets/logo-black.svg') {
    const buf = Buffer.from('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTUwIiBoZWlnaHQ9IjMxIiB2aWV3Qm94PSIwIDAgMTUwIDMxIiBmaWxsPSJub25lIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPgo8cGF0aCBkPSJNNDMuNzg4NiAxNC45NjdDNDMuNjI0MiAxNC43OTgzIDQzLjUwOTEgMTQuNTQ1MSA0My40NTk4IDE0LjMwODhDNDMuMzYxMSAxMy44MzYzIDQzLjQ3NjIgMTMuMzYzNyA0My42NzM2IDEyLjk0MThDNDQuMDAyNCAxMi4yNDk4IDQ0LjU5NDMgMTEuNzA5OCA0NS4yNTIgMTEuMzcyM0M0NS43NDUzIDExLjEzNiA0Ni4yODc5IDExLjAwMSA0Ni44MzA1IDExLjA1MTZDNDcuMjQxNiAxMS4xMDIyIDQ3LjY2OTEgMTEuMjU0MSA0Ny45NDg2IDExLjU0MUM0OC4xMjk1IDExLjcyNjcgNDguMjYxMSAxMS45Nzk4IDQ4LjMyNjggMTIuMjMzQzQ4LjQ0MTkgMTIuNzM5MyA0OC4zMTA0IDEzLjMzIDQ4LjAzMDkgMTMuNzY4OEM0Ny43NTEzIDE0LjIyNDQgNDcuMzA3NCAxNC41MjgyIDQ2Ljg0NyAxNC43ODE0QzQ2LjI3MTUgMTUuMDg1MiA0NS42Nzk2IDE1LjMwNDYgNDUuMDA1NCAxNS4zMzgzQzQ0LjU3NzkgMTUuMzU1MiA0NC4wODQ2IDE1LjI4NzcgNDMuNzg4NiAxNC45NjdaIiBmaWxsPSIjMjYyNjI2Ii8+CjxwYXRoIGQ9Ik0zMi4xMzc3IDEyLjM1MjdDMzIuMjIxNCAxMi4zMzYxIDMyLjMyMTggMTIuMzE5NSAzMi4zODg3IDEyLjM1MjdDMzIuNTIyNSAxMi40MDI1IDMyLjU3MjggMTIuNTg1MSAzMi42MDYyIDEyLjczNDZDMzIuNjM5NyAxMi44Njc0IDMyLjY1NjQgMTIuOTgzNiAzMi42NzMxIDEzLjA5OTlDMzIuNzA2NiAxMy40MTU0IDMyLjc0MDEgMTMuNzQ3NSAzMi43NTY4IDE0LjA3OTVDMzIuODIzNyAxNC45NTk2IDMyLjg0MDUgMTUuODIzIDMyLjg3MzkgMTYuNjg2NEMzMi45MDc0IDE4LjE2NDIgMzIuOTQwOSAxOS42NDIgMzIuOTI0MSAyMS4xMTk4QzMyLjkyNDEgMjEuODY3IDMyLjkwNzQgMjIuNTk3NiAzMi44OTA3IDIzLjM0NDhDMzIuODkwNyAyMy42MTA1IDMyLjg5MDcgMjMuODc2MSAzMi44NzM5IDI0LjE0MThDMzIuODU3MiAyNC4zMDc4IDMyLjg1NzIgMjQuNDkwNSAzMi44MjM3IDI0LjY1NjVDMzIuODA3IDI0LjgyMjYgMzIuNzU2OCAyNC45ODg2IDMyLjY4OTkgMjUuMTIxNUMzMi42MjMgMjUuMjcwOSAzMi41MDU4IDI1LjQwMzcgMzIuMzg4NyAyNS41MkMzMi4zMDUgMjUuNjAzIDMyLjIyMTQgMjUuNjg2IDMyLjEzNzcgMjUuNzY5QzMzLjg3NzkgMjUuNzY5IDM1LjYwMTQgMjUuNzY5IDM3LjM0MTYgMjUuNzY5QzM3LjIwNzcgMjUuNjUyOCAzNy4wOTA2IDI1LjUyIDM2Ljk3MzUgMjUuMzg3MUMzNi44NTYzIDI1LjI1NDMgMzYuNzU1OSAyNS4xMDQ5IDM2LjcwNTcgMjQuOTM4OEMzNi42NTU1IDI0Ljc1NjIgMzYuNjM4OCAyNC41NzM1IDM2LjYzODggMjQuMzkwOUMzNi42Mzg4IDIzLjk5MjQgMzYuNjM4OCAyMy42MTA1IDM2LjY1NTUgMjMuMjI4NkMzNi42NzIzIDIyLjQ4MTQgMzYuNjU1NSAyMS43MTc2IDM2LjY1NTUgMjAuOTcwNEMzNi42NTU1IDIwLjUzODYgMzYuNjcyMyAyMC4xMjM1IDM2LjY1NTUgMTkuNjkxOEMzNi42NTU1IDE5LjU1OSAzNi42NTU1IDE5LjQyNjEgMzYuNjU1NSAxOS4yNzY3QzM2LjY3MjMgMTkuMTEwNyAzNi42ODkgMTguOTQ0NiAzNi43NTU5IDE4Ljc5NTJDMzYuODIyOSAxOC42NDU3IDM2LjkyMzMgMTguNTEyOSAzNy4wNDA0IDE4LjM5NjdDMzcuMjU3OSAxOC4xOTc0IDM3LjU1OTEgMTguMTE0NCAzNy44NjAzIDE4LjA5NzhDMzguMDc3OCAxOC4wOTc4IDM4LjI5NTQgMTguMTMxIDM4LjQ3OTQgMTguMjMwNkMzOC42ODAyIDE4LjMzMDMgMzguODQ3NSAxOC40OTYzIDM4Ljk0NzkgMTguNjk1NkMzOS4wNjUxIDE4LjkxMTQgMzkuMDk4NSAxOS4xNDM5IDM5LjExNTMgMTkuMzkyOUMzOS4xMzIgMTkuNTU5IDM5LjExNTMgMTkuNzI1IDM5LjExNTMgMTkuODkxMUMzOS4xMTUzIDIwLjIwNjYgMzkuMTE1MyAyMC41MDU0IDM5LjExNTMgMjAuODIwOUMzOS4xMTUzIDIxLjE4NjIgMzkuMTE1MyAyMS41NjgxIDM5LjExNTMgMjEuOTMzNEMzOS4xMTUzIDIyLjM2NTEgMzkuMTE1MyAyMi44MTM0IDM5LjExNTMgMjMuMjQ1MkMzOS4xMTUzIDIzLjYxMDUgMzkuMTE1MyAyMy45NTkxIDM5LjExNTMgMjQuMzI0NEMzOS4xMTUzIDI0LjQ3MzkgMzkuMTE1MyAyNC42MjMzIDM5LjA4MTggMjQuNzcyOEMzOS4wNDgzIDI0LjkzODggMzguOTY0NyAyNS4wODgyIDM4Ljg2NDMgMjUuMjIxMUMzOC43NDcxIDI1LjM4NzEgMzguNjMgMjUuNTM2NiAzOC40Nzk0IDI1LjY2OTRDMzguNDQ1OSAyNS43MDI2IDM4LjM5NTcgMjUuNzM1OCAzOC4zNjIzIDI1Ljc2OUM0MC44ODg5IDI1Ljc2OSA0My40MzIzIDI1Ljc2OSA0NS45NTkgMjUuNzY5QzQ2LjQ5NDQgMjUuNzY5IDQ3LjAxMzEgMjUuNzY5IDQ3LjU0ODYgMjUuNzY5QzQ3Ljk1MDIgMjUuNzY5IDQ4LjMzNSAyNS43NjkgNDguNzM2NiAyNS43NjlDNDguODcwNCAyNS43NjkgNDguOTg3NiAyNS43NjkgNDkuMTIxNCAyNS43NjlDNDkuMDcxMiAyNS42ODYgNDkuMDIxIDI1LjYwMyA0OC45NzA4IDI1LjUzNjZDNDguODg3MiAyNS40MjAzIDQ4Ljc3MDEgMjUuMzIwNyA0OC42ODY0IDI1LjIyMTFDNDguNjE5NSAyNS4xNTQ3IDQ4LjU2OTMgMjUuMDcxNiA0OC41MzU4IDI0Ljk4ODZDNDguNDM1NCAyNC43NTYyIDQ4LjQwMTkgMjQuNTA3MSA0OC4zODUyIDI0LjI1OEM0OC4zODUyIDI0LjE3NSA0OC4zNjg1IDI0LjA5MiA0OC4zNjg1IDI0LjAwOUM0OC4zNTE3IDIzLjgwOTcgNDguMzY4NSAyMy41OTM4IDQ4LjM2ODUgMjMuMzk0NkM0OC4zNjg1IDIzLjA0NTkgNDguMzY4NSAyMi43MTM4IDQ4LjM2ODUgMjIuMzY1MUM0OC4zNTE3IDIwLjgyMDkgNDguMzY4NSAxOS4yNjAxIDQ4LjM2ODUgMTcuNzE1OUM0OC4zNjg1IDE3LjU4MzEgNDguMzY4NSAxNy40NTAyIDQ4LjM2ODUgMTcuMzE3NEM0OC4zNjg1IDE3LjA2ODMgNDguMzg1MiAxNi44MTkzIDQ4LjQxODcgMTYuNTcwMkM0OC40MzU0IDE2LjQzNzQgNDguNDUyMSAxNi4zMDQ1IDQ4LjQ2ODkgMTYuMTU1MUM0OC40ODU2IDE2LjAyMjMgNDguNTAyMyAxNS44NzI4IDQ4LjQzNTQgMTUuNzU2NkM0OC4zODUyIDE1LjY1NyA0OC4yODQ4IDE1LjU5MDUgNDguMTY3NyAxNS41NTczQzQ4LjAzMzggMTUuNTI0MSA0Ny44ODMyIDE1LjU1NzMgNDcuNzQ5NCAxNS41OTA1QzQ3LjU0ODYgMTUuNjQwMyA0Ny4zODEyIDE1LjY3MzYgNDcuMTYzNyAxNS42OTAyQzQ3LjA2MzMgMTUuNzA2OCA0Ni45NDYyIDE1LjcwNjggNDYuODI5MSAxNS43MDY4QzQ2LjE1OTcgMTUuNzQgNDUuNTc0MSAxNS43NTY2IDQ0Ljk3MTcgMTUuNzU2NkM0NC43NTQyIDE1Ljc1NjYgNDQuNTUzNCAxNS43NTY2IDQ0LjMzNTkgMTUuNzU2NkM0NC4yMDIgMTUuNzU2NiA0NC4wNjgxIDE1Ljc1NjYgNDMuOTM0MyAxNS43NTY2QzQzLjg1MDYgMTUuNzU2NiA0My43NjcgMTUuNzU2NiA0My42ODMzIDE1Ljc3MzJDNDMuNjE2NCAxNS43ODk4IDQzLjU0OTQgMTUuNzg5OCA0My40OTkyIDE1LjgzOTZDNDMuNDMyMyAxNS45MDYgNDMuMzk4OCAxNi4wMDU2IDQzLjM5ODggMTYuMTA1M0M0My40MTU2IDE2LjI3MTMgNDMuNTE2IDE2LjM4NzUgNDMuNjE2NCAxNi41MDM4QzQzLjczMzUgMTYuNjUzMiA0My44MzM5IDE2Ljc4NiA0My45MTc2IDE2LjkxODlDNDMuOTY3OCAxNi45ODUzIDQ0LjAxOCAxNy4wNTE3IDQ0LjA1MTQgMTcuMjE3OEM0NC4wNjgxIDE3LjMzNCA0NC4wODQ5IDE3LjUxNjYgNDQuMTAxNiAxNy42NjYxQzQ0LjEzNTEgMTguMDQ4IDQ0LjExODQgMTguMTgwOCA0NC4xMTg0IDE4LjMzMDNDNDQuMTAxNiAxOS4wNDQyIDQ0LjExODQgMjAuMDU3MSA0NC4xMTg0IDIxLjA1MzRDNDQuMTE4NCAyMS4zODU1IDQ0LjExODQgMjEuNzAxIDQ0LjExODQgMjIuMDMzQzQ0LjExODQgMjIuNTQ3OCA0NC4xMTg0IDIzLjA0NTkgNDQuMTE4NCAyMy41NjA2QzQ0LjExODQgMjMuNjkzNSA0NC4xMTg0IDIzLjgyNjMgNDQuMTE4NCAyMy45NDI1QzQ0LjExODQgMjQuMDkyIDQ0LjEwMTYgMjQuMjQxNCA0NC4wNjgyIDI0LjM5MDlDNDQuMDM0NyAyNC41NTY5IDQ0LjAwMTIgMjQuNzA2MyA0My45MTc2IDI0Ljg3MjRDNDMuODE3MiAyNS4wNTUgNDMuNjY2NiAyNS4yNTQzIDQzLjUzMjcgMjUuMjU0M0M0My4zOTg4IDI1LjIzNzcgNDMuMjgxNyAyNS4wMzg0IDQzLjE5OCAyNC44NzI0QzQzLjEzMTEgMjQuNzIzIDQzLjA5NzYgMjQuNTkwMSA0My4wOTc2IDI0LjQ1NzNDNDMuMDgwOSAyNC4zMDc4IDQzLjA4MDkgMjQuMTI1MiA0My4wODA5IDIzLjk1OTFDNDMuMDgwOSAyMi44NjMzIDQzLjA4MDkgMjEuODAwNiA0My4wODA5IDIwLjczNzlDNDMuMDgwOSAyMC4zMDYyIDQzLjA4MDkgMTkuODU3OSA0My4wODA5IDE5LjQyNjFDNDMuMDgwOSAxOS4yNzY3IDQzLjA4MDkgMTkuMTQzOSA0My4wODA5IDE4Ljk5NDRDNDMuMDY0MiAxOC41NDYxIDQzLjAxNCAxOC4wOTc4IDQyLjg0NjcgMTcuNjgyN0M0Mi41NDU1IDE2Ljk2ODcgNDEuODkyOSAxNi4zODc1IDQxLjE1NjcgMTYuMDM4OUM0MC42NzE0IDE1LjgwNjQgNDAuMTUyNyAxNS42OTAyIDM5LjYxNzIgMTUuNjU3QzM4Ljk5ODEgMTUuNjIzNyAzOC4zNjIzIDE1LjcwNjggMzcuNzU5OSAxNS44NzI4QzM3LjQwODUgMTUuOTU1OCAzNy4wNzM5IDE2LjA3MjEgMzYuNzU1OSAxNi4yMDQ5QzM2Ljc1NTkgMTUuNDkwOSAzNi43NzI3IDE0Ljc3NjkgMzYuNzcyNyAxNC4wNzk1QzM2Ljc3MjcgMTMuNzgwNyAzNi43NzI3IDEzLjQ5ODQgMzYuNzg5NCAxMy4xOTk1QzM2Ljc4OTQgMTMuMDgzMyAzNi44MDYxIDEyLjk4MzYgMzYuODA2MSAxMi44Njc0QzM2LjgyMjkgMTIuNjY4MiAzNi44MjI5IDEyLjQ2ODkgMzYuODU2MyAxMi4yNjk3QzM2Ljg3MzEgMTIuMDcwNCAzNi45MDY1IDExLjg1NDUgMzYuODM5NiAxMS43MzgzQzM2LjgwNjEgMTEuNjcxOSAzNi43NTU5IDExLjYzODcgMzYuNjcyMyAxMS42MDU1QzM2LjUzODQgMTEuNTU1NyAzNi4zNzExIDExLjU4ODkgMzYuMjAzOCAxMS42MjIxQzM2LjA1MzIgMTEuNjU1MyAzNS45MTkzIDExLjY3MTkgMzUuNzY4NyAxMS43MDUxQzM1LjYwMTQgMTEuNzM4MyAzNS40MzQgMTEuNzM4MyAzNS4yNjY3IDExLjc1NDlDMzQuOTMyMSAxMS43NzE1IDM0LjYxNDIgMTEuNzcxNSAzNC4yNzk1IDExLjc3MTVDMzMuNjQzNyAxMS43ODgxIDMzLjAwNzggMTEuNzg4MSAzMi4zNzIgMTEuNzg4MUMzMi4yNTQ4IDExLjk3MDggMzIuMjA0NiAxMi4xNTM0IDMyLjEzNzcgMTIuMzUyN1oiIGZpbGw9IiMyNjI2MjYiLz4KPHBhdGggZD0iTTEyLjg0ODYgMTguMDkyOEMxMy40NDMgMTUuODc4NyAxNC4wMTM3IDEzLjY4ODMgMTQuNTM2OCAxMS40NzQyQzE0LjY1NTcgMTAuOTc0MiAxNC43NzQ2IDEwLjQ3NDMgMTQuODkzNSA5Ljk5ODExQzE1LjA2IDkuMzU1MjkgMTUuMjI2NCA4LjczNjI4IDE1LjM5MjkgOC4xMTcyN0MxNS41MTE3IDcuNjY0OTIgMTUuNjA2OSA3LjIxMjU3IDE1LjcyNTcgNi43NjAyMkMxNS43OTcxIDYuNDUwNzIgMTUuODY4NCA2LjE2NTAyIDE1LjkxNiA1Ljg1NTUxQzE1Ljk2MzUgNS41OTM2MiAxNi4wMTExIDUuMzU1NTUgMTYuMDExMSA1LjA5MzY2QzE2LjAxMTEgNC43ODQxNiAxNS45NjM1IDQuNDUwODQgMTUuODkyMiA0LjE0MTM0QzE1LjgyMDkgMy43ODQyMiAxNS43MjU3IDMuNDUwOSAxNS41ODMxIDMuMTE3NTlDMTUuMjc0IDIuMzA4MTIgMTQuNzc0NiAxLjU3MDA3IDE0LjE1NjQgMC45NzQ4NzNDMTYuOTg2IDAuOTc0ODczIDE5LjgzOTQgMC45NzQ4NzMgMjIuNjY5IDAuOTc0ODczQzIyLjU5NzYgMS4wOTM5MSAyMi41MjYzIDEuMjEyOTUgMjIuNTAyNSAxLjM1NThDMjIuNDMxMiAxLjYxNzY5IDIyLjQwNzQgMS44Nzk1OCAyMi40MDc0IDIuMTY1MjdDMjIuNDMxMiAyLjg3OTUxIDIyLjU3MzkgMy41Njk5NSAyMi43NjQxIDQuMjM2NTdDMjIuOTc4MSA1LjA0NjA0IDIzLjIxNTkgNS44NTU1MiAyMy40NTM3IDYuNjY0OTlDMjMuODEwMyA3Ljg1NTM5IDI0LjE5MDggOS4wNjk1OSAyNC41NDc1IDEwLjI2QzI1LjMwODQgMTIuNzU5OCAyNi4wMjE3IDE1LjI1OTcgMjYuNzM1IDE3Ljc1OTVDMjcuMzUzMyAxNS4zNTQ5IDI3Ljk5NTMgMTIuOTUwMyAyOC43MzI0IDEwLjU2OTVDMjguODUxMyAxMC4xNDEgMjguOTk0IDkuNzEyNDEgMjkuMTEyOSA5LjI4Mzg3QzI5LjMyNjkgOC41NDU4MiAyOS41MTcxIDcuNzgzOTYgMjkuNzMxMSA3LjA0NTkxQzI5Ljg3MzggNi41Njk3NSAzMC4wMTY0IDYuMDkzNTkgMzAuMTM1MyA1LjYxNzQzQzMwLjIzMDQgNS4xODg4OSAzMC4zMjU2IDQuNzYwMzUgMzAuMzQ5MyA0LjMzMThDMzAuMzczMSAzLjk5ODQ5IDMwLjM3MzEgMy42NjUxOCAzMC4zMjU2IDMuMzMxODdDMzAuMjU0MiAyLjkyNzEzIDMwLjA4NzggMi41MjI0IDI5Ljg3MzggMi4xNDE0N0MyOS43MDczIDEuODc5NTggMjkuNTQwOSAxLjYxNzY5IDI5LjMyNjkgMS4zNzk2MUMyOS4yMDggMS4yMTI5NiAyOS4wNjUzIDEuMDcwMTEgMjguOTIyNiAwLjkyNzI2MkMzMC42MzQ3IDAuOTI3MjYyIDMyLjMyMjkgMC45MjcyNjIgMzQuMDM1IDAuOTI3MjYyQzM0LjMyMDMgMC45MjcyNjIgMzQuNTgxOSAwLjkyNzI2MiAzNC44NjcyIDAuOTI3MjYyQzM1LjEyODggMC45MjcyNjIgMzUuMzY2NSAwLjkwMzQ1MSAzNS42MjgxIDAuOTk4NjgzQzM1LjY3NTcgMS4wMjI0OSAzNS43MjMyIDEuMDIyNDkgMzUuNzQ3IDEuMDQ2M0MzNS44NDIxIDEuMTQxNTMgMzUuNzcwOCAxLjMzMiAzNS43MjMyIDEuNDk4NjVDMzUuNjI4MSAxLjc4NDM1IDM1LjU1NjggMi4wMjI0MyAzNS40NjE3IDIuMjM2N0MzMy4zNDU0IDguNjY0ODYgMzAuOTQzOCAxNi40NzM5IDI4Ljc4IDIzLjYxNjNDMjguNjYxMSAyNC4wNDQ4IDI4LjUxODQgMjQuNDQ5NiAyOC4zOTk1IDI0Ljg3ODFDMjguMzI4MiAyNS4wOTI0IDI4LjI4MDYgMjUuMzA2NiAyOC4yMDkzIDI1LjQ5NzFDMjguMTYxNyAyNS42MTYxIDI4LjExNDIgMjUuNzM1MiAyOC4wNjY2IDI1Ljg1NDJDMjguMDE5MSAyNS45NzMzIDI3Ljk3MTUgMjYuMTE2MSAyNy44NzY0IDI2LjE2MzdDMjcuNzU3NSAyNi4yMzUyIDI3LjU2NzMgMjYuMTg3NSAyNy40MDA4IDI2LjEzOTlDMjYuODc3NyAyNS45OTcxIDI2LjQ5NzMgMjUuODU0MiAyNi4wNjkzIDI1LjY2MzhDMjUuMzU1OSAyNS4zNTQzIDI0LjU5NSAyNC45NzMzIDIzLjg4MTcgMjQuNTQ0OEMyMy4yODcyIDI0LjE4NzcgMjIuNjkyOCAyMy44MDY3IDIyLjI2NDcgMjMuMjgzQzIxLjkwODEgMjIuODU0NCAyMS42NzAzIDIyLjMzMDYgMjEuNDU2MyAyMS44MDY5QzIxLjA3NTggMjAuOTAyMiAyMC43OTA1IDE5Ljk3MzcgMjAuNDgxNCAxOS4wNDUxQzIwLjA3NzIgMTcuODA3MSAxOS42NzI5IDE2LjU0NTMgMTkuMjkyNSAxNS4zMDczQzE4Ljg4ODIgMTMuOTc0IDE4LjUwNzggMTIuNjQwOCAxOC4xNzQ5IDExLjI4MzdDMTcuOTg0NyAxMS45NTA0IDE3Ljc5NDQgMTIuNjQwOCAxNy42MDQyIDEzLjMwNzRDMTcuMjk1MSAxNC40MDI2IDE3LjAwOTggMTUuNDczOSAxNi43MjQ0IDE2LjU2OTFDMTYuNDYyOSAxNy41NjkgMTYuMjI1MSAxOC41NDUyIDE1Ljk2MzUgMTkuNTQ1MUMxNS43NDk1IDIwLjQwMjIgMTUuNTExNyAyMS4yNTkzIDE1LjI3NCAyMi4wOTI2QzE1LjEwNzUgMjIuNzExNiAxNC45NjQ4IDIzLjMzMDYgMTQuODIyMiAyMy45MjU4QzE0Ljc1MDggMjQuMjM1MyAxNC42NTU3IDI0LjU2ODYgMTQuNTg0NCAyNC44NzgxQzE0LjUzNjggMjUuMTE2MiAxNC40NjU1IDI1LjMzMDUgMTQuNDE3OSAyNS41Njg1QzE0LjM5NDIgMjUuNjYzOCAxNC4zNzA0IDI1LjczNTIgMTQuMzQ2NiAyNS44MDY2QzE0LjMyMjggMjUuODU0MiAxNC4yNzUzIDI1LjkwMTggMTQuMjI3NyAyNS45NDk1QzE0LjA4NTEgMjYuMDY4NSAxMy44NDczIDI2LjA0NDcgMTMuNjA5NSAyNS45OTcxQzEzLjAzODggMjUuODc4IDEyLjU2MzIgMjUuNzExNCAxMi4wODc3IDI1LjQ5NzFDMTEuMjMxNyAyNS4xNCAxMC4zNTE5IDI0LjY4NzYgOS41NDM0MSAyNC4xNDAxQzkuMTg2NzQgMjMuOTAyIDguODUzODQgMjMuNjE2MyA4LjU2ODUgMjMuMzA2OEM4LjE4ODA1IDIyLjkwMiA3Ljg1NTE2IDIyLjQwMjEgNy41OTM2IDIxLjkwMjFDNy4xMTgwMyAyMS4wMjEyIDYuODA4OTIgMjAuMDkyNyA2LjQ3NjAzIDE5LjE0MDRDNi4wOTU1NyAxOC4wNDUyIDUuNzE1MTIgMTYuOTczOCA1LjMzNDY3IDE1Ljg3ODdDNC40MDczMiAxMy4xNDA4IDMuNTk4ODYgMTAuMzU1MiAyLjk1Njg1IDcuNTQ1ODhDMi43OTA0IDYuODU1NDUgMi42NDc3MyA2LjE2NTAyIDIuNTI4ODQgNS40NzQ1OUMyLjQ4MTI5IDUuMjEyNyAyLjQzMzczIDQuOTc0NjIgMi4zNjIzOSA0LjcxMjczQzIuMjY3MjggNC40MDMyMyAyLjEyNDYyIDQuMTQxMzQgMS45ODE5NSAzLjg1NTY0QzEuNjQ5MDUgMy4xODkwMiAxLjMzOTkzIDIuNDk4NTkgMC44NjQzNjggMS45NTFDMC42NzQxNDIgMS43MzY3MyAwLjQ2MDEzNiAxLjUyMjQ2IDAuMjIyMzU0IDEuMzMxOTlDMC4xNTEwMTkgMS4yNjA1NyAwLjA3OTY4ODcgMS4yMTI5NSAwLjA1NTkxMDUgMS4xMTc3MkMwLjAwODM1NDEzIDEuMDIyNDkgLTAuMDE1NDI3IDAuOTI3MjYzIDAuMDA4MzUxMjMgMC44MzIwMzFDMS43Njc5NCAwLjgzMjAzMSAzLjUwMzc1IDAuODMyMDMxIDUuMjYzMzQgMC44MzIwMzFDNS45MjkxMiAwLjgzMjAzMSA2LjU3MTE0IDAuODMyMDMxIDcuMjEzMTUgMC44MzIwMzFDNy40MDMzOCAwLjgzMjAzMSA3LjU5MzYgMC44MzIwMzEgNy44MDc2MSAwLjgzMjAzMUM3Ljk1MDI3IDAuODMyMDMxIDguMDkyOTQgMC44MzIwMjcgOC4yMTE4MyAwLjg3OTY0M0M4LjMzMDcyIDAuOTI3MjU5IDguNDI1ODQgMS4wNDYzIDguNDk3MTcgMS4xODkxNUM4LjYxNjA2IDEuMzc5NjIgOC42NjM2MiAxLjYxNzY5IDguNzExMTcgMS44MzE5NkM4LjkyNTE4IDIuNzEyODYgOS4xNjI5NiAzLjU0NjE0IDkuNDI0NTIgNC4zNzk0MkMxMC43MzIzIDkuMDIxOTggMTEuNjgzNCAxMy41OTMxIDEyLjg0ODYgMTguMDkyOFoiIGZpbGw9IiMyNjI2MjYiLz4KPHBhdGggZD0iTTQ4LjY4OTUgMjMuMTUzOUM0OS4wMzg0IDIzLjM0NyA0OS40MjYgMjMuNTQwMSA0OS43NzQ5IDIzLjY5NDZDNTAuMDQ2MyAyMy44NDkgNTAuMzU2NCAyMy45NjQ5IDUwLjYyNzggMjQuMDgwN0M1MS4wMTU1IDI0LjE5NjYgNTEuNDAzMSAyNC4yNzM4IDUxLjc5MDggMjQuMzEyNEM1Mi4yOTQ4IDI0LjM4OTcgNTIuODM3NSAyNC40MjgzIDUzLjM0MTUgMjQuMjM1MkM1My41MzUzIDI0LjE1OCA1My43MjkyIDI0LjA4MDcgNTMuODQ1NSAyMy45MjYzQzUzLjkyMyAyMy43NzE4IDUzLjk2MTggMjMuNjE3MyA1My45NjE4IDIzLjQyNDJDNTMuOTYxOCAyMy4yNjk4IDUzLjg4NDIgMjMuMTE1MyA1My44MDY3IDIyLjk5OTRDNTMuNjkwNCAyMi44NDUgNTMuNDk2NiAyMi43Njc3IDUzLjMwMjcgMjIuNjkwNUM1Mi43OTg4IDIyLjQ1ODggNTIuMzMzNiAyMi4yMjcxIDUxLjg2ODMgMjEuOTk1NEM1MS40NDE5IDIxLjgwMjMgNTAuOTc2NyAyMS42MDkyIDUwLjU1MDMgMjEuMzc3NUM1MC4yNDAxIDIxLjE4NDQgNDkuOTMgMjAuOTkxMyA0OS42NTg2IDIwLjcyMUM0OS4zNDg1IDIwLjQxMjEgNDkuMTE1OSAyMC4wMjU5IDQ4Ljk5OTYgMTkuNjAxMUM0OC44ODMzIDE5LjE3NjMgNDguOTIyMSAxOC43MTI5IDQ5LjAzODQgMTguMjQ5NUM0OS4xOTM0IDE3Ljc4NjEgNDkuNDY0OCAxNy4zNjEzIDQ5Ljc3NDkgMTcuMDEzN0M1MC4zOTUyIDE2LjM5NTggNTEuMjA5MyAxNi4wMDk3IDUyLjA2MjIgMTUuODE2NkM1Mi42NDM3IDE1LjcwMDcgNTMuMTg2NCAxNS42NjIxIDUzLjc2NzkgMTUuNjYyMUM1NC4zNDk0IDE1LjY2MjEgNTQuOTY5NyAxNS43MDA3IDU1LjQ3MzcgMTUuNzc4QzU1LjY2NzUgMTUuODE2NiA1NS44NjEzIDE1Ljg1NTIgNTYuMTMyNyAxNS44OTM4QzU2LjMyNjYgMTUuOTMyNCA1Ni41NTkyIDE2LjAwOTcgNTYuNzE0MiAxNi4wODY5QzU2Ljc5MTggMTYuMTI1NSA1Ni44NjkzIDE2LjIwMjggNTYuOTQ2OCAxNi4zMTg2QzU2Ljk4NTYgMTYuMzk1OCA1Ny4wMjQ0IDE2LjQ3MzEgNTcuMDI0NCAxNi41ODg5QzU3LjAyNDQgMTYuNjY2MiA1Ny4wMjQ0IDE2Ljc0MzQgNTcuMDI0NCAxNi44MjA2QzU3LjAyNDQgMTcuMzk5OSA1Ny4wMjQ0IDE3Ljk0MDYgNTcuMDI0NCAxOC41MTk4QzU2Ljc5MTcgMTguMzY1MyA1Ni41OTc5IDE4LjI0OTUgNTYuMzY1MyAxOC4xMzM2QzU2LjA5MzkgMTguMDE3OCA1NS44MjI2IDE3LjkwMTkgNTUuNTUxMiAxNy44MjQ3QzU1LjA4NiAxNy43MDg4IDU0LjY1OTYgMTcuNjcwMiA1NC4xOTQ0IDE3LjY3MDJDNTMuOTYxOCAxNy42NzAyIDUzLjcyOTIgMTcuNzA4OCA1My40OTY2IDE3Ljc4NjFDNTMuMzAyNyAxNy44NjMzIDUzLjEwODkgMTguMDE3OCA1My4wNzAxIDE4LjIxMDlDNTMuMDMxMyAxOC4zNjUzIDUzLjEwODkgMTguNTk3IDUzLjE4NjQgMTguNzEyOUM1My4zNDE1IDE4Ljk0NDYgNTMuNjEyOSAxOS4wMjE4IDUzLjg4NDIgMTkuMTM3N0M1NC40MjcgMTkuMzMwOCA1NC45Njk3IDE5LjQ4NTMgNTUuNTEyNSAxOS42NzgzQzU1LjkzODkgMTkuODMyOCA1Ni4zNjUzIDIwLjAyNTkgNTYuNzUzIDIwLjI1NzZDNTcuMjk1NyAyMC42MDUyIDU3Ljc5OTcgMjEuMTA3MiA1OC4wNzExIDIxLjcyNTFDNTguMzQyNCAyMi4zODE2IDU4LjMwMzcgMjMuMTUzOSA1OC4wMzIzIDIzLjc3MThDNTcuNzYwOSAyNC4zODk3IDU3LjI1NyAyNC44OTE3IDU2LjY3NTUgMjUuMjM5M0M1Ni4xMzI3IDI1LjU4NjggNTUuNTEyNCAyNS43Nzk5IDU0Ljg5MjIgMjUuODk1N0M1NC4xOTQ0IDI2LjA1MDIgNTMuNDU3OCAyNi4wODg4IDUyLjc2IDI2LjA4ODhDNTEuOTQ1OSAyNi4wODg4IDUxLjEzMTggMjUuOTczIDUwLjM5NTIgMjUuODU3MUM1MC4xMjM4IDI1LjgxODUgNDkuODUyNSAyNS43Nzk5IDQ5LjU0MjMgMjUuNzAyN0M0OS40MjYgMjUuNjY0IDQ5LjM0ODUgMjUuNjI1NCA0OS4yNzEgMjUuNTQ4MkM0OS4yMzIyIDI1LjQ3MSA0OS4xOTM0IDI1LjM1NTEgNDkuMTkzNCAyNS4yNzc5QzQ5LjE1NDcgMjUuMTIzNCA0OS4xNTQ3IDI1LjAwNzYgNDkuMTE1OSAyNC44OTE3QzQ4Ljk5OTYgMjQuNDI4MyA0OC44NDQ1IDIzLjg0OSA0OC42ODk1IDIzLjE1MzlaIiBmaWxsPSIjMjYyNjI2Ii8+CjxwYXRoIGQ9Ik02Mi44ODM3IDI0LjAwMTVDNjMuMDI0NiAyNC4zNzg0IDYzLjE2NTQgMjQuNzU1MyA2My4zMDYyIDI1LjEzMjJDNjMuMzUzMiAyNS4zMjA3IDYzLjQ0NzEgMjUuNDYyIDYzLjQ5NCAyNS42NTA1QzYzLjU0MSAyNS43NDQ3IDYzLjU4NzkgMjUuODg2MSA2My42ODE4IDI1LjkzMzJDNjMuODIyNiAyNi4wMjc0IDY0LjAxMDQgMjYuMDc0NSA2NC4xOTgyIDI2LjA3NDVDNjQuNDc5OSAyNi4wNzQ1IDY0LjcxNDYgMjYuMDc0NSA2NC45OTYzIDI2LjA3NDVDNjUuMjMxIDI2LjA3NDUgNjUuNDY1NyAyNi4wNzQ1IDY1LjY1MzUgMjYuMDc0NUM2Ni4wNzYgMjYuMDI3NCA2Ni40NTE2IDI1Ljg4NjEgNjYuODI3MiAyNS42OTc2QzY3LjIwMjcgMjUuNTA5MiA2Ny41MzEzIDI1LjMyMDcgNjcuODYgMjUuMDM4QzY4LjMyOTQgMjQuNjE0IDY4Ljc1MTkgMjQuMDk1NyA2OC45ODY2IDIzLjUzMDNDNjkuMzYyMiAyMi43Mjk0IDY5LjU1IDIxLjc4NzEgNjkuNTUgMjAuODkxOUM2OS41NSAyMC4yMzIzIDY5LjUwMyAxOS42MTk4IDY5LjMxNTMgMTkuMDA3M0M2OS4xMjc1IDE4LjQ0MTkgNjguODkyNyAxNy44NzY1IDY4LjUxNzIgMTcuNDA1NEM2OC4wOTQ3IDE2Ljg0IDY3LjU3ODMgMTYuMzY4OCA2Ni45NjggMTYuMDM5QzY2LjQwNDYgMTUuODAzNSA2NS43OTQ0IDE1LjcwOTIgNjUuMTg0MSAxNS42NjIxQzY0LjgwODUgMTUuNjYyMSA2NC40MzI5IDE1LjY2MjEgNjQuMTA0MyAxNS43NTYzQzYzLjkxNjUgMTUuODAzNSA2My42ODE4IDE1Ljg5NzcgNjMuNDk0IDE2LjAzOUM2My4zMDYyIDE2LjEzMzMgNjMuMTE4NSAxNi4yMjc1IDYyLjkzMDcgMTYuMjI3NUM2Mi44MzY4IDE2LjIyNzUgNjIuNjk1OSAxNi4xMzMzIDYyLjY0OSAxNi4wODYyQzYyLjYwMiAxNS45OTE5IDYyLjYwMjEgMTUuODUwNiA2Mi41MDgyIDE1Ljc1NjNDNjIuNDYxMiAxNS43MDkyIDYyLjM2NzMgMTUuNjYyMSA2Mi4yNzM0IDE1LjY2MjFDNjIuMTc5NSAxNS42NjIxIDYyLjA4NTcgMTUuNzU2MyA2MS45OTE4IDE1LjgwMzVDNjEuODA0IDE1Ljg5NzcgNjEuNjE2MiAxNS44OTc3IDYxLjQyODQgMTUuOTQ0OEM2MS4yNDA2IDE1Ljk0NDggNjEuMDk5OCAxNS45NDQ4IDYwLjkxMiAxNS45NDQ4QzYwLjIwNzggMTUuOTQ0OCA1OS41MDM3IDE1Ljk0NDggNTguODQ2NCAxNS45NDQ4QzU4LjcwNTYgMTUuOTQ0OCA1OC42MTE3IDE1Ljk0NDggNTguNDcwOSAxNS45NDQ4QzU4LjMzIDE1Ljk0NDggNTguMTg5MiAxNS45NDQ4IDU4LjE0MjIgMTUuOTkxOUM1OC4wOTUzIDE2LjAzOSA1OC4wNDgzIDE2LjA4NjEgNTguMDQ4MyAxNi4xODA0QzU4LjA0ODMgMTYuMjI3NSA1OC4wOTUzIDE2LjI3NDYgNTguMTQyMiAxNi4zNjg4QzU4LjIzNjEgMTYuNTU3MyA1OC4zNzcgMTYuNjk4NiA1OC41MTc4IDE2Ljg4NzFDNTguNjExNyAxNy4wMjg0IDU4LjcwNTYgMTcuMTIyNyA1OC43NTI1IDE3LjI2NEM1OC44NDY0IDE3LjQ1MjUgNTguNzk5NSAxNy42ODgxIDU4Ljc5OTUgMTcuOTIzNkM1OC43OTk1IDE4LjA2NSA1OC43OTk1IDE4LjIwNjMgNTguNzk5NSAxOC4zOTQ4QzU4Ljc5OTUgMTguOTEzMSA1OC43OTk1IDE5LjQzMTMgNTguNzk5NSAxOS45NDk2QzU4Ljc5OTUgMjAuNTYyMSA1OC43OTk1IDIxLjEyNzUgNTguNzk5NSAyMS43NEM1OC43OTk1IDIzLjY3MTcgNTguNzUyNSAyNS42NTA1IDU4Ljc5OTUgMjcuNTgyMkM1OC43OTk1IDI3LjkxMiA1OC43OTk1IDI4LjI0MTggNTguNzk5NSAyOC41NzE2QzU4Ljc5OTUgMjguNzYwMSA1OC43OTk1IDI4Ljk0ODUgNTguNzUyNSAyOS4wODk5QzU4LjcwNTYgMjkuMjc4MyA1OC42MTE3IDI5LjQ2NjggNTguNDcwOSAyOS42NTUzQzU4LjMzIDI5Ljg0MzcgNTguMjM2MSAyOS45ODUxIDU4LjA0ODMgMzAuMTczNUM1OS43ODUzIDMwLjE3MzUgNjEuNDc1NCAzMC4xNzM1IDYzLjIxMjMgMzAuMTczNUM2My4xMTg1IDMwLjA3OTMgNjMuMDI0NiAyOS45ODUxIDYyLjkzMDcgMjkuODkwOEM2Mi43NDI5IDI5LjcwMjQgNjIuNjAyMSAyOS40NjY4IDYyLjUwODIgMjkuMTg0MUM2Mi40NjEyIDI4Ljk5NTcgNjIuNDE0MyAyOC44MDcyIDYyLjQxNDMgMjguNjE4N0M2Mi40MTQzIDI4LjM4MzIgNjIuNDE0MyAyOC4xMDA1IDYyLjQxNDMgMjcuODY0OUM2Mi40MTQzIDI3LjQ4OCA2Mi40MTQzIDI3LjE1ODIgNjIuNDE0MyAyNi43ODEyQzYyLjQxNDMgMjQuNzU1MyA2Mi40MTQzIDIyLjc3NjUgNjIuNDE0MyAyMC43NTA1QzYyLjQxNDMgMjAuNTYyMSA2Mi40MTQzIDIwLjM3MzYgNjIuNDE0MyAyMC4xODUyQzYyLjQxNDMgMTkuOTQ5NiA2Mi40MTQzIDE5LjcxNCA2Mi40NjEyIDE5LjUyNTVDNjIuNTA4MiAxOS4yOSA2Mi41NTUxIDE5LjA1NDQgNjIuNjQ5IDE4Ljg2NTlDNjIuNzQyOSAxOC42MzA0IDYyLjkzMDcgMTguNDQxOSA2My4xNjU0IDE4LjM0NzdDNjMuMzUzMiAxOC4yNTM0IDYzLjU0MSAxOC4yMDYzIDYzLjcyODcgMTguMjA2M0M2My45MTY1IDE4LjIwNjMgNjQuMTUxMyAxOC4yMDYzIDY0LjMzOSAxOC4zMDA2QzY0LjYyMDcgMTguMzk0OCA2NC44MDg1IDE4LjU4MzIgNjQuOTk2MyAxOC44MTg4QzY1LjEzNzEgMTkuMDU0NCA2NS4yMzEgMTkuMzM3MSA2NS4zMjQ5IDE5LjYxOThDNjUuNDE4OCAxOS45OTY3IDY1LjUxMjcgMjAuMzczNiA2NS41NTk2IDIwLjc5NzdDNjUuNjA2NiAyMS4yNjg4IDY1LjYwNjYgMjEuNzM5OSA2NS41MTI3IDIyLjI1ODJDNjUuNDY1NyAyMi42ODIyIDY1LjM3MTggMjMuMDU5MiA2NS4xODQxIDIzLjM4OUM2NS4wOTAyIDIzLjU3NzQgNjQuOTAyNCAyMy43NjU5IDY0LjcxNDYgMjMuOTA3MkM2NC40Nzk5IDI0LjA0ODYgNjQuMTk4MiAyNC4xNDI4IDYzLjkxNjUgMjQuMTg5OUM2My41ODc5IDI0LjA5NTcgNjMuMjU5MyAyNC4wOTU3IDYyLjg4MzcgMjQuMDAxNVoiIGZpbGw9IiMyNjI2MjYiLz4KPHBhdGggZD0iTTgwLjQ5NzUgMjMuMDExMkM4MC40OTM2IDIzLjAzMzEgODAuNDkzNiAyMy4wNTEgODAuNDg5NiAyMy4wNjY5QzgwLjQ1NzggMjMuMTYyMyA4MC40MjYgMjMuMjU1NyA4MC4zOTQyIDIzLjM1MTFDODAuMzY0MyAyMy40Mzg2IDgwLjMzMDYgMjMuNTI2MSA4MC4zMDA3IDIzLjYxNTVDODAuMjcwOSAyMy43MDMgODAuMjQ1MSAyMy43OTI0IDgwLjIxNTMgMjMuODgxOUM4MC4xNzM1IDI0LjAwMzEgODAuMTI3OCAyNC4xMjQ0IDgwLjA4NDEgMjQuMjQ1N0M4MC4wNDIzIDI0LjM2MjkgODAuMDAwNiAyNC40NzgyIDc5Ljk1NjkgMjQuNTk1NUM3OS45MjExIDI0LjY5NDkgNzkuODgxMyAyNC43OTQzIDc5Ljg0NTUgMjQuODkzN0M3OS44MTU3IDI0Ljk3OTEgNzkuNzgzOSAyNS4wNjI2IDc5Ljc2MDEgMjUuMTUwMUM3OS43MDQ0IDI1LjM0MjkgNzkuNTg5MSAyNS40ODYgNzkuNDEwMiAyNS41Nzc1Qzc5LjI1NTIgMjUuNjU5IDc5LjA5NjEgMjUuNzMwNSA3OC45MzEyIDI1Ljc5MjFDNzguODQxNyAyNS44MjU5IDc4Ljc1MDMgMjUuODQ5OCA3OC42NTg4IDI1Ljg3OTZDNzguNTgxMyAyNS45MDM1IDc4LjUwNTggMjUuOTI5MyA3OC40MjgyIDI1Ljk1MTJDNzguMzY4NiAyNS45NjkxIDc4LjMwNyAyNS45ODMgNzguMjQ3NCAyNS45OTY5Qzc4LjE3OTggMjYuMDE0OCA3OC4xMTQyIDI2LjAzMjcgNzguMDQ2NiAyNi4wNDg2Qzc4LjAwNjggMjYuMDU4NSA3Ny45NjcxIDI2LjA2NjUgNzcuOTI1MyAyNi4wNzQ0Qzc3Ljg3MzcgMjYuMDg2MyA3Ny44MjIgMjYuMDk2MyA3Ny43NzAzIDI2LjEwODJDNzcuNzMyNSAyNi4xMTYyIDc3LjY5NjcgMjYuMTI0MSA3Ny42NTkgMjYuMTMwMUM3Ny42MDMzIDI2LjE0IDc3LjU0NzcgMjYuMTQ2IDc3LjQ5MiAyNi4xNTU5Qzc3LjQyNDQgMjYuMTY1OCA3Ny4zNTg4IDI2LjE3NzggNzcuMjkxMiAyNi4xODc3Qzc3LjI4NzMgMjYuMTg3NyA3Ny4yODEzIDI2LjE4OTcgNzcuMjc3MyAyNi4xODk3Qzc3LjE5NTggMjYuMTk3NyA3Ny4xMTIzIDI2LjIwNTYgNzcuMDMwOCAyNi4yMTU1Qzc2LjkzMTQgMjYuMjI1NSA3Ni44MzAxIDI2LjIzNTQgNzYuNzMwNyAyNi4yNDczQzc2LjcyMDcgMjYuMjQ5MyA3Ni43MTA4IDI2LjI0OTMgNzYuNzAwOSAyNi4yNTEzQzc2LjQwNDcgMjYuMjYxMyA3Ni4xMDg1IDI2LjI4MzEgNzUuODEyMyAyNi4yNzEyQzc1LjY4MTEgMjYuMjY1MiA3NS41NDk5IDI2LjI2MTMgNzUuNDIwNyAyNi4yNTEzQzc1LjMxNTQgMjYuMjQzNCA3NS4yMSAyNi4yMjk1IDc1LjEwNDcgMjYuMjE5NUM3NS4wMjMyIDI2LjIxMTYgNzQuOTM5NyAyNi4yMDU2IDc0Ljg1ODIgMjYuMTk1N0M3NC43ODg2IDI2LjE4NzcgNzQuNzE5IDI2LjE3MzggNzQuNjQ3NSAyNi4xNjE5Qzc0LjYwMzggMjYuMTUzOSA3NC41NiAyNi4xNDYgNzQuNTE2MyAyNi4xNEM3NC40NjQ2IDI2LjEzMjEgNzQuNDEwOSAyNi4xMjQxIDc0LjM1OTMgMjYuMTE0MkM3NC4zMTE1IDI2LjEwNjIgNzQuMjY1OCAyNi4wOTIzIDc0LjIyMDEgMjYuMDgyNEM3NC4xODQzIDI2LjA3NDQgNzQuMTQ4NiAyNi4wNjY1IDc0LjExNDggMjYuMDU4NUM3NC4wMTU0IDI2LjAzMjcgNzMuOTE0IDI2LjAwODggNzMuODE0NiAyNS45ODFDNzMuNzE5MiAyNS45NTUxIDczLjYyMTggMjUuOTI3MyA3My41MjY0IDI1Ljg5NTVDNzMuNDI1IDI1Ljg2MTcgNzMuMzIzNiAyNS44MjIgNzMuMjIyMiAyNS43ODIyQzczLjEwMyAyNS43MzQ1IDcyLjk4MzcgMjUuNjg4OCA3Mi44Njg0IDI1LjYzNTFDNzIuNTc2MiAyNS40OTk5IDcyLjI5MzkgMjUuMzQ0OSA3Mi4wMjc2IDI1LjE2QzcxLjY5MzYgMjQuOTI5NCA3MS4zODU1IDI0LjY2OSA3MS4xMjEyIDI0LjM2MDlDNzAuODkyNiAyNC4wOTQ2IDcwLjY5OTcgMjMuODAyNCA3MC41NDY3IDIzLjQ4NjNDNzAuNDc1MSAyMy4zMzcyIDcwLjQxMTUgMjMuMTg0MiA3MC4zNTU5IDIzLjAyOTFDNzAuMzIyMSAyMi45MzU3IDcwLjI5NjIgMjIuODM4MyA3MC4yNzA0IDIyLjc0MDlDNzAuMjQ0NSAyMi42NDk1IDcwLjIxODcgMjIuNTU4IDcwLjE5NjggMjIuNDY0NkM3MC4xNzg5IDIyLjM4MTEgNzAuMTY1IDIyLjI5NTYgNzAuMTUxMSAyMi4yMTIxQzcwLjE0MTIgMjIuMTUyNSA3MC4xMjkzIDIyLjA5MjkgNzAuMTE5MyAyMi4wMzEzQzcwLjExOTMgMjIuMDI3MyA3MC4xMTczIDIyLjAyNTMgNzAuMTE3MyAyMi4wMjEzQzcwLjEwOTQgMjEuOTU5NyA3MC4xMDE0IDIxLjg5NjEgNzAuMDk1NSAyMS44MzQ1QzcwLjA2OTYgMjEuNTg0IDcwLjA2NzYgMjEuMzMxNiA3MC4wNzM2IDIxLjA4MTFDNzAuMDc3NiAyMC45NDM5IDcwLjA4NTUgMjAuODA2OCA3MC4wOTc0IDIwLjY2OTZDNzAuMTA1NCAyMC41NjIzIDcwLjExOTMgMjAuNDU2OSA3MC4xMzcyIDIwLjM0OTZDNzAuMTUxMSAyMC4yNTQyIDcwLjE3MyAyMC4xNTg4IDcwLjE5MDkgMjAuMDYzNEM3MC4yMDQ4IDE5Ljk4NTggNzAuMjE4NyAxOS45MDgzIDcwLjIzNjYgMTkuODMwOEM3MC4yNTI1IDE5Ljc2MzIgNzAuMjcyNCAxOS42OTc2IDcwLjI5MDMgMTkuNjNDNzAuMzEyMSAxOS41NDg1IDcwLjMzMiAxOS40NjcgNzAuMzU1OSAxOS4zODc1QzcwLjM3NzcgMTkuMzE0IDcwLjQwMzYgMTkuMjQwNCA3MC40Mjc0IDE5LjE2ODlDNzAuNDUzMyAxOS4wOTEzIDcwLjQ4MTEgMTkuMDEzOCA3MC41MDg5IDE4LjkzODNDNzAuNTU2NiAxOC44MTcgNzAuNjAwNCAxOC42OTE4IDcwLjY1NiAxOC41NzQ1QzcwLjczNzUgMTguMzk5NiA3MC44MjEgMTguMjI0NyA3MC45MTY0IDE4LjA1NzdDNzEuMTQzIDE3LjY1NjIgNzEuNDE5MyAxNy4yODg0IDcxLjc1MzMgMTYuOTY4NEM3Mi4wOTEyIDE2LjY0MjQgNzIuNDY4OSAxNi4zNzIgNzIuODgyMyAxNi4xNTM0QzczLjA0MTQgMTYuMDY5OSA3My4yMDQ0IDE1Ljk5MjQgNzMuMzcxMyAxNS45MjQ4QzczLjQ5MDYgMTUuODc3MSA3My42MTE4IDE1LjgzNzMgNzMuNzMzMSAxNS43OTc2QzczLjgzNjUgMTUuNzYzOCA3My45Mzk4IDE1LjczMiA3NC4wNDMyIDE1LjcwNDFDNzQuMTE0OCAxNS42ODQzIDc0LjE4ODMgMTUuNjcyMyA3NC4yNTk5IDE1LjY1ODRDNzQuMzQ5MyAxNS42NDA1IDc0LjQ0MDggMTUuNjIwNyA3NC41MzAyIDE1LjYwNDhDNzQuNTkzOCAxNS41OTQ4IDc0LjY1NzQgMTUuNTg2OSA3NC43MjEgMTUuNTgwOUM3NC44NjAyIDE1LjU2OSA3NS4wMDEzIDE1LjU1OSA3NS4xNDI0IDE1LjU1MzFDNzUuMjUzOCAxNS41NDkxIDc1LjM2NTEgMTUuNTUxMSA3NS40NzQ0IDE1LjU1MzFDNzUuNTA4MiAxNS41NTMxIDc1LjU0NCAxNS41NTUxIDc1LjU3NzggMTUuNTU5Qzc1LjY5NSAxNS41NjcgNzUuODEyMyAxNS41NzEgNzUuOTI5NiAxNS41ODQ5Qzc2LjAzNSAxNS41OTY4IDc2LjEzODMgMTUuNjE4NyA3Ni4yNDE3IDE1LjYzNjZDNzYuMjg5NCAxNS42NDQ1IDc2LjMzOTEgMTUuNjUyNSA3Ni4zODY4IDE1LjY2MjRDNzYuNDI4NSAxNS42NzA0IDc2LjQ3MDMgMTUuNjgyMyA3Ni41MTIgMTUuNjkyMkM3Ni41NDc4IDE1LjcwMDIgNzYuNTgxNiAxNS43MTAxIDc2LjYxNzQgMTUuNzIwMUM3Ni43MDQ4IDE1Ljc0MzkgNzYuNzkwMyAxNS43Njc4IDc2Ljg3NzggMTUuNzk1NkM3Ni45NTkzIDE1LjgyMTQgNzcuMDM4OCAxNS44NTEyIDc3LjEyMDMgMTUuODc5MUM3Ny4yNTc0IDE1LjkyNDggNzcuMzg4NiAxNS45ODI0IDc3LjUxNzggMTYuMDQ0MUM3Ny43NDY0IDE2LjE1MzQgNzcuOTY3MSAxNi4yNzY2IDc4LjE3NzggMTYuNDE5N0M3OC41NDk1IDE2LjY3MDIgNzguODg1NCAxNi45NjI0IDc5LjE4MTYgMTcuMzAyM0M3OS40NTIgMTcuNjEyNCA3OS42Nzg2IDE3Ljk1MDMgNzkuODU3NSAxOC4zMjIxQzc5LjkzMSAxOC40NzUxIDc5Ljk5MjYgMTguNjMwMiA4MC4wNDgzIDE4Ljc4OTJDODAuMDg2MSAxOC44OTY1IDgwLjExNzkgMTkuMDA3OCA4MC4xNDc3IDE5LjExOTJDODAuMTczNSAxOS4yMTg1IDgwLjE5MzQgMTkuMzIxOSA4MC4yMTMzIDE5LjQyMzNDODAuMjMxMiAxOS41MTQ3IDgwLjI0OTEgMTkuNjA4MiA4MC4yNjY5IDE5LjY5OTZDODAuMjc2OSAxOS43NDkzIDgwLjI4MjggMTkuODAxIDgwLjI4ODggMTkuODUwN0M4MC4yOTg4IDE5Ljk0NjEgODAuMzAyNyAyMC4wNDE1IDgwLjMxNDcgMjAuMTM2OUM4MC4zMzI1IDIwLjI4NiA4MC4zMzQ1IDIwLjQzNTEgODAuMzM0NSAyMC41ODIyQzgwLjMzNDUgMjAuNzE1MyA4MC4zMzI1IDIwLjg1MDUgODAuMzMyNSAyMC45ODM3QzgwLjMzMjUgMjEuMDAzNiA4MC4zMjg2IDIxLjAyMzUgODAuMzI2NiAyMS4wNDUzQzgwLjMwMDcgMjEuMDQ3MyA4MC4yNzY5IDIxLjA0OTMgODAuMjU1IDIxLjA0OTNDNzkuMTUzOCAyMS4wNDkzIDc4LjA1MjYgMjEuMDQ5MyA3Ni45NTEzIDIxLjA1MTNDNzUuOTI5NiAyMS4wNTEzIDc0LjkwNzkgMjEuMDUzMyA3My44ODYyIDIxLjA1NTNDNzMuODA0NyAyMS4wNTUzIDczLjgwNDcgMjEuMDU3MiA3My44MDA3IDIxLjEzODdDNzMuNzkwNyAyMS4yODc4IDczLjgwODYgMjEuNDM2OSA3My44MjA2IDIxLjU4NEM3My44Mjg1IDIxLjY4MzQgNzMuODUyNCAyMS43ODI4IDczLjg3NDIgMjEuODgwMkM3My44OTQxIDIxLjk2OTYgNzMuOTEyIDIyLjA2MTEgNzMuOTM5OCAyMi4xNDY2Qzc0LjAwOTQgMjIuMzYxMiA3NC4xMDI4IDIyLjU2NCA3NC4yMjQxIDIyLjc1NDhDNzQuNDYwNiAyMy4xMjQ1IDc0Ljc2NjggMjMuNDIwNyA3NS4xMzQ1IDIzLjY1OTNDNzUuMjk3NSAyMy43NjQ2IDc1LjQ2ODQgMjMuODUyMSA3NS42NDczIDIzLjkyMzZDNzUuNzU2NyAyMy45Njc0IDc1Ljg2OCAyNC4wMDUxIDc1Ljk4NTMgMjQuMDMxQzc2LjA1NjggMjQuMDQ2OSA3Ni4xMjg0IDI0LjA2ODcgNzYuMTk5OSAyNC4wODI3Qzc2LjI1NzYgMjQuMDk0NiA3Ni4zMTcyIDI0LjEwMDUgNzYuMzc2OSAyNC4xMDg1Qzc2LjQ3NjIgMjQuMTIwNCA3Ni41NzM2IDI0LjEzMDQgNzYuNjczIDI0LjEzODNDNzYuODA0MiAyNC4xNDgyIDc2LjkzNzQgMjQuMTQ4MiA3Ny4wNzA2IDI0LjEzNjNDNzcuMTA2NCAyNC4xMzIzIDc3LjE0NDEgMjQuMTMwNCA3Ny4xNzk5IDI0LjEyODRDNzcuMjc1MyAyNC4xMjA0IDc3LjM3MDcgMjQuMTE2NCA3Ny40NjYyIDI0LjEwMjVDNzcuNTYzNiAyNC4wODg2IDc3LjY2MSAyNC4wNjg3IDc3Ljc1NjQgMjQuMDUwOEM3Ny44MzM5IDI0LjAzNjkgNzcuOTExNCAyNC4wMjMgNzcuOTg4OSAyNC4wMDUxQzc4LjA1NDUgMjMuOTkxMiA3OC4xMTgyIDIzLjk3MTMgNzguMTgzNyAyMy45NTM0Qzc4LjI0MTQgMjMuOTM3NSA3OC4zMDEgMjMuOTIzNiA3OC4zNTg3IDIzLjkwNzdDNzguNDEwNCAyMy44OTM4IDc4LjQ2MiAyMy44Nzc5IDc4LjUxMzcgMjMuODZDNzguNTgzMyAyMy44MzgyIDc4LjY1MDkgMjMuODE0MyA3OC43MTg1IDIzLjc5MDRDNzguNzkgMjMuNzY0NiA3OC44NTk2IDIzLjczODggNzguOTI5MiAyMy43MTI5Qzc5LjAwMjcgMjMuNjg1MSA3OS4wNzYzIDIzLjY1OTMgNzkuMTQ5OCAyMy42MzE0Qzc5LjI1NTIgMjMuNTg5NyA3OS4zNjA1IDIzLjU0NzkgNzkuNDYzOSAyMy41MDQyQzc5LjU3NzIgMjMuNDU2NSA3OS42ODg1IDIzLjQwNjggNzkuNzk3OCAyMy4zNTMxQzc5Ljk3MDggMjMuMjcxNiA4MC4xNDE3IDIzLjE4NjIgODAuMzE0NyAyMy4xMDI3QzgwLjM2ODMgMjMuMDc2OCA4MC40MTggMjMuMDQ3IDgwLjQ3MTcgMjMuMDIxMkM4MC40NzM3IDIzLjAxMzIgODAuNDgxNiAyMy4wMTUyIDgwLjQ5NzUgMjMuMDExMlpNNzMuNzc0OCAxOS4yMzA1Qzc0Ljc1ODggMTkuMjMwNSA3NS43MzQ4IDE5LjIzMDUgNzYuNzE0OCAxOS4yMzA1Qzc2LjcxNjggMTkuMjEwNiA3Ni43MTg4IDE5LjE5NDcgNzYuNzIyNyAxOS4xNzg4Qzc2LjczMjcgMTkuMDk5MyA3Ni43MjI3IDE5LjAxOTggNzYuNzIwNyAxOC45NDAzQzc2LjcxNjggMTguODQ0OCA3Ni42OTY5IDE4Ljc1MzQgNzYuNjc1IDE4LjY2MkM3Ni42NDcyIDE4LjU1NjYgNzYuNjA5NCAxOC40NTUyIDc2LjU1OTcgMTguMzU5OEM3Ni40NzYyIDE4LjE5MjkgNzYuMzY2OSAxOC4wNDc3IDc2LjIxOTggMTcuOTMwNUM3Ni4xNTQyIDE3Ljg3ODggNzYuMDg0NyAxNy44MzUxIDc2LjAwOTEgMTcuNzk3M0M3NS45MzU2IDE3Ljc2MTUgNzUuODYyIDE3LjcyNzcgNzUuNzg2NSAxNy42OTk5Qzc1LjcxMjkgMTcuNjc0IDc1LjYzNTQgMTcuNjU0MiA3NS41NTc5IDE3LjYzODNDNzUuNDcyNCAxNy42MjA0IDc1LjM4NSAxNy42MTI0IDc1LjI5NzUgMTcuNjA4NEM3NS4yNDk4IDE3LjYwNjUgNzUuMjAyMSAxNy42MTg0IDc1LjE1NDQgMTcuNjIwNEM3NS4wNzA5IDE3LjYyNDMgNzQuOTkxNCAxNy42NDQyIDc0LjkxMTkgMTcuNjY4MUM3NC43NzI3IDE3LjcwOTggNzQuNjM3NSAxNy43Njc1IDc0LjUxNDMgMTcuODQ1Qzc0LjI4OTcgMTcuOTgyMSA3NC4xMTQ4IDE4LjE2NSA3My45OTM1IDE4LjM5NzZDNzMuOTQ1OCAxOC40OTEgNzMuOTAwMSAxOC41ODQ0IDczLjg3MjIgMTguNjg1OEM3My44NTQ0IDE4Ljc0OTQgNzMuODMyNSAxOC44MTExIDczLjgxODYgMTguODc0N0M3My44MDI3IDE4Ljk0NjIgNzMuNzkyNyAxOS4wMTk4IDczLjc4MjggMTkuMDkzM0M3My43NzY4IDE5LjEzOSA3My43NzY4IDE5LjE4MjggNzMuNzc0OCAxOS4yMzA1WiIgZmlsbD0iIzI2MjYyNiIvPgo8cGF0aCBkPSJNODAuNTA2OCAyNS43NjY0QzgwLjYwNTggMjUuNjc5NSA4MC42OTkgMjUuNTg2OCA4MC43ODY0IDI1LjQ4ODNDODAuOTI2MSAyNS4zMjYxIDgxLjA0ODQgMjUuMTUyMyA4MS4xMjk5IDI0Ljk2MTFDODEuMjU4MSAyNC42NDgzIDgxLjI1ODEgMjQuMzAwNyA4MS4yNjM5IDIzLjk1MzFDODEuMjY5NyAyMy4xODI1IDgxLjI2MzkgMjIuNDQ2OCA4MS4yNjM5IDIxLjY5OTVDODEuMjYzOSAyMC42MjE5IDgxLjI2OTcgMTkuNTI3IDgxLjI2MzkgMTguNDM3OEM4MS4yNjM5IDE4LjI1ODIgODEuMjYzOSAxOC4wNzg2IDgxLjI2MzkgMTcuOTA0OEM4MS4yNjM5IDE3Ljc4MzIgODEuMjY5NyAxNy42NjE1IDgxLjI2MzkgMTcuNTM5OUM4MS4yNjM5IDE3LjQ2NDYgODEuMjU4MSAxNy4zODkyIDgxLjIzNDggMTcuMzEzOUM4MS4xODgyIDE3LjE0MDEgODEuMDQ4NCAxNy4wMDExIDgwLjkyNjEgMTYuODU2M0M4MC44MDk3IDE2LjcyMyA4MC43MDQ4IDE2LjU4NCA4MC42NDA4IDE2LjQyMThDODAuNTg4NCAxNi4yODg1IDgwLjU3NjcgMTYuMTM3OSA4MC41ODI1IDE1LjkzNTFDODEuMjM0OCAxNS45MzUxIDgxLjg4MTIgMTUuOTM1MSA4Mi41MzM0IDE1LjkzNTFDODIuODAxMiAxNS45MzUxIDgzLjA2OTEgMTUuOTM1MSA4My4zMTM3IDE1LjkzNTFDODMuNTE3NSAxNS45MzUxIDgzLjcwOTcgMTUuOTM1MSA4My45MzY4IDE1Ljg5NDZDODQuMTExNSAxNS44NjU2IDg0LjMxNTMgMTUuODEzNSA4NC40OTU4IDE1Ljc3ODdDODQuNjEyMyAxNS43NTU1IDg0LjcyMyAxNS43MzgyIDg0LjgzOTQgMTUuNzQzOUM4NC45MDkzIDE1Ljc0OTcgODQuOTc5MiAxNS43NjEzIDg1LjAzMTYgMTUuODAxOUM4NS4wNzgyIDE1Ljg0MjQgODUuMTAxNSAxNS45MDYyIDg1LjExODkgMTUuOTY0MUM4NS4xMzA2IDE2LjAxNjIgODUuMTMwNiAxNi4wNjg0IDg1LjEzMDYgMTYuMTI2M0M4NS4xMzY0IDE2LjI4ODUgODUuMTQyMiAxNi40NTA3IDg1LjEzMDYgMTYuNjEyOUM4NS4yMzU0IDE2LjUwMjkgODUuMzQ2MSAxNi4zOTg2IDg1LjQ2MjUgMTYuMjk0M0M4NS42MTM5IDE2LjE2MTEgODUuNzc3IDE2LjAzOTQgODUuOTUxNyAxNS45NDY3Qzg2LjEzMjIgMTUuODU0IDg2LjMzMDIgMTUuNzkwMyA4Ni41MjI0IDE1Ljc0MzlDODYuNzg0NCAxNS42ODYgODcuMDQwNyAxNS42NTcgODcuMzI2IDE1LjY2MjhDODcuNTI0IDE1LjY2MjggODcuNzM5NSAxNS42ODAyIDg3Ljg3MzQgMTUuODA3N0M4Ny45NDkxIDE1Ljg4MyA4Ny45OTU3IDE1Ljk4NzMgODguMDEzMiAxNi4wOTczQzg4LjAzNjUgMTYuMTk1OCA4OC4wMzA2IDE2LjMwMDEgODguMDMwNiAxNi4zOTg2Qzg4LjAzMDYgMTYuNjY1MSA4OC4wMzA2IDE2LjkzMTYgODguMDMwNiAxNy4yMDM5Qzg4LjAzMDYgMTcuNjI2OCA4OC4wMjQ4IDE4LjA0MzkgODguMDI0OCAxOC40MjYyQzg3LjQ4MzIgMTguNDIwNSA4Ny4wNzU2IDE4LjM5NzMgODYuNzAyOSAxOC40MTQ3Qzg2LjQ5MzMgMTguNDI2MiA4Ni4zMDExIDE4LjQ0OTQgODYuMDk3MyAxOC41MTg5Qzg1LjkxMDkgMTguNTgyNyA4NS43MTI5IDE4LjY4MTEgODUuNTQ5OSAxOC44MjAyQzg1LjM3NTIgMTguOTY1IDg1LjIzNTQgMTkuMTU2MiA4NS4xNDgxIDE5LjM2NDhDODUuMDQzMiAxOS42MjU1IDg1LjAzMTYgMTkuOTIwOSA4NS4wMzE2IDIwLjIwNDhDODUuMDMxNiAyMC40MTMzIDg1LjAzMTYgMjAuNjE2MSA4NS4wMzE2IDIwLjgxODlDODUuMDM3NCAyMS41MzE1IDg1LjA0OTEgMjIuMjQ0IDg1LjAzMTYgMjIuOTE2MUM4NS4wMTk5IDIzLjM4NTMgODQuOTk2NyAyMy44MzcyIDg1LjA1NDkgMjQuMzkzM0M4NS4wNzI0IDI0LjU0OTggODUuMDg5OCAyNC43MTIgODUuMTM2NCAyNC44NTY4Qzg1LjIwMDUgMjUuMDc3IDg1LjMxMTEgMjUuMjUwOCA4NS40Mjc2IDI1LjQxODhDODUuNTA5MSAyNS41MzQ2IDg1LjU5NjUgMjUuNjQ0NyA4NS42ODk2IDI1Ljc0OUM4My45NjAxIDI1Ljc2NjQgODIuMjM2NCAyNS43NjY0IDgwLjUwNjggMjUuNzY2NFoiIGZpbGw9IiMyNjI2MjYiLz4KPHBhdGggZD0iTTk4LjIwNzMgMjUuNzU4MkM5NC43ODA5IDI1Ljc1ODIgOTEuMzU0NiAyNS43NTgyIDg3LjkxNSAyNS43NTgyQzg3Ljk0MTQgMjUuNzI1MiA4Ny45NjEzIDI1LjY5MjEgODcuOTgxMSAyNS42Nzg5Qzg4LjMxMTkgMjUuNDA3NyA4OC41ODk3IDI1LjA5MDIgODguODM0NCAyNC43Mzk2Qzg4Ljk5MzIgMjQuNTE0NyA4OS4xMTg4IDI0LjI4MzIgODkuMjExNCAyNC4wMzE4Qzg5LjI3NzYgMjMuODQ2NiA4OS4zMTczIDIzLjY1NDggODkuMzYzNiAyMy40NjNDODkuNDI5NyAyMy4yMDUgODkuNDI5NyAyMi45NDA0IDg5LjQ1NjIgMjIuNjc1OUM4OS41MDkxIDIyLjE4NjQgODkuNDg5MyAyMS43MDM1IDg5LjQ4OTMgMjEuMjE0Qzg5LjQ4OTMgMjAuMDk2MiA4OS40ODkzIDE4Ljk3ODMgODkuNDc2IDE3Ljg2MDRDODkuNDY5NCAxNi45MDEzIDg5LjQ0OTYgMTUuOTQ4OCA4OS40Mjk3IDE0Ljk4OTdDODkuNDE2NSAxNC4zMzQ5IDg5LjQxNjUgMTMuNjggODkuMzkgMTMuMDE4NkM4OS4zNTcgMTIuMDI2NCA4OS4zNzAyIDExLjAyNzYgODkuMzM3MSAxMC4wMzU0Qzg5LjI4NDIgOC4zMzU0NiA4OS4zMTczIDYuNjI4OSA4OS4zMDQgNC45Mjg5NUM4OS4zMDQgNC42NjQzNyA4OS4zMTczIDQuNDA2NCA4OS4yNzEgNC4xNDE4MkM4OS4yNTc3IDQuMDgyMjkgODkuMjY0NCA0LjAxNjE0IDg5LjI2NDQgMy45NDk5OUM4OS4yNjQ0IDMuNzQ0OTQgODkuMjMxMyAzLjUzOTg5IDg5LjE4NSAzLjM0MTQ1Qzg5LjE1MTkgMy4yMDI1NSA4OS4xMjU1IDMuMDU3MDMgODkuMDg1OCAyLjkxODEyQzg4Ljk2MDEgMi40NzQ5NCA4OC43NjgzIDIuMDc4MDcgODguNDE3NyAxLjc2NzE4Qzg4LjI4NTQgMS42NDgxMiA4OC4xNTk3IDEuNTI5MDYgODguMDIwOCAxLjQxNjYxQzg3Ljk0MTQgMS4zNTA0NiA4Ny44ODE5IDEuMjcxMDkgODcuODQyMiAxLjE3ODQ5Qzg3Ljc3NjEgMS4wMTMxMiA4Ny44MTU4IDAuOTAwNjc0IDg4LjAyNzQgMC44Njc2MDFDODguMDg3IDAuODU0MzcyIDg4LjE0NjUgMC44NjA5ODYgODguMjA2IDAuODYwOTg2Qzg5LjI4NDIgMC44NjA5ODYgOTAuMzYyNCAwLjg2NzYwMiA5MS40MzM5IDAuODQ3NzU4QzkxLjkzIDAuODQxMTQzIDkyLjQzMjcgMC44MjEyOTkgOTIuOTI4OCAwLjgzNDUyOEM5NS40MjkxIDAuODk0MDU5IDk3LjkyOTUgMC44NDExNDMgMTAwLjQzNiAwLjg2NzYwMUMxMDAuNTYyIDAuODY3NjAxIDEwMC42ODEgMC44ODc0NDUgMTAwLjgwNyAwLjkwMDY3NEMxMDAuODQgMC45MDA2NzQgMTAwLjg2NiAwLjkwNzI4OSAxMDAuODk5IDAuOTA3Mjg5QzEwMS4xMzEgMC45MjcxMzMgMTAxLjM2MiAwLjk0MDM2MSAxMDEuNTk0IDAuOTY2ODJDMTAxLjcyNiAwLjk4MDA0OSAxMDEuODU5IDEuMDE5NzQgMTAxLjk4NCAxLjAzOTU4QzEwMi4wOTcgMS4wNTk0MiAxMDIuMjAyIDEuMDcyNjUgMTAyLjMxNSAxLjA5MjVDMTAyLjQxNCAxLjExMjM0IDEwMi41MDcgMS4xMzg4IDEwMi42MDYgMS4xNjUyNkMxMDIuNjcyIDEuMTg1MSAxMDIuNzMyIDEuMjA0OTQgMTAyLjc5OCAxLjIxODE3QzEwMy4xMDkgMS4yOTA5MyAxMDMuNDA2IDEuNDEgMTAzLjY5NyAxLjUzNTY3QzEwNC4yODYgMS43ODcwMyAxMDQuODE1IDIuMTMwOTkgMTA1LjI5OCAyLjU1NDMyQzEwNS43NzQgMi45NzEwNCAxMDYuMTg0IDMuNDQ3MjkgMTA2LjUyOCAzLjk3NjQ1QzEwNi43MzMgNC4yOTM5NSAxMDYuOTE5IDQuNjI0NjggMTA3LjA1OCA0Ljk3NTI1QzEwNy4xMyA1LjE2MDQ2IDEwNy4yMDMgNS4zNDU2NyAxMDcuMjY5IDUuNTM3NDlDMTA3LjMxNiA1LjY3NjQgMTA3LjM0MiA1LjgyMTkyIDEwNy4zNzUgNS45Njc0NEMxMDcuNDIxIDYuMTc5MTEgMTA3LjQ1NCA2LjM5MDc3IDEwNy40OTQgNi42MDI0NEMxMDcuNDk0IDYuNjE1NjcgMTA3LjUwMSA2LjYyMjI4IDEwNy41MDEgNi42MzU1MUMxMDcuNTE0IDYuOTU5NjMgMTA3LjUzNCA3LjI4Mzc0IDEwNy41NCA3LjYxNDQ3QzEwNy41NCA3LjgxOTUyIDEwNy41MjcgOC4wMTc5NiAxMDcuNTAxIDguMjIzMDFDMTA3LjQ3NCA4LjQ0MTI5IDEwNy40MjEgOC42NTk1NyAxMDcuMzgyIDguODg0NDdDMTA3LjMzNSA5LjE2ODg5IDEwNy4yNDMgOS40NDAwOSAxMDcuMTQ0IDkuNzA0NjdDMTA2LjkzMiAxMC4yNTM3IDEwNi42NDEgMTAuNzYzIDEwNi4yNjQgMTEuMjE5NEMxMDUuOTk5IDExLjU0MzUgMTA1LjY4OCAxMS44MjEzIDEwNS4zNzEgMTIuMDkyNUMxMDQuODY4IDEyLjUyMjUgMTA0LjMzMiAxMi45MDYxIDEwMy43NTcgMTMuMjQzNUMxMDMuNTUyIDEzLjM2MjUgMTAzLjMzNCAxMy40NjE4IDEwMy4xMjIgMTMuNTY3NkMxMDMuMDQ5IDEzLjYwMDcgMTAzLjA0MyAxMy42MTM5IDEwMy4wODIgMTMuNjhDMTAzLjMwNyAxNC4wMzA2IDEwMy41MzIgMTQuMzg3OCAxMDMuNzU3IDE0LjczODRDMTAzLjkyMiAxNS4wMDMgMTA0LjA5NCAxNS4yNjc1IDEwNC4yNTMgMTUuNTMyMUMxMDQuNTQ0IDE2LjAwODQgMTA0LjgzNSAxNi40NzggMTA1LjExOSAxNi45NTQzQzEwNS4zODQgMTcuMzkwOCAxMDUuNjU1IDE3LjgzNCAxMDUuOTIgMTguMjc3MkMxMDYuMjExIDE4Ljc2IDEwNi41MDIgMTkuMjQ5NSAxMDYuNzkzIDE5LjczOUMxMDcuMTgzIDIwLjM4NzIgMTA3LjU2NyAyMS4wMzU0IDEwNy45NTcgMjEuNjgzN0MxMDguMjIyIDIyLjEyNjggMTA4LjQ5MyAyMi41NjM0IDEwOC43NzEgMjNDMTA5LjA2MiAyMy40NDMxIDEwOS4zOTkgMjMuODUzMyAxMDkuNzUgMjQuMjUwMUMxMTAuMTczIDI0LjcxOTggMTEwLjYyMyAyNS4xNTYzIDExMS4xMTIgMjUuNTU5OEMxMTEuMTE5IDI1LjU2NjQgMTExLjExOSAyNS41NzMgMTExLjEzOSAyNS41ODYzQzExMS4wNzMgMjUuNjA2MSAxMTEuMDA2IDI1LjYzMjYgMTEwLjk0NyAyNS42MzI2QzExMC42ODkgMjUuNjUyNCAxMTAuNDMxIDI1LjY1OSAxMTAuMTggMjUuNjkyMUMxMDkuOTc1IDI1LjcxODYgMTA5Ljc3IDI1LjcwNTMgMTA5LjU2NCAyNS43Mzg0QzEwOS4zOTMgMjUuNzY0OSAxMDkuMjIxIDI1Ljc1MTYgMTA5LjA0OSAyNS43NzgxQzEwOC43OTEgMjUuODE3OCAxMDguNTMzIDI1Ljc5MTMgMTA4LjI3NSAyNS44MzFDMTA3LjkzNyAyNS44NzczIDEwNy42IDI1Ljg1MDkgMTA3LjI2MyAyNS44NzA3QzEwNi4yNjQgMjUuOTQzNSAxMDUuMjcyIDI1Ljg5MDUgMTA0LjI3MyAyNS45MDM4QzEwNC4wNzQgMjUuOTAzOCAxMDMuODY5IDI1Ljg5MDUgMTAzLjY3MSAyNS44NTA5QzEwMy4wNDkgMjUuNzM4NCAxMDIuNTEzIDI1LjQ1NCAxMDIuMDM3IDI1LjAzNzNDMTAxLjcgMjQuNzM5NiAxMDEuNDIyIDI0LjM5NTYgMTAxLjE5NyAyNC4wMTJDMTAwLjk5MiAyMy42NzQ3IDEwMC44IDIzLjMyNDEgMTAwLjYwOCAyMi45ODAxQzEwMC40NDMgMjIuNjg5MSAxMDAuMjc4IDIyLjM5OCAxMDAuMTE5IDIyLjEwN0M5OS44NjA5IDIxLjYzNzQgOTkuNjAyOSAyMS4xNjExIDk5LjM1MTYgMjAuNjkxNUM5OS4wNDczIDIwLjEyMjYgOTguNzQ5NyAxOS41NTM4IDk4LjQ1MiAxOC45ODQ5Qzk4LjEzNDUgMTguMzgzIDk3LjgxNyAxNy43ODc3IDk3LjQ3MyAxNy4yMDU2Qzk3LjE2MjIgMTYuNjc2NCA5Ni44NjQ1IDE2LjEzNCA5Ni41NjAyIDE1LjU5ODNDOTYuNTQ3IDE1LjU3ODQgOTYuNTMzOCAxNS41NjUyIDk2LjQ5NDEgMTUuNTU4NkM5Ni40OTQxIDE1LjU5MTYgOTYuNDk0MSAxNS42MjQ3IDk2LjQ5NDEgMTUuNjU3OEM5Ni40OTQxIDE3LjY4ODUgOTYuNDk0MSAxOS43MjU4IDk2LjQ5NDEgMjEuNzU2NEM5Ni40OTQxIDIyLjEzMzUgOTYuNTAwNyAyMi41MDM5IDk2LjUyMDUgMjIuODgwOUM5Ni41MjcyIDIzLjA0NjMgOTYuNTY2OSAyMy4yMDUgOTYuNTkzMyAyMy4zNzA0Qzk2LjYxMzIgMjMuNDgyOCA5Ni42MjY0IDIzLjU4ODcgOTYuNjU5NSAyMy43MDExQzk2LjY5OTEgMjMuODQgOTYuNzQ1NCAyMy45ODU1IDk2LjgwNSAyNC4xMTc4Qzk2LjkxNzQgMjQuMzgyNCA5Ny4wNTYzIDI0LjYzMzggOTcuMjI4MyAyNC44NjUzQzk3LjQ3OTcgMjUuMTg5NCA5Ny43NjQxIDI1LjQ2NzIgOTguMTE0NyAyNS42ODU1Qzk4LjE0NzcgMjUuNzA1MyA5OC4xODA4IDI1LjczMTggOTguMjEzOSAyNS43NTE2Qzk4LjIxMzkgMjUuNzQ1IDk4LjIxMzkgMjUuNzUxNiA5OC4yMDczIDI1Ljc1ODJaTTk2LjQ0MTIgNC42MTE0NUM5Ni40MTQ3IDQuNzcwMiA5Ni40MTQ3IDEzLjAzMTggOTYuNDQxMiAxMy4xMTEyQzk2LjQ1NDQgMTMuMTExMiA5Ni40Njc2IDEzLjExNzggOTYuNDgwOSAxMy4xMTc4Qzk2LjU2MDIgMTMuMTA0NiA5Ni42Mzk2IDEzLjA5MTMgOTYuNzE5IDEzLjA3MTVDOTYuODExNiAxMy4wNTE3IDk2LjkxMDggMTMuMDQ1IDk3LjAwMzQgMTMuMDE4NkM5Ny4xNjg4IDEyLjk2NTcgOTcuMzI3NSAxMi45MDYxIDk3LjQ5MjkgMTIuODUzMkM5Ny43NDQyIDEyLjc2NzIgOTcuOTgyNCAxMi42NDgyIDk4LjIxMzkgMTIuNTA5M0M5OC42NDM4IDEyLjI1MTMgOTkuMDIwOSAxMS45MjcyIDk5LjM1MTYgMTEuNTU2OEM5OS43MDIyIDExLjE1OTkgOTkuOTg2NiAxMC43Mjk5IDEwMC4xOTggMTAuMjQ3MUMxMDAuMjc4IDEwLjA2ODUgMTAwLjMzNyA5Ljg4MzI3IDEwMC4zOTcgOS42OTE0NUMxMDAuNDM2IDkuNTY1NzcgMTAwLjQ2MyA5LjQzMzQ4IDEwMC40OTYgOS4zMDExOUMxMDAuNTM2IDkuMTIyNTkgMTAwLjU3NSA4Ljk0NCAxMDAuNTc1IDguNzU4NzlDMTAwLjU3NSA4LjY5MjY0IDEwMC41ODIgOC42MjY1IDEwMC41ODIgOC41NTM3NEMxMDAuNTg5IDguMTYzNDggMTAwLjU4OSA3Ljc3MzIyIDEwMC40ODkgNy4zOTYxOUMxMDAuNDM2IDcuMjEwOTggMTAwLjQwMyA3LjAxOTE2IDEwMC4zMzcgNi44NDA1NkMxMDAuMjExIDYuNDg5OTkgMTAwLjAzMyA2LjE2NTg4IDk5Ljc5NDggNS44NjgyMkM5OS41NTY2IDUuNTc3MTggOTkuMjg1NCA1LjMyNTgzIDk4Ljk1NDcgNS4xMjczOUM5OC43Njk1IDUuMDE0OTQgOTguNTcxMSA0LjkyODk1IDk4LjM3MjYgNC44NDI5NkM5OC4yNzM0IDQuNzk2NjYgOTguMTYxIDQuNzcwMiA5OC4wNTUxIDQuNzQzNzRDOTcuOTY5MSA0LjcyMzkgOTcuODgzMiA0LjcwNDA1IDk3Ljc5NzIgNC42OTA4M0M5Ny42NzE1IDQuNjY0MzcgOTcuNTUyNCA0LjYxODA3IDk3LjQyNjcgNC42MTgwN0M5Ny4xMDkyIDQuNTk4MjIgOTYuNzc4NSA0LjYxMTQ1IDk2LjQ0MTIgNC42MTE0NVoiIGZpbGw9IiMyNjI2MjYiLz4KPHBhdGggZD0iTTExNC43ODcgMTUuNzcxOEMxMTUuMDU5IDE1Ljc2MzkgMTE1LjMyOCAxNS43NzcgMTE1LjU5NSAxNS44MDU4QzExNS43OTkgMTUuODI5MyAxMTYuMDAzIDE1Ljg2MzMgMTE2LjIwNyAxNS45QzExNi4zNDMgMTUuOTIzNSAxMTYuNDgyIDE1Ljk1MjMgMTE2LjYxNiAxNS45ODg5QzExNi44NTYgMTYuMDU0MyAxMTcuMDkyIDE2LjEzOCAxMTcuMzE5IDE2LjI0QzExNy43ODcgMTYuNDQ2NyAxMTguMjE3IDE2LjcxNjEgMTE4LjU5OCAxNy4wNTFDMTE4Ljk5MyAxNy4zOTYzIDExOS4zMiAxNy43OTkyIDExOS41ODUgMTguMjU0NEMxMTkuNzEzIDE4LjQ3MTUgMTE5LjgyMyAxOC42OTkxIDExOS45MTcgMTguOTMxOUMxMTkuOTcyIDE5LjA2NTMgMTIwLjAxNCAxOS4yMDQgMTIwLjA1NiAxOS4zNDI2QzEyMC4wOTIgMTkuNDU1MSAxMjAuMTI0IDE5LjU3MDIgMTIwLjE1MiAxOS42ODUzQzEyMC4xNjggMTkuNzQ1NSAxMjAuMTc2IDE5LjgwODMgMTIwLjE4NiAxOS44NzFDMTIwLjIwMiAxOS45NDY5IDEyMC4yMTUgMjAuMDIyOCAxMjAuMjMxIDIwLjEwMTJDMTIwLjIzMyAyMC4xMDkxIDEyMC4yMzMgMjAuMTE5NiAxMjAuMjM2IDIwLjEyNzRDMTIwLjI0NCAyMC4xOTU0IDEyMC4yNTcgMjAuMjY2MSAxMjAuMjYgMjAuMzM0MUMxMjAuMjY1IDIwLjU2OTUgMTIwLjMwMSAyMC44MDIzIDEyMC4yNzMgMjEuMDM3OEMxMjAuMjY3IDIxLjA3OTYgMTIwLjI3IDIxLjEyMTUgMTIwLjI2NyAyMS4xNjA3QzEyMC4yNTcgMjEuMjkxNSAxMjAuMjUyIDIxLjQyMjMgMTIwLjIzMyAyMS41NTA1QzEyMC4yMTggMjEuNjc2MSAxMjAuMTg5IDIxLjc5NjQgMTIwLjE2NSAyMS45MjJDMTIwLjE0NyAyMi4wMTYyIDEyMC4xMjkgMjIuMTEyOSAxMjAuMTA1IDIyLjIwNzFDMTIwLjA3NiAyMi4zMTQ0IDEyMC4wNDUgMjIuNDE5IDEyMC4wMDggMjIuNTIzN0MxMTkuOTY3IDIyLjY0OTIgMTE5LjkyMiAyMi43NzIyIDExOS44NzUgMjIuODk1MUMxMTkuNzcgMjMuMTY0NiAxMTkuNjQyIDIzLjQyMDkgMTE5LjQ5IDIzLjY2OTVDMTE5LjAwNyAyNC40NTQzIDExOC4zMzkgMjUuMDM1IDExNy41MSAyNS40M0MxMTcuMjIyIDI1LjU2ODcgMTE2LjkyNCAyNS42ODEyIDExNi42MTggMjUuNzY3NUMxMTYuNDE0IDI1LjgyMjQgMTE2LjIwNyAyNS44Nzc0IDExNS45OTggMjUuOTIxOEMxMTUuODI4IDI1Ljk1ODUgMTE1LjY1OCAyNS45OTI1IDExNS40ODUgMjYuMDE2QzExNS4xMzcgMjYuMDYwNSAxMTQuNzg3IDI2LjA5NDUgMTE0LjQzNiAyNi4wNjgzQzExNC4xOSAyNi4wNSAxMTMuOTQ3IDI2LjAyMzkgMTEzLjcwNCAyNS45ODk5QzExMy40NzYgMjUuOTU1OCAxMTMuMjQ5IDI1LjkxNjYgMTEzLjAyNCAyNS44NjE3QzExMi40ODcgMjUuNzMzNSAxMTEuOTcyIDI1LjU1MDQgMTExLjUwNCAyNS4yNDk1QzExMS4wNDEgMjQuOTQ4NyAxMTAuNjQzIDI0LjU4MjQgMTEwLjMwNiAyNC4xNDU2QzExMC4wODkgMjMuODYwNCAxMDkuOTA1IDIzLjU1NDQgMTA5Ljc1MSAyMy4yM0MxMDkuNjY3IDIzLjA1MjEgMTA5LjU5NCAyMi44NzE2IDEwOS41MjkgMjIuNjg1OUMxMDkuNDkyIDIyLjU4OTEgMTA5LjQ2OSAyMi40ODcgMTA5LjQ0IDIyLjM4NzZDMTA5LjQwNiAyMi4yNjk5IDEwOS4zNzQgMjIuMTQ5NiAxMDkuMzQ2IDIyLjAzMTlDMTA5LjMzIDIxLjk3MTcgMTA5LjMyMiAyMS45MDg5IDEwOS4zMTIgMjEuODQ2MUMxMDkuMjk5IDIxLjc3MDMgMTA5LjI4MyAyMS42OTE4IDEwOS4yNyAyMS42MTU5QzEwOS4yNyAyMS42MTA3IDEwOS4yNjcgMjEuNjAyOCAxMDkuMjY1IDIxLjU5NzZDMTA5LjI1NCAyMS40OTMgMTA5LjI0MSAyMS4zODU3IDEwOS4yMzMgMjEuMjgxMUMxMDkuMjIzIDIxLjEwMzIgMTA5LjIxIDIwLjkyNTMgMTA5LjIxMiAyMC43NDc0QzEwOS4yMTIgMjAuNTk1NyAxMDkuMjI1IDIwLjQ0MzkgMTA5LjI0MSAyMC4yOTIyQzEwOS4yNTEgMjAuMTc3MSAxMDkuMjcgMjAuMDY0NiAxMDkuMjkzIDE5Ljk1MjFDMTA5LjMyIDE5LjgyNCAxMDkuMzU0IDE5LjY5NTggMTA5LjM4OCAxOS41Njc2QzEwOS40MTkgMTkuNDUyNSAxMDkuNDU4IDE5LjM0MjYgMTA5LjQ5NSAxOS4yMzAxQzEwOS41NTIgMTkuMDU0OCAxMDkuNjI4IDE4Ljg4NDggMTA5LjcxNSAxOC43MkMxMTAuMDI4IDE4LjExMDUgMTEwLjQ0NCAxNy41Nzk0IDExMC45NTcgMTcuMTI0MkMxMTEuMzg5IDE2LjczOTcgMTExLjg2NyAxNi40MzM2IDExMi4zOTkgMTYuMjA2QzExMi42NDIgMTYuMTAxNCAxMTIuODkzIDE2LjAxNzcgMTEzLjE1MiAxNS45NTc1QzExMy4zODUgMTUuOTA1MiAxMTMuNjIgMTUuODYwNyAxMTMuODU4IDE1LjgyOTNDMTE0LjE2NCAxNS43Nzk2IDExNC40NzYgMTUuNzY5MiAxMTQuNzg3IDE1Ljc3MThaTTExNi42NjUgMjEuMjUyM0MxMTYuNjYzIDIxLjI1MjMgMTE2LjY2IDIxLjI1MjMgMTE2LjY1NyAyMS4yNTIzQzExNi42NTcgMjEuMDE5NSAxMTYuNjYgMjAuNzg2NiAxMTYuNjU3IDIwLjU1MzhDMTE2LjY1NSAyMC4zNzU5IDExNi42MzkgMjAuMTk4IDExNi42MjkgMjAuMDIwMkMxMTYuNjI5IDIwLjAwOTcgMTE2LjYyNiAxOS45OTkyIDExNi42MjMgMTkuOTg4OEMxMTYuNjA4IDE5LjkwNSAxMTYuNTk1IDE5LjgyMTMgMTE2LjU3OSAxOS43NDAyQzExNi41NjEgMTkuNjQzNCAxMTYuNTQ4IDE5LjU0NCAxMTYuNTE5IDE5LjQ0NzJDMTE2LjQ3OSAxOS4zMDYgMTE2LjQzIDE5LjE2NzMgMTE2LjM3MiAxOS4wMzM5QzExNi4yNTIgMTguNzUxNCAxMTYuMDg3IDE4LjQ5NzYgMTE1Ljg3IDE4LjI3NzlDMTE1LjcwOCAxOC4xMTMxIDExNS41MjIgMTcuOTgyMyAxMTUuMzA4IDE3Ljg5ODZDMTE1LjA0NiAxNy43OTY2IDExNC43NzEgMTcuNzcwNCAxMTQuNDk0IDE3Ljc3M0MxMTQuNDI2IDE3Ljc3MyAxMTQuMzU1IDE3Ljc4MDkgMTE0LjI4NyAxNy43OTM5QzExNC4xNDMgMTcuODI1MyAxMTQuMDA3IDE3Ljg3NzcgMTEzLjg4NCAxNy45NTYxQzExMy41OTEgMTguMTQ0NSAxMTMuMzY2IDE4LjM5MyAxMTMuMjA3IDE4LjY5OTFDMTEzLjA4NCAxOC45MzE5IDExMi45OSAxOS4xNzc4IDExMi45NCAxOS40Mzk0QzExMi45MTQgMTkuNTcwMiAxMTIuODg1IDE5LjcwMzYgMTEyLjg2OSAxOS44MzQ0QzExMi44NTEgMjAuMDIwMiAxMTIuODMgMjAuMjA1OSAxMTIuODMzIDIwLjM5NDJDMTEyLjgzMyAyMC41MDQxIDExMi44MjUgMjAuNjExNCAxMTIuODIyIDIwLjcyMTJDMTEyLjgyIDIwLjgyODUgMTEyLjgxMiAyMC45MzU3IDExMi44MjIgMjEuMDQwNEMxMTIuODQzIDIxLjIyODcgMTEyLjgzMyAyMS40MTk3IDExMi44NTkgMjEuNjA4MUMxMTIuODc3IDIxLjczMzYgMTEyLjg5IDIxLjg2MTggMTEyLjkxNCAyMS45ODc0QzExMi45MzUgMjIuMTA3NyAxMTIuOTU4IDIyLjIyODEgMTEyLjk5NSAyMi4zNDg0QzExMy4wMzQgMjIuNDgxOCAxMTMuMDY2IDIyLjYxNTIgMTEzLjExIDIyLjc0NkMxMTMuMTYyIDIyLjkwMDQgMTEzLjIzIDIzLjA0OTUgMTEzLjMxNCAyMy4xOTA3QzExMy40MjcgMjMuMzc5MSAxMTMuNTYzIDIzLjU0OTEgMTEzLjc0NiAyMy42NzczQzExNC4xMiAyMy45MzM3IDExNC41MzYgMjQuMDYxOSAxMTQuOTg4IDI0LjA2OTdDMTE1LjE2NiAyNC4wNzIzIDExNS4zMzQgMjQuMDM1NyAxMTUuNDk4IDIzLjk3MjlDMTE1LjgxIDIzLjg1MjYgMTE2LjA1MyAyMy42NDU5IDExNi4yNDQgMjMuMzc2NUMxMTYuNDA0IDIzLjE1MTUgMTE2LjUgMjIuOTAwNCAxMTYuNTU4IDIyLjYzMDlDMTE2LjU2OCAyMi41ODEyIDExNi41ODIgMjIuNTI4OSAxMTYuNTg5IDIyLjQ3OTJDMTE2LjYwNSAyMi4zOTI5IDExNi42MjYgMjIuMzAzOSAxMTYuNjMxIDIyLjIxNUMxMTYuNjQyIDIxLjg5MzIgMTE2LjY1MiAyMS41NzQxIDExNi42NjUgMjEuMjUyM1oiIGZpbGw9IiMyNjI2MjYiLz4KPHBhdGggZD0iTTEyNi4zOTQgMTUuNzcxOEMxMjYuNjY2IDE1Ljc2MzkgMTI2LjkzNiAxNS43NzcgMTI3LjIwMyAxNS44MDU4QzEyNy40MDcgMTUuODI5MyAxMjcuNjExIDE1Ljg2MzMgMTI3LjgxNSAxNS45QzEyNy45NTEgMTUuOTIzNSAxMjguMDkgMTUuOTUyMyAxMjguMjIzIDE1Ljk4ODlDMTI4LjQ2NCAxNi4wNTQzIDEyOC42OTkgMTYuMTM4IDEyOC45MjcgMTYuMjRDMTI5LjM5NSAxNi40NDY3IDEyOS44MjQgMTYuNzE2MSAxMzAuMjA2IDE3LjA1MUMxMzAuNjAxIDE3LjM5NjMgMTMwLjkyOCAxNy43OTkyIDEzMS4xOTIgMTguMjU0NEMxMzEuMzIgMTguNDcxNSAxMzEuNDMgMTguNjk5MSAxMzEuNTI0IDE4LjkzMTlDMTMxLjU3OSAxOS4wNjUzIDEzMS42MjEgMTkuMjA0IDEzMS42NjMgMTkuMzQyNkMxMzEuNyAxOS40NTUxIDEzMS43MzEgMTkuNTcwMiAxMzEuNzYgMTkuNjg1M0MxMzEuNzc1IDE5Ljc0NTUgMTMxLjc4MyAxOS44MDgzIDEzMS43OTQgMTkuODcxQzEzMS44MDkgMTkuOTQ2OSAxMzEuODIzIDIwLjAyMjggMTMxLjgzOCAyMC4xMDEyQzEzMS44NDEgMjAuMTA5MSAxMzEuODQxIDIwLjExOTYgMTMxLjg0MyAyMC4xMjc0QzEzMS44NTEgMjAuMTk1NCAxMzEuODY0IDIwLjI2NjEgMTMxLjg2NyAyMC4zMzQxQzEzMS44NzIgMjAuNTY5NSAxMzEuOTA5IDIwLjgwMjMgMTMxLjg4IDIxLjAzNzhDMTMxLjg3NSAyMS4wNzk2IDEzMS44NzcgMjEuMTIxNSAxMzEuODc1IDIxLjE2MDdDMTMxLjg2NCAyMS4yOTE1IDEzMS44NTkgMjEuNDIyMyAxMzEuODQxIDIxLjU1MDVDMTMxLjgyNSAyMS42NzYxIDEzMS43OTYgMjEuNzk2NCAxMzEuNzczIDIxLjkyMkMxMzEuNzU1IDIyLjAxNjIgMTMxLjczNiAyMi4xMTI5IDEzMS43MTMgMjIuMjA3MUMxMzEuNjg0IDIyLjMxNDQgMTMxLjY1MyAyMi40MTkgMTMxLjYxNiAyMi41MjM3QzEzMS41NzQgMjIuNjQ5MiAxMzEuNTMgMjIuNzcyMiAxMzEuNDgyIDIyLjg5NTFDMTMxLjM3OCAyMy4xNjQ2IDEzMS4yNSAyMy40MjA5IDEzMS4wOTggMjMuNjY5NUMxMzAuNjE0IDI0LjQ1NDMgMTI5Ljk0NyAyNS4wMzUgMTI5LjExOCAyNS40M0MxMjguODMgMjUuNTY4NyAxMjguNTMyIDI1LjY4MTIgMTI4LjIyNiAyNS43Njc1QzEyOC4wMjIgMjUuODIyNCAxMjcuODE1IDI1Ljg3NzQgMTI3LjYwNiAyNS45MjE4QzEyNy40MzYgMjUuOTU4NSAxMjcuMjY1IDI1Ljk5MjUgMTI3LjA5MyAyNi4wMTZDMTI2Ljc0NSAyNi4wNjA1IDEyNi4zOTQgMjYuMDk0NSAxMjYuMDQ0IDI2LjA2ODNDMTI1Ljc5OCAyNi4wNSAxMjUuNTU1IDI2LjAyMzkgMTI1LjMxMSAyNS45ODk5QzEyNS4wODQgMjUuOTU1OCAxMjQuODU2IDI1LjkxNjYgMTI0LjYzMSAyNS44NjE3QzEyNC4wOTUgMjUuNzMzNSAxMjMuNTggMjUuNTUwNCAxMjMuMTExIDI1LjI0OTVDMTIyLjY0OCAyNC45NDg3IDEyMi4yNTEgMjQuNTgyNCAxMjEuOTEzIDI0LjE0NTZDMTIxLjY5NiAyMy44NjA0IDEyMS41MTMgMjMuNTU0NCAxMjEuMzU5IDIzLjIzQzEyMS4yNzUgMjMuMDUyMSAxMjEuMjAyIDIyLjg3MTYgMTIxLjEzNiAyMi42ODU5QzEyMS4xIDIyLjU4OTEgMTIxLjA3NiAyMi40ODcgMTIxLjA0NyAyMi4zODc2QzEyMS4wMTMgMjIuMjY5OSAxMjAuOTgyIDIyLjE0OTYgMTIwLjk1MyAyMi4wMzE5QzEyMC45MzcgMjEuOTcxNyAxMjAuOTMgMjEuOTA4OSAxMjAuOTE5IDIxLjg0NjFDMTIwLjkwNiAyMS43NzAzIDEyMC44OSAyMS42OTE4IDEyMC44NzcgMjEuNjE1OUMxMjAuODc3IDIxLjYxMDcgMTIwLjg3NSAyMS42MDI4IDEyMC44NzIgMjEuNTk3NkMxMjAuODYyIDIxLjQ5MyAxMjAuODQ4IDIxLjM4NTcgMTIwLjg0MSAyMS4yODExQzEyMC44MyAyMS4xMDMyIDEyMC44MTcgMjAuOTI1MyAxMjAuODIgMjAuNzQ3NEMxMjAuODIgMjAuNTk1NyAxMjAuODMzIDIwLjQ0MzkgMTIwLjg0OCAyMC4yOTIyQzEyMC44NTkgMjAuMTc3MSAxMjAuODc3IDIwLjA2NDYgMTIwLjkwMSAxOS45NTIxQzEyMC45MjcgMTkuODI0IDEyMC45NjEgMTkuNjk1OCAxMjAuOTk1IDE5LjU2NzZDMTIxLjAyNiAxOS40NTI1IDEyMS4wNjYgMTkuMzQyNiAxMjEuMTAyIDE5LjIzMDFDMTIxLjE2IDE5LjA1NDggMTIxLjIzNiAxOC44ODQ4IDEyMS4zMjIgMTguNzJDMTIxLjYzNiAxOC4xMTA1IDEyMi4wNTIgMTcuNTc5NCAxMjIuNTY1IDE3LjEyNDJDMTIyLjk5NiAxNi43Mzk3IDEyMy40NzUgMTYuNDMzNiAxMjQuMDA2IDE2LjIwNkMxMjQuMjQ5IDE2LjEwMTQgMTI0LjUgMTYuMDE3NyAxMjQuNzU5IDE1Ljk1NzVDMTI0Ljk5MiAxNS45MDUyIDEyNS4yMjggMTUuODYwNyAxMjUuNDY2IDE1LjgyOTNDMTI1Ljc3MiAxNS43Nzk2IDEyNi4wODMgMTUuNzY5MiAxMjYuMzk0IDE1Ljc3MThaTTEyOC4yNzMgMjEuMjUyM0MxMjguMjcgMjEuMjUyMyAxMjguMjY3IDIxLjI1MjMgMTI4LjI2NSAyMS4yNTIzQzEyOC4yNjUgMjEuMDE5NSAxMjguMjY3IDIwLjc4NjYgMTI4LjI2NSAyMC41NTM4QzEyOC4yNjIgMjAuMzc1OSAxMjguMjQ2IDIwLjE5OCAxMjguMjM2IDIwLjAyMDJDMTI4LjIzNiAyMC4wMDk3IDEyOC4yMzMgMTkuOTk5MiAxMjguMjMxIDE5Ljk4ODhDMTI4LjIxNSAxOS45MDUgMTI4LjIwMiAxOS44MjEzIDEyOC4xODYgMTkuNzQwMkMxMjguMTY4IDE5LjY0MzQgMTI4LjE1NSAxOS41NDQgMTI4LjEyNiAxOS40NDcyQzEyOC4wODcgMTkuMzA2IDEyOC4wMzcgMTkuMTY3MyAxMjcuOTggMTkuMDMzOUMxMjcuODU5IDE4Ljc1MTQgMTI3LjY5NSAxOC40OTc2IDEyNy40NzcgMTguMjc3OUMxMjcuMzE1IDE4LjExMzEgMTI3LjEyOSAxNy45ODIzIDEyNi45MTUgMTcuODk4NkMxMjYuNjUzIDE3Ljc5NjYgMTI2LjM3OSAxNy43NzA0IDEyNi4xMDEgMTcuNzczQzEyNi4wMzMgMTcuNzczIDEyNS45NjMgMTcuNzgwOSAxMjUuODk1IDE3Ljc5MzlDMTI1Ljc1MSAxNy44MjUzIDEyNS42MTUgMTcuODc3NyAxMjUuNDkyIDE3Ljk1NjFDMTI1LjE5OSAxOC4xNDQ1IDEyNC45NzQgMTguMzkzIDEyNC44MTQgMTguNjk5MUMxMjQuNjkxIDE4LjkzMTkgMTI0LjU5NyAxOS4xNzc4IDEyNC41NDcgMTkuNDM5NEMxMjQuNTIxIDE5LjU3MDIgMTI0LjQ5MyAxOS43MDM2IDEyNC40NzcgMTkuODM0NEMxMjQuNDU5IDIwLjAyMDIgMTI0LjQzOCAyMC4yMDU5IDEyNC40NCAyMC4zOTQyQzEyNC40NCAyMC41MDQxIDEyNC40MzIgMjAuNjExNCAxMjQuNDMgMjAuNzIxMkMxMjQuNDI3IDIwLjgyODUgMTI0LjQxOSAyMC45MzU3IDEyNC40MyAyMS4wNDA0QzEyNC40NTEgMjEuMjI4NyAxMjQuNDQgMjEuNDE5NyAxMjQuNDY2IDIxLjYwODFDMTI0LjQ4NSAyMS43MzM2IDEyNC40OTggMjEuODYxOCAxMjQuNTIxIDIxLjk4NzRDMTI0LjU0MiAyMi4xMDc3IDEyNC41NjYgMjIuMjI4MSAxMjQuNjAyIDIyLjM0ODRDMTI0LjY0MiAyMi40ODE4IDEyNC42NzMgMjIuNjE1MiAxMjQuNzE4IDIyLjc0NkMxMjQuNzcgMjIuOTAwNCAxMjQuODM4IDIzLjA0OTUgMTI0LjkyMiAyMy4xOTA3QzEyNS4wMzQgMjMuMzc5MSAxMjUuMTcgMjMuNTQ5MSAxMjUuMzUzIDIzLjY3NzNDMTI1LjcyNyAyMy45MzM3IDEyNi4xNDMgMjQuMDYxOSAxMjYuNTk2IDI0LjA2OTdDMTI2Ljc3NCAyNC4wNzIzIDEyNi45NDEgMjQuMDM1NyAxMjcuMTA2IDIzLjk3MjlDMTI3LjQxNyAyMy44NTI2IDEyNy42NjEgMjMuNjQ1OSAxMjcuODUxIDIzLjM3NjVDMTI4LjAxMSAyMy4xNTE1IDEyOC4xMDggMjIuOTAwNCAxMjguMTY1IDIyLjYzMDlDMTI4LjE3NiAyMi41ODEyIDEyOC4xODkgMjIuNTI4OSAxMjguMTk3IDIyLjQ3OTJDMTI4LjIxMiAyMi4zOTI5IDEyOC4yMzMgMjIuMzAzOSAxMjguMjM5IDIyLjIxNUMxMjguMjQ5IDIxLjg5MzIgMTI4LjI2IDIxLjU3NDEgMTI4LjI3MyAyMS4yNTIzWiIgZmlsbD0iIzI2MjYyNiIvPgo8cGF0aCBkPSJNMTMyLjEwOCAyNS43MjY0QzEzMi4yMjkgMjUuNjE5OSAxMzIuMzM1IDI1LjUxMzQgMTMyLjQ0MiAyNS4zOTM2QzEzMi41NjIgMjUuMjYwNSAxMzIuNjU2IDI1LjExNCAxMzIuNzM2IDI0Ljk1NDNDMTMyLjgwMyAyNC44MjEyIDEzMi44NDMgMjQuNjYxNSAxMzIuODY5IDI0LjUxNUMxMzIuOTEgMjQuMjYyMSAxMzIuOTEgMjQuMDA5MiAxMzIuOTEgMjMuNzQzQzEzMi45MSAyMi40Nzg0IDEzMi45MSAyMS4yMjcxIDEzMi45MSAxOS45NjI2QzEzMi45MSAxOS40NTY4IDEzMi44OTYgMTguOTUwOSAxMzIuOTEgMTguNDQ1MUMxMzIuOTEgMTguMTc4OSAxMzIuOTIzIDE3LjkxMjYgMTMyLjg5NiAxNy42NDY0QzEzMi44ODMgMTcuNDA2OCAxMzIuODQzIDE3LjE2NzIgMTMyLjc0OSAxNi45NTQyQzEzMi42NTYgMTYuNzU0NiAxMzIuNTA5IDE2LjU2ODIgMTMyLjM3NSAxNi4zOTUyQzEzMi4yOTUgMTYuMjg4NyAxMzIuMjE1IDE2LjE5NTUgMTMyLjEzNSAxNi4xMDIzQzEzMi4zMjIgMTYuMTAyMyAxMzIuNTIyIDE2LjExNTYgMTMyLjcwOSAxNi4xMTU2QzEzMy4xNjMgMTYuMTI4OSAxMzMuNjA0IDE2LjEyODkgMTM0LjA1OCAxNi4xMjg5QzEzNC40NTggMTYuMTI4OSAxMzQuODU5IDE2LjExNTYgMTM1LjI1OSAxNi4wNzU3QzEzNS40NzMgMTYuMDYyNCAxMzUuNjg3IDE2LjAzNTggMTM1LjkgMTUuOTgyNUMxMzYuMTI3IDE1LjkyOTMgMTM2LjM1NCAxNS44NjI3IDEzNi41ODEgMTUuNzY5NUMxMzYuNTgxIDE2LjE0MjIgMTM2LjU4MSAxNi41MTUgMTM2LjU4MSAxNi44NzQ0QzEzNi42MjEgMTYuODg3NyAxMzYuNjQ4IDE2Ljg4NzcgMTM2LjY4OCAxNi44NzQ0QzEzNi43MjggMTYuODYxMSAxMzYuNzY4IDE2LjgzNDQgMTM2LjgwOCAxNi44MDc4QzEzNi45OTUgMTYuNjYxNCAxMzcuMTQyIDE2LjQ3NSAxMzcuMzE2IDE2LjM0MTlDMTM3LjUyOSAxNi4xNjg5IDEzNy43OTYgMTYuMDQ5MSAxMzguMDYzIDE1Ljk2OTJDMTM4LjQxMSAxNS44NjI3IDEzOC43NTggMTUuODIyOCAxMzkuMTMyIDE1LjgyMjhDMTM5LjU5OSAxNS44MjI4IDE0MC4wOCAxNS44NzYgMTQwLjQ1MyAxNi4wNDkxQzE0MC42NCAxNi4xNDIyIDE0MC44MDEgMTYuMjYyMSAxNDAuOTg3IDE2LjQyMThDMTQxLjE4OCAxNi41OTQ4IDE0MS40NDEgMTYuODA3OCAxNDEuNjQyIDE2Ljk2NzVDMTQxLjgyOSAxNi43OTQ1IDE0Mi4wMjkgMTYuNjM0OCAxNDIuMjQzIDE2LjUwMTdDMTQyLjYwMyAxNi4yNzU0IDE0Mi45OSAxNi4xMDIzIDE0My40MDQgMTYuMDA5MUMxNDMuNzc4IDE1LjkxNiAxNDQuMTY1IDE1Ljg2MjcgMTQ0LjU1MiAxNS44NjI3QzE0NC45NjYgMTUuODQ5NCAxNDUuMzk0IDE1Ljg4OTMgMTQ1LjgwOCAxNS45ODI1QzE0Ni4zNTUgMTYuMTE1NiAxNDYuODc2IDE2LjM1NTIgMTQ3LjMwMyAxNi43MTQ2QzE0Ny41NTcgMTYuOTE0MyAxNDcuNzcgMTcuMTUzOSAxNDcuOTQ0IDE3LjQyMDFDMTQ4LjExNyAxNy42ODY0IDE0OC4yMzggMTcuOTkyNSAxNDguMjkxIDE4LjMxMkMxNDguMzMxIDE4LjU2NDkgMTQ4LjMzMSAxOC44MzExIDE0OC4zMzEgMTkuMDg0QzE0OC4zMzEgMTkuODQyOCAxNDguMzMxIDIwLjU4ODIgMTQ4LjMzMSAyMS4zMzM2QzE0OC4zMzEgMjEuNjUzMSAxNDguMzMxIDIxLjk3MjYgMTQ4LjMzMSAyMi4zMDU0QzE0OC4zMzEgMjIuNjM4MSAxNDguMzMxIDIyLjk1NzYgMTQ4LjMzMSAyMy4yOTA0QzE0OC4zMzEgMjMuNTU2NiAxNDguMzMxIDIzLjgwOTUgMTQ4LjMzMSAyNC4wNzU4QzE0OC4zMzEgMjQuMzE1NCAxNDguMzQ0IDI0LjU2ODMgMTQ4LjQxMSAyNC43OTQ2QzE0OC40NzggMjUuMDA3NiAxNDguNjI1IDI1LjIwNzIgMTQ4Ljc1OCAyNS4zOTM2QzE0OC44MzggMjUuNTAwMSAxNDguOTMyIDI1LjYwNjYgMTQ5LjA5MiAyNS43Mzk3QzE0Ny4zNTYgMjUuNzM5NyAxNDUuNjIxIDI1LjczOTcgMTQzLjg3MiAyNS43Mzk3QzE0My45OTIgMjUuNjE5OSAxNDQuMDk4IDI1LjUwMDEgMTQ0LjIwNSAyNS4zODAzQzE0NC4zMTIgMjUuMjQ3MiAxNDQuNDA2IDI1LjEyNzQgMTQ0LjQ3MiAyNC45ODA5QzE0NC41MzkgMjQuODQ3OCAxNDQuNTY2IDI0LjY4ODEgMTQ0LjU5MyAyNC41MjgzQzE0NC42MDYgMjQuNDM1MiAxNDQuNjE5IDI0LjMyODcgMTQ0LjYxOSAyNC4yMzU1QzE0NC42MTkgMjQuMTQyMyAxNDQuNjE5IDI0LjA0OTEgMTQ0LjYxOSAyMy45NTZDMTQ0LjYwNiAyMy4xNDQgMTQ0LjYxOSAyMi4zMTg3IDE0NC42MTkgMjEuNTA2N0MxNDQuNjE5IDIxLjE0NzMgMTQ0LjYxOSAyMC44MDEyIDE0NC42MTkgMjAuNDQxOEMxNDQuNjE5IDIwLjA4MjQgMTQ0LjYzMyAxOS43MDk3IDE0NC42MTkgMTkuMzUwM0MxNDQuNjE5IDE5LjIxNzIgMTQ0LjYwNiAxOS4wOTczIDE0NC41OTMgMTguOTc3NUMxNDQuNTY2IDE4LjgxNzggMTQ0LjQ4NiAxOC42NTgxIDE0NC4zOTIgMTguNTI1QzE0NC4yODUgMTguMzc4NSAxNDQuMTUyIDE4LjI1ODcgMTQ0LjAwNSAxOC4xNzg5QzE0My44NDUgMTguMDk5IDE0My42NDUgMTguMDU5MSAxNDMuNDcxIDE4LjA3MjRDMTQzLjIzMSAxOC4wODU3IDE0My4wMDQgMTguMTkyMiAxNDIuODQzIDE4LjM1MTlDMTQyLjY5NyAxOC40OTgzIDE0Mi41OSAxOC42ODQ3IDE0Mi41MzYgMTguODg0NEMxNDIuNDk2IDE5LjA0NDEgMTQyLjQ5NiAxOS4yMDM4IDE0Mi40OTYgMTkuMzYzNkMxNDIuNDk2IDE5LjUxIDE0Mi40OTYgMTkuNjQzMSAxNDIuNDk2IDE5Ljc4OTVDMTQyLjQ5NiAyMC4xNzU2IDE0Mi40OTYgMjAuNTc0OSAxNDIuNDk2IDIwLjk2MDlDMTQyLjQ5NiAyMS45NDYgMTQyLjUxIDIyLjkzMSAxNDIuNDk2IDIzLjkwMjdDMTQyLjQ5NiAyNC4wMzU4IDE0Mi40OTYgMjQuMTgyMyAxNDIuNDk2IDI0LjMxNTRDMTQyLjUxIDI0LjUwMTcgMTQyLjUyMyAyNC43MDE0IDE0Mi42MDMgMjQuODc0NEMxNDIuNjgzIDI1LjA3NDEgMTQyLjgxNyAyNS4yNDcyIDE0Mi45NjQgMjUuNDIwMkMxNDMuMDU3IDI1LjU0IDE0My4xNjQgMjUuNjQ2NSAxNDMuMjcxIDI1Ljc1M0MxNDEuNTIyIDI1Ljc1MyAxMzkuNzg2IDI1Ljc1MyAxMzguMDM3IDI1Ljc1M0MxMzguMTU3IDI1LjYzMzIgMTM4LjI2NCAyNS41MTM0IDEzOC4zNyAyNS4zOTM2QzEzOC40NzcgMjUuMjYwNSAxMzguNTcxIDI1LjE0MDcgMTM4LjYzOCAyNC45OTQyQzEzOC43MDQgMjQuODYxMSAxMzguNzMxIDI0LjcwMTQgMTM4Ljc1OCAyNC41NDE3QzEzOC43NzEgMjQuNDQ4NSAxMzguNzg0IDI0LjM0MiAxMzguNzg0IDI0LjI0ODhDMTM4Ljc4NCAyNC4xNTU2IDEzOC43ODQgMjQuMDYyNCAxMzguNzg0IDIzLjk2OTNDMTM4Ljc3MSAyMy4xNTczIDEzOC43ODQgMjIuMzMyIDEzOC43ODQgMjEuNTJDMTM4Ljc4NCAyMS4xNjA2IDEzOC43ODQgMjAuODE0NSAxMzguNzg0IDIwLjQ1NTFDMTM4Ljc4NCAyMC4wOTU3IDEzOC43OTggMTkuNzIzIDEzOC43ODQgMTkuMzYzNkMxMzguNzg0IDE5LjIzMDUgMTM4Ljc3MSAxOS4xMTA3IDEzOC43NTggMTguOTkwOUMxMzguNzMxIDE4LjgzMTEgMTM4LjY1MSAxOC42NzE0IDEzOC41NTcgMTguNTM4M0MxMzguNDUxIDE4LjM5MTkgMTM4LjMxNyAxOC4yNzIxIDEzOC4xNyAxOC4xOTIyQzEzOC4wMSAxOC4xMTIzIDEzNy44MSAxOC4wNzI0IDEzNy42MzYgMTguMDg1N0MxMzcuMzk2IDE4LjA5OSAxMzcuMTY5IDE4LjIwNTUgMTM3LjAwOSAxOC4zNjUyQzEzNi44NjIgMTguNTExNyAxMzYuNzU1IDE4LjY5OCAxMzYuNzAxIDE4Ljg5NzdDMTM2LjY2MSAxOS4wNTc0IDEzNi42NjEgMTkuMjE3MSAxMzYuNjYxIDE5LjM3NjlDMTM2LjY2MSAxOS41MjMzIDEzNi42NjEgMTkuNjU2NCAxMzYuNjYxIDE5LjgwMjhDMTM2LjY2MSAyMC4xODg5IDEzNi42NjEgMjAuNTg4MiAxMzYuNjYxIDIwLjk3NDJDMTM2LjY2MSAyMS45NTkzIDEzNi42NzUgMjIuOTQ0MyAxMzYuNjYxIDIzLjkxNkMxMzYuNjYxIDI0LjA0OTEgMTM2LjY2MSAyNC4xOTU2IDEzNi42NjEgMjQuMzI4N0MxMzYuNjc1IDI0LjUxNSAxMzYuNjg4IDI0LjcxNDcgMTM2Ljc2OCAyNC44ODc3QzEzNi44NDggMjUuMDg3NCAxMzYuOTgyIDI1LjI2MDUgMTM3LjEyOSAyNS40MzM1QzEzNy4yMjIgMjUuNTUzMyAxMzcuMzI5IDI1LjY1OTggMTM3LjQzNiAyNS43NjYzQzEzNS42MDcgMjUuNzI2NCAxMzMuODU4IDI1LjcyNjQgMTMyLjEwOCAyNS43MjY0WiIgZmlsbD0iIzI2MjYyNiIvPgo8L3N2Zz4='.replace('data:image/svg+xml;base64,',''), 'base64');
    res.writeHead(200, {'Content-Type':'image/svg+xml','Cache-Control':'public,max-age=86400'});
    res.end(buf); return;
  }

    // ── Shipping Dashboard ──────────────────────────────────────────
  if (pathname === '/shipping') {
    if (!isAuth(req)) { res.writeHead(302, {Location: '/deals'}); res.end(); return; }
    try {
      const html = fs.readFileSync(path.join(__dirname, 'shipping-dashboard.html'), 'utf8');
      res.writeHead(200, {'Content-Type':'text/html'});
      res.end(html);
    } catch(e) {
      res.writeHead(500); res.end('shipping-dashboard.html not found');
    }
    return;
  }

  // ── Live Tracking Status ─────────────────────────────────────────
  if (pathname === '/api/track' && req.method === 'GET') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    const carrier  = parsed.query.carrier  || '';
    const tracking = parsed.query.tracking || '';
    if (!tracking) { json({ error: 'No tracking number' }, 400); return; }

    try {
      // Serve from cache first — no AfterShip call on page load
      const cached = await getTrackingFromCache(tracking);
      if (cached) {
        json({
          status:        cached.status,
          label:         cached.label,
          location:      cached.location,
          lastEvent:     cached.last_event,
          lastEventTime: cached.last_event_time,
          eta:           cached.eta,
          deliveredAt:   cached.delivered_at,
          signedBy:      cached.signed_by,
          fromCache:     true,
        });
        return;
      }

      // Not in cache yet — fetch directly (first time only)
      const result = await fetchAndCacheTracking(tracking, carrier);
      if (result) {
        json(result);
      } else {
        json({ status: 'pending', label: 'Registered', location: null, eta: null });
      }
    } catch(e) {
      console.warn('Track route error:', e.message);
      json({ status: null, label: null, error: e.message });
    }
    return;
  }


  // ── Shipping Board API ───────────────────────────────────────────
  // Force refresh a specific tracking number in the cache
  if (pathname === '/api/shipping/refresh-tracking' && req.method === 'POST') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    try {
      const body = JSON.parse(await readBody(req));
      const { tracking, carrier } = body;
      if (!tracking) { json({ error: 'tracking required' }, 400); return; }
      // Delete from cache to force fresh fetch
      await db.query('DELETE FROM tracking_cache WHERE tracking_number = $1', [tracking]);
      const result = await fetchAndCacheTracking(tracking, carrier || '');
      json({ success: true, tracking, result });
    } catch(e) { writelog('error','error.refresh-tracking',`refresh-tracking failed: ${e.message}`,{ rep: getRepFromReq(req) }); json({ error: e.message }, 500); }
    return;
  }

  // Debug: test OD API raw response
  if (pathname === '/api/debug/od-tracking' && req.method === 'GET') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    const trackingNum = parsed.query.pro || '78078713803';
    const OD_USER = process.env.OD_USER || '';
    const OD_PASS = process.env.OD_PASS || '';
    try {
      const authRes = await httpsRequest({
        hostname: 'api.odfl.com',
        path: '/auth/v1.0/token',
        method: 'GET',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${OD_USER}:${OD_PASS}`).toString('base64'),
          'Accept': 'application/json',
        }
      });
      const token = authRes.body?.access_token || authRes.body?.sessionToken || authRes.body?.token;
      if (!token) { json({ error: 'auth failed', authStatus: authRes.status, authBody: authRes.body }); return; }
      const trackRes = await httpsRequest({
        hostname: 'api.odfl.com',
        path: '/tracking/v2.0/shipment.track',
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' }
      }, { referenceType: 'PRO', referenceNumber: trackingNum });
      json({ authStatus: authRes.status, trackStatus: trackRes.status, trackBody: trackRes.body });
    } catch(e) { json({ error: e.message }); }
    return;
  }

  // Debug: dump tracking cache
  if (pathname === '/api/debug/tracking-cache' && req.method === 'GET') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    try {
      const rows = await db.query('SELECT tracking_number, slug, status, label, eta, last_event, updated_at FROM tracking_cache ORDER BY updated_at DESC');
      json({ count: rows.rows.length, rows: rows.rows });
    } catch(e) { json({ error: e.message }, 500); }
    return;
  }

  if (pathname === '/api/shipping-board' && req.method === 'GET') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    try {
      // Fetch shipped deals with tracking from HubSpot
      const searchRes = await httpsRequest({
        hostname: 'api.hubapi.com',
        path: '/crm/v3/objects/deals/search',
        method: 'POST',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
      }, {
        // OR across 4 scenarios: any Shipped-stage deal in last 30 days, whether it
        // has tracking/carrier set or not, using either date_shipped or closedate.
        // This ensures deals show up on the board even if Jeromy hasn't filled in
        // carrier/tracking yet — they'll show as "No tracking" rows.
        filterGroups: [
          {
            // All shipped deals — no date filter, just stage
            filters: [
              { propertyName: 'dealstage', operator: 'EQ', value: '845719' }
            ]
          }
        ],
        properties: ['dealname','amount','freight_carrier','tracking_number','date_shipped','hubspot_owner_id',
                     'shipping_address','shipping_city','shipping_state','shipping_zipcode','closedate'],
        sorts: [{ propertyName: 'date_shipped', direction: 'DESCENDING' }],
        limit: 100
      });

      // Keep all shipped deals — those without carrier/tracking show as "No tracking" rows
      const deals = searchRes.body.results || [];

      // Map owner IDs to names
      const ownerMap = {
        '36303670': 'Benton White',
        '36320208': 'Gabe White',
        '36330944': 'Jill Holdway',
        '38143901': 'Sarah Smith',
        '38732178': 'Kim Dalton',
        '38732186': 'Jeromy Packwood',
        '38900892': 'Chet Burgess',
        '117442978': 'Travis Singleton',
      };

      // Batch fetch tracking cache for all tracking numbers
      const trackingNumbers = deals.map(d => d.properties.tracking_number).filter(Boolean);
      const cacheMap = {};
      if (db && trackingNumbers.length) {
        try {
          const placeholders = trackingNumbers.map((_, i) => `$${i+1}`).join(',');
          const cacheRows = await db.query(
            `SELECT * FROM tracking_cache WHERE tracking_number IN (${placeholders})`,
            trackingNumbers
          );
          cacheRows.rows.forEach(r => { cacheMap[r.tracking_number] = r; });
        } catch(e) { console.warn('tracking cache batch fetch error:', e.message); }
      }

      const results = deals.map(d => {
        const p = d.properties;
        const carrier = p.freight_carrier || '';
        const tracking = p.tracking_number || '';
        let trackingUrl = '';
        if (carrier === 'ABF')  trackingUrl = `https://view.arcb.com/nlo/tools/tracking/${tracking}`;
        if (carrier === 'OD')   trackingUrl = `https://www.odfl.com/us/en/tools/trace-track-ltl-freight.html?pro=${tracking}`;
        if (carrier === 'UPS')  trackingUrl = `https://www.ups.com/track?tracknum=${tracking}`;
        if (carrier === 'FedEx') trackingUrl = `https://www.fedex.com/en-us/tracking.html?tracknumbers=${tracking}`;
        if (carrier === 'USPS') trackingUrl = `https://tools.usps.com/go/TrackConfirmAction?tLabels=${tracking}`;

        const cache = cacheMap[tracking] || null;

        const dateShipped = p.date_shipped || p.closedate?.split('T')[0] || null;

        // Sanity check: AfterShip sometimes returns 'delivered' immediately on new registrations
        // If shipped within last 2 days and AfterShip says delivered with no delivered_at, treat as pending
        let trackStatus = cache?.status || (tracking ? 'pending' : null);
        let trackLabel  = cache?.label  || (tracking ? 'Pending' : 'No Tracking');
        if (trackStatus === 'delivered' && !cache?.delivered_at && dateShipped) {
          const daysSinceShip = (Date.now() - new Date(dateShipped).getTime()) / 86400000;
          if (daysSinceShip < 3) {
            trackStatus = 'in_transit';
            trackLabel  = 'In Transit';
          }
        }

        return {
          dealId:      d.id,
          dealName:    p.dealname,
          amount:      p.amount ? parseFloat(p.amount) : null,
          carrier,
          tracking,
          trackingUrl,
          dateShipped,
          city:        p.shipping_city  || cache?.dest_city  || '',
          state:       p.shipping_state || cache?.dest_state || '',
          zip:         p.shipping_zipcode || '',
          address:     [p.shipping_address, p.shipping_city, p.shipping_state, p.shipping_zipcode].filter(Boolean).join(', '),
          rep:         ownerMap[p.hubspot_owner_id] || 'Unknown',
          dealUrl:     `https://app.hubspot.com/contacts/5764220/deal/${d.id}`,
          // AfterShip tracking data from cache
          trackStatus,
          trackLabel,
          trackLastEvent: cache?.last_event || null,
          trackLastTime:  cache?.last_event_time || null,
          trackEta:       cache?.eta        || null,
          trackLocation:  cache?.location   || null,
          trackDelivered: cache?.delivered_at || null,
          trackUpdated:   cache?.updated_at  || null,
        };
      });

      // Also trigger background refresh for any tracking numbers not yet in cache
      const uncached = deals.filter(d => d.properties.tracking_number && !cacheMap[d.properties.tracking_number]);
      if (uncached.length > 0) {
        (async () => {
          for (const d of uncached.slice(0, 5)) { // max 5 at a time
            try {
              await fetchAndCacheTracking(d.properties.tracking_number, d.properties.freight_carrier);
              await new Promise(r => setTimeout(r, 1000));
            } catch(e) { /* silent */ }
          }
        })();
      }

      // For ABF shipments missing ETA, fetch transit times in background
      const ARCBEST_KEY = process.env.ARCBEST_API_KEY || '';
      if (ARCBEST_KEY) {
        const needEta = results.filter(r => r.carrier === 'ABF' && !r.trackEta && r.zip && r.trackStatus !== 'delivered');
        if (needEta.length > 0) {
          (async () => {
            for (const s of needEta.slice(0, 10)) {
              try {
                const tt = await fetchABFTransitDays(s.zip, s.dateShipped, ARCBEST_KEY);
                if (tt?.eta) {
                  await db.query(
                    'UPDATE tracking_cache SET eta = $1, updated_at = NOW() WHERE tracking_number = $2',
                    [tt.eta, s.tracking]
                  );
                  console.log(`[ABF transit] ${s.tracking} → ETA ${tt.eta} (${tt.transitDays} days)`);
                }
              } catch(e) { /* silent */ }
              await new Promise(r => setTimeout(r, 500));
            }
          })();
        }
      }

      json({ success: true, shipments: results, total: results.length });
    } catch(e) { json({ error: e.message }, 500); }
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    // Redirect to Deal Hub as default landing page
    res.writeHead(302, { Location: '/deals' });
    res.end();
    return;
  }

  if (pathname === '/quotes' || pathname === '/quote-builder') {
    if (!isAuth(req)) { res.writeHead(302, { Location: '/deals' }); res.end(); return; }
    try {
      const html = fs.readFileSync(MAIN_HTML_PATH, 'utf8');
      res.writeHead(200, {'Content-Type':'text/html'});
      res.end(html);
    } catch(e) {
      res.writeHead(500); res.end('quote-builder.html not found');
    }
    return;
  }

  // ── API: Search products ──
  if (pathname === '/api/products' && req.method === 'GET') {
    try {
      const q      = parsed.query.q || '';
      const offset = parseInt(parsed.query.after || '0');
      const data   = await hsSearchProducts(q, 100, offset);
      json(data);
    } catch(e) { json({error: e.message}, 500); }
    return;
  }

  // ── API: Version ────────────────────────────────────────────────
  if (pathname === '/api/version' && req.method === 'GET') {
    json({ version: APP_VERSION }); return;
  }


  if (pathname === '/api/products-all' && req.method === 'GET') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    try {
      const products = await getProductsCached();
      json({ results: products, total: products.length });
    } catch(e) { json({ error: e.message }, 500); }
    return;
  }

  // ── API: Search contacts ──
  if (pathname === '/api/contacts' && req.method === 'GET') {
    try {
      const q = parsed.query.q || '';
      if (q.length < 2) { json({ results: [] }); return; }
      const data = await hsSearchContacts(q);
      json(data);
    } catch(e) { json({error: e.message}, 500); }
    return;
  }

  // ── API: Get quote history ──
  if (pathname === '/api/history' && req.method === 'GET') {
    try {
      const q = parsed.query.q || '';
      const repId = parsed.query.rep || '';
      const limit = Math.min(parseInt(parsed.query.limit || '100'), 200);
      const offset = parseInt(parsed.query.offset || '0');

      // Try DB first, fall back to HubSpot Notes
      const dbResults = await searchQuotesInDb(q, repId, limit, offset);
      if (dbResults) {
        json({ results: dbResults.results.map(r => r.json_snapshot), total: dbResults.total, source: 'db' });
      } else {
        const history = await fetchQuoteHistory();
        json({ results: history, source: 'hubspot' });
      }
    } catch(e) { json({error: e.message}, 500); }
    return;
  }

  // ── API: Save quote to history (DB only) ─────────────────────────
  if (pathname === '/api/history' && req.method === 'POST') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    try {
      const body = JSON.parse(await readBody(req));
      await saveQuoteToDb(body);
      json({ success: true });
    } catch(e) { json({error: e.message}, 500); }
    return;
  }

  // ── API: Get deals associated with a contact ──────────────────
  if (pathname.startsWith('/api/contact-deals/') && req.method === 'GET') {
    try {
      const contactId = pathname.replace('/api/contact-deals/', '').trim();
      if (!contactId) { json({ deals: [] }); return; }

      // Step 1: Get deal IDs via associations endpoint
      // NOTE: The search API's associations.contact filter is not supported —
      // must use the dedicated associations endpoint instead.
      const assocRes = await httpsRequest({
        hostname: 'api.hubapi.com',
        path: `/crm/v3/objects/contacts/${contactId}/associations/deals`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
      });

      const dealIds = (assocRes.body?.results || []).map(r => r.id);
      if (!dealIds.length) { json({ deals: [] }); return; }

      // Step 2: Batch fetch deal details (cap at 10 most-recent by ID descending)
      const batchRes = await httpsRequest({
        hostname: 'api.hubapi.com',
        path: '/crm/v3/objects/deals/batch/read',
        method: 'POST',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
      }, {
        inputs: dealIds.slice(0, 10).map(id => ({ id })),
        properties: ['dealname', 'amount', 'dealstage', 'hubspot_owner_id', 'hs_lastmodifieddate', 'closedate']
      });

      const deals = (batchRes.body?.results || [])
        .sort((a, b) => new Date(b.properties.hs_lastmodifieddate || 0) - new Date(a.properties.hs_lastmodifieddate || 0))
        .map(d => ({
          id: d.id,
          name: d.properties.dealname || 'Untitled Deal',
          amount: d.properties.amount || null,
          stage: d.properties.dealstage || null,
          ownerId: d.properties.hubspot_owner_id || null,
          modified: d.properties.hs_lastmodifieddate || null,
        }));

      json({ deals });
    } catch(e) { json({ deals: [], error: e.message }); }
    return;
  }

  // ── API: Get deal with contact details ──
  if (pathname.startsWith('/api/deal/') && req.method === 'GET') {
    try {
      const dealId = pathname.split('/api/deal/')[1];
      const data = await hsGetDealWithDetails(dealId);
      json(data || { error: 'Deal not found' });
    } catch(e) { json({error: e.message}, 500); }
    return;
  }

  // ── API: Search deals ──
  if (pathname === '/api/deals' && req.method === 'GET') {
    try {
      const q = parsed.query.q || '';
      if (q.length < 2) { json({ results: [] }); return; }
      const data = await hsSearchDeals(q);
      json(data);
    } catch(e) { json({error: e.message}, 500); }
    return;
  }

  // ── API: List all deals for deals dashboard ───────────────────────
  if (pathname === '/api/deals/list' && req.method === 'GET') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    try {
      const q     = parsed.query.q     || '';
      const stage = parsed.query.stage || '';
      const rep   = parsed.query.rep   || '';
      const limit = Math.min(parseInt(parsed.query.limit) || 200, 200);

      const filters = [];
      if (stage) filters.push({ propertyName: 'dealstage', operator: 'EQ', value: stage });
      if (rep)   filters.push({ propertyName: 'hubspot_owner_id', operator: 'EQ', value: rep });

      const searchBody = {
        filterGroups: filters.length ? [{ filters }] : [],
        properties: ['dealname','dealstage','amount','hubspot_owner_id','hs_lastmodifieddate',
                     'closedate','payment_status','tracking_number','carrier__c',
                     'hs_contact_id','phone','email'],
        sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
        limit,
      };
      if (q) searchBody.query = q;

      const res2 = await httpsRequest({
        hostname: 'api.hubapi.com',
        path: '/crm/v3/objects/deals/search',
        method: 'POST',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
      }, searchBody);

      const deals = (res2.body?.results || []).map(d => ({
        id:            d.id,
        name:          d.properties?.dealname || '—',
        stage:         d.properties?.dealstage || '',
        amount:        d.properties?.amount || '0',
        ownerId:       d.properties?.hubspot_owner_id || '',
        modified:      d.properties?.hs_lastmodifieddate || '',
        paymentStatus: d.properties?.payment_status || 'not_paid',
        tracking:      d.properties?.tracking_number || '',
        carrier:       d.properties?.carrier__c || '',
      }));

      // Enrich with DB quote data (latest quote number, accepted status)
      if (db && deals.length) {
        const ids = deals.map(d => d.id);
        const dbRes = await db.query(
          `SELECT deal_id, quote_number, total,
                  (json_snapshot->>'accepted')::text as accepted,
                  json_snapshot->'lineItems' as line_items
           FROM quotes
           WHERE deal_id = ANY($1)
           ORDER BY created_at DESC`,
          [ids]
        );
        // Group by deal_id — first row = latest quote, but check ALL rows for accepted status
        const byDeal = {};
        dbRes.rows.forEach(r => {
          if (!byDeal[r.deal_id]) {
            let firstMdl = '';
            try {
              const items = r.line_items || [];
              // Strict MDL-only match — ignore accessories with 4-digit codes
              const mdlItem = items.find(i => /^MDL\b/.test(i?.name||''));
              if (mdlItem) firstMdl = (mdlItem.name||'').split(' ').slice(0,3).join(' ');
            } catch(e) {}
            byDeal[r.deal_id] = {
              latestQuote: r.quote_number,
              total: r.total,
              accepted: r.accepted === 'true',
              firstMdl,
            };
          } else if (r.accepted === 'true') {
            // Any quote for this deal being accepted marks the deal as accepted
            byDeal[r.deal_id].accepted = true;
          }
        });
        deals.forEach(d => {
          if (byDeal[d.id]) Object.assign(d, byDeal[d.id]);
        });
      }

      // Auto-sync: for any unpaid deals, check if their HubSpot invoice is actually paid
      // Run in background — don't block the response
      (async () => {
        try {
          const unpaidDeals = deals.filter(d => d.paymentStatus !== 'paid' && d.latestQuote);
          if (!unpaidDeals.length) return;
          // Batch fetch invoice associations for unpaid deals
          const assocRes = await httpsRequest({
            hostname: 'api.hubapi.com',
            path: '/crm/v4/associations/deals/invoices/batch/read',
            method: 'POST',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
          }, { inputs: unpaidDeals.map(d => ({ id: String(d.id) })) });
          const assocResults = assocRes.body?.results || [];
          const invoiceIds = [];
          const dealByInvoice = {};
          assocResults.forEach(r => {
            (r.to || []).forEach(t => {
              invoiceIds.push(t.toObjectId);
              dealByInvoice[t.toObjectId] = r.from?.id;
            });
          });
          if (!invoiceIds.length) return;
          // Fetch invoice statuses
          const batchRes = await httpsRequest({
            hostname: 'api.hubapi.com',
            path: '/crm/v3/objects/invoices/batch/read',
            method: 'POST',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
          }, { inputs: invoiceIds.map(id => ({ id: String(id) })), properties: ['hs_invoice_status'] });
          const paidInvoices = (batchRes.body?.results || []).filter(inv => inv.properties?.hs_invoice_status === 'paid');
          for (const inv of paidInvoices) {
            const dId = dealByInvoice[inv.id];
            if (!dId) continue;
            // Update deal in HubSpot
            await httpsRequest({
              hostname: 'api.hubapi.com',
              path: `/crm/v3/objects/deals/${dId}`,
              method: 'PATCH',
              headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
            }, { properties: { payment_status: 'paid' } });
            console.log(`[deals list] auto-synced payment_status=paid for deal ${dId}`);
          }
        } catch(e) { console.warn('[deals list] auto-sync error:', e.message); }
      })();

      json({ deals, total: res2.body?.total || deals.length });
    } catch(e) {
      console.error('Deals list error:', e.message);
      json({ error: e.message }, 500);
    }
    return;
  }



  // ── API: Get freight quote ──
  if (pathname === '/api/freight' && req.method === 'POST') {
    let body = {};
    try {
      body = JSON.parse(await readBody(req));
      const { pallets, totalWeight, city, state: rawFreightState, zip, canadian, accessories } = body;
      const state = toStateAbbr(rawFreightState);
      const abfUrl = buildAbfUrl(pallets, totalWeight, city, state, zip, canadian, accessories || {});
      console.log(`[freight] URL: ${abfUrl}`);
      const res2 = await httpsGet(abfUrl);
      console.log(`[freight] ABF response: ${res2.body?.slice(0, 500)}`);
      const result = parseAbfXml(res2.body);
      console.log(`[freight] parsed: cost=${result.cost} dynDisc=${result.dynDisc} transit=${result.transit}`);
      json({ ...result, markup: Math.round(result.cost * 0.25 * 100) / 100 });
    } catch(e) {
      console.error(`[freight] error: ${e.message}`);
      writelog('error', 'error.freight', `ABF rate failed: ${e.message}`, { rep: getRepFromReq(req, body), meta: { zip: body.zip || null, state: body.state || null, city: body.city || null } });
      json({error: e.message}, 500);
    }
    return;
  }
  if (pathname === '/api/tax' && req.method === 'POST') {
    let body = {};
    try {
      body = JSON.parse(await readBody(req));
      const { state: rawState, zip, city, subtotal, shipping, street, rep } = body;
      const state = toStateAbbr(rawState);
      console.log(`[tax route] received: state=${state} zip=${zip} city=${city||'(none)'} street=${street||'(none)'} subtotal=${subtotal} shipping=${shipping}`);
      const result = await calculateTaxProper(state, zip, city, subtotal, shipping, street || '');
      console.log(`[tax route] result: tax=${result.tax} rate=${result.rate} inNexus=${result.inNexus} error=${result.error||'none'}`);
      if (result.error) {
        console.error(`[tax] error for ${state} ${zip}: ${result.error}`);
        writelog('error', 'error.tax', `Tax failed: ${state} ${zip||'no zip'} — ${result.error}`, { rep: rep || null, meta: { state, zip: zip||null, city: city||null, error: result.error } });
      }
      json(result);
    } catch(e) {
      console.error(`[tax route] exception: ${e.message}`);
      writelog('error', 'error.tax', `Tax exception: ${e.message}`, { rep: body.rep || null, meta: { state: body.state||null, zip: body.zip||null } });
      json({error: e.message}, 500);
    }
    return;
  }

  // ── API: Push to HubSpot ──
  if (pathname === '/api/create-deal' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const { customer, lineItems, freight, tax, discount, total, ownerId, dealName, existingDealId, existingContactId, billing, isRevision, linkedDealId: bodyLinkedDealId, confirmContactOverride, quoteLabel, bindFolderId } = body;
      let { quoteNumber } = body;

      // ── In-place update detection ────────────────────────────────────
      // If this is a revision and total + line item count haven't changed,
      // update the snapshot in place — keep the same quote number, skip line item reset
      let _inPlaceUpdate = false;
      let _existingQuoteNumber = null;
      if (existingDealId && db) {
        try {
          const snapRow = await db.query(
            'SELECT quote_number, total, json_snapshot FROM quotes WHERE deal_id = $1 ORDER BY created_at DESC LIMIT 1',
            [String(existingDealId)]
          );
          if (snapRow.rows.length > 0) {
            const stored = snapRow.rows[0];
            const storedTotal = parseFloat(stored.total) || 0;
            const storedItems = stored.json_snapshot?.lineItems?.length || 0;
            const newTotal    = parseFloat(total) || 0;
            const newItems    = (lineItems || []).filter(i => i.price >= 0).length; // exclude credits from count
            const totalMatch  = Math.abs(storedTotal - newTotal) < 0.01;
            const countMatch  = storedItems === newItems;
            if (totalMatch && countMatch) {
              _inPlaceUpdate = true;
              _existingQuoteNumber = stored.quote_number;
              console.log(`[save] in-place update detected for deal ${existingDealId} — keeping quote number ${_existingQuoteNumber}`);
            }
          }
        } catch(e) { console.warn('[save] in-place check failed:', e.message); }
      }

      // If in-place, use existing quote number — skip generating a new one
      if (_inPlaceUpdate && _existingQuoteNumber) {
        quoteNumber = _existingQuoteNumber;
      }

      // Resolve any quote number collision server-side before touching HubSpot
      // This replaces the client error-and-retry flow with silent auto-increment
      if (quoteNumber && db && !_inPlaceUpdate) {
        const resolvedContactId = existingContactId ? String(existingContactId) : null;
        const resolvedDealId    = existingDealId    ? String(existingDealId)    : null;
        const free = await generateFreeQuoteNumber(quoteNumber, ownerId, resolvedDealId, resolvedContactId);
        if (free !== quoteNumber) {
          console.log(`[save] quote number collision: ${quoteNumber} → reassigned to ${free}`);
          quoteNumber = free;
        }
      }

      // Find or create contact
      let contactId;
      if (existingContactId) {
        // Rep chose to use an existing contact from the duplicate check
        contactId = String(existingContactId);
      } else {
        const existing = await hsSearchContact(customer.email);
        if (existing.results && existing.results.length > 0) {
          contactId = existing.results[0].id;
          // Selectively update contact — only overwrite fields that are blank
          // in HubSpot, or where the quote has a value and HubSpot doesn't.
          // Never overwrite existing data blindly.
          try {
            const existingProps = existing.results[0].properties || {};
            const updateProps = {};

            if (confirmContactOverride) {
              // Rep confirmed — update all changed fields
              if (customer.firstName) updateProps.firstname = customer.firstName;
              if (customer.lastName)  updateProps.lastname  = customer.lastName;
              if (customer.address)   updateProps.address   = customer.address;
              if (customer.city)      updateProps.city      = customer.city;
              if (customer.state)     updateProps.state     = toStateFull(customer.state) || customer.state;
              if (customer.zip)       updateProps.zip       = customer.zip;
              if (customer.phone)     updateProps.phone     = customer.phone;
              if (customer.company)   updateProps.company   = customer.company;
            } else {
              // Only fill blanks — never overwrite existing non-empty data without confirmation
              if (customer.firstName && !existingProps.firstname) updateProps.firstname = customer.firstName;
              if (customer.lastName  && !existingProps.lastname)  updateProps.lastname  = customer.lastName;
              if (customer.address   && !existingProps.address)   updateProps.address   = customer.address;
              if (customer.city      && !existingProps.city)      updateProps.city      = customer.city;
              if (customer.state     && !existingProps.state)     updateProps.state     = toStateFull(customer.state) || customer.state;
              if (customer.zip       && !existingProps.zip)       updateProps.zip       = customer.zip;
              if (customer.phone     && !existingProps.phone)     updateProps.phone     = customer.phone;
              if (customer.company   && !existingProps.company)   updateProps.company   = customer.company;
            }

            // Assign rep as contact owner if:
            // - contact has no owner, OR
            // - current owner is info@whisperroom.com (generic fallback)
            if (ownerId) {
              const currentOwner = existingProps.hubspot_owner_id;
              const isGenericOwner = currentOwner && currentOwner === '36303670'; // Benton = info@ fallback
              // Look up if the current owner email is info@
              let ownerIsGeneric = !currentOwner;
              if (currentOwner) {
                const ownerEmail = REP_EMAILS[String(currentOwner)] || '';
                ownerIsGeneric = !ownerEmail || ownerEmail === 'info@whisperroom.com';
              }
              if (ownerIsGeneric) {
                updateProps.hubspot_owner_id = String(ownerId);
              }
            }

            if (Object.keys(updateProps).length > 0) {
              await httpsRequest({
                hostname: 'api.hubapi.com',
                path: `/crm/v3/objects/contacts/${contactId}`,
                method: 'PATCH',
                headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
              }, { properties: updateProps });
            }
          } catch(e) {
            console.warn('Contact update skipped:', e.message);
          }
        } else {
          let newContact;
          try {
            newContact = await hsCreateContact({
              firstname:          customer.firstName,
              lastname:           customer.lastName,
              email:              customer.email,
              phone:              customer.phone,
              company:            customer.company,
              address:            customer.address,
              city:               customer.city,
              state:              toStateFull(customer.state),
              zip:                customer.zip,
              ...(ownerId ? { hubspot_owner_id: String(ownerId) } : {}),
            });
            if (newContact.status === 'error' || newContact.errors) {
              console.warn(`[create-deal] Contact create failed (${newContact.message}), retrying without state`);
              newContact = await hsCreateContact({
                firstname:          customer.firstName,
                lastname:           customer.lastName,
                email:              customer.email,
                phone:              customer.phone,
                company:            customer.company,
                address:            customer.address,
                city:               customer.city,
                zip:                customer.zip,
                ...(ownerId ? { hubspot_owner_id: String(ownerId) } : {}),
              });
            }
          } catch(e) {
            console.warn(`[create-deal] Contact create threw (${e.message}), retrying without state`);
            newContact = await hsCreateContact({
              firstname:          customer.firstName,
              lastname:           customer.lastName,
              email:              customer.email,
              phone:              customer.phone,
              company:            customer.company,
              address:            customer.address,
              city:               customer.city,
              zip:                customer.zip,
              ...(ownerId ? { hubspot_owner_id: String(ownerId) } : {}),
            });
          }
          contactId = newContact.id;
          if (!contactId) throw new Error('Failed to create contact: ' + JSON.stringify(newContact));
        }
      }

      // Use existing deal or create new one
      let dealId;
      if (existingDealId) {
        dealId = existingDealId;
        // Fetch current stage so we don't move deal backward
        let existingDealStage = 'appointmentscheduled';
        try {
          const dsRes = await httpsRequest({
            hostname: 'api.hubapi.com',
            path: `/crm/v3/objects/deals/${dealId}?properties=dealstage`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
          });
          existingDealStage = dsRes.body?.properties?.dealstage || 'appointmentscheduled';
        } catch(e) { console.warn('Could not fetch deal stage:', e.message); }
        // Update existing deal — amount + address fields always updated from latest quote
        const dealPatchProps = {
          amount: total.toFixed(2),
          // Always update shipping address from latest quote
          shipping_address:  customer.address || '',
          shipping_city:     customer.city    || '',
          shipping_zipcode:  customer.zip     || '',
          billing_address:   billing ? billing.address || '' : customer.address || '',
          billing_city:      billing ? billing.city    || '' : customer.city    || '',
          billing_zipcode:   billing ? billing.zip     || '' : customer.zip     || '',
          dealname: dealName || undefined,
          // Only advance to Updated Quote if deal is still at Sent Quote stage
          ...(() => {
            const earlyStages = ['appointmentscheduled', 'qualifiedtobuy'];
            return earlyStages.includes(existingDealStage) ? { dealstage: 'qualifiedtobuy' } : {};
          })(),
        };
        // State fields — try with them first, retry without if HubSpot rejects
        const shipping_state = toStateFull(customer.state) || customer.state || '';
        const billing_state  = billing ? (toStateFull(billing.state) || billing.state || '') : shipping_state;
        try {
          await httpsRequest({
            hostname: 'api.hubapi.com',
            path: `/crm/v3/objects/deals/${dealId}`,
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
          }, { properties: { ...dealPatchProps, shipping_state, billing_state } });
        } catch(e) {
          // Retry without state fields if HubSpot rejects (e.g. Canadian province)
          await httpsRequest({
            hostname: 'api.hubapi.com',
            path: `/crm/v3/objects/deals/${dealId}`,
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
          }, { properties: dealPatchProps });
        }

        // Rename Google Drive folder if deal name changed
        if (dealName && db) {
          try {
            const folderRow = await db.query(
              'SELECT gdrive_folder_id, deal_name FROM quotes WHERE deal_id = $1 ORDER BY created_at DESC LIMIT 1',
              [existingDealId]
            );
            const folderId = folderRow.rows[0]?.gdrive_folder_id;
            const oldName  = folderRow.rows[0]?.deal_name;
            const newFolderName = getCompanyFolderName(dealName, customer?.company || '').replace(/[/\\:*?"<>|]/g, '-').trim();
            if (folderId && newFolderName && oldName !== newFolderName) {
              await gdriveRenameFolder(folderId, newFolderName);
              console.log(`GDrive: renamed folder "${oldName}" → "${newFolderName}"`);
            }
          } catch(e) { console.warn('GDrive rename error:', e.message); }
        }
      } else {
        const dealProps = {
          dealname: dealName || (() => {
            return customer.company || [customer.firstName, customer.lastName].filter(Boolean).join(' ') || 'Customer';
          })(),
          tax_rate: tax && tax.rate ? String((tax.rate * 100).toFixed(3)) : '',
          quote_number: quoteNumber || '',
          freight_cost: freight && freight.total ? String(freight.total) : '',
          discount: discount && discount.value ? String(discount.value) : '',
          shipping_address: customer.address || '',
          shipping_city: customer.city || '',
          shipping_state: toStateFull(customer.state) || customer.state || '',
          billing_address: billing ? billing.address || '' : customer.address || '',
          billing_city: billing ? billing.city || '' : customer.city || '',
          billing_state: billing ? (toStateFull(billing.state) || billing.state || '') : (toStateFull(customer.state) || customer.state || ''),
          shipping_zipcode: customer.zip || '',
          billing_zipcode: billing ? billing.zip || '' : customer.zip || '',
          pipeline: 'default',
          dealstage: isRevision ? 'qualifiedtobuy' : 'appointmentscheduled',
          amount: total.toFixed(2),
          hubspot_owner_id: String(ownerId),
          closedate: new Date(Date.now() + 30*24*60*60*1000).toISOString().split('T')[0],
        };
        let deal;
        try {
          deal = await hsCreateDeal(dealProps);
          // HubSpot returns error body instead of throwing on 4xx
          if (deal.status === 'error' || deal.errors) {
            console.warn(`[create-deal] Deal create failed (${deal.message}), retrying without state fields`);
            const { shipping_state, billing_state, ...dealPropsNoState } = dealProps;
            deal = await hsCreateDeal(dealPropsNoState);
          }
        } catch(e) {
          console.warn(`[create-deal] Deal create threw (${e.message}), retrying without state fields`);
          const { shipping_state, billing_state, ...dealPropsNoState } = dealProps;
          deal = await hsCreateDeal(dealPropsNoState);
        }
        dealId = deal.id;
        if (!dealId) throw new Error('Failed to create deal: ' + JSON.stringify(deal));
      }

      // Associate contact with deal
      await hsAssociate('deals', dealId, 'contacts', contactId, 'deal_to_contact');

      // Create line items — deduct credits from MDL (or highest-priced item) so HubSpot total is correct
      const creditTotal = lineItems.reduce((s, item) => item.price < 0 ? s + (item.price * item.qty) : s, 0);
      const creditItems = lineItems.filter(item => item.price < 0);
      const positiveItems = lineItems.filter(item => item.price >= 0);

      // If credits exist, adjust the anchor line item price
      let adjustedItems = positiveItems.map(i => ({ ...i }));
      let anchor = null;
      if (creditTotal < 0 && adjustedItems.length > 0) {
        let anchorIdx = adjustedItems.findIndex(i => /^MDL\b/i.test(i.name || ''));
        if (anchorIdx === -1) anchorIdx = adjustedItems.reduce((maxIdx, item, idx, arr) => item.price > arr[maxIdx].price ? idx : maxIdx, 0);
        anchor = adjustedItems[anchorIdx];
        const creditAmt = Math.abs(creditTotal);
        adjustedItems[anchorIdx] = {
          ...anchor,
          price: Math.max(0, anchor.price - creditAmt),
          description: (`$${creditAmt.toFixed(2)} in credits applied to this line. ` + (anchor.description || '')).trim(),
        };
        console.log(`[create-deal] deducted $${creditAmt.toFixed(2)} credits from "${anchor.name}"`);
      }

      const lineItemIds = [];
      if (!_inPlaceUpdate) {
        // Clear existing line items first so we don't accumulate on each quote push
        await hsClearDealLineItems(dealId);
        for (const item of adjustedItems) {
          const li = await hsCreateLineItem({
            name: item.name,
            quantity: String(item.qty),
            price: String(parseFloat(item.price).toFixed(2)),
            hs_product_id: item.productId ? String(item.productId) : undefined,
            description: item.description || '',
            hs_discount_percentage: item.lineDiscount && item.lineDiscount > 0 ? String(item.lineDiscount) : undefined,
          });
          if (li.id) lineItemIds.push(li.id);
        }

        // Add each credit as a $0 descriptor line
        for (const cr of creditItems) {
          const amt = Math.abs(parseFloat(cr.price) * parseInt(cr.qty || 1));
          const li = await hsCreateLineItem({
            name: cr.name,
            quantity: '1',
            price: '0.00',
            description: `Credit applied${anchor ? ' in ' + anchor.name + ' above' : ''}: -$${amt.toFixed(2)}${cr.description ? ' — ' + cr.description : ''}`,
          });
          if (li.id) lineItemIds.push(li.id);
        }

        // Add freight line item
        if (freight && freight.total > 0 && !freight.tbd) {
          const fli = await hsCreateLineItem({
            name: 'Freight',
            quantity: '1',
            price: String(freight.total.toFixed(2)),
            description: `LTL freight estimate. Transit: ${freight.transit || '—'}. ${freight.dynDisc > 0 ? `Dynamic discount of $${freight.dynDisc} excluded.` : ''}`,
          });
          if (fli.id) lineItemIds.push(fli.id);
        }

        // Add tax line item if applicable
        if (tax && tax.tax > 0) {
          const tli = await hsCreateLineItem({
            name: `Sales Tax (${(tax.rate * 100).toFixed(3)}%)`,
            quantity: '1',
            price: String(tax.tax.toFixed(2)),
            description: `State: ${customer.state}. ${tax.freightTaxed ? 'Includes freight.' : 'Product only.'}`,
          });
          if (tli.id) lineItemIds.push(tli.id);
        }

        // Associate all line items with deal
        if (lineItemIds.length > 0) {
          await hsBatchAssociateLineItems(dealId, lineItemIds);
        }
      } // end !_inPlaceUpdate

      // Append quote link and contact history — only for new quotes, not in-place updates
      if (!_inPlaceUpdate) {
        // Append quote link to deal (preserves all previous links)
        if (quoteNumber) {
          try {
            const newLink = `https://sales.whisperroom.com/q/${quoteNumber}`;
            const datestamp = new Date().toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric', timeZone:'America/New_York'});
            const existingDeal = await httpsRequest({
              hostname: 'api.hubapi.com',
              path: `/crm/v3/objects/deals/${dealId}?properties=quote_link`,
              method: 'GET',
              headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
            });
            const existingLinks = existingDeal.body?.properties?.quote_link || '';
            const totalFmt = total ? ' — $' + parseFloat(total).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '';
            const newEntry = `${datestamp}${totalFmt} — #${quoteNumber}: ${newLink}`;
            const updatedLinks = existingLinks ? newEntry + '\n' + existingLinks : newEntry;
            await httpsRequest({
              hostname: 'api.hubapi.com',
              path: `/crm/v3/objects/deals/${dealId}`,
              method: 'PATCH',
              headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
            }, { properties: { quote_link: updatedLinks } });
          } catch(e) { console.warn('quote_link append failed:', e.message); }
        }

        // Append quote history to contact record
        if (quoteNumber && contactId) {
          try {
            const newLink = `https://sales.whisperroom.com/q/${quoteNumber}`;
            const datestamp = new Date().toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric', timeZone:'America/New_York'});
            const totalFmt = total ? ' — $' + parseFloat(total).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '';
            const dealLabel = dealName ? ` — ${dealName}` : '';
            const existingContact = await httpsRequest({
              hostname: 'api.hubapi.com',
              path: `/crm/v3/objects/contacts/${contactId}?properties=quote_links,all_quote_numbers`,
              method: 'GET',
              headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
            });
            const existingLinks = existingContact.body?.properties?.quote_links || '';
            const existingNums  = existingContact.body?.properties?.all_quote_numbers || '';
            const newEntry = `${datestamp}${totalFmt}${dealLabel} — #${quoteNumber}: ${newLink}`;
            const updatedLinks = existingLinks ? newEntry + '\n' + existingLinks : newEntry;
            const numList = existingNums ? quoteNumber + ', ' + existingNums : quoteNumber;

            await httpsRequest({
              hostname: 'api.hubapi.com',
              path: `/crm/v3/objects/contacts/${contactId}`,
              method: 'PATCH',
              headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
            }, {
              properties: {
                quote_links:        updatedLinks,
                quote_number:       quoteNumber,
                all_quote_numbers:  numList,
              }
            });
          } catch(e) { console.warn('Contact quote history update failed:', e.message); }
        }
      } // end !_inPlaceUpdate

      // Save to PostgreSQL DB (primary storage)
      // Fetch actual deal name from HubSpot to ensure DB matches
      let finalDealName = dealName;
      try {
        const dnRes = await httpsRequest({
          hostname: 'api.hubapi.com',
          path: `/crm/v3/objects/deals/${dealId}?properties=dealname`,
          method: 'GET',
          headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
        });
        finalDealName = dnRes.body?.properties?.dealname || dealName;
      } catch(e) { /* use client dealName as fallback */ }

      let shareToken = null;
      try {
        console.log(`[save] saving quote ${quoteNumber} with dealId: ${dealId}`);
        await saveQuoteToDb({
          quoteNumber, dealId, contactId, dealName: finalDealName, ownerId, total,
          date: new Date().toLocaleDateString('en-US', {month:'short',day:'numeric',year:'numeric'}),
          customer, lineItems, discount, freight, tax,
          quoteLabel: quoteLabel || '',
        });
        // Fetch the token we just saved
        const tokenRow = await db?.query('SELECT share_token FROM quotes WHERE quote_number = $1', [quoteNumber]);
        shareToken = tokenRow?.rows[0]?.share_token || null;

        // Create Google Drive folder and upload quote PDF (non-blocking)
        (async () => {
          try {
            // 1. If rep explicitly bound an existing folder, save that ID
            if (bindFolderId) {
              await db?.query('UPDATE quotes SET gdrive_folder_id = $1 WHERE quote_number = $2', [bindFolderId, quoteNumber]);
              console.log(`[drive] using bound folder ${bindFolderId} for ${quoteNumber}`);
            } else {
              // 2. Check if contact has a prior folder we can inherit
              let inheritedFolderId = null;
              if (contactId && db) {
                const priorRow = await db.query(
                  'SELECT gdrive_folder_id FROM quotes WHERE contact_id = $1 AND gdrive_folder_id IS NOT NULL ORDER BY created_at DESC LIMIT 1',
                  [String(contactId)]
                );
                inheritedFolderId = priorRow.rows[0]?.gdrive_folder_id || null;
              }
              if (inheritedFolderId) {
                await db?.query('UPDATE quotes SET gdrive_folder_id = $1 WHERE quote_number = $2', [inheritedFolderId, quoteNumber]);
                console.log(`[drive] inherited folder ${inheritedFolderId} for ${quoteNumber}`);
              } else {
                // 3. Create new folder
                await gdriveCreateDealFolders(finalDealName, quoteNumber, customer?.company || '');
              }
            }
            // Upload quote PDF to Google Drive
            // For in-place updates: delete the existing PDF first to avoid duplicates
            if (_inPlaceUpdate) {
              try {
                const folderRow = await db?.query('SELECT gdrive_folder_id FROM quotes WHERE quote_number = $1', [quoteNumber]);
                const folderId = folderRow?.rows[0]?.gdrive_folder_id;
                if (folderId) {
                  const driveToken = await getGDriveToken();
                  const pdfName = buildPdfFilename({ customer, quoteLabel }, quoteNumber, 'Quote');
                  // Search for existing file with same name in folder
                  const searchRes = await httpsRequest({
                    hostname: 'www.googleapis.com',
                    path: `/drive/v3/files?q=${encodeURIComponent(`'${folderId}' in parents and name='${pdfName.replace(/'/g,"\\'")}' and trashed=false`)}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
                    method: 'GET',
                    headers: { 'Authorization': `Bearer ${driveToken}` }
                  });
                  for (const f of (searchRes.body?.files || [])) {
                    await httpsRequest({
                      hostname: 'www.googleapis.com',
                      path: `/drive/v3/files/${f.id}?supportsAllDrives=true`,
                      method: 'DELETE',
                      headers: { 'Authorization': `Bearer ${driveToken}` }
                    });
                    console.log(`[drive] deleted old PDF ${f.id} for in-place update`);
                  }
                }
              } catch(delErr) { console.warn('[drive] could not delete old PDF:', delErr.message); }
            }
            const shareTokenQ = (await db?.query('SELECT share_token FROM quotes WHERE quote_number = $1', [quoteNumber]))?.rows[0]?.share_token || '';
            const quoteUrl = `https://sales.whisperroom.com/q/${encodeURIComponent(quoteNumber)}${shareTokenQ ? '?t=' + shareTokenQ : ''}`;
            const pdfBufQ = await generatePdfBuffer(quoteUrl);
            await gdriveSavePdfToDeal(quoteNumber, 'Quotes', buildPdfFilename({ customer, quoteLabel }, quoteNumber, 'Quote'), pdfBufQ);
          } catch(e) {
            console.warn('GDrive quote upload error:', e.message, e.stack?.split('\n')[1]);
            writelog('error', 'error.gdrive', `Drive quote upload failed: ${e.message}`, { rep: String(ownerId||''), quoteNum: quoteNumber, dealId: String(dealId||''), meta: { step: 'quote-pdf' } });
          }
        })();

      } catch(e) {
        console.warn('DB save error:', e.message);
        // If it's a collision error, surface it to the client immediately
        if (e.message && e.message.includes('already exists for a different customer')) {
          json({ error: e.message }, 409);
          return;
        }
      }

      // HubSpot Notes write removed — DB is primary storage

      const isNewDeal = !existingDealId;
      const updateType = isNewDeal ? 'New deal' : (_inPlaceUpdate ? 'In-place update' : 'Revision');
      writelog('info', 'quote.pushed', `${updateType}: ${finalDealName || dealName || '—'} (${quoteNumber || '—'})${isNewDeal ? '' : ' — deal ' + dealId}`, { rep: String(ownerId || ''), quoteNum: quoteNumber || null, dealId: String(dealId || ''), dealName: finalDealName || dealName || null, meta: { isNewDeal, inPlaceUpdate: _inPlaceUpdate, existingDealId: existingDealId || null } });
      json({
        success: true,
        dealId,
        contactId,
        quoteNumber,
        shareToken,
        dealName: finalDealName,
        inPlaceUpdate: _inPlaceUpdate,
        dealUrl: `https://app.hubspot.com/contacts/5764220/record/0-3/${dealId}`
      });

    } catch(e) {
      writelog('error', 'error.save', `create-deal failed: ${e.message}`, { rep: getRepFromReq(req, body) });
      json({error: e.message}, 500);
    }
    return;
  }

  // ── Shareable Quote Page ─────────────────────────────────────────

  // ── Invoice Page (/i/:quoteNumber) ──────────────────────────────
  if (pathname.startsWith('/i/') && req.method === 'GET') {
    const quoteId = decodeURIComponent(pathname.replace('/i/', '').trim());
    if (!quoteId) { res.writeHead(404); res.end('Not found'); return; }
    try {
      let quoteData = await getQuoteFromDb(quoteId);
      if (!quoteData) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><head><title>Invoice Not Found</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:#f5f5f5}div{text-align:center}</style></head><body><div><h2 style="color:#ee6216">Invoice Not Found</h2><p style="color:#888">This link may have expired or the invoice number is incorrect.</p></div></body></html>');
        return;
      }
      const iToken = new URLSearchParams(search).get('t');
      if (!validateShareToken(quoteData, iToken)) {
        res.writeHead(403, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><head><title>Link Expired</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:#f5f5f5}div{text-align:center}</style></head><body><div><h2 style="color:#ee6216">This link is no longer valid</h2><p style="color:#888;margin-top:8px">Please contact your WhisperRoom representative for an updated link.</p></div></body></html>');
        return;
      }

      // Get payment link from DB
      let paymentUrl = null;
      if (db) {
        try {
          const pr = await db.query('SELECT payment_link FROM quotes WHERE quote_number = $1', [quoteId]);
          paymentUrl = pr.rows[0]?.payment_link || null;
        } catch(e) {}
      }

      const q = quoteData;
      const fmt = n => '$' + parseFloat(n||0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,',');
      const sub = (q.lineItems||[]).reduce((s,i)=>s+(i.price*i.qty),0);
      const disc = q.discount && q.discount.value > 0
        ? (q.discount.type==='pct' ? sub*q.discount.value/100 : q.discount.value) : 0;
      const freightTbd = q.freight?.tbd === true;
      const freightAmt = (!freightTbd && q.freight) ? q.freight.total : 0;
      const taxAmt = q.tax ? q.tax.tax : 0;
      const total = sub - disc + freightAmt + taxAmt;
      const c = q.customer || {};

      const lineRows = (q.lineItems||[]).map(item =>
        `<tr>
          <td style="padding:12px 0;border-bottom:1px solid #f5f5f5;padding-right:16px">
            <div class="item-name">${item.name}</div>
            ${item.description?`<div class="item-desc">${item.description.replace(/\n/g,'<br>')}</div>`:''}
          </td>
          <td style="padding:12px 0;border-bottom:1px solid #f5f5f5;text-align:center;color:#888;width:50px">${item.qty}</td>
          <td style="padding:12px 0;border-bottom:1px solid #f5f5f5;text-align:right;color:#888;width:110px">${fmt(item.price)}</td>
          <td style="padding:12px 0;border-bottom:1px solid #f5f5f5;text-align:right;font-weight:700;color:#1a1a1a;width:110px">${fmt(item.price*item.qty)}</td>
        </tr>`
      ).join('');

      const issueDate = q.date || new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric',timeZone:'America/New_York'});

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhisperRoom Invoice ${q.quoteNumber||''}</title>
<link rel="icon" href="/assets/favicon.avif">
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;0,9..40,800;1,9..40,400&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7f6f4;color:#1a1a1a;-webkit-font-smoothing:antialiased}
.page{max-width:840px;margin:0 auto;padding:0 0 110px}
.header-card{background:#ffffff;padding:32px 40px 28px;margin-bottom:0;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:20px;border-left:6px solid transparent;border-image:linear-gradient(to bottom,#ee6216 0%,rgba(238,98,22,.15) 70%,transparent 100%) 1;box-shadow:0 2px 12px rgba(0,0,0,.08)}
.logo-img{height:40px;display:block}
.header-right{text-align:right}
.quote-type{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.16em;color:#ee6216;margin-bottom:8px}
.quote-num{font-size:34px;font-weight:800;color:#1a1a1a;letter-spacing:-.8px;font-variant-numeric:tabular-nums;line-height:1}
.quote-meta{font-size:12px;color:#aaa;margin-top:6px}
.accent-strip{height:1px;background:#eee;margin-bottom:20px}
.card{background:#fff;border-radius:10px;padding:30px 36px;margin:0 0 12px;box-shadow:0 1px 4px rgba(0,0,0,.06);border:1px solid #f0f0f0}
.card-label{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;color:#ee6216;margin-bottom:18px}
.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.info-item label{font-size:10px;color:#bbb;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:4px}
.info-item span{font-size:14px;font-weight:600;color:#1a1a1a}
table{width:100%;border-collapse:collapse}
thead th{font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;color:#ccc;padding:0 0 16px;border-bottom:2px solid #f5f5f5;text-align:left}
thead th:nth-child(2){text-align:center}
thead th:nth-child(3),thead th:nth-child(4){text-align:right}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover td{background:#fdfcfb}
.item-name{font-weight:700;color:#1a1a1a;font-size:14px}
.item-desc{font-size:11px;color:#bbb;margin-top:4px;line-height:1.6}
.totals{max-width:320px;margin-left:auto;margin-top:28px;padding-top:20px;border-top:2px solid #f5f5f5}
.tot{display:flex;justify-content:space-between;padding:7px 0;font-size:13px;color:#999}
.tot.grand{font-size:26px;font-weight:800;color:#1a1a1a;padding-top:18px;margin-top:10px;border-top:2px solid #1a1a1a}
.tot.grand span:last-child{color:#ee6216}
.discount-val{color:#1a7a4a!important;font-weight:600}
.terms{font-size:11px;color:#bbb;line-height:1.9}
.action-bar{position:fixed;bottom:0;left:0;right:0;background:rgba(20,20,20,.97);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-top:1px solid rgba(255,255,255,.06);padding:16px 28px;display:flex;gap:12px;justify-content:center;align-items:center;z-index:100}
.btn{padding:13px 32px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;border:none;letter-spacing:.04em;font-family:inherit;transition:all .15s}
.btn-pay{background:#1a7a4a;color:white;font-size:14px;font-weight:800;padding:14px 40px;letter-spacing:.02em}
.btn-pay:hover{background:#166040;transform:translateY(-1px);box-shadow:0 6px 24px rgba(26,122,74,.5)}
.btn-secondary{background:rgba(255,255,255,.05);color:rgba(255,255,255,.45);border:1px solid rgba(255,255,255,.08)}
.btn-secondary:hover{background:rgba(255,255,255,.09);color:rgba(255,255,255,.65)}
.footer{text-align:center;margin:24px 0 0;padding:24px 32px;font-size:11px;color:#bbb;line-height:2.1;border-top:1px solid #ece9e4}
.footer a{color:#ee6216;text-decoration:none}
.footer strong{color:#888;font-weight:600}
@media(max-width:600px){
  .header-card{padding:24px 20px;border-left:4px solid transparent}
  .logo-img{height:30px}
  .header-right{text-align:left}
  .quote-num{font-size:26px}
  .card{padding:22px 20px}
  .info-grid{grid-template-columns:1fr}
  .action-bar{flex-direction:column;padding:14px 16px}
  .btn{width:100%;text-align:center}
}
@media print{
  body{background:white}
  .action-bar{display:none!important}
  .page{padding-bottom:20px}
  .header-card{border-left:6px solid #ee6216!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .card{box-shadow:none}
}
</style>
</head>
<body>
<div class="page">

  <div class="header-card">
    <img src="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTUwIiBoZWlnaHQ9IjMxIiB2aWV3Qm94PSIwIDAgMTUwIDMxIiBmaWxsPSJub25lIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPgo8cGF0aCBkPSJNNDMuNzg4NiAxNC45NjdDNDMuNjI0MiAxNC43OTgzIDQzLjUwOTEgMTQuNTQ1MSA0My40NTk4IDE0LjMwODhDNDMuMzYxMSAxMy44MzYzIDQzLjQ3NjIgMTMuMzYzNyA0My42NzM2IDEyLjk0MThDNDQuMDAyNCAxMi4yNDk4IDQ0LjU5NDMgMTEuNzA5OCA0NS4yNTIgMTEuMzcyM0M0NS43NDUzIDExLjEzNiA0Ni4yODc5IDExLjAwMSA0Ni44MzA1IDExLjA1MTZDNDcuMjQxNiAxMS4xMDIyIDQ3LjY2OTEgMTEuMjU0MSA0Ny45NDg2IDExLjU0MUM0OC4xMjk1IDExLjcyNjcgNDguMjYxMSAxMS45Nzk4IDQ4LjMyNjggMTIuMjMzQzQ4LjQ0MTkgMTIuNzM5MyA0OC4zMTA0IDEzLjMzIDQ4LjAzMDkgMTMuNzY4OEM0Ny43NTEzIDE0LjIyNDQgNDcuMzA3NCAxNC41MjgyIDQ2Ljg0NyAxNC43ODE0QzQ2LjI3MTUgMTUuMDg1MiA0NS42Nzk2IDE1LjMwNDYgNDUuMDA1NCAxNS4zMzgzQzQ0LjU3NzkgMTUuMzU1MiA0NC4wODQ2IDE1LjI4NzcgNDMuNzg4NiAxNC45NjdaIiBmaWxsPSIjMjYyNjI2Ii8+CjxwYXRoIGQ9Ik0zMi4xMzc3IDEyLjM1MjdDMzIuMjIxNCAxMi4zMzYxIDMyLjMyMTggMTIuMzE5NSAzMi4zODg3IDEyLjM1MjdDMzIuNTIyNSAxMi40MDI1IDMyLjU3MjggMTIuNTg1MSAzMi42MDYyIDEyLjczNDZDMzIuNjM5NyAxMi44Njc0IDMyLjY1NjQgMTIuOTgzNiAzMi42NzMxIDEzLjA5OTlDMzIuNzA2NiAxMy40MTU0IDMyLjc0MDEgMTMuNzQ3NSAzMi43NTY4IDE0LjA3OTVDMzIuODIzNyAxNC45NTk2IDMyLjg0MDUgMTUuODIzIDMyLjg3MzkgMTYuNjg2NEMzMi45MDc0IDE4LjE2NDIgMzIuOTQwOSAxOS42NDIgMzIuOTI0MSAyMS4xMTk4QzMyLjkyNDEgMjEuODY3IDMyLjkwNzQgMjIuNTk3NiAzMi44OTA3IDIzLjM0NDhDMzIuODkwNyAyMy42MTA1IDMyLjg5MDcgMjMuODc2MSAzMi44NzM5IDI0LjE0MThDMzIuODU3MiAyNC4zMDc4IDMyLjg1NzIgMjQuNDkwNSAzMi44MjM3IDI0LjY1NjVDMzIuODA3IDI0LjgyMjYgMzIuNzU2OCAyNC45ODg2IDMyLjY4OTkgMjUuMTIxNUMzMi42MjMgMjUuMjcwOSAzMi41MDU4IDI1LjQwMzcgMzIuMzg4NyAyNS41MkMzMi4zMDUgMjUuNjAzIDMyLjIyMTQgMjUuNjg2IDMyLjEzNzcgMjUuNzY5QzMzLjg3NzkgMjUuNzY5IDM1LjYwMTQgMjUuNzY5IDM3LjM0MTYgMjUuNzY5QzM3LjIwNzcgMjUuNjUyOCAzNy4wOTA2IDI1LjUyIDM2Ljk3MzUgMjUuMzg3MUMzNi44NTYzIDI1LjI1NDMgMzYuNzU1OSAyNS4xMDQ5IDM2LjcwNTcgMjQuOTM4OEMzNi42NTU1IDI0Ljc1NjIgMzYuNjM4OCAyNC41NzM1IDM2LjYzODggMjQuMzkwOUMzNi42Mzg4IDIzLjk5MjQgMzYuNjM4OCAyMy42MTA1IDM2LjY1NTUgMjMuMjI4NkMzNi42NzIzIDIyLjQ4MTQgMzYuNjU1NSAyMS43MTc2IDM2LjY1NTUgMjAuOTcwNEMzNi42NTU1IDIwLjUzODYgMzYuNjcyMyAyMC4xMjM1IDM2LjY1NTUgMTkuNjkxOEMzNi42NTU1IDE5LjU1OSAzNi42NTU1IDE5LjQyNjEgMzYuNjU1NSAxOS4yNzY3QzM2LjY3MjMgMTkuMTEwNyAzNi42ODkgMTguOTQ0NiAzNi43NTU5IDE4Ljc5NTJDMzYuODIyOSAxOC42NDU3IDM2LjkyMzMgMTguNTEyOSAzNy4wNDA0IDE4LjM5NjdDMzcuMjU3OSAxOC4xOTc0IDM3LjU1OTEgMTguMTE0NCAzNy44NjAzIDE4LjA5NzhDMzguMDc3OCAxOC4wOTc4IDM4LjI5NTQgMTguMTMxIDM4LjQ3OTQgMTguMjMwNkMzOC42ODAyIDE4LjMzMDMgMzguODQ3NSAxOC40OTYzIDM4Ljk0NzkgMTguNjk1NkMzOS4wNjUxIDE4LjkxMTQgMzkuMDk4NSAxOS4xNDM5IDM5LjExNTMgMTkuMzkyOUMzOS4xMzIgMTkuNTU5IDM5LjExNTMgMTkuNzI1IDM5LjExNTMgMTkuODkxMUMzOS4xMTUzIDIwLjIwNjYgMzkuMTE1MyAyMC41MDU0IDM5LjExNTMgMjAuODIwOUMzOS4xMTUzIDIxLjE4NjIgMzkuMTE1MyAyMS41NjgxIDM5LjExNTMgMjEuOTMzNEMzOS4xMTUzIDIyLjM2NTEgMzkuMTE1MyAyMi44MTM0IDM5LjExNTMgMjMuMjQ1MkMzOS4xMTUzIDIzLjYxMDUgMzkuMTE1MyAyMy45NTkxIDM5LjExNTMgMjQuMzI0NEMzOS4xMTUzIDI0LjQ3MzkgMzkuMTE1MyAyNC42MjMzIDM5LjA4MTggMjQuNzcyOEMzOS4wNDgzIDI0LjkzODggMzguOTY0NyAyNS4wODgyIDM4Ljg2NDMgMjUuMjIxMUMzOC43NDcxIDI1LjM4NzEgMzguNjMgMjUuNTM2NiAzOC40Nzk0IDI1LjY2OTRDMzguNDQ1OSAyNS43MDI2IDM4LjM5NTcgMjUuNzM1OCAzOC4zNjIzIDI1Ljc2OUM0MC44ODg5IDI1Ljc2OSA0My40MzIzIDI1Ljc2OSA0NS45NTkgMjUuNzY5QzQ2LjQ5NDQgMjUuNzY5IDQ3LjAxMzEgMjUuNzY5IDQ3LjU0ODYgMjUuNzY5QzQ3Ljk1MDIgMjUuNzY5IDQ4LjMzNSAyNS43NjkgNDguNzM2NiAyNS43NjlDNDguODcwNCAyNS43NjkgNDguOTg3NiAyNS43NjkgNDkuMTIxNCAyNS43NjlDNDkuMDcxMiAyNS42ODYgNDkuMDIxIDI1LjYwMyA0OC45NzA4IDI1LjUzNjZDNDguODg3MiAyNS40MjAzIDQ4Ljc3MDEgMjUuMzIwNyA0OC42ODY0IDI1LjIyMTFDNDguNjE5NSAyNS4xNTQ3IDQ4LjU2OTMgMjUuMDcxNiA0OC41MzU4IDI0Ljk4ODZDNDguNDM1NCAyNC43NTYyIDQ4LjQwMTkgMjQuNTA3MSA0OC4zODUyIDI0LjI1OEM0OC4zODUyIDI0LjE3NSA0OC4zNjg1IDI0LjA5MiA0OC4zNjg1IDI0LjAwOUM0OC4zNTE3IDIzLjgwOTcgNDguMzY4NSAyMy41OTM4IDQ4LjM2ODUgMjMuMzk0NkM0OC4zNjg1IDIzLjA0NTkgNDguMzY4NSAyMi43MTM4IDQ4LjM2ODUgMjIuMzY1MUM0OC4zNTE3IDIwLjgyMDkgNDguMzY4NSAxOS4yNjAxIDQ4LjM2ODUgMTcuNzE1OUM0OC4zNjg1IDE3LjU4MzEgNDguMzY4NSAxNy40NTAyIDQ4LjM2ODUgMTcuMzE3NEM0OC4zNjg1IDE3LjA2ODMgNDguMzg1MiAxNi44MTkzIDQ4LjQxODcgMTYuNTcwMkM0OC40MzU0IDE2LjQzNzQgNDguNDUyMSAxNi4zMDQ1IDQ4LjQ2ODkgMTYuMTU1MUM0OC40ODU2IDE2LjAyMjMgNDguNTAyMyAxNS44NzI4IDQ4LjQzNTQgMTUuNzU2NkM0OC4zODUyIDE1LjY1NyA0OC4yODQ4IDE1LjU5MDUgNDguMTY3NyAxNS41NTczQzQ4LjAzMzggMTUuNTI0MSA0Ny44ODMyIDE1LjU1NzMgNDcuNzQ5NCAxNS41OTA1QzQ3LjU0ODYgMTUuNjQwMyA0Ny4zODEyIDE1LjY3MzYgNDcuMTYzNyAxNS42OTAyQzQ3LjA2MzMgMTUuNzA2OCA0Ni45NDYyIDE1LjcwNjggNDYuODI5MSAxNS43MDY4QzQ2LjE1OTcgMTUuNzQgNDUuNTc0MSAxNS43NTY2IDQ0Ljk3MTcgMTUuNzU2NkM0NC43NTQyIDE1Ljc1NjYgNDQuNTUzNCAxNS43NTY2IDQ0LjMzNTkgMTUuNzU2NkM0NC4yMDIgMTUuNzU2NiA0NC4wNjgxIDE1Ljc1NjYgNDMuOTM0MyAxNS43NTY2QzQzLjg1MDYgMTUuNzU2NiA0My43NjcgMTUuNzU2NiA0My42ODMzIDE1Ljc3MzJDNDMuNjE2NCAxNS43ODk4IDQzLjU0OTQgMTUuNzg5OCA0My40OTkyIDE1LjgzOTZDNDMuNDMyMyAxNS45MDYgNDMuMzk4OCAxNi4wMDU2IDQzLjM5ODggMTYuMTA1M0M0My40MTU2IDE2LjI3MTMgNDMuNTE2IDE2LjM4NzUgNDMuNjE2NCAxNi41MDM4QzQzLjczMzUgMTYuNjUzMiA0My44MzM5IDE2Ljc4NiA0My45MTc2IDE2LjkxODlDNDMuOTY3OCAxNi45ODUzIDQ0LjAxOCAxNy4wNTE3IDQ0LjA1MTQgMTcuMjE3OEM0NC4wNjgxIDE3LjMzNCA0NC4wODQ5IDE3LjUxNjYgNDQuMTAxNiAxNy42NjYxQzQ0LjEzNTEgMTguMDQ4IDQ0LjExODQgMTguMTgwOCA0NC4xMTg0IDE4LjMzMDNDNDQuMTAxNiAxOS4wNDQyIDQ0LjExODQgMjAuMDU3MSA0NC4xMTg0IDIxLjA1MzRDNDQuMTE4NCAyMS4zODU1IDQ0LjExODQgMjEuNzAxIDQ0LjExODQgMjIuMDMzQzQ0LjExODQgMjIuNTQ3OCA0NC4xMTg0IDIzLjA0NTkgNDQuMTE4NCAyMy41NjA2QzQ0LjExODQgMjMuNjkzNSA0NC4xMTg0IDIzLjgyNjMgNDQuMTE4NCAyMy45NDI1QzQ0LjExODQgMjQuMDkyIDQ0LjEwMTYgMjQuMjQxNCA0NC4wNjgyIDI0LjM5MDlDNDQuMDM0NyAyNC41NTY5IDQ0LjAwMTIgMjQuNzA2MyA0My45MTc2IDI0Ljg3MjRDNDMuODE3MiAyNS4wNTUgNDMuNjY2NiAyNS4yNTQzIDQzLjUzMjcgMjUuMjU0M0M0My4zOTg4IDI1LjIzNzcgNDMuMjgxNyAyNS4wMzg0IDQzLjE5OCAyNC44NzI0QzQzLjEzMTEgMjQuNzIzIDQzLjA5NzYgMjQuNTkwMSA0My4wOTc2IDI0LjQ1NzNDNDMuMDgwOSAyNC4zMDc4IDQzLjA4MDkgMjQuMTI1MiA0My4wODA5IDIzLjk1OTFDNDMuMDgwOSAyMi44NjMzIDQzLjA4MDkgMjEuODAwNiA0My4wODA5IDIwLjczNzlDNDMuMDgwOSAyMC4zMDYyIDQzLjA4MDkgMTkuODU3OSA0My4wODA5IDE5LjQyNjFDNDMuMDgwOSAxOS4yNzY3IDQzLjA4MDkgMTkuMTQzOSA0My4wODA5IDE4Ljk5NDRDNDMuMDY0MiAxOC41NDYxIDQzLjAxNCAxOC4wOTc4IDQyLjg0NjcgMTcuNjgyN0M0Mi41NDU1IDE2Ljk2ODcgNDEuODkyOSAxNi4zODc1IDQxLjE1NjcgMTYuMDM4OUM0MC42NzE0IDE1LjgwNjQgNDAuMTUyNyAxNS42OTAyIDM5LjYxNzIgMTUuNjU3QzM4Ljk5ODEgMTUuNjIzNyAzOC4zNjIzIDE1LjcwNjggMzcuNzU5OSAxNS44NzI4QzM3LjQwODUgMTUuOTU1OCAzNy4wNzM5IDE2LjA3MjEgMzYuNzU1OSAxNi4yMDQ5QzM2Ljc1NTkgMTUuNDkwOSAzNi43NzI3IDE0Ljc3NjkgMzYuNzcyNyAxNC4wNzk1QzM2Ljc3MjcgMTMuNzgwNyAzNi43NzI3IDEzLjQ5ODQgMzYuNzg5NCAxMy4xOTk1QzM2Ljc4OTQgMTMuMDgzMyAzNi44MDYxIDEyLjk4MzYgMzYuODA2MSAxMi44Njc0QzM2LjgyMjkgMTIuNjY4MiAzNi44MjI5IDEyLjQ2ODkgMzYuODU2MyAxMi4yNjk3QzM2Ljg3MzEgMTIuMDcwNCAzNi45MDY1IDExLjg1NDUgMzYuODM5NiAxMS43MzgzQzM2LjgwNjEgMTEuNjcxOSAzNi43NTU5IDExLjYzODcgMzYuNjcyMyAxMS42MDU1QzM2LjUzODQgMTEuNTU1NyAzNi4zNzExIDExLjU4ODkgMzYuMjAzOCAxMS42MjIxQzM2LjA1MzIgMTEuNjU1MyAzNS45MTkzIDExLjY3MTkgMzUuNzY4NyAxMS43MDUxQzM1LjYwMTQgMTEuNzM4MyAzNS40MzQgMTEuNzM4MyAzNS4yNjY3IDExLjc1NDlDMzQuOTMyMSAxMS43NzE1IDM0LjYxNDIgMTEuNzcxNSAzNC4yNzk1IDExLjc3MTVDMzMuNjQzNyAxMS43ODgxIDMzLjAwNzggMTEuNzg4MSAzMi4zNzIgMTEuNzg4MUMzMi4yNTQ4IDExLjk3MDggMzIuMjA0NiAxMi4xNTM0IDMyLjEzNzcgMTIuMzUyN1oiIGZpbGw9IiMyNjI2MjYiLz4KPHBhdGggZD0iTTEyLjg0ODYgMTguMDkyOEMxMy40NDMgMTUuODc4NyAxNC4wMTM3IDEzLjY4ODMgMTQuNTM2OCAxMS40NzQyQzE0LjY1NTcgMTAuOTc0MiAxNC43NzQ2IDEwLjQ3NDMgMTQuODkzNSA5Ljk5ODExQzE1LjA2IDkuMzU1MjkgMTUuMjI2NCA4LjczNjI4IDE1LjM5MjkgOC4xMTcyN0MxNS41MTE3IDcuNjY0OTIgMTUuNjA2OSA3LjIxMjU3IDE1LjcyNTcgNi43NjAyMkMxNS43OTcxIDYuNDUwNzIgMTUuODY4NCA2LjE2NTAyIDE1LjkxNiA1Ljg1NTUxQzE1Ljk2MzUgNS41OTM2MiAxNi4wMTExIDUuMzU1NTUgMTYuMDExMSA1LjA5MzY2QzE2LjAxMTEgNC43ODQxNiAxNS45NjM1IDQuNDUwODQgMTUuODkyMiA0LjE0MTM0QzE1LjgyMDkgMy43ODQyMiAxNS43MjU3IDMuNDUwOSAxNS41ODMxIDMuMTE3NTlDMTUuMjc0IDIuMzA4MTIgMTQuNzc0NiAxLjU3MDA3IDE0LjE1NjQgMC45NzQ4NzNDMTYuOTg2IDAuOTc0ODczIDE5LjgzOTQgMC45NzQ4NzMgMjIuNjY5IDAuOTc0ODczQzIyLjU5NzYgMS4wOTM5MSAyMi41MjYzIDEuMjEyOTUgMjIuNTAyNSAxLjM1NThDMjIuNDMxMiAxLjYxNzY5IDIyLjQwNzQgMS44Nzk1OCAyMi40MDc0IDIuMTY1MjdDMjIuNDMxMiAyLjg3OTUxIDIyLjU3MzkgMy41Njk5NSAyMi43NjQxIDQuMjM2NTdDMjIuOTc4MSA1LjA0NjA0IDIzLjIxNTkgNS44NTU1MiAyMy40NTM3IDYuNjY0OTlDMjMuODEwMyA3Ljg1NTM5IDI0LjE5MDggOS4wNjk1OSAyNC41NDc1IDEwLjI2QzI1LjMwODQgMTIuNzU5OCAyNi4wMjE3IDE1LjI1OTcgMjYuNzM1IDE3Ljc1OTVDMjcuMzUzMyAxNS4zNTQ5IDI3Ljk5NTMgMTIuOTUwMyAyOC43MzI0IDEwLjU2OTVDMjguODUxMyAxMC4xNDEgMjguOTk0IDkuNzEyNDEgMjkuMTEyOSA5LjI4Mzg3QzI5LjMyNjkgOC41NDU4MiAyOS41MTcxIDcuNzgzOTYgMjkuNzMxMSA3LjA0NTkxQzI5Ljg3MzggNi41Njk3NSAzMC4wMTY0IDYuMDkzNTkgMzAuMTM1MyA1LjYxNzQzQzMwLjIzMDQgNS4xODg4OSAzMC4zMjU2IDQuNzYwMzUgMzAuMzQ5MyA0LjMzMThDMzAuMzczMSAzLjk5ODQ5IDMwLjM3MzEgMy42NjUxOCAzMC4zMjU2IDMuMzMxODdDMzAuMjU0MiAyLjkyNzEzIDMwLjA4NzggMi41MjI0IDI5Ljg3MzggMi4xNDE0N0MyOS43MDczIDEuODc5NTggMjkuNTQwOSAxLjYxNzY5IDI5LjMyNjkgMS4zNzk2MUMyOS4yMDggMS4yMTI5NiAyOS4wNjUzIDEuMDcwMTEgMjguOTIyNiAwLjkyNzI2MkMzMC42MzQ3IDAuOTI3MjYyIDMyLjMyMjkgMC45MjcyNjIgMzQuMDM1IDAuOTI3MjYyQzM0LjMyMDMgMC45MjcyNjIgMzQuNTgxOSAwLjkyNzI2MiAzNC44NjcyIDAuOTI3MjYyQzM1LjEyODggMC45MjcyNjIgMzUuMzY2NSAwLjkwMzQ1MSAzNS42MjgxIDAuOTk4NjgzQzM1LjY3NTcgMS4wMjI0OSAzNS43MjMyIDEuMDIyNDkgMzUuNzQ3IDEuMDQ2M0MzNS44NDIxIDEuMTQxNTMgMzUuNzcwOCAxLjMzMiAzNS43MjMyIDEuNDk4NjVDMzUuNjI4MSAxLjc4NDM1IDM1LjU1NjggMi4wMjI0MyAzNS40NjE3IDIuMjM2N0MzMy4zNDU0IDguNjY0ODYgMzAuOTQzOCAxNi40NzM5IDI4Ljc4IDIzLjYxNjNDMjguNjYxMSAyNC4wNDQ4IDI4LjUxODQgMjQuNDQ5NiAyOC4zOTk1IDI0Ljg3ODFDMjguMzI4MiAyNS4wOTI0IDI4LjI4MDYgMjUuMzA2NiAyOC4yMDkzIDI1LjQ5NzFDMjguMTYxNyAyNS42MTYxIDI4LjExNDIgMjUuNzM1MiAyOC4wNjY2IDI1Ljg1NDJDMjguMDE5MSAyNS45NzMzIDI3Ljk3MTUgMjYuMTE2MSAyNy44NzY0IDI2LjE2MzdDMjcuNzU3NSAyNi4yMzUyIDI3LjU2NzMgMjYuMTg3NSAyNy40MDA4IDI2LjEzOTlDMjYuODc3NyAyNS45OTcxIDI2LjQ5NzMgMjUuODU0MiAyNi4wNjkzIDI1LjY2MzhDMjUuMzU1OSAyNS4zNTQzIDI0LjU5NSAyNC45NzMzIDIzLjg4MTcgMjQuNTQ0OEMyMy4yODcyIDI0LjE4NzcgMjIuNjkyOCAyMy44MDY3IDIyLjI2NDcgMjMuMjgzQzIxLjkwODEgMjIuODU0NCAyMS42NzAzIDIyLjMzMDYgMjEuNDU2MyAyMS44MDY5QzIxLjA3NTggMjAuOTAyMiAyMC43OTA1IDE5Ljk3MzcgMjAuNDgxNCAxOS4wNDUxQzIwLjA3NzIgMTcuODA3MSAxOS42NzI5IDE2LjU0NTMgMTkuMjkyNSAxNS4zMDczQzE4Ljg4ODIgMTMuOTc0IDE4LjUwNzggMTIuNjQwOCAxOC4xNzQ5IDExLjI4MzdDMTcuOTg0NyAxMS45NTA0IDE3Ljc5NDQgMTIuNjQwOCAxNy42MDQyIDEzLjMwNzRDMTcuMjk1MSAxNC40MDI2IDE3LjAwOTggMTUuNDczOSAxNi43MjQ0IDE2LjU2OTFDMTYuNDYyOSAxNy41NjkgMTYuMjI1MSAxOC41NDUyIDE1Ljk2MzUgMTkuNTQ1MUMxNS43NDk1IDIwLjQwMjIgMTUuNTExNyAyMS4yNTkzIDE1LjI3NCAyMi4wOTI2QzE1LjEwNzUgMjIuNzExNiAxNC45NjQ4IDIzLjMzMDYgMTQuODIyMiAyMy45MjU4QzE0Ljc1MDggMjQuMjM1MyAxNC42NTU3IDI0LjU2ODYgMTQuNTg0NCAyNC44NzgxQzE0LjUzNjggMjUuMTE2MiAxNC40NjU1IDI1LjMzMDUgMTQuNDE3OSAyNS41Njg1QzE0LjM5NDIgMjUuNjYzOCAxNC4zNzA0IDI1LjczNTIgMTQuMzQ2NiAyNS44MDY2QzE0LjMyMjggMjUuODU0MiAxNC4yNzUzIDI1LjkwMTggMTQuMjI3NyAyNS45NDk1QzE0LjA4NTEgMjYuMDY4NSAxMy44NDczIDI2LjA0NDcgMTMuNjA5NSAyNS45OTcxQzEzLjAzODggMjUuODc4IDEyLjU2MzIgMjUuNzExNCAxMi4wODc3IDI1LjQ5NzFDMTEuMjMxNyAyNS4xNCAxMC4zNTE5IDI0LjY4NzYgOS41NDM0MSAyNC4xNDAxQzkuMTg2NzQgMjMuOTAyIDguODUzODQgMjMuNjE2MyA4LjU2ODUgMjMuMzA2OEM4LjE4ODA1IDIyLjkwMiA3Ljg1NTE2IDIyLjQwMjEgNy41OTM2IDIxLjkwMjFDNy4xMTgwMyAyMS4wMjEyIDYuODA4OTIgMjAuMDkyNyA2LjQ3NjAzIDE5LjE0MDRDNi4wOTU1NyAxOC4wNDUyIDUuNzE1MTIgMTYuOTczOCA1LjMzNDY3IDE1Ljg3ODdDNC40MDczMiAxMy4xNDA4IDMuNTk4ODYgMTAuMzU1MiAyLjk1Njg1IDcuNTQ1ODhDMi43OTA0IDYuODU1NDUgMi42NDc3MyA2LjE2NTAyIDIuNTI4ODQgNS40NzQ1OUMyLjQ4MTI5IDUuMjEyNyAyLjQzMzczIDQuOTc0NjIgMi4zNjIzOSA0LjcxMjczQzIuMjY3MjggNC40MDMyMyAyLjEyNDYyIDQuMTQxMzQgMS45ODE5NSAzLjg1NTY0QzEuNjQ5MDUgMy4xODkwMiAxLjMzOTkzIDIuNDk4NTkgMC44NjQzNjggMS45NTFDMC42NzQxNDIgMS43MzY3MyAwLjQ2MDEzNiAxLjUyMjQ2IDAuMjIyMzU0IDEuMzMxOTlDMC4xNTEwMTkgMS4yNjA1NyAwLjA3OTY4ODcgMS4yMTI5NSAwLjA1NTkxMDUgMS4xMTc3MkMwLjAwODM1NDEzIDEuMDIyNDkgLTAuMDE1NDI3IDAuOTI3MjYzIDAuMDA4MzUxMjMgMC44MzIwMzFDMS43Njc5NCAwLjgzMjAzMSAzLjUwMzc1IDAuODMyMDMxIDUuMjYzMzQgMC44MzIwMzFDNS45MjkxMiAwLjgzMjAzMSA2LjU3MTE0IDAuODMyMDMxIDcuMjEzMTUgMC44MzIwMzFDNy40MDMzOCAwLjgzMjAzMSA3LjU5MzYgMC44MzIwMzEgNy44MDc2MSAwLjgzMjAzMUM3Ljk1MDI3IDAuODMyMDMxIDguMDkyOTQgMC44MzIwMjcgOC4yMTE4MyAwLjg3OTY0M0M4LjMzMDcyIDAuOTI3MjU5IDguNDI1ODQgMS4wNDYzIDguNDk3MTcgMS4xODkxNUM4LjYxNjA2IDEuMzc5NjIgOC42NjM2MiAxLjYxNzY5IDguNzExMTcgMS44MzE5NkM4LjkyNTE4IDIuNzEyODYgOS4xNjI5NiAzLjU0NjE0IDkuNDI0NTIgNC4zNzk0MkMxMC43MzIzIDkuMDIxOTggMTEuNjgzNCAxMy41OTMxIDEyLjg0ODYgMTguMDkyOFoiIGZpbGw9IiMyNjI2MjYiLz4KPHBhdGggZD0iTTQ4LjY4OTUgMjMuMTUzOUM0OS4wMzg0IDIzLjM0NyA0OS40MjYgMjMuNTQwMSA0OS43NzQ5IDIzLjY5NDZDNTAuMDQ2MyAyMy44NDkgNTAuMzU2NCAyMy45NjQ5IDUwLjYyNzggMjQuMDgwN0M1MS4wMTU1IDI0LjE5NjYgNTEuNDAzMSAyNC4yNzM4IDUxLjc5MDggMjQuMzEyNEM1Mi4yOTQ4IDI0LjM4OTcgNTIuODM3NSAyNC40MjgzIDUzLjM0MTUgMjQuMjM1MkM1My41MzUzIDI0LjE1OCA1My43MjkyIDI0LjA4MDcgNTMuODQ1NSAyMy45MjYzQzUzLjkyMyAyMy43NzE4IDUzLjk2MTggMjMuNjE3MyA1My45NjE4IDIzLjQyNDJDNTMuOTYxOCAyMy4yNjk4IDUzLjg4NDIgMjMuMTE1MyA1My44MDY3IDIyLjk5OTRDNTMuNjkwNCAyMi44NDUgNTMuNDk2NiAyMi43Njc3IDUzLjMwMjcgMjIuNjkwNUM1Mi43OTg4IDIyLjQ1ODggNTIuMzMzNiAyMi4yMjcxIDUxLjg2ODMgMjEuOTk1NEM1MS40NDE5IDIxLjgwMjMgNTAuOTc2NyAyMS42MDkyIDUwLjU1MDMgMjEuMzc3NUM1MC4yNDAxIDIxLjE4NDQgNDkuOTMgMjAuOTkxMyA0OS42NTg2IDIwLjcyMUM0OS4zNDg1IDIwLjQxMjEgNDkuMTE1OSAyMC4wMjU5IDQ4Ljk5OTYgMTkuNjAxMUM0OC44ODMzIDE5LjE3NjMgNDguOTIyMSAxOC43MTI5IDQ5LjAzODQgMTguMjQ5NUM0OS4xOTM0IDE3Ljc4NjEgNDkuNDY0OCAxNy4zNjEzIDQ5Ljc3NDkgMTcuMDEzN0M1MC4zOTUyIDE2LjM5NTggNTEuMjA5MyAxNi4wMDk3IDUyLjA2MjIgMTUuODE2NkM1Mi42NDM3IDE1LjcwMDcgNTMuMTg2NCAxNS42NjIxIDUzLjc2NzkgMTUuNjYyMUM1NC4zNDk0IDE1LjY2MjEgNTQuOTY5NyAxNS43MDA3IDU1LjQ3MzcgMTUuNzc4QzU1LjY2NzUgMTUuODE2NiA1NS44NjEzIDE1Ljg1NTIgNTYuMTMyNyAxNS44OTM4QzU2LjMyNjYgMTUuOTMyNCA1Ni41NTkyIDE2LjAwOTcgNTYuNzE0MiAxNi4wODY5QzU2Ljc5MTggMTYuMTI1NSA1Ni44NjkzIDE2LjIwMjggNTYuOTQ2OCAxNi4zMTg2QzU2Ljk4NTYgMTYuMzk1OCA1Ny4wMjQ0IDE2LjQ3MzEgNTcuMDI0NCAxNi41ODg5QzU3LjAyNDQgMTYuNjY2MiA1Ny4wMjQ0IDE2Ljc0MzQgNTcuMDI0NCAxNi44MjA2QzU3LjAyNDQgMTcuMzk5OSA1Ny4wMjQ0IDE3Ljk0MDYgNTcuMDI0NCAxOC41MTk4QzU2Ljc5MTcgMTguMzY1MyA1Ni41OTc5IDE4LjI0OTUgNTYuMzY1MyAxOC4xMzM2QzU2LjA5MzkgMTguMDE3OCA1NS44MjI2IDE3LjkwMTkgNTUuNTUxMiAxNy44MjQ3QzU1LjA4NiAxNy43MDg4IDU0LjY1OTYgMTcuNjcwMiA1NC4xOTQ0IDE3LjY3MDJDNTMuOTYxOCAxNy42NzAyIDUzLjcyOTIgMTcuNzA4OCA1My40OTY2IDE3Ljc4NjFDNTMuMzAyNyAxNy44NjMzIDUzLjEwODkgMTguMDE3OCA1My4wNzAxIDE4LjIxMDlDNTMuMDMxMyAxOC4zNjUzIDUzLjEwODkgMTguNTk3IDUzLjE4NjQgMTguNzEyOUM1My4zNDE1IDE4Ljk0NDYgNTMuNjEyOSAxOS4wMjE4IDUzLjg4NDIgMTkuMTM3N0M1NC40MjcgMTkuMzMwOCA1NC45Njk3IDE5LjQ4NTMgNTUuNTEyNSAxOS42NzgzQzU1LjkzODkgMTkuODMyOCA1Ni4zNjUzIDIwLjAyNTkgNTYuNzUzIDIwLjI1NzZDNTcuMjk1NyAyMC42MDUyIDU3Ljc5OTcgMjEuMTA3MiA1OC4wNzExIDIxLjcyNTFDNTguMzQyNCAyMi4zODE2IDU4LjMwMzcgMjMuMTUzOSA1OC4wMzIzIDIzLjc3MThDNTcuNzYwOSAyNC4zODk3IDU3LjI1NyAyNC44OTE3IDU2LjY3NTUgMjUuMjM5M0M1Ni4xMzI3IDI1LjU4NjggNTUuNTEyNCAyNS43Nzk5IDU0Ljg5MjIgMjUuODk1N0M1NC4xOTQ0IDI2LjA1MDIgNTMuNDU3OCAyNi4wODg4IDUyLjc2IDI2LjA4ODhDNTEuOTQ1OSAyNi4wODg4IDUxLjEzMTggMjUuOTczIDUwLjM5NTIgMjUuODU3MUM1MC4xMjM4IDI1LjgxODUgNDkuODUyNSAyNS43Nzk5IDQ5LjU0MjMgMjUuNzAyN0M0OS40MjYgMjUuNjY0IDQ5LjM0ODUgMjUuNjI1NCA0OS4yNzEgMjUuNTQ4MkM0OS4yMzIyIDI1LjQ3MSA0OS4xOTM0IDI1LjM1NTEgNDkuMTkzNCAyNS4yNzc5QzQ5LjE1NDcgMjUuMTIzNCA0OS4xNTQ3IDI1LjAwNzYgNDkuMTE1OSAyNC44OTE3QzQ4Ljk5OTYgMjQuNDI4MyA0OC44NDQ1IDIzLjg0OSA0OC42ODk1IDIzLjE1MzlaIiBmaWxsPSIjMjYyNjI2Ii8+CjxwYXRoIGQ9Ik02Mi44ODM3IDI0LjAwMTVDNjMuMDI0NiAyNC4zNzg0IDYzLjE2NTQgMjQuNzU1MyA2My4zMDYyIDI1LjEzMjJDNjMuMzUzMiAyNS4zMjA3IDYzLjQ0NzEgMjUuNDYyIDYzLjQ5NCAyNS42NTA1QzYzLjU0MSAyNS43NDQ3IDYzLjU4NzkgMjUuODg2MSA2My42ODE4IDI1LjkzMzJDNjMuODIyNiAyNi4wMjc0IDY0LjAxMDQgMjYuMDc0NSA2NC4xOTgyIDI2LjA3NDVDNjQuNDc5OSAyNi4wNzQ1IDY0LjcxNDYgMjYuMDc0NSA2NC45OTYzIDI2LjA3NDVDNjUuMjMxIDI2LjA3NDUgNjUuNDY1NyAyNi4wNzQ1IDY1LjY1MzUgMjYuMDc0NUM2Ni4wNzYgMjYuMDI3NCA2Ni40NTE2IDI1Ljg4NjEgNjYuODI3MiAyNS42OTc2QzY3LjIwMjcgMjUuNTA5MiA2Ny41MzEzIDI1LjMyMDcgNjcuODYgMjUuMDM4QzY4LjMyOTQgMjQuNjE0IDY4Ljc1MTkgMjQuMDk1NyA2OC45ODY2IDIzLjUzMDNDNjkuMzYyMiAyMi43Mjk0IDY5LjU1IDIxLjc4NzEgNjkuNTUgMjAuODkxOUM2OS41NSAyMC4yMzIzIDY5LjUwMyAxOS42MTk4IDY5LjMxNTMgMTkuMDA3M0M2OS4xMjc1IDE4LjQ0MTkgNjguODkyNyAxNy44NzY1IDY4LjUxNzIgMTcuNDA1NEM2OC4wOTQ3IDE2Ljg0IDY3LjU3ODMgMTYuMzY4OCA2Ni45NjggMTYuMDM5QzY2LjQwNDYgMTUuODAzNSA2NS43OTQ0IDE1LjcwOTIgNjUuMTg0MSAxNS42NjIxQzY0LjgwODUgMTUuNjYyMSA2NC40MzI5IDE1LjY2MjEgNjQuMTA0MyAxNS43NTYzQzYzLjkxNjUgMTUuODAzNSA2My42ODE4IDE1Ljg5NzcgNjMuNDk0IDE2LjAzOUM2My4zMDYyIDE2LjEzMzMgNjMuMTE4NSAxNi4yMjc1IDYyLjkzMDcgMTYuMjI3NUM2Mi44MzY4IDE2LjIyNzUgNjIuNjk1OSAxNi4xMzMzIDYyLjY0OSAxNi4wODYyQzYyLjYwMiAxNS45OTE5IDYyLjYwMjEgMTUuODUwNiA2Mi41MDgyIDE1Ljc1NjNDNjIuNDYxMiAxNS43MDkyIDYyLjM2NzMgMTUuNjYyMSA2Mi4yNzM0IDE1LjY2MjFDNjIuMTc5NSAxNS42NjIxIDYyLjA4NTcgMTUuNzU2MyA2MS45OTE4IDE1LjgwMzVDNjEuODA0IDE1Ljg5NzcgNjEuNjE2MiAxNS44OTc3IDYxLjQyODQgMTUuOTQ0OEM2MS4yNDA2IDE1Ljk0NDggNjEuMDk5OCAxNS45NDQ4IDYwLjkxMiAxNS45NDQ4QzYwLjIwNzggMTUuOTQ0OCA1OS41MDM3IDE1Ljk0NDggNTguODQ2NCAxNS45NDQ4QzU4LjcwNTYgMTUuOTQ0OCA1OC42MTE3IDE1Ljk0NDggNTguNDcwOSAxNS45NDQ4QzU4LjMzIDE1Ljk0NDggNTguMTg5MiAxNS45NDQ4IDU4LjE0MjIgMTUuOTkxOUM1OC4wOTUzIDE2LjAzOSA1OC4wNDgzIDE2LjA4NjEgNTguMDQ4MyAxNi4xODA0QzU4LjA0ODMgMTYuMjI3NSA1OC4wOTUzIDE2LjI3NDYgNTguMTQyMiAxNi4zNjg4QzU4LjIzNjEgMTYuNTU3MyA1OC4zNzcgMTYuNjk4NiA1OC41MTc4IDE2Ljg4NzFDNTguNjExNyAxNy4wMjg0IDU4LjcwNTYgMTcuMTIyNyA1OC43NTI1IDE3LjI2NEM1OC44NDY0IDE3LjQ1MjUgNTguNzk5NSAxNy42ODgxIDU4Ljc5OTUgMTcuOTIzNkM1OC43OTk1IDE4LjA2NSA1OC43OTk1IDE4LjIwNjMgNTguNzk5NSAxOC4zOTQ4QzU4Ljc5OTUgMTguOTEzMSA1OC43OTk1IDE5LjQzMTMgNTguNzk5NSAxOS45NDk2QzU4Ljc5OTUgMjAuNTYyMSA1OC43OTk1IDIxLjEyNzUgNTguNzk5NSAyMS43NEM1OC43OTk1IDIzLjY3MTcgNTguNzUyNSAyNS42NTA1IDU4Ljc5OTUgMjcuNTgyMkM1OC43OTk1IDI3LjkxMiA1OC43OTk1IDI4LjI0MTggNTguNzk5NSAyOC41NzE2QzU4Ljc5OTUgMjguNzYwMSA1OC43OTk1IDI4Ljk0ODUgNTguNzUyNSAyOS4wODk5QzU4LjcwNTYgMjkuMjc4MyA1OC42MTE3IDI5LjQ2NjggNTguNDcwOSAyOS42NTUzQzU4LjMzIDI5Ljg0MzcgNTguMjM2MSAyOS45ODUxIDU4LjA0ODMgMzAuMTczNUM1OS43ODUzIDMwLjE3MzUgNjEuNDc1NCAzMC4xNzM1IDYzLjIxMjMgMzAuMTczNUM2My4xMTg1IDMwLjA3OTMgNjMuMDI0NiAyOS45ODUxIDYyLjkzMDcgMjkuODkwOEM2Mi43NDI5IDI5LjcwMjQgNjIuNjAyMSAyOS40NjY4IDYyLjUwODIgMjkuMTg0MUM2Mi40NjEyIDI4Ljk5NTcgNjIuNDE0MyAyOC44MDcyIDYyLjQxNDMgMjguNjE4N0M2Mi40MTQzIDI4LjM4MzIgNjIuNDE0MyAyOC4xMDA1IDYyLjQxNDMgMjcuODY0OUM2Mi40MTQzIDI3LjQ4OCA2Mi40MTQzIDI3LjE1ODIgNjIuNDE0MyAyNi43ODEyQzYyLjQxNDMgMjQuNzU1MyA2Mi40MTQzIDIyLjc3NjUgNjIuNDE0MyAyMC43NTA1QzYyLjQxNDMgMjAuNTYyMSA2Mi40MTQzIDIwLjM3MzYgNjIuNDE0MyAyMC4xODUyQzYyLjQxNDMgMTkuOTQ5NiA2Mi40MTQzIDE5LjcxNCA2Mi40NjEyIDE5LjUyNTVDNjIuNTA4MiAxOS4yOSA2Mi41NTUxIDE5LjA1NDQgNjIuNjQ5IDE4Ljg2NTlDNjIuNzQyOSAxOC42MzA0IDYyLjkzMDcgMTguNDQxOSA2My4xNjU0IDE4LjM0NzdDNjMuMzUzMiAxOC4yNTM0IDYzLjU0MSAxOC4yMDYzIDYzLjcyODcgMTguMjA2M0M2My45MTY1IDE4LjIwNjMgNjQuMTUxMyAxOC4yMDYzIDY0LjMzOSAxOC4zMDA2QzY0LjYyMDcgMTguMzk0OCA2NC44MDg1IDE4LjU4MzIgNjQuOTk2MyAxOC44MTg4QzY1LjEzNzEgMTkuMDU0NCA2NS4yMzEgMTkuMzM3MSA2NS4zMjQ5IDE5LjYxOThDNjUuNDE4OCAxOS45OTY3IDY1LjUxMjcgMjAuMzczNiA2NS41NTk2IDIwLjc5NzdDNjUuNjA2NiAyMS4yNjg4IDY1LjYwNjYgMjEuNzM5OSA2NS41MTI3IDIyLjI1ODJDNjUuNDY1NyAyMi42ODIyIDY1LjM3MTggMjMuMDU5MiA2NS4xODQxIDIzLjM4OUM2NS4wOTAyIDIzLjU3NzQgNjQuOTAyNCAyMy43NjU5IDY0LjcxNDYgMjMuOTA3MkM2NC40Nzk5IDI0LjA0ODYgNjQuMTk4MiAyNC4xNDI4IDYzLjkxNjUgMjQuMTg5OUM2My41ODc5IDI0LjA5NTcgNjMuMjU5MyAyNC4wOTU3IDYyLjg4MzcgMjQuMDAxNVoiIGZpbGw9IiMyNjI2MjYiLz4KPHBhdGggZD0iTTgwLjQ5NzUgMjMuMDExMkM4MC40OTM2IDIzLjAzMzEgODAuNDkzNiAyMy4wNTEgODAuNDg5NiAyMy4wNjY5QzgwLjQ1NzggMjMuMTYyMyA4MC40MjYgMjMuMjU1NyA4MC4zOTQyIDIzLjM1MTFDODAuMzY0MyAyMy40Mzg2IDgwLjMzMDYgMjMuNTI2MSA4MC4zMDA3IDIzLjYxNTVDODAuMjcwOSAyMy43MDMgODAuMjQ1MSAyMy43OTI0IDgwLjIxNTMgMjMuODgxOUM4MC4xNzM1IDI0LjAwMzEgODAuMTI3OCAyNC4xMjQ0IDgwLjA4NDEgMjQuMjQ1N0M4MC4wNDIzIDI0LjM2MjkgODAuMDAwNiAyNC40NzgyIDc5Ljk1NjkgMjQuNTk1NUM3OS45MjExIDI0LjY5NDkgNzkuODgxMyAyNC43OTQzIDc5Ljg0NTUgMjQuODkzN0M3OS44MTU3IDI0Ljk3OTEgNzkuNzgzOSAyNS4wNjI2IDc5Ljc2MDEgMjUuMTUwMUM3OS43MDQ0IDI1LjM0MjkgNzkuNTg5MSAyNS40ODYgNzkuNDEwMiAyNS41Nzc1Qzc5LjI1NTIgMjUuNjU5IDc5LjA5NjEgMjUuNzMwNSA3OC45MzEyIDI1Ljc5MjFDNzguODQxNyAyNS44MjU5IDc4Ljc1MDMgMjUuODQ5OCA3OC42NTg4IDI1Ljg3OTZDNzguNTgxMyAyNS45MDM1IDc4LjUwNTggMjUuOTI5MyA3OC40MjgyIDI1Ljk1MTJDNzguMzY4NiAyNS45NjkxIDc4LjMwNyAyNS45ODMgNzguMjQ3NCAyNS45OTY5Qzc4LjE3OTggMjYuMDE0OCA3OC4xMTQyIDI2LjAzMjcgNzguMDQ2NiAyNi4wNDg2Qzc4LjAwNjggMjYuMDU4NSA3Ny45NjcxIDI2LjA2NjUgNzcuOTI1MyAyNi4wNzQ0Qzc3Ljg3MzcgMjYuMDg2MyA3Ny44MjIgMjYuMDk2MyA3Ny43NzAzIDI2LjEwODJDNzcuNzMyNSAyNi4xMTYyIDc3LjY5NjcgMjYuMTI0MSA3Ny42NTkgMjYuMTMwMUM3Ny42MDMzIDI2LjE0IDc3LjU0NzcgMjYuMTQ2IDc3LjQ5MiAyNi4xNTU5Qzc3LjQyNDQgMjYuMTY1OCA3Ny4zNTg4IDI2LjE3NzggNzcuMjkxMiAyNi4xODc3Qzc3LjI4NzMgMjYuMTg3NyA3Ny4yODEzIDI2LjE4OTcgNzcuMjc3MyAyNi4xODk3Qzc3LjE5NTggMjYuMTk3NyA3Ny4xMTIzIDI2LjIwNTYgNzcuMDMwOCAyNi4yMTU1Qzc2LjkzMTQgMjYuMjI1NSA3Ni44MzAxIDI2LjIzNTQgNzYuNzMwNyAyNi4yNDczQzc2LjcyMDcgMjYuMjQ5MyA3Ni43MTA4IDI2LjI0OTMgNzYuNzAwOSAyNi4yNTEzQzc2LjQwNDcgMjYuMjYxMyA3Ni4xMDg1IDI2LjI4MzEgNzUuODEyMyAyNi4yNzEyQzc1LjY4MTEgMjYuMjY1MiA3NS41NDk5IDI2LjI2MTMgNzUuNDIwNyAyNi4yNTEzQzc1LjMxNTQgMjYuMjQzNCA3NS4yMSAyNi4yMjk1IDc1LjEwNDcgMjYuMjE5NUM3NS4wMjMyIDI2LjIxMTYgNzQuOTM5NyAyNi4yMDU2IDc0Ljg1ODIgMjYuMTk1N0M3NC43ODg2IDI2LjE4NzcgNzQuNzE5IDI2LjE3MzggNzQuNjQ3NSAyNi4xNjE5Qzc0LjYwMzggMjYuMTUzOSA3NC41NiAyNi4xNDYgNzQuNTE2MyAyNi4xNEM3NC40NjQ2IDI2LjEzMjEgNzQuNDEwOSAyNi4xMjQxIDc0LjM1OTMgMjYuMTE0MkM3NC4zMTE1IDI2LjEwNjIgNzQuMjY1OCAyNi4wOTIzIDc0LjIyMDEgMjYuMDgyNEM3NC4xODQzIDI2LjA3NDQgNzQuMTQ4NiAyNi4wNjY1IDc0LjExNDggMjYuMDU4NUM3NC4wMTU0IDI2LjAzMjcgNzMuOTE0IDI2LjAwODggNzMuODE0NiAyNS45ODFDNzMuNzE5MiAyNS45NTUxIDczLjYyMTggMjUuOTI3MyA3My41MjY0IDI1Ljg5NTVDNzMuNDI1IDI1Ljg2MTcgNzMuMzIzNiAyNS44MjIgNzMuMjIyMiAyNS43ODIyQzczLjEwMyAyNS43MzQ1IDcyLjk4MzcgMjUuNjg4OCA3Mi44Njg0IDI1LjYzNTFDNzIuNTc2MiAyNS40OTk5IDcyLjI5MzkgMjUuMzQ0OSA3Mi4wMjc2IDI1LjE2QzcxLjY5MzYgMjQuOTI5NCA3MS4zODU1IDI0LjY2OSA3MS4xMjEyIDI0LjM2MDlDNzAuODkyNiAyNC4wOTQ2IDcwLjY5OTcgMjMuODAyNCA3MC41NDY3IDIzLjQ4NjNDNzAuNDc1MSAyMy4zMzcyIDcwLjQxMTUgMjMuMTg0MiA3MC4zNTU5IDIzLjAyOTFDNzAuMzIyMSAyMi45MzU3IDcwLjI5NjIgMjIuODM4MyA3MC4yNzA0IDIyLjc0MDlDNzAuMjQ0NSAyMi42NDk1IDcwLjIxODcgMjIuNTU4IDcwLjE5NjggMjIuNDY0NkM3MC4xNzg5IDIyLjM4MTEgNzAuMTY1IDIyLjI5NTYgNzAuMTUxMSAyMi4yMTIxQzcwLjE0MTIgMjIuMTUyNSA3MC4xMjkzIDIyLjA5MjkgNzAuMTE5MyAyMi4wMzEzQzcwLjExOTMgMjIuMDI3MyA3MC4xMTczIDIyLjAyNTMgNzAuMTE3MyAyMi4wMjEzQzcwLjEwOTQgMjEuOTU5NyA3MC4xMDE0IDIxLjg5NjEgNzAuMDk1NSAyMS44MzQ1QzcwLjA2OTYgMjEuNTg0IDcwLjA2NzYgMjEuMzMxNiA3MC4wNzM2IDIxLjA4MTFDNzAuMDc3NiAyMC45NDM5IDcwLjA4NTUgMjAuODA2OCA3MC4wOTc0IDIwLjY2OTZDNzAuMTA1NCAyMC41NjIzIDcwLjExOTMgMjAuNDU2OSA3MC4xMzcyIDIwLjM0OTZDNzAuMTUxMSAyMC4yNTQyIDcwLjE3MyAyMC4xNTg4IDcwLjE5MDkgMjAuMDYzNEM3MC4yMDQ4IDE5Ljk4NTggNzAuMjE4NyAxOS45MDgzIDcwLjIzNjYgMTkuODMwOEM3MC4yNTI1IDE5Ljc2MzIgNzAuMjcyNCAxOS42OTc2IDcwLjI5MDMgMTkuNjNDNzAuMzEyMSAxOS41NDg1IDcwLjMzMiAxOS40NjcgNzAuMzU1OSAxOS4zODc1QzcwLjM3NzcgMTkuMzE0IDcwLjQwMzYgMTkuMjQwNCA3MC40Mjc0IDE5LjE2ODlDNzAuNDUzMyAxOS4wOTEzIDcwLjQ4MTEgMTkuMDEzOCA3MC41MDg5IDE4LjkzODNDNzAuNTU2NiAxOC44MTcgNzAuNjAwNCAxOC42OTE4IDcwLjY1NiAxOC41NzQ1QzcwLjczNzUgMTguMzk5NiA3MC44MjEgMTguMjI0NyA3MC45MTY0IDE4LjA1NzdDNzEuMTQzIDE3LjY1NjIgNzEuNDE5MyAxNy4yODg0IDcxLjc1MzMgMTYuOTY4NEM3Mi4wOTEyIDE2LjY0MjQgNzIuNDY4OSAxNi4zNzIgNzIuODgyMyAxNi4xNTM0QzczLjA0MTQgMTYuMDY5OSA3My4yMDQ0IDE1Ljk5MjQgNzMuMzcxMyAxNS45MjQ4QzczLjQ5MDYgMTUuODc3MSA3My42MTE4IDE1LjgzNzMgNzMuNzMzMSAxNS43OTc2QzczLjgzNjUgMTUuNzYzOCA3My45Mzk4IDE1LjczMiA3NC4wNDMyIDE1LjcwNDFDNzQuMTE0OCAxNS42ODQzIDc0LjE4ODMgMTUuNjcyMyA3NC4yNTk5IDE1LjY1ODRDNzQuMzQ5MyAxNS42NDA1IDc0LjQ0MDggMTUuNjIwNyA3NC41MzAyIDE1LjYwNDhDNzQuNTkzOCAxNS41OTQ4IDc0LjY1NzQgMTUuNTg2OSA3NC43MjEgMTUuNTgwOUM3NC44NjAyIDE1LjU2OSA3NS4wMDEzIDE1LjU1OSA3NS4xNDI0IDE1LjU1MzFDNzUuMjUzOCAxNS41NDkxIDc1LjM2NTEgMTUuNTUxMSA3NS40NzQ0IDE1LjU1MzFDNzUuNTA4MiAxNS41NTMxIDc1LjU0NCAxNS41NTUxIDc1LjU3NzggMTUuNTU5Qzc1LjY5NSAxNS41NjcgNzUuODEyMyAxNS41NzEgNzUuOTI5NiAxNS41ODQ5Qzc2LjAzNSAxNS41OTY4IDc2LjEzODMgMTUuNjE4NyA3Ni4yNDE3IDE1LjYzNjZDNzYuMjg5NCAxNS42NDQ1IDc2LjMzOTEgMTUuNjUyNSA3Ni4zODY4IDE1LjY2MjRDNzYuNDI4NSAxNS42NzA0IDc2LjQ3MDMgMTUuNjgyMyA3Ni41MTIgMTUuNjkyMkM3Ni41NDc4IDE1LjcwMDIgNzYuNTgxNiAxNS43MTAxIDc2LjYxNzQgMTUuNzIwMUM3Ni43MDQ4IDE1Ljc0MzkgNzYuNzkwMyAxNS43Njc4IDc2Ljg3NzggMTUuNzk1NkM3Ni45NTkzIDE1LjgyMTQgNzcuMDM4OCAxNS44NTEyIDc3LjEyMDMgMTUuODc5MUM3Ny4yNTc0IDE1LjkyNDggNzcuMzg4NiAxNS45ODI0IDc3LjUxNzggMTYuMDQ0MUM3Ny43NDY0IDE2LjE1MzQgNzcuOTY3MSAxNi4yNzY2IDc4LjE3NzggMTYuNDE5N0M3OC41NDk1IDE2LjY3MDIgNzguODg1NCAxNi45NjI0IDc5LjE4MTYgMTcuMzAyM0M3OS40NTIgMTcuNjEyNCA3OS42Nzg2IDE3Ljk1MDMgNzkuODU3NSAxOC4zMjIxQzc5LjkzMSAxOC40NzUxIDc5Ljk5MjYgMTguNjMwMiA4MC4wNDgzIDE4Ljc4OTJDODAuMDg2MSAxOC44OTY1IDgwLjExNzkgMTkuMDA3OCA4MC4xNDc3IDE5LjExOTJDODAuMTczNSAxOS4yMTg1IDgwLjE5MzQgMTkuMzIxOSA4MC4yMTMzIDE5LjQyMzNDODAuMjMxMiAxOS41MTQ3IDgwLjI0OTEgMTkuNjA4MiA4MC4yNjY5IDE5LjY5OTZDODAuMjc2OSAxOS43NDkzIDgwLjI4MjggMTkuODAxIDgwLjI4ODggMTkuODUwN0M4MC4yOTg4IDE5Ljk0NjEgODAuMzAyNyAyMC4wNDE1IDgwLjMxNDcgMjAuMTM2OUM4MC4zMzI1IDIwLjI4NiA4MC4zMzQ1IDIwLjQzNTEgODAuMzM0NSAyMC41ODIyQzgwLjMzNDUgMjAuNzE1MyA4MC4zMzI1IDIwLjg1MDUgODAuMzMyNSAyMC45ODM3QzgwLjMzMjUgMjEuMDAzNiA4MC4zMjg2IDIxLjAyMzUgODAuMzI2NiAyMS4wNDUzQzgwLjMwMDcgMjEuMDQ3MyA4MC4yNzY5IDIxLjA0OTMgODAuMjU1IDIxLjA0OTNDNzkuMTUzOCAyMS4wNDkzIDc4LjA1MjYgMjEuMDQ5MyA3Ni45NTEzIDIxLjA1MTNDNzUuOTI5NiAyMS4wNTEzIDc0LjkwNzkgMjEuMDUzMyA3My44ODYyIDIxLjA1NTNDNzMuODA0NyAyMS4wNTUzIDczLjgwNDcgMjEuMDU3MiA3My44MDA3IDIxLjEzODdDNzMuNzkwNyAyMS4yODc4IDczLjgwODYgMjEuNDM2OSA3My44MjA2IDIxLjU4NEM3My44Mjg1IDIxLjY4MzQgNzMuODUyNCAyMS43ODI4IDczLjg3NDIgMjEuODgwMkM3My44OTQxIDIxLjk2OTYgNzMuOTEyIDIyLjA2MTEgNzMuOTM5OCAyMi4xNDY2Qzc0LjAwOTQgMjIuMzYxMiA3NC4xMDI4IDIyLjU2NCA3NC4yMjQxIDIyLjc1NDhDNzQuNDYwNiAyMy4xMjQ1IDc0Ljc2NjggMjMuNDIwNyA3NS4xMzQ1IDIzLjY1OTNDNzUuMjk3NSAyMy43NjQ2IDc1LjQ2ODQgMjMuODUyMSA3NS42NDczIDIzLjkyMzZDNzUuNzU2NyAyMy45Njc0IDc1Ljg2OCAyNC4wMDUxIDc1Ljk4NTMgMjQuMDMxQzc2LjA1NjggMjQuMDQ2OSA3Ni4xMjg0IDI0LjA2ODcgNzYuMTk5OSAyNC4wODI3Qzc2LjI1NzYgMjQuMDk0NiA3Ni4zMTcyIDI0LjEwMDUgNzYuMzc2OSAyNC4xMDg1Qzc2LjQ3NjIgMjQuMTIwNCA3Ni41NzM2IDI0LjEzMDQgNzYuNjczIDI0LjEzODNDNzYuODA0MiAyNC4xNDgyIDc2LjkzNzQgMjQuMTQ4MiA3Ny4wNzA2IDI0LjEzNjNDNzcuMTA2NCAyNC4xMzIzIDc3LjE0NDEgMjQuMTMwNCA3Ny4xNzk5IDI0LjEyODRDNzcuMjc1MyAyNC4xMjA0IDc3LjM3MDcgMjQuMTE2NCA3Ny40NjYyIDI0LjEwMjVDNzcuNTYzNiAyNC4wODg2IDc3LjY2MSAyNC4wNjg3IDc3Ljc1NjQgMjQuMDUwOEM3Ny44MzM5IDI0LjAzNjkgNzcuOTExNCAyNC4wMjMgNzcuOTg4OSAyNC4wMDUxQzc4LjA1NDUgMjMuOTkxMiA3OC4xMTgyIDIzLjk3MTMgNzguMTgzNyAyMy45NTM0Qzc4LjI0MTQgMjMuOTM3NSA3OC4zMDEgMjMuOTIzNiA3OC4zNTg3IDIzLjkwNzdDNzguNDEwNCAyMy44OTM4IDc4LjQ2MiAyMy44Nzc5IDc4LjUxMzcgMjMuODZDNzguNTgzMyAyMy44MzgyIDc4LjY1MDkgMjMuODE0MyA3OC43MTg1IDIzLjc5MDRDNzguNzkgMjMuNzY0NiA3OC44NTk2IDIzLjczODggNzguOTI5MiAyMy43MTI5Qzc5LjAwMjcgMjMuNjg1MSA3OS4wNzYzIDIzLjY1OTMgNzkuMTQ5OCAyMy42MzE0Qzc5LjI1NTIgMjMuNTg5NyA3OS4zNjA1IDIzLjU0NzkgNzkuNDYzOSAyMy41MDQyQzc5LjU3NzIgMjMuNDU2NSA3OS42ODg1IDIzLjQwNjggNzkuNzk3OCAyMy4zNTMxQzc5Ljk3MDggMjMuMjcxNiA4MC4xNDE3IDIzLjE4NjIgODAuMzE0NyAyMy4xMDI3QzgwLjM2ODMgMjMuMDc2OCA4MC40MTggMjMuMDQ3IDgwLjQ3MTcgMjMuMDIxMkM4MC40NzM3IDIzLjAxMzIgODAuNDgxNiAyMy4wMTUyIDgwLjQ5NzUgMjMuMDExMlpNNzMuNzc0OCAxOS4yMzA1Qzc0Ljc1ODggMTkuMjMwNSA3NS43MzQ4IDE5LjIzMDUgNzYuNzE0OCAxOS4yMzA1Qzc2LjcxNjggMTkuMjEwNiA3Ni43MTg4IDE5LjE5NDcgNzYuNzIyNyAxOS4xNzg4Qzc2LjczMjcgMTkuMDk5MyA3Ni43MjI3IDE5LjAxOTggNzYuNzIwNyAxOC45NDAzQzc2LjcxNjggMTguODQ0OCA3Ni42OTY5IDE4Ljc1MzQgNzYuNjc1IDE4LjY2MkM3Ni42NDcyIDE4LjU1NjYgNzYuNjA5NCAxOC40NTUyIDc2LjU1OTcgMTguMzU5OEM3Ni40NzYyIDE4LjE5MjkgNzYuMzY2OSAxOC4wNDc3IDc2LjIxOTggMTcuOTMwNUM3Ni4xNTQyIDE3Ljg3ODggNzYuMDg0NyAxNy44MzUxIDc2LjAwOTEgMTcuNzk3M0M3NS45MzU2IDE3Ljc2MTUgNzUuODYyIDE3LjcyNzcgNzUuNzg2NSAxNy42OTk5Qzc1LjcxMjkgMTcuNjc0IDc1LjYzNTQgMTcuNjU0MiA3NS41NTc5IDE3LjYzODNDNzUuNDcyNCAxNy42MjA0IDc1LjM4NSAxNy42MTI0IDc1LjI5NzUgMTcuNjA4NEM3NS4yNDk4IDE3LjYwNjUgNzUuMjAyMSAxNy42MTg0IDc1LjE1NDQgMTcuNjIwNEM3NS4wNzA5IDE3LjYyNDMgNzQuOTkxNCAxNy42NDQyIDc0LjkxMTkgMTcuNjY4MUM3NC43NzI3IDE3LjcwOTggNzQuNjM3NSAxNy43Njc1IDc0LjUxNDMgMTcuODQ1Qzc0LjI4OTcgMTcuOTgyMSA3NC4xMTQ4IDE4LjE2NSA3My45OTM1IDE4LjM5NzZDNzMuOTQ1OCAxOC40OTEgNzMuOTAwMSAxOC41ODQ0IDczLjg3MjIgMTguNjg1OEM3My44NTQ0IDE4Ljc0OTQgNzMuODMyNSAxOC44MTExIDczLjgxODYgMTguODc0N0M3My44MDI3IDE4Ljk0NjIgNzMuNzkyNyAxOS4wMTk4IDczLjc4MjggMTkuMDkzM0M3My43NzY4IDE5LjEzOSA3My43NzY4IDE5LjE4MjggNzMuNzc0OCAxOS4yMzA1WiIgZmlsbD0iIzI2MjYyNiIvPgo8cGF0aCBkPSJNODAuNTA2OCAyNS43NjY0QzgwLjYwNTggMjUuNjc5NSA4MC42OTkgMjUuNTg2OCA4MC43ODY0IDI1LjQ4ODNDODAuOTI2MSAyNS4zMjYxIDgxLjA0ODQgMjUuMTUyMyA4MS4xMjk5IDI0Ljk2MTFDODEuMjU4MSAyNC42NDgzIDgxLjI1ODEgMjQuMzAwNyA4MS4yNjM5IDIzLjk1MzFDODEuMjY5NyAyMy4xODI1IDgxLjI2MzkgMjIuNDQ2OCA4MS4yNjM5IDIxLjY5OTVDODEuMjYzOSAyMC42MjE5IDgxLjI2OTcgMTkuNTI3IDgxLjI2MzkgMTguNDM3OEM4MS4yNjM5IDE4LjI1ODIgODEuMjYzOSAxOC4wNzg2IDgxLjI2MzkgMTcuOTA0OEM4MS4yNjM5IDE3Ljc4MzIgODEuMjY5NyAxNy42NjE1IDgxLjI2MzkgMTcuNTM5OUM4MS4yNjM5IDE3LjQ2NDYgODEuMjU4MSAxNy4zODkyIDgxLjIzNDggMTcuMzEzOUM4MS4xODgyIDE3LjE0MDEgODEuMDQ4NCAxNy4wMDExIDgwLjkyNjEgMTYuODU2M0M4MC44MDk3IDE2LjcyMyA4MC43MDQ4IDE2LjU4NCA4MC42NDA4IDE2LjQyMThDODAuNTg4NCAxNi4yODg1IDgwLjU3NjcgMTYuMTM3OSA4MC41ODI1IDE1LjkzNTFDODEuMjM0OCAxNS45MzUxIDgxLjg4MTIgMTUuOTM1MSA4Mi41MzM0IDE1LjkzNTFDODIuODAxMiAxNS45MzUxIDgzLjA2OTEgMTUuOTM1MSA4My4zMTM3IDE1LjkzNTFDODMuNTE3NSAxNS45MzUxIDgzLjcwOTcgMTUuOTM1MSA4My45MzY4IDE1Ljg5NDZDODQuMTExNSAxNS44NjU2IDg0LjMxNTMgMTUuODEzNSA4NC40OTU4IDE1Ljc3ODdDODQuNjEyMyAxNS43NTU1IDg0LjcyMyAxNS43MzgyIDg0LjgzOTQgMTUuNzQzOUM4NC45MDkzIDE1Ljc0OTcgODQuOTc5MiAxNS43NjEzIDg1LjAzMTYgMTUuODAxOUM4NS4wNzgyIDE1Ljg0MjQgODUuMTAxNSAxNS45MDYyIDg1LjExODkgMTUuOTY0MUM4NS4xMzA2IDE2LjAxNjIgODUuMTMwNiAxNi4wNjg0IDg1LjEzMDYgMTYuMTI2M0M4NS4xMzY0IDE2LjI4ODUgODUuMTQyMiAxNi40NTA3IDg1LjEzMDYgMTYuNjEyOUM4NS4yMzU0IDE2LjUwMjkgODUuMzQ2MSAxNi4zOTg2IDg1LjQ2MjUgMTYuMjk0M0M4NS42MTM5IDE2LjE2MTEgODUuNzc3IDE2LjAzOTQgODUuOTUxNyAxNS45NDY3Qzg2LjEzMjIgMTUuODU0IDg2LjMzMDIgMTUuNzkwMyA4Ni41MjI0IDE1Ljc0MzlDODYuNzg0NCAxNS42ODYgODcuMDQwNyAxNS42NTcgODcuMzI2IDE1LjY2MjhDODcuNTI0IDE1LjY2MjggODcuNzM5NSAxNS42ODAyIDg3Ljg3MzQgMTUuODA3N0M4Ny45NDkxIDE1Ljg4MyA4Ny45OTU3IDE1Ljk4NzMgODguMDEzMiAxNi4wOTczQzg4LjAzNjUgMTYuMTk1OCA4OC4wMzA2IDE2LjMwMDEgODguMDMwNiAxNi4zOTg2Qzg4LjAzMDYgMTYuNjY1MSA4OC4wMzA2IDE2LjkzMTYgODguMDMwNiAxNy4yMDM5Qzg4LjAzMDYgMTcuNjI2OCA4OC4wMjQ4IDE4LjA0MzkgODguMDI0OCAxOC40MjYyQzg3LjQ4MzIgMTguNDIwNSA4Ny4wNzU2IDE4LjM5NzMgODYuNzAyOSAxOC40MTQ3Qzg2LjQ5MzMgMTguNDI2MiA4Ni4zMDExIDE4LjQ0OTQgODYuMDk3MyAxOC41MTg5Qzg1LjkxMDkgMTguNTgyNyA4NS43MTI5IDE4LjY4MTEgODUuNTQ5OSAxOC44MjAyQzg1LjM3NTIgMTguOTY1IDg1LjIzNTQgMTkuMTU2MiA4NS4xNDgxIDE5LjM2NDhDODUuMDQzMiAxOS42MjU1IDg1LjAzMTYgMTkuOTIwOSA4NS4wMzE2IDIwLjIwNDhDODUuMDMxNiAyMC40MTMzIDg1LjAzMTYgMjAuNjE2MSA4NS4wMzE2IDIwLjgxODlDODUuMDM3NCAyMS41MzE1IDg1LjA0OTEgMjIuMjQ0IDg1LjAzMTYgMjIuOTE2MUM4NS4wMTk5IDIzLjM4NTMgODQuOTk2NyAyMy44MzcyIDg1LjA1NDkgMjQuMzkzM0M4NS4wNzI0IDI0LjU0OTggODUuMDg5OCAyNC43MTIgODUuMTM2NCAyNC44NTY4Qzg1LjIwMDUgMjUuMDc3IDg1LjMxMTEgMjUuMjUwOCA4NS40Mjc2IDI1LjQxODhDODUuNTA5MSAyNS41MzQ2IDg1LjU5NjUgMjUuNjQ0NyA4NS42ODk2IDI1Ljc0OUM4My45NjAxIDI1Ljc2NjQgODIuMjM2NCAyNS43NjY0IDgwLjUwNjggMjUuNzY2NFoiIGZpbGw9IiMyNjI2MjYiLz4KPHBhdGggZD0iTTk4LjIwNzMgMjUuNzU4MkM5NC43ODA5IDI1Ljc1ODIgOTEuMzU0NiAyNS43NTgyIDg3LjkxNSAyNS43NTgyQzg3Ljk0MTQgMjUuNzI1MiA4Ny45NjEzIDI1LjY5MjEgODcuOTgxMSAyNS42Nzg5Qzg4LjMxMTkgMjUuNDA3NyA4OC41ODk3IDI1LjA5MDIgODguODM0NCAyNC43Mzk2Qzg4Ljk5MzIgMjQuNTE0NyA4OS4xMTg4IDI0LjI4MzIgODkuMjExNCAyNC4wMzE4Qzg5LjI3NzYgMjMuODQ2NiA4OS4zMTczIDIzLjY1NDggODkuMzYzNiAyMy40NjNDODkuNDI5NyAyMy4yMDUgODkuNDI5NyAyMi45NDA0IDg5LjQ1NjIgMjIuNjc1OUM4OS41MDkxIDIyLjE4NjQgODkuNDg5MyAyMS43MDM1IDg5LjQ4OTMgMjEuMjE0Qzg5LjQ4OTMgMjAuMDk2MiA4OS40ODkzIDE4Ljk3ODMgODkuNDc2IDE3Ljg2MDRDODkuNDY5NCAxNi45MDEzIDg5LjQ0OTYgMTUuOTQ4OCA4OS40Mjk3IDE0Ljk4OTdDODkuNDE2NSAxNC4zMzQ5IDg5LjQxNjUgMTMuNjggODkuMzkgMTMuMDE4NkM4OS4zNTcgMTIuMDI2NCA4OS4zNzAyIDExLjAyNzYgODkuMzM3MSAxMC4wMzU0Qzg5LjI4NDIgOC4zMzU0NiA4OS4zMTczIDYuNjI4OSA4OS4zMDQgNC45Mjg5NUM4OS4zMDQgNC42NjQzNyA4OS4zMTczIDQuNDA2NCA4OS4yNzEgNC4xNDE4MkM4OS4yNTc3IDQuMDgyMjkgODkuMjY0NCA0LjAxNjE0IDg5LjI2NDQgMy45NDk5OUM4OS4yNjQ0IDMuNzQ0OTQgODkuMjMxMyAzLjUzOTg5IDg5LjE4NSAzLjM0MTQ1Qzg5LjE1MTkgMy4yMDI1NSA4OS4xMjU1IDMuMDU3MDMgODkuMDg1OCAyLjkxODEyQzg4Ljk2MDEgMi40NzQ5NCA4OC43NjgzIDIuMDc4MDcgODguNDE3NyAxLjc2NzE4Qzg4LjI4NTQgMS42NDgxMiA4OC4xNTk3IDEuNTI5MDYgODguMDIwOCAxLjQxNjYxQzg3Ljk0MTQgMS4zNTA0NiA4Ny44ODE5IDEuMjcxMDkgODcuODQyMiAxLjE3ODQ5Qzg3Ljc3NjEgMS4wMTMxMiA4Ny44MTU4IDAuOTAwNjc0IDg4LjAyNzQgMC44Njc2MDFDODguMDg3IDAuODU0MzcyIDg4LjE0NjUgMC44NjA5ODYgODguMjA2IDAuODYwOTg2Qzg5LjI4NDIgMC44NjA5ODYgOTAuMzYyNCAwLjg2NzYwMiA5MS40MzM5IDAuODQ3NzU4QzkxLjkzIDAuODQxMTQzIDkyLjQzMjcgMC44MjEyOTkgOTIuOTI4OCAwLjgzNDUyOEM5NS40MjkxIDAuODk0MDU5IDk3LjkyOTUgMC44NDExNDMgMTAwLjQzNiAwLjg2NzYwMUMxMDAuNTYyIDAuODY3NjAxIDEwMC42ODEgMC44ODc0NDUgMTAwLjgwNyAwLjkwMDY3NEMxMDAuODQgMC45MDA2NzQgMTAwLjg2NiAwLjkwNzI4OSAxMDAuODk5IDAuOTA3Mjg5QzEwMS4xMzEgMC45MjcxMzMgMTAxLjM2MiAwLjk0MDM2MSAxMDEuNTk0IDAuOTY2ODJDMTAxLjcyNiAwLjk4MDA0OSAxMDEuODU5IDEuMDE5NzQgMTAxLjk4NCAxLjAzOTU4QzEwMi4wOTcgMS4wNTk0MiAxMDIuMjAyIDEuMDcyNjUgMTAyLjMxNSAxLjA5MjVDMTAyLjQxNCAxLjExMjM0IDEwMi41MDcgMS4xMzg4IDEwMi42MDYgMS4xNjUyNkMxMDIuNjcyIDEuMTg1MSAxMDIuNzMyIDEuMjA0OTQgMTAyLjc5OCAxLjIxODE3QzEwMy4xMDkgMS4yOTA5MyAxMDMuNDA2IDEuNDEgMTAzLjY5NyAxLjUzNTY3QzEwNC4yODYgMS43ODcwMyAxMDQuODE1IDIuMTMwOTkgMTA1LjI5OCAyLjU1NDMyQzEwNS43NzQgMi45NzEwNCAxMDYuMTg0IDMuNDQ3MjkgMTA2LjUyOCAzLjk3NjQ1QzEwNi43MzMgNC4yOTM5NSAxMDYuOTE5IDQuNjI0NjggMTA3LjA1OCA0Ljk3NTI1QzEwNy4xMyA1LjE2MDQ2IDEwNy4yMDMgNS4zNDU2NyAxMDcuMjY5IDUuNTM3NDlDMTA3LjMxNiA1LjY3NjQgMTA3LjM0MiA1LjgyMTkyIDEwNy4zNzUgNS45Njc0NEMxMDcuNDIxIDYuMTc5MTEgMTA3LjQ1NCA2LjM5MDc3IDEwNy40OTQgNi42MDI0NEMxMDcuNDk0IDYuNjE1NjcgMTA3LjUwMSA2LjYyMjI4IDEwNy41MDEgNi42MzU1MUMxMDcuNTE0IDYuOTU5NjMgMTA3LjUzNCA3LjI4Mzc0IDEwNy41NCA3LjYxNDQ3QzEwNy41NCA3LjgxOTUyIDEwNy41MjcgOC4wMTc5NiAxMDcuNTAxIDguMjIzMDFDMTA3LjQ3NCA4LjQ0MTI5IDEwNy40MjEgOC42NTk1NyAxMDcuMzgyIDguODg0NDdDMTA3LjMzNSA5LjE2ODg5IDEwNy4yNDMgOS40NDAwOSAxMDcuMTQ0IDkuNzA0NjdDMTA2LjkzMiAxMC4yNTM3IDEwNi42NDEgMTAuNzYzIDEwNi4yNjQgMTEuMjE5NEMxMDUuOTk5IDExLjU0MzUgMTA1LjY4OCAxMS44MjEzIDEwNS4zNzEgMTIuMDkyNUMxMDQuODY4IDEyLjUyMjUgMTA0LjMzMiAxMi45MDYxIDEwMy43NTcgMTMuMjQzNUMxMDMuNTUyIDEzLjM2MjUgMTAzLjMzNCAxMy40NjE4IDEwMy4xMjIgMTMuNTY3NkMxMDMuMDQ5IDEzLjYwMDcgMTAzLjA0MyAxMy42MTM5IDEwMy4wODIgMTMuNjhDMTAzLjMwNyAxNC4wMzA2IDEwMy41MzIgMTQuMzg3OCAxMDMuNzU3IDE0LjczODRDMTAzLjkyMiAxNS4wMDMgMTA0LjA5NCAxNS4yNjc1IDEwNC4yNTMgMTUuNTMyMUMxMDQuNTQ0IDE2LjAwODQgMTA0LjgzNSAxNi40NzggMTA1LjExOSAxNi45NTQzQzEwNS4zODQgMTcuMzkwOCAxMDUuNjU1IDE3LjgzNCAxMDUuOTIgMTguMjc3MkMxMDYuMjExIDE4Ljc2IDEwNi41MDIgMTkuMjQ5NSAxMDYuNzkzIDE5LjczOUMxMDcuMTgzIDIwLjM4NzIgMTA3LjU2NyAyMS4wMzU0IDEwNy45NTcgMjEuNjgzN0MxMDguMjIyIDIyLjEyNjggMTA4LjQ5MyAyMi41NjM0IDEwOC43NzEgMjNDMTA5LjA2MiAyMy40NDMxIDEwOS4zOTkgMjMuODUzMyAxMDkuNzUgMjQuMjUwMUMxMTAuMTczIDI0LjcxOTggMTEwLjYyMyAyNS4xNTYzIDExMS4xMTIgMjUuNTU5OEMxMTEuMTE5IDI1LjU2NjQgMTExLjExOSAyNS41NzMgMTExLjEzOSAyNS41ODYzQzExMS4wNzMgMjUuNjA2MSAxMTEuMDA2IDI1LjYzMjYgMTEwLjk0NyAyNS42MzI2QzExMC42ODkgMjUuNjUyNCAxMTAuNDMxIDI1LjY1OSAxMTAuMTggMjUuNjkyMUMxMDkuOTc1IDI1LjcxODYgMTA5Ljc3IDI1LjcwNTMgMTA5LjU2NCAyNS43Mzg0QzEwOS4zOTMgMjUuNzY0OSAxMDkuMjIxIDI1Ljc1MTYgMTA5LjA0OSAyNS43NzgxQzEwOC43OTEgMjUuODE3OCAxMDguNTMzIDI1Ljc5MTMgMTA4LjI3NSAyNS44MzFDMTA3LjkzNyAyNS44NzczIDEwNy42IDI1Ljg1MDkgMTA3LjI2MyAyNS44NzA3QzEwNi4yNjQgMjUuOTQzNSAxMDUuMjcyIDI1Ljg5MDUgMTA0LjI3MyAyNS45MDM4QzEwNC4wNzQgMjUuOTAzOCAxMDMuODY5IDI1Ljg5MDUgMTAzLjY3MSAyNS44NTA5QzEwMy4wNDkgMjUuNzM4NCAxMDIuNTEzIDI1LjQ1NCAxMDIuMDM3IDI1LjAzNzNDMTAxLjcgMjQuNzM5NiAxMDEuNDIyIDI0LjM5NTYgMTAxLjE5NyAyNC4wMTJDMTAwLjk5MiAyMy42NzQ3IDEwMC44IDIzLjMyNDEgMTAwLjYwOCAyMi45ODAxQzEwMC40NDMgMjIuNjg5MSAxMDAuMjc4IDIyLjM5OCAxMDAuMTE5IDIyLjEwN0M5OS44NjA5IDIxLjYzNzQgOTkuNjAyOSAyMS4xNjExIDk5LjM1MTYgMjAuNjkxNUM5OS4wNDczIDIwLjEyMjYgOTguNzQ5NyAxOS41NTM4IDk4LjQ1MiAxOC45ODQ5Qzk4LjEzNDUgMTguMzgzIDk3LjgxNyAxNy43ODc3IDk3LjQ3MyAxNy4yMDU2Qzk3LjE2MjIgMTYuNjc2NCA5Ni44NjQ1IDE2LjEzNCA5Ni41NjAyIDE1LjU5ODNDOTYuNTQ3IDE1LjU3ODQgOTYuNTMzOCAxNS41NjUyIDk2LjQ5NDEgMTUuNTU4NkM5Ni40OTQxIDE1LjU5MTYgOTYuNDk0MSAxNS42MjQ3IDk2LjQ5NDEgMTUuNjU3OEM5Ni40OTQxIDE3LjY4ODUgOTYuNDk0MSAxOS43MjU4IDk2LjQ5NDEgMjEuNzU2NEM5Ni40OTQxIDIyLjEzMzUgOTYuNTAwNyAyMi41MDM5IDk2LjUyMDUgMjIuODgwOUM5Ni41MjcyIDIzLjA0NjMgOTYuNTY2OSAyMy4yMDUgOTYuNTkzMyAyMy4zNzA0Qzk2LjYxMzIgMjMuNDgyOCA5Ni42MjY0IDIzLjU4ODcgOTYuNjU5NSAyMy43MDExQzk2LjY5OTEgMjMuODQgOTYuNzQ1NCAyMy45ODU1IDk2LjgwNSAyNC4xMTc4Qzk2LjkxNzQgMjQuMzgyNCA5Ny4wNTYzIDI0LjYzMzggOTcuMjI4MyAyNC44NjUzQzk3LjQ3OTcgMjUuMTg5NCA5Ny43NjQxIDI1LjQ2NzIgOTguMTE0NyAyNS42ODU1Qzk4LjE0NzcgMjUuNzA1MyA5OC4xODA4IDI1LjczMTggOTguMjEzOSAyNS43NTE2Qzk4LjIxMzkgMjUuNzQ1IDk4LjIxMzkgMjUuNzUxNiA5OC4yMDczIDI1Ljc1ODJaTTk2LjQ0MTIgNC42MTE0NUM5Ni40MTQ3IDQuNzcwMiA5Ni40MTQ3IDEzLjAzMTggOTYuNDQxMiAxMy4xMTEyQzk2LjQ1NDQgMTMuMTExMiA5Ni40Njc2IDEzLjExNzggOTYuNDgwOSAxMy4xMTc4Qzk2LjU2MDIgMTMuMTA0NiA5Ni42Mzk2IDEzLjA5MTMgOTYuNzE5IDEzLjA3MTVDOTYuODExNiAxMy4wNTE3IDk2LjkxMDggMTMuMDQ1IDk3LjAwMzQgMTMuMDE4NkM5Ny4xNjg4IDEyLjk2NTcgOTcuMzI3NSAxMi45MDYxIDk3LjQ5MjkgMTIuODUzMkM5Ny43NDQyIDEyLjc2NzIgOTcuOTgyNCAxMi42NDgyIDk4LjIxMzkgMTIuNTA5M0M5OC42NDM4IDEyLjI1MTMgOTkuMDIwOSAxMS45MjcyIDk5LjM1MTYgMTEuNTU2OEM5OS43MDIyIDExLjE1OTkgOTkuOTg2NiAxMC43Mjk5IDEwMC4xOTggMTAuMjQ3MUMxMDAuMjc4IDEwLjA2ODUgMTAwLjMzNyA5Ljg4MzI3IDEwMC4zOTcgOS42OTE0NUMxMDAuNDM2IDkuNTY1NzcgMTAwLjQ2MyA5LjQzMzQ4IDEwMC40OTYgOS4zMDExOUMxMDAuNTM2IDkuMTIyNTkgMTAwLjU3NSA4Ljk0NCAxMDAuNTc1IDguNzU4NzlDMTAwLjU3NSA4LjY5MjY0IDEwMC41ODIgOC42MjY1IDEwMC41ODIgOC41NTM3NEMxMDAuNTg5IDguMTYzNDggMTAwLjU4OSA3Ljc3MzIyIDEwMC40ODkgNy4zOTYxOUMxMDAuNDM2IDcuMjEwOTggMTAwLjQwMyA3LjAxOTE2IDEwMC4zMzcgNi44NDA1NkMxMDAuMjExIDYuNDg5OTkgMTAwLjAzMyA2LjE2NTg4IDk5Ljc5NDggNS44NjgyMkM5OS41NTY2IDUuNTc3MTggOTkuMjg1NCA1LjMyNTgzIDk4Ljk1NDcgNS4xMjczOUM5OC43Njk1IDUuMDE0OTQgOTguNTcxMSA0LjkyODk1IDk4LjM3MjYgNC44NDI5NkM5OC4yNzM0IDQuNzk2NjYgOTguMTYxIDQuNzcwMiA5OC4wNTUxIDQuNzQzNzRDOTcuOTY5MSA0LjcyMzkgOTcuODgzMiA0LjcwNDA1IDk3Ljc5NzIgNC42OTA4M0M5Ny42NzE1IDQuNjY0MzcgOTcuNTUyNCA0LjYxODA3IDk3LjQyNjcgNC42MTgwN0M5Ny4xMDkyIDQuNTk4MjIgOTYuNzc4NSA0LjYxMTQ1IDk2LjQ0MTIgNC42MTE0NVoiIGZpbGw9IiMyNjI2MjYiLz4KPHBhdGggZD0iTTExNC43ODcgMTUuNzcxOEMxMTUuMDU5IDE1Ljc2MzkgMTE1LjMyOCAxNS43NzcgMTE1LjU5NSAxNS44MDU4QzExNS43OTkgMTUuODI5MyAxMTYuMDAzIDE1Ljg2MzMgMTE2LjIwNyAxNS45QzExNi4zNDMgMTUuOTIzNSAxMTYuNDgyIDE1Ljk1MjMgMTE2LjYxNiAxNS45ODg5QzExNi44NTYgMTYuMDU0MyAxMTcuMDkyIDE2LjEzOCAxMTcuMzE5IDE2LjI0QzExNy43ODcgMTYuNDQ2NyAxMTguMjE3IDE2LjcxNjEgMTE4LjU5OCAxNy4wNTFDMTE4Ljk5MyAxNy4zOTYzIDExOS4zMiAxNy43OTkyIDExOS41ODUgMTguMjU0NEMxMTkuNzEzIDE4LjQ3MTUgMTE5LjgyMyAxOC42OTkxIDExOS45MTcgMTguOTMxOUMxMTkuOTcyIDE5LjA2NTMgMTIwLjAxNCAxOS4yMDQgMTIwLjA1NiAxOS4zNDI2QzEyMC4wOTIgMTkuNDU1MSAxMjAuMTI0IDE5LjU3MDIgMTIwLjE1MiAxOS42ODUzQzEyMC4xNjggMTkuNzQ1NSAxMjAuMTc2IDE5LjgwODMgMTIwLjE4NiAxOS44NzFDMTIwLjIwMiAxOS45NDY5IDEyMC4yMTUgMjAuMDIyOCAxMjAuMjMxIDIwLjEwMTJDMTIwLjIzMyAyMC4xMDkxIDEyMC4yMzMgMjAuMTE5NiAxMjAuMjM2IDIwLjEyNzRDMTIwLjI0NCAyMC4xOTU0IDEyMC4yNTcgMjAuMjY2MSAxMjAuMjYgMjAuMzM0MUMxMjAuMjY1IDIwLjU2OTUgMTIwLjMwMSAyMC44MDIzIDEyMC4yNzMgMjEuMDM3OEMxMjAuMjY3IDIxLjA3OTYgMTIwLjI3IDIxLjEyMTUgMTIwLjI2NyAyMS4xNjA3QzEyMC4yNTcgMjEuMjkxNSAxMjAuMjUyIDIxLjQyMjMgMTIwLjIzMyAyMS41NTA1QzEyMC4yMTggMjEuNjc2MSAxMjAuMTg5IDIxLjc5NjQgMTIwLjE2NSAyMS45MjJDMTIwLjE0NyAyMi4wMTYyIDEyMC4xMjkgMjIuMTEyOSAxMjAuMTA1IDIyLjIwNzFDMTIwLjA3NiAyMi4zMTQ0IDEyMC4wNDUgMjIuNDE5IDEyMC4wMDggMjIuNTIzN0MxMTkuOTY3IDIyLjY0OTIgMTE5LjkyMiAyMi43NzIyIDExOS44NzUgMjIuODk1MUMxMTkuNzcgMjMuMTY0NiAxMTkuNjQyIDIzLjQyMDkgMTE5LjQ5IDIzLjY2OTVDMTE5LjAwNyAyNC40NTQzIDExOC4zMzkgMjUuMDM1IDExNy41MSAyNS40M0MxMTcuMjIyIDI1LjU2ODcgMTE2LjkyNCAyNS42ODEyIDExNi42MTggMjUuNzY3NUMxMTYuNDE0IDI1LjgyMjQgMTE2LjIwNyAyNS44Nzc0IDExNS45OTggMjUuOTIxOEMxMTUuODI4IDI1Ljk1ODUgMTE1LjY1OCAyNS45OTI1IDExNS40ODUgMjYuMDE2QzExNS4xMzcgMjYuMDYwNSAxMTQuNzg3IDI2LjA5NDUgMTE0LjQzNiAyNi4wNjgzQzExNC4xOSAyNi4wNSAxMTMuOTQ3IDI2LjAyMzkgMTEzLjcwNCAyNS45ODk5QzExMy40NzYgMjUuOTU1OCAxMTMuMjQ5IDI1LjkxNjYgMTEzLjAyNCAyNS44NjE3QzExMi40ODcgMjUuNzMzNSAxMTEuOTcyIDI1LjU1MDQgMTExLjUwNCAyNS4yNDk1QzExMS4wNDEgMjQuOTQ4NyAxMTAuNjQzIDI0LjU4MjQgMTEwLjMwNiAyNC4xNDU2QzExMC4wODkgMjMuODYwNCAxMDkuOTA1IDIzLjU1NDQgMTA5Ljc1MSAyMy4yM0MxMDkuNjY3IDIzLjA1MjEgMTA5LjU5NCAyMi44NzE2IDEwOS41MjkgMjIuNjg1OUMxMDkuNDkyIDIyLjU4OTEgMTA5LjQ2OSAyMi40ODcgMTA5LjQ0IDIyLjM4NzZDMTA5LjQwNiAyMi4yNjk5IDEwOS4zNzQgMjIuMTQ5NiAxMDkuMzQ2IDIyLjAzMTlDMTA5LjMzIDIxLjk3MTcgMTA5LjMyMiAyMS45MDg5IDEwOS4zMTIgMjEuODQ2MUMxMDkuMjk5IDIxLjc3MDMgMTA5LjI4MyAyMS42OTE4IDEwOS4yNyAyMS42MTU5QzEwOS4yNyAyMS42MTA3IDEwOS4yNjcgMjEuNjAyOCAxMDkuMjY1IDIxLjU5NzZDMTA5LjI1NCAyMS40OTMgMTA5LjI0MSAyMS4zODU3IDEwOS4yMzMgMjEuMjgxMUMxMDkuMjIzIDIxLjEwMzIgMTA5LjIxIDIwLjkyNTMgMTA5LjIxMiAyMC43NDc0QzEwOS4yMTIgMjAuNTk1NyAxMDkuMjI1IDIwLjQ0MzkgMTA5LjI0MSAyMC4yOTIyQzEwOS4yNTEgMjAuMTc3MSAxMDkuMjcgMjAuMDY0NiAxMDkuMjkzIDE5Ljk1MjFDMTA5LjMyIDE5LjgyNCAxMDkuMzU0IDE5LjY5NTggMTA5LjM4OCAxOS41Njc2QzEwOS40MTkgMTkuNDUyNSAxMDkuNDU4IDE5LjM0MjYgMTA5LjQ5NSAxOS4yMzAxQzEwOS41NTIgMTkuMDU0OCAxMDkuNjI4IDE4Ljg4NDggMTA5LjcxNSAxOC43MkMxMTAuMDI4IDE4LjExMDUgMTEwLjQ0NCAxNy41Nzk0IDExMC45NTcgMTcuMTI0MkMxMTEuMzg5IDE2LjczOTcgMTExLjg2NyAxNi40MzM2IDExMi4zOTkgMTYuMjA2QzExMi42NDIgMTYuMTAxNCAxMTIuODkzIDE2LjAxNzcgMTEzLjE1MiAxNS45NTc1QzExMy4zODUgMTUuOTA1MiAxMTMuNjIgMTUuODYwNyAxMTMuODU4IDE1LjgyOTNDMTE0LjE2NCAxNS43Nzk2IDExNC40NzYgMTUuNzY5MiAxMTQuNzg3IDE1Ljc3MThaTTExNi42NjUgMjEuMjUyM0MxMTYuNjYzIDIxLjI1MjMgMTE2LjY2IDIxLjI1MjMgMTE2LjY1NyAyMS4yNTIzQzExNi42NTcgMjEuMDE5NSAxMTYuNjYgMjAuNzg2NiAxMTYuNjU3IDIwLjU1MzhDMTE2LjY1NSAyMC4zNzU5IDExNi42MzkgMjAuMTk4IDExNi42MjkgMjAuMDIwMkMxMTYuNjI5IDIwLjAwOTcgMTE2LjYyNiAxOS45OTkyIDExNi42MjMgMTkuOTg4OEMxMTYuNjA4IDE5LjkwNSAxMTYuNTk1IDE5LjgyMTMgMTE2LjU3OSAxOS43NDAyQzExNi41NjEgMTkuNjQzNCAxMTYuNTQ4IDE5LjU0NCAxMTYuNTE5IDE5LjQ0NzJDMTE2LjQ3OSAxOS4zMDYgMTE2LjQzIDE5LjE2NzMgMTE2LjM3MiAxOS4wMzM5QzExNi4yNTIgMTguNzUxNCAxMTYuMDg3IDE4LjQ5NzYgMTE1Ljg3IDE4LjI3NzlDMTE1LjcwOCAxOC4xMTMxIDExNS41MjIgMTcuOTgyMyAxMTUuMzA4IDE3Ljg5ODZDMTE1LjA0NiAxNy43OTY2IDExNC43NzEgMTcuNzcwNCAxMTQuNDk0IDE3Ljc3M0MxMTQuNDI2IDE3Ljc3MyAxMTQuMzU1IDE3Ljc4MDkgMTE0LjI4NyAxNy43OTM5QzExNC4xNDMgMTcuODI1MyAxMTQuMDA3IDE3Ljg3NzcgMTEzLjg4NCAxNy45NTYxQzExMy41OTEgMTguMTQ0NSAxMTMuMzY2IDE4LjM5MyAxMTMuMjA3IDE4LjY5OTFDMTEzLjA4NCAxOC45MzE5IDExMi45OSAxOS4xNzc4IDExMi45NCAxOS40Mzk0QzExMi45MTQgMTkuNTcwMiAxMTIuODg1IDE5LjcwMzYgMTEyLjg2OSAxOS44MzQ0QzExMi44NTEgMjAuMDIwMiAxMTIuODMgMjAuMjA1OSAxMTIuODMzIDIwLjM5NDJDMTEyLjgzMyAyMC41MDQxIDExMi44MjUgMjAuNjExNCAxMTIuODIyIDIwLjcyMTJDMTEyLjgyIDIwLjgyODUgMTEyLjgxMiAyMC45MzU3IDExMi44MjIgMjEuMDQwNEMxMTIuODQzIDIxLjIyODcgMTEyLjgzMyAyMS40MTk3IDExMi44NTkgMjEuNjA4MUMxMTIuODc3IDIxLjczMzYgMTEyLjg5IDIxLjg2MTggMTEyLjkxNCAyMS45ODc0QzExMi45MzUgMjIuMTA3NyAxMTIuOTU4IDIyLjIyODEgMTEyLjk5NSAyMi4zNDg0QzExMy4wMzQgMjIuNDgxOCAxMTMuMDY2IDIyLjYxNTIgMTEzLjExIDIyLjc0NkMxMTMuMTYyIDIyLjkwMDQgMTEzLjIzIDIzLjA0OTUgMTEzLjMxNCAyMy4xOTA3QzExMy40MjcgMjMuMzc5MSAxMTMuNTYzIDIzLjU0OTEgMTEzLjc0NiAyMy42NzczQzExNC4xMiAyMy45MzM3IDExNC41MzYgMjQuMDYxOSAxMTQuOTg4IDI0LjA2OTdDMTE1LjE2NiAyNC4wNzIzIDExNS4zMzQgMjQuMDM1NyAxMTUuNDk4IDIzLjk3MjlDMTE1LjgxIDIzLjg1MjYgMTE2LjA1MyAyMy42NDU5IDExNi4yNDQgMjMuMzc2NUMxMTYuNDA0IDIzLjE1MTUgMTE2LjUgMjIuOTAwNCAxMTYuNTU4IDIyLjYzMDlDMTE2LjU2OCAyMi41ODEyIDExNi41ODIgMjIuNTI4OSAxMTYuNTg5IDIyLjQ3OTJDMTE2LjYwNSAyMi4zOTI5IDExNi42MjYgMjIuMzAzOSAxMTYuNjMxIDIyLjIxNUMxMTYuNjQyIDIxLjg5MzIgMTE2LjY1MiAyMS41NzQxIDExNi42NjUgMjEuMjUyM1oiIGZpbGw9IiMyNjI2MjYiLz4KPHBhdGggZD0iTTEyNi4zOTQgMTUuNzcxOEMxMjYuNjY2IDE1Ljc2MzkgMTI2LjkzNiAxNS43NzcgMTI3LjIwMyAxNS44MDU4QzEyNy40MDcgMTUuODI5MyAxMjcuNjExIDE1Ljg2MzMgMTI3LjgxNSAxNS45QzEyNy45NTEgMTUuOTIzNSAxMjguMDkgMTUuOTUyMyAxMjguMjIzIDE1Ljk4ODlDMTI4LjQ2NCAxNi4wNTQzIDEyOC42OTkgMTYuMTM4IDEyOC45MjcgMTYuMjRDMTI5LjM5NSAxNi40NDY3IDEyOS44MjQgMTYuNzE2MSAxMzAuMjA2IDE3LjA1MUMxMzAuNjAxIDE3LjM5NjMgMTMwLjkyOCAxNy43OTkyIDEzMS4xOTIgMTguMjU0NEMxMzEuMzIgMTguNDcxNSAxMzEuNDMgMTguNjk5MSAxMzEuNTI0IDE4LjkzMTlDMTMxLjU3OSAxOS4wNjUzIDEzMS42MjEgMTkuMjA0IDEzMS42NjMgMTkuMzQyNkMxMzEuNyAxOS40NTUxIDEzMS43MzEgMTkuNTcwMiAxMzEuNzYgMTkuNjg1M0MxMzEuNzc1IDE5Ljc0NTUgMTMxLjc4MyAxOS44MDgzIDEzMS43OTQgMTkuODcxQzEzMS44MDkgMTkuOTQ2OSAxMzEuODIzIDIwLjAyMjggMTMxLjgzOCAyMC4xMDEyQzEzMS44NDEgMjAuMTA5MSAxMzEuODQxIDIwLjExOTYgMTMxLjg0MyAyMC4xMjc0QzEzMS44NTEgMjAuMTk1NCAxMzEuODY0IDIwLjI2NjEgMTMxLjg2NyAyMC4zMzQxQzEzMS44NzIgMjAuNTY5NSAxMzEuOTA5IDIwLjgwMjMgMTMxLjg4IDIxLjAzNzhDMTMxLjg3NSAyMS4wNzk2IDEzMS44NzcgMjEuMTIxNSAxMzEuODc1IDIxLjE2MDdDMTMxLjg2NCAyMS4yOTE1IDEzMS44NTkgMjEuNDIyMyAxMzEuODQxIDIxLjU1MDVDMTMxLjgyNSAyMS42NzYxIDEzMS43OTYgMjEuNzk2NCAxMzEuNzczIDIxLjkyMkMxMzEuNzU1IDIyLjAxNjIgMTMxLjczNiAyMi4xMTI5IDEzMS43MTMgMjIuMjA3MUMxMzEuNjg0IDIyLjMxNDQgMTMxLjY1MyAyMi40MTkgMTMxLjYxNiAyMi41MjM3QzEzMS41NzQgMjIuNjQ5MiAxMzEuNTMgMjIuNzcyMiAxMzEuNDgyIDIyLjg5NTFDMTMxLjM3OCAyMy4xNjQ2IDEzMS4yNSAyMy40MjA5IDEzMS4wOTggMjMuNjY5NUMxMzAuNjE0IDI0LjQ1NDMgMTI5Ljk0NyAyNS4wMzUgMTI5LjExOCAyNS40M0MxMjguODMgMjUuNTY4NyAxMjguNTMyIDI1LjY4MTIgMTI4LjIyNiAyNS43Njc1QzEyOC4wMjIgMjUuODIyNCAxMjcuODE1IDI1Ljg3NzQgMTI3LjYwNiAyNS45MjE4QzEyNy40MzYgMjUuOTU4NSAxMjcuMjY1IDI1Ljk5MjUgMTI3LjA5MyAyNi4wMTZDMTI2Ljc0NSAyNi4wNjA1IDEyNi4zOTQgMjYuMDk0NSAxMjYuMDQ0IDI2LjA2ODNDMTI1Ljc5OCAyNi4wNSAxMjUuNTU1IDI2LjAyMzkgMTI1LjMxMSAyNS45ODk5QzEyNS4wODQgMjUuOTU1OCAxMjQuODU2IDI1LjkxNjYgMTI0LjYzMSAyNS44NjE3QzEyNC4wOTUgMjUuNzMzNSAxMjMuNTggMjUuNTUwNCAxMjMuMTExIDI1LjI0OTVDMTIyLjY0OCAyNC45NDg3IDEyMi4yNTEgMjQuNTgyNCAxMjEuOTEzIDI0LjE0NTZDMTIxLjY5NiAyMy44NjA0IDEyMS41MTMgMjMuNTU0NCAxMjEuMzU5IDIzLjIzQzEyMS4yNzUgMjMuMDUyMSAxMjEuMjAyIDIyLjg3MTYgMTIxLjEzNiAyMi42ODU5QzEyMS4xIDIyLjU4OTEgMTIxLjA3NiAyMi40ODcgMTIxLjA0NyAyMi4zODc2QzEyMS4wMTMgMjIuMjY5OSAxMjAuOTgyIDIyLjE0OTYgMTIwLjk1MyAyMi4wMzE5QzEyMC45MzcgMjEuOTcxNyAxMjAuOTMgMjEuOTA4OSAxMjAuOTE5IDIxLjg0NjFDMTIwLjkwNiAyMS43NzAzIDEyMC44OSAyMS42OTE4IDEyMC44NzcgMjEuNjE1OUMxMjAuODc3IDIxLjYxMDcgMTIwLjg3NSAyMS42MDI4IDEyMC44NzIgMjEuNTk3NkMxMjAuODYyIDIxLjQ5MyAxMjAuODQ4IDIxLjM4NTcgMTIwLjg0MSAyMS4yODExQzEyMC44MyAyMS4xMDMyIDEyMC44MTcgMjAuOTI1MyAxMjAuODIgMjAuNzQ3NEMxMjAuODIgMjAuNTk1NyAxMjAuODMzIDIwLjQ0MzkgMTIwLjg0OCAyMC4yOTIyQzEyMC44NTkgMjAuMTc3MSAxMjAuODc3IDIwLjA2NDYgMTIwLjkwMSAxOS45NTIxQzEyMC45MjcgMTkuODI0IDEyMC45NjEgMTkuNjk1OCAxMjAuOTk1IDE5LjU2NzZDMTIxLjAyNiAxOS40NTI1IDEyMS4wNjYgMTkuMzQyNiAxMjEuMTAyIDE5LjIzMDFDMTIxLjE2IDE5LjA1NDggMTIxLjIzNiAxOC44ODQ4IDEyMS4zMjIgMTguNzJDMTIxLjYzNiAxOC4xMTA1IDEyMi4wNTIgMTcuNTc5NCAxMjIuNTY1IDE3LjEyNDJDMTIyLjk5NiAxNi43Mzk3IDEyMy40NzUgMTYuNDMzNiAxMjQuMDA2IDE2LjIwNkMxMjQuMjQ5IDE2LjEwMTQgMTI0LjUgMTYuMDE3NyAxMjQuNzU5IDE1Ljk1NzVDMTI0Ljk5MiAxNS45MDUyIDEyNS4yMjggMTUuODYwNyAxMjUuNDY2IDE1LjgyOTNDMTI1Ljc3MiAxNS43Nzk2IDEyNi4wODMgMTUuNzY5MiAxMjYuMzk0IDE1Ljc3MThaTTEyOC4yNzMgMjEuMjUyM0MxMjguMjcgMjEuMjUyMyAxMjguMjY3IDIxLjI1MjMgMTI4LjI2NSAyMS4yNTIzQzEyOC4yNjUgMjEuMDE5NSAxMjguMjY3IDIwLjc4NjYgMTI4LjI2NSAyMC41NTM4QzEyOC4yNjIgMjAuMzc1OSAxMjguMjQ2IDIwLjE5OCAxMjguMjM2IDIwLjAyMDJDMTI4LjIzNiAyMC4wMDk3IDEyOC4yMzMgMTkuOTk5MiAxMjguMjMxIDE5Ljk4ODhDMTI4LjIxNSAxOS45MDUgMTI4LjIwMiAxOS44MjEzIDEyOC4xODYgMTkuNzQwMkMxMjguMTY4IDE5LjY0MzQgMTI4LjE1NSAxOS41NDQgMTI4LjEyNiAxOS40NDcyQzEyOC4wODcgMTkuMzA2IDEyOC4wMzcgMTkuMTY3MyAxMjcuOTggMTkuMDMzOUMxMjcuODU5IDE4Ljc1MTQgMTI3LjY5NSAxOC40OTc2IDEyNy40NzcgMTguMjc3OUMxMjcuMzE1IDE4LjExMzEgMTI3LjEyOSAxNy45ODIzIDEyNi45MTUgMTcuODk4NkMxMjYuNjUzIDE3Ljc5NjYgMTI2LjM3OSAxNy43NzA0IDEyNi4xMDEgMTcuNzczQzEyNi4wMzMgMTcuNzczIDEyNS45NjMgMTcuNzgwOSAxMjUuODk1IDE3Ljc5MzlDMTI1Ljc1MSAxNy44MjUzIDEyNS42MTUgMTcuODc3NyAxMjUuNDkyIDE3Ljk1NjFDMTI1LjE5OSAxOC4xNDQ1IDEyNC45NzQgMTguMzkzIDEyNC44MTQgMTguNjk5MUMxMjQuNjkxIDE4LjkzMTkgMTI0LjU5NyAxOS4xNzc4IDEyNC41NDcgMTkuNDM5NEMxMjQuNTIxIDE5LjU3MDIgMTI0LjQ5MyAxOS43MDM2IDEyNC40NzcgMTkuODM0NEMxMjQuNDU5IDIwLjAyMDIgMTI0LjQzOCAyMC4yMDU5IDEyNC40NCAyMC4zOTQyQzEyNC40NCAyMC41MDQxIDEyNC40MzIgMjAuNjExNCAxMjQuNDMgMjAuNzIxMkMxMjQuNDI3IDIwLjgyODUgMTI0LjQxOSAyMC45MzU3IDEyNC40MyAyMS4wNDA0QzEyNC40NTEgMjEuMjI4NyAxMjQuNDQgMjEuNDE5NyAxMjQuNDY2IDIxLjYwODFDMTI0LjQ4NSAyMS43MzM2IDEyNC40OTggMjEuODYxOCAxMjQuNTIxIDIxLjk4NzRDMTI0LjU0MiAyMi4xMDc3IDEyNC41NjYgMjIuMjI4MSAxMjQuNjAyIDIyLjM0ODRDMTI0LjY0MiAyMi40ODE4IDEyNC42NzMgMjIuNjE1MiAxMjQuNzE4IDIyLjc0NkMxMjQuNzcgMjIuOTAwNCAxMjQuODM4IDIzLjA0OTUgMTI0LjkyMiAyMy4xOTA3QzEyNS4wMzQgMjMuMzc5MSAxMjUuMTcgMjMuNTQ5MSAxMjUuMzUzIDIzLjY3NzNDMTI1LjcyNyAyMy45MzM3IDEyNi4xNDMgMjQuMDYxOSAxMjYuNTk2IDI0LjA2OTdDMTI2Ljc3NCAyNC4wNzIzIDEyNi45NDEgMjQuMDM1NyAxMjcuMTA2IDIzLjk3MjlDMTI3LjQxNyAyMy44NTI2IDEyNy42NjEgMjMuNjQ1OSAxMjcuODUxIDIzLjM3NjVDMTI4LjAxMSAyMy4xNTE1IDEyOC4xMDggMjIuOTAwNCAxMjguMTY1IDIyLjYzMDlDMTI4LjE3NiAyMi41ODEyIDEyOC4xODkgMjIuNTI4OSAxMjguMTk3IDIyLjQ3OTJDMTI4LjIxMiAyMi4zOTI5IDEyOC4yMzMgMjIuMzAzOSAxMjguMjM5IDIyLjIxNUMxMjguMjQ5IDIxLjg5MzIgMTI4LjI2IDIxLjU3NDEgMTI4LjI3MyAyMS4yNTIzWiIgZmlsbD0iIzI2MjYyNiIvPgo8cGF0aCBkPSJNMTMyLjEwOCAyNS43MjY0QzEzMi4yMjkgMjUuNjE5OSAxMzIuMzM1IDI1LjUxMzQgMTMyLjQ0MiAyNS4zOTM2QzEzMi41NjIgMjUuMjYwNSAxMzIuNjU2IDI1LjExNCAxMzIuNzM2IDI0Ljk1NDNDMTMyLjgwMyAyNC44MjEyIDEzMi44NDMgMjQuNjYxNSAxMzIuODY5IDI0LjUxNUMxMzIuOTEgMjQuMjYyMSAxMzIuOTEgMjQuMDA5MiAxMzIuOTEgMjMuNzQzQzEzMi45MSAyMi40Nzg0IDEzMi45MSAyMS4yMjcxIDEzMi45MSAxOS45NjI2QzEzMi45MSAxOS40NTY4IDEzMi44OTYgMTguOTUwOSAxMzIuOTEgMTguNDQ1MUMxMzIuOTEgMTguMTc4OSAxMzIuOTIzIDE3LjkxMjYgMTMyLjg5NiAxNy42NDY0QzEzMi44ODMgMTcuNDA2OCAxMzIuODQzIDE3LjE2NzIgMTMyLjc0OSAxNi45NTQyQzEzMi42NTYgMTYuNzU0NiAxMzIuNTA5IDE2LjU2ODIgMTMyLjM3NSAxNi4zOTUyQzEzMi4yOTUgMTYuMjg4NyAxMzIuMjE1IDE2LjE5NTUgMTMyLjEzNSAxNi4xMDIzQzEzMi4zMjIgMTYuMTAyMyAxMzIuNTIyIDE2LjExNTYgMTMyLjcwOSAxNi4xMTU2QzEzMy4xNjMgMTYuMTI4OSAxMzMuNjA0IDE2LjEyODkgMTM0LjA1OCAxNi4xMjg5QzEzNC40NTggMTYuMTI4OSAxMzQuODU5IDE2LjExNTYgMTM1LjI1OSAxNi4wNzU3QzEzNS40NzMgMTYuMDYyNCAxMzUuNjg3IDE2LjAzNTggMTM1LjkgMTUuOTgyNUMxMzYuMTI3IDE1LjkyOTMgMTM2LjM1NCAxNS44NjI3IDEzNi41ODEgMTUuNzY5NUMxMzYuNTgxIDE2LjE0MjIgMTM2LjU4MSAxNi41MTUgMTM2LjU4MSAxNi44NzQ0QzEzNi42MjEgMTYuODg3NyAxMzYuNjQ4IDE2Ljg4NzcgMTM2LjY4OCAxNi44NzQ0QzEzNi43MjggMTYuODYxMSAxMzYuNzY4IDE2LjgzNDQgMTM2LjgwOCAxNi44MDc4QzEzNi45OTUgMTYuNjYxNCAxMzcuMTQyIDE2LjQ3NSAxMzcuMzE2IDE2LjM0MTlDMTM3LjUyOSAxNi4xNjg5IDEzNy43OTYgMTYuMDQ5MSAxMzguMDYzIDE1Ljk2OTJDMTM4LjQxMSAxNS44NjI3IDEzOC43NTggMTUuODIyOCAxMzkuMTMyIDE1LjgyMjhDMTM5LjU5OSAxNS44MjI4IDE0MC4wOCAxNS44NzYgMTQwLjQ1MyAxNi4wNDkxQzE0MC42NCAxNi4xNDIyIDE0MC44MDEgMTYuMjYyMSAxNDAuOTg3IDE2LjQyMThDMTQxLjE4OCAxNi41OTQ4IDE0MS40NDEgMTYuODA3OCAxNDEuNjQyIDE2Ljk2NzVDMTQxLjgyOSAxNi43OTQ1IDE0Mi4wMjkgMTYuNjM0OCAxNDIuMjQzIDE2LjUwMTdDMTQyLjYwMyAxNi4yNzU0IDE0Mi45OSAxNi4xMDIzIDE0My40MDQgMTYuMDA5MUMxNDMuNzc4IDE1LjkxNiAxNDQuMTY1IDE1Ljg2MjcgMTQ0LjU1MiAxNS44NjI3QzE0NC45NjYgMTUuODQ5NCAxNDUuMzk0IDE1Ljg4OTMgMTQ1LjgwOCAxNS45ODI1QzE0Ni4zNTUgMTYuMTE1NiAxNDYuODc2IDE2LjM1NTIgMTQ3LjMwMyAxNi43MTQ2QzE0Ny41NTcgMTYuOTE0MyAxNDcuNzcgMTcuMTUzOSAxNDcuOTQ0IDE3LjQyMDFDMTQ4LjExNyAxNy42ODY0IDE0OC4yMzggMTcuOTkyNSAxNDguMjkxIDE4LjMxMkMxNDguMzMxIDE4LjU2NDkgMTQ4LjMzMSAxOC44MzExIDE0OC4zMzEgMTkuMDg0QzE0OC4zMzEgMTkuODQyOCAxNDguMzMxIDIwLjU4ODIgMTQ4LjMzMSAyMS4zMzM2QzE0OC4zMzEgMjEuNjUzMSAxNDguMzMxIDIxLjk3MjYgMTQ4LjMzMSAyMi4zMDU0QzE0OC4zMzEgMjIuNjM4MSAxNDguMzMxIDIyLjk1NzYgMTQ4LjMzMSAyMy4yOTA0QzE0OC4zMzEgMjMuNTU2NiAxNDguMzMxIDIzLjgwOTUgMTQ4LjMzMSAyNC4wNzU4QzE0OC4zMzEgMjQuMzE1NCAxNDguMzQ0IDI0LjU2ODMgMTQ4LjQxMSAyNC43OTQ2QzE0OC40NzggMjUuMDA3NiAxNDguNjI1IDI1LjIwNzIgMTQ4Ljc1OCAyNS4zOTM2QzE0OC44MzggMjUuNTAwMSAxNDguOTMyIDI1LjYwNjYgMTQ5LjA5MiAyNS43Mzk3QzE0Ny4zNTYgMjUuNzM5NyAxNDUuNjIxIDI1LjczOTcgMTQzLjg3MiAyNS43Mzk3QzE0My45OTIgMjUuNjE5OSAxNDQuMDk4IDI1LjUwMDEgMTQ0LjIwNSAyNS4zODAzQzE0NC4zMTIgMjUuMjQ3MiAxNDQuNDA2IDI1LjEyNzQgMTQ0LjQ3MiAyNC45ODA5QzE0NC41MzkgMjQuODQ3OCAxNDQuNTY2IDI0LjY4ODEgMTQ0LjU5MyAyNC41MjgzQzE0NC42MDYgMjQuNDM1MiAxNDQuNjE5IDI0LjMyODcgMTQ0LjYxOSAyNC4yMzU1QzE0NC42MTkgMjQuMTQyMyAxNDQuNjE5IDI0LjA0OTEgMTQ0LjYxOSAyMy45NTZDMTQ0LjYwNiAyMy4xNDQgMTQ0LjYxOSAyMi4zMTg3IDE0NC42MTkgMjEuNTA2N0MxNDQuNjE5IDIxLjE0NzMgMTQ0LjYxOSAyMC44MDEyIDE0NC42MTkgMjAuNDQxOEMxNDQuNjE5IDIwLjA4MjQgMTQ0LjYzMyAxOS43MDk3IDE0NC42MTkgMTkuMzUwM0MxNDQuNjE5IDE5LjIxNzIgMTQ0LjYwNiAxOS4wOTczIDE0NC41OTMgMTguOTc3NUMxNDQuNTY2IDE4LjgxNzggMTQ0LjQ4NiAxOC42NTgxIDE0NC4zOTIgMTguNTI1QzE0NC4yODUgMTguMzc4NSAxNDQuMTUyIDE4LjI1ODcgMTQ0LjAwNSAxOC4xNzg5QzE0My44NDUgMTguMDk5IDE0My42NDUgMTguMDU5MSAxNDMuNDcxIDE4LjA3MjRDMTQzLjIzMSAxOC4wODU3IDE0My4wMDQgMTguMTkyMiAxNDIuODQzIDE4LjM1MTlDMTQyLjY5NyAxOC40OTgzIDE0Mi41OSAxOC42ODQ3IDE0Mi41MzYgMTguODg0NEMxNDIuNDk2IDE5LjA0NDEgMTQyLjQ5NiAxOS4yMDM4IDE0Mi40OTYgMTkuMzYzNkMxNDIuNDk2IDE5LjUxIDE0Mi40OTYgMTkuNjQzMSAxNDIuNDk2IDE5Ljc4OTVDMTQyLjQ5NiAyMC4xNzU2IDE0Mi40OTYgMjAuNTc0OSAxNDIuNDk2IDIwLjk2MDlDMTQyLjQ5NiAyMS45NDYgMTQyLjUxIDIyLjkzMSAxNDIuNDk2IDIzLjkwMjdDMTQyLjQ5NiAyNC4wMzU4IDE0Mi40OTYgMjQuMTgyMyAxNDIuNDk2IDI0LjMxNTRDMTQyLjUxIDI0LjUwMTcgMTQyLjUyMyAyNC43MDE0IDE0Mi42MDMgMjQuODc0NEMxNDIuNjgzIDI1LjA3NDEgMTQyLjgxNyAyNS4yNDcyIDE0Mi45NjQgMjUuNDIwMkMxNDMuMDU3IDI1LjU0IDE0My4xNjQgMjUuNjQ2NSAxNDMuMjcxIDI1Ljc1M0MxNDEuNTIyIDI1Ljc1MyAxMzkuNzg2IDI1Ljc1MyAxMzguMDM3IDI1Ljc1M0MxMzguMTU3IDI1LjYzMzIgMTM4LjI2NCAyNS41MTM0IDEzOC4zNyAyNS4zOTM2QzEzOC40NzcgMjUuMjYwNSAxMzguNTcxIDI1LjE0MDcgMTM4LjYzOCAyNC45OTQyQzEzOC43MDQgMjQuODYxMSAxMzguNzMxIDI0LjcwMTQgMTM4Ljc1OCAyNC41NDE3QzEzOC43NzEgMjQuNDQ4NSAxMzguNzg0IDI0LjM0MiAxMzguNzg0IDI0LjI0ODhDMTM4Ljc4NCAyNC4xNTU2IDEzOC43ODQgMjQuMDYyNCAxMzguNzg0IDIzLjk2OTNDMTM4Ljc3MSAyMy4xNTczIDEzOC43ODQgMjIuMzMyIDEzOC43ODQgMjEuNTJDMTM4Ljc4NCAyMS4xNjA2IDEzOC43ODQgMjAuODE0NSAxMzguNzg0IDIwLjQ1NTFDMTM4Ljc4NCAyMC4wOTU3IDEzOC43OTggMTkuNzIzIDEzOC43ODQgMTkuMzYzNkMxMzguNzg0IDE5LjIzMDUgMTM4Ljc3MSAxOS4xMTA3IDEzOC43NTggMTguOTkwOUMxMzguNzMxIDE4LjgzMTEgMTM4LjY1MSAxOC42NzE0IDEzOC41NTcgMTguNTM4M0MxMzguNDUxIDE4LjM5MTkgMTM4LjMxNyAxOC4yNzIxIDEzOC4xNyAxOC4xOTIyQzEzOC4wMSAxOC4xMTIzIDEzNy44MSAxOC4wNzI0IDEzNy42MzYgMTguMDg1N0MxMzcuMzk2IDE4LjA5OSAxMzcuMTY5IDE4LjIwNTUgMTM3LjAwOSAxOC4zNjUyQzEzNi44NjIgMTguNTExNyAxMzYuNzU1IDE4LjY5OCAxMzYuNzAxIDE4Ljg5NzdDMTM2LjY2MSAxOS4wNTc0IDEzNi42NjEgMTkuMjE3MSAxMzYuNjYxIDE5LjM3NjlDMTM2LjY2MSAxOS41MjMzIDEzNi42NjEgMTkuNjU2NCAxMzYuNjYxIDE5LjgwMjhDMTM2LjY2MSAyMC4xODg5IDEzNi42NjEgMjAuNTg4MiAxMzYuNjYxIDIwLjk3NDJDMTM2LjY2MSAyMS45NTkzIDEzNi42NzUgMjIuOTQ0MyAxMzYuNjYxIDIzLjkxNkMxMzYuNjYxIDI0LjA0OTEgMTM2LjY2MSAyNC4xOTU2IDEzNi42NjEgMjQuMzI4N0MxMzYuNjc1IDI0LjUxNSAxMzYuNjg4IDI0LjcxNDcgMTM2Ljc2OCAyNC44ODc3QzEzNi44NDggMjUuMDg3NCAxMzYuOTgyIDI1LjI2MDUgMTM3LjEyOSAyNS40MzM1QzEzNy4yMjIgMjUuNTUzMyAxMzcuMzI5IDI1LjY1OTggMTM3LjQzNiAyNS43NjYzQzEzNS42MDcgMjUuNzI2NCAxMzMuODU4IDI1LjcyNjQgMTMyLjEwOCAyNS43MjY0WiIgZmlsbD0iIzI2MjYyNiIvPgo8L3N2Zz4=" alt="WhisperRoom" class="logo-img">
    <div class="header-right">
      <div class="quote-type">Invoice</div>
      <div class="quote-num">${q.quoteNumber||'INV'}</div>
      <div class="quote-meta">Issued ${issueDate}</div>
      ${(q.rep||REPS[q.ownerId])?`<div style="font-size:11px;color:#888;margin-top:4px;font-weight:600">${q.rep||REPS[q.ownerId]||''}</div>`:''}
      ${q.quoteLabel ? `<div style="margin-top:8px;display:block;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#ee6216;background:rgba(238,98,22,.08);border:1px solid rgba(238,98,22,.25);border-radius:4px;padding:4px 12px;width:fit-content;margin-left:auto">${q.quoteLabel}</div>` : ''}
    </div>
  </div>
  <div class="accent-strip"></div>

  ${c.firstName ? `<div class="card">
    <div class="card-label">Billed To</div>
    <div class="info-grid">
      <div class="info-item"><label>Name</label><span>${c.firstName} ${c.lastName}</span></div>
      ${c.company?`<div class="info-item"><label>Company</label><span>${c.company}</span></div>`:''}
      ${c.email?`<div class="info-item"><label>Email</label><span>${c.email}</span></div>`:''}
      ${(c.address||c.city||c.state||c.zip)?`<div class="info-item"><label>Ship To</label><span>${[c.address,c.city,(c.state&&c.zip?c.state+' '+c.zip:c.state||c.zip)].filter(Boolean).join(', ')}</span></div>`:''}
      ${q.billing && (q.billing.address || q.billing.email) ? `<div class="info-item" style="margin-top:10px;padding-top:10px;border-top:1px solid #f0f0f0"><label>Bill To</label><span>${[q.billing.email||'',q.billing.address||'',[q.billing.city,(q.billing.state&&q.billing.zip?q.billing.state+' '+q.billing.zip:q.billing.state||q.billing.zip)].filter(Boolean).join(', ')].filter(Boolean).join('<br>')}</span></div>` : ''}
    </div>
  </div>` : ''}

  <div class="card">
    <div class="card-label">Products &amp; Services</div>
    <table>
      <thead><tr><th>Item</th><th style="text-align:center">Qty</th><th style="text-align:right">Unit Price</th><th style="text-align:right">Total</th></tr></thead>
      <tbody>${lineRows}</tbody>
    </table>
    <div style="display:flex;align-items:flex-start;gap:20px;margin-top:16px;flex-wrap:wrap">
      ${q.notes ? `<div style="flex:1;min-width:180px;background:rgba(238,98,22,.06);border:1px solid rgba(238,98,22,.25);border-radius:8px;padding:14px 16px">
        <div style="font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:#ee6216;margin-bottom:6px">Quote Notes</div>
        <div style="font-size:13px;color:#444;line-height:1.6;white-space:pre-wrap">${q.notes.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
      </div>` : ''}
      <div style="min-width:220px;${q.notes ? '' : 'margin-left:auto'}">
        <div class="totals" style="margin-top:0">
          <div class="tot"><span>Subtotal</span><span>${fmt(sub)}</span></div>
          ${disc>0?`<div class="tot"><span>Discount${q.discount&&q.discount.type==='pct'?' ('+q.discount.value+'%)':''}</span><span class="discount-val">-${fmt(disc)}</span></div>`:''}
          ${freightTbd?'<div class="tot"><span>Freight</span><span style="color:#888;font-style:italic">TBD</span></div>':freightAmt>0?`<div class="tot"><span>Freight</span><span>${fmt(freightAmt)}</span></div>`:''}
          ${taxAmt>0?`<div class="tot"><span>Sales Tax${q.tax&&q.tax.rate?' ('+(q.tax.rate*100).toFixed(2).replace(/\\.?0+$/,'')+'%)':''}</span><span>${fmt(taxAmt)}</span></div>`:''}
          ${(q.taxExempt||q.accessories?.taxexempt)?'<div class="tot"><span style="color:#22c55e;font-weight:700">✓ Tax Exempt</span><span style="color:#22c55e">'+(q.taxExemptCert||q.taxExemptCertificate||'Exempt')+'</span></div>':''}
          <div class="tot grand"><span>Amount Due</span><span>${fmt(total)}</span></div>
        </div>
      </div>
    </div>
  </div>
  ${freightTbd?`<div class="card" style="border-left:3px solid #ee6216;background:#fff8f5">
    <p style="margin:0;font-size:12px;color:#666"><strong style="color:#ee6216">Freight Note:</strong> Freight cost is to be determined. A freight estimate will be provided prior to finalizing your order. The total above does not include freight.</p>
  </div>`:''}
  ${(q.taxExempt||q.accessories?.taxexempt)?`<div class="card" style="border-left:3px solid #22c55e;background:#f0fdf4">
    <p style="margin:0;font-size:12px;color:#166534"><strong style="color:#166534">Tax Exemption Required:</strong> A valid tax exemption certificate must be provided to WhisperRoom, Inc. before your order can be processed.${(q.taxExemptCert||q.taxExemptCertificate)?(' Certificate: '+(q.taxExemptCert||q.taxExemptCertificate)):''}</p>
  </div>`:''}

  <div class="card">
    <div class="card-label">Payment Terms</div>
    <p class="terms">Payment is due upon receipt. We accept ACH bank transfer and major credit/debit cards. For questions regarding this invoice, contact us at <a href="mailto:info@whisperroom.com" style="color:#ee6216">info@whisperroom.com</a> or (865) 558-5364.</p>
  </div>

  <div class="footer">
    <strong>WhisperRoom, Inc.</strong> &middot; 322 Nancy Lynn Lane, Suite 14 &middot; Knoxville, TN 37919<br>
    <a href="tel:18002008168">1-800-200-8168</a> &middot; <a href="mailto:info@whisperroom.com">info@whisperroom.com</a> &middot; <a href="https://www.whisperroom.com" target="_blank">whisperroom.com</a>
  </div>

</div>

<div class="action-bar" id="action-bar">
  ${paymentUrl
    ? `<button class="btn btn-pay" onclick="window.open('${paymentUrl}','_blank')">&#x1F4B3;&nbsp;&nbsp;Pay Now — ${fmt(total)}</button>`
    : `<button class="btn btn-pay" style="opacity:.5;cursor:not-allowed" title="Payment link not available">&#x1F4B3;&nbsp;&nbsp;Pay Now — ${fmt(total)}</button>`
  }
  <button class="btn btn-secondary" onclick="window.print()">&#x2B07;&nbsp;&nbsp;Download PDF</button>
</div>

<script>
  document.title = 'Invoice ${q.quoteNumber||''}${q.dealName ? ' — ' + q.dealName.replace(/[<>]/g,'') : ''}';
</script>
</body>
</html>`;

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end('<h2 style="font-family:sans-serif;padding:40px">Error: ' + e.message + '</h2>');
    }
    return;
  }

    if (pathname.startsWith('/q/') && req.method === 'GET') {
    const quoteId = decodeURIComponent(pathname.replace('/q/', '').trim());
    if (!quoteId) { res.writeHead(404); res.end('Not found'); return; }
    try {
      let quoteData = await getQuoteFromDb(quoteId);

      if (!quoteData) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><head><title>Quote Not Found</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:#f5f5f5}div{text-align:center}</style></head><body><div><h2 style="color:#ee6216">Quote Not Found</h2><p style="color:#888">This link may have expired or the quote number is incorrect.</p></div></body></html>');
        return;
      }
      const qToken = new URLSearchParams(search).get('t');
      if (!validateShareToken(quoteData, qToken)) {
        res.writeHead(403, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><head><title>Link Expired</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:#f5f5f5}div{text-align:center}</style></head><body><div><h2 style="color:#ee6216">This link is no longer valid</h2><p style="color:#888;margin-top:8px">Please contact your WhisperRoom representative for an updated link.</p></div></body></html>');
        return;
      }

      const q = quoteData;
      const fmt = n => '$' + parseFloat(n||0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,',');
      const sub = (q.lineItems||[]).reduce((s,i)=>s+(i.price*i.qty),0);
      const disc = q.discount && q.discount.value > 0
        ? (q.discount.type==='pct' ? sub*q.discount.value/100 : q.discount.value) : 0;
      const freightTbd = q.freight?.tbd === true;
      const freight = (!freightTbd && q.freight) ? q.freight.total : 0;
      const tax = q.tax ? q.tax.tax : 0;
      const total = sub - disc + freight + tax;
      const c = q.customer || {};

      const lineRows = (q.lineItems||[]).map(item =>
        `<tr>
          <td style="padding:12px 0;border-bottom:1px solid #f5f5f5;padding-right:16px">
            <div class="item-name">${item.name}</div>
            ${item.description?`<div class="item-desc">${item.description.replace(/\n/g,'<br>')}</div>`:''}
          </td>
          <td style="padding:12px 0;border-bottom:1px solid #f5f5f5;text-align:center;color:#888;width:50px">${item.qty}</td>
          <td style="padding:12px 0;border-bottom:1px solid #f5f5f5;text-align:right;color:#888;width:110px">${fmt(item.price)}</td>
          <td style="padding:12px 0;border-bottom:1px solid #f5f5f5;text-align:right;font-weight:700;color:#1a1a1a;width:110px">${fmt(item.price*item.qty)}</td>
        </tr>`
      ).join('');

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhisperRoom Quote ${q.quoteNumber||''}</title>
<link rel="icon" href="/assets/favicon.avif">
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;0,9..40,800;1,9..40,400&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7f6f4;color:#1a1a1a;-webkit-font-smoothing:antialiased}
.page{max-width:840px;margin:0 auto;padding:0 0 110px}

/* Header — white with orange left border */
.header-card{background:#ffffff;padding:32px 40px 28px;margin-bottom:0;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:20px;border-left:6px solid transparent;border-image:linear-gradient(to bottom,#ee6216 0%,rgba(238,98,22,.15) 70%,transparent 100%) 1;box-shadow:0 2px 12px rgba(0,0,0,.08)}
.logo-img{height:40px;display:block}
.header-right{text-align:right}
.quote-type{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.16em;color:#ee6216;margin-bottom:8px}
.quote-num{font-size:34px;font-weight:800;color:#1a1a1a;letter-spacing:-.8px;font-variant-numeric:tabular-nums;line-height:1}
.quote-meta{font-size:12px;color:#aaa;margin-top:6px}
.quote-valid-tag{display:inline-block;margin-top:8px;background:#ee6216;color:white;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;padding:4px 12px;border-radius:3px}

/* Divider */
.accent-strip{height:1px;background:#eee;margin-bottom:20px}

/* Cards */
.card{background:#fff;border-radius:10px;padding:30px 36px;margin:0 0 12px;box-shadow:0 1px 4px rgba(0,0,0,.06);border:1px solid #f0f0f0}
.card-label{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;color:#ee6216;margin-bottom:18px}
.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.info-item label{font-size:10px;color:#bbb;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:4px}
.info-item span{font-size:14px;font-weight:600;color:#1a1a1a}

/* Table */
table{width:100%;border-collapse:collapse}
thead th{font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;color:#ccc;padding:0 0 16px;border-bottom:2px solid #f5f5f5;text-align:left}
thead th:nth-child(2){text-align:center}
thead th:nth-child(3),thead th:nth-child(4){text-align:right}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover td{background:#fdfcfb}
.item-name{font-weight:700;color:#1a1a1a;font-size:14px}
.item-desc{font-size:11px;color:#bbb;margin-top:4px;line-height:1.6}

/* Totals */
.totals{max-width:320px;margin-left:auto;margin-top:28px;padding-top:20px;border-top:2px solid #f5f5f5}
.tot{display:flex;justify-content:space-between;padding:7px 0;font-size:13px;color:#999}
.tot.grand{font-size:26px;font-weight:800;color:#1a1a1a;padding-top:18px;margin-top:10px;border-top:2px solid #1a1a1a}
.tot.grand span:last-child{color:#ee6216}
.discount-val{color:#1a7a4a!important;font-weight:600}

/* Terms */
.terms{font-size:11px;color:#bbb;line-height:1.9}

/* Bottom bar */
.action-bar{position:fixed;bottom:0;left:0;right:0;background:rgba(20,20,20,.97);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-top:1px solid rgba(255,255,255,.06);padding:16px 28px;display:flex;gap:12px;justify-content:center;align-items:center;z-index:100}
.btn{padding:13px 32px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;border:none;letter-spacing:.04em;font-family:inherit;transition:all .15s}
.btn-primary{background:rgba(255,255,255,.08);color:rgba(255,255,255,.65);border:1px solid rgba(255,255,255,.12)}
.btn-primary:hover{background:rgba(255,255,255,.14);color:white}
.btn-secondary{background:rgba(255,255,255,.05);color:rgba(255,255,255,.45);border:1px solid rgba(255,255,255,.08)}
.btn-secondary:hover{background:rgba(255,255,255,.09);color:rgba(255,255,255,.65)}
.btn-accept{background:#ee6216;color:white;font-size:14px;font-weight:800;padding:14px 40px;letter-spacing:.02em}
.btn-accept:hover{background:#d4561a;transform:translateY(-1px);box-shadow:0 6px 24px rgba(238,98,22,.5)}

/* Footer */
.footer{text-align:center;margin:24px 0 0;padding:24px 32px;font-size:11px;color:#bbb;line-height:2.1;border-top:1px solid #ece9e4}
.footer a{color:#ee6216;text-decoration:none}
.footer strong{color:#888;font-weight:600}

@media(max-width:600px){
  .header-card{padding:24px 20px;border-left:4px solid transparent;border-image:linear-gradient(to bottom,#ee6216 0%,rgba(238,98,22,.15) 70%,transparent 100%) 1}
  .logo-img{height:30px}
  .header-right{text-align:left}
  .quote-num{font-size:26px}
  .card{padding:22px 20px}
  .info-grid{grid-template-columns:1fr}
  .action-bar{flex-direction:column;padding:14px 16px}
  .btn{width:100%;text-align:center}
}
@media print{
  body{background:white}
  .action-bar{display:none!important}
  .page{padding-bottom:20px}
  .header-card{border-left:6px solid #ee6216!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;border-image:none!important}
  .card{box-shadow:none}
}
</style>
</head>
<body>
<div class="page">

  <div class="header-card">
    <img src="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTUwIiBoZWlnaHQ9IjMxIiB2aWV3Qm94PSIwIDAgMTUwIDMxIiBmaWxsPSJub25lIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPgo8cGF0aCBkPSJNNDMuNzg4NiAxNC45NjdDNDMuNjI0MiAxNC43OTgzIDQzLjUwOTEgMTQuNTQ1MSA0My40NTk4IDE0LjMwODhDNDMuMzYxMSAxMy44MzYzIDQzLjQ3NjIgMTMuMzYzNyA0My42NzM2IDEyLjk0MThDNDQuMDAyNCAxMi4yNDk4IDQ0LjU5NDMgMTEuNzA5OCA0NS4yNTIgMTEuMzcyM0M0NS43NDUzIDExLjEzNiA0Ni4yODc5IDExLjAwMSA0Ni44MzA1IDExLjA1MTZDNDcuMjQxNiAxMS4xMDIyIDQ3LjY2OTEgMTEuMjU0MSA0Ny45NDg2IDExLjU0MUM0OC4xMjk1IDExLjcyNjcgNDguMjYxMSAxMS45Nzk4IDQ4LjMyNjggMTIuMjMzQzQ4LjQ0MTkgMTIuNzM5MyA0OC4zMTA0IDEzLjMzIDQ4LjAzMDkgMTMuNzY4OEM0Ny43NTEzIDE0LjIyNDQgNDcuMzA3NCAxNC41MjgyIDQ2Ljg0NyAxNC43ODE0QzQ2LjI3MTUgMTUuMDg1MiA0NS42Nzk2IDE1LjMwNDYgNDUuMDA1NCAxNS4zMzgzQzQ0LjU3NzkgMTUuMzU1MiA0NC4wODQ2IDE1LjI4NzcgNDMuNzg4NiAxNC45NjdaIiBmaWxsPSIjMjYyNjI2Ii8+CjxwYXRoIGQ9Ik0zMi4xMzc3IDEyLjM1MjdDMzIuMjIxNCAxMi4zMzYxIDMyLjMyMTggMTIuMzE5NSAzMi4zODg3IDEyLjM1MjdDMzIuNTIyNSAxMi40MDI1IDMyLjU3MjggMTIuNTg1MSAzMi42MDYyIDEyLjczNDZDMzIuNjM5NyAxMi44Njc0IDMyLjY1NjQgMTIuOTgzNiAzMi42NzMxIDEzLjA5OTlDMzIuNzA2NiAxMy40MTU0IDMyLjc0MDEgMTMuNzQ3NSAzMi43NTY4IDE0LjA3OTVDMzIuODIzNyAxNC45NTk2IDMyLjg0MDUgMTUuODIzIDMyLjg3MzkgMTYuNjg2NEMzMi45MDc0IDE4LjE2NDIgMzIuOTQwOSAxOS42NDIgMzIuOTI0MSAyMS4xMTk4QzMyLjkyNDEgMjEuODY3IDMyLjkwNzQgMjIuNTk3NiAzMi44OTA3IDIzLjM0NDhDMzIuODkwNyAyMy42MTA1IDMyLjg5MDcgMjMuODc2MSAzMi44NzM5IDI0LjE0MThDMzIuODU3MiAyNC4zMDc4IDMyLjg1NzIgMjQuNDkwNSAzMi44MjM3IDI0LjY1NjVDMzIuODA3IDI0LjgyMjYgMzIuNzU2OCAyNC45ODg2IDMyLjY4OTkgMjUuMTIxNUMzMi42MjMgMjUuMjcwOSAzMi41MDU4IDI1LjQwMzcgMzIuMzg4NyAyNS41MkMzMi4zMDUgMjUuNjAzIDMyLjIyMTQgMjUuNjg2IDMyLjEzNzcgMjUuNzY5QzMzLjg3NzkgMjUuNzY5IDM1LjYwMTQgMjUuNzY5IDM3LjM0MTYgMjUuNzY5QzM3LjIwNzcgMjUuNjUyOCAzNy4wOTA2IDI1LjUyIDM2Ljk3MzUgMjUuMzg3MUMzNi44NTYzIDI1LjI1NDMgMzYuNzU1OSAyNS4xMDQ5IDM2LjcwNTcgMjQuOTM4OEMzNi42NTU1IDI0Ljc1NjIgMzYuNjM4OCAyNC41NzM1IDM2LjYzODggMjQuMzkwOUMzNi42Mzg4IDIzLjk5MjQgMzYuNjM4OCAyMy42MTA1IDM2LjY1NTUgMjMuMjI4NkMzNi42NzIzIDIyLjQ4MTQgMzYuNjU1NSAyMS43MTc2IDM2LjY1NTUgMjAuOTcwNEMzNi42NTU1IDIwLjUzODYgMzYuNjcyMyAyMC4xMjM1IDM2LjY1NTUgMTkuNjkxOEMzNi42NTU1IDE5LjU1OSAzNi42NTU1IDE5LjQyNjEgMzYuNjU1NSAxOS4yNzY3QzM2LjY3MjMgMTkuMTEwNyAzNi42ODkgMTguOTQ0NiAzNi43NTU5IDE4Ljc5NTJDMzYuODIyOSAxOC42NDU3IDM2LjkyMzMgMTguNTEyOSAzNy4wNDA0IDE4LjM5NjdDMzcuMjU3OSAxOC4xOTc0IDM3LjU1OTEgMTguMTE0NCAzNy44NjAzIDE4LjA5NzhDMzguMDc3OCAxOC4wOTc4IDM4LjI5NTQgMTguMTMxIDM4LjQ3OTQgMTguMjMwNkMzOC42ODAyIDE4LjMzMDMgMzguODQ3NSAxOC40OTYzIDM4Ljk0NzkgMTguNjk1NkMzOS4wNjUxIDE4LjkxMTQgMzkuMDk4NSAxOS4xNDM5IDM5LjExNTMgMTkuMzkyOUMzOS4xMzIgMTkuNTU5IDM5LjExNTMgMTkuNzI1IDM5LjExNTMgMTkuODkxMUMzOS4xMTUzIDIwLjIwNjYgMzkuMTE1MyAyMC41MDU0IDM5LjExNTMgMjAuODIwOUMzOS4xMTUzIDIxLjE4NjIgMzkuMTE1MyAyMS41NjgxIDM5LjExNTMgMjEuOTMzNEMzOS4xMTUzIDIyLjM2NTEgMzkuMTE1MyAyMi44MTM0IDM5LjExNTMgMjMuMjQ1MkMzOS4xMTUzIDIzLjYxMDUgMzkuMTE1MyAyMy45NTkxIDM5LjExNTMgMjQuMzI0NEMzOS4xMTUzIDI0LjQ3MzkgMzkuMTE1MyAyNC42MjMzIDM5LjA4MTggMjQuNzcyOEMzOS4wNDgzIDI0LjkzODggMzguOTY0NyAyNS4wODgyIDM4Ljg2NDMgMjUuMjIxMUMzOC43NDcxIDI1LjM4NzEgMzguNjMgMjUuNTM2NiAzOC40Nzk0IDI1LjY2OTRDMzguNDQ1OSAyNS43MDI2IDM4LjM5NTcgMjUuNzM1OCAzOC4zNjIzIDI1Ljc2OUM0MC44ODg5IDI1Ljc2OSA0My40MzIzIDI1Ljc2OSA0NS45NTkgMjUuNzY5QzQ2LjQ5NDQgMjUuNzY5IDQ3LjAxMzEgMjUuNzY5IDQ3LjU0ODYgMjUuNzY5QzQ3Ljk1MDIgMjUuNzY5IDQ4LjMzNSAyNS43NjkgNDguNzM2NiAyNS43NjlDNDguODcwNCAyNS43NjkgNDguOTg3NiAyNS43NjkgNDkuMTIxNCAyNS43NjlDNDkuMDcxMiAyNS42ODYgNDkuMDIxIDI1LjYwMyA0OC45NzA4IDI1LjUzNjZDNDguODg3MiAyNS40MjAzIDQ4Ljc3MDEgMjUuMzIwNyA0OC42ODY0IDI1LjIyMTFDNDguNjE5NSAyNS4xNTQ3IDQ4LjU2OTMgMjUuMDcxNiA0OC41MzU4IDI0Ljk4ODZDNDguNDM1NCAyNC43NTYyIDQ4LjQwMTkgMjQuNTA3MSA0OC4zODUyIDI0LjI1OEM0OC4zODUyIDI0LjE3NSA0OC4zNjg1IDI0LjA5MiA0OC4zNjg1IDI0LjAwOUM0OC4zNTE3IDIzLjgwOTcgNDguMzY4NSAyMy41OTM4IDQ4LjM2ODUgMjMuMzk0NkM0OC4zNjg1IDIzLjA0NTkgNDguMzY4NSAyMi43MTM4IDQ4LjM2ODUgMjIuMzY1MUM0OC4zNTE3IDIwLjgyMDkgNDguMzY4NSAxOS4yNjAxIDQ4LjM2ODUgMTcuNzE1OUM0OC4zNjg1IDE3LjU4MzEgNDguMzY4NSAxNy40NTAyIDQ4LjM2ODUgMTcuMzE3NEM0OC4zNjg1IDE3LjA2ODMgNDguMzg1MiAxNi44MTkzIDQ4LjQxODcgMTYuNTcwMkM0OC40MzU0IDE2LjQzNzQgNDguNDUyMSAxNi4zMDQ1IDQ4LjQ2ODkgMTYuMTU1MUM0OC40ODU2IDE2LjAyMjMgNDguNTAyMyAxNS44NzI4IDQ4LjQzNTQgMTUuNzU2NkM0OC4zODUyIDE1LjY1NyA0OC4yODQ4IDE1LjU5MDUgNDguMTY3NyAxNS41NTczQzQ4LjAzMzggMTUuNTI0MSA0Ny44ODMyIDE1LjU1NzMgNDcuNzQ5NCAxNS41OTA1QzQ3LjU0ODYgMTUuNjQwMyA0Ny4zODEyIDE1LjY3MzYgNDcuMTYzNyAxNS42OTAyQzQ3LjA2MzMgMTUuNzA2OCA0Ni45NDYyIDE1LjcwNjggNDYuODI5MSAxNS43MDY4QzQ2LjE1OTcgMTUuNzQgNDUuNTc0MSAxNS43NTY2IDQ0Ljk3MTcgMTUuNzU2NkM0NC43NTQyIDE1Ljc1NjYgNDQuNTUzNCAxNS43NTY2IDQ0LjMzNTkgMTUuNzU2NkM0NC4yMDIgMTUuNzU2NiA0NC4wNjgxIDE1Ljc1NjYgNDMuOTM0MyAxNS43NTY2QzQzLjg1MDYgMTUuNzU2NiA0My43NjcgMTUuNzU2NiA0My42ODMzIDE1Ljc3MzJDNDMuNjE2NCAxNS43ODk4IDQzLjU0OTQgMTUuNzg5OCA0My40OTkyIDE1LjgzOTZDNDMuNDMyMyAxNS45MDYgNDMuMzk4OCAxNi4wMDU2IDQzLjM5ODggMTYuMTA1M0M0My40MTU2IDE2LjI3MTMgNDMuNTE2IDE2LjM4NzUgNDMuNjE2NCAxNi41MDM4QzQzLjczMzUgMTYuNjUzMiA0My44MzM5IDE2Ljc4NiA0My45MTc2IDE2LjkxODlDNDMuOTY3OCAxNi45ODUzIDQ0LjAxOCAxNy4wNTE3IDQ0LjA1MTQgMTcuMjE3OEM0NC4wNjgxIDE3LjMzNCA0NC4wODQ5IDE3LjUxNjYgNDQuMTAxNiAxNy42NjYxQzQ0LjEzNTEgMTguMDQ4IDQ0LjExODQgMTguMTgwOCA0NC4xMTg0IDE4LjMzMDNDNDQuMTAxNiAxOS4wNDQyIDQ0LjExODQgMjAuMDU3MSA0NC4xMTg0IDIxLjA1MzRDNDQuMTE4NCAyMS4zODU1IDQ0LjExODQgMjEuNzAxIDQ0LjExODQgMjIuMDMzQzQ0LjExODQgMjIuNTQ3OCA0NC4xMTg0IDIzLjA0NTkgNDQuMTE4NCAyMy41NjA2QzQ0LjExODQgMjMuNjkzNSA0NC4xMTg0IDIzLjgyNjMgNDQuMTE4NCAyMy45NDI1QzQ0LjExODQgMjQuMDkyIDQ0LjEwMTYgMjQuMjQxNCA0NC4wNjgyIDI0LjM5MDlDNDQuMDM0NyAyNC41NTY5IDQ0LjAwMTIgMjQuNzA2MyA0My45MTc2IDI0Ljg3MjRDNDMuODE3MiAyNS4wNTUgNDMuNjY2NiAyNS4yNTQzIDQzLjUzMjcgMjUuMjU0M0M0My4zOTg4IDI1LjIzNzcgNDMuMjgxNyAyNS4wMzg0IDQzLjE5OCAyNC44NzI0QzQzLjEzMTEgMjQuNzIzIDQzLjA5NzYgMjQuNTkwMSA0My4wOTc2IDI0LjQ1NzNDNDMuMDgwOSAyNC4zMDc4IDQzLjA4MDkgMjQuMTI1MiA0My4wODA5IDIzLjk1OTFDNDMuMDgwOSAyMi44NjMzIDQzLjA4MDkgMjEuODAwNiA0My4wODA5IDIwLjczNzlDNDMuMDgwOSAyMC4zMDYyIDQzLjA4MDkgMTkuODU3OSA0My4wODA5IDE5LjQyNjFDNDMuMDgwOSAxOS4yNzY3IDQzLjA4MDkgMTkuMTQzOSA0My4wODA5IDE4Ljk5NDRDNDMuMDY0MiAxOC41NDYxIDQzLjAxNCAxOC4wOTc4IDQyLjg0NjcgMTcuNjgyN0M0Mi41NDU1IDE2Ljk2ODcgNDEuODkyOSAxNi4zODc1IDQxLjE1NjcgMTYuMDM4OUM0MC42NzE0IDE1LjgwNjQgNDAuMTUyNyAxNS42OTAyIDM5LjYxNzIgMTUuNjU3QzM4Ljk5ODEgMTUuNjIzNyAzOC4zNjIzIDE1LjcwNjggMzcuNzU5OSAxNS44NzI4QzM3LjQwODUgMTUuOTU1OCAzNy4wNzM5IDE2LjA3MjEgMzYuNzU1OSAxNi4yMDQ5QzM2Ljc1NTkgMTUuNDkwOSAzNi43NzI3IDE0Ljc3NjkgMzYuNzcyNyAxNC4wNzk1QzM2Ljc3MjcgMTMuNzgwNyAzNi43NzI3IDEzLjQ5ODQgMzYuNzg5NCAxMy4xOTk1QzM2Ljc4OTQgMTMuMDgzMyAzNi44MDYxIDEyLjk4MzYgMzYuODA2MSAxMi44Njc0QzM2LjgyMjkgMTIuNjY4MiAzNi44MjI5IDEyLjQ2ODkgMzYuODU2MyAxMi4yNjk3QzM2Ljg3MzEgMTIuMDcwNCAzNi45MDY1IDExLjg1NDUgMzYuODM5NiAxMS43MzgzQzM2LjgwNjEgMTEuNjcxOSAzNi43NTU5IDExLjYzODcgMzYuNjcyMyAxMS42MDU1QzM2LjUzODQgMTEuNTU1NyAzNi4zNzExIDExLjU4ODkgMzYuMjAzOCAxMS42MjIxQzM2LjA1MzIgMTEuNjU1MyAzNS45MTkzIDExLjY3MTkgMzUuNzY4NyAxMS43MDUxQzM1LjYwMTQgMTEuNzM4MyAzNS40MzQgMTEuNzM4MyAzNS4yNjY3IDExLjc1NDlDMzQuOTMyMSAxMS43NzE1IDM0LjYxNDIgMTEuNzcxNSAzNC4yNzk1IDExLjc3MTVDMzMuNjQzNyAxMS43ODgxIDMzLjAwNzggMTEuNzg4MSAzMi4zNzIgMTEuNzg4MUMzMi4yNTQ4IDExLjk3MDggMzIuMjA0NiAxMi4xNTM0IDMyLjEzNzcgMTIuMzUyN1oiIGZpbGw9IiMyNjI2MjYiLz4KPHBhdGggZD0iTTEyLjg0ODYgMTguMDkyOEMxMy40NDMgMTUuODc4NyAxNC4wMTM3IDEzLjY4ODMgMTQuNTM2OCAxMS40NzQyQzE0LjY1NTcgMTAuOTc0MiAxNC43NzQ2IDEwLjQ3NDMgMTQuODkzNSA5Ljk5ODExQzE1LjA2IDkuMzU1MjkgMTUuMjI2NCA4LjczNjI4IDE1LjM5MjkgOC4xMTcyN0MxNS41MTE3IDcuNjY0OTIgMTUuNjA2OSA3LjIxMjU3IDE1LjcyNTcgNi43NjAyMkMxNS43OTcxIDYuNDUwNzIgMTUuODY4NCA2LjE2NTAyIDE1LjkxNiA1Ljg1NTUxQzE1Ljk2MzUgNS41OTM2MiAxNi4wMTExIDUuMzU1NTUgMTYuMDExMSA1LjA5MzY2QzE2LjAxMTEgNC43ODQxNiAxNS45NjM1IDQuNDUwODQgMTUuODkyMiA0LjE0MTM0QzE1LjgyMDkgMy43ODQyMiAxNS43MjU3IDMuNDUwOSAxNS41ODMxIDMuMTE3NTlDMTUuMjc0IDIuMzA4MTIgMTQuNzc0NiAxLjU3MDA3IDE0LjE1NjQgMC45NzQ4NzNDMTYuOTg2IDAuOTc0ODczIDE5LjgzOTQgMC45NzQ4NzMgMjIuNjY5IDAuOTc0ODczQzIyLjU5NzYgMS4wOTM5MSAyMi41MjYzIDEuMjEyOTUgMjIuNTAyNSAxLjM1NThDMjIuNDMxMiAxLjYxNzY5IDIyLjQwNzQgMS44Nzk1OCAyMi40MDc0IDIuMTY1MjdDMjIuNDMxMiAyLjg3OTUxIDIyLjU3MzkgMy41Njk5NSAyMi43NjQxIDQuMjM2NTdDMjIuOTc4MSA1LjA0NjA0IDIzLjIxNTkgNS44NTU1MiAyMy40NTM3IDYuNjY0OTlDMjMuODEwMyA3Ljg1NTM5IDI0LjE5MDggOS4wNjk1OSAyNC41NDc1IDEwLjI2QzI1LjMwODQgMTIuNzU5OCAyNi4wMjE3IDE1LjI1OTcgMjYuNzM1IDE3Ljc1OTVDMjcuMzUzMyAxNS4zNTQ5IDI3Ljk5NTMgMTIuOTUwMyAyOC43MzI0IDEwLjU2OTVDMjguODUxMyAxMC4xNDEgMjguOTk0IDkuNzEyNDEgMjkuMTEyOSA5LjI4Mzg3QzI5LjMyNjkgOC41NDU4MiAyOS41MTcxIDcuNzgzOTYgMjkuNzMxMSA3LjA0NTkxQzI5Ljg3MzggNi41Njk3NSAzMC4wMTY0IDYuMDkzNTkgMzAuMTM1MyA1LjYxNzQzQzMwLjIzMDQgNS4xODg4OSAzMC4zMjU2IDQuNzYwMzUgMzAuMzQ5MyA0LjMzMThDMzAuMzczMSAzLjk5ODQ5IDMwLjM3MzEgMy42NjUxOCAzMC4zMjU2IDMuMzMxODdDMzAuMjU0MiAyLjkyNzEzIDMwLjA4NzggMi41MjI0IDI5Ljg3MzggMi4xNDE0N0MyOS43MDczIDEuODc5NTggMjkuNTQwOSAxLjYxNzY5IDI5LjMyNjkgMS4zNzk2MUMyOS4yMDggMS4yMTI5NiAyOS4wNjUzIDEuMDcwMTEgMjguOTIyNiAwLjkyNzI2MkMzMC42MzQ3IDAuOTI3MjYyIDMyLjMyMjkgMC45MjcyNjIgMzQuMDM1IDAuOTI3MjYyQzM0LjMyMDMgMC45MjcyNjIgMzQuNTgxOSAwLjkyNzI2MiAzNC44NjcyIDAuOTI3MjYyQzM1LjEyODggMC45MjcyNjIgMzUuMzY2NSAwLjkwMzQ1MSAzNS42MjgxIDAuOTk4NjgzQzM1LjY3NTcgMS4wMjI0OSAzNS43MjMyIDEuMDIyNDkgMzUuNzQ3IDEuMDQ2M0MzNS44NDIxIDEuMTQxNTMgMzUuNzcwOCAxLjMzMiAzNS43MjMyIDEuNDk4NjVDMzUuNjI4MSAxLjc4NDM1IDM1LjU1NjggMi4wMjI0MyAzNS40NjE3IDIuMjM2N0MzMy4zNDU0IDguNjY0ODYgMzAuOTQzOCAxNi40NzM5IDI4Ljc4IDIzLjYxNjNDMjguNjYxMSAyNC4wNDQ4IDI4LjUxODQgMjQuNDQ5NiAyOC4zOTk1IDI0Ljg3ODFDMjguMzI4MiAyNS4wOTI0IDI4LjI4MDYgMjUuMzA2NiAyOC4yMDkzIDI1LjQ5NzFDMjguMTYxNyAyNS42MTYxIDI4LjExNDIgMjUuNzM1MiAyOC4wNjY2IDI1Ljg1NDJDMjguMDE5MSAyNS45NzMzIDI3Ljk3MTUgMjYuMTE2MSAyNy44NzY0IDI2LjE2MzdDMjcuNzU3NSAyNi4yMzUyIDI3LjU2NzMgMjYuMTg3NSAyNy40MDA4IDI2LjEzOTlDMjYuODc3NyAyNS45OTcxIDI2LjQ5NzMgMjUuODU0MiAyNi4wNjkzIDI1LjY2MzhDMjUuMzU1OSAyNS4zNTQzIDI0LjU5NSAyNC45NzMzIDIzLjg4MTcgMjQuNTQ0OEMyMy4yODcyIDI0LjE4NzcgMjIuNjkyOCAyMy44MDY3IDIyLjI2NDcgMjMuMjgzQzIxLjkwODEgMjIuODU0NCAyMS42NzAzIDIyLjMzMDYgMjEuNDU2MyAyMS44MDY5QzIxLjA3NTggMjAuOTAyMiAyMC43OTA1IDE5Ljk3MzcgMjAuNDgxNCAxOS4wNDUxQzIwLjA3NzIgMTcuODA3MSAxOS42NzI5IDE2LjU0NTMgMTkuMjkyNSAxNS4zMDczQzE4Ljg4ODIgMTMuOTc0IDE4LjUwNzggMTIuNjQwOCAxOC4xNzQ5IDExLjI4MzdDMTcuOTg0NyAxMS45NTA0IDE3Ljc5NDQgMTIuNjQwOCAxNy42MDQyIDEzLjMwNzRDMTcuMjk1MSAxNC40MDI2IDE3LjAwOTggMTUuNDczOSAxNi43MjQ0IDE2LjU2OTFDMTYuNDYyOSAxNy41NjkgMTYuMjI1MSAxOC41NDUyIDE1Ljk2MzUgMTkuNTQ1MUMxNS43NDk1IDIwLjQwMjIgMTUuNTExNyAyMS4yNTkzIDE1LjI3NCAyMi4wOTI2QzE1LjEwNzUgMjIuNzExNiAxNC45NjQ4IDIzLjMzMDYgMTQuODIyMiAyMy45MjU4QzE0Ljc1MDggMjQuMjM1MyAxNC42NTU3IDI0LjU2ODYgMTQuNTg0NCAyNC44NzgxQzE0LjUzNjggMjUuMTE2MiAxNC40NjU1IDI1LjMzMDUgMTQuNDE3OSAyNS41Njg1QzE0LjM5NDIgMjUuNjYzOCAxNC4zNzA0IDI1LjczNTIgMTQuMzQ2NiAyNS44MDY2QzE0LjMyMjggMjUuODU0MiAxNC4yNzUzIDI1LjkwMTggMTQuMjI3NyAyNS45NDk1QzE0LjA4NTEgMjYuMDY4NSAxMy44NDczIDI2LjA0NDcgMTMuNjA5NSAyNS45OTcxQzEzLjAzODggMjUuODc4IDEyLjU2MzIgMjUuNzExNCAxMi4wODc3IDI1LjQ5NzFDMTEuMjMxNyAyNS4xNCAxMC4zNTE5IDI0LjY4NzYgOS41NDM0MSAyNC4xNDAxQzkuMTg2NzQgMjMuOTAyIDguODUzODQgMjMuNjE2MyA4LjU2ODUgMjMuMzA2OEM4LjE4ODA1IDIyLjkwMiA3Ljg1NTE2IDIyLjQwMjEgNy41OTM2IDIxLjkwMjFDNy4xMTgwMyAyMS4wMjEyIDYuODA4OTIgMjAuMDkyNyA2LjQ3NjAzIDE5LjE0MDRDNi4wOTU1NyAxOC4wNDUyIDUuNzE1MTIgMTYuOTczOCA1LjMzNDY3IDE1Ljg3ODdDNC40MDczMiAxMy4xNDA4IDMuNTk4ODYgMTAuMzU1MiAyLjk1Njg1IDcuNTQ1ODhDMi43OTA0IDYuODU1NDUgMi42NDc3MyA2LjE2NTAyIDIuNTI4ODQgNS40NzQ1OUMyLjQ4MTI5IDUuMjEyNyAyLjQzMzczIDQuOTc0NjIgMi4zNjIzOSA0LjcxMjczQzIuMjY3MjggNC40MDMyMyAyLjEyNDYyIDQuMTQxMzQgMS45ODE5NSAzLjg1NTY0QzEuNjQ5MDUgMy4xODkwMiAxLjMzOTkzIDIuNDk4NTkgMC44NjQzNjggMS45NTFDMC42NzQxNDIgMS43MzY3MyAwLjQ2MDEzNiAxLjUyMjQ2IDAuMjIyMzU0IDEuMzMxOTlDMC4xNTEwMTkgMS4yNjA1NyAwLjA3OTY4ODcgMS4yMTI5NSAwLjA1NTkxMDUgMS4xMTc3MkMwLjAwODM1NDEzIDEuMDIyNDkgLTAuMDE1NDI3IDAuOTI3MjYzIDAuMDA4MzUxMjMgMC44MzIwMzFDMS43Njc5NCAwLjgzMjAzMSAzLjUwMzc1IDAuODMyMDMxIDUuMjYzMzQgMC44MzIwMzFDNS45MjkxMiAwLjgzMjAzMSA2LjU3MTE0IDAuODMyMDMxIDcuMjEzMTUgMC44MzIwMzFDNy40MDMzOCAwLjgzMjAzMSA3LjU5MzYgMC44MzIwMzEgNy44MDc2MSAwLjgzMjAzMUM3Ljk1MDI3IDAuODMyMDMxIDguMDkyOTQgMC44MzIwMjcgOC4yMTE4MyAwLjg3OTY0M0M4LjMzMDcyIDAuOTI3MjU5IDguNDI1ODQgMS4wNDYzIDguNDk3MTcgMS4xODkxNUM4LjYxNjA2IDEuMzc5NjIgOC42NjM2MiAxLjYxNzY5IDguNzExMTcgMS44MzE5NkM4LjkyNTE4IDIuNzEyODYgOS4xNjI5NiAzLjU0NjE0IDkuNDI0NTIgNC4zNzk0MkMxMC43MzIzIDkuMDIxOTggMTEuNjgzNCAxMy41OTMxIDEyLjg0ODYgMTguMDkyOFoiIGZpbGw9IiMyNjI2MjYiLz4KPHBhdGggZD0iTTQ4LjY4OTUgMjMuMTUzOUM0OS4wMzg0IDIzLjM0NyA0OS40MjYgMjMuNTQwMSA0OS43NzQ5IDIzLjY5NDZDNTAuMDQ2MyAyMy44NDkgNTAuMzU2NCAyMy45NjQ5IDUwLjYyNzggMjQuMDgwN0M1MS4wMTU1IDI0LjE5NjYgNTEuNDAzMSAyNC4yNzM4IDUxLjc5MDggMjQuMzEyNEM1Mi4yOTQ4IDI0LjM4OTcgNTIuODM3NSAyNC40MjgzIDUzLjM0MTUgMjQuMjM1MkM1My41MzUzIDI0LjE1OCA1My43MjkyIDI0LjA4MDcgNTMuODQ1NSAyMy45MjYzQzUzLjkyMyAyMy43NzE4IDUzLjk2MTggMjMuNjE3MyA1My45NjE4IDIzLjQyNDJDNTMuOTYxOCAyMy4yNjk4IDUzLjg4NDIgMjMuMTE1MyA1My44MDY3IDIyLjk5OTRDNTMuNjkwNCAyMi44NDUgNTMuNDk2NiAyMi43Njc3IDUzLjMwMjcgMjIuNjkwNUM1Mi43OTg4IDIyLjQ1ODggNTIuMzMzNiAyMi4yMjcxIDUxLjg2ODMgMjEuOTk1NEM1MS40NDE5IDIxLjgwMjMgNTAuOTc2NyAyMS42MDkyIDUwLjU1MDMgMjEuMzc3NUM1MC4yNDAxIDIxLjE4NDQgNDkuOTMgMjAuOTkxMyA0OS42NTg2IDIwLjcyMUM0OS4zNDg1IDIwLjQxMjEgNDkuMTE1OSAyMC4wMjU5IDQ4Ljk5OTYgMTkuNjAxMUM0OC44ODMzIDE5LjE3NjMgNDguOTIyMSAxOC43MTI5IDQ5LjAzODQgMTguMjQ5NUM0OS4xOTM0IDE3Ljc4NjEgNDkuNDY0OCAxNy4zNjEzIDQ5Ljc3NDkgMTcuMDEzN0M1MC4zOTUyIDE2LjM5NTggNTEuMjA5MyAxNi4wMDk3IDUyLjA2MjIgMTUuODE2NkM1Mi42NDM3IDE1LjcwMDcgNTMuMTg2NCAxNS42NjIxIDUzLjc2NzkgMTUuNjYyMUM1NC4zNDk0IDE1LjY2MjEgNTQuOTY5NyAxNS43MDA3IDU1LjQ3MzcgMTUuNzc4QzU1LjY2NzUgMTUuODE2NiA1NS44NjEzIDE1Ljg1NTIgNTYuMTMyNyAxNS44OTM4QzU2LjMyNjYgMTUuOTMyNCA1Ni41NTkyIDE2LjAwOTcgNTYuNzE0MiAxNi4wODY5QzU2Ljc5MTggMTYuMTI1NSA1Ni44NjkzIDE2LjIwMjggNTYuOTQ2OCAxNi4zMTg2QzU2Ljk4NTYgMTYuMzk1OCA1Ny4wMjQ0IDE2LjQ3MzEgNTcuMDI0NCAxNi41ODg5QzU3LjAyNDQgMTYuNjY2MiA1Ny4wMjQ0IDE2Ljc0MzQgNTcuMDI0NCAxNi44MjA2QzU3LjAyNDQgMTcuMzk5OSA1Ny4wMjQ0IDE3Ljk0MDYgNTcuMDI0NCAxOC41MTk4QzU2Ljc5MTcgMTguMzY1MyA1Ni41OTc5IDE4LjI0OTUgNTYuMzY1MyAxOC4xMzM2QzU2LjA5MzkgMTguMDE3OCA1NS44MjI2IDE3LjkwMTkgNTUuNTUxMiAxNy44MjQ3QzU1LjA4NiAxNy43MDg4IDU0LjY1OTYgMTcuNjcwMiA1NC4xOTQ0IDE3LjY3MDJDNTMuOTYxOCAxNy42NzAyIDUzLjcyOTIgMTcuNzA4OCA1My40OTY2IDE3Ljc4NjFDNTMuMzAyNyAxNy44NjMzIDUzLjEwODkgMTguMDE3OCA1My4wNzAxIDE4LjIxMDlDNTMuMDMxMyAxOC4zNjUzIDUzLjEwODkgMTguNTk3IDUzLjE4NjQgMTguNzEyOUM1My4zNDE1IDE4Ljk0NDYgNTMuNjEyOSAxOS4wMjE4IDUzLjg4NDIgMTkuMTM3N0M1NC40MjcgMTkuMzMwOCA1NC45Njk3IDE5LjQ4NTMgNTUuNTEyNSAxOS42NzgzQzU1LjkzODkgMTkuODMyOCA1Ni4zNjUzIDIwLjAyNTkgNTYuNzUzIDIwLjI1NzZDNTcuMjk1NyAyMC42MDUyIDU3Ljc5OTcgMjEuMTA3MiA1OC4wNzExIDIxLjcyNTFDNTguMzQyNCAyMi4zODE2IDU4LjMwMzcgMjMuMTUzOSA1OC4wMzIzIDIzLjc3MThDNTcuNzYwOSAyNC4zODk3IDU3LjI1NyAyNC44OTE3IDU2LjY3NTUgMjUuMjM5M0M1Ni4xMzI3IDI1LjU4NjggNTUuNTEyNCAyNS43Nzk5IDU0Ljg5MjIgMjUuODk1N0M1NC4xOTQ0IDI2LjA1MDIgNTMuNDU3OCAyNi4wODg4IDUyLjc2IDI2LjA4ODhDNTEuOTQ1OSAyNi4wODg4IDUxLjEzMTggMjUuOTczIDUwLjM5NTIgMjUuODU3MUM1MC4xMjM4IDI1LjgxODUgNDkuODUyNSAyNS43Nzk5IDQ5LjU0MjMgMjUuNzAyN0M0OS40MjYgMjUuNjY0IDQ5LjM0ODUgMjUuNjI1NCA0OS4yNzEgMjUuNTQ4MkM0OS4yMzIyIDI1LjQ3MSA0OS4xOTM0IDI1LjM1NTEgNDkuMTkzNCAyNS4yNzc5QzQ5LjE1NDcgMjUuMTIzNCA0OS4xNTQ3IDI1LjAwNzYgNDkuMTE1OSAyNC44OTE3QzQ4Ljk5OTYgMjQuNDI4MyA0OC44NDQ1IDIzLjg0OSA0OC42ODk1IDIzLjE1MzlaIiBmaWxsPSIjMjYyNjI2Ii8+CjxwYXRoIGQ9Ik02Mi44ODM3IDI0LjAwMTVDNjMuMDI0NiAyNC4zNzg0IDYzLjE2NTQgMjQuNzU1MyA2My4zMDYyIDI1LjEzMjJDNjMuMzUzMiAyNS4zMjA3IDYzLjQ0NzEgMjUuNDYyIDYzLjQ5NCAyNS42NTA1QzYzLjU0MSAyNS43NDQ3IDYzLjU4NzkgMjUuODg2MSA2My42ODE4IDI1LjkzMzJDNjMuODIyNiAyNi4wMjc0IDY0LjAxMDQgMjYuMDc0NSA2NC4xOTgyIDI2LjA3NDVDNjQuNDc5OSAyNi4wNzQ1IDY0LjcxNDYgMjYuMDc0NSA2NC45OTYzIDI2LjA3NDVDNjUuMjMxIDI2LjA3NDUgNjUuNDY1NyAyNi4wNzQ1IDY1LjY1MzUgMjYuMDc0NUM2Ni4wNzYgMjYuMDI3NCA2Ni40NTE2IDI1Ljg4NjEgNjYuODI3MiAyNS42OTc2QzY3LjIwMjcgMjUuNTA5MiA2Ny41MzEzIDI1LjMyMDcgNjcuODYgMjUuMDM4QzY4LjMyOTQgMjQuNjE0IDY4Ljc1MTkgMjQuMDk1NyA2OC45ODY2IDIzLjUzMDNDNjkuMzYyMiAyMi43Mjk0IDY5LjU1IDIxLjc4NzEgNjkuNTUgMjAuODkxOUM2OS41NSAyMC4yMzIzIDY5LjUwMyAxOS42MTk4IDY5LjMxNTMgMTkuMDA3M0M2OS4xMjc1IDE4LjQ0MTkgNjguODkyNyAxNy44NzY1IDY4LjUxNzIgMTcuNDA1NEM2OC4wOTQ3IDE2Ljg0IDY3LjU3ODMgMTYuMzY4OCA2Ni45NjggMTYuMDM5QzY2LjQwNDYgMTUuODAzNSA2NS43OTQ0IDE1LjcwOTIgNjUuMTg0MSAxNS42NjIxQzY0LjgwODUgMTUuNjYyMSA2NC40MzI5IDE1LjY2MjEgNjQuMTA0MyAxNS43NTYzQzYzLjkxNjUgMTUuODAzNSA2My42ODE4IDE1Ljg5NzcgNjMuNDk0IDE2LjAzOUM2My4zMDYyIDE2LjEzMzMgNjMuMTE4NSAxNi4yMjc1IDYyLjkzMDcgMTYuMjI3NUM2Mi44MzY4IDE2LjIyNzUgNjIuNjk1OSAxNi4xMzMzIDYyLjY0OSAxNi4wODYyQzYyLjYwMiAxNS45OTE5IDYyLjYwMjEgMTUuODUwNiA2Mi41MDgyIDE1Ljc1NjNDNjIuNDYxMiAxNS43MDkyIDYyLjM2NzMgMTUuNjYyMSA2Mi4yNzM0IDE1LjY2MjFDNjIuMTc5NSAxNS42NjIxIDYyLjA4NTcgMTUuNzU2MyA2MS45OTE4IDE1LjgwMzVDNjEuODA0IDE1Ljg5NzcgNjEuNjE2MiAxNS44OTc3IDYxLjQyODQgMTUuOTQ0OEM2MS4yNDA2IDE1Ljk0NDggNjEuMDk5OCAxNS45NDQ4IDYwLjkxMiAxNS45NDQ4QzYwLjIwNzggMTUuOTQ0OCA1OS41MDM3IDE1Ljk0NDggNTguODQ2NCAxNS45NDQ4QzU4LjcwNTYgMTUuOTQ0OCA1OC42MTE3IDE1Ljk0NDggNTguNDcwOSAxNS45NDQ4QzU4LjMzIDE1Ljk0NDggNTguMTg5MiAxNS45NDQ4IDU4LjE0MjIgMTUuOTkxOUM1OC4wOTUzIDE2LjAzOSA1OC4wNDgzIDE2LjA4NjEgNTguMDQ4MyAxNi4xODA0QzU4LjA0ODMgMTYuMjI3NSA1OC4wOTUzIDE2LjI3NDYgNTguMTQyMiAxNi4zNjg4QzU4LjIzNjEgMTYuNTU3MyA1OC4zNzcgMTYuNjk4NiA1OC41MTc4IDE2Ljg4NzFDNTguNjExNyAxNy4wMjg0IDU4LjcwNTYgMTcuMTIyNyA1OC43NTI1IDE3LjI2NEM1OC44NDY0IDE3LjQ1MjUgNTguNzk5NSAxNy42ODgxIDU4Ljc5OTUgMTcuOTIzNkM1OC43OTk1IDE4LjA2NSA1OC43OTk1IDE4LjIwNjMgNTguNzk5NSAxOC4zOTQ4QzU4Ljc5OTUgMTguOTEzMSA1OC43OTk1IDE5LjQzMTMgNTguNzk5NSAxOS45NDk2QzU4Ljc5OTUgMjAuNTYyMSA1OC43OTk1IDIxLjEyNzUgNTguNzk5NSAyMS43NEM1OC43OTk1IDIzLjY3MTcgNTguNzUyNSAyNS42NTA1IDU4Ljc5OTUgMjcuNTgyMkM1OC43OTk1IDI3LjkxMiA1OC43OTk1IDI4LjI0MTggNTguNzk5NSAyOC41NzE2QzU4Ljc5OTUgMjguNzYwMSA1OC43OTk1IDI4Ljk0ODUgNTguNzUyNSAyOS4wODk5QzU4LjcwNTYgMjkuMjc4MyA1OC42MTE3IDI5LjQ2NjggNTguNDcwOSAyOS42NTUzQzU4LjMzIDI5Ljg0MzcgNTguMjM2MSAyOS45ODUxIDU4LjA0ODMgMzAuMTczNUM1OS43ODUzIDMwLjE3MzUgNjEuNDc1NCAzMC4xNzM1IDYzLjIxMjMgMzAuMTczNUM2My4xMTg1IDMwLjA3OTMgNjMuMDI0NiAyOS45ODUxIDYyLjkzMDcgMjkuODkwOEM2Mi43NDI5IDI5LjcwMjQgNjIuNjAyMSAyOS40NjY4IDYyLjUwODIgMjkuMTg0MUM2Mi40NjEyIDI4Ljk5NTcgNjIuNDE0MyAyOC44MDcyIDYyLjQxNDMgMjguNjE4N0M2Mi40MTQzIDI4LjM4MzIgNjIuNDE0MyAyOC4xMDA1IDYyLjQxNDMgMjcuODY0OUM2Mi40MTQzIDI3LjQ4OCA2Mi40MTQzIDI3LjE1ODIgNjIuNDE0MyAyNi43ODEyQzYyLjQxNDMgMjQuNzU1MyA2Mi40MTQzIDIyLjc3NjUgNjIuNDE0MyAyMC43NTA1QzYyLjQxNDMgMjAuNTYyMSA2Mi40MTQzIDIwLjM3MzYgNjIuNDE0MyAyMC4xODUyQzYyLjQxNDMgMTkuOTQ5NiA2Mi40MTQzIDE5LjcxNCA2Mi40NjEyIDE5LjUyNTVDNjIuNTA4MiAxOS4yOSA2Mi41NTUxIDE5LjA1NDQgNjIuNjQ5IDE4Ljg2NTlDNjIuNzQyOSAxOC42MzA0IDYyLjkzMDcgMTguNDQxOSA2My4xNjU0IDE4LjM0NzdDNjMuMzUzMiAxOC4yNTM0IDYzLjU0MSAxOC4yMDYzIDYzLjcyODcgMTguMjA2M0M2My45MTY1IDE4LjIwNjMgNjQuMTUxMyAxOC4yMDYzIDY0LjMzOSAxOC4zMDA2QzY0LjYyMDcgMTguMzk0OCA2NC44MDg1IDE4LjU4MzIgNjQuOTk2MyAxOC44MTg4QzY1LjEzNzEgMTkuMDU0NCA2NS4yMzEgMTkuMzM3MSA2NS4zMjQ5IDE5LjYxOThDNjUuNDE4OCAxOS45OTY3IDY1LjUxMjcgMjAuMzczNiA2NS41NTk2IDIwLjc5NzdDNjUuNjA2NiAyMS4yNjg4IDY1LjYwNjYgMjEuNzM5OSA2NS41MTI3IDIyLjI1ODJDNjUuNDY1NyAyMi42ODIyIDY1LjM3MTggMjMuMDU5MiA2NS4xODQxIDIzLjM4OUM2NS4wOTAyIDIzLjU3NzQgNjQuOTAyNCAyMy43NjU5IDY0LjcxNDYgMjMuOTA3MkM2NC40Nzk5IDI0LjA0ODYgNjQuMTk4MiAyNC4xNDI4IDYzLjkxNjUgMjQuMTg5OUM2My41ODc5IDI0LjA5NTcgNjMuMjU5MyAyNC4wOTU3IDYyLjg4MzcgMjQuMDAxNVoiIGZpbGw9IiMyNjI2MjYiLz4KPHBhdGggZD0iTTgwLjQ5NzUgMjMuMDExMkM4MC40OTM2IDIzLjAzMzEgODAuNDkzNiAyMy4wNTEgODAuNDg5NiAyMy4wNjY5QzgwLjQ1NzggMjMuMTYyMyA4MC40MjYgMjMuMjU1NyA4MC4zOTQyIDIzLjM1MTFDODAuMzY0MyAyMy40Mzg2IDgwLjMzMDYgMjMuNTI2MSA4MC4zMDA3IDIzLjYxNTVDODAuMjcwOSAyMy43MDMgODAuMjQ1MSAyMy43OTI0IDgwLjIxNTMgMjMuODgxOUM4MC4xNzM1IDI0LjAwMzEgODAuMTI3OCAyNC4xMjQ0IDgwLjA4NDEgMjQuMjQ1N0M4MC4wNDIzIDI0LjM2MjkgODAuMDAwNiAyNC40NzgyIDc5Ljk1NjkgMjQuNTk1NUM3OS45MjExIDI0LjY5NDkgNzkuODgxMyAyNC43OTQzIDc5Ljg0NTUgMjQuODkzN0M3OS44MTU3IDI0Ljk3OTEgNzkuNzgzOSAyNS4wNjI2IDc5Ljc2MDEgMjUuMTUwMUM3OS43MDQ0IDI1LjM0MjkgNzkuNTg5MSAyNS40ODYgNzkuNDEwMiAyNS41Nzc1Qzc5LjI1NTIgMjUuNjU5IDc5LjA5NjEgMjUuNzMwNSA3OC45MzEyIDI1Ljc5MjFDNzguODQxNyAyNS44MjU5IDc4Ljc1MDMgMjUuODQ5OCA3OC42NTg4IDI1Ljg3OTZDNzguNTgxMyAyNS45MDM1IDc4LjUwNTggMjUuOTI5MyA3OC40MjgyIDI1Ljk1MTJDNzguMzY4NiAyNS45NjkxIDc4LjMwNyAyNS45ODMgNzguMjQ3NCAyNS45OTY5Qzc4LjE3OTggMjYuMDE0OCA3OC4xMTQyIDI2LjAzMjcgNzguMDQ2NiAyNi4wNDg2Qzc4LjAwNjggMjYuMDU4NSA3Ny45NjcxIDI2LjA2NjUgNzcuOTI1MyAyNi4wNzQ0Qzc3Ljg3MzcgMjYuMDg2MyA3Ny44MjIgMjYuMDk2MyA3Ny43NzAzIDI2LjEwODJDNzcuNzMyNSAyNi4xMTYyIDc3LjY5NjcgMjYuMTI0MSA3Ny42NTkgMjYuMTMwMUM3Ny42MDMzIDI2LjE0IDc3LjU0NzcgMjYuMTQ2IDc3LjQ5MiAyNi4xNTU5Qzc3LjQyNDQgMjYuMTY1OCA3Ny4zNTg4IDI2LjE3NzggNzcuMjkxMiAyNi4xODc3Qzc3LjI4NzMgMjYuMTg3NyA3Ny4yODEzIDI2LjE4OTcgNzcuMjc3MyAyNi4xODk3Qzc3LjE5NTggMjYuMTk3NyA3Ny4xMTIzIDI2LjIwNTYgNzcuMDMwOCAyNi4yMTU1Qzc2LjkzMTQgMjYuMjI1NSA3Ni44MzAxIDI2LjIzNTQgNzYuNzMwNyAyNi4yNDczQzc2LjcyMDcgMjYuMjQ5MyA3Ni43MTA4IDI2LjI0OTMgNzYuNzAwOSAyNi4yNTEzQzc2LjQwNDcgMjYuMjYxMyA3Ni4xMDg1IDI2LjI4MzEgNzUuODEyMyAyNi4yNzEyQzc1LjY4MTEgMjYuMjY1MiA3NS41NDk5IDI2LjI2MTMgNzUuNDIwNyAyNi4yNTEzQzc1LjMxNTQgMjYuMjQzNCA3NS4yMSAyNi4yMjk1IDc1LjEwNDcgMjYuMjE5NUM3NS4wMjMyIDI2LjIxMTYgNzQuOTM5NyAyNi4yMDU2IDc0Ljg1ODIgMjYuMTk1N0M3NC43ODg2IDI2LjE4NzcgNzQuNzE5IDI2LjE3MzggNzQuNjQ3NSAyNi4xNjE5Qzc0LjYwMzggMjYuMTUzOSA3NC41NiAyNi4xNDYgNzQuNTE2MyAyNi4xNEM3NC40NjQ2IDI2LjEzMjEgNzQuNDEwOSAyNi4xMjQxIDc0LjM1OTMgMjYuMTE0MkM3NC4zMTE1IDI2LjEwNjIgNzQuMjY1OCAyNi4wOTIzIDc0LjIyMDEgMjYuMDgyNEM3NC4xODQzIDI2LjA3NDQgNzQuMTQ4NiAyNi4wNjY1IDc0LjExNDggMjYuMDU4NUM3NC4wMTU0IDI2LjAzMjcgNzMuOTE0IDI2LjAwODggNzMuODE0NiAyNS45ODFDNzMuNzE5MiAyNS45NTUxIDczLjYyMTggMjUuOTI3MyA3My41MjY0IDI1Ljg5NTVDNzMuNDI1IDI1Ljg2MTcgNzMuMzIzNiAyNS44MjIgNzMuMjIyMiAyNS43ODIyQzczLjEwMyAyNS43MzQ1IDcyLjk4MzcgMjUuNjg4OCA3Mi44Njg0IDI1LjYzNTFDNzIuNTc2MiAyNS40OTk5IDcyLjI5MzkgMjUuMzQ0OSA3Mi4wMjc2IDI1LjE2QzcxLjY5MzYgMjQuOTI5NCA3MS4zODU1IDI0LjY2OSA3MS4xMjEyIDI0LjM2MDlDNzAuODkyNiAyNC4wOTQ2IDcwLjY5OTcgMjMuODAyNCA3MC41NDY3IDIzLjQ4NjNDNzAuNDc1MSAyMy4zMzcyIDcwLjQxMTUgMjMuMTg0MiA3MC4zNTU5IDIzLjAyOTFDNzAuMzIyMSAyMi45MzU3IDcwLjI5NjIgMjIuODM4MyA3MC4yNzA0IDIyLjc0MDlDNzAuMjQ0NSAyMi42NDk1IDcwLjIxODcgMjIuNTU4IDcwLjE5NjggMjIuNDY0NkM3MC4xNzg5IDIyLjM4MTEgNzAuMTY1IDIyLjI5NTYgNzAuMTUxMSAyMi4yMTIxQzcwLjE0MTIgMjIuMTUyNSA3MC4xMjkzIDIyLjA5MjkgNzAuMTE5MyAyMi4wMzEzQzcwLjExOTMgMjIuMDI3MyA3MC4xMTczIDIyLjAyNTMgNzAuMTE3MyAyMi4wMjEzQzcwLjEwOTQgMjEuOTU5NyA3MC4xMDE0IDIxLjg5NjEgNzAuMDk1NSAyMS44MzQ1QzcwLjA2OTYgMjEuNTg0IDcwLjA2NzYgMjEuMzMxNiA3MC4wNzM2IDIxLjA4MTFDNzAuMDc3NiAyMC45NDM5IDcwLjA4NTUgMjAuODA2OCA3MC4wOTc0IDIwLjY2OTZDNzAuMTA1NCAyMC41NjIzIDcwLjExOTMgMjAuNDU2OSA3MC4xMzcyIDIwLjM0OTZDNzAuMTUxMSAyMC4yNTQyIDcwLjE3MyAyMC4xNTg4IDcwLjE5MDkgMjAuMDYzNEM3MC4yMDQ4IDE5Ljk4NTggNzAuMjE4NyAxOS45MDgzIDcwLjIzNjYgMTkuODMwOEM3MC4yNTI1IDE5Ljc2MzIgNzAuMjcyNCAxOS42OTc2IDcwLjI5MDMgMTkuNjNDNzAuMzEyMSAxOS41NDg1IDcwLjMzMiAxOS40NjcgNzAuMzU1OSAxOS4zODc1QzcwLjM3NzcgMTkuMzE0IDcwLjQwMzYgMTkuMjQwNCA3MC40Mjc0IDE5LjE2ODlDNzAuNDUzMyAxOS4wOTEzIDcwLjQ4MTEgMTkuMDEzOCA3MC41MDg5IDE4LjkzODNDNzAuNTU2NiAxOC44MTcgNzAuNjAwNCAxOC42OTE4IDcwLjY1NiAxOC41NzQ1QzcwLjczNzUgMTguMzk5NiA3MC44MjEgMTguMjI0NyA3MC45MTY0IDE4LjA1NzdDNzEuMTQzIDE3LjY1NjIgNzEuNDE5MyAxNy4yODg0IDcxLjc1MzMgMTYuOTY4NEM3Mi4wOTEyIDE2LjY0MjQgNzIuNDY4OSAxNi4zNzIgNzIuODgyMyAxNi4xNTM0QzczLjA0MTQgMTYuMDY5OSA3My4yMDQ0IDE1Ljk5MjQgNzMuMzcxMyAxNS45MjQ4QzczLjQ5MDYgMTUuODc3MSA3My42MTE4IDE1LjgzNzMgNzMuNzMzMSAxNS43OTc2QzczLjgzNjUgMTUuNzYzOCA3My45Mzk4IDE1LjczMiA3NC4wNDMyIDE1LjcwNDFDNzQuMTE0OCAxNS42ODQzIDc0LjE4ODMgMTUuNjcyMyA3NC4yNTk5IDE1LjY1ODRDNzQuMzQ5MyAxNS42NDA1IDc0LjQ0MDggMTUuNjIwNyA3NC41MzAyIDE1LjYwNDhDNzQuNTkzOCAxNS41OTQ4IDc0LjY1NzQgMTUuNTg2OSA3NC43MjEgMTUuNTgwOUM3NC44NjAyIDE1LjU2OSA3NS4wMDEzIDE1LjU1OSA3NS4xNDI0IDE1LjU1MzFDNzUuMjUzOCAxNS41NDkxIDc1LjM2NTEgMTUuNTUxMSA3NS40NzQ0IDE1LjU1MzFDNzUuNTA4MiAxNS41NTMxIDc1LjU0NCAxNS41NTUxIDc1LjU3NzggMTUuNTU5Qzc1LjY5NSAxNS41NjcgNzUuODEyMyAxNS41NzEgNzUuOTI5NiAxNS41ODQ5Qzc2LjAzNSAxNS41OTY4IDc2LjEzODMgMTUuNjE4NyA3Ni4yNDE3IDE1LjYzNjZDNzYuMjg5NCAxNS42NDQ1IDc2LjMzOTEgMTUuNjUyNSA3Ni4zODY4IDE1LjY2MjRDNzYuNDI4NSAxNS42NzA0IDc2LjQ3MDMgMTUuNjgyMyA3Ni41MTIgMTUuNjkyMkM3Ni41NDc4IDE1LjcwMDIgNzYuNTgxNiAxNS43MTAxIDc2LjYxNzQgMTUuNzIwMUM3Ni43MDQ4IDE1Ljc0MzkgNzYuNzkwMyAxNS43Njc4IDc2Ljg3NzggMTUuNzk1NkM3Ni45NTkzIDE1LjgyMTQgNzcuMDM4OCAxNS44NTEyIDc3LjEyMDMgMTUuODc5MUM3Ny4yNTc0IDE1LjkyNDggNzcuMzg4NiAxNS45ODI0IDc3LjUxNzggMTYuMDQ0MUM3Ny43NDY0IDE2LjE1MzQgNzcuOTY3MSAxNi4yNzY2IDc4LjE3NzggMTYuNDE5N0M3OC41NDk1IDE2LjY3MDIgNzguODg1NCAxNi45NjI0IDc5LjE4MTYgMTcuMzAyM0M3OS40NTIgMTcuNjEyNCA3OS42Nzg2IDE3Ljk1MDMgNzkuODU3NSAxOC4zMjIxQzc5LjkzMSAxOC40NzUxIDc5Ljk5MjYgMTguNjMwMiA4MC4wNDgzIDE4Ljc4OTJDODAuMDg2MSAxOC44OTY1IDgwLjExNzkgMTkuMDA3OCA4MC4xNDc3IDE5LjExOTJDODAuMTczNSAxOS4yMTg1IDgwLjE5MzQgMTkuMzIxOSA4MC4yMTMzIDE5LjQyMzNDODAuMjMxMiAxOS41MTQ3IDgwLjI0OTEgMTkuNjA4MiA4MC4yNjY5IDE5LjY5OTZDODAuMjc2OSAxOS43NDkzIDgwLjI4MjggMTkuODAxIDgwLjI4ODggMTkuODUwN0M4MC4yOTg4IDE5Ljk0NjEgODAuMzAyNyAyMC4wNDE1IDgwLjMxNDcgMjAuMTM2OUM4MC4zMzI1IDIwLjI4NiA4MC4zMzQ1IDIwLjQzNTEgODAuMzM0NSAyMC41ODIyQzgwLjMzNDUgMjAuNzE1MyA4MC4zMzI1IDIwLjg1MDUgODAuMzMyNSAyMC45ODM3QzgwLjMzMjUgMjEuMDAzNiA4MC4zMjg2IDIxLjAyMzUgODAuMzI2NiAyMS4wNDUzQzgwLjMwMDcgMjEuMDQ3MyA4MC4yNzY5IDIxLjA0OTMgODAuMjU1IDIxLjA0OTNDNzkuMTUzOCAyMS4wNDkzIDc4LjA1MjYgMjEuMDQ5MyA3Ni45NTEzIDIxLjA1MTNDNzUuOTI5NiAyMS4wNTEzIDc0LjkwNzkgMjEuMDUzMyA3My44ODYyIDIxLjA1NTNDNzMuODA0NyAyMS4wNTUzIDczLjgwNDcgMjEuMDU3MiA3My44MDA3IDIxLjEzODdDNzMuNzkwNyAyMS4yODc4IDczLjgwODYgMjEuNDM2OSA3My44MjA2IDIxLjU4NEM3My44Mjg1IDIxLjY4MzQgNzMuODUyNCAyMS43ODI4IDczLjg3NDIgMjEuODgwMkM3My44OTQxIDIxLjk2OTYgNzMuOTEyIDIyLjA2MTEgNzMuOTM5OCAyMi4xNDY2Qzc0LjAwOTQgMjIuMzYxMiA3NC4xMDI4IDIyLjU2NCA3NC4yMjQxIDIyLjc1NDhDNzQuNDYwNiAyMy4xMjQ1IDc0Ljc2NjggMjMuNDIwNyA3NS4xMzQ1IDIzLjY1OTNDNzUuMjk3NSAyMy43NjQ2IDc1LjQ2ODQgMjMuODUyMSA3NS42NDczIDIzLjkyMzZDNzUuNzU2NyAyMy45Njc0IDc1Ljg2OCAyNC4wMDUxIDc1Ljk4NTMgMjQuMDMxQzc2LjA1NjggMjQuMDQ2OSA3Ni4xMjg0IDI0LjA2ODcgNzYuMTk5OSAyNC4wODI3Qzc2LjI1NzYgMjQuMDk0NiA3Ni4zMTcyIDI0LjEwMDUgNzYuMzc2OSAyNC4xMDg1Qzc2LjQ3NjIgMjQuMTIwNCA3Ni41NzM2IDI0LjEzMDQgNzYuNjczIDI0LjEzODNDNzYuODA0MiAyNC4xNDgyIDc2LjkzNzQgMjQuMTQ4MiA3Ny4wNzA2IDI0LjEzNjNDNzcuMTA2NCAyNC4xMzIzIDc3LjE0NDEgMjQuMTMwNCA3Ny4xNzk5IDI0LjEyODRDNzcuMjc1MyAyNC4xMjA0IDc3LjM3MDcgMjQuMTE2NCA3Ny40NjYyIDI0LjEwMjVDNzcuNTYzNiAyNC4wODg2IDc3LjY2MSAyNC4wNjg3IDc3Ljc1NjQgMjQuMDUwOEM3Ny44MzM5IDI0LjAzNjkgNzcuOTExNCAyNC4wMjMgNzcuOTg4OSAyNC4wMDUxQzc4LjA1NDUgMjMuOTkxMiA3OC4xMTgyIDIzLjk3MTMgNzguMTgzNyAyMy45NTM0Qzc4LjI0MTQgMjMuOTM3NSA3OC4zMDEgMjMuOTIzNiA3OC4zNTg3IDIzLjkwNzdDNzguNDEwNCAyMy44OTM4IDc4LjQ2MiAyMy44Nzc5IDc4LjUxMzcgMjMuODZDNzguNTgzMyAyMy44MzgyIDc4LjY1MDkgMjMuODE0MyA3OC43MTg1IDIzLjc5MDRDNzguNzkgMjMuNzY0NiA3OC44NTk2IDIzLjczODggNzguOTI5MiAyMy43MTI5Qzc5LjAwMjcgMjMuNjg1MSA3OS4wNzYzIDIzLjY1OTMgNzkuMTQ5OCAyMy42MzE0Qzc5LjI1NTIgMjMuNTg5NyA3OS4zNjA1IDIzLjU0NzkgNzkuNDYzOSAyMy41MDQyQzc5LjU3NzIgMjMuNDU2NSA3OS42ODg1IDIzLjQwNjggNzkuNzk3OCAyMy4zNTMxQzc5Ljk3MDggMjMuMjcxNiA4MC4xNDE3IDIzLjE4NjIgODAuMzE0NyAyMy4xMDI3QzgwLjM2ODMgMjMuMDc2OCA4MC40MTggMjMuMDQ3IDgwLjQ3MTcgMjMuMDIxMkM4MC40NzM3IDIzLjAxMzIgODAuNDgxNiAyMy4wMTUyIDgwLjQ5NzUgMjMuMDExMlpNNzMuNzc0OCAxOS4yMzA1Qzc0Ljc1ODggMTkuMjMwNSA3NS43MzQ4IDE5LjIzMDUgNzYuNzE0OCAxOS4yMzA1Qzc2LjcxNjggMTkuMjEwNiA3Ni43MTg4IDE5LjE5NDcgNzYuNzIyNyAxOS4xNzg4Qzc2LjczMjcgMTkuMDk5MyA3Ni43MjI3IDE5LjAxOTggNzYuNzIwNyAxOC45NDAzQzc2LjcxNjggMTguODQ0OCA3Ni42OTY5IDE4Ljc1MzQgNzYuNjc1IDE4LjY2MkM3Ni42NDcyIDE4LjU1NjYgNzYuNjA5NCAxOC40NTUyIDc2LjU1OTcgMTguMzU5OEM3Ni40NzYyIDE4LjE5MjkgNzYuMzY2OSAxOC4wNDc3IDc2LjIxOTggMTcuOTMwNUM3Ni4xNTQyIDE3Ljg3ODggNzYuMDg0NyAxNy44MzUxIDc2LjAwOTEgMTcuNzk3M0M3NS45MzU2IDE3Ljc2MTUgNzUuODYyIDE3LjcyNzcgNzUuNzg2NSAxNy42OTk5Qzc1LjcxMjkgMTcuNjc0IDc1LjYzNTQgMTcuNjU0MiA3NS41NTc5IDE3LjYzODNDNzUuNDcyNCAxNy42MjA0IDc1LjM4NSAxNy42MTI0IDc1LjI5NzUgMTcuNjA4NEM3NS4yNDk4IDE3LjYwNjUgNzUuMjAyMSAxNy42MTg0IDc1LjE1NDQgMTcuNjIwNEM3NS4wNzA5IDE3LjYyNDMgNzQuOTkxNCAxNy42NDQyIDc0LjkxMTkgMTcuNjY4MUM3NC43NzI3IDE3LjcwOTggNzQuNjM3NSAxNy43Njc1IDc0LjUxNDMgMTcuODQ1Qzc0LjI4OTcgMTcuOTgyMSA3NC4xMTQ4IDE4LjE2NSA3My45OTM1IDE4LjM5NzZDNzMuOTQ1OCAxOC40OTEgNzMuOTAwMSAxOC41ODQ0IDczLjg3MjIgMTguNjg1OEM3My44NTQ0IDE4Ljc0OTQgNzMuODMyNSAxOC44MTExIDczLjgxODYgMTguODc0N0M3My44MDI3IDE4Ljk0NjIgNzMuNzkyNyAxOS4wMTk4IDczLjc4MjggMTkuMDkzM0M3My43NzY4IDE5LjEzOSA3My43NzY4IDE5LjE4MjggNzMuNzc0OCAxOS4yMzA1WiIgZmlsbD0iIzI2MjYyNiIvPgo8cGF0aCBkPSJNODAuNTA2OCAyNS43NjY0QzgwLjYwNTggMjUuNjc5NSA4MC42OTkgMjUuNTg2OCA4MC43ODY0IDI1LjQ4ODNDODAuOTI2MSAyNS4zMjYxIDgxLjA0ODQgMjUuMTUyMyA4MS4xMjk5IDI0Ljk2MTFDODEuMjU4MSAyNC42NDgzIDgxLjI1ODEgMjQuMzAwNyA4MS4yNjM5IDIzLjk1MzFDODEuMjY5NyAyMy4xODI1IDgxLjI2MzkgMjIuNDQ2OCA4MS4yNjM5IDIxLjY5OTVDODEuMjYzOSAyMC42MjE5IDgxLjI2OTcgMTkuNTI3IDgxLjI2MzkgMTguNDM3OEM4MS4yNjM5IDE4LjI1ODIgODEuMjYzOSAxOC4wNzg2IDgxLjI2MzkgMTcuOTA0OEM4MS4yNjM5IDE3Ljc4MzIgODEuMjY5NyAxNy42NjE1IDgxLjI2MzkgMTcuNTM5OUM4MS4yNjM5IDE3LjQ2NDYgODEuMjU4MSAxNy4zODkyIDgxLjIzNDggMTcuMzEzOUM4MS4xODgyIDE3LjE0MDEgODEuMDQ4NCAxNy4wMDExIDgwLjkyNjEgMTYuODU2M0M4MC44MDk3IDE2LjcyMyA4MC43MDQ4IDE2LjU4NCA4MC42NDA4IDE2LjQyMThDODAuNTg4NCAxNi4yODg1IDgwLjU3NjcgMTYuMTM3OSA4MC41ODI1IDE1LjkzNTFDODEuMjM0OCAxNS45MzUxIDgxLjg4MTIgMTUuOTM1MSA4Mi41MzM0IDE1LjkzNTFDODIuODAxMiAxNS45MzUxIDgzLjA2OTEgMTUuOTM1MSA4My4zMTM3IDE1LjkzNTFDODMuNTE3NSAxNS45MzUxIDgzLjcwOTcgMTUuOTM1MSA4My45MzY4IDE1Ljg5NDZDODQuMTExNSAxNS44NjU2IDg0LjMxNTMgMTUuODEzNSA4NC40OTU4IDE1Ljc3ODdDODQuNjEyMyAxNS43NTU1IDg0LjcyMyAxNS43MzgyIDg0LjgzOTQgMTUuNzQzOUM4NC45MDkzIDE1Ljc0OTcgODQuOTc5MiAxNS43NjEzIDg1LjAzMTYgMTUuODAxOUM4NS4wNzgyIDE1Ljg0MjQgODUuMTAxNSAxNS45MDYyIDg1LjExODkgMTUuOTY0MUM4NS4xMzA2IDE2LjAxNjIgODUuMTMwNiAxNi4wNjg0IDg1LjEzMDYgMTYuMTI2M0M4NS4xMzY0IDE2LjI4ODUgODUuMTQyMiAxNi40NTA3IDg1LjEzMDYgMTYuNjEyOUM4NS4yMzU0IDE2LjUwMjkgODUuMzQ2MSAxNi4zOTg2IDg1LjQ2MjUgMTYuMjk0M0M4NS42MTM5IDE2LjE2MTEgODUuNzc3IDE2LjAzOTQgODUuOTUxNyAxNS45NDY3Qzg2LjEzMjIgMTUuODU0IDg2LjMzMDIgMTUuNzkwMyA4Ni41MjI0IDE1Ljc0MzlDODYuNzg0NCAxNS42ODYgODcuMDQwNyAxNS42NTcgODcuMzI2IDE1LjY2MjhDODcuNTI0IDE1LjY2MjggODcuNzM5NSAxNS42ODAyIDg3Ljg3MzQgMTUuODA3N0M4Ny45NDkxIDE1Ljg4MyA4Ny45OTU3IDE1Ljk4NzMgODguMDEzMiAxNi4wOTczQzg4LjAzNjUgMTYuMTk1OCA4OC4wMzA2IDE2LjMwMDEgODguMDMwNiAxNi4zOTg2Qzg4LjAzMDYgMTYuNjY1MSA4OC4wMzA2IDE2LjkzMTYgODguMDMwNiAxNy4yMDM5Qzg4LjAzMDYgMTcuNjI2OCA4OC4wMjQ4IDE4LjA0MzkgODguMDI0OCAxOC40MjYyQzg3LjQ4MzIgMTguNDIwNSA4Ny4wNzU2IDE4LjM5NzMgODYuNzAyOSAxOC40MTQ3Qzg2LjQ5MzMgMTguNDI2MiA4Ni4zMDExIDE4LjQ0OTQgODYuMDk3MyAxOC41MTg5Qzg1LjkxMDkgMTguNTgyNyA4NS43MTI5IDE4LjY4MTEgODUuNTQ5OSAxOC44MjAyQzg1LjM3NTIgMTguOTY1IDg1LjIzNTQgMTkuMTU2MiA4NS4xNDgxIDE5LjM2NDhDODUuMDQzMiAxOS42MjU1IDg1LjAzMTYgMTkuOTIwOSA4NS4wMzE2IDIwLjIwNDhDODUuMDMxNiAyMC40MTMzIDg1LjAzMTYgMjAuNjE2MSA4NS4wMzE2IDIwLjgxODlDODUuMDM3NCAyMS41MzE1IDg1LjA0OTEgMjIuMjQ0IDg1LjAzMTYgMjIuOTE2MUM4NS4wMTk5IDIzLjM4NTMgODQuOTk2NyAyMy44MzcyIDg1LjA1NDkgMjQuMzkzM0M4NS4wNzI0IDI0LjU0OTggODUuMDg5OCAyNC43MTIgODUuMTM2NCAyNC44NTY4Qzg1LjIwMDUgMjUuMDc3IDg1LjMxMTEgMjUuMjUwOCA4NS40Mjc2IDI1LjQxODhDODUuNTA5MSAyNS41MzQ2IDg1LjU5NjUgMjUuNjQ0NyA4NS42ODk2IDI1Ljc0OUM4My45NjAxIDI1Ljc2NjQgODIuMjM2NCAyNS43NjY0IDgwLjUwNjggMjUuNzY2NFoiIGZpbGw9IiMyNjI2MjYiLz4KPHBhdGggZD0iTTk4LjIwNzMgMjUuNzU4MkM5NC43ODA5IDI1Ljc1ODIgOTEuMzU0NiAyNS43NTgyIDg3LjkxNSAyNS43NTgyQzg3Ljk0MTQgMjUuNzI1MiA4Ny45NjEzIDI1LjY5MjEgODcuOTgxMSAyNS42Nzg5Qzg4LjMxMTkgMjUuNDA3NyA4OC41ODk3IDI1LjA5MDIgODguODM0NCAyNC43Mzk2Qzg4Ljk5MzIgMjQuNTE0NyA4OS4xMTg4IDI0LjI4MzIgODkuMjExNCAyNC4wMzE4Qzg5LjI3NzYgMjMuODQ2NiA4OS4zMTczIDIzLjY1NDggODkuMzYzNiAyMy40NjNDODkuNDI5NyAyMy4yMDUgODkuNDI5NyAyMi45NDA0IDg5LjQ1NjIgMjIuNjc1OUM4OS41MDkxIDIyLjE4NjQgODkuNDg5MyAyMS43MDM1IDg5LjQ4OTMgMjEuMjE0Qzg5LjQ4OTMgMjAuMDk2MiA4OS40ODkzIDE4Ljk3ODMgODkuNDc2IDE3Ljg2MDRDODkuNDY5NCAxNi45MDEzIDg5LjQ0OTYgMTUuOTQ4OCA4OS40Mjk3IDE0Ljk4OTdDODkuNDE2NSAxNC4zMzQ5IDg5LjQxNjUgMTMuNjggODkuMzkgMTMuMDE4NkM4OS4zNTcgMTIuMDI2NCA4OS4zNzAyIDExLjAyNzYgODkuMzM3MSAxMC4wMzU0Qzg5LjI4NDIgOC4zMzU0NiA4OS4zMTczIDYuNjI4OSA4OS4zMDQgNC45Mjg5NUM4OS4zMDQgNC42NjQzNyA4OS4zMTczIDQuNDA2NCA4OS4yNzEgNC4xNDE4MkM4OS4yNTc3IDQuMDgyMjkgODkuMjY0NCA0LjAxNjE0IDg5LjI2NDQgMy45NDk5OUM4OS4yNjQ0IDMuNzQ0OTQgODkuMjMxMyAzLjUzOTg5IDg5LjE4NSAzLjM0MTQ1Qzg5LjE1MTkgMy4yMDI1NSA4OS4xMjU1IDMuMDU3MDMgODkuMDg1OCAyLjkxODEyQzg4Ljk2MDEgMi40NzQ5NCA4OC43NjgzIDIuMDc4MDcgODguNDE3NyAxLjc2NzE4Qzg4LjI4NTQgMS42NDgxMiA4OC4xNTk3IDEuNTI5MDYgODguMDIwOCAxLjQxNjYxQzg3Ljk0MTQgMS4zNTA0NiA4Ny44ODE5IDEuMjcxMDkgODcuODQyMiAxLjE3ODQ5Qzg3Ljc3NjEgMS4wMTMxMiA4Ny44MTU4IDAuOTAwNjc0IDg4LjAyNzQgMC44Njc2MDFDODguMDg3IDAuODU0MzcyIDg4LjE0NjUgMC44NjA5ODYgODguMjA2IDAuODYwOTg2Qzg5LjI4NDIgMC44NjA5ODYgOTAuMzYyNCAwLjg2NzYwMiA5MS40MzM5IDAuODQ3NzU4QzkxLjkzIDAuODQxMTQzIDkyLjQzMjcgMC44MjEyOTkgOTIuOTI4OCAwLjgzNDUyOEM5NS40MjkxIDAuODk0MDU5IDk3LjkyOTUgMC44NDExNDMgMTAwLjQzNiAwLjg2NzYwMUMxMDAuNTYyIDAuODY3NjAxIDEwMC42ODEgMC44ODc0NDUgMTAwLjgwNyAwLjkwMDY3NEMxMDAuODQgMC45MDA2NzQgMTAwLjg2NiAwLjkwNzI4OSAxMDAuODk5IDAuOTA3Mjg5QzEwMS4xMzEgMC45MjcxMzMgMTAxLjM2MiAwLjk0MDM2MSAxMDEuNTk0IDAuOTY2ODJDMTAxLjcyNiAwLjk4MDA0OSAxMDEuODU5IDEuMDE5NzQgMTAxLjk4NCAxLjAzOTU4QzEwMi4wOTcgMS4wNTk0MiAxMDIuMjAyIDEuMDcyNjUgMTAyLjMxNSAxLjA5MjVDMTAyLjQxNCAxLjExMjM0IDEwMi41MDcgMS4xMzg4IDEwMi42MDYgMS4xNjUyNkMxMDIuNjcyIDEuMTg1MSAxMDIuNzMyIDEuMjA0OTQgMTAyLjc5OCAxLjIxODE3QzEwMy4xMDkgMS4yOTA5MyAxMDMuNDA2IDEuNDEgMTAzLjY5NyAxLjUzNTY3QzEwNC4yODYgMS43ODcwMyAxMDQuODE1IDIuMTMwOTkgMTA1LjI5OCAyLjU1NDMyQzEwNS43NzQgMi45NzEwNCAxMDYuMTg0IDMuNDQ3MjkgMTA2LjUyOCAzLjk3NjQ1QzEwNi43MzMgNC4yOTM5NSAxMDYuOTE5IDQuNjI0NjggMTA3LjA1OCA0Ljk3NTI1QzEwNy4xMyA1LjE2MDQ2IDEwNy4yMDMgNS4zNDU2NyAxMDcuMjY5IDUuNTM3NDlDMTA3LjMxNiA1LjY3NjQgMTA3LjM0MiA1LjgyMTkyIDEwNy4zNzUgNS45Njc0NEMxMDcuNDIxIDYuMTc5MTEgMTA3LjQ1NCA2LjM5MDc3IDEwNy40OTQgNi42MDI0NEMxMDcuNDk0IDYuNjE1NjcgMTA3LjUwMSA2LjYyMjI4IDEwNy41MDEgNi42MzU1MUMxMDcuNTE0IDYuOTU5NjMgMTA3LjUzNCA3LjI4Mzc0IDEwNy41NCA3LjYxNDQ3QzEwNy41NCA3LjgxOTUyIDEwNy41MjcgOC4wMTc5NiAxMDcuNTAxIDguMjIzMDFDMTA3LjQ3NCA4LjQ0MTI5IDEwNy40MjEgOC42NTk1NyAxMDcuMzgyIDguODg0NDdDMTA3LjMzNSA5LjE2ODg5IDEwNy4yNDMgOS40NDAwOSAxMDcuMTQ0IDkuNzA0NjdDMTA2LjkzMiAxMC4yNTM3IDEwNi42NDEgMTAuNzYzIDEwNi4yNjQgMTEuMjE5NEMxMDUuOTk5IDExLjU0MzUgMTA1LjY4OCAxMS44MjEzIDEwNS4zNzEgMTIuMDkyNUMxMDQuODY4IDEyLjUyMjUgMTA0LjMzMiAxMi45MDYxIDEwMy43NTcgMTMuMjQzNUMxMDMuNTUyIDEzLjM2MjUgMTAzLjMzNCAxMy40NjE4IDEwMy4xMjIgMTMuNTY3NkMxMDMuMDQ5IDEzLjYwMDcgMTAzLjA0MyAxMy42MTM5IDEwMy4wODIgMTMuNjhDMTAzLjMwNyAxNC4wMzA2IDEwMy41MzIgMTQuMzg3OCAxMDMuNzU3IDE0LjczODRDMTAzLjkyMiAxNS4wMDMgMTA0LjA5NCAxNS4yNjc1IDEwNC4yNTMgMTUuNTMyMUMxMDQuNTQ0IDE2LjAwODQgMTA0LjgzNSAxNi40NzggMTA1LjExOSAxNi45NTQzQzEwNS4zODQgMTcuMzkwOCAxMDUuNjU1IDE3LjgzNCAxMDUuOTIgMTguMjc3MkMxMDYuMjExIDE4Ljc2IDEwNi41MDIgMTkuMjQ5NSAxMDYuNzkzIDE5LjczOUMxMDcuMTgzIDIwLjM4NzIgMTA3LjU2NyAyMS4wMzU0IDEwNy45NTcgMjEuNjgzN0MxMDguMjIyIDIyLjEyNjggMTA4LjQ5MyAyMi41NjM0IDEwOC43NzEgMjNDMTA5LjA2MiAyMy40NDMxIDEwOS4zOTkgMjMuODUzMyAxMDkuNzUgMjQuMjUwMUMxMTAuMTczIDI0LjcxOTggMTEwLjYyMyAyNS4xNTYzIDExMS4xMTIgMjUuNTU5OEMxMTEuMTE5IDI1LjU2NjQgMTExLjExOSAyNS41NzMgMTExLjEzOSAyNS41ODYzQzExMS4wNzMgMjUuNjA2MSAxMTEuMDA2IDI1LjYzMjYgMTEwLjk0NyAyNS42MzI2QzExMC42ODkgMjUuNjUyNCAxMTAuNDMxIDI1LjY1OSAxMTAuMTggMjUuNjkyMUMxMDkuOTc1IDI1LjcxODYgMTA5Ljc3IDI1LjcwNTMgMTA5LjU2NCAyNS43Mzg0QzEwOS4zOTMgMjUuNzY0OSAxMDkuMjIxIDI1Ljc1MTYgMTA5LjA0OSAyNS43NzgxQzEwOC43OTEgMjUuODE3OCAxMDguNTMzIDI1Ljc5MTMgMTA4LjI3NSAyNS44MzFDMTA3LjkzNyAyNS44NzczIDEwNy42IDI1Ljg1MDkgMTA3LjI2MyAyNS44NzA3QzEwNi4yNjQgMjUuOTQzNSAxMDUuMjcyIDI1Ljg5MDUgMTA0LjI3MyAyNS45MDM4QzEwNC4wNzQgMjUuOTAzOCAxMDMuODY5IDI1Ljg5MDUgMTAzLjY3MSAyNS44NTA5QzEwMy4wNDkgMjUuNzM4NCAxMDIuNTEzIDI1LjQ1NCAxMDIuMDM3IDI1LjAzNzNDMTAxLjcgMjQuNzM5NiAxMDEuNDIyIDI0LjM5NTYgMTAxLjE5NyAyNC4wMTJDMTAwLjk5MiAyMy42NzQ3IDEwMC44IDIzLjMyNDEgMTAwLjYwOCAyMi45ODAxQzEwMC40NDMgMjIuNjg5MSAxMDAuMjc4IDIyLjM5OCAxMDAuMTE5IDIyLjEwN0M5OS44NjA5IDIxLjYzNzQgOTkuNjAyOSAyMS4xNjExIDk5LjM1MTYgMjAuNjkxNUM5OS4wNDczIDIwLjEyMjYgOTguNzQ5NyAxOS41NTM4IDk4LjQ1MiAxOC45ODQ5Qzk4LjEzNDUgMTguMzgzIDk3LjgxNyAxNy43ODc3IDk3LjQ3MyAxNy4yMDU2Qzk3LjE2MjIgMTYuNjc2NCA5Ni44NjQ1IDE2LjEzNCA5Ni41NjAyIDE1LjU5ODNDOTYuNTQ3IDE1LjU3ODQgOTYuNTMzOCAxNS41NjUyIDk2LjQ5NDEgMTUuNTU4NkM5Ni40OTQxIDE1LjU5MTYgOTYuNDk0MSAxNS42MjQ3IDk2LjQ5NDEgMTUuNjU3OEM5Ni40OTQxIDE3LjY4ODUgOTYuNDk0MSAxOS43MjU4IDk2LjQ5NDEgMjEuNzU2NEM5Ni40OTQxIDIyLjEzMzUgOTYuNTAwNyAyMi41MDM5IDk2LjUyMDUgMjIuODgwOUM5Ni41MjcyIDIzLjA0NjMgOTYuNTY2OSAyMy4yMDUgOTYuNTkzMyAyMy4zNzA0Qzk2LjYxMzIgMjMuNDgyOCA5Ni42MjY0IDIzLjU4ODcgOTYuNjU5NSAyMy43MDExQzk2LjY5OTEgMjMuODQgOTYuNzQ1NCAyMy45ODU1IDk2LjgwNSAyNC4xMTc4Qzk2LjkxNzQgMjQuMzgyNCA5Ny4wNTYzIDI0LjYzMzggOTcuMjI4MyAyNC44NjUzQzk3LjQ3OTcgMjUuMTg5NCA5Ny43NjQxIDI1LjQ2NzIgOTguMTE0NyAyNS42ODU1Qzk4LjE0NzcgMjUuNzA1MyA5OC4xODA4IDI1LjczMTggOTguMjEzOSAyNS43NTE2Qzk4LjIxMzkgMjUuNzQ1IDk4LjIxMzkgMjUuNzUxNiA5OC4yMDczIDI1Ljc1ODJaTTk2LjQ0MTIgNC42MTE0NUM5Ni40MTQ3IDQuNzcwMiA5Ni40MTQ3IDEzLjAzMTggOTYuNDQxMiAxMy4xMTEyQzk2LjQ1NDQgMTMuMTExMiA5Ni40Njc2IDEzLjExNzggOTYuNDgwOSAxMy4xMTc4Qzk2LjU2MDIgMTMuMTA0NiA5Ni42Mzk2IDEzLjA5MTMgOTYuNzE5IDEzLjA3MTVDOTYuODExNiAxMy4wNTE3IDk2LjkxMDggMTMuMDQ1IDk3LjAwMzQgMTMuMDE4NkM5Ny4xNjg4IDEyLjk2NTcgOTcuMzI3NSAxMi45MDYxIDk3LjQ5MjkgMTIuODUzMkM5Ny43NDQyIDEyLjc2NzIgOTcuOTgyNCAxMi42NDgyIDk4LjIxMzkgMTIuNTA5M0M5OC42NDM4IDEyLjI1MTMgOTkuMDIwOSAxMS45MjcyIDk5LjM1MTYgMTEuNTU2OEM5OS43MDIyIDExLjE1OTkgOTkuOTg2NiAxMC43Mjk5IDEwMC4xOTggMTAuMjQ3MUMxMDAuMjc4IDEwLjA2ODUgMTAwLjMzNyA5Ljg4MzI3IDEwMC4zOTcgOS42OTE0NUMxMDAuNDM2IDkuNTY1NzcgMTAwLjQ2MyA5LjQzMzQ4IDEwMC40OTYgOS4zMDExOUMxMDAuNTM2IDkuMTIyNTkgMTAwLjU3NSA4Ljk0NCAxMDAuNTc1IDguNzU4NzlDMTAwLjU3NSA4LjY5MjY0IDEwMC41ODIgOC42MjY1IDEwMC41ODIgOC41NTM3NEMxMDAuNTg5IDguMTYzNDggMTAwLjU4OSA3Ljc3MzIyIDEwMC40ODkgNy4zOTYxOUMxMDAuNDM2IDcuMjEwOTggMTAwLjQwMyA3LjAxOTE2IDEwMC4zMzcgNi44NDA1NkMxMDAuMjExIDYuNDg5OTkgMTAwLjAzMyA2LjE2NTg4IDk5Ljc5NDggNS44NjgyMkM5OS41NTY2IDUuNTc3MTggOTkuMjg1NCA1LjMyNTgzIDk4Ljk1NDcgNS4xMjczOUM5OC43Njk1IDUuMDE0OTQgOTguNTcxMSA0LjkyODk1IDk4LjM3MjYgNC44NDI5NkM5OC4yNzM0IDQuNzk2NjYgOTguMTYxIDQuNzcwMiA5OC4wNTUxIDQuNzQzNzRDOTcuOTY5MSA0LjcyMzkgOTcuODgzMiA0LjcwNDA1IDk3Ljc5NzIgNC42OTA4M0M5Ny42NzE1IDQuNjY0MzcgOTcuNTUyNCA0LjYxODA3IDk3LjQyNjcgNC42MTgwN0M5Ny4xMDkyIDQuNTk4MjIgOTYuNzc4NSA0LjYxMTQ1IDk2LjQ0MTIgNC42MTE0NVoiIGZpbGw9IiMyNjI2MjYiLz4KPHBhdGggZD0iTTExNC43ODcgMTUuNzcxOEMxMTUuMDU5IDE1Ljc2MzkgMTE1LjMyOCAxNS43NzcgMTE1LjU5NSAxNS44MDU4QzExNS43OTkgMTUuODI5MyAxMTYuMDAzIDE1Ljg2MzMgMTE2LjIwNyAxNS45QzExNi4zNDMgMTUuOTIzNSAxMTYuNDgyIDE1Ljk1MjMgMTE2LjYxNiAxNS45ODg5QzExNi44NTYgMTYuMDU0MyAxMTcuMDkyIDE2LjEzOCAxMTcuMzE5IDE2LjI0QzExNy43ODcgMTYuNDQ2NyAxMTguMjE3IDE2LjcxNjEgMTE4LjU5OCAxNy4wNTFDMTE4Ljk5MyAxNy4zOTYzIDExOS4zMiAxNy43OTkyIDExOS41ODUgMTguMjU0NEMxMTkuNzEzIDE4LjQ3MTUgMTE5LjgyMyAxOC42OTkxIDExOS45MTcgMTguOTMxOUMxMTkuOTcyIDE5LjA2NTMgMTIwLjAxNCAxOS4yMDQgMTIwLjA1NiAxOS4zNDI2QzEyMC4wOTIgMTkuNDU1MSAxMjAuMTI0IDE5LjU3MDIgMTIwLjE1MiAxOS42ODUzQzEyMC4xNjggMTkuNzQ1NSAxMjAuMTc2IDE5LjgwODMgMTIwLjE4NiAxOS44NzFDMTIwLjIwMiAxOS45NDY5IDEyMC4yMTUgMjAuMDIyOCAxMjAuMjMxIDIwLjEwMTJDMTIwLjIzMyAyMC4xMDkxIDEyMC4yMzMgMjAuMTE5NiAxMjAuMjM2IDIwLjEyNzRDMTIwLjI0NCAyMC4xOTU0IDEyMC4yNTcgMjAuMjY2MSAxMjAuMjYgMjAuMzM0MUMxMjAuMjY1IDIwLjU2OTUgMTIwLjMwMSAyMC44MDIzIDEyMC4yNzMgMjEuMDM3OEMxMjAuMjY3IDIxLjA3OTYgMTIwLjI3IDIxLjEyMTUgMTIwLjI2NyAyMS4xNjA3QzEyMC4yNTcgMjEuMjkxNSAxMjAuMjUyIDIxLjQyMjMgMTIwLjIzMyAyMS41NTA1QzEyMC4yMTggMjEuNjc2MSAxMjAuMTg5IDIxLjc5NjQgMTIwLjE2NSAyMS45MjJDMTIwLjE0NyAyMi4wMTYyIDEyMC4xMjkgMjIuMTEyOSAxMjAuMTA1IDIyLjIwNzFDMTIwLjA3NiAyMi4zMTQ0IDEyMC4wNDUgMjIuNDE5IDEyMC4wMDggMjIuNTIzN0MxMTkuOTY3IDIyLjY0OTIgMTE5LjkyMiAyMi43NzIyIDExOS44NzUgMjIuODk1MUMxMTkuNzcgMjMuMTY0NiAxMTkuNjQyIDIzLjQyMDkgMTE5LjQ5IDIzLjY2OTVDMTE5LjAwNyAyNC40NTQzIDExOC4zMzkgMjUuMDM1IDExNy41MSAyNS40M0MxMTcuMjIyIDI1LjU2ODcgMTE2LjkyNCAyNS42ODEyIDExNi42MTggMjUuNzY3NUMxMTYuNDE0IDI1LjgyMjQgMTE2LjIwNyAyNS44Nzc0IDExNS45OTggMjUuOTIxOEMxMTUuODI4IDI1Ljk1ODUgMTE1LjY1OCAyNS45OTI1IDExNS40ODUgMjYuMDE2QzExNS4xMzcgMjYuMDYwNSAxMTQuNzg3IDI2LjA5NDUgMTE0LjQzNiAyNi4wNjgzQzExNC4xOSAyNi4wNSAxMTMuOTQ3IDI2LjAyMzkgMTEzLjcwNCAyNS45ODk5QzExMy40NzYgMjUuOTU1OCAxMTMuMjQ5IDI1LjkxNjYgMTEzLjAyNCAyNS44NjE3QzExMi40ODcgMjUuNzMzNSAxMTEuOTcyIDI1LjU1MDQgMTExLjUwNCAyNS4yNDk1QzExMS4wNDEgMjQuOTQ4NyAxMTAuNjQzIDI0LjU4MjQgMTEwLjMwNiAyNC4xNDU2QzExMC4wODkgMjMuODYwNCAxMDkuOTA1IDIzLjU1NDQgMTA5Ljc1MSAyMy4yM0MxMDkuNjY3IDIzLjA1MjEgMTA5LjU5NCAyMi44NzE2IDEwOS41MjkgMjIuNjg1OUMxMDkuNDkyIDIyLjU4OTEgMTA5LjQ2OSAyMi40ODcgMTA5LjQ0IDIyLjM4NzZDMTA5LjQwNiAyMi4yNjk5IDEwOS4zNzQgMjIuMTQ5NiAxMDkuMzQ2IDIyLjAzMTlDMTA5LjMzIDIxLjk3MTcgMTA5LjMyMiAyMS45MDg5IDEwOS4zMTIgMjEuODQ2MUMxMDkuMjk5IDIxLjc3MDMgMTA5LjI4MyAyMS42OTE4IDEwOS4yNyAyMS42MTU5QzEwOS4yNyAyMS42MTA3IDEwOS4yNjcgMjEuNjAyOCAxMDkuMjY1IDIxLjU5NzZDMTA5LjI1NCAyMS40OTMgMTA5LjI0MSAyMS4zODU3IDEwOS4yMzMgMjEuMjgxMUMxMDkuMjIzIDIxLjEwMzIgMTA5LjIxIDIwLjkyNTMgMTA5LjIxMiAyMC43NDc0QzEwOS4yMTIgMjAuNTk1NyAxMDkuMjI1IDIwLjQ0MzkgMTA5LjI0MSAyMC4yOTIyQzEwOS4yNTEgMjAuMTc3MSAxMDkuMjcgMjAuMDY0NiAxMDkuMjkzIDE5Ljk1MjFDMTA5LjMyIDE5LjgyNCAxMDkuMzU0IDE5LjY5NTggMTA5LjM4OCAxOS41Njc2QzEwOS40MTkgMTkuNDUyNSAxMDkuNDU4IDE5LjM0MjYgMTA5LjQ5NSAxOS4yMzAxQzEwOS41NTIgMTkuMDU0OCAxMDkuNjI4IDE4Ljg4NDggMTA5LjcxNSAxOC43MkMxMTAuMDI4IDE4LjExMDUgMTEwLjQ0NCAxNy41Nzk0IDExMC45NTcgMTcuMTI0MkMxMTEuMzg5IDE2LjczOTcgMTExLjg2NyAxNi40MzM2IDExMi4zOTkgMTYuMjA2QzExMi42NDIgMTYuMTAxNCAxMTIuODkzIDE2LjAxNzcgMTEzLjE1MiAxNS45NTc1QzExMy4zODUgMTUuOTA1MiAxMTMuNjIgMTUuODYwNyAxMTMuODU4IDE1LjgyOTNDMTE0LjE2NCAxNS43Nzk2IDExNC40NzYgMTUuNzY5MiAxMTQuNzg3IDE1Ljc3MThaTTExNi42NjUgMjEuMjUyM0MxMTYuNjYzIDIxLjI1MjMgMTE2LjY2IDIxLjI1MjMgMTE2LjY1NyAyMS4yNTIzQzExNi42NTcgMjEuMDE5NSAxMTYuNjYgMjAuNzg2NiAxMTYuNjU3IDIwLjU1MzhDMTE2LjY1NSAyMC4zNzU5IDExNi42MzkgMjAuMTk4IDExNi42MjkgMjAuMDIwMkMxMTYuNjI5IDIwLjAwOTcgMTE2LjYyNiAxOS45OTkyIDExNi42MjMgMTkuOTg4OEMxMTYuNjA4IDE5LjkwNSAxMTYuNTk1IDE5LjgyMTMgMTE2LjU3OSAxOS43NDAyQzExNi41NjEgMTkuNjQzNCAxMTYuNTQ4IDE5LjU0NCAxMTYuNTE5IDE5LjQ0NzJDMTE2LjQ3OSAxOS4zMDYgMTE2LjQzIDE5LjE2NzMgMTE2LjM3MiAxOS4wMzM5QzExNi4yNTIgMTguNzUxNCAxMTYuMDg3IDE4LjQ5NzYgMTE1Ljg3IDE4LjI3NzlDMTE1LjcwOCAxOC4xMTMxIDExNS41MjIgMTcuOTgyMyAxMTUuMzA4IDE3Ljg5ODZDMTE1LjA0NiAxNy43OTY2IDExNC43NzEgMTcuNzcwNCAxMTQuNDk0IDE3Ljc3M0MxMTQuNDI2IDE3Ljc3MyAxMTQuMzU1IDE3Ljc4MDkgMTE0LjI4NyAxNy43OTM5QzExNC4xNDMgMTcuODI1MyAxMTQuMDA3IDE3Ljg3NzcgMTEzLjg4NCAxNy45NTYxQzExMy41OTEgMTguMTQ0NSAxMTMuMzY2IDE4LjM5MyAxMTMuMjA3IDE4LjY5OTFDMTEzLjA4NCAxOC45MzE5IDExMi45OSAxOS4xNzc4IDExMi45NCAxOS40Mzk0QzExMi45MTQgMTkuNTcwMiAxMTIuODg1IDE5LjcwMzYgMTEyLjg2OSAxOS44MzQ0QzExMi44NTEgMjAuMDIwMiAxMTIuODMgMjAuMjA1OSAxMTIuODMzIDIwLjM5NDJDMTEyLjgzMyAyMC41MDQxIDExMi44MjUgMjAuNjExNCAxMTIuODIyIDIwLjcyMTJDMTEyLjgyIDIwLjgyODUgMTEyLjgxMiAyMC45MzU3IDExMi44MjIgMjEuMDQwNEMxMTIuODQzIDIxLjIyODcgMTEyLjgzMyAyMS40MTk3IDExMi44NTkgMjEuNjA4MUMxMTIuODc3IDIxLjczMzYgMTEyLjg5IDIxLjg2MTggMTEyLjkxNCAyMS45ODc0QzExMi45MzUgMjIuMTA3NyAxMTIuOTU4IDIyLjIyODEgMTEyLjk5NSAyMi4zNDg0QzExMy4wMzQgMjIuNDgxOCAxMTMuMDY2IDIyLjYxNTIgMTEzLjExIDIyLjc0NkMxMTMuMTYyIDIyLjkwMDQgMTEzLjIzIDIzLjA0OTUgMTEzLjMxNCAyMy4xOTA3QzExMy40MjcgMjMuMzc5MSAxMTMuNTYzIDIzLjU0OTEgMTEzLjc0NiAyMy42NzczQzExNC4xMiAyMy45MzM3IDExNC41MzYgMjQuMDYxOSAxMTQuOTg4IDI0LjA2OTdDMTE1LjE2NiAyNC4wNzIzIDExNS4zMzQgMjQuMDM1NyAxMTUuNDk4IDIzLjk3MjlDMTE1LjgxIDIzLjg1MjYgMTE2LjA1MyAyMy42NDU5IDExNi4yNDQgMjMuMzc2NUMxMTYuNDA0IDIzLjE1MTUgMTE2LjUgMjIuOTAwNCAxMTYuNTU4IDIyLjYzMDlDMTE2LjU2OCAyMi41ODEyIDExNi41ODIgMjIuNTI4OSAxMTYuNTg5IDIyLjQ3OTJDMTE2LjYwNSAyMi4zOTI5IDExNi42MjYgMjIuMzAzOSAxMTYuNjMxIDIyLjIxNUMxMTYuNjQyIDIxLjg5MzIgMTE2LjY1MiAyMS41NzQxIDExNi42NjUgMjEuMjUyM1oiIGZpbGw9IiMyNjI2MjYiLz4KPHBhdGggZD0iTTEyNi4zOTQgMTUuNzcxOEMxMjYuNjY2IDE1Ljc2MzkgMTI2LjkzNiAxNS43NzcgMTI3LjIwMyAxNS44MDU4QzEyNy40MDcgMTUuODI5MyAxMjcuNjExIDE1Ljg2MzMgMTI3LjgxNSAxNS45QzEyNy45NTEgMTUuOTIzNSAxMjguMDkgMTUuOTUyMyAxMjguMjIzIDE1Ljk4ODlDMTI4LjQ2NCAxNi4wNTQzIDEyOC42OTkgMTYuMTM4IDEyOC45MjcgMTYuMjRDMTI5LjM5NSAxNi40NDY3IDEyOS44MjQgMTYuNzE2MSAxMzAuMjA2IDE3LjA1MUMxMzAuNjAxIDE3LjM5NjMgMTMwLjkyOCAxNy43OTkyIDEzMS4xOTIgMTguMjU0NEMxMzEuMzIgMTguNDcxNSAxMzEuNDMgMTguNjk5MSAxMzEuNTI0IDE4LjkzMTlDMTMxLjU3OSAxOS4wNjUzIDEzMS42MjEgMTkuMjA0IDEzMS42NjMgMTkuMzQyNkMxMzEuNyAxOS40NTUxIDEzMS43MzEgMTkuNTcwMiAxMzEuNzYgMTkuNjg1M0MxMzEuNzc1IDE5Ljc0NTUgMTMxLjc4MyAxOS44MDgzIDEzMS43OTQgMTkuODcxQzEzMS44MDkgMTkuOTQ2OSAxMzEuODIzIDIwLjAyMjggMTMxLjgzOCAyMC4xMDEyQzEzMS44NDEgMjAuMTA5MSAxMzEuODQxIDIwLjExOTYgMTMxLjg0MyAyMC4xMjc0QzEzMS44NTEgMjAuMTk1NCAxMzEuODY0IDIwLjI2NjEgMTMxLjg2NyAyMC4zMzQxQzEzMS44NzIgMjAuNTY5NSAxMzEuOTA5IDIwLjgwMjMgMTMxLjg4IDIxLjAzNzhDMTMxLjg3NSAyMS4wNzk2IDEzMS44NzcgMjEuMTIxNSAxMzEuODc1IDIxLjE2MDdDMTMxLjg2NCAyMS4yOTE1IDEzMS44NTkgMjEuNDIyMyAxMzEuODQxIDIxLjU1MDVDMTMxLjgyNSAyMS42NzYxIDEzMS43OTYgMjEuNzk2NCAxMzEuNzczIDIxLjkyMkMxMzEuNzU1IDIyLjAxNjIgMTMxLjczNiAyMi4xMTI5IDEzMS43MTMgMjIuMjA3MUMxMzEuNjg0IDIyLjMxNDQgMTMxLjY1MyAyMi40MTkgMTMxLjYxNiAyMi41MjM3QzEzMS41NzQgMjIuNjQ5MiAxMzEuNTMgMjIuNzcyMiAxMzEuNDgyIDIyLjg5NTFDMTMxLjM3OCAyMy4xNjQ2IDEzMS4yNSAyMy40MjA5IDEzMS4wOTggMjMuNjY5NUMxMzAuNjE0IDI0LjQ1NDMgMTI5Ljk0NyAyNS4wMzUgMTI5LjExOCAyNS40M0MxMjguODMgMjUuNTY4NyAxMjguNTMyIDI1LjY4MTIgMTI4LjIyNiAyNS43Njc1QzEyOC4wMjIgMjUuODIyNCAxMjcuODE1IDI1Ljg3NzQgMTI3LjYwNiAyNS45MjE4QzEyNy40MzYgMjUuOTU4NSAxMjcuMjY1IDI1Ljk5MjUgMTI3LjA5MyAyNi4wMTZDMTI2Ljc0NSAyNi4wNjA1IDEyNi4zOTQgMjYuMDk0NSAxMjYuMDQ0IDI2LjA2ODNDMTI1Ljc5OCAyNi4wNSAxMjUuNTU1IDI2LjAyMzkgMTI1LjMxMSAyNS45ODk5QzEyNS4wODQgMjUuOTU1OCAxMjQuODU2IDI1LjkxNjYgMTI0LjYzMSAyNS44NjE3QzEyNC4wOTUgMjUuNzMzNSAxMjMuNTggMjUuNTUwNCAxMjMuMTExIDI1LjI0OTVDMTIyLjY0OCAyNC45NDg3IDEyMi4yNTEgMjQuNTgyNCAxMjEuOTEzIDI0LjE0NTZDMTIxLjY5NiAyMy44NjA0IDEyMS41MTMgMjMuNTU0NCAxMjEuMzU5IDIzLjIzQzEyMS4yNzUgMjMuMDUyMSAxMjEuMjAyIDIyLjg3MTYgMTIxLjEzNiAyMi42ODU5QzEyMS4xIDIyLjU4OTEgMTIxLjA3NiAyMi40ODcgMTIxLjA0NyAyMi4zODc2QzEyMS4wMTMgMjIuMjY5OSAxMjAuOTgyIDIyLjE0OTYgMTIwLjk1MyAyMi4wMzE5QzEyMC45MzcgMjEuOTcxNyAxMjAuOTMgMjEuOTA4OSAxMjAuOTE5IDIxLjg0NjFDMTIwLjkwNiAyMS43NzAzIDEyMC44OSAyMS42OTE4IDEyMC44NzcgMjEuNjE1OUMxMjAuODc3IDIxLjYxMDcgMTIwLjg3NSAyMS42MDI4IDEyMC44NzIgMjEuNTk3NkMxMjAuODYyIDIxLjQ5MyAxMjAuODQ4IDIxLjM4NTcgMTIwLjg0MSAyMS4yODExQzEyMC44MyAyMS4xMDMyIDEyMC44MTcgMjAuOTI1MyAxMjAuODIgMjAuNzQ3NEMxMjAuODIgMjAuNTk1NyAxMjAuODMzIDIwLjQ0MzkgMTIwLjg0OCAyMC4yOTIyQzEyMC44NTkgMjAuMTc3MSAxMjAuODc3IDIwLjA2NDYgMTIwLjkwMSAxOS45NTIxQzEyMC45MjcgMTkuODI0IDEyMC45NjEgMTkuNjk1OCAxMjAuOTk1IDE5LjU2NzZDMTIxLjAyNiAxOS40NTI1IDEyMS4wNjYgMTkuMzQyNiAxMjEuMTAyIDE5LjIzMDFDMTIxLjE2IDE5LjA1NDggMTIxLjIzNiAxOC44ODQ4IDEyMS4zMjIgMTguNzJDMTIxLjYzNiAxOC4xMTA1IDEyMi4wNTIgMTcuNTc5NCAxMjIuNTY1IDE3LjEyNDJDMTIyLjk5NiAxNi43Mzk3IDEyMy40NzUgMTYuNDMzNiAxMjQuMDA2IDE2LjIwNkMxMjQuMjQ5IDE2LjEwMTQgMTI0LjUgMTYuMDE3NyAxMjQuNzU5IDE1Ljk1NzVDMTI0Ljk5MiAxNS45MDUyIDEyNS4yMjggMTUuODYwNyAxMjUuNDY2IDE1LjgyOTNDMTI1Ljc3MiAxNS43Nzk2IDEyNi4wODMgMTUuNzY5MiAxMjYuMzk0IDE1Ljc3MThaTTEyOC4yNzMgMjEuMjUyM0MxMjguMjcgMjEuMjUyMyAxMjguMjY3IDIxLjI1MjMgMTI4LjI2NSAyMS4yNTIzQzEyOC4yNjUgMjEuMDE5NSAxMjguMjY3IDIwLjc4NjYgMTI4LjI2NSAyMC41NTM4QzEyOC4yNjIgMjAuMzc1OSAxMjguMjQ2IDIwLjE5OCAxMjguMjM2IDIwLjAyMDJDMTI4LjIzNiAyMC4wMDk3IDEyOC4yMzMgMTkuOTk5MiAxMjguMjMxIDE5Ljk4ODhDMTI4LjIxNSAxOS45MDUgMTI4LjIwMiAxOS44MjEzIDEyOC4xODYgMTkuNzQwMkMxMjguMTY4IDE5LjY0MzQgMTI4LjE1NSAxOS41NDQgMTI4LjEyNiAxOS40NDcyQzEyOC4wODcgMTkuMzA2IDEyOC4wMzcgMTkuMTY3MyAxMjcuOTggMTkuMDMzOUMxMjcuODU5IDE4Ljc1MTQgMTI3LjY5NSAxOC40OTc2IDEyNy40NzcgMTguMjc3OUMxMjcuMzE1IDE4LjExMzEgMTI3LjEyOSAxNy45ODIzIDEyNi45MTUgMTcuODk4NkMxMjYuNjUzIDE3Ljc5NjYgMTI2LjM3OSAxNy43NzA0IDEyNi4xMDEgMTcuNzczQzEyNi4wMzMgMTcuNzczIDEyNS45NjMgMTcuNzgwOSAxMjUuODk1IDE3Ljc5MzlDMTI1Ljc1MSAxNy44MjUzIDEyNS42MTUgMTcuODc3NyAxMjUuNDkyIDE3Ljk1NjFDMTI1LjE5OSAxOC4xNDQ1IDEyNC45NzQgMTguMzkzIDEyNC44MTQgMTguNjk5MUMxMjQuNjkxIDE4LjkzMTkgMTI0LjU5NyAxOS4xNzc4IDEyNC41NDcgMTkuNDM5NEMxMjQuNTIxIDE5LjU3MDIgMTI0LjQ5MyAxOS43MDM2IDEyNC40NzcgMTkuODM0NEMxMjQuNDU5IDIwLjAyMDIgMTI0LjQzOCAyMC4yMDU5IDEyNC40NCAyMC4zOTQyQzEyNC40NCAyMC41MDQxIDEyNC40MzIgMjAuNjExNCAxMjQuNDMgMjAuNzIxMkMxMjQuNDI3IDIwLjgyODUgMTI0LjQxOSAyMC45MzU3IDEyNC40MyAyMS4wNDA0QzEyNC40NTEgMjEuMjI4NyAxMjQuNDQgMjEuNDE5NyAxMjQuNDY2IDIxLjYwODFDMTI0LjQ4NSAyMS43MzM2IDEyNC40OTggMjEuODYxOCAxMjQuNTIxIDIxLjk4NzRDMTI0LjU0MiAyMi4xMDc3IDEyNC41NjYgMjIuMjI4MSAxMjQuNjAyIDIyLjM0ODRDMTI0LjY0MiAyMi40ODE4IDEyNC42NzMgMjIuNjE1MiAxMjQuNzE4IDIyLjc0NkMxMjQuNzcgMjIuOTAwNCAxMjQuODM4IDIzLjA0OTUgMTI0LjkyMiAyMy4xOTA3QzEyNS4wMzQgMjMuMzc5MSAxMjUuMTcgMjMuNTQ5MSAxMjUuMzUzIDIzLjY3NzNDMTI1LjcyNyAyMy45MzM3IDEyNi4xNDMgMjQuMDYxOSAxMjYuNTk2IDI0LjA2OTdDMTI2Ljc3NCAyNC4wNzIzIDEyNi45NDEgMjQuMDM1NyAxMjcuMTA2IDIzLjk3MjlDMTI3LjQxNyAyMy44NTI2IDEyNy42NjEgMjMuNjQ1OSAxMjcuODUxIDIzLjM3NjVDMTI4LjAxMSAyMy4xNTE1IDEyOC4xMDggMjIuOTAwNCAxMjguMTY1IDIyLjYzMDlDMTI4LjE3NiAyMi41ODEyIDEyOC4xODkgMjIuNTI4OSAxMjguMTk3IDIyLjQ3OTJDMTI4LjIxMiAyMi4zOTI5IDEyOC4yMzMgMjIuMzAzOSAxMjguMjM5IDIyLjIxNUMxMjguMjQ5IDIxLjg5MzIgMTI4LjI2IDIxLjU3NDEgMTI4LjI3MyAyMS4yNTIzWiIgZmlsbD0iIzI2MjYyNiIvPgo8cGF0aCBkPSJNMTMyLjEwOCAyNS43MjY0QzEzMi4yMjkgMjUuNjE5OSAxMzIuMzM1IDI1LjUxMzQgMTMyLjQ0MiAyNS4zOTM2QzEzMi41NjIgMjUuMjYwNSAxMzIuNjU2IDI1LjExNCAxMzIuNzM2IDI0Ljk1NDNDMTMyLjgwMyAyNC44MjEyIDEzMi44NDMgMjQuNjYxNSAxMzIuODY5IDI0LjUxNUMxMzIuOTEgMjQuMjYyMSAxMzIuOTEgMjQuMDA5MiAxMzIuOTEgMjMuNzQzQzEzMi45MSAyMi40Nzg0IDEzMi45MSAyMS4yMjcxIDEzMi45MSAxOS45NjI2QzEzMi45MSAxOS40NTY4IDEzMi44OTYgMTguOTUwOSAxMzIuOTEgMTguNDQ1MUMxMzIuOTEgMTguMTc4OSAxMzIuOTIzIDE3LjkxMjYgMTMyLjg5NiAxNy42NDY0QzEzMi44ODMgMTcuNDA2OCAxMzIuODQzIDE3LjE2NzIgMTMyLjc0OSAxNi45NTQyQzEzMi42NTYgMTYuNzU0NiAxMzIuNTA5IDE2LjU2ODIgMTMyLjM3NSAxNi4zOTUyQzEzMi4yOTUgMTYuMjg4NyAxMzIuMjE1IDE2LjE5NTUgMTMyLjEzNSAxNi4xMDIzQzEzMi4zMjIgMTYuMTAyMyAxMzIuNTIyIDE2LjExNTYgMTMyLjcwOSAxNi4xMTU2QzEzMy4xNjMgMTYuMTI4OSAxMzMuNjA0IDE2LjEyODkgMTM0LjA1OCAxNi4xMjg5QzEzNC40NTggMTYuMTI4OSAxMzQuODU5IDE2LjExNTYgMTM1LjI1OSAxNi4wNzU3QzEzNS40NzMgMTYuMDYyNCAxMzUuNjg3IDE2LjAzNTggMTM1LjkgMTUuOTgyNUMxMzYuMTI3IDE1LjkyOTMgMTM2LjM1NCAxNS44NjI3IDEzNi41ODEgMTUuNzY5NUMxMzYuNTgxIDE2LjE0MjIgMTM2LjU4MSAxNi41MTUgMTM2LjU4MSAxNi44NzQ0QzEzNi42MjEgMTYuODg3NyAxMzYuNjQ4IDE2Ljg4NzcgMTM2LjY4OCAxNi44NzQ0QzEzNi43MjggMTYuODYxMSAxMzYuNzY4IDE2LjgzNDQgMTM2LjgwOCAxNi44MDc4QzEzNi45OTUgMTYuNjYxNCAxMzcuMTQyIDE2LjQ3NSAxMzcuMzE2IDE2LjM0MTlDMTM3LjUyOSAxNi4xNjg5IDEzNy43OTYgMTYuMDQ5MSAxMzguMDYzIDE1Ljk2OTJDMTM4LjQxMSAxNS44NjI3IDEzOC43NTggMTUuODIyOCAxMzkuMTMyIDE1LjgyMjhDMTM5LjU5OSAxNS44MjI4IDE0MC4wOCAxNS44NzYgMTQwLjQ1MyAxNi4wNDkxQzE0MC42NCAxNi4xNDIyIDE0MC44MDEgMTYuMjYyMSAxNDAuOTg3IDE2LjQyMThDMTQxLjE4OCAxNi41OTQ4IDE0MS40NDEgMTYuODA3OCAxNDEuNjQyIDE2Ljk2NzVDMTQxLjgyOSAxNi43OTQ1IDE0Mi4wMjkgMTYuNjM0OCAxNDIuMjQzIDE2LjUwMTdDMTQyLjYwMyAxNi4yNzU0IDE0Mi45OSAxNi4xMDIzIDE0My40MDQgMTYuMDA5MUMxNDMuNzc4IDE1LjkxNiAxNDQuMTY1IDE1Ljg2MjcgMTQ0LjU1MiAxNS44NjI3QzE0NC45NjYgMTUuODQ5NCAxNDUuMzk0IDE1Ljg4OTMgMTQ1LjgwOCAxNS45ODI1QzE0Ni4zNTUgMTYuMTE1NiAxNDYuODc2IDE2LjM1NTIgMTQ3LjMwMyAxNi43MTQ2QzE0Ny41NTcgMTYuOTE0MyAxNDcuNzcgMTcuMTUzOSAxNDcuOTQ0IDE3LjQyMDFDMTQ4LjExNyAxNy42ODY0IDE0OC4yMzggMTcuOTkyNSAxNDguMjkxIDE4LjMxMkMxNDguMzMxIDE4LjU2NDkgMTQ4LjMzMSAxOC44MzExIDE0OC4zMzEgMTkuMDg0QzE0OC4zMzEgMTkuODQyOCAxNDguMzMxIDIwLjU4ODIgMTQ4LjMzMSAyMS4zMzM2QzE0OC4zMzEgMjEuNjUzMSAxNDguMzMxIDIxLjk3MjYgMTQ4LjMzMSAyMi4zMDU0QzE0OC4zMzEgMjIuNjM4MSAxNDguMzMxIDIyLjk1NzYgMTQ4LjMzMSAyMy4yOTA0QzE0OC4zMzEgMjMuNTU2NiAxNDguMzMxIDIzLjgwOTUgMTQ4LjMzMSAyNC4wNzU4QzE0OC4zMzEgMjQuMzE1NCAxNDguMzQ0IDI0LjU2ODMgMTQ4LjQxMSAyNC43OTQ2QzE0OC40NzggMjUuMDA3NiAxNDguNjI1IDI1LjIwNzIgMTQ4Ljc1OCAyNS4zOTM2QzE0OC44MzggMjUuNTAwMSAxNDguOTMyIDI1LjYwNjYgMTQ5LjA5MiAyNS43Mzk3QzE0Ny4zNTYgMjUuNzM5NyAxNDUuNjIxIDI1LjczOTcgMTQzLjg3MiAyNS43Mzk3QzE0My45OTIgMjUuNjE5OSAxNDQuMDk4IDI1LjUwMDEgMTQ0LjIwNSAyNS4zODAzQzE0NC4zMTIgMjUuMjQ3MiAxNDQuNDA2IDI1LjEyNzQgMTQ0LjQ3MiAyNC45ODA5QzE0NC41MzkgMjQuODQ3OCAxNDQuNTY2IDI0LjY4ODEgMTQ0LjU5MyAyNC41MjgzQzE0NC42MDYgMjQuNDM1MiAxNDQuNjE5IDI0LjMyODcgMTQ0LjYxOSAyNC4yMzU1QzE0NC42MTkgMjQuMTQyMyAxNDQuNjE5IDI0LjA0OTEgMTQ0LjYxOSAyMy45NTZDMTQ0LjYwNiAyMy4xNDQgMTQ0LjYxOSAyMi4zMTg3IDE0NC42MTkgMjEuNTA2N0MxNDQuNjE5IDIxLjE0NzMgMTQ0LjYxOSAyMC44MDEyIDE0NC42MTkgMjAuNDQxOEMxNDQuNjE5IDIwLjA4MjQgMTQ0LjYzMyAxOS43MDk3IDE0NC42MTkgMTkuMzUwM0MxNDQuNjE5IDE5LjIxNzIgMTQ0LjYwNiAxOS4wOTczIDE0NC41OTMgMTguOTc3NUMxNDQuNTY2IDE4LjgxNzggMTQ0LjQ4NiAxOC42NTgxIDE0NC4zOTIgMTguNTI1QzE0NC4yODUgMTguMzc4NSAxNDQuMTUyIDE4LjI1ODcgMTQ0LjAwNSAxOC4xNzg5QzE0My44NDUgMTguMDk5IDE0My42NDUgMTguMDU5MSAxNDMuNDcxIDE4LjA3MjRDMTQzLjIzMSAxOC4wODU3IDE0My4wMDQgMTguMTkyMiAxNDIuODQzIDE4LjM1MTlDMTQyLjY5NyAxOC40OTgzIDE0Mi41OSAxOC42ODQ3IDE0Mi41MzYgMTguODg0NEMxNDIuNDk2IDE5LjA0NDEgMTQyLjQ5NiAxOS4yMDM4IDE0Mi40OTYgMTkuMzYzNkMxNDIuNDk2IDE5LjUxIDE0Mi40OTYgMTkuNjQzMSAxNDIuNDk2IDE5Ljc4OTVDMTQyLjQ5NiAyMC4xNzU2IDE0Mi40OTYgMjAuNTc0OSAxNDIuNDk2IDIwLjk2MDlDMTQyLjQ5NiAyMS45NDYgMTQyLjUxIDIyLjkzMSAxNDIuNDk2IDIzLjkwMjdDMTQyLjQ5NiAyNC4wMzU4IDE0Mi40OTYgMjQuMTgyMyAxNDIuNDk2IDI0LjMxNTRDMTQyLjUxIDI0LjUwMTcgMTQyLjUyMyAyNC43MDE0IDE0Mi42MDMgMjQuODc0NEMxNDIuNjgzIDI1LjA3NDEgMTQyLjgxNyAyNS4yNDcyIDE0Mi45NjQgMjUuNDIwMkMxNDMuMDU3IDI1LjU0IDE0My4xNjQgMjUuNjQ2NSAxNDMuMjcxIDI1Ljc1M0MxNDEuNTIyIDI1Ljc1MyAxMzkuNzg2IDI1Ljc1MyAxMzguMDM3IDI1Ljc1M0MxMzguMTU3IDI1LjYzMzIgMTM4LjI2NCAyNS41MTM0IDEzOC4zNyAyNS4zOTM2QzEzOC40NzcgMjUuMjYwNSAxMzguNTcxIDI1LjE0MDcgMTM4LjYzOCAyNC45OTQyQzEzOC43MDQgMjQuODYxMSAxMzguNzMxIDI0LjcwMTQgMTM4Ljc1OCAyNC41NDE3QzEzOC43NzEgMjQuNDQ4NSAxMzguNzg0IDI0LjM0MiAxMzguNzg0IDI0LjI0ODhDMTM4Ljc4NCAyNC4xNTU2IDEzOC43ODQgMjQuMDYyNCAxMzguNzg0IDIzLjk2OTNDMTM4Ljc3MSAyMy4xNTczIDEzOC43ODQgMjIuMzMyIDEzOC43ODQgMjEuNTJDMTM4Ljc4NCAyMS4xNjA2IDEzOC43ODQgMjAuODE0NSAxMzguNzg0IDIwLjQ1NTFDMTM4Ljc4NCAyMC4wOTU3IDEzOC43OTggMTkuNzIzIDEzOC43ODQgMTkuMzYzNkMxMzguNzg0IDE5LjIzMDUgMTM4Ljc3MSAxOS4xMTA3IDEzOC43NTggMTguOTkwOUMxMzguNzMxIDE4LjgzMTEgMTM4LjY1MSAxOC42NzE0IDEzOC41NTcgMTguNTM4M0MxMzguNDUxIDE4LjM5MTkgMTM4LjMxNyAxOC4yNzIxIDEzOC4xNyAxOC4xOTIyQzEzOC4wMSAxOC4xMTIzIDEzNy44MSAxOC4wNzI0IDEzNy42MzYgMTguMDg1N0MxMzcuMzk2IDE4LjA5OSAxMzcuMTY5IDE4LjIwNTUgMTM3LjAwOSAxOC4zNjUyQzEzNi44NjIgMTguNTExNyAxMzYuNzU1IDE4LjY5OCAxMzYuNzAxIDE4Ljg5NzdDMTM2LjY2MSAxOS4wNTc0IDEzNi42NjEgMTkuMjE3MSAxMzYuNjYxIDE5LjM3NjlDMTM2LjY2MSAxOS41MjMzIDEzNi42NjEgMTkuNjU2NCAxMzYuNjYxIDE5LjgwMjhDMTM2LjY2MSAyMC4xODg5IDEzNi42NjEgMjAuNTg4MiAxMzYuNjYxIDIwLjk3NDJDMTM2LjY2MSAyMS45NTkzIDEzNi42NzUgMjIuOTQ0MyAxMzYuNjYxIDIzLjkxNkMxMzYuNjYxIDI0LjA0OTEgMTM2LjY2MSAyNC4xOTU2IDEzNi42NjEgMjQuMzI4N0MxMzYuNjc1IDI0LjUxNSAxMzYuNjg4IDI0LjcxNDcgMTM2Ljc2OCAyNC44ODc3QzEzNi44NDggMjUuMDg3NCAxMzYuOTgyIDI1LjI2MDUgMTM3LjEyOSAyNS40MzM1QzEzNy4yMjIgMjUuNTUzMyAxMzcuMzI5IDI1LjY1OTggMTM3LjQzNiAyNS43NjYzQzEzNS42MDcgMjUuNzI2NCAxMzMuODU4IDI1LjcyNjQgMTMyLjEwOCAyNS43MjY0WiIgZmlsbD0iIzI2MjYyNiIvPgo8L3N2Zz4=" alt="WhisperRoom" class="logo-img">
    <div class="header-right">
      <div class="quote-type">Price Quote</div>
      <div class="quote-num">${q.quoteNumber||'QUOTE'}</div>
      <div class="quote-meta">Issued ${q.date||new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric',timeZone:'America/New_York'})}</div>
      ${(q.rep||REPS[q.ownerId])?`<div style="font-size:11px;color:#888;margin-top:4px;font-weight:600">${q.rep||REPS[q.ownerId]||''}</div>`:''}
      <div class="quote-valid-tag">Valid 30 Days</div>
      ${q.quoteLabel ? `<div style="margin-top:8px;display:block;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#ee6216;background:rgba(238,98,22,.08);border:1px solid rgba(238,98,22,.25);border-radius:4px;padding:4px 12px;width:fit-content;margin-left:auto">${q.quoteLabel}</div>` : ''}
    </div>
  </div>
  <div class="accent-strip"></div>

  ${c.firstName ? `<div class="card">
    <div class="card-label">Prepared For</div>
    <div class="info-grid">
      <div class="info-item"><label>Name</label><span>${c.firstName} ${c.lastName}</span></div>
      ${c.company?`<div class="info-item"><label>Company</label><span>${c.company}</span></div>`:''}
      ${c.email?`<div class="info-item"><label>Email</label><span>${c.email}</span></div>`:''}
      ${(c.address||c.city||c.state||c.zip)?`<div class="info-item"><label>Ship To</label><span>${[c.address,c.city,(c.state&&c.zip?c.state+' '+c.zip:c.state||c.zip)].filter(Boolean).join(', ')}</span></div>`:''}
      ${q.billing && (q.billing.address || q.billing.email) ? `<div class="info-item" style="margin-top:10px;padding-top:10px;border-top:1px solid #f0f0f0"><label>Bill To</label><span>${[q.billing.email||'',q.billing.address||'',[q.billing.city,(q.billing.state&&q.billing.zip?q.billing.state+' '+q.billing.zip:q.billing.state||q.billing.zip)].filter(Boolean).join(', ')].filter(Boolean).join('<br>')}</span></div>` : ''}
    </div>
  </div>` : ''}

  <div class="card">
    <div class="card-label">Products &amp; Services</div>
    <table>
      <thead><tr><th>Item</th><th style="text-align:center">Qty</th><th style="text-align:right">Unit Price</th><th style="text-align:right">Total</th></tr></thead>
      <tbody>${lineRows}</tbody>
    </table>
    <div style="display:flex;align-items:flex-start;gap:20px;margin-top:16px;flex-wrap:wrap">
      ${q.notes ? `<div style="flex:1;min-width:180px;background:rgba(238,98,22,.06);border:1px solid rgba(238,98,22,.25);border-radius:8px;padding:14px 16px">
        <div style="font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:#ee6216;margin-bottom:6px">Quote Notes</div>
        <div style="font-size:13px;color:#444;line-height:1.6;white-space:pre-wrap">${q.notes.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
      </div>` : ''}
      <div style="min-width:220px;${q.notes ? '' : 'margin-left:auto'}">
        <div class="totals" style="margin-top:0">
          <div class="tot"><span>Subtotal</span><span>${fmt(sub)}</span></div>
          ${disc>0?`<div class="tot"><span>Discount${q.discount.type==='pct'?' ('+q.discount.value+'%)':''}</span><span class="discount-val">-${fmt(disc)}</span></div>`:''}
          ${freightTbd?'<div class="tot"><span>Freight</span><span style="color:#888;font-style:italic">TBD</span></div>':freight>0?`<div class="tot"><span>Freight</span><span>${fmt(freight)}</span></div>`:''}
          ${tax>0?`<div class="tot"><span>Sales Tax${q.tax&&q.tax.rate?' ('+( q.tax.rate*100).toFixed(2).replace(/\.?0+$/,'')+')%':''}</span><span>${fmt(tax)}</span></div>`:''}
          ${(q.taxExempt||q.accessories?.taxexempt)?'<div class="tot"><span style="color:#22c55e;font-weight:700">✓ Tax Exempt</span><span style="color:#22c55e">'+(q.taxExemptCert||q.taxExemptCertificate||'Exempt')+'</span></div>':''}
          <div class="tot grand"><span>Total</span><span>${fmt(total)}</span></div>
        </div>
      </div>
    </div>
  </div>
  ${freightTbd?`<div class="card" style="border-left:3px solid #ee6216;background:#fff8f5">
    <p style="margin:0;font-size:12px;color:#666"><strong style="color:#ee6216">Freight Note:</strong> Freight cost is to be determined. A freight estimate will be provided before your order is finalized. The total above does not include freight.</p>
  </div>`:''}
  ${(q.taxExempt||q.accessories?.taxexempt)?`<div class="card" style="border-left:3px solid #22c55e;background:#f0fdf4">
    <p style="margin:0;font-size:12px;color:#166534"><strong style="color:#166534">Tax Exemption Required:</strong> A valid tax exemption certificate must be provided to WhisperRoom, Inc. before your order can be processed.${(q.taxExemptCert||q.taxExemptCertificate)?(' Certificate: '+(q.taxExemptCert||q.taxExemptCertificate)):''}</p>
  </div>`:''}

  <div class="card">
    <div class="card-label">Terms &amp; Conditions</div>
    <p class="terms">I understand that WhisperRooms are not 100% soundproof. I understand that all products manufactured by WhisperRoom, Inc. are for indoor use only. Any returns will be at the sole discretion of WhisperRoom, Inc. and are subject to a restocking fee and freight charges. Any damage during shipping must be reported within five business days. Compliance with local, state and national building codes is my responsibility. Any alterations to the WhisperRoom will void the warranty.</p>
    <p class="terms" style="margin-top:8px">Standard delivery requires recipient to offload boxes from pallet. Standard delivery does not include extra services and fees related to those services such as Liftgate, Inside Delivery, Sort and Segregate and storage fees.</p>
  </div>

  <div class="footer">
    <strong>WhisperRoom, Inc.</strong> &middot; 322 Nancy Lynn Lane, Suite 14 &middot; Knoxville, TN 37919<br>
    <a href="tel:18002008168">1-800-200-8168</a> &middot; <a href="mailto:info@whisperroom.com">info@whisperroom.com</a> &middot; <a href="https://www.whisperroom.com" target="_blank">whisperroom.com</a><br>
    Shipping charges are based on the zip code provided and may vary. Quote valid 30 days from issue date.
  </div>

</div>

<!-- Foam/Hinge selection modal -->
<div id="accept-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:200;align-items:center;justify-content:center;padding:16px">
  <div style="background:white;border-radius:14px;padding:32px;max-width:440px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.3)">
    <h2 style="font-size:18px;font-weight:800;color:#1a1a1a;margin-bottom:6px">One last step!</h2>
    <p style="font-size:13px;color:#888;margin-bottom:24px">Please answer the following before accepting your quote. These are required before your order ships — you can choose <em>Undecided</em> if you need more time.</p>

    <div style="margin-bottom:20px">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#555;margin-bottom:10px">Foam Color</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px" id="foam-grid">
        ${['Gray','Blue','Purple','Orange','Burgundy','Undecided'].map(c => `
        <label class="sel-label" style="display:flex;align-items:center;gap:8px;padding:10px 12px;border:2px solid #eee;border-radius:8px;cursor:pointer;font-size:14px;font-weight:500;transition:all .15s">
          <input type="radio" name="foam" value="${c}" style="accent-color:#ee6216" onchange="updateLabels()"> ${c}
        </label>`).join('')}
      </div>
    </div>

    <div style="margin-bottom:28px">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#555;margin-bottom:10px">Door Hinge</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px" id="hinge-grid">
        ${['Left Hand','Right Hand','Undecided'].map(h => `
        <label class="sel-label" style="display:flex;align-items:center;gap:8px;padding:10px 12px;border:2px solid #eee;border-radius:8px;cursor:pointer;font-size:14px;font-weight:500;transition:all .15s">
          <input type="radio" name="hinge" value="${h}" style="accent-color:#ee6216" onchange="updateLabels()"> ${h}
        </label>`).join('')}
      </div>
    </div>

    <div style="margin-bottom:20px">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#555;margin-bottom:8px">Message to WhisperRoom <span style="font-weight:400;text-transform:none;letter-spacing:0;color:#bbb">(optional)</span></div>
      <textarea id="customer-note" rows="3" placeholder="Any questions, special instructions, or delivery notes..." style="width:100%;padding:10px 12px;border:2px solid #eee;border-radius:8px;font-size:14px;font-family:inherit;resize:vertical;box-sizing:border-box"></textarea>
    </div>

    <p style="font-size:12px;color:#bbb;margin:0 0 16px;text-align:center">These selections are required before your order ships. Choose <em>Undecided</em> if you need more time — a WhisperRoom rep will follow up.</p>

    <div style="display:flex;gap:10px">
      <button onclick="submitAcceptance()" style="flex:1;padding:13px;background:#ee6216;color:white;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer">
        ✓ Accept Quote
      </button>
      <button onclick="document.getElementById('accept-modal').style.display='none'" style="padding:13px 18px;background:#f0f0f0;color:#555;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">
        Cancel
      </button>
    </div>
  </div>
</div>

<div class="action-bar" id="action-bar">
  <button class="btn btn-accept" id="accept-btn" onclick="acceptQuote()">&#x2713;&nbsp;&nbsp;Accept This Quote</button>
  <button class="btn btn-primary" onclick="window.print()">&#x2B07;&nbsp;&nbsp;Download PDF</button>
  <button class="btn btn-secondary" id="share-btn" onclick="(function(b){if(navigator.clipboard){navigator.clipboard.writeText(window.location.href).then(function(){b.textContent='\u2713 Copied!';setTimeout(function(){b.textContent='Share Link'},2000)}).catch(function(){prompt('Copy link:',window.location.href)})}else{prompt('Copy link:',window.location.href)}})(this)">Share Link</button>
</div>

<div id="accepted-bar" style="display:none;position:fixed;bottom:0;left:0;right:0;background:#1a7a4a;color:white;text-align:center;padding:20px;font-size:15px;font-weight:700;z-index:100;font-family:inherit">
  &#x2713;&nbsp;&nbsp;Quote Accepted &mdash; A WhisperRoom representative will be in touch shortly.
</div>

<script>
  document.title = 'Quote ${q.quoteNumber||''}${q.dealName ? ' - ' + q.dealName.replace(/[<>]/g,'') : ''}';

  function updateLabels() {
    // Reset all label borders, then highlight only the selected one per group
    document.querySelectorAll('.sel-label').forEach(l => {
      l.style.borderColor = '#eee';
      l.style.background = 'white';
    });
    document.querySelectorAll('input[name="foam"]:checked, input[name="hinge"]:checked').forEach(inp => {
      const label = inp.closest('.sel-label');
      if (label) {
        label.style.borderColor = '#ee6216';
        label.style.background = '#fff8f0';
      }
    });
  }

  async function acceptQuote() {
    const btn = document.getElementById('accept-btn');
    if (!btn) return;

    // Show foam/hinge selection modal first
    const modal = document.getElementById('accept-modal');
    if (modal) { modal.style.display = 'flex'; return; }
  }

  async function submitAcceptance() {
    const foam  = document.querySelector('input[name="foam"]:checked')?.value  || '';
    const hinge = document.querySelector('input[name="hinge"]:checked')?.value || '';
    const customerNote = (document.getElementById('customer-note')?.value || '').trim();
    // Foam and hinge are optional — no validation required

    document.getElementById('accept-modal').style.display = 'none';
    const btn = document.getElementById('accept-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = 'Processing…'; }

    try {
      const res = await fetch('/api/accept-quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteNumber: '${q.quoteNumber || ""}',
          dealId: '${q.dealId || ""}',
          contactEmail: '${q.customer ? (q.customer.email || "") : ""}',
          foamColor: foam,
          hingePreference: hinge,
          customerNote: customerNote,
        })
      });
      const data = await res.json();
      if (data.success) {
        document.getElementById('action-bar').style.display = 'none';
        document.getElementById('accepted-bar').style.display = 'block';
        window.scrollTo(0, 0);
      } else {
        if (btn) { btn.disabled = false; btn.innerHTML = '✓  Accept This Quote'; }
        alert('Something went wrong. Please contact WhisperRoom at (865) 558-5364.');
      }
    } catch(e) {
      if (btn) { btn.disabled = false; btn.innerHTML = '✓  Accept This Quote'; }
    }
  }
</script>
</body>
</html>`;;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end('<h2 style="font-family:sans-serif;padding:40px">Error: ' + e.message + '</h2>');
    }
    return;
  }

  // ── API: Batch check current prices for line items ──────────────
  if (pathname === '/api/check-prices' && req.method === 'POST') {
    try {
      const { items } = JSON.parse(await readBody(req));
      if (!items || !items.length) { json({ results: [] }); return; }

      // Only check items that have a productId
      const toCheck = items.filter(i => i.productId);
      if (!toCheck.length) { json({ results: [] }); return; }

      // Fetch current prices in parallel
      const checks = await Promise.all(toCheck.map(async item => {
        try {
          const res = await httpsRequest({
            hostname: 'api.hubapi.com',
            path: `/crm/v3/objects/products/${item.productId}?properties=name,price`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
          });
          const current = parseFloat(res.body?.properties?.price || 0);
          const quoted  = parseFloat(item.price || 0);
          return {
            productId: item.productId,
            name: item.name,
            quotedPrice: quoted,
            currentPrice: current,
            changed: Math.abs(current - quoted) > 0.01
          };
        } catch(e) {
          return { productId: item.productId, name: item.name, error: true };
        }
      }));

      json({ results: checks });
    } catch(e) { json({ error: e.message }, 500); }
    return;
  }

  // ── API: Accept Quote (from shareable link page) ──────────────
  if (pathname === '/api/accept-quote' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const { quoteNumber } = body;
      // dealId comes from the quote snapshot in DB or HubSpot — more reliable than embedded template
      let dealId = body.dealId;

      // If dealId is missing, look it up from DB deal_id column first, then snapshot, then HubSpot
      if (!dealId) {
        if (db) {
          const row = await db.query('SELECT deal_id FROM quotes WHERE quote_number = $1', [quoteNumber]);
          dealId = row.rows[0]?.deal_id || null;
        }
        if (!dealId) {
          const snapshot = await getQuoteFromDb(quoteNumber);
          if (snapshot?.dealId) dealId = snapshot.dealId;
          // Also check linkedDealId in snapshot
          if (!dealId && snapshot?.linkedDealId) dealId = snapshot.linkedDealId;
        }
        // Last resort: search HubSpot for a deal with this quote number
        if (!dealId) {
          try {
            const srch = await httpsRequest({
              hostname: 'api.hubapi.com',
              path: '/crm/v3/objects/deals/search',
              method: 'POST',
              headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
            }, {
              filterGroups: [{ filters: [{ propertyName: 'quote_number', operator: 'EQ', value: quoteNumber }] }],
              properties: ['dealname', 'quote_number'],
              limit: 1
            });
            dealId = srch.body?.results?.[0]?.id || null;
            if (dealId) console.log(`Accept: found dealId ${dealId} via HubSpot search`);
          } catch(e) { console.warn('HubSpot deal search failed:', e.message); }
        }
        // Also backfill the DB if we found it
        if (dealId && db) {
          db.query('UPDATE quotes SET deal_id = $1 WHERE quote_number = $2 AND deal_id IS NULL', [dealId, quoteNumber]).catch(() => {});
        }
      }

      console.log(`Accept quote #${quoteNumber} → dealId: ${dealId}`);
      const results = { quoteNumber, resolvedDealId: dealId };

      if (!dealId) {
        console.warn(`[accept] dealId still null after all lookups for ${quoteNumber}`);
      } else {
        console.log(`[accept] will advance deal ${dealId} to contractsent`);
      }

      // 0. Mark quote as accepted in DB with timestamp + customer preferences
      if (db && quoteNumber) {
        try {
          const acceptedAt = new Date().toISOString();
          await db.query(
            `UPDATE quotes SET json_snapshot = jsonb_set(
              jsonb_set(
                jsonb_set(
                  jsonb_set(
                    jsonb_set(COALESCE(json_snapshot, '{}'), '{accepted}', 'true'),
                    '{acceptedAt}', $2
                  ),
                  '{acceptedFoam}', $3
                ),
                '{acceptedHinge}', $4
              ),
              '{acceptedNote}', $5
            ) WHERE quote_number = $1`,
            [
              quoteNumber,
              JSON.stringify(acceptedAt),
              JSON.stringify(body.foamColor || ''),
              JSON.stringify(body.hingePreference || ''),
              JSON.stringify(body.customerNote || ''),
            ]
          );
          console.log(`Quote ${quoteNumber} marked accepted in DB`);
        } catch(e) { console.warn('DB accepted flag error:', e.message); }
      }

      // 1. Advance deal stage to Verbal Confirmation
      if (dealId) {
        const stageRes = await httpsRequest({
          hostname: 'api.hubapi.com',
          path: `/crm/v3/objects/deals/${dealId}`,
          method: 'PATCH',
          headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
        }, { properties: { dealstage: 'contractsent' } });
        results.stageUpdated = !stageRes.body.error;
        if (stageRes.body.error) {
          console.warn('[accept] Stage update failed:', stageRes.body.message);
        } else {
          console.log(`[accept] Deal ${dealId} stage → contractsent ✓`);
        }
      } else {
        results.warning = 'No dealId found — stage not updated';
        console.warn(`Accept quote #${quoteNumber}: no dealId found`);
      }

      // 2. Create a HubSpot task for the deal owner
      if (dealId) {
        // Get deal owner first
        const dealData = await httpsRequest({
          hostname: 'api.hubapi.com',
          path: `/crm/v3/objects/deals/${dealId}?properties=hubspot_owner_id,dealname`,
          method: 'GET',
          headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
        });
        const ownerId = dealData.body?.properties?.hubspot_owner_id;
        const dealName = dealData.body?.properties?.dealname || 'Deal';

        if (ownerId) {
          const dueDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
          await httpsRequest({
            hostname: 'api.hubapi.com',
            path: '/crm/v3/objects/tasks',
            method: 'POST',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
          }, {
            properties: {
              hs_task_subject: `🔔 ACCEPTED — ${dealName} — Quote #${quoteNumber}`,
              hs_task_body: `Customer accepted quote #${quoteNumber} for ${dealName}. Ready to create invoice.\n\nFoam Color: ${body.foamColor || 'Not selected'}\nHinge: ${body.hingePreference || 'Not selected'}${body.customerNote ? '\n\nCustomer Note: "' + body.customerNote + '"' : ''}`,
              hubspot_owner_id: ownerId,
              hs_task_status: 'NOT_STARTED',
              hs_task_type: 'TODO',
              hs_timestamp: new Date().toISOString(),
              hs_task_priority: 'HIGH',
            },
            associations: dealId ? [{ to: { id: dealId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 216 }] }] : []
          });
          results.taskCreated = true;

          // Internal notification to rep
          const repName = REPS[String(ownerId)] || 'Rep';
          const notePrefs = [
            body.foamColor ? `Foam: ${body.foamColor}` : null,
            body.hingePreference ? `Hinge: ${body.hingePreference}` : null,
            body.customerNote ? `Note: "${body.customerNote}"` : null,
          ].filter(Boolean).join(' · ');
          await notifyRep(ownerId, `✓ Quote Accepted — ${dealName}`,
            `Quote #${quoteNumber} was accepted by the customer.${notePrefs ? ' ' + notePrefs : ''} Ready to invoice.`,
            { type: 'quote_accepted', dealId, dealName, quoteNum: quoteNumber }
          );
        }
      }

      // 3. Log a plain note on the deal (NOT a WR_QUOTE_DATA note — just an activity log)
      if (dealId) {
        const acceptNote = await httpsRequest({
          hostname: 'api.hubapi.com',
          path: '/crm/v3/objects/notes',
          method: 'POST',
          headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
        }, {
          properties: {
            hs_note_body: `✓ Quote #${quoteNumber} accepted by customer on ${new Date().toLocaleDateString('en-US', {month:'long',day:'numeric',year:'numeric'})}.\n\nFoam Color: ${body.foamColor || 'Not selected'}\nHinge Preference: ${body.hingePreference || 'Not selected'}${body.customerNote ? '\n\nCustomer Note: "' + body.customerNote + '"' : ''}`,
            hs_timestamp: new Date().toISOString(),
          },
          associations: [{
            to: { id: dealId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }]
          }]
        });
        results.noteLogged = !!acceptNote.body?.id;
      }

      json({ success: true, results });
    writelog('error','error.accept-quote',`accept-quote failed: ${e.message}`,{ rep: getRepFromReq(req) });
    } catch(e) { json({ error: e.message }, 500); }
    return;
  }

  // ── HubSpot Webhook: invoice paid → auto-update payment_status ───
  // Set up in HubSpot: Workflows → Invoice paid → HTTP request POST to this endpoint
  // Payload: { "objectId": "<invoice_id>", "dealId": "<deal_id>" }  (or HubSpot standard format)
  if (pathname === '/api/webhooks/invoice-paid' && req.method === 'POST') {
    try {
      const raw = await readBody(req);
      const events = JSON.parse(raw);
      // Respond immediately — process in background
      json({ received: true });

      const items = Array.isArray(events) ? events : [events];
      for (const event of items) {
        // HubSpot sends objectId for the invoice, and we need the associated deal
        const invoiceId = event.objectId || event.invoiceId || null;
        let dealId = event.dealId || event.associatedDealId || null;

        // If no dealId in payload, look it up via invoice → deal association
        if (!dealId && invoiceId) {
          try {
            const assocRes = await httpsRequest({
              hostname: 'api.hubapi.com',
              path: `/crm/v4/associations/invoices/deals/batch/read`,
              method: 'POST',
              headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
            }, { inputs: [{ id: String(invoiceId) }] });
            dealId = assocRes.body?.results?.[0]?.to?.[0]?.toObjectId || null;
            if (dealId) console.log(`[invoice-webhook] invoice ${invoiceId} → deal ${dealId}`);
          } catch(e) { console.warn('[invoice-webhook] association lookup failed:', e.message); }
        }

        if (!dealId) {
          console.warn('[invoice-webhook] no dealId found for event:', JSON.stringify(event).slice(0, 200));
          continue;
        }

        // Set payment_status = 'paid' on the deal
        try {
          await httpsRequest({
            hostname: 'api.hubapi.com',
            path: `/crm/v3/objects/deals/${dealId}`,
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
          }, { properties: { payment_status: 'paid' } });
          console.log(`[invoice-webhook] deal ${dealId} payment_status → paid`);
        } catch(e) { console.warn('[invoice-webhook] deal update failed:', e.message); }

        // Create internal notification for the deal's rep
        try {
          const dealRes = await httpsRequest({
            hostname: 'api.hubapi.com',
            path: `/crm/v3/objects/deals/${dealId}?properties=dealname,hubspot_owner_id,amount`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
          });
          const dp = dealRes.body?.properties || {};
          const ownerId = dp.hubspot_owner_id;
          const dealName = dp.dealname || `Deal ${dealId}`;
          const amount = dp.amount ? '$' + parseFloat(dp.amount).toLocaleString('en-US', {minimumFractionDigits:0,maximumFractionDigits:0}) : '';
          if (ownerId) {
            await notifyRep(
              ownerId,
              `💰 Invoice Paid — ${dealName}`,
              `Payment received${amount ? ' · ' + amount : ''}. Deal marked Paid.`,
              { type: 'invoice_paid', dealId, dealName }
            );
          }
        } catch(e) { console.warn('[invoice-webhook] notify failed:', e.message); }
      }
    } catch(e) {
      console.warn('[invoice-webhook] error:', e.message);
    }
    return;
  }

  // ── API: Check if contact has existing Drive folder ───────────────
  if (pathname === '/api/drive/contact-folder' && req.method === 'GET') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    const contactId = parsed.query.contactId;
    if (!contactId || !db) { json({ folderId: null }); return; }
    try {
      const row = await db.query(
        'SELECT gdrive_folder_id, deal_name, company FROM quotes WHERE contact_id = $1 AND gdrive_folder_id IS NOT NULL ORDER BY created_at DESC LIMIT 1',
        [String(contactId)]
      );
      if (!row.rows[0]) { json({ folderId: null }); return; }
      const { gdrive_folder_id, deal_name, company } = row.rows[0];
      const folderName = company || deal_name?.replace(/\s*[·—\-–]\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s*$/i, '').trim() || '';
      json({ folderId: gdrive_folder_id, folderName });
    } catch(e) { json({ folderId: null }); }
    return;
  }

  // ── API: Search Google Drive folders ─────────────────────────────
  if (pathname === '/api/drive/search-folders' && req.method === 'GET') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    const q = (parsed.query.q || '').trim();
    if (!q || q.length < 2) { json({ folders: [] }); return; }
    try {
      const token = await getGDriveToken();
      if (!token) { json({ error: 'Drive not configured' }, 500); return; }
      const query = encodeURIComponent(
        `name contains '${q.replace(/'/g,"\\'")}' and '${GDRIVE_ROOT_FOLDER}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
      );
      const res2 = await httpsRequest({
        hostname: 'www.googleapis.com',
        path: `/drive/v3/files?q=${query}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives&pageSize=20`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const folders = (res2.body?.files || []).map(f => ({ id: f.id, name: f.name }));
      json({ folders });
    } catch(e) { json({ error: e.message }, 500); }
    return;
  }

  // ── API: Bind existing Drive folder to a deal/contact ────────────
  if (pathname === '/api/drive/bind-folder' && req.method === 'POST') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    try {
      const { quoteNumber, folderId } = JSON.parse(await readBody(req));
      if (!quoteNumber || !folderId) { json({ error: 'Missing quoteNumber or folderId' }, 400); return; }
      if (!db) { json({ error: 'No database' }, 500); return; }
      await db.query('UPDATE quotes SET gdrive_folder_id = $1 WHERE quote_number = $2', [folderId, quoteNumber]);
      console.log(`[drive] bound folder ${folderId} to quote ${quoteNumber}`);
      json({ success: true });
    } catch(e) { json({ error: e.message }, 500); }
    return;
  }

  // ── API: Scan Orders folder for files matching a company name ─────
  if (pathname === '/api/drive/scan-orders' && req.method === 'POST') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    try {
      const { quoteNumber, company } = JSON.parse(await readBody(req));
      if (!company) { json({ files: [], destFolderId: null, destFolderName: null }); return; }

      // Normalize company name for matching
      const normalize = s => s.toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
      const needle = normalize(company);
      if (needle.length < 4) { json({ files: [], destFolderId: null, destFolderName: null }); return; }

      // Get dest folder ID from DB
      let destFolderId = null, destFolderName = null;
      if (db && quoteNumber) {
        const row = await db.query('SELECT gdrive_folder_id, company, deal_name FROM quotes WHERE quote_number = $1 LIMIT 1', [quoteNumber]);
        destFolderId   = row.rows[0]?.gdrive_folder_id || null;
        destFolderName = row.rows[0]?.company || row.rows[0]?.deal_name || company;
      }

      // List files in the shared Orders folder
      const token = await getGDriveToken();
      if (!token) { json({ error: 'Drive not configured' }, 500); return; }
      const listRes = await httpsRequest({
        hostname: 'www.googleapis.com',
        path: `/drive/v3/files?q=${encodeURIComponent(`'${SHARED_ORDERS_FOLDER}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`)}&fields=files(id,name,mimeType,size)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=200`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const allFiles = listRes.body?.files || [];

      // Filter to files whose name contains the company name
      const matches = allFiles.filter(f => normalize(f.name).includes(needle));

      if (allFiles.length > 0 && matches.length === 0) {
        console.warn(`[scan-orders] No match for "${needle}" among ${allFiles.length} files. Sample names:`, allFiles.slice(0,3).map(f => f.name));
      }
      console.log(`[scan-orders] quote=${quoteNumber} company="\" — ${allFiles.length} total files, ${matches.length} matches, destFolder=${destFolderId||'none'}`);

      json({ files: matches, destFolderId, destFolderName });
    } catch(e) {
      console.warn('[scan-orders] error:', e.message);
      json({ error: e.message }, 500);
    }
    return;
  }

  // ── API: Copy files from Orders folder to contact folder ─────────
  // Uses copy+delete instead of re-parent PATCH — Contributor access on Shared Drives
  // allows copying but not re-parenting. Delete is attempted but non-fatal.
  if (pathname === '/api/drive/move-order-files' && req.method === 'POST') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    try {
      const { fileIds, destFolderId, quoteNumber } = JSON.parse(await readBody(req));
      if (!fileIds?.length || !destFolderId) { json({ error: 'Missing fileIds or destFolderId' }, 400); return; }

      const token = await getGDriveToken();
      if (!token) { json({ error: 'Drive not configured' }, 500); return; }

      const results = [];
      for (const fileId of fileIds) {
        try {
          // Reparent: move from Orders folder to contact folder in one API call
          // No delete permission needed — just moves the file's parent
          const moveRes = await httpsRequest({
            hostname: 'www.googleapis.com',
            path: `/drive/v3/files/${fileId}?addParents=${destFolderId}&removeParents=${SHARED_ORDERS_FOLDER}&supportsAllDrives=true&fields=id,name`,
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
          }, {});

          if (moveRes.body?.error) {
            console.warn(`[move-order-files] Reparent failed for ${fileId}:`, JSON.stringify(moveRes.body.error));
            results.push({ id: fileId, success: false, error: moveRes.body.error.message });
            continue;
          }

          const movedName = moveRes.body?.name || fileId;
          console.log(`[move-order-files] Moved "${movedName}" → contact folder ${destFolderId}`);
          results.push({ id: fileId, name: movedName, success: true });
        } catch(e) {
          console.warn(`[move-order-files] Error on file ${fileId}:`, e.message);
          results.push({ id: fileId, success: false, error: e.message });
        }
      }

      const moved = results.filter(r => r.success).map(r => r.name);
      const failed = results.filter(r => !r.success);
      writelog('info', 'order.files.moved', `Moved ${moved.length} file(s) to contact folder`, { quoteNum: quoteNumber, meta: { files: moved, destFolderId } });
      if (failed.length) writelog('error', 'error.gdrive', `Failed to move ${failed.length} file(s)`, { quoteNum: quoteNumber, meta: { failed } });

      json({ success: true, moved, failed });
    } catch(e) {
      console.warn('[move-order-files] error:', e.message);
      json({ error: e.message }, 500);
    }
    return;
  }

  // ── Admin: Rename Drive folders to company-name format ────────
  // ── API: Rename Deal ─────────────────────────────────────────────
  if (pathname === '/api/rename-deal' && req.method === 'POST') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    try {
      const { dealId, newName } = JSON.parse(await readBody(req));
      if (!dealId || !newName) { json({ error: 'Missing dealId or newName' }, 400); return; }

      // 1. Update deal name in HubSpot
      await httpsRequest({
        hostname: 'api.hubapi.com',
        path: `/crm/v3/objects/deals/${dealId}`,
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
      }, { properties: { dealname: newName } });

      // 2. Update all quotes in DB with this deal_id
      let oldName = null;
      let folderId = null;
      if (db) {
        const row = await db.query(
          `SELECT deal_name, gdrive_folder_id FROM quotes WHERE deal_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [dealId]
        );
        oldName  = row.rows[0]?.deal_name  || null;
        folderId = row.rows[0]?.gdrive_folder_id || null;
        await db.query(`UPDATE quotes SET deal_name = $1 WHERE deal_id = $2`, [newName, dealId]);
      }

      // 3. Rename Google Drive folder
      let driveRenamed = false;
      if (folderId) {
        try {
          const newFolderName = getCompanyFolderName(newName, '').replace(/[/\\:*?"<>|]/g, '-').trim();
          await gdriveRenameFolder(folderId, newFolderName);
          driveRenamed = true;
          console.log(`[rename-deal] Drive folder renamed: "${oldName}" → "${newFolderName}"`);
        } catch(e) { console.warn('[rename-deal] Drive rename failed:', e.message); }
      }

      writelog('info', 'deal.renamed', `Deal renamed: "${oldName}" → "${newName}"`, { dealId: String(dealId), dealName: newName });
      console.log(`[rename-deal] ${dealId}: "${oldName}" → "${newName}" drive=${driveRenamed}`);
      json({ success: true, driveRenamed });
    } catch(e) {
      writelog('error', 'error.rename-deal', `rename-deal failed: ${e.message}`, { rep: getRepFromReq(req) });
      json({ error: e.message }, 500);
    }
    return;
  }

  if (pathname === '/api/admin/rename-drive-folders' && req.method === 'POST') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    try {
      if (!db) { json({ error: 'No database' }, 500); return; }

      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch(e) {}
      const urlParams = new URLSearchParams(req.url.includes('?') ? req.url.split('?')[1] : '');
      const dryRun = urlParams.get('dryRun') === 'true' || body.dryRun === true;

      // Get all quotes that have a gdrive_folder_id
      const rows = await db.query(`
        SELECT DISTINCT ON (gdrive_folder_id)
          gdrive_folder_id, deal_name, company, customer_name,
          json_snapshot->>'dealName' as snap_deal_name,
          json_snapshot->'customer'->>'company' as snap_company
        FROM quotes
        WHERE gdrive_folder_id IS NOT NULL
        ORDER BY gdrive_folder_id, created_at DESC
      `);

      const results = { dryRun, renamed: [], skipped: [], errors: [] };

      for (const row of rows.rows) {
        const folderId = row.gdrive_folder_id;
        const dealName  = row.snap_deal_name || row.deal_name || '';
        const company   = row.snap_company   || row.company   || '';

        const newName = getCompanyFolderName(dealName, company)
          .replace(/[/\:*?"<>|]/g, '-').trim();

        if (!newName) { results.skipped.push({ folderId, reason: 'no name' }); continue; }

        try {
          // Get current folder name from Drive to check if rename needed
          const current = await gdriveRequest('GET', `/drive/v3/files/${folderId}?fields=name&supportsAllDrives=true`);
          const currentName = current?.name || '';

          if (currentName === newName) {
            results.skipped.push({ folderId, name: currentName, reason: 'already correct' });
            continue;
          }

          if (dryRun) {
            // Dry run — report what would happen, don't actually rename
            results.renamed.push({ folderId, from: currentName, to: newName, dryRun: true });
          } else {
            await gdriveRenameFolder(folderId, newName);
            console.log(`[rename-folders] "${currentName}" → "${newName}"`);
            results.renamed.push({ folderId, from: currentName, to: newName });
          }
        } catch(e) {
          results.errors.push({ folderId, error: e.message });
        }
      }

      json({ success: true, ...results, total: rows.rows.length });
    } catch(e) {
      json({ error: e.message }, 500);
    }
    return;
  }

  // ── Admin: Strip date suffix from deal names (one-time + ongoing) ──
  if (pathname === '/api/admin/strip-deal-date-suffixes' && req.method === 'POST') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    try {
      const urlParams = new URLSearchParams(req.url.includes('?') ? req.url.split('?')[1] : '');
      const dryRun = urlParams.get('dryRun') === 'true';

      // Find all DB deals where deal_name matches "Name - Mon YYYY" or "Name · Mon YYYY"
      const DATE_SUFFIX = /\s*[·—\-–]\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s*$/i;

      const rows = await db.query(`
        SELECT DISTINCT ON (deal_id) deal_id, deal_name
        FROM quotes
        WHERE deal_id IS NOT NULL
          AND deal_name ~ '[·—\\-–]\\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+[0-9]{4}'
        ORDER BY deal_id, created_at DESC
      `);

      const results = { dryRun, renamed: [], skipped: [], errors: [], total: rows.rows.length };

      for (const row of rows.rows) {
        const oldName = row.deal_name || '';
        const newName = oldName.replace(DATE_SUFFIX, '').trim();

        if (!newName || newName === oldName) {
          results.skipped.push({ dealId: row.deal_id, name: oldName, reason: 'no change' });
          continue;
        }

        if (dryRun) {
          results.renamed.push({ dealId: row.deal_id, from: oldName, to: newName, dryRun: true });
          continue;
        }

        try {
          // Update HubSpot
          await httpsRequest({
            hostname: 'api.hubapi.com',
            path: `/crm/v3/objects/deals/${row.deal_id}`,
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
          }, { properties: { dealname: newName } });
          // Update DB
          await db.query(`UPDATE quotes SET deal_name = $1 WHERE deal_id = $2`, [newName, row.deal_id]);
          console.log(`[strip-deal-dates] "${oldName}" → "${newName}"`);
          results.renamed.push({ dealId: row.deal_id, from: oldName, to: newName });
        } catch(e) {
          results.errors.push({ dealId: row.deal_id, name: oldName, error: e.message });
        }
      }

      json({ success: true, ...results });
    } catch(e) {
      json({ error: e.message }, 500);
    }
    return;
  }

  // ── Drive: Search AllContacts for legacy folder by name ──────────
  if (pathname === '/api/drive/search-legacy-folder' && req.method === 'GET') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    try {
      const urlParams = new URLSearchParams(req.url.includes('?') ? req.url.split('?')[1] : '');
      const q = (urlParams.get('q') || '').trim();
      if (!q) { json({ error: 'Missing q' }, 400); return; }

      // Search for folders in AllContacts root whose name contains the query (case-insensitive)
      const escaped = q.replace(/\\/g, '').replace(/'/g, "\\'");
      const driveQ = `mimeType='application/vnd.google-apps.folder' and '${GDRIVE_ROOT_FOLDER}' in parents and name contains '${escaped}' and trashed=false`;
      const searchRes = await gdriveRequest('GET',
        `/drive/v3/files?q=${encodeURIComponent(driveQ)}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`
      );

      const folders = (searchRes?.files || []).map(f => ({ id: f.id, name: f.name }));
      json({ success: true, folders });
    } catch(e) {
      json({ error: e.message }, 500);
    }
    return;
  }

  // ── Drive: Merge legacy folder into deal folder ──────────────────
  if (pathname === '/api/drive/merge-legacy-folder' && req.method === 'POST') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    try {
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch(e) {}
      const { legacyFolderId, quoteNumber, dealName, companyName } = body;

      if (!legacyFolderId) { json({ error: 'Missing legacyFolderId' }, 400); return; }
      if (!quoteNumber && !dealName) { json({ error: 'Missing quoteNumber or dealName' }, 400); return; }

      // Step 1: Ensure deal folder exists (creates if needed, returns existing if found)
      let dealFolderId = null;
      if (quoteNumber) {
        const qRow = await db.query(`SELECT gdrive_folder_id FROM quotes WHERE quote_number = $1 LIMIT 1`, [quoteNumber]);
        dealFolderId = qRow.rows[0]?.gdrive_folder_id || null;
      }

      if (!dealFolderId) {
        // Create/find the deal folder
        const folderName = getCompanyFolderName(dealName || quoteNumber, companyName || '').replace(/[/\\:*?"<>|]/g, '-').trim();
        const dealFolder = await gdriveEnsureFolder(folderName, GDRIVE_ROOT_FOLDER);
        dealFolderId = dealFolder?.id;
        if (!dealFolderId) throw new Error('Could not create or find deal folder');
        // Save back to DB if we have a quote number
        if (quoteNumber) {
          await db.query(`UPDATE quotes SET gdrive_folder_id = $1 WHERE quote_number = $2`, [dealFolderId, quoteNumber]);
        }
      }

      // Step 2: List all files in legacy folder
      const listQ = `'${legacyFolderId}' in parents and trashed=false`;
      const listRes = await gdriveRequest('GET',
        `/drive/v3/files?q=${encodeURIComponent(listQ)}&fields=files(id,name,mimeType)&supportsAllDrives=true&includeItemsFromAllDrives=true`
      );
      const files = listRes?.files || [];

      if (!files.length) {
        // Nothing to move — just delete the empty folder
        await gdriveRequest('DELETE', `/drive/v3/files/${legacyFolderId}?supportsAllDrives=true`);
        json({ success: true, moved: 0, message: 'Legacy folder was empty — deleted.' });
        return;
      }

      // Step 3: Move each file to deal folder
      let moved = 0;
      const errors = [];
      for (const file of files) {
        try {
          await gdriveRequest('PATCH',
            `/drive/v3/files/${file.id}?addParents=${dealFolderId}&removeParents=${legacyFolderId}&supportsAllDrives=true&fields=id`,
            {}
          );
          moved++;
        } catch(e) {
          errors.push({ name: file.name, error: e.message });
        }
      }

      // Step 4: Delete legacy folder if all moved successfully
      if (errors.length === 0) {
        try {
          // Use PATCH to trash the folder — more reliable than DELETE for shared drives
          await gdriveRequest('PATCH',
            `/drive/v3/files/${legacyFolderId}?supportsAllDrives=true&fields=id`,
            { trashed: true }
          );
          console.log(`[merge-legacy] Trashed legacy folder ${legacyFolderId}`);
        } catch(e) {
          console.warn('[merge-legacy] Could not trash legacy folder:', e.message);
        }
      }

      json({ success: true, moved, errors, dealFolderId, message: `Moved ${moved} item${moved!==1?'s':''} to deal folder.${errors.length?' Some errors occurred.':''}` });
    } catch(e) {
      json({ error: e.message }, 500);
    }
    return;
  }

  // ── Admin: Backfill tracking numbers via contact email lookup ────
  if (pathname === '/api/admin/backfill-tracking' && req.method === 'POST') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    // Fire and forget — return immediately, run in background
    json({ success: true, message: 'Backfill started in background. Check /api/admin/backfill-status for progress.' });
    try {
      // Map: customer email → tracking number + carrier
      const emailToTracking = {
  "timothy.j.masi@us.mcd.com": { tracking: "78077872246", carrier: "OD" },
  "jon.olivier@grainger.com": { tracking: "248007092", carrier: "ABF" },
  "nedad@wardenwoods.com": { tracking: "248007097", carrier: "ABF" },
  "michael.yanez@microsoft.com": { tracking: "248007084", carrier: "ABF" },
  "catherine.massengale@ttu.edu": { tracking: "78078696057", carrier: "OD" },
  "jcortner@missionmobilemed.com": { tracking: "78078524150", carrier: "OD" },
  "riley.w@hellohearingstudios.com": { tracking: "78078713803", carrier: "OD" },
  "admin@kavnhealth.com": { tracking: "248006552", carrier: "ABF" },
  "noahstern00@gmail.com": { tracking: "78078096381", carrier: "OD" },
  "macguarnieri@aol.com": { tracking: "248007091", carrier: "ABF" },
  "realminseok@hotmail.com": { tracking: "248859712", carrier: "OD" },
  "jperez2@bartonhealth.org": { tracking: "248007093", carrier: "ABF" },
  "brady.lorenzen@mayo.edu": { tracking: "248006553", carrier: "ABF" },
  "nathan@tshmt.com": { tracking: "78078144215", carrier: "OD" },
  "randall.turner@morrisjenkins.com": { tracking: "78078494438", carrier: "OD" },
  "vo@jordankilgore.com": { tracking: "248007081", carrier: "ABF" },
  "drapp@offscriptsociety.com": { tracking: "248007098", carrier: "ABF" },
  "jill@digitalvideogroup.com": { tracking: "78077745905", carrier: "OD" },
  "fmaurer@midjourney.com": { tracking: "248007064", carrier: "ABF" },
  "clint.rollett@rd.nestle.com": { tracking: "78076246681", carrier: "OD" },
  "ousteventhomas@gmail.com": { tracking: "78077656458", carrier: "OD" },
  "emovshin@unitedhearing.com": { tracking: "78076411889", carrier: "OD" },
  "mflan25@gmail.com": { tracking: "248007072", carrier: "ABF" },
  "sara.frazier@donegalsd.org": { tracking: "248007076", carrier: "ABF" },
  "drnnenna@reenglobalhealth.com": { tracking: "78076484027", carrier: "OD" },
  "igor@fortell.com": { tracking: "80999169362", carrier: "OD" },
  "raybrown742@gmail.com": { tracking: "78077495626", carrier: "OD" },
  "noah.malone@mannasupply.com": { tracking: "248007054", carrier: "ABF" },
  "robert.mentzer.contractor@pepsico.com": { tracking: "248007055", carrier: "ABF" },
  "nspann@whisperroomguys.com": { tracking: "248890542", carrier: "ABF" },
  "garrett.kenehan@chaffey.edu": { tracking: "248007077", carrier: "ABF" },
  "t.peterson@asu.edu": { tracking: "78077484554", carrier: "OD" },
  "adavidson@nmrevents.com": { tracking: "248007075", carrier: "ABF" },
  "rvanormer@ithacavoice.org": { tracking: "248006856", carrier: "ABF" },
  "dmgray@oxfordsc.org": { tracking: "78076726732", carrier: "OD" },
  "aminidmaynard@state.gov": { tracking: "78076884051", carrier: "OD" },
  "heather_lydon@baxter.com": { tracking: "248007059", carrier: "ABF" },
  "kelly.zimbelman@unlv.edu": { tracking: "78077248041", carrier: "OD" },
  "emounts@modernhearing.net": { tracking: "248007065", carrier: "ABF" },
  "ktr.adams@gmail.com": { tracking: "78077570642", carrier: "OD" },
  "margaret.keating@audionova.com": { tracking: "248890538", carrier: "ABF" },
  "coastalhearingcenter@yahoo.com": { tracking: "78076256086", carrier: "OD" }
};

      // Run all lookups in parallel (5 at a time to avoid rate limits)
      async function processOne(customerEmail, info) {
        try {
          const contactSearch = await httpsRequest({
            hostname: 'api.hubapi.com',
            path: '/crm/v3/objects/contacts/search',
            method: 'POST',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
          }, {
            filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: customerEmail }] }],
            properties: ['email'], limit: 1
          });
          const contacts = contactSearch.body?.results || [];
          if (!contacts.length) return { email: customerEmail, skipped: 'contact not found' };
          const contactId = contacts[0].id;

          const dealSearch = await httpsRequest({
            hostname: 'api.hubapi.com',
            path: '/crm/v3/objects/deals/search',
            method: 'POST',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
          }, {
            filterGroups: [{
              filters: [{ propertyName: 'dealstage', operator: 'EQ', value: '845719' }],
              associatedWith: [{ objectType: 'contacts', operator: 'EQUAL', objectIdValues: [parseInt(contactId)] }]
            }],
            properties: ['dealname', 'tracking_number'],
            sorts: [{ propertyName: 'closedate', direction: 'DESCENDING' }], limit: 1
          });
          const deals = dealSearch.body?.results || [];
          if (!deals.length) return { email: customerEmail, contactId, skipped: 'no shipped deal' };
          const deal = deals[0];
          if (deal.properties?.tracking_number) return { email: customerEmail, dealId: deal.id, skipped: 'already has tracking: ' + deal.properties.tracking_number };

          await httpsRequest({
            hostname: 'api.hubapi.com',
            path: `/crm/v3/objects/deals/${deal.id}`,
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
          }, { properties: { tracking_number: info.tracking, freight_carrier: info.carrier } });
          return { email: customerEmail, dealId: deal.id, tracking: info.tracking, carrier: info.carrier, success: true };
        } catch(e) { return { email: customerEmail, error: e.message }; }
      }

      // Run in parallel batches of 8
      const entries = Object.entries(emailToTracking);
      const results = [];
      for (let i = 0; i < entries.length; i += 8) {
        const batch = entries.slice(i, i + 8);
        const batchResults = await Promise.all(batch.map(([email, info]) => processOne(email, info)));
        results.push(...batchResults);
      }

      const written = results.filter(r => r.success).length;
      const skipped = results.filter(r => r.skipped).length;
      const errors  = results.filter(r => r.error).length;
      global._backfillStatus = { done: true, total: entries.length, written, skipped, errors, results };
      console.log(`Backfill complete: ${written} written, ${skipped} skipped, ${errors} errors`);
    } catch(e) {
      global._backfillStatus = { done: true, error: e.message };
      console.error('Backfill error:', e.message);
    }
    return;
  }

  // ── Admin: Backfill status ────────────────────────────────────────
  if (pathname === '/api/admin/backfill-status' && req.method === 'GET') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    json(global._backfillStatus || { done: false, message: 'Not started or still running' });
    return;
  }


  // ── API: Search Closed Won deals (for Add Shipment modal) ────────
  if (pathname === '/api/deals/closed-won' && req.method === 'GET') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    try {
      const q = parsed.query.q || '';
      // Build request body — filter by stage always, optionally add text search
      const reqBody = {
        filterGroups: [{
          filters: [{ propertyName: 'dealstage', operator: 'EQ', value: 'closedwon' }]
        }],
        properties: ['dealname', 'amount', 'hubspot_owner_id'],
        sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
        limit: 100
      };
      if (q.trim().length >= 2) reqBody.query = q.trim();

      const searchRes = await httpsRequest({
        hostname: 'api.hubapi.com',
        path: '/crm/v3/objects/deals/search',
        method: 'POST',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
      }, reqBody);

      const results = (searchRes.body.results || []).map(d => ({
        id: d.id,
        name: d.properties.dealname || 'Untitled',
        amount: d.properties.amount || null,
        ownerId: d.properties.hubspot_owner_id || null,
      }));
      json({ results });
    } catch(e) { json({ error: e.message }, 500); }
    return;
  }

  // ── API: Ship Deal (from Add Shipment modal) ─────────────────────
  if (pathname === '/api/ship-deal' && req.method === 'POST') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    try {
      const body = JSON.parse(await readBody(req));
      const { dealId, carrier, tracking, dateShipped } = body;
      if (!dealId || !carrier || !tracking) {
        json({ error: 'Missing required fields' }, 400); return;
      }

      // 1. Patch deal: set tracking, carrier, date_shipped, advance stage to Shipped
      await httpsRequest({
        hostname: 'api.hubapi.com',
        path: `/crm/v3/objects/deals/${dealId}`,
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
      }, {
        properties: {
          tracking_number: tracking,
          freight_carrier: carrier,
          date_shipped: dateShipped || new Date().toISOString().split('T')[0],
          dealstage: '845719'  // Shipped
        }
      });

      // Seed tracking cache immediately so shipping board shows status on next load
      fetchAndCacheTracking(tracking, carrier).catch(e => console.warn('[ship-deal] cache seed failed:', e.message));

      json({ success: true });
    writelog('error','error.ship-deal',`ship-deal failed: ${e.message}`,{ rep: getRepFromReq(req) });
    } catch(e) { json({ error: e.message }, 500); }
    return;
  }


  // ── API: Get invoices for a deal ──────────────────────────────────
  if (pathname.startsWith('/api/deals/') && pathname.endsWith('/invoices') && req.method === 'GET') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    const dealId = pathname.split('/')[3];
    try {
      // Get invoice associations from HubSpot
      const assocRes = await httpsRequest({
        hostname: 'api.hubapi.com',
        path: `/crm/v4/objects/deals/${dealId}/associations/invoices`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
      });
      console.log(`[deal invoices] deal ${dealId} assoc status:`, assocRes?.status, 'results:', assocRes?.body?.results?.length);
      const invoiceIds = (assocRes?.body?.results || []).map(r => r.toObjectId);
      if (!invoiceIds.length) { json({ invoices: [] }); return; }

      // Batch fetch invoice details
      const batchRes = await httpsRequest({
        hostname: 'api.hubapi.com',
        path: '/crm/v3/objects/invoices/batch/read',
        method: 'POST',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
      }, {
        inputs: invoiceIds.map(id => ({ id: String(id) })),
        properties: ['hs_invoice_status','hs_due_date','hs_invoice_date','hs_number','hs_title','hs_amount_billed','hs_balance_due','hs_hubspot_invoice_link','quote_number']
      });

      const invoices = (batchRes?.body?.results || []).map(inv => ({
        id: inv.id,
        status:     inv.properties?.hs_invoice_status || 'draft',
        number:     inv.properties?.hs_number || '',
        title:      inv.properties?.hs_title || '',
        date:       inv.properties?.hs_invoice_date || '',
        dueDate:    inv.properties?.hs_due_date || '',
        amount:     inv.properties?.hs_amount_billed || '0',
        balance:    inv.properties?.hs_balance_due || '0',
        invoiceUrl: inv.properties?.hs_hubspot_invoice_link || null,
        quoteNumber: inv.properties?.quote_number || '',
      }));

      // Also check our DB for payment_link / invoice page URL
      if (db) {
        const dbRows = await db.query(
          'SELECT quote_number, payment_link, share_token FROM quotes WHERE deal_id = $1 AND payment_link IS NOT NULL',
          [dealId]
        );
        dbRows.rows.forEach(row => {
          const match = invoices.find(i => i.quoteNumber === row.quote_number);
          const invoicePage = row.quote_number && row.share_token
            ? `https://sales.whisperroom.com/i/${row.quote_number}?t=${row.share_token}`
            : row.payment_link;
          if (match) match.paymentPageUrl = invoicePage;
        });
        if (invoices.length === 1 && !invoices[0].paymentPageUrl && dbRows.rows.length > 0) {
          const row = dbRows.rows[0];
          invoices[0].paymentPageUrl = row.quote_number && row.share_token
            ? `https://sales.whisperroom.com/i/${row.quote_number}?t=${row.share_token}`
            : row.payment_link;
        }
      }

      console.log(`[deal invoices] returning ${invoices.length} invoices for deal ${dealId}`);
      json({ invoices });
    } catch(e) {
      console.error('Get deal invoices error:', e.message);
      json({ error: e.message }, 500);
    }
    return;
  }


  // ── API: Update deal payment status ──────────────────────────────
  if (pathname.startsWith('/api/deals/') && pathname.endsWith('/payment-status') && req.method === 'PATCH') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    const dealId = pathname.split('/')[3];
    try {
      const { status } = JSON.parse(await readBody(req));
      await httpsRequest({
        hostname: 'api.hubapi.com',
        path: `/crm/v3/objects/deals/${dealId}`,
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
      }, { properties: { payment_status: status } });

      // Notify rep on payment
      if (status === 'paid' || status === 'po_received') {
        try {
          const dealRes = await httpsRequest({
            hostname: 'api.hubapi.com',
            path: `/crm/v3/objects/deals/${dealId}?properties=hubspot_owner_id,dealname`,
            method: 'GET', headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
          });
          const ownerId  = dealRes.body?.properties?.hubspot_owner_id;
          const dealName = dealRes.body?.properties?.dealname || dealId;
          const statusLabel = status === 'paid' ? '💰 Payment Received' : '📄 PO Received';
          await notifyRep(ownerId, `${statusLabel} — ${dealName}`,
            `${dealName} has been marked as ${status === 'paid' ? 'paid' : 'PO received'}.`,
            { type: 'payment', dealId, dealName }
          );
        } catch(e) { /* non-fatal */ }
      }

      json({ success: true, status });
    } catch(e) {
      json({ error: e.message }, 500);
    }
    return;
  }

  // ── API: Update deal stage ────────────────────────────────────────
  if (pathname.startsWith('/api/deals/') && pathname.endsWith('/stage') && req.method === 'PATCH') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    const dealId = pathname.split('/')[3];
    try {
      const { stage } = JSON.parse(await readBody(req));
      await httpsRequest({
        hostname: 'api.hubapi.com',
        path: `/crm/v3/objects/deals/${dealId}`,
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
      }, { properties: { dealstage: stage } });
      json({ success: true, stage });
    } catch(e) {
      json({ error: e.message }, 500);
    }
    return;
  }


  // ── API: Reports data ────────────────────────────────────────────
  if (pathname === '/api/reports' && req.method === 'GET') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    try {
      const period = parsed.query.period || '30';
      const days   = parseInt(period);
      const since  = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const nowEST = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
      const thisMonthStart = (() => {
        const d = new Date(); d.setDate(1); d.setHours(0,0,0,0); return d.toISOString();
      })();

      const report = {};

      if (db) {
        // ── All quotes in period ──────────────────────────────────
        const qAll = await db.query(
          `SELECT quote_number, rep_id, total, created_at, company, deal_name, deal_id,
                  (json_snapshot->>'accepted')::text            as accepted,
                  (json_snapshot->>'acceptedAt')::text          as accepted_at,
                  json_snapshot->'lineItems'                    as line_items,
                  json_snapshot->'customer'                     as customer,
                  json_snapshot->'freight'                      as freight
           FROM quotes WHERE created_at >= $1 ORDER BY created_at DESC`,
          [since]
        );
        const quotes = qAll.rows;

        // ── All-time quote base ───────────────────────────────────
        const qAllTime = await db.query(
          `SELECT quote_number, rep_id, total, created_at, company, deal_id,
                  (json_snapshot->>'accepted')::text as accepted,
                  (json_snapshot->>'acceptedAt')::text as accepted_at,
                  json_snapshot->'customer' as customer
           FROM quotes ORDER BY created_at ASC`
        );

        // ── Basic quote stats ─────────────────────────────────────
        report.quotes = {
          total:      quotes.length,
          totalValue: quotes.reduce((s,q) => s + parseFloat(q.total||0), 0),
          accepted:   quotes.filter(q => q.accepted==='true').length,
          acceptRate: quotes.length ? Math.round(quotes.filter(q=>q.accepted==='true').length/quotes.length*100) : 0,
          byRep:      {},
          recentList: quotes.slice(0,25).map(q => ({
            quoteNumber: q.quote_number,
            dealName:    q.deal_name || q.company || '—',
            rep:         REPS[q.rep_id] || '—',
            total:       parseFloat(q.total||0),
            accepted:    q.accepted==='true',
            date:        q.created_at,
          })),
        };
        quotes.forEach(q => {
          const rep = REPS[q.rep_id]||'Unknown';
          if (!report.quotes.byRep[rep]) report.quotes.byRep[rep] = {count:0,value:0,accepted:0};
          report.quotes.byRep[rep].count++;
          report.quotes.byRep[rep].value += parseFloat(q.total||0);
          if (q.accepted==='true') report.quotes.byRep[rep].accepted++;
        });

        // ── Rep leaderboard — this month ─────────────────────────
        const qMonth = await db.query(
          `SELECT rep_id, total, (json_snapshot->>'accepted')::text as accepted
           FROM quotes WHERE created_at >= $1`,
          [thisMonthStart]
        );
        const leaderboard = {};
        qMonth.rows.forEach(q => {
          const rep = REPS[q.rep_id]||'Unknown';
          if (!leaderboard[rep]) leaderboard[rep] = {quoted:0,quotedVal:0,accepted:0,acceptedVal:0};
          leaderboard[rep].quoted++;
          leaderboard[rep].quotedVal += parseFloat(q.total||0);
          if (q.accepted==='true') { leaderboard[rep].accepted++; leaderboard[rep].acceptedVal += parseFloat(q.total||0); }
        });
        report.leaderboard = Object.entries(leaderboard)
          .sort((a,b) => b[1].acceptedVal - a[1].acceptedVal)
          .map(([rep,d],i) => ({ rank:i+1, rep, ...d }));

        // ── Sales velocity ────────────────────────────────────────
        // quote sent → accepted
        const velocityData = [];
        qAllTime.rows.forEach(q => {
          if (q.accepted==='true' && q.accepted_at && q.created_at) {
            const daysToAccept = (new Date(q.accepted_at) - new Date(q.created_at)) / (1000*60*60*24);
            if (daysToAccept >= 0 && daysToAccept < 180) velocityData.push(daysToAccept);
          }
        });
        const avgVelocity = velocityData.length
          ? Math.round(velocityData.reduce((s,d)=>s+d,0) / velocityData.length * 10) / 10
          : null;

        // ── Quote revision analysis ───────────────────────────────
        const dealQuoteCounts = {};
        qAllTime.rows.forEach(q => {
          if (q.deal_id) {
            if (!dealQuoteCounts[q.deal_id]) dealQuoteCounts[q.deal_id] = {count:0,accepted:false,value:0};
            dealQuoteCounts[q.deal_id].count++;
            if (q.accepted==='true') dealQuoteCounts[q.deal_id].accepted = true;
            dealQuoteCounts[q.deal_id].value = Math.max(dealQuoteCounts[q.deal_id].value, parseFloat(q.total||0));
          }
        });
        const dealCounts = Object.values(dealQuoteCounts);
        const singleQuoteDeals = dealCounts.filter(d=>d.count===1).length;
        const multiQuoteDeals  = dealCounts.filter(d=>d.count>=2).length;
        const avgQuotesPerDeal = dealCounts.length
          ? Math.round(dealCounts.reduce((s,d)=>s+d.count,0)/dealCounts.length*10)/10
          : null;
        const revisionAcceptRate = multiQuoteDeals
          ? Math.round(dealCounts.filter(d=>d.count>=2&&d.accepted).length/multiQuoteDeals*100)
          : null;
        const singleAcceptRate = singleQuoteDeals
          ? Math.round(dealCounts.filter(d=>d.count===1&&d.accepted).length/singleQuoteDeals*100)
          : null;
        report.revisions = {
          totalDeals: dealCounts.length,
          singleQuote: singleQuoteDeals,
          multiQuote: multiQuoteDeals,
          avgQuotesPerDeal,
          revisionAcceptRate,
          singleAcceptRate,
          distribution: [1,2,3,4,5].map(n => ({
            count: n,
            label: n===5?'5+':''+n,
            deals: n===5 ? dealCounts.filter(d=>d.count>=5).length : dealCounts.filter(d=>d.count===n).length,
          })),
        };

        // ── Product mix ───────────────────────────────────────────
        const productCounts = {}, modelCounts = {}, seCounts = {S:0,E:0,Other:0};
        quotes.forEach(q => {
          try {
            const items = q.line_items||[];
            items.forEach(item => {
              if (!item?.name) return;
              const name = item.name;
              const qty  = parseInt(item.qty||1);
              if (!productCounts[name]) productCounts[name] = {count:0,revenue:0};
              productCounts[name].count   += qty;
              productCounts[name].revenue += parseFloat(item.price||0)*qty;
              // MDL model tracking
              if (name.startsWith('MDL')) {
                const model = name.split(' ').slice(0,2).join(' ');
                if (!modelCounts[model]) modelCounts[model] = {count:0,revenue:0};
                modelCounts[model].count   += qty;
                modelCounts[model].revenue += parseFloat(item.price||0)*qty;
                if (name.endsWith(' S'))      seCounts.S += qty;
                else if (name.endsWith(' E')) seCounts.E += qty;
                else seCounts.Other += qty;
              }
            });
          } catch(e) {}
        });
        report.topProducts = Object.entries(productCounts)
          .sort((a,b)=>b[1].count-a[1].count).slice(0,10)
          .map(([name,d])=>({name,count:d.count,revenue:Math.round(d.revenue)}));
        report.mdlModels = Object.entries(modelCounts)
          .sort((a,b)=>b[1].count-a[1].count).slice(0,10)
          .map(([name,d])=>({name,count:d.count,revenue:Math.round(d.revenue)}));
        report.seCounts = seCounts;

        // ── Geographic — state breakdown from shipped orders ──────
        const stateCounts = {};
        qAllTime.rows.forEach(q => {
          try {
            const state = q.customer?.state;
            if (!state) return;
            const abbr = toStateAbbr(state);
            if (abbr && abbr.length===2) stateCounts[abbr] = (stateCounts[abbr]||0)+1;
          } catch(e) {}
        });
        report.geography = stateCounts;

        // ── Customer insights ─────────────────────────────────────
        // Group by company
        const companies = {};
        qAllTime.rows.forEach(q => {
          const co = q.company || (q.deal_name?.split(/[·-]/)[0]?.trim()) || '—';
          if (!co || co==='—') return;
          if (!companies[co]) companies[co] = {deals:new Set(),totalValue:0,accepted:0,repIds:new Set(),lastDate:null};
          if (q.deal_id) companies[co].deals.add(q.deal_id);
          companies[co].totalValue += parseFloat(q.total||0);
          if (q.accepted==='true') companies[co].accepted++;
          if (q.rep_id) companies[co].repIds.add(q.rep_id);
          if (!companies[co].lastDate || q.created_at > companies[co].lastDate) companies[co].lastDate = q.created_at;
        });
        const repeatCustomers = Object.entries(companies)
          .map(([name,d]) => ({
            name, deals: d.deals.size, totalValue: Math.round(d.totalValue),
            accepted: d.accepted, rep: REPS[Array.from(d.repIds)[0]]||'—', lastDate: d.lastDate
          }))
          .filter(c => c.deals >= 2)
          .sort((a,b) => b.totalValue - a.totalValue)
          .slice(0,15);
        report.repeatCustomers = repeatCustomers;

        // Top customers by value
        report.topCustomers = Object.entries(companies)
          .map(([name,d]) => ({
            name, deals: d.deals.size, totalValue: Math.round(d.totalValue),
            accepted: d.accepted, rep: REPS[Array.from(d.repIds)[0]]||'—',
          }))
          .sort((a,b) => b.totalValue - a.totalValue)
          .slice(0,10);

        // ── Monthly trend — last 12 months ────────────────────────
        const monthly = await db.query(
          `SELECT to_char(created_at AT TIME ZONE 'America/New_York','Mon YY') as month,
                  to_char(created_at AT TIME ZONE 'America/New_York','YYYY-MM') as month_key,
                  COUNT(*) as quote_count,
                  SUM(total) as total_value,
                  SUM(CASE WHEN (json_snapshot->>'accepted')::text='true' THEN 1 ELSE 0 END) as accepted
           FROM quotes WHERE created_at >= NOW() - INTERVAL '12 months'
           GROUP BY month, month_key ORDER BY month_key ASC`
        );
        report.monthly = monthly.rows.map(r => ({
          month:r.month, monthKey:r.month_key,
          quotes:parseInt(r.quote_count),
          value:parseFloat(r.total_value||0),
          accepted:parseInt(r.accepted),
        }));

        // ── Orders ────────────────────────────────────────────────
        const oAll = await db.query(
          `SELECT quote_number, created_at, order_data FROM orders WHERE created_at >= $1`,
          [since]
        );
        const orders = oAll.rows;
        const shippedOrders = orders.filter(o=>o.order_data?.shipped?.tracking);
        const fulfillTimes = [];
        orders.forEach(o => {
          if (o.order_data?.shipped?.date && o.created_at) {
            const d = (new Date(o.order_data.shipped.date)-new Date(o.created_at))/(1000*60*60*24);
            if (d>0 && d<180) fulfillTimes.push(d);
          }
        });
        const carrierCounts={}, foamCounts={};
        shippedOrders.forEach(o => {
          const c=o.order_data?.shipped?.carrier||'Unknown';
          carrierCounts[c]=(carrierCounts[c]||0)+1;
        });
        orders.forEach(o => {
          const f=o.order_data?.foamColor;
          if(f) foamCounts[f]=(foamCounts[f]||0)+1;
        });
        report.orders = {
          total: orders.length,
          shipped: shippedOrders.length,
          inProduction: orders.length-shippedOrders.length,
          avgFulfillDays: fulfillTimes.length ? Math.round(fulfillTimes.reduce((s,d)=>s+d,0)/fulfillTimes.length) : null,
          byCarrier: carrierCounts,
          byFoamColor: Object.entries(foamCounts).sort((a,b)=>b[1]-a[1]).slice(0,6),
        };

        // ── All-time totals ───────────────────────────────────────
        const totals = await db.query(
          `SELECT COUNT(*) as total_quotes, SUM(total) as total_value,
                  SUM(CASE WHEN (json_snapshot->>'accepted')::text='true' THEN 1 ELSE 0 END) as total_accepted,
                  COUNT(DISTINCT company) as unique_companies, MIN(created_at) as first_quote
           FROM quotes`
        );
        report.allTime = {
          totalQuotes:     parseInt(totals.rows[0].total_quotes),
          totalValue:      parseFloat(totals.rows[0].total_value||0),
          totalAccepted:   parseInt(totals.rows[0].total_accepted),
          uniqueCompanies: parseInt(totals.rows[0].unique_companies),
          since:           totals.rows[0].first_quote,
        };

        report.velocity = { avgDaysToAccept: avgVelocity, sampleSize: velocityData.length };
      }

      // ── HubSpot pipeline + application field ──────────────────
      try {
        const pipeRes = await httpsRequest({
          hostname: 'api.hubapi.com',
          path: '/crm/v3/objects/deals/search',
          method: 'POST',
          headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
        }, {
          filterGroups: [],
          properties: ['dealstage','amount','hubspot_owner_id','payment_status','hs_lastmodifieddate','closedate'],
          sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
          limit: 200,
        });
        const deals = pipeRes.body?.results||[];
        const STAGE_NAMES = {
          'appointmentscheduled':'Sent Quote','qualifiedtobuy':'Updated Quote',
          'contractsent':'Verbal Confirmation','closedwon':'Closed Won',
          '845719':'Shipped','closedlost':'Closed Lost',
        };
        // Weighted forecast — configured weights
        const WEIGHTS = { 'appointmentscheduled':.20,'qualifiedtobuy':.40,'contractsent':.80,'closedwon':.95,'845719':1.0 };
        const pipeline={}, repDeals={};
        let totalPipeline=0, weightedForecast=0;
        let won=0, lost=0;
        deals.forEach(d => {
          const stage = d.properties?.dealstage;
          const sName = STAGE_NAMES[stage]||stage||'Unknown';
          const amt   = parseFloat(d.properties?.amount||0);
          if (!pipeline[sName]) pipeline[sName] = {count:0,value:0};
          pipeline[sName].count++;
          pipeline[sName].value += amt;
          if (stage!=='closedlost') totalPipeline += amt;
          if (WEIGHTS[stage]) weightedForecast += amt * WEIGHTS[stage];
          if (['closedwon','845719'].includes(stage)) won++;
          if (stage==='closedlost') lost++;
          const rep = REPS[d.properties?.hubspot_owner_id]||'Unknown';
          if (!repDeals[rep]) repDeals[rep]={total:0,value:0,won:0,wonVal:0};
          repDeals[rep].total++;
          repDeals[rep].value += amt;
          if (['closedwon','845719'].includes(stage)) { repDeals[rep].won++; repDeals[rep].wonVal += amt; }
        });
        const payBreakdown={paid:0,po_received:0,not_paid:0};
        deals.forEach(d => {
          const ps=d.properties?.payment_status||'not_paid';
          payBreakdown[ps]=(payBreakdown[ps]||0)+1;
        });
        report.pipeline = {
          byStage: pipeline, totalValue: totalPipeline, totalDeals: deals.length,
          weightedForecast: Math.round(weightedForecast),
          winRate: (won+lost)>0 ? Math.round(won/(won+lost)*100) : null,
          paymentBreakdown: payBreakdown,
          byRep: repDeals,
        };

        // Application field — discover and fetch from contacts
        try {
          const contactRes = await httpsRequest({
            hostname: 'api.hubapi.com',
            path: '/crm/v3/objects/contacts/search',
            method: 'POST',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
          }, {
            filterGroups: [],
            properties: ['application','firstname','lastname'],
            sorts: [{ propertyName: 'lastmodifieddate', direction: 'DESCENDING' }],
            limit: 200,
          });
          const applicationCounts = {};
          (contactRes.body?.results||[]).forEach(c => {
            const app = c.properties?.application;
            if (app) applicationCounts[app] = (applicationCounts[app]||0)+1;
          });
          report.applications = Object.entries(applicationCounts)
            .sort((a,b)=>b[1]-a[1])
            .map(([name,count])=>({name,count}));
          if (!report.applications.length) {
            console.log('[reports] application field returned no data — checking field name');
          }
        } catch(e) { console.warn('Application fetch failed:', e.message); }
      } catch(e) { console.warn('Pipeline fetch failed:', e.message); }

      report.period = days;
      report.generatedAt = new Date().toISOString();
      json(report);
    } catch(e) {
      console.error('Reports error:', e.message);
      json({ error: e.message }, 500);
    }
    return;
  }

  // ── API: Notifications ───────────────────────────────────────────
  if (pathname === '/api/notifications' && req.method === 'GET') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    const sess = getSession(req);
    if (!sess?.ownerId) { json({ notifications: [] }); return; }
    try {
      const r = await db.query(
        `SELECT id, type, title, body, deal_id, deal_name, quote_num, read, created_at
         FROM notifications WHERE owner_id=$1
         ORDER BY created_at DESC LIMIT 50`,
        [String(sess.ownerId)]
      );
      json({ notifications: r.rows });
    } catch(e) { json({ notifications: [] }); }
    return;
  }

  if (pathname === '/api/notifications/read-all' && req.method === 'POST') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    const sess = getSession(req);
    if (!sess?.ownerId) { json({ success: true }); return; }
    try {
      await db.query(`UPDATE notifications SET read=true WHERE owner_id=$1`, [String(sess.ownerId)]);
      json({ success: true });
    } catch(e) { json({ success: false }); }
    return;
  }

  if (pathname.startsWith('/api/notifications/') && req.method === 'POST') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    const notifId = pathname.split('/')[3];
    try {
      await db.query(`UPDATE notifications SET read=true WHERE id=$1`, [notifId]);
      json({ success: true });
    } catch(e) { json({ success: false }); }
    return;
  }


  if (pathname.startsWith('/api/quote-snapshot/') && req.method === 'GET') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    const qNum = decodeURIComponent(pathname.replace('/api/quote-snapshot/', '').trim());
    try {
      const snap = await getQuoteFromDb(qNum);
      if (!snap) { json({ error: 'Quote not found' }, 404); return; }
      json({
        lineItems: snap.lineItems || [],
        freight:   snap.freight   || null,
        tax:       snap.tax       || null,
        discount:  snap.discount  || { type:'pct', value:0 },
        customer:  snap.customer  || {},
        ownerId:   snap.ownerId   || null,
        shareToken: snap._shareToken || null,
      });
    } catch(e) { json({ error: e.message }, 500); }
    return;
  }

  if (pathname.startsWith('/api/deals/') && pathname.endsWith('/timeline') && req.method === 'GET') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    const dealId = pathname.split('/')[3];
    try {
      const events = [];

      // 1. Deal created / stage changes from HubSpot deal properties
      const dealRes = await httpsRequest({
        hostname: 'api.hubapi.com',
        path: `/crm/v3/objects/deals/${dealId}?properties=dealname,dealstage,createdate,hs_lastmodifieddate,amount,hubspot_owner_id`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
      });
      const dp = dealRes.body?.properties || {};
      if (dp.createdate) events.push({
        at: dp.createdate, type: 'deal_created',
        icon: '🟠', label: 'Deal created',
        detail: dp.dealname || '',
        rep: REPS[dp.hubspot_owner_id] || ''
      });

      // 2. Quotes from DB
      if (db) {
        // Get deal name for fallback matching
        const dealName = dp.dealname || null;
        const qr = await db.query(
          `SELECT quote_number, date, created_at, total,
                  (json_snapshot->>'accepted')::text as accepted,
                  json_snapshot->'acceptedAt' as accepted_at,
                  json_snapshot->'customer' as customer
           FROM quotes
           WHERE deal_id = $1 OR (deal_id IS NULL AND deal_name = $2)
           ORDER BY created_at ASC`,
          [dealId, dealName]
        );
        qr.rows.forEach(r => {
          const customerName = (() => {
            try {
              const c = r.customer || {};
              return [c.firstName, c.lastName].filter(Boolean).join(' ') || c.company || '';
            } catch(e) { return ''; }
          })();
          events.push({
            at: r.created_at, type: 'quote_sent',
            icon: '📋', label: `Quote sent — ${r.quote_number}`,
            detail: customerName ? `To: ${customerName}` : '',
            amount: r.total ? parseFloat(r.total) : null,
            quoteNumber: r.quote_number,
          });
          if (r.accepted === 'true') {
            // Use acceptedAt if stored, else use modified time as estimate
            const acceptedAt = r.accepted_at || r.created_at;
            events.push({
              at: acceptedAt, type: 'quote_accepted',
              icon: '✅', label: `Quote accepted — ${r.quote_number}`,
              detail: '', quoteNumber: r.quote_number,
              highlight: true,
            });
          }
        });

        // 3. Orders from DB
        const or = await db.query(
          `SELECT o.quote_number, o.created_at, o.order_data
           FROM orders o
           WHERE o.deal_id = $1
              OR o.quote_number IN (SELECT quote_number FROM quotes WHERE deal_id = $1 OR (deal_id IS NULL AND deal_name = $2))
           ORDER BY o.created_at ASC`,
          [dealId, dealName]
        );
        or.rows.forEach(r => {
          events.push({
            at: r.created_at, type: 'order_created',
            icon: '📦', label: `Order processed — ${r.quote_number}`,
            detail: [r.order_data?.foamColor, r.order_data?.hingePreference].filter(Boolean).join(' · '),
            quoteNumber: r.quote_number,
          });
          if (r.order_data?.shipped?.date) {
            const shipDate = new Date(r.order_data.shipped.date).toISOString();
            events.push({
              at: shipDate, type: 'shipped',
              icon: '🚚', label: `Shipped — ${r.quote_number}`,
              detail: [r.order_data.shipped.carrier, r.order_data.shipped.tracking].filter(Boolean).join(' · '),
              highlight: true,
            });
          }
          // Change log entries
          (r.order_data?.changeLog || []).forEach(entry => {
            if (entry.summary?.includes('Marked Shipped')) return; // dedupe with shipped event
            events.push({
              at: entry.at, type: 'order_update',
              icon: '🔧', label: entry.summary,
              detail: entry.rep || '',
            });
          });
        });
      }

      // 4. Invoices from HubSpot
      try {
        const assocRes = await httpsRequest({
          hostname: 'api.hubapi.com',
          path: `/crm/v4/associations/deals/invoices/batch/read`,
          method: 'POST',
          headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
        }, { inputs: [{ id: String(dealId) }] });

        const invoiceIds = (assocRes.body?.results?.[0]?.to || []).map(r => r.toObjectId);
        if (invoiceIds.length) {
          const batchRes = await httpsRequest({
            hostname: 'api.hubapi.com',
            path: '/crm/v3/objects/invoices/batch/read',
            method: 'POST',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
          }, {
            inputs: invoiceIds.map(id => ({ id: String(id) })),
            properties: ['hs_invoice_status','hs_create_date','hs_number','hs_amount_billed','hs_payment_date']
          });
          (batchRes.body?.results || []).forEach(inv => {
            const p = inv.properties || {};
            if (p.hs_create_date) events.push({
              at: p.hs_create_date, type: 'invoice_created',
              icon: '🧾', label: `Invoice created — ${p.hs_number || inv.id}`,
              amount: p.hs_amount_billed ? parseFloat(p.hs_amount_billed) : null,
            });
            if (p.hs_payment_date && p.hs_invoice_status === 'paid') events.push({
              at: p.hs_payment_date, type: 'invoice_paid',
              icon: '💰', label: `Invoice paid — ${p.hs_number || inv.id}`,
              amount: p.hs_amount_billed ? parseFloat(p.hs_amount_billed) : null,
              highlight: true,
            });
          });
        }
      } catch(e) { console.warn('Timeline invoice fetch failed:', e.message); }

      // Sort all events chronologically
      events.sort((a, b) => new Date(a.at) - new Date(b.at));

      json({ events });
    } catch(e) {
      console.error('Timeline error:', e.message);
      json({ error: e.message }, 500);
    }
    return;
  }

  if (pathname.startsWith('/api/deals/') && pathname.endsWith('/hub') && req.method === 'GET') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    const dealId = pathname.split('/')[3];
    try {
      // Fire all independent data fetches in parallel
      const [dealRes, contactAssocRes, quotesRes, ordersRes, invoiceAssocRes] = await Promise.all([

        // 1. Deal properties from HubSpot
        httpsRequest({
          hostname: 'api.hubapi.com',
          path: `/crm/v3/objects/deals/${dealId}?properties=dealname,dealstage,payment_status,amount,hubspot_owner_id`,
          method: 'GET',
          headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
        }).catch(() => ({ body: {} })),

        // 2. Contact association from HubSpot
        httpsRequest({
          hostname: 'api.hubapi.com',
          path: `/crm/v4/associations/deals/contacts/batch/read`,
          method: 'POST',
          headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
        }, { inputs: [{ id: String(dealId) }] }).catch(() => ({ body: {} })),

        // 3. Quotes from DB (need dealName for fallback — use dealId only for first pass)
        db ? db.query(
          `SELECT quote_number, total, date, deal_name, rep_id, share_token, payment_link,
                  gdrive_folder_id,
                  (json_snapshot->>'accepted')::text            as accepted,
                  json_snapshot->>'acceptedFoam'                as accepted_foam,
                  json_snapshot->>'acceptedHinge'               as accepted_hinge,
                  json_snapshot->>'acceptedNote'                as accepted_note,
                  json_snapshot->>'quoteLabel'                  as quote_label,
                  json_snapshot->'lineItems'                    as line_items
           FROM quotes WHERE deal_id = $1 ORDER BY created_at DESC`,
          [dealId]
        ).catch(() => ({ rows: [] })) : Promise.resolve({ rows: [] }),

        // 4. Orders from DB
        db ? db.query(
          `SELECT o.quote_number, o.order_data, o.created_at
           FROM orders o
           WHERE o.deal_id = $1
              OR o.quote_number IN (SELECT quote_number FROM quotes WHERE deal_id = $1)
           ORDER BY o.created_at DESC`,
          [dealId]
        ).catch(() => ({ rows: [] })) : Promise.resolve({ rows: [] }),

        // 5. Invoice associations from HubSpot
        httpsRequest({
          hostname: 'api.hubapi.com',
          path: `/crm/v4/objects/deals/${dealId}/associations/invoices`,
          method: 'GET',
          headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
        }).catch(() => ({ body: {} })),
      ]);

      // Extract deal properties
      const dp = dealRes.body?.properties || {};
      let dealName      = dp.dealname    || null;
      const dealStage   = dp.dealstage   || null;
      const dealAmount  = dp.amount      || null;
      let paymentStatus = dp.payment_status || 'not_paid';

      // If no quotes found by deal_id, try fallback by deal_name (legacy quotes)
      let qRows = quotesRes.rows || [];
      if (qRows.length === 0 && dealName && db) {
        try {
          const fallback = await db.query(
            `SELECT quote_number, total, date, deal_name, rep_id, share_token, payment_link,
                    gdrive_folder_id,
                    (json_snapshot->>'accepted')::text            as accepted,
                    json_snapshot->>'acceptedFoam'                as accepted_foam,
                    json_snapshot->>'acceptedHinge'               as accepted_hinge,
                    json_snapshot->>'acceptedNote'                as accepted_note,
                    json_snapshot->>'quoteLabel'                  as quote_label,
                    json_snapshot->'lineItems'                    as line_items
             FROM quotes WHERE deal_id IS NULL AND deal_name = $1 ORDER BY created_at DESC`,
            [dealName]
          );
          qRows = fallback.rows;
          // Backfill deal_id in background
          if (qRows.length > 0) {
            db.query(`UPDATE quotes SET deal_id = $1 WHERE deal_name = $2 AND deal_id IS NULL`, [dealId, dealName])
              .then(r => { if (r.rowCount > 0) console.log(`[hub] backfilled deal_id for ${r.rowCount} quotes`); })
              .catch(() => {});
          }
        } catch(e) {}
      }
      console.log(`[hub] deal ${dealId} (${dealName}) quotes: ${qRows.length}`);

      const quotes = qRows.map(r => {
        let firstMdl = '';
        try {
          const mdlItem = (r.line_items || []).find(i => i && /^MDL\b/.test(i.name || ''));
          if (mdlItem) firstMdl = (mdlItem.name || '').split(' ').slice(0, 3).join(' ');
        } catch(e) {}
        return {
          quoteNumber:   r.quote_number,
          total:         r.total,
          date:          r.date,
          dealName:      r.deal_name,
          repId:         r.rep_id,
          shareToken:    r.share_token,
          paymentLink:   r.payment_link,
          accepted:      r.accepted === 'true',
          firstMdl,
          acceptedFoam:  r.accepted_foam  || '',
          acceptedHinge: r.accepted_hinge || '',
          acceptedNote:  r.accepted_note  || '',
          quoteLabel:    r.quote_label    || '',
          gdriveFolder:  r.gdrive_folder_id || null,
        };
      });

      const orders = (ordersRes.rows || []).map(r => ({
        quoteNumber:     r.quote_number,
        foamColor:       r.order_data?.foamColor || '',
        hingePreference: r.order_data?.hingePreference || '',
        shipped:         r.order_data?.shipped || null,
        freightCost:     r.order_data?.freightCost || null,
        createdAt:       r.created_at,
      }));

      // Resolve contact (needs contactId from assoc result)
      let contact = null;
      try {
        const contactId = contactAssocRes.body?.results?.[0]?.to?.[0]?.toObjectId;
        if (contactId) {
          const cRes = await httpsRequest({
            hostname: 'api.hubapi.com',
            path: `/crm/v3/objects/contacts/${contactId}?properties=firstname,lastname,email,phone,company`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
          });
          const cp = cRes.body?.properties || {};
          contact = {
            firstName: cp.firstname || '',
            lastName:  cp.lastname  || '',
            email:     cp.email     || '',
            phone:     cp.phone     || '',
            company:   cp.company   || '',
          };
        }
      } catch(e) { console.warn('[hub] contact fetch error:', e.message); }

      // Resolve invoices (needs invoiceIds from assoc result)
      let invoices = [];
      try {
        const invoiceIds = (invoiceAssocRes?.body?.results || []).map(r => r.toObjectId);
        if (invoiceIds.length) {
          const [batchRes, dbInv] = await Promise.all([
            httpsRequest({
              hostname: 'api.hubapi.com',
              path: '/crm/v3/objects/invoices/batch/read',
              method: 'POST',
              headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
            }, {
              inputs: invoiceIds.map(id => ({ id: String(id) })),
              properties: ['hs_invoice_status','hs_invoice_date','hs_number','hs_title','hs_amount_billed','hs_balance_due','hs_hubspot_invoice_link','quote_number']
            }),
            db ? db.query('SELECT quote_number, payment_link, share_token FROM quotes WHERE deal_id = $1 AND payment_link IS NOT NULL', [dealId]).catch(() => ({ rows: [] }))
               : Promise.resolve({ rows: [] }),
          ]);

          invoices = (batchRes?.body?.results || []).map(inv => {
            const dbRows = dbInv.rows || [];
            const dbMatch = dbRows.find(d => d.quote_number === inv.properties?.quote_number)
              || (dbRows.length === 1 ? dbRows[0] : null);
            const invPageUrl = dbMatch?.quote_number && dbMatch?.share_token
              ? `https://sales.whisperroom.com/i/${dbMatch.quote_number}?t=${dbMatch.share_token}`
              : dbMatch?.payment_link || null;
            return {
              id:             inv.id,
              status:         inv.properties?.hs_invoice_status || 'draft',
              number:         inv.properties?.hs_number || '',
              title:          inv.properties?.hs_title || '',
              date:           inv.properties?.hs_invoice_date || '',
              amount:         inv.properties?.hs_amount_billed || '0',
              balance:        inv.properties?.hs_balance_due || '0',
              hubspotUrl:     inv.properties?.hs_hubspot_invoice_link || null,
              quoteNumber:    inv.properties?.quote_number || '',
              paymentPageUrl: invPageUrl,
              paymentMethod:  inv.properties?.hs_payment_method || '',
            };
          });

          // Fetch payment method from Payment records (only for paid invoices)
          try {
            const paidInvIds = invoices.filter(inv => inv.status === 'paid').map(inv => inv.id);
            if (paidInvIds.length) {
              const pmAssocRes = await httpsRequest({
                hostname: 'api.hubapi.com',
                path: '/crm/v4/associations/invoices/payments/batch/read',
                method: 'POST',
                headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
              }, { inputs: paidInvIds.map(id => ({ id: String(id) })) });
              const pmResults = pmAssocRes.body?.results || [];
              const paymentIds = [];
              const invByPayment = {};
              pmResults.forEach(r => {
                (r.to || []).forEach(t => {
                  paymentIds.push(t.toObjectId);
                  invByPayment[t.toObjectId] = r.from?.id;
                });
              });
              if (paymentIds.length) {
                const pmBatch = await httpsRequest({
                  hostname: 'api.hubapi.com',
                  path: '/crm/v3/objects/payments/batch/read',
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
                }, { inputs: paymentIds.map(id => ({ id: String(id) })), properties: ['hs_payment_method'] });
                (pmBatch.body?.results || []).forEach(pm => {
                  const invId = invByPayment[pm.id];
                  const inv = invoices.find(i => i.id === invId);
                  if (inv && pm.properties?.hs_payment_method) {
                    const raw = pm.properties.hs_payment_method;
                    inv.paymentMethod = raw.includes('ach') || raw.includes('bank') ? 'ACH'
                                      : raw.includes('card') ? 'CC' : raw;
                  }
                });
              }
            }
          } catch(e) { console.warn('[hub] payment method fetch failed:', e.message); }

          // Auto-sync: if any invoice is paid, update deal payment_status in background
          const anyPaid = invoices.some(inv => inv.status === 'paid');
          if (anyPaid && paymentStatus !== 'paid') {
            paymentStatus = 'paid';
            httpsRequest({
              hostname: 'api.hubapi.com',
              path: `/crm/v3/objects/deals/${dealId}`,
              method: 'PATCH',
              headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
            }, { properties: { payment_status: 'paid' } })
              .then(() => console.log(`[hub] auto-synced payment_status=paid for deal ${dealId}`))
              .catch(e => console.warn('[hub] auto-sync payment_status failed:', e.message));
          }
        }
      } catch(e) { console.warn('[hub] invoices error:', e.message); }

      // Drive folder (from quotes — no extra API call if no folder set)
      const driveFolderQuote = quotes.find(q => q.gdriveFolder) || null;
      const driveFolderId    = driveFolderQuote?.gdriveFolder || null;
      let driveFolderName    = null;
      if (driveFolderId) {
        try {
          const folderMeta = await gdriveRequest('GET',
            `/drive/v3/files/${driveFolderId}?fields=name&supportsAllDrives=true`
          );
          driveFolderName = folderMeta?.name || null;
        } catch(e) { console.warn('[hub] folder name fetch failed:', e.message); }
      }

      json({ dealId, dealStage, dealAmount, paymentStatus, quotes, invoices, orders, contact, driveFolderId, driveFolderName });
    } catch(e) {
      console.error('Deal hub error:', e.message);
      writelog('error','error.create-invoice',`create-invoice failed: ${e.message}`,{ rep: getRepFromReq(req, body) });
      json({ error: e.message }, 500);
    }
    return;
  }

  // ── API: Create Invoice ──────────────────────────────────────────
  // ── API: Create Payment Link (replaces invoice flow) ────────────
  if (pathname === '/api/create-invoice' && req.method === 'POST') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    try {
      const body = JSON.parse(await readBody(req));
      const { dealId, quoteNumber, lineItems, freight, tax, discount, ownerId, contactId, customer } = body;

      if (!dealId) { json({ error: 'No deal ID' }, 400); return; }

      // 1. Fetch deal owner + contact if not passed
      let resolvedOwnerId = ownerId || null;
      let resolvedContactId = contactId || null;
      try {
        const dealData = await httpsRequest({
          hostname: 'api.hubapi.com',
          path: `/crm/v3/objects/deals/${dealId}?properties=hubspot_owner_id,hs_contact_id`,
          method: 'GET',
          headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
        });
        if (!resolvedOwnerId) resolvedOwnerId = dealData.body?.properties?.hubspot_owner_id || null;
        // Get associated contact from deal
        if (!resolvedContactId) {
          const assocRes = await httpsRequest({
            hostname: 'api.hubapi.com',
            path: `/crm/v4/objects/deals/${dealId}/associations/contacts`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
          });
          resolvedContactId = assocRes.body?.results?.[0]?.toObjectId || null;
        }
      } catch(e) { console.warn('Could not fetch deal details:', e.message); }

      // 2. Calculate discount multiplier
      const sub = (lineItems || []).reduce((s, i) => s + (parseFloat(i.price) * parseInt(i.qty)), 0);
      const discPct = discount && discount.value > 0
        ? (discount.type === 'pct' ? discount.value / 100 : discount.value / (sub || 1))
        : 0;
      const freightTotal = freight ? parseFloat(freight.total || 0) : 0;
      const taxTotal = tax ? parseFloat(tax.tax || 0) : 0;

      // 3. Build line items
      const creditTotal = (lineItems || []).reduce((s, item) => item.price < 0 ? s + (parseFloat(item.price) * parseInt(item.qty || 1)) : s, 0);
      const creditItems = (lineItems || []).filter(item => parseFloat(item.price || 0) < 0);
      const positiveLineItems = (lineItems || []).filter(item => parseFloat(item.price || 0) >= 0);

      const invoiceLineItems = positiveLineItems.map(item => ({ ...item, price: parseFloat(item.price || 0), lineDiscount: discPct > 0 ? parseFloat((discPct * 100).toFixed(4)) : 0 }));

      // If credits exist: deduct total from the MDL line item (or highest-priced item as fallback)
      // so HubSpot invoice total is correct. Each credit also appears as a $0 descriptor line.
      if (creditTotal < 0 && invoiceLineItems.length > 0) {
        // Find MDL item first, fall back to highest-priced
        let anchorIdx = invoiceLineItems.findIndex(i => /^MDL\b/i.test(i.name || ''));
        if (anchorIdx === -1) {
          anchorIdx = invoiceLineItems.reduce((maxIdx, item, idx, arr) =>
            item.price > arr[maxIdx].price ? idx : maxIdx, 0);
        }
        const anchor = invoiceLineItems[anchorIdx];
        const creditAmt = Math.abs(creditTotal);
        const origPrice = parseFloat(anchor.price);
        const adjustedPrice = Math.max(0, origPrice - creditAmt);
        const creditDesc = `$${creditAmt.toFixed(2)} in credits applied to this line. ${anchor.description || ''}`.trim();
        invoiceLineItems[anchorIdx] = { ...anchor, price: adjustedPrice, description: creditDesc };

        // Add each individual credit as a $0 line with description showing the amount
        creditItems.forEach(cr => {
          const amt = Math.abs(parseFloat(cr.price) * parseInt(cr.qty || 1));
          invoiceLineItems.push({
            name: cr.name,
            qty: 1,
            price: 0,
            description: `Credit applied in ${anchor.name} above: -$${amt.toFixed(2)}${cr.description ? ' — ' + cr.description : ''}`,
            isCredit: true,
          });
        });
        console.log(`[create-invoice] deducted $${creditAmt.toFixed(2)} credits from "${anchor.name}" (${origPrice.toFixed(2)} → ${adjustedPrice.toFixed(2)})`);
      }

      if (freightTotal > 0) invoiceLineItems.push({
        name: 'Freight', qty: 1, price: freightTotal,
        description: freight?.transit ? `LTL freight. Transit: ${freight.transit}` : 'LTL freight'
      });
      if (taxTotal > 0) invoiceLineItems.push({
        name: `Sales Tax (${tax?.rate ? (tax.rate * 100).toFixed(2).replace(/\.?0+$/,'') : ''}%)`,
        qty: 1, price: taxTotal,
        description: tax?.freightTaxed ? 'State tax — includes freight.' : 'State tax — product only.'
      });

      const createdLineItemIds = [];
      for (let idx = 0; idx < invoiceLineItems.length; idx++) {
        const item = invoiceLineItems[idx];
        try {
          const liProps = {
            name: item.name,
            quantity: String(item.qty || 1),
            price: String(parseFloat(item.price || 0).toFixed(2)),
            description: item.description || '',
            hs_position_on_quote: String(idx),
          };
          if (item.productId) liProps.hs_product_id = String(item.productId);
          if (item.lineDiscount && item.lineDiscount > 0 && !item.isCredit) {
            liProps.hs_discount_percentage = String(item.lineDiscount);
          }
          const li = await hsCreateLineItem(liProps);
          if (li.id) createdLineItemIds.push(li.id);
        } catch(e) { console.warn('Line item create error:', e.message); }
      }

      // 4. Create HubSpot invoice as draft
      const today = new Date().toISOString().split('T')[0];
      const invoiceProps = {
        hs_invoice_status: 'draft',
        hs_currency:       'USD',
        hs_title:          quoteNumber ? `Invoice — ${quoteNumber}` : 'Invoice',
        hs_invoice_date:   today,
        hs_due_date:       today,
      };
      // Ship-to: patch contact's address so HubSpot invoice billing address populates
      if (resolvedContactId && customer?.address) {
        try {
          await httpsRequest({
            hostname: 'api.hubapi.com',
            path: `/crm/v3/objects/contacts/${resolvedContactId}`,
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
          }, { properties: {
            address:  customer.address || '',
            city:     customer.city    || '',
            state:    toStateFull(customer.state) || customer.state || '',
            zip:      customer.zip     || '',
            country:  customer.country || 'United States',
          }});
        } catch(e) { console.warn('Contact address patch failed:', e.message); }
      }
      // Also try patching invoice shipping address after creation (patch separately to avoid creation errors)
      invoiceProps.hs_title = quoteNumber ? `Invoice — ${quoteNumber}` : 'Invoice';
      // Custom ship-to fields
      if (customer) {
        const firstName = customer.firstName || '';
        const lastName  = customer.lastName  || '';
        const fullName  = [firstName, lastName].filter(Boolean).join(' ') || customer.company || '';
        const csz       = [customer.city, customer.state, customer.zip].filter(Boolean).join(', ');
        if (fullName)        invoiceProps.ship_to_name          = fullName;
        if (customer.address) invoiceProps.ship_to_address      = customer.address;
        if (csz)             invoiceProps.ship_to_city_state_zip = csz;
      }
      if (resolvedOwnerId) invoiceProps.hubspot_owner_id = String(resolvedOwnerId);
      if (quoteNumber)     invoiceProps.quote_number     = quoteNumber;

      const invoiceRes = await httpsRequest({
        hostname: 'api.hubapi.com',
        path: '/crm/v3/objects/invoices',
        method: 'POST',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
      }, { properties: invoiceProps });

      console.log('Invoice create response:', JSON.stringify(invoiceRes.body));

      const invoiceId = invoiceRes.body?.id;
      if (!invoiceId) {
        const errMsg = invoiceRes.body?.message
          || (invoiceRes.body?.errors || []).map(e => e.message).join(', ')
          || JSON.stringify(invoiceRes.body);
        throw new Error('Error creating invoice: ' + errMsg);
      }

      // 5. Associate invoice → deal
      try {
        await httpsRequest({
          hostname: 'api.hubapi.com',
          path: '/crm/v4/associations/invoices/deals/batch/create',
          method: 'POST',
          headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
        }, {
          inputs: [{ from: { id: String(invoiceId) }, to: { id: String(dealId) },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 175 }] }]
        });
      } catch(e) { console.warn('Invoice→deal association failed:', e.message); }

      // 6. Associate invoice → contact (for Billed To)
      if (resolvedContactId) {
        try {
          await httpsRequest({
            hostname: 'api.hubapi.com',
            path: '/crm/v4/associations/invoices/contacts/batch/create',
            method: 'POST',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
          }, {
            inputs: [{ from: { id: String(invoiceId) }, to: { id: String(resolvedContactId) },
              types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 177 }] }]
          });
          console.log(`Invoice→contact associated: contact ${resolvedContactId}`);
        } catch(e) { console.warn('Invoice→contact association failed:', e.message); }
      }

      // 7. Associate invoice → line items
      if (createdLineItemIds.length > 0) {
        try {
          await httpsRequest({
            hostname: 'api.hubapi.com',
            path: '/crm/v4/associations/invoices/line_items/batch/create',
            method: 'POST',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
          }, {
            inputs: createdLineItemIds.map(liId => ({
              from: { id: String(invoiceId) }, to: { id: String(liId) },
              types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 409 }]
            }))
          });
        } catch(e) { console.warn('Invoice→line_items association failed:', e.message); }
      }

      // 8a. Patch to open — separate from address so status always succeeds
      try {
        const statusRes = await httpsRequest({
          hostname: 'api.hubapi.com',
          path: `/crm/v3/objects/invoices/${invoiceId}`,
          method: 'PATCH',
          headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
        }, { properties: { hs_invoice_status: 'open' } });
        if (statusRes.body?.status === 'error') {
          console.warn('Invoice status patch error:', statusRes.body?.message);
        } else {
          console.log(`Invoice ${invoiceId} set to open`);
        }
      } catch(e) { console.warn('Invoice status patch failed:', e.message); }

      // 8b. Patch shipping address separately — failure here won't affect invoice status
      if (customer) {
        console.log(`[invoice] patching address for ${invoiceId}:`, JSON.stringify({name: customer.firstName, addr: customer.address, city: customer.city, state: customer.state, zip: customer.zip}));
        try {
          const addrProps = {};
          const fullName = [customer.firstName, customer.lastName].filter(Boolean).join(' ') || customer.company || '';
          if (fullName)         addrProps.hs_recipient_shipping_name         = fullName;
          if (customer.address) addrProps.hs_recipient_shipping_address      = customer.address;
          if (customer.city)    addrProps.hs_recipient_shipping_city         = customer.city;
          if (customer.state)   addrProps.hs_recipient_shipping_state        = customer.state;
          if (customer.zip)     addrProps.hs_recipient_shipping_zip          = customer.zip;
          addrProps.hs_recipient_shipping_country      = 'United States';
          addrProps.hs_recipient_shipping_country_code = 'US';
          const addrRes = await httpsRequest({
            hostname: 'api.hubapi.com',
            path: `/crm/v3/objects/invoices/${invoiceId}`,
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
          }, { properties: addrProps });
          if (addrRes.body?.status === 'error') {
            console.warn('Invoice address patch error:', addrRes.body?.message?.slice(0, 200));
          } else {
            console.log(`Invoice ${invoiceId} shipping address set`);
          }
        } catch(e) { console.warn('Invoice address patch failed:', e.message); }
      }

      // 9. Fetch invoice link after open (it may only be set after status=open)
      let paymentUrl = invoiceRes.body?.properties?.hs_invoice_link || null;
      if (!paymentUrl) {
        try {
          const fetchedInv = await httpsRequest({
            hostname: 'api.hubapi.com',
            path: `/crm/v3/objects/invoices/${invoiceId}?properties=hs_invoice_link`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
          });
          paymentUrl = fetchedInv.body?.properties?.hs_invoice_link || null;
          console.log('Invoice link after open:', paymentUrl);
        } catch(e) { console.warn('Could not fetch invoice link:', e.message); }
      }

      if (quoteNumber && paymentUrl) {
        try {
          await db.query('UPDATE quotes SET payment_link = $1 WHERE quote_number = $2', [paymentUrl, quoteNumber]);
        } catch(e) { console.warn('DB payment_link save failed:', e.message); }
      }

      // 10. Return invoice page URL
      const invToken = (await db?.query('SELECT share_token FROM quotes WHERE quote_number = $1', [quoteNumber]))?.rows[0]?.share_token || '';
      const invoicePageUrl = `https://sales.whisperroom.com/i/${quoteNumber}?t=${invToken}`;
      writelog('info', 'invoice.created', `Invoice created: ${quoteNumber || '—'}`, { rep: String(ownerId || ''), quoteNum: quoteNumber || null, dealId: String(dealId || ''), meta: { invoiceId } });
      json({ success: true, invoiceUrl: invoicePageUrl, paymentUrl, invoiceId });

      // Upload invoice PDF to Google Drive (non-blocking)
      (async () => {
        try {
          const pdfBufI = await generatePdfBuffer(invoicePageUrl);
          const snapRowI = await db?.query('SELECT json_snapshot FROM quotes WHERE quote_number = $1', [quoteNumber]);
          const snapI = snapRowI?.rows[0]?.json_snapshot || {};
          await gdriveSavePdfToDeal(quoteNumber, 'Invoices', buildPdfFilename(snapI, quoteNumber, 'Invoice'), pdfBufI);
        } catch(e) {
          console.warn('GDrive invoice upload error:', e.message);
          writelog('error', 'error.gdrive', `Drive invoice upload failed: ${e.message}`, { rep: String(ownerId||''), quoteNum: quoteNumber, dealId: String(dealId||''), meta: { step: 'invoice-pdf' } });
        }
      })();

    } catch(e) {
      console.error('Create invoice error:', e.message);
      writelog('error','error.create-invoice',`create-invoice failed: ${e.message}`,{ rep: getRepFromReq(req, body) });
      json({ error: e.message }, 500);
    }
    return;
  }




  // ── Orders Dashboard Page ─────────────────────────────────────────
  if (pathname === '/reports' && req.method === 'GET') {
    if (!isAuth(req)) { res.writeHead(302, { Location: '/deals' }); res.end(); return; }
    const html = fs.readFileSync(path.join(__dirname, 'reports-dashboard.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (pathname === '/deals' && req.method === 'GET') {
    if (!isAuth(req)) { res.writeHead(302, { Location: '/' }); res.end(); return; }
    const html = fs.readFileSync(path.join(__dirname, 'deals-dashboard.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // ── Admin Log Page ───────────────────────────────────────────────
  // ── Changelog Page ───────────────────────────────────────────────
  if (pathname === '/changelog' && req.method === 'GET') {
    if (!isAuth(req)) { res.writeHead(302, { Location: '/' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Changelog — WhisperRoom</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='%231a1a1a'/><text x='50%25' y='56%25' dominant-baseline='middle' text-anchor='middle' font-size='18'>📝</text></svg>">
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root{--bg:#0f0f0f;--surface:#1a1a1a;--surface2:#222;--border:#2a2a2a;--orange:#ee6216;--text:#e8e8e8;--muted:#888;--green:#22c55e;--red:#ef4444;--yellow:#f59e0b;--blue:#3b82f6;}
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;}
  .topbar{display:flex;align-items:center;justify-content:space-between;padding:0 20px;height:52px;background:#1a1a1a;border-bottom:1px solid rgba(255,255,255,.1);position:sticky;top:0;z-index:100;}
  .logo{font-family:'Syne',sans-serif;font-size:18px;font-weight:800;color:#f0ede8;}.logo span{color:#e8531a;}
  .back{font-size:11px;font-weight:700;color:var(--muted);text-decoration:none;padding:5px 10px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:6px;letter-spacing:.05em;text-transform:uppercase;}
  .main{max-width:860px;margin:0 auto;padding:32px 24px;}
  h1{font-family:'Syne',sans-serif;font-size:24px;font-weight:800;margin-bottom:4px;}h1 span{color:var(--orange);}
  .subtitle{font-size:12px;color:var(--muted);margin-bottom:32px;}
  .version-block{margin-bottom:28px;border:1px solid var(--border);border-radius:10px;overflow:hidden;}
  .version-header{padding:12px 18px;background:var(--surface);display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--border);}
  .version-num{font-family:'Syne',sans-serif;font-size:15px;font-weight:800;color:var(--orange);}
  .version-date{font-size:11px;color:var(--muted);}
  .version-tag{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;padding:2px 7px;border-radius:4px;margin-left:auto;}
  .tag-fix{background:rgba(59,130,246,.15);color:var(--blue);}
  .tag-feature{background:rgba(34,197,94,.12);color:var(--green);}
  .tag-logging{background:rgba(238,98,22,.12);color:var(--orange);}
  .tag-ui{background:rgba(168,85,247,.15);color:#a855f7;}
  .version-body{padding:14px 18px;background:var(--surface);}
  .change-item{display:flex;gap:10px;padding:5px 0;border-bottom:1px solid var(--border);font-size:13px;line-height:1.5;}
  .change-item:last-child{border-bottom:none;}
  .change-type{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;padding:2px 6px;border-radius:3px;white-space:nowrap;height:fit-content;margin-top:2px;}
  .ct-fix{background:rgba(59,130,246,.15);color:var(--blue);}
  .ct-add{background:rgba(34,197,94,.12);color:var(--green);}
  .ct-log{background:rgba(238,98,22,.12);color:var(--orange);}
  .ct-ui{background:rgba(168,85,247,.15);color:#a855f7;}
  .ct-security{background:rgba(245,158,11,.12);color:var(--yellow);}
</style>
</head>
<body>
<div class="topbar">
  <div class="logo">Whisper<span>Room</span> — Changelog</div>
  <a href="/admin-log" class="back">← Admin Log</a>
</div>
<div class="main">
  <h1>Patch <span>Notes</span></h1>
  <div class="subtitle">Full history of changes to the WhisperRoom sales tool</div>

  ${[
    {
      v:'1.1.14', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Canadian freight now uses correct NMFC codes (027880/02) matching legacy system'},
        {t:'fix', d:'Postal code spaces stripped automatically — "M4W 1B7" and "M4W1B7" both work'},
        {t:'fix', d:'Zip space stripping applied at server, freight request, and customer record save'},
      ]
    },
    {
      v:'1.1.13', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Ship It button now saves serial number, production notes, foam color, and hinge preference — same as Save Changes'},
      ]
    },
    {
      v:'1.1.12', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Ship date showing one day early — YYYY-MM-DD strings parsed as UTC midnight, now treated as local noon'},
      ]
    },
    {
      v:'1.1.11', date:'Apr 13, 2026', tag:'log',
      changes:[
        {t:'log', d:'Full shipping error coverage: error.refresh-tracking, error.track, error.ship-deal, error.ship-hubspot-deal, error.shipping-board, error.order-ship, error.tracking-poller'},
        {t:'log', d:'All error log entries now include rep via getRepFromReq()'},
      ]
    },
    {
      v:'1.1.10', date:'Apr 13, 2026', tag:'log',
      changes:[
        {t:'log', d:'Rep name now shows on ALL error log entries — getRepFromReq() helper added'},
        {t:'log', d:'Tax errors include rep from request body'},
      ]
    },
    {
      v:'1.1.09', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'TaxJar errors now log to system log with state/zip/city'},
        {t:'fix', d:'Tax route body hoisted out of try block — prevents body is not defined crash'},
        {t:'ui',  d:'Tax errors show plain English: invalid ZIP/city/state/timeout messages'},
      ]
    },
    {
      v:'1.1.08', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'TaxJar errors now logged to system log (error.tax event)'},
        {t:'ui',  d:'Tax error messages translated to plain English for reps'},
      ]
    },
    {
      v:'1.1.07', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'httpsGet 15-second timeout — freight no longer hangs for 5+ minutes'},
        {t:'fix', d:'parseAbfXml reads ABF ERROR tags and returns actionable messages'},
        {t:'fix', d:'Freight body scope fix — body is not defined crash resolved'},
        {t:'ui',  d:'Invalid ZIP/city/state/weight shown as plain English to reps'},
      ]
    },
    {
      v:'1.1.06', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Freight route body hoisted — prevented unhandledRejection crash'},
        {t:'log', d:'Freight errors now correctly log with dest zip/state/city'},
      ]
    },
    {
      v:'1.1.05', date:'Apr 13, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Rename Deal button in deal panel — updates HubSpot, Google Drive folder, and all DB quotes'},
        {t:'log', d:'deal.renamed logged to activity feed on success'},
      ]
    },
    {
      v:'1.1.04', date:'Apr 13, 2026', tag:'log',
      changes:[
        {t:'log', d:'Full error logging on all critical routes: accept-quote, create-invoice, process-order, abf-booking, order-save, unship, orders-list, hubspot'},
        {t:'add', d:'Gabe Troubleshooting Handbook added to handoff doc'},
      ]
    },
    {
      v:'1.1.03', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Duplicate quote.pushed log removed — was firing from both /api/history and /api/create-deal'},
      ]
    },
    {
      v:'1.1.02', date:'Apr 13, 2026', tag:'log',
      changes:[
        {t:'log', d:'Freight error logging added to quote builder, orders-freight, and ABF inner catch'},
      ]
    },
    {
      v:'1.1.01', date:'Apr 13, 2026', tag:'ui',
      changes:[
        {t:'ui',  d:'Admin log rebuilt — favicon, live dot, rep/event dropdowns, date range filter, stats bar, version badge, clear button'},
      ]
    },
    {
      v:'1.1.00', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'quote.pushed log correctly labels New deal vs Revision — meta includes isNewDeal and existingDealId'},
      ]
    },
    {
      v:'1.0.96', date:'Apr 13, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Logging system launched — logs table in PostgreSQL, writelog() helper, admin log page at /admin-log'},
        {t:'log', d:'Events: quote.pushed, deal.created, invoice.created, order.shipped, order.unshipped, order.deleted, order.processed, task.accounting'},
        {t:'log', d:'Errors: error.freight, error.tax, error.hubspot, error.save'},
      ]
    },
    {
      v:'1.0.95', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Accounting task on Ship It fires for ALL reps, not just Jeromy — assigned to Kim Dalton'},
        {t:'fix', d:'Task includes deal name, serial number, carrier, PRO/tracking, freight cost'},
      ]
    },
    {
      v:'1.0.94', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Unship preserves all shipment data — only reverts HubSpot dealstage to Closed Won'},
        {t:'fix', d:'Delete button now visible to all reps'},
        {t:'fix', d:'HS-only orders: Ship It creates DB record so order persists on board'},
      ]
    },
    {
      v:'1.0.93', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Serial number field changed to textarea for multi-line support'},
        {t:'fix', d:'HS-only orders (HS-{dealId}) save directly to HubSpot via PATCH'},
      ]
    },
    {
      v:'1.0.92', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Credits line items created BEFORE the HubSpot loop — were never being sent'},
        {t:'fix', d:'Credit descriptor line: "Credit applied in MDL XXXX above: -$XX.XX"'},
        {t:'fix', d:'anchor variable hoisted to outer scope — fixed ReferenceError on credit push'},
      ]
    },
    {
      v:'1.0.91', date:'Apr 13, 2026', tag:'feature',
      changes:[
        {t:'add', d:'OD Freight rating added alongside ABF — LTL, GTD, GTE via SOAP XML'},
        {t:'add', d:'OD Book URL pre-fills dest zip on odfl.com'},
        {t:'fix', d:'httpsGet timeout 15 seconds, parseAbfXml reads ERROR tags'},
      ]
    },
    {
      v:'1.0.90', date:'Apr 13, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Freight rating modal on orders board — Get Freight button fetches ABF rate per order'},
        {t:'add', d:'Orders board drag-and-drop sort with position persistence'},
      ]
    },
    {
      v:'1.0.89', date:'Apr 9, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Quote notes displayed on /q/ and /i/ client pages in orange-bordered box'},
        {t:'fix', d:'Canadian province state handling — retry without state fields if HubSpot rejects'},
      ]
    },
    {
      v:'1.0.88', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Orders dashboard — In Production / Shipped / All Orders / HubSpot Closed Won tabs'},
        {t:'add', d:'Orders drawer with foam color, hinge, serial number, production notes, delivery notes'},
        {t:'add', d:'Ship It button with carrier/tracking/date/pallets/boxes/hardware box fields'},
        {t:'add', d:'HubSpot deal stage advances to Shipped (845719) on Ship It'},
      ]
    },
    {
      v:'1.0.87', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Notifications system — bell icon in Deal Hub, fires on quote accept and payment marked'},
        {t:'add', d:'HubSpot workflow: task on accept → emails rep via internal email notification'},
      ]
    },
    {
      v:'1.0.86', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Merge Deal feature — move all quotes/orders to correct deal, delete wrong deal, merge Drive folders'},
        {t:'add', d:'Merge Legacy folder — import old AllContacts Drive folders into deal structure'},
      ]
    },
    {
      v:'1.0.85', date:'Apr 9, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Deal hub panel load parallelized with Promise.all — 5 independent HubSpot calls fire simultaneously'},
        {t:'fix', d:'Hub panel load time reduced from 5-7s to near-instant'},
      ]
    },
    {
      v:'1.0.84', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Activity Timeline in deal panel — full HubSpot engagement history per deal'},
        {t:'add', d:'Invoice panel in deal hub showing status, payment method, amounts'},
        {t:'add', d:'Orders panel in deal hub showing production/shipped status'},
      ]
    },
    {
      v:'1.0.83', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Create Invoice button per quote in deal hub — creates HubSpot invoice from quote snapshot'},
        {t:'add', d:'Invoice linked to deal and contact in HubSpot'},
        {t:'add', d:'Payment link fetched and stored in DB after invoice creation'},
      ]
    },
    {
      v:'1.0.82', date:'Apr 9, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Deal delete — removes HubSpot deal and all DB quote records'},
        {t:'fix', d:'Stage override in admin panel — single click moves deal to any stage'},
        {t:'fix', d:'Payment status picker — Not Paid / PO Received / Paid with color coding'},
      ]
    },
    {
      v:'1.0.81', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Deal Hub kanban board — Sent/Updated, Verbal, Closed Won, Shipped columns'},
        {t:'add', d:'Right-side hub panel with quotes, pipeline stepper, next action, admin overrides'},
        {t:'add', d:'Auto-filters to logged-in rep deals on load'},
        {t:'add', d:'HubSpot-only deal toggle to hide/show unintegrated deals'},
      ]
    },
    {
      v:'1.0.80', date:'Apr 9, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Share token stored in DB column only — stripped from json_snapshot before save'},
        {t:'fix', d:'getShareToken() prefers _loadedShareToken over _lastShareToken'},
        {t:'fix', d:'Both tokens synced on push, cleared on new quote, server fallback fetch if missing'},
      ]
    },
    {
      v:'1.0.79', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Shareable quote links (/q/:quoteNumber) with token validation'},
        {t:'add', d:'Customer-facing quote accept flow — foam color, hinge, notes captured on accept'},
        {t:'add', d:'Shareable invoice links (/i/:quoteNumber)'},
        {t:'add', d:'Customer-facing order status pages (/o/:quoteNumber)'},
      ]
    },
    {
      v:'1.0.78', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'PDF download for quotes, invoices, orders via Puppeteer'},
        {t:'add', d:'PDF semaphore — only one PDF generates at a time to stay within Railway memory limits'},
        {t:'add', d:'Google Drive auto-upload: quotes to Quotes/, invoices to Invoices/'},
      ]
    },
    {
      v:'1.0.77', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Google Drive integration — service account JWT auth, deal folder creation with subfolders'},
        {t:'add', d:'Subfolders: Quotes, Invoices, Purchase Orders, Drawings & Specs, Shipping, Final Order'},
        {t:'add', d:'Drive folder ID saved to DB, linked to quote record'},
      ]
    },
    {
      v:'1.0.76', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Process Order flow — moves deal to Closed Won, creates order record, sends confirmation email'},
        {t:'add', d:'Foam/hinge no longer required to process order'},
        {t:'add', d:'Changelog uses OAuth session name (window._sessionRepName)'},
      ]
    },
    {
      v:'1.0.75', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'TaxJar sales tax integration — nexus states, freight taxability per state'},
        {t:'add', d:'Tax exempt checkbox per quote'},
        {t:'add', d:'Tax included in HubSpot deal amount and order total'},
      ]
    },
    {
      v:'1.0.74', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'ABF freight rate integration — pallets, weight, accessories (residential, liftgate, limited access)'},
        {t:'add', d:'Freight accessorial preferences saved per customer email'},
        {t:'add', d:'BOOTH_DATA for pallet dims, freight weight = sum of all line item weights'},
      ]
    },
    {
      v:'1.0.73', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'OD tracking via direct REST API (api.odfl.com) — replaces AfterShip for OD shipments'},
        {t:'add', d:'ABF tracking via XML API (abfs.com) — replaces AfterShip for ABF shipments'},
        {t:'add', d:'UPS/FedEx/USPS tracking via Puppeteer scrape'},
        {t:'add', d:'Shipping board — 90-day window of shipped deals with live tracking status'},
      ]
    },
    {
      v:'1.0.59', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Credits tab in price book — 35 credit items from WR_CREDITS list, red CR badge styling'},
        {t:'add', d:'Negative price inputs supported — custom items can have negative prices'},
        {t:'fix', d:'Credits excluded from HubSpot line items — sum applied as hs_discount on invoice'},
      ]
    },
    {
      v:'1.0.58', date:'Apr 9, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'ABF delivered status false positives — now requires DELIVERYDATE in XML, not just status text match'},
        {t:'add', d:'"Arrived at Terminal" label added for shipments at local service center'},
      ]
    },
    {
      v:'1.0.57', date:'Apr 9, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'AfterShip fully removed — all tracking now uses direct carrier APIs'},
        {t:'fix', d:'Hub panel parallelized with Promise.all — 5 HubSpot calls fire simultaneously'},
        {t:'add', d:'fetchAndCacheTracking() seeds cache immediately on Ship It instead of AfterShip'},
      ]
    },
    {
      v:'1.0.56', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'fetchABFTracking() — ABF XML trace API, parses status/dates/signature/destination'},
        {t:'add', d:'fetchABFTransitDays() — ABF transit time API for ETA backfill on shipping board'},
        {t:'add', d:'fetchAndCacheTracking() rewritten — OD REST API, ABF direct XML, UPS/FedEx/USPS Puppeteer'},
        {t:'add', d:'/api/debug/od-tracking — raw OD API debug endpoint'},
        {t:'fix', d:'initTrackingCache — clears bogus same-day delivered_at entries'},
      ]
    },
    {
      v:'1.0.55', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Initial import — full system on Railway: Node.js server, PostgreSQL, HubSpot OAuth'},
        {t:'add', d:'Quote builder with product search, line items, customer fields, HubSpot push'},
        {t:'add', d:'Quote history in DB, contact/deal search, quote numbering by rep'},
        {t:'add', d:'HubSpot 30-day OAuth sessions, DB-backed, products cached with 15min TTL'},
      ]
    },
    ].map(v => `
    <div class="version-block">
      <div class="version-header">
        <div class="version-num">v${v.v}</div>
        <div class="version-date">${v.date}</div>
        <div class="version-tag tag-${v.tag}">${v.tag}</div>
      </div>
      <div class="version-body">
        ${v.changes.map(c => `
          <div class="change-item">
            <span class="change-type ct-${c.t === 'log' ? 'log' : c.t === 'add' ? 'add' : c.t === 'ui' ? 'ui' : c.t === 'security' ? 'security' : 'fix'}">${c.t === 'log' ? 'log' : c.t === 'add' ? 'new' : c.t === 'ui' ? 'ui' : c.t === 'security' ? 'sec' : 'fix'}</span>
            <span>${c.d}</span>
          </div>`).join('')}
      </div>
    </div>`).join('')}
</div>
</body>
</html>`);
    return;
  }

  if (pathname === '/admin-log' && req.method === 'GET') {
    if (!isAuth(req)) { res.writeHead(302, { Location: '/' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Admin Log — WhisperRoom</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='%231a1a1a'/><text x='50%25' y='56%25' dominant-baseline='middle' text-anchor='middle' font-size='18'>📋</text></svg>">
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root{--bg:#0f0f0f;--surface:#1a1a1a;--surface2:#222;--border:#2a2a2a;--orange:#ee6216;--text:#e8e8e8;--muted:#888;--green:#22c55e;--red:#ef4444;--yellow:#f59e0b;--blue:#3b82f6;}
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;}
  .topbar{display:flex;align-items:center;justify-content:space-between;padding:0 20px;height:52px;background:#1a1a1a;border-bottom:1px solid rgba(255,255,255,.1);position:sticky;top:0;z-index:100;gap:12px;}
  .logo{font-family:'Syne',sans-serif;font-size:18px;font-weight:800;color:#f0ede8;white-space:nowrap;}.logo span{color:#e8531a;}
  .topbar-right{display:flex;align-items:center;gap:10px;flex-shrink:0;}
  .back{font-size:11px;font-weight:700;color:var(--muted);text-decoration:none;padding:5px 10px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:6px;letter-spacing:.05em;text-transform:uppercase;}
  .live-dot{width:7px;height:7px;background:var(--green);border-radius:50%;animation:pulse 2s infinite;}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
  .last-updated{font-size:10px;color:var(--muted);}
  .main{max-width:1400px;margin:0 auto;padding:24px;}
  .page-header{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:18px;gap:16px;flex-wrap:wrap;}
  h1{font-family:'Syne',sans-serif;font-size:22px;font-weight:800;}h1 span{color:var(--orange);}
  .subtitle{font-size:12px;color:var(--muted);margin-top:3px;}
  .global-filters{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;}
  .filter-group{display:flex;flex-direction:column;gap:4px;}
  .filter-label{font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.07em;}
  .filter-select,.filter-input{padding:6px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:11px;font-family:inherit;outline:none;cursor:pointer;}
  .filter-select:focus,.filter-input:focus{border-color:var(--orange);}
  .btn-row{display:flex;gap:6px;}
  .refresh-btn{padding:6px 14px;background:var(--orange);color:white;border:none;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;text-transform:uppercase;letter-spacing:.05em;}
  .clear-btn{padding:6px 12px;background:none;color:var(--muted);border:1px solid var(--border);border-radius:6px;font-size:11px;cursor:pointer;font-family:inherit;}
  .stat-bar{display:flex;gap:12px;margin-bottom:18px;flex-wrap:wrap;}
  .stat{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 16px;min-width:110px;}
  .stat-val{font-size:22px;font-weight:800;font-family:'Syne',sans-serif;}
  .stat-label{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-top:2px;}
  .panels{display:grid;grid-template-columns:1fr 1fr;gap:20px;}
  @media(max-width:1000px){.panels{grid-template-columns:1fr;}}
  .panel{background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden;}
  .panel-header{padding:12px 16px;border-bottom:1px solid var(--border);}
  .panel-header-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;}
  .panel-title{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;}
  .activity-title{color:var(--green);}.error-title{color:var(--red);}
  .count{font-size:10px;color:var(--muted);font-weight:600;}
  .panel-body{overflow-y:auto;max-height:66vh;}
  .log-row{padding:9px 14px;border-bottom:1px solid var(--border);font-size:12px;}
  .log-row:last-child{border-bottom:none;}
  .log-row:hover{background:rgba(255,255,255,.02);}
  .log-row-main{display:grid;grid-template-columns:120px 115px 1fr 70px 48px;gap:8px;align-items:start;}
  .log-time{color:var(--muted);font-size:10px;white-space:nowrap;padding-top:1px;}
  .log-event{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:2px 6px;border-radius:4px;white-space:nowrap;width:fit-content;}
  .ev-quote\\.pushed{background:rgba(59,130,246,.15);color:var(--blue);}
  .ev-deal\\.created{background:rgba(59,130,246,.15);color:var(--blue);}
  .ev-invoice\\.created{background:rgba(168,85,247,.15);color:#a855f7;}
  .ev-order\\.shipped{background:rgba(34,197,94,.12);color:var(--green);}
  .ev-order\\.processed{background:rgba(34,197,94,.12);color:var(--green);}
  .ev-order\\.unshipped{background:rgba(245,158,11,.12);color:var(--yellow);}
  .ev-order\\.deleted{background:rgba(239,68,68,.12);color:var(--red);}
  .ev-task\\.accounting{background:rgba(238,98,22,.12);color:var(--orange);}
  .ev-quote\\.collision{background:rgba(245,158,11,.12);color:var(--yellow);}
  .ev-error\\.hubspot,.ev-error\\.save{background:rgba(239,68,68,.12);color:var(--red);}
  .log-msg{color:var(--text);line-height:1.4;}
  .log-sub{font-size:10px;color:var(--muted);margin-top:1px;}
  .log-rep{font-size:10px;font-weight:700;color:var(--orange);white-space:nowrap;text-align:right;}
  .log-ver{font-size:9px;color:rgba(255,255,255,.18);font-family:monospace;text-align:right;white-space:nowrap;}
  .meta-btn{font-size:10px;color:var(--muted);cursor:pointer;background:none;border:none;text-decoration:underline;font-family:inherit;margin-top:3px;display:inline-block;}
  .meta-row{display:none;margin:6px -14px -9px;padding:10px 14px;background:rgba(0,0,0,.3);font-size:10px;color:var(--muted);font-family:monospace;white-space:pre-wrap;word-break:break-all;border-top:1px solid var(--border);}
  .empty{padding:40px;text-align:center;color:var(--muted);font-size:13px;}
</style>
</head>
<body>
<div class="topbar">
  <div class="logo">Whisper<span>Room</span> — System Log</div>
  <div class="topbar-right">
    <div class="live-dot"></div>
    <span class="last-updated" id="lastUpdated">Loading…</span>
    <a href="/changelog" class="back">📝 Changelog</a>
    <a href="/deals" class="back">← Deal Hub</a>
  </div>
</div>
<div class="main">
  <div class="page-header">
    <div>
      <h1>System <span>Log</span></h1>
      <div class="subtitle">Activity and errors — auto-refreshes every 30 seconds</div>
    </div>
    <div class="global-filters">
      <div class="filter-group">
        <span class="filter-label">Rep</span>
        <select class="filter-select" id="globalRep" onchange="renderAll()">
          <option value="">All Reps</option>
        </select>
      </div>
      <div class="filter-group">
        <span class="filter-label">Event</span>
        <select class="filter-select" id="globalEvent" onchange="renderAll()">
          <option value="">All Events</option>
        </select>
      </div>
      <div class="filter-group">
        <span class="filter-label">Date Range</span>
        <select class="filter-select" id="globalDate" onchange="renderAll()">
          <option value="">All Time</option>
          <option value="today">Today</option>
          <option value="week">This Week</option>
          <option value="month">This Month</option>
        </select>
      </div>
      <div class="btn-row">
        <button class="refresh-btn" onclick="loadLogs()">↻ Refresh</button>
        <button class="clear-btn" onclick="clearFilters()">Clear</button>
      </div>
    </div>
  </div>

  <div class="stat-bar" id="statBar"></div>

  <div class="panels">
    <div class="panel">
      <div class="panel-header">
        <div class="panel-header-top">
          <div>
            <div class="panel-title activity-title">Activity Feed</div>
            <div class="count" id="activityCount"></div>
          </div>
          <input class="filter-input" id="activitySearch" placeholder="Search…" oninput="renderActivity()" style="width:150px">
        </div>
      </div>
      <div class="panel-body" id="activityBody"><div class="empty">Loading…</div></div>
    </div>
    <div class="panel">
      <div class="panel-header">
        <div class="panel-header-top">
          <div>
            <div class="panel-title error-title">Errors &amp; Warnings</div>
            <div class="count" id="errorCount"></div>
          </div>
          <input class="filter-input" id="errorSearch" placeholder="Search…" oninput="renderErrors()" style="width:150px">
        </div>
      </div>
      <div class="panel-body" id="errorBody"><div class="empty">Loading…</div></div>
    </div>
  </div>
</div>
<script>
let _activity=[], _errors=[];
const REPS={'36303670':'Benton','36320208':'Gabe','38732178':'Kim','38900892':'Chet','38732186':'Jeromy','36330944':'Jill','38143901':'Sarah','117442978':'Travis'};

async function loadLogs() {
  try {
    const res=await fetch('/api/logs',{credentials:'include'});
    const data=await res.json();
    _activity=data.activity||[];
    _errors=data.errors||[];
    populateDropdowns();
    renderAll();
    document.getElementById('lastUpdated').textContent='Updated '+new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/New_York'});
  } catch(e) {
    document.getElementById('activityBody').innerHTML='<div class="empty">Failed to load — '+e.message+'</div>';
  }
}

function populateDropdowns() {
  const all=[..._activity,..._errors];
  const repSel=document.getElementById('globalRep');
  const curRep=repSel.value;
  const reps=[...new Set(all.map(r=>r.rep).filter(Boolean))].sort();
  repSel.innerHTML='<option value="">All Reps</option>'+reps.map(r=>'<option value="'+r+'"'+(r===curRep?' selected':'')+'>'+(REPS[r]||r)+'</option>').join('');
  const evSel=document.getElementById('globalEvent');
  const curEv=evSel.value;
  const evs=[...new Set(all.map(r=>r.event).filter(Boolean))].sort();
  evSel.innerHTML='<option value="">All Events</option>'+evs.map(e=>'<option value="'+e+'"'+(e===curEv?' selected':'')+'>'+e+'</option>').join('');
}

function getFilters() {
  const rep=document.getElementById('globalRep').value;
  const event=document.getElementById('globalEvent').value;
  const date=document.getElementById('globalDate').value;
  const now=new Date();
  let since=null;
  if(date==='today') since=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  else if(date==='week') since=new Date(now-7*86400000);
  else if(date==='month') since=new Date(now.getFullYear(),now.getMonth(),1);
  return {rep,event,since};
}

function applyFilters(rows) {
  const {rep,event,since}=getFilters();
  return rows.filter(r=>{
    if(rep && r.rep!==rep) return false;
    if(event && r.event!==event) return false;
    if(since && new Date(r.at)<since) return false;
    return true;
  });
}

function renderAll(){renderActivity();renderErrors();renderStats();}
function clearFilters(){
  ['globalRep','globalEvent','globalDate','activitySearch','errorSearch'].forEach(id=>document.getElementById(id).value='');
  renderAll();
}

function fmt(ts) {
  const d=new Date(ts);
  return d.toLocaleDateString('en-US',{month:'short',day:'numeric'})+' '+d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',hour12:true,timeZone:'America/New_York'});
}

function evCls(ev){return 'ev-'+(ev||'').replace(/[.]/g,'\\\\.');}
function repLabel(r){
  if(!r) return '';
  // If it's a known ownerId, map to name
  if(REPS[r]) return REPS[r];
  // If it looks like a numeric ownerId but isn't in REPS, show as-is
  // Otherwise it's already a name string
  return r;
}

function rowHtml(r) {
  const meta=r.meta?JSON.stringify(r.meta,null,2):null;
  return '<div class="log-row"><div class="log-row-main">'
    +'<div class="log-time">'+fmt(r.at)+'</div>'
    +'<div class="log-event '+evCls(r.event)+'">'+r.event+'</div>'
    +'<div><div class="log-msg">'+(r.message||'')+'</div>'
    +((r.quote_num||r.deal_name)?'<div class="log-sub">'+[r.quote_num,r.deal_name].filter(Boolean).join(' · ')+'</div>':'')
    +(meta?'<button class="meta-btn" onclick="toggleMeta('+r.id+')">▸ details</button>':'')
    +'</div>'
    +'<div class="log-rep">'+repLabel(r.rep)+'</div>'
    +'<div class="log-ver">v'+(r.version||'—')+'</div>'
    +'</div>'
    +(meta?'<div class="meta-row" id="meta-'+r.id+'">'+meta+'</div>':'')
    +'</div>';
}

function toggleMeta(id){const el=document.getElementById('meta-'+id);if(el)el.style.display=el.style.display==='block'?'none':'block';}

function renderActivity() {
  const search=document.getElementById('activitySearch').value.trim().toLowerCase();
  let rows=applyFilters(_activity);
  if(search) rows=rows.filter(r=>(r.message||'').toLowerCase().includes(search)||(r.deal_name||'').toLowerCase().includes(search)||(r.quote_num||'').toLowerCase().includes(search));
  document.getElementById('activityCount').textContent=rows.length+' events';
  document.getElementById('activityBody').innerHTML=rows.length?rows.map(rowHtml).join(''):'<div class="empty">No activity matching filters</div>';
}

function renderErrors() {
  const search=document.getElementById('errorSearch').value.trim().toLowerCase();
  let rows=applyFilters(_errors);
  if(search) rows=rows.filter(r=>(r.message||'').toLowerCase().includes(search)||(r.event||'').toLowerCase().includes(search));
  document.getElementById('errorCount').textContent=rows.length+' events';
  document.getElementById('errorBody').innerHTML=rows.length?rows.map(rowHtml).join(''):'<div class="empty">No errors logged</div>';
}

function renderStats() {
  const f=applyFilters(_activity);
  const quotes=f.filter(r=>r.event==='quote.pushed').length;
  const shipped=f.filter(r=>r.event==='order.shipped').length;
  const invoices=f.filter(r=>r.event==='invoice.created').length;
  const errs=applyFilters(_errors).length;
  document.getElementById('statBar').innerHTML=[
    {v:quotes,l:'Quotes Pushed',c:'var(--blue)'},
    {v:shipped,l:'Orders Shipped',c:'var(--green)'},
    {v:invoices,l:'Invoices Created',c:'#a855f7'},
    {v:errs,l:'Errors',c:errs>0?'var(--red)':'var(--muted)'},
  ].map(s=>'<div class="stat"><div class="stat-val" style="color:'+s.c+'">'+s.v+'</div><div class="stat-label">'+s.l+'</div></div>').join('');
}

loadLogs();
setInterval(loadLogs,30000);
</script>
</body>
</html>`);
    return;
  }

    // ── API: Logs ────────────────────────────────────────────────────
  if (pathname === '/api/logs' && req.method === 'GET') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    try {
      if (!db) { json({ activity: [], errors: [] }); return; }
      const [actRes, errRes] = await Promise.all([
        db.query(`SELECT * FROM logs WHERE level = 'info' ORDER BY at DESC LIMIT 500`),
        db.query(`SELECT * FROM logs WHERE level IN ('error','warn') ORDER BY at DESC LIMIT 200`),
      ]);
      json({ activity: actRes.rows, errors: errRes.rows });
    } catch(e) {
      json({ error: e.message }, 500);
    }
    return;
  }

  if (pathname === '/orders' && req.method === 'GET') {
    const html = fs.readFileSync(path.join(__dirname, 'orders-dashboard.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // ── API: HubSpot Closed Won deals (for orders board) ─────────────
  if (pathname === '/api/orders/hubspot-deals' && req.method === 'GET') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    try {
      // Fetch Closed Won deals from HubSpot, exclude ones already in DB orders
      const hsRes = await httpsRequest({
        hostname: 'api.hubapi.com',
        path: '/crm/v3/objects/deals/search',
        method: 'POST',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
      }, {
        filterGroups: [{
          filters: [{ propertyName: 'dealstage', operator: 'EQ', value: 'closedwon' }]
        }],
        properties: ['dealname','amount','hubspot_owner_id','closedate','hs_deal_stage_probability',
                     'customer_name','company','shipping_address','shipping_city','shipping_state','shipping_zip'],
        sorts: [{ propertyName: 'closedate', direction: 'DESCENDING' }],
        limit: 100
      });

      const hsDeals = (hsRes.body?.results || []);

      // Get list of quote numbers already in our orders DB
      let dbQuoteNumbers = new Set();
      if (db) {
        const dbOrders = await db.query('SELECT deal_id FROM orders WHERE deal_id IS NOT NULL');
        dbOrders.rows.forEach(r => dbQuoteNumbers.add(r.deal_id));
      }

      // Filter out deals already processed through the new system
      const unprocessed = hsDeals.filter(d => !dbQuoteNumbers.has(d.id));

      json({ deals: unprocessed.map(d => ({
        id: d.id,
        dealName: d.properties.dealname || 'Unnamed Deal',
        amount: d.properties.amount || null,
        ownerId: d.properties.hubspot_owner_id || null,
        closeDate: d.properties.closedate || null,
        company: d.properties.company || '',
        dealUrl: `https://app.hubspot.com/contacts/5764220/record/0-3/${d.id}`,
        source: 'hubspot'
      }))});

    } catch(e) {
      console.error('HubSpot deals fetch error:', e.message);
      json({ deals: [], error: e.message });
    }
    return;
  }

  // ── API: Ship HubSpot deal directly (from orders board) ──────────
  if (pathname === '/api/orders/ship-hubspot-deal' && req.method === 'POST') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    try {
      const body = JSON.parse(await readBody(req));
      const { dealId, dealName, carrier, tracking, shipDate, pallets, boxes, hardwareBox, repName } = body;

      if (!dealId || !carrier || !tracking) {
        json({ error: 'dealId, carrier and tracking are required' }, 400); return;
      }

      // 1. Advance deal to Shipped in HubSpot
      await httpsRequest({
        hostname: 'api.hubapi.com',
        path: `/crm/v3/objects/deals/${dealId}`,
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
      }, {
        properties: {
          dealstage: '845719',
          freight_carrier: hsCarrierEnum(carrier),
          tracking_number: tracking,
          date_shipped: shipDate || new Date().toISOString().split('T')[0],
          box_count: parseInt(boxes)||0,
          pallet_count: parseInt(pallets)||0,
          hardware_box: parseInt(hardwareBox)||0,
        }
      });

      // 2. Create minimal order record in DB so it shows up in orders board
      if (db) {
        try {
          const orderData = {
            shipped: { carrier, tracking, date: shipDate, pallets: parseInt(pallets)||0, boxes: parseInt(boxes)||0, hardwareBox: hardwareBox||'' },
            processedAt: new Date().toISOString(),
            changeLog: [{
              at: new Date().toISOString(),
              summary: `Marked Shipped — ${carrier}, ${tracking}`,
              rep: repName || 'Unknown',
            }],
            source: 'hubspot_import'
          };
          // Use deal ID as a pseudo quote number for legacy deals
          const pseudoQuoteNum = `HS-${dealId}`;
          await db.query(`
            INSERT INTO orders (quote_number, deal_id, order_data)
            VALUES ($1, $2, $3)
            ON CONFLICT (quote_number) DO UPDATE SET
              order_data = EXCLUDED.order_data,
              deal_id    = EXCLUDED.deal_id
          `, [pseudoQuoteNum, dealId, JSON.stringify(orderData)]);
        } catch(e) { console.warn('DB order create failed:', e.message); }
      }

      // 3. Seed tracking cache immediately so shipping board shows status on next load
      if (tracking) {
        fetchAndCacheTracking(tracking, carrier).catch(e => console.warn('[ship-deal] cache seed failed:', e.message));
      }

      console.log(`HubSpot deal ${dealId} marked shipped: ${carrier} ${tracking}`);
      json({ success: true });

    } catch(e) {
      console.error('Ship HubSpot deal error:', e.message);
      writelog('error','error.ship-hubspot-deal',`ship-hubspot-deal failed: ${e.message}`,{ rep: getRepFromReq(req) });
      json({ error: e.message }, 500);
    }
    return;
  }



  // ── API: Get freight quote for order ────────────────────────────
  if (pathname === '/api/orders-freight' && req.method === 'POST') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    try {
      const body = JSON.parse(await readBody(req));
      const { pallets, totalWeight, city, state: rawState, zip, canadian, accessories } = body;
      const state = toStateAbbr(rawState);
      if (!pallets || !pallets.length) { json({ error: 'No pallet data' }, 400); return; }
      if (!city || !state || !zip)     { json({ error: 'Missing destination' }, 400); return; }
      const acc = accessories || {};

      // ── ABF: standard LTL via XML API ────────────────────────────
      // Note: ABF's legacy XML rate API (aquotexml.asp) only returns standard LTL.
      // Guaranteed/expedited pricing requires the ArcBest REST API (separate integration).
      const abfResults = [];
      try {
        const url = buildAbfUrl(pallets, totalWeight, city, state, zip, canadian || false, acc);
        const res2 = await httpsGet(url);
        const result = parseAbfXml(res2.body);
        abfResults.push({
          carrier:     'ABF Freight',
          service:     'Standard LTL',
          serviceCode: 'STND',
          cost:        result.cost,
          transit:     result.transit,
          bookable:    true,
        });
      } catch(e) {
        console.warn(`[orders-freight] ABF Standard failed: ${e.message}`);
        writelog('error', 'error.freight', `ABF rate failed: ${e.message}`, { rep: getRepFromReq(req, body), meta: { zip, state, city } });
      }

      // ── OD: SOAP XML rate API ─────────────────────────────────────
      // OD's rate API is SOAP, not REST. Auth is in the request body.
      // Service types: LTL (standard), GTD (guaranteed), GTE (guaranteed by noon)
      const odResults = [];
      const OD_USER    = process.env.OD_USER    || '';
      const OD_PASS    = process.env.OD_PASS    || '';
      const OD_ACCOUNT = process.env.OD_ACCOUNT || '';
      if (OD_USER && OD_PASS && OD_ACCOUNT) {
        const totalWt = Math.round(totalWeight || pallets.reduce((s,p)=>s+(parseFloat(p.weight)||0),0));
        const destCountry = canadian ? 'CAN' : 'USA';

        // Build accessorials array from accessories
        const odAccessorials = [];
        if (acc.liftgate)       odAccessorials.push('HYD');  // Liftgate Delivery
        if (acc.residential)    odAccessorials.push('RDC');  // Residential Delivery
        if (acc.limitedaccess)  odAccessorials.push('LDC');  // Limited Access Delivery

        // Build freightItems XML from pallets
        const freightItemsXml = pallets.map(p => `
        <freightItems>
          <dimensionUnits>IN</dimensionUnits>
          <length>${Math.round(p.l || 90)}</length>
          <width>${Math.round(p.w || 52)}</width>
          <height>${Math.round(p.h || 48)}</height>
          <numberOfUnits>1</numberOfUnits>
          <ratedClass>${FREIGHT_CLASS}</ratedClass>
          <weight>${Math.round(parseFloat(p.weight) || Math.round(totalWt / pallets.length))}</weight>
        </freightItems>`).join('');

        const accessorialsXml = odAccessorials.map(a => `<accessorials>${a}</accessorials>`).join('\n        ');

        // Helper to build SOAP envelope for a given shipType
        const buildOdSoap = (shipType) => `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:myr="http://myRate.ws.odfl.com/">
  <soapenv:Header/>
  <soapenv:Body>
    <myr:getLTLRateEstimate>
      <arg0>
        ${accessorialsXml}
        <destinationCountry>${destCountry}</destinationCountry>
        <destinationPostalCode>${zip}</destinationPostalCode>
        ${freightItemsXml}
        <numberPallets>${pallets.length}</numberPallets>
        <movement>O</movement>
        <odfl4MePassword>${OD_PASS}</odfl4MePassword>
        <odfl4MeUser>${OD_USER}</odfl4MeUser>
        <odflCustomerAccount>${OD_ACCOUNT}</odflCustomerAccount>
        <originCountry>USA</originCountry>
        <originPostalCode>${SHIP_ZIP}</originPostalCode>
        <originState>${SHIP_STATE}</originState>
        <requestReferenceNumber>false</requestReferenceNumber>
        <shipType>${shipType}</shipType>
        <tariff>559</tariff>
        <weightUnits>LBS</weightUnits>
      </arg0>
    </myr:getLTLRateEstimate>
  </soapenv:Body>
</soapenv:Envelope>`;

        // Helper to parse OD SOAP response
        const parseOdSoap = (xml, shipType) => {
          const get = (tag) => { const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\/${tag}>`, 'i')); return m ? m[1].trim() : null; };
          const success = get('success');
          if (success === 'false') {
            const err = get('errorMessages') || get('message') || 'Unknown error';
            console.warn(`[orders-freight] OD ${shipType} error: ${err}`);
            return null;
          }
          const netCharge  = parseFloat(get('netFreightCharge') || '0');
          const fuelSurch  = parseFloat(get('fuelSurcharge') || '0');
          const accessChrg = parseFloat(get('totalAccessorialCharge') || '0');
          const total = Math.round((netCharge + fuelSurch + accessChrg) * 100) / 100;
          if (!total) return null;

          // Transit days from first destinationCities entry
          const transitMatch = xml.match(/<destinationCities>[\s\S]*?<serviceDays>(\d+)<\/serviceDays>/i);
          const transitDays = transitMatch ? parseInt(transitMatch[1]) : null;
          const transit = transitDays ? `${transitDays} day${transitDays !== 1 ? 's' : ''}` : '—';

          const serviceLabels = { LTL: 'Standard LTL', GTD: 'Guaranteed', GTE: 'Guaranteed by Noon' };
          return {
            carrier:     'Old Dominion',
            service:     serviceLabels[shipType] || shipType,
            serviceCode: shipType,
            cost:        total,
            transit,
            bookable:    false,
            odBookUrl:   buildOdBookUrl({ city, state, zip, pallets, totalWeight: totalWt, acc }),
          };
        };

        // Fetch LTL + GTD + GTE in parallel
        const OD_SERVICE_TYPES = ['LTL', 'GTD', 'GTE'];
        const odRawResults = await Promise.all(OD_SERVICE_TYPES.map(async shipType => {
          try {
            const soapBody = buildOdSoap(shipType);
            return new Promise((resolve) => {
              const req2 = require('https').request({
                hostname: 'www.odfl.com',
                path: '/wsRate_v6/RateService',
                method: 'POST',
                headers: {
                  'Content-Type': 'text/xml; charset=utf-8',
                  'SOAPAction': '"getLTLRateEstimate"',
                  'Accept-Encoding': 'identity',
                  'Content-Length': Buffer.byteLength(soapBody),
                }
              }, (res2) => {
                let data = '';
                res2.on('data', c => data += c);
                res2.on('end', () => {
                  console.log(`[orders-freight] OD ${shipType} HTTP status: ${res2.statusCode}, body length: ${data.length}`);
                  resolve({ shipType, xml: data, status: res2.statusCode });
                });
              });
              req2.on('error', (e) => {
                console.warn(`[orders-freight] OD ${shipType} request error: ${e.message}`);
                resolve(null);
              });
              req2.setTimeout(12000, () => { req2.destroy(); resolve(null); });
              req2.write(soapBody);
              req2.end();
            });
          } catch(e) {
            console.warn(`[orders-freight] OD ${shipType} failed: ${e.message}`);
            return null;
          }
        }));

        odRawResults.forEach(r => {
          if (!r) return;
          const parsed = parseOdSoap(r.xml, r.shipType);
          if (parsed) odResults.push(parsed);
        });

        console.log(`[orders-freight] OD results: ${odResults.length} rates`);
      } else {
        console.warn('[orders-freight] OD credentials not set (OD_USER/OD_PASS/OD_ACCOUNT)');
      }

      const carriers = [
        ...abfResults.filter(Boolean),
        ...odResults,
      ];

      if (!carriers.length) throw new Error('No rates returned from any carrier');
      json({ carriers });

    } catch(e) {
      console.error('[orders-freight] error:', e.message);
      writelog('error', 'error.freight', `Orders freight failed: ${e.message}`, { rep: getRepFromReq(req, body), meta: { zip, state, city } });
      json({ error: e.message }, 500);
    }
    return;
  }
  if (pathname === '/api/book-abf-shipment' && req.method === 'POST') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    try {
      const body = JSON.parse(await readBody(req));
      const {
        quoteNumber, dealId,
        pallets, totalWeight,
        consName, consAddr, consCity, consState, consZip, consPhone,
        pickupDate, accessories, specialInstructions,
      } = body;

      if (!pallets?.length) { json({ error: 'No pallet data' }, 400); return; }
      if (!consCity || !consState || !consZip) { json({ error: 'Missing destination' }, 400); return; }

      const bolNumber = quoteNumber || `WR-${Date.now()}`;

      const bookingUrl = buildAbfBookingUrl({
        pallets, totalWeight,
        consName, consAddr, consCity, consState: toStateAbbr(consState), consZip,
        consPhone, pickupDate, bolNumber, specialInstructions, accessories,
      });

      console.log('ABF booking URL:', bookingUrl.slice(0, 200) + '...');
      const res = await httpsGet(bookingUrl);
      console.log('ABF booking response:', res.body?.slice(0, 500));

      const result = parseAbfBookingXml(res.body);

      if (result.error) {
        json({ error: 'ABF booking error: ' + result.error, raw: result.raw });
        return;
      }

      if (!result.proNumber && !result.bolNumber && !result.pickupConfirm) {
        json({ error: 'No confirmation received from ABF. Raw: ' + result.raw });
        return;
      }

      // Save PRO number to order and HubSpot
      const proNumber = result.proNumber || result.bolNumber;
      if (proNumber) {
        // Update order in DB
        if (db && quoteNumber) {
          try {
            const existing = await db.query('SELECT order_data FROM orders WHERE quote_number = $1', [quoteNumber]);
            if (existing.rows[0]) {
              const od = existing.rows[0].order_data || {};
              od.shipped = { ...(od.shipped||{}), tracking: proNumber, carrier: 'ABF Freight', date: pickupDate || new Date().toISOString().split('T')[0] };
              od.changeLog = od.changeLog || [];
              od.changeLog.push({ at: new Date().toISOString(), summary: `ABF booked — PRO ${proNumber}`, rep: 'System' });
              await db.query('UPDATE orders SET order_data = $1 WHERE quote_number = $2', [JSON.stringify(od), quoteNumber]);
            }
          } catch(e) { console.warn('DB update after booking:', e.message); }
        }

        // Update HubSpot deal
        if (dealId) {
          try {
            await httpsRequest({
              hostname: 'api.hubapi.com',
              path: `/crm/v3/objects/deals/${dealId}`,
              method: 'PATCH',
              headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
            }, { properties: {
              dealstage: '845719',
              tracking_number: proNumber,
              carrier__c: 'ABF',
              date_shipped: pickupDate || new Date().toISOString().split('T')[0],
            }});
          } catch(e) { console.warn('HubSpot update after booking:', e.message); }
        }

        // Seed tracking cache immediately
        fetchAndCacheTracking(proNumber, 'ABF').catch(e => console.warn('ABF cache seed failed:', e.message));
      }

      json({
        success: true,
        proNumber,
        bolNumber: result.bolNumber,
        pickupConfirm: result.pickupConfirm,
        message: `Shipment booked. PRO: ${proNumber || 'pending'}`,
      });

    } catch(e) {
      console.error('ABF booking error:', e.message);
      writelog('error','error.abf-booking',`abf-booking failed: ${e.message}`,{ rep: getRepFromReq(req, body) });
      json({ error: e.message }, 500);
    }
    return;
  }

  // ── API: Unship order ────────────────────────────────────────────
  // ── API: Delete Order ────────────────────────────────────────────
  if (pathname.startsWith('/api/orders/') && pathname.endsWith('/delete') && req.method === 'DELETE') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    const quoteNumber = decodeURIComponent(pathname.replace('/api/orders/', '').replace('/delete', '').trim());
    try {
      if (!db) { json({ error: 'No database' }, 500); return; }
      const result = await db.query('DELETE FROM orders WHERE quote_number = $1', [quoteNumber]);
      if (result.rowCount === 0) { json({ error: 'Order not found' }, 404); return; }
      console.log(`[orders] deleted order ${quoteNumber}`);
      writelog('info', 'order.deleted', `Order deleted: ${quoteNumber}`, { quoteNum: quoteNumber });
      json({ success: true });
    } catch(e) {
      console.error('Delete order error:', e.message);
      writelog('error','error.order-save',`order-save failed: ${e.message}`,{ rep: getRepFromReq(req, body) });
      json({ error: e.message }, 500);
    }
    return;
  }

  if (pathname.startsWith('/api/orders/') && pathname.endsWith('/unship') && req.method === 'POST') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    const quoteNumber = decodeURIComponent(pathname.replace('/api/orders/', '').replace('/unship', '').trim());
    try {
      if (!db) { json({ error: 'No database' }, 500); return; }

      const existing = await db.query('SELECT order_data, deal_id FROM orders WHERE quote_number = $1', [quoteNumber]);
      if (!existing.rows[0]) { json({ error: 'Order not found' }, 404); return; }

      const od = existing.rows[0].order_data || {};
      const dealId = existing.rows[0].deal_id;
      const repName = JSON.parse(await readBody(req))?.repName || 'Unknown';

      // Unship — preserve ALL shipment data, just add unshipped flag so badge/stage reverts
      // Shipment fields stay visible in the drawer for reference
      const changeLog = od.changeLog || [];
      changeLog.push({ at: new Date().toISOString(), summary: 'Unshipped — reverted to Closed Won', rep: repName });

      const updated = {
        ...od,
        shipped:    od.shipped ? { ...od.shipped, unshipped: true } : null,
        changeLog,
        lastUpdated: new Date().toISOString()
      };
      await db.query('UPDATE orders SET order_data = $1 WHERE quote_number = $2', [JSON.stringify(updated), quoteNumber]);

      // Revert HubSpot deal stage to Closed Won — don't clear any fields
      if (dealId) {
        try {
          await httpsRequest({
            hostname: 'api.hubapi.com',
            path: `/crm/v3/objects/deals/${dealId}`,
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
          }, {
            properties: { dealstage: 'closedwon' }
          });
          console.log(`[unship] Deal ${dealId} reverted to Closed Won — all fields preserved`);
        } catch(e) { console.warn('[unship] HubSpot revert failed:', e.message); }
      }
      writelog('info', 'order.unshipped', `Unshipped: ${quoteNumber}`, { rep: repName, quoteNum: quoteNumber, dealId: String(dealId || '') });
      json({ success: true, quoteNumber });
    } catch(e) {
      writelog('error','error.unship',`unship failed: ${e.message}`,{ rep: getRepFromReq(req, body) });
      json({ error: e.message }, 500);
    }
    return;
  }

  // ── API: Delete Quote (single quote record) ─────────────────────
  if (pathname.startsWith('/api/quotes/') && pathname.endsWith('/delete') && req.method === 'DELETE') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    const quoteNumber = decodeURIComponent(pathname.replace('/api/quotes/', '').replace('/delete', '').trim());
    if (!quoteNumber) { json({ error: 'Quote number required' }, 400); return; }
    try {
      if (!db) { json({ error: 'No database' }, 500); return; }
      // Delete from orders table too if exists
      await db.query('DELETE FROM orders WHERE quote_number = $1', [quoteNumber]);
      await db.query('DELETE FROM notifications WHERE quote_num = $1', [quoteNumber]);
      const res = await db.query('DELETE FROM quotes WHERE quote_number = $1 RETURNING quote_number', [quoteNumber]);
      if (res.rows.length === 0) { json({ error: 'Quote not found' }, 404); return; }
      console.log(`[delete] quote ${quoteNumber} deleted from DB`);
      json({ success: true, deleted: quoteNumber });
    } catch(e) {
      console.error('[delete quote] error:', e.message);
      json({ error: e.message }, 500);
    }
    return;
  }

  // ── API: Delete Deal (all quotes + orders for a deal, + HubSpot deal) ──
  if (pathname.startsWith('/api/deals/') && pathname.endsWith('/merge') && req.method === 'POST') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    const sourceDealId = pathname.replace('/api/deals/', '').replace('/merge', '').trim();
    if (!sourceDealId) { json({ error: 'Source deal ID required' }, 400); return; }
    try {
      let body = {};
      try { body = JSON.parse(await readBody(req)); } catch(e) {}
      const { targetDealId } = body;
      if (!targetDealId) { json({ error: 'targetDealId required' }, 400); return; }
      if (sourceDealId === targetDealId) { json({ error: 'Source and target cannot be the same deal' }, 400); return; }

      const result = { quotes: 0, orders: 0, driveFolder: null, hubspotDeleted: false };

      if (db) {
        // Get source deal's Drive folder before re-associating quotes
        const folderRow = await db.query(
          `SELECT DISTINCT gdrive_folder_id FROM quotes WHERE deal_id = $1 AND gdrive_folder_id IS NOT NULL LIMIT 1`,
          [sourceDealId]
        );
        const sourceFolderId = folderRow.rows[0]?.gdrive_folder_id || null;

        // Get target deal's folder
        const targetFolderRow = await db.query(
          `SELECT DISTINCT gdrive_folder_id FROM quotes WHERE deal_id = $1 AND gdrive_folder_id IS NOT NULL LIMIT 1`,
          [targetDealId]
        );
        const targetFolderId = targetFolderRow.rows[0]?.gdrive_folder_id || null;

        // Re-associate all quotes from source → target deal
        const qRes = await db.query(
          `UPDATE quotes SET deal_id = $1 WHERE deal_id = $2`,
          [targetDealId, sourceDealId]
        );
        result.quotes = qRes.rowCount;

        // Re-associate all orders from source → target deal
        const oRes = await db.query(
          `UPDATE orders SET deal_id = $1 WHERE deal_id = $2`,
          [targetDealId, sourceDealId]
        );
        result.orders = oRes.rowCount;

        // Update notifications
        await db.query(
          `UPDATE notifications SET deal_id = $1 WHERE deal_id = $2`,
          [targetDealId, sourceDealId]
        );

        // Merge Drive folders if source has one
        if (sourceFolderId && targetFolderId && sourceFolderId !== targetFolderId) {
          try {
            // List all files in source folder
            const listQ = `'${sourceFolderId}' in parents and trashed=false`;
            const listRes = await gdriveRequest('GET',
              `/drive/v3/files?q=${encodeURIComponent(listQ)}&fields=files(id,name,mimeType)&supportsAllDrives=true&includeItemsFromAllDrives=true`
            );
            const files = listRes?.files || [];
            let moved = 0;
            for (const file of files) {
              try {
                await gdriveRequest('PATCH',
                  `/drive/v3/files/${file.id}?addParents=${targetFolderId}&removeParents=${sourceFolderId}&supportsAllDrives=true&fields=id`,
                  {}
                );
                moved++;
              } catch(e) { console.warn(`[merge-deal] Could not move file ${file.name}:`, e.message); }
            }
            // Trash source folder
            if (moved === files.length) {
              try {
                await gdriveRequest('PATCH',
                  `/drive/v3/files/${sourceFolderId}?supportsAllDrives=true&fields=id`,
                  { trashed: true }
                );
              } catch(e) { console.warn('[merge-deal] Could not trash source folder:', e.message); }
            }
            result.driveFolder = { moved, total: files.length };
          } catch(e) {
            console.warn('[merge-deal] Drive merge error:', e.message);
            result.driveFolder = { error: e.message };
          }
        } else if (sourceFolderId && !targetFolderId) {
          // Target has no folder — reassign source folder to target
          await db.query(
            `UPDATE quotes SET gdrive_folder_id = NULL WHERE deal_id = $1 AND gdrive_folder_id = $2`,
            [targetDealId, sourceFolderId]
          );
          result.driveFolder = { reassigned: sourceFolderId };
        }
      }

      // Delete source deal from HubSpot
      try {
        const hsRes = await httpsRequest({
          hostname: 'api.hubapi.com',
          path: `/crm/v3/objects/deals/${sourceDealId}`,
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
        });
        result.hubspotDeleted = hsRes.status === 204 || hsRes.status === 200;
        console.log(`[merge-deal] HubSpot source deal ${sourceDealId} deleted: ${hsRes.status}`);
      } catch(e) {
        console.warn('[merge-deal] HubSpot delete failed:', e.message);
      }

      console.log(`[merge-deal] ${sourceDealId} → ${targetDealId}: quotes=${result.quotes}, orders=${result.orders}`);
      json({ success: true, sourceDealId, targetDealId, ...result });
    } catch(e) {
      console.error('[merge-deal] error:', e.message);
      json({ error: e.message }, 500);
    }
    return;
  }

  if (pathname.startsWith('/api/deals/') && pathname.endsWith('/delete') && req.method === 'DELETE') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    const dealId = pathname.replace('/api/deals/', '').replace('/delete', '').trim();
    if (!dealId) { json({ error: 'Deal ID required' }, 400); return; }
    try {
      let dbDeleted = { quotes: 0, orders: 0 };

      if (db) {
        // Get all quote numbers for this deal first
        const qRows = await db.query('SELECT quote_number FROM quotes WHERE deal_id = $1', [dealId]);
        const qNums = qRows.rows.map(r => r.quote_number);

        if (qNums.length) {
          // Delete orders, notifications, then quotes
          await db.query('DELETE FROM orders WHERE deal_id = $1 OR quote_number = ANY($2)', [dealId, qNums]);
          await db.query('DELETE FROM notifications WHERE deal_id = $1 OR quote_num = ANY($2)', [dealId, qNums]);
          const del = await db.query('DELETE FROM quotes WHERE deal_id = $1 RETURNING quote_number', [dealId]);
          dbDeleted.quotes = del.rows.length;
        } else {
          // No quotes but try cleaning up orders/notifications by deal_id anyway
          await db.query('DELETE FROM orders WHERE deal_id = $1', [dealId]);
          await db.query('DELETE FROM notifications WHERE deal_id = $1', [dealId]);
        }
      }

      // Delete from HubSpot
      let hubspotDeleted = false;
      try {
        const hsRes = await httpsRequest({
          hostname: 'api.hubapi.com',
          path: `/crm/v3/objects/deals/${dealId}`,
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
        });
        // HubSpot returns 204 on success
        hubspotDeleted = hsRes.status === 204 || hsRes.status === 200;
        console.log(`[delete] HubSpot deal ${dealId} deleted: status ${hsRes.status}`);
      } catch(e) {
        console.warn(`[delete] HubSpot deal deletion failed: ${e.message}`);
      }

      console.log(`[delete] deal ${dealId} — DB quotes: ${dbDeleted.quotes}, HubSpot: ${hubspotDeleted}`);
      json({ success: true, dealId, dbDeleted, hubspotDeleted });
    } catch(e) {
      console.error('[delete deal] error:', e.message);
      json({ error: e.message }, 500);
    }
    return;
  }

  // ── API: List Orders ──────────────────────────────────────────────
  if (pathname === '/api/orders' && req.method === 'GET') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    try {
      if (!db) { json({ orders: [] }); return; }

      // 1. DB orders
      const result = await db.query(`
        SELECT
          o.quote_number,
          o.deal_id,
          o.order_data,
          o.created_at,
          COALESCE(q.customer_name, o.order_data->>'customerName') as customer_name,
          COALESCE(q.company,       o.order_data->>'company')      as company,
          COALESCE(q.deal_name,     o.order_data->>'dealName')     as deal_name,
          COALESCE(q.total::text,   o.order_data->>'total')        as total,
          q.json_snapshot,
          q.share_token,
          q.gdrive_folder_id,
          q.company as q_company
        FROM orders o
        LEFT JOIN quotes q ON q.quote_number = o.quote_number
        ORDER BY o.created_at DESC
      `);
      const dbOrders = result.rows.filter(r => {
        // Filter out orphaned HS- records that have no real order data
        // These were created by the old approach and should be re-shown via HubSpot
        if (r.quote_number.startsWith('HS-')) {
          const od = r.order_data || {};
          const hasRealData = od.foamColor || od.hingePreference || od.serialNumber ||
                              od.productionNotes || (od.shipped?.tracking && !od.shipped?.unshipped);
          return !!hasRealData;
        }
        return true;
      });
      const dbDealIds = new Set(dbOrders.map(r => r.deal_id).filter(Boolean));

      // 2. Pull HubSpot Closed Won deals not already in DB
      // Shipped (845719) deals belong on the shipping board, not orders board
      let hsOrders = [];
      try {
        const hsRes = await httpsRequest({
          hostname: 'api.hubapi.com',
          path: '/crm/v3/objects/deals/search',
          method: 'POST',
          headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
        }, {
          filterGroups: [
            { filters: [{ propertyName: 'dealstage', operator: 'EQ', value: 'closedwon' }] }
          ],
          properties: ['dealname','amount','hubspot_owner_id','closedate','dealstage',
                       'company','freight_carrier','tracking_number','date_shipped',
                       'box_count','pallet_count','hardware_box','description','production_notes'],
          sorts: [{ propertyName: 'closedate', direction: 'DESCENDING' }],
          limit: 100
        });

        hsOrders = (hsRes.body?.results || [])
          .filter(d => !dbDealIds.has(d.id))
          .map(d => {
            const p = d.properties || {};
            return {
              quote_number: `HS-${d.id}`,
              deal_id:      d.id,
              deal_name:    p.dealname || 'Unnamed Deal',
              customer_name: p.dealname || '',
              company:      p.company  || '',
              total:        p.amount   || null,
              order_data: {
                source:          'hubspot',
                serialNumber:    p.description      || '',
                productionNotes: p.production_notes || '',
                // Shipment fields pre-populate the drawer but shipped is always null —
                // the rep explicitly marks shipped via Ship It. Don't infer shipped state
                // from HubSpot fields since tracking/carrier may be set before pickup.
                shipped:         null,
                _hsCarrier:      p.freight_carrier  || '',
                _hsTracking:     p.tracking_number  || '',
                _hsDate:         p.date_shipped     || '',
                _hsBoxes:        p.box_count        || '',
                _hsPallets:      p.pallet_count     || '',
                _hsHardwareBox:  p.hardware_box     || '',
              },
              json_snapshot: null,
              share_token:   null,
              created_at:   p.closedate || '',
            };
          });
      } catch(e) { console.warn('[orders] HubSpot merge failed:', e.message); }

      json({ orders: [...dbOrders, ...hsOrders] });
    } catch(e) {
      console.error('List orders error:', e.message);
      writelog('error','error.orders-list',`list orders failed: ${e.message}`,{ rep: getRepFromReq(req) });
      json({ error: e.message }, 500);
    }
    return;
  }

  // ── API: Update Order ─────────────────────────────────────────────
  if (pathname.startsWith('/api/orders/') && req.method === 'PATCH') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    const quoteNumber = decodeURIComponent(pathname.replace('/api/orders/', '').trim());
    try {
      const body = JSON.parse(await readBody(req));
      const { customer, foamColor, hingePreference, productionNotes, deliveryNotes, shipped, changes, repName, freightCost, shipEmailTo, shipEmailCc, markShipped, serialNumber, shipmentFields } = body;

      if (!db) { json({ error: 'No database' }, 500); return; }

      // ── HubSpot-only orders (HS-{dealId}) — patch directly to HubSpot, no DB ──
      if (quoteNumber.startsWith('HS-')) {
        const hsDealId = quoteNumber.replace('HS-', '');
        try {
          const hsProps = {};
          if (serialNumber    !== undefined) hsProps.description      = String(serialNumber || '');
          const sf = shipmentFields || shipped || {};
          if (sf.carrier    !== undefined && sf.carrier)  hsProps.freight_carrier   = hsCarrierEnum(sf.carrier);
          if (sf.tracking   !== undefined && sf.tracking) hsProps.tracking_number   = String(sf.tracking);
          if (sf.date       !== undefined && sf.date)     hsProps.date_shipped      = String(sf.date);
          if (sf.boxes      !== undefined)                hsProps.box_count         = parseInt(sf.boxes) || 0;
          if (sf.pallets    !== undefined)                hsProps.pallet_count      = parseInt(sf.pallets) || 0;
          if (sf.hardwareBox !== undefined)               hsProps.hardware_box      = String(sf.hardwareBox || '');
          if (freightCost   !== undefined && freightCost) hsProps.actual_freight_cost = String(freightCost);
          if (markShipped && sf.tracking)                 hsProps.dealstage         = '845719';

          if (Object.keys(hsProps).length > 0) {
            const hsRes = await httpsRequest({
              hostname: 'api.hubapi.com',
              path: `/crm/v3/objects/deals/${hsDealId}`,
              method: 'PATCH',
              headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
            }, { properties: hsProps });
            if (hsRes.status >= 400) {
              console.error('[orders] HS-only PATCH error:', JSON.stringify(hsRes.body)?.slice(0,200));
              json({ error: 'HubSpot update failed: ' + (hsRes.body?.message || hsRes.status) }, 500);
              return;
            }
            console.log(`[orders] HS-only PATCH deal ${hsDealId}: ${Object.keys(hsProps).join(', ')}`);
          }

          // Seed tracking cache if tracking number present
          const trk = (sf.tracking || shipped?.tracking || '');
          const car = (sf.carrier  || shipped?.carrier  || '');
          if (trk && car) fetchAndCacheTracking(trk, car).catch(() => {});

          json({ success: true });

          // Non-blocking: create DB record + accounting task when Ship It is clicked
          if (markShipped && sf.tracking) {
            (async () => {
              try {
                // Create DB record so order appears on shipping board
                const shippedData = {
                  source:      'hubspot',
                  serialNumber: serialNumber || '',
                  shipped: {
                    carrier:     sf.carrier     || '',
                    tracking:    sf.tracking    || '',
                    date:        sf.date        || new Date().toISOString().split('T')[0],
                    boxes:       parseInt(sf.boxes)   || 0,
                    pallets:     parseInt(sf.pallets)  || 0,
                    hardwareBox: sf.hardwareBox || '',
                  },
                  freightCost: freightCost || null,
                  changeLog: [{ at: new Date().toISOString(), summary: 'Shipped', rep: repName || 'Unknown' }],
                };
                if (db) {
                  await db.query(
                    `INSERT INTO orders (quote_number, deal_id, order_data)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (quote_number) DO UPDATE SET
                       order_data = EXCLUDED.order_data, deal_id = EXCLUDED.deal_id`,
                    [quoteNumber, hsDealId, JSON.stringify(shippedData)]
                  );
                  console.log(`[orders] HS-only Ship It: DB record created for ${quoteNumber}`);
                }

                // Fetch deal name for task
                let dealNameT = quoteNumber;
                try {
                  const dr = await httpsRequest({
                    hostname: 'api.hubapi.com',
                    path: `/crm/v3/objects/deals/${hsDealId}?properties=dealname`,
                    method: 'GET',
                    headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
                  });
                  dealNameT = dr.body?.properties?.dealname || quoteNumber;
                } catch(e) {}

                // Accounting task
                const fcDisplay = freightCost ? `$${parseFloat(freightCost).toFixed(2)}` : '—';
                const taskBody = [
                  `Deal: ${dealNameT}`,
                  `Serial Number: ${serialNumber || '—'}`,
                  `Carrier: ${sf.carrier || '—'}`,
                  `PRO / Tracking: ${sf.tracking || '—'}`,
                  `Freight Cost: ${fcDisplay}`,
                ].join('\n');

                const taskRes = await httpsRequest({
                  hostname: 'api.hubapi.com',
                  path: '/crm/v3/objects/tasks',
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
                }, {
                  properties: {
                    hs_task_subject:  `📦 SHIPPED — ${dealNameT}`,
                    hs_task_body:     taskBody,
                    hs_task_status:   'NOT_STARTED',
                    hs_task_type:     'TODO',
                    hs_task_priority: 'HIGH',
                    hubspot_owner_id: '38732178', // Kim Dalton
                    hs_timestamp:     String(Date.now()),
                  }
                });
                const taskId = taskRes.body?.id;
                if (taskId && hsDealId) {
                  await httpsRequest({
                    hostname: 'api.hubapi.com',
                    path: '/crm/v4/associations/tasks/deals/batch/create',
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
                  }, {
                    inputs: [{ from: { id: taskId }, to: { id: String(hsDealId) },
                      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 216 }] }]
                  });
                }
                console.log(`[orders] HS-only accounting task created for ${dealNameT} (task ${taskId})`);
              } catch(e) {
                console.warn('[orders] HS-only Ship It post-processing failed:', e.message);
              }
            })();
          }
        } catch(e) {
          console.error('[orders] HS-only save error:', e.message);
          json({ error: e.message }, 500);
        }
        return;
      }

      // 1. Get existing DB order
      const existing = await db.query('SELECT order_data, deal_id FROM orders WHERE quote_number = $1', [quoteNumber]);
      if (!existing.rows[0]) { json({ error: 'Order not found' }, 404); return; }
      const currentOrderData = existing.rows[0].order_data || {};
      let dealId = existing.rows[0].deal_id;

      // Fallback: if deal_id missing from orders table, look it up from quotes table
      if (!dealId) {
        const qRow = await db.query('SELECT deal_id FROM quotes WHERE quote_number = $1 AND deal_id IS NOT NULL LIMIT 1', [quoteNumber]);
        if (qRow.rows[0]?.deal_id) {
          dealId = qRow.rows[0].deal_id;
          // Backfill it into orders table so we don't need to look it up next time
          await db.query('UPDATE orders SET deal_id = $1 WHERE quote_number = $2', [dealId, quoteNumber]);
          console.log(`[orders] backfilled deal_id ${dealId} for order ${quoteNumber}`);
        }
      }
      const wasShipped = !!(currentOrderData.shipped?.tracking);
      const isNowShipped = !!(shipped?.tracking);

      // 2. Append to change log if anything changed
      const changeLog = currentOrderData.changeLog || [];
      if (changes && changes.length > 0) {
        changeLog.push({
          at: new Date().toISOString(),
          summary: changes.join(' · '),
          rep: repName || null,
        });
      }

      // 3. Build updated order data
      // Merge shipmentFields into the shipped object for persistence
      // This lets Save persist carrier/tracking/etc. without triggering Ship It logic
      let mergedShipped = currentOrderData.shipped || null;
      if (shipmentFields) {
        mergedShipped = {
          ...(mergedShipped || {}),
          ...(shipmentFields.carrier   ? { carrier:     shipmentFields.carrier }             : {}),
          ...(shipmentFields.tracking  ? { tracking:    shipmentFields.tracking }            : {}),
          ...(shipmentFields.date      ? { date:        shipmentFields.date }                : {}),
          ...(shipmentFields.pallets   !== undefined ? { pallets: parseInt(shipmentFields.pallets)||0 } : {}),
          ...(shipmentFields.boxes     !== undefined ? { boxes:   parseInt(shipmentFields.boxes)||0 }   : {}),
          ...(shipmentFields.hardwareBox !== undefined ? { hardwareBox: shipmentFields.hardwareBox }    : {}),
        };
      }
      if (shipped !== undefined) mergedShipped = shipped; // Ship It overrides everything

      const updatedOrderData = {
        ...currentOrderData,
        foamColor:        foamColor        !== undefined ? foamColor        : currentOrderData.foamColor,
        hingePreference:  hingePreference  !== undefined ? hingePreference  : currentOrderData.hingePreference,
        serialNumber:     serialNumber     !== undefined ? serialNumber     : currentOrderData.serialNumber,
        productionNotes:  productionNotes  !== undefined ? productionNotes  : currentOrderData.productionNotes,
        deliveryNotes:    deliveryNotes    !== undefined ? deliveryNotes    : currentOrderData.deliveryNotes,
        shipped:          mergedShipped,
        freightCost:      freightCost      !== undefined ? freightCost      : currentOrderData.freightCost,
        shipEmailTo:      shipEmailTo      !== undefined ? shipEmailTo      : currentOrderData.shipEmailTo,
        shipEmailCc:      shipEmailCc      !== undefined ? shipEmailCc      : currentOrderData.shipEmailCc,
        changeLog,
        lastUpdated: new Date().toISOString(),
      };

      await db.query(
        'UPDATE orders SET order_data = $1 WHERE quote_number = $2',
        [JSON.stringify(updatedOrderData), quoteNumber]
      );

      // 4. Update customer in quote snapshot
      if (customer) {
        const qr = await db.query('SELECT json_snapshot FROM quotes WHERE quote_number = $1', [quoteNumber]);
        if (qr.rows[0]) {
          const snapshot = qr.rows[0].json_snapshot || {};
          snapshot.customer = { ...snapshot.customer, ...customer };
          await db.query(
            'UPDATE quotes SET json_snapshot = $1, customer_name = $2, company = $3 WHERE quote_number = $4',
            [
              JSON.stringify(snapshot),
              [customer.firstName, customer.lastName].filter(Boolean).join(' ') || snapshot.customer_name,
              customer.company || snapshot.company,
              quoteNumber
            ]
          );
        }
      }

      // 5. HubSpot updates
      if (dealId) {
        try {
          // Build HubSpot update from current full order state
          // Use shipped from client payload (Ship It) OR fall back to what was already in DB
          const sf = shipped || shipmentFields || currentOrderData.shipped || {};
          const fc = freightCost !== undefined ? freightCost : (currentOrderData.freightCost || null);
          const hsProps = {};
          if (serialNumber !== undefined)   hsProps.description       = String(serialNumber || '');
          if (productionNotes !== undefined) hsProps.production_notes  = String(productionNotes || '');
          console.log(`[orders] serialNumber received: ${JSON.stringify(serialNumber)} | updatedOrderData.serialNumber: ${JSON.stringify(updatedOrderData.serialNumber)}`);
          if (sf.carrier !== undefined)     hsProps.freight_carrier = hsCarrierEnum(sf.carrier || '');
          if (sf.tracking !== undefined)    hsProps.tracking_number = String(sf.tracking || '');
          if (sf.date !== undefined)        hsProps.date_shipped    = String(sf.date || '');
          if (sf.boxes !== undefined)       hsProps.box_count       = parseInt(sf.boxes) || 0;
          if (sf.pallets !== undefined)     hsProps.pallet_count    = parseInt(sf.pallets) || 0;
          if (sf.hardwareBox !== undefined) hsProps.hardware_box    = parseInt(sf.hardwareBox) || 0;
          if (fc !== null)                  hsProps.freight_cost        = String(fc);
          if (fc !== null)                  hsProps.actual_freight_cost = String(fc);
          if (markShipped && sf.tracking)   hsProps.dealstage           = '845719';
          console.log(`[orders] writing to HubSpot: ${JSON.stringify(hsProps)}`);

          if (Object.keys(hsProps).length > 0) {
            const hsRes = await httpsRequest({
              hostname: 'api.hubapi.com',
              path: `/crm/v3/objects/deals/${dealId}`,
              method: 'PATCH',
              headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
            }, { properties: hsProps });
            console.log(`[orders] HubSpot write status: ${hsRes.status} props: ${Object.keys(hsProps).join(',')}`);
            if (hsRes.status >= 400) {
              console.error('[orders] HubSpot error:', JSON.stringify(hsRes.body)?.slice(0,300));
              writelog('error', 'error.hubspot', `HubSpot PATCH failed (${hsRes.status}): ${hsRes.body?.message || '—'}`, { rep: getRepFromReq(req, body), quoteNum: quoteNumber, dealId: String(dealId || ''), meta: { status: hsRes.status, props: Object.keys(hsProps).join(',') } });
            }
          }

          // Seed tracking cache immediately when tracking number is present (non-blocking)
          if (sf.tracking) {
            (async () => {
              try {
                const cached = await getTrackingFromCache(sf.tracking);
                // Only fetch if not already cached with good data
                if (!cached || !cached.status || cached.status === 'pending') {
                  console.log(`[orders] seeding tracking cache for ${sf.tracking}`);
                  await fetchAndCacheTracking(sf.tracking, sf.carrier || updatedOrderData.shipped?.carrier || '');
                }
              } catch(e) { console.warn(`[orders] tracking cache seed error: ${e.message}`); }
            })();
          }
          // Address update
          if (customer?.address) {
            await httpsRequest({
              hostname: 'api.hubapi.com',
              path: `/crm/v3/objects/deals/${dealId}`,
              method: 'PATCH',
              headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
            }, {
              properties: {
                ...(customer.address ? { delivery_street: customer.address } : {}),
                ...(customer.city    ? { delivery_city:   customer.city    } : {}),
                ...(customer.state   ? { delivery_state:  customer.state   } : {}),
                ...(customer.zip     ? { delivery_zip:    customer.zip     } : {}),
              }
            });
          }
        } catch(e) { console.warn('HubSpot update failed:', e.message); }
      }

      console.log(`Order ${quoteNumber} updated${isNowShipped && !wasShipped ? ' → SHIPPED' : ''}`);
      if (isNowShipped && !wasShipped) {
        const _sf = updatedOrderData.shipped || {};
        writelog('info', 'order.shipped', `Shipped: ${quoteNumber} via ${_sf.carrier || '—'} PRO: ${_sf.tracking || '—'}`, { rep: repName || null, quoteNum: quoteNumber, dealId: String(dealId || ''), meta: { carrier: _sf.carrier, tracking: _sf.tracking, freightCost: updatedOrderData.freightCost } });
      }

      // Look up company from quotes table — orderData doesn't store it, quotes always does
      let orderCompany = currentOrderData.company || '';
      if (!orderCompany && db) {
        try {
          const cRow = await db.query('SELECT company, customer_name FROM quotes WHERE quote_number = $1 LIMIT 1', [quoteNumber]);
          orderCompany = cRow.rows[0]?.company || cRow.rows[0]?.customer_name || '';
        } catch(e) { /* non-fatal */ }
      }

      json({ success: true, shipped: isNowShipped, quoteNumber, company: orderCompany });

      // ── Accounting task when Jeromy ships ────────────────────────
      // Fire when: Ship It is clicked AND shipper is Jeromy (38732186)
      if (isNowShipped && !wasShipped && dealId) {
        (async () => {
          try {
            const sf2        = updatedOrderData.shipped || {};
            const serial     = updatedOrderData.serialNumber || currentOrderData.serialNumber || '—';
            const fc2        = updatedOrderData.freightCost   || currentOrderData.freightCost   || '—';
            const dealRow    = await db?.query('SELECT deal_name FROM quotes WHERE quote_number = $1 LIMIT 1', [quoteNumber]);
            const dealNameT  = dealRow?.rows[0]?.deal_name || quoteNumber;
            const fcDisplay  = fc2 !== '—' ? `$${parseFloat(fc2).toFixed(2)}` : '—';

            const taskBody = [
              `Deal: ${dealNameT}`,
              `Serial Number: ${serial}`,
              `Carrier: ${sf2.carrier || '—'}`,
              `PRO / Tracking: ${sf2.tracking || '—'}`,
              `Freight Cost: ${fcDisplay}`,
            ].join('\n');

            // Create HubSpot task assigned to Jeromy, associated to the deal
            const taskRes = await httpsRequest({
              hostname: 'api.hubapi.com',
              path: '/crm/v3/objects/tasks',
              method: 'POST',
              headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
            }, {
              properties: {
                hs_task_subject:   `📦 SHIPPED — ${dealNameT} — Notify accounting@whisperroom.com`,
                hs_task_body:      taskBody,
                hs_task_status:    'NOT_STARTED',
                hs_task_type:      'TODO',
                hs_task_priority:  'HIGH',
                hubspot_owner_id:  '38732178', // Kim Dalton — accounting@whisperroom.com
                hs_timestamp:      String(Date.now()),
              }
            });

            const taskId = taskRes.body?.id;
            if (taskId && dealId) {
              await httpsRequest({
                hostname: 'api.hubapi.com',
                path: '/crm/v4/associations/tasks/deals/batch/create',
                method: 'POST',
                headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
              }, {
                inputs: [{ from: { id: taskId }, to: { id: String(dealId) },
                  types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 216 }] }]
              });
            }

            // Also log an email engagement to accounting on the deal timeline
            await httpsRequest({
              hostname: 'api.hubapi.com',
              path: '/crm/v3/objects/emails',
              method: 'POST',
              headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
            }, {
              properties: {
                hs_email_direction: 'EMAIL',
                hs_email_status:    'SENT',
                hs_email_subject:   `📦 SHIPPED — ${dealNameT}`,
                hs_email_text:      taskBody,
                hs_email_to_email:  'accounting@whisperroom.com',
                hs_timestamp:       new Date().toISOString(),
              },
              associations: [{
                to: { id: String(dealId) },
                types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }]
              }]
            });

            console.log(`[orders] accounting task created for ${dealNameT} (task ${taskId})`);
          } catch(e) {
            console.warn('[orders] accounting task failed:', e.message);
          }
        })();
      }

      // Upload order PDF to Google Drive when shipped (non-blocking)
      if (isNowShipped && !wasShipped) {
        (async () => {
          try {
            const tokenRowO = await db?.query('SELECT share_token, deal_name FROM quotes WHERE quote_number = $1', [quoteNumber]);
            const tokenO    = tokenRowO?.rows[0]?.share_token || '';
            const dnO       = tokenRowO?.rows[0]?.deal_name   || quoteNumber;
            const orderUrl  = `https://sales.whisperroom.com/o/${encodeURIComponent(quoteNumber)}${tokenO ? '?t=' + tokenO : ''}`;
            const pdfBufO   = await generatePdfBuffer(orderUrl);
            const snapRowO  = await db?.query('SELECT json_snapshot FROM quotes WHERE quote_number = $1', [quoteNumber]);
            const snapO     = snapRowO?.rows[0]?.json_snapshot || {};
            await gdriveSavePdfToDeal(quoteNumber, 'Final Order', buildPdfFilename(snapO, quoteNumber, 'Order'), pdfBufO);
          } catch(e) {
            console.warn('GDrive order PDF error:', e.message);
            writelog('error', 'error.gdrive', `Drive order upload failed: ${e.message}`, { quoteNum: quoteNumber, meta: { step: 'order-pdf' } });
          }
        })();
      }

    } catch(e) {
      console.error('Update order error:', e.message);
      json({ error: e.message }, 500);
    }
    return;
  }


  // ── Order Page (/o/:quoteNumber) ─────────────────────────────────
  if (pathname.startsWith('/o/') && req.method === 'GET') {
    const quoteId = decodeURIComponent(pathname.replace('/o/', '').trim());
    if (!quoteId) { res.writeHead(404); res.end('Not found'); return; }
    try {
      let quoteData = await getQuoteFromDb(quoteId);

      // For HubSpot legacy orders (HS-{dealId}), quoteData won't exist
      // Allow auth'd reps through anyway — order data will render what's available
      if (!quoteData) {
        if (isAuth(req)) {
          // Create minimal quoteData from order if it exists
          if (db) {
            try {
              const or = await db.query('SELECT order_data, deal_id FROM orders WHERE quote_number = $1', [quoteId]);
              if (or.rows[0]) {
                quoteData = {
                  quoteNumber: quoteId,
                  dealName: or.rows[0].order_data?.dealName || quoteId,
                  customer: {},
                  lineItems: [],
                  _shareToken: null,
                };
              }
            } catch(e) {}
          }
        }
        if (!quoteData) {
          res.writeHead(404, { 'Content-Type': 'text/html' });
          res.end('<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px"><h2>Order Not Found</h2></body></html>');
          return;
        }
      }
      const oToken = new URLSearchParams(search).get('t');
      // Logged-in reps can always view order pages without token
      if (!isAuth(req) && !validateShareToken(quoteData, oToken)) {
        res.writeHead(403, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><head><title>Link Expired</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:#f5f5f5}div{text-align:center}</style></head><body><div><h2 style="color:#ee6216">This link is no longer valid</h2><p style="color:#888;margin-top:8px">Please contact your WhisperRoom representative for an updated link.</p></div></body></html>');
        return;
      }

      // Get order details from DB
      let orderData = null;
      if (db) {
        try {
          const or = await db.query('SELECT order_data FROM orders WHERE quote_number = $1', [quoteId]);
          if (or.rows[0]) orderData = or.rows[0].order_data;
        } catch(e) {}
      }

      const q = quoteData;
      const o = orderData || {};
      const fmt = n => '$' + parseFloat(n||0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,',');
      const fmtW = n => parseFloat(n||0) > 0 ? `${parseFloat(n).toLocaleString()} lbs` : '—';
      const sub = (q.lineItems||[]).reduce((s,i)=>s+(i.price*i.qty),0);
      const disc = q.discount && q.discount.value > 0
        ? (q.discount.type==='pct' ? sub*q.discount.value/100 : q.discount.value) : 0;
      const freightTbd = q.freight?.tbd === true;
      const freightAmt = (!freightTbd && q.freight) ? q.freight.total : 0;
      const taxAmt = q.tax ? q.tax.tax : 0;
      const total = sub - disc + freightAmt + taxAmt;
      const totalWeight = (q.lineItems||[]).reduce((s,i) => s + ((parseFloat(i.weight)||0) * (parseInt(i.qty)||1)), 0);
      const c = q.customer || {};
      const issueDate = new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric',timeZone:'America/New_York'});

      const lineRows = (q.lineItems||[]).map(item => {
        const itemWeight = parseFloat(item.weight)||0;
        const totalItemWeight = itemWeight * (parseInt(item.qty)||1);
        return `<tr>
          <td style="padding:12px 0;border-bottom:1px solid #f5f5f5;padding-right:12px">
            <div class="item-name">${item.name}</div>
            ${item.description?`<div class="item-desc">${item.description.replace(/\n/g,'<br>')}</div>`:''}
          </td>
          <td style="padding:12px 0;border-bottom:1px solid #f5f5f5;text-align:center;color:#888;width:40px">${item.qty}</td>
          <td style="padding:12px 0;border-bottom:1px solid #f5f5f5;text-align:right;color:#888;width:90px">${fmt(item.price)}</td>
          <td style="padding:12px 0;border-bottom:1px solid #f5f5f5;text-align:right;color:#aaa;width:80px">${itemWeight>0?fmtW(totalItemWeight):'—'}</td>
          <td style="padding:12px 0;border-bottom:1px solid #f5f5f5;text-align:right;font-weight:700;color:#1a1a1a;width:90px">${fmt(item.price*item.qty)}</td>
        </tr>`;
      }).join('');

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Order ${q.quoteNumber||''}</title>
<link rel="icon" href="/assets/favicon.avif">
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;0,9..40,800&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',-apple-system,sans-serif;background:#f7f6f4;color:#1a1a1a;-webkit-font-smoothing:antialiased}
.page{max-width:840px;margin:0 auto;padding:0 0 40px}
.header-card{background:#ffffff;padding:32px 40px 28px;margin-bottom:0;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:20px;border-left:6px solid transparent;border-image:linear-gradient(to bottom,#ee6216 0%,rgba(238,98,22,.15) 70%,transparent 100%) 1;box-shadow:0 2px 12px rgba(0,0,0,.08)}
.logo-img{height:40px;display:block}
.header-right{text-align:right}
.order-type{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.16em;color:#ee6216;margin-bottom:8px}
.order-num{font-size:34px;font-weight:800;color:#1a1a1a;letter-spacing:-.8px;line-height:1}
.order-meta{font-size:12px;color:#aaa;margin-top:6px}
.order-tag{display:inline-block;margin-top:8px;background:#1a7a4a;color:white;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;padding:4px 12px;border-radius:3px}
.accent-strip{height:1px;background:#eee;margin-bottom:20px}
.card{background:#fff;border-radius:10px;padding:28px 32px;margin:0 0 12px;box-shadow:0 1px 4px rgba(0,0,0,.06);border:1px solid #f0f0f0}
.card-label{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;color:#ee6216;margin-bottom:16px}
.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.info-item label{font-size:10px;color:#bbb;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:4px}
.info-item span{font-size:14px;font-weight:600;color:#1a1a1a}
.notes-box{background:#f9f8f6;border-radius:8px;padding:14px 16px;font-size:13px;color:#555;line-height:1.6;border:1px solid #ede9e3}
table{width:100%;border-collapse:collapse}
thead th{font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;color:#ccc;padding:0 0 14px;border-bottom:2px solid #f5f5f5;text-align:left}
thead th:nth-child(2),thead th:nth-child(3),thead th:nth-child(4),thead th:nth-child(5){text-align:right}
thead th:nth-child(2){text-align:center}
tbody tr:last-child td{border-bottom:none}
.item-name{font-weight:700;color:#1a1a1a;font-size:14px}
.item-desc{font-size:11px;color:#bbb;margin-top:4px;line-height:1.6}
.totals{max-width:320px;margin-left:auto;margin-top:24px;padding-top:18px;border-top:2px solid #f5f5f5}
.tot{display:flex;justify-content:space-between;padding:6px 0;font-size:13px;color:#999}
.tot.grand{font-size:24px;font-weight:800;color:#1a1a1a;padding-top:16px;margin-top:8px;border-top:2px solid #1a1a1a}
.tot.grand span:last-child{color:#ee6216}
.tot.weight-total{font-size:14px;font-weight:700;color:#555;border-top:1px solid #eee;margin-top:8px;padding-top:10px}
.discount-val{color:#1a7a4a!important;font-weight:600}
.footer{text-align:center;margin:24px 0 0;padding:24px 32px;font-size:11px;color:#bbb;line-height:2.1;border-top:1px solid #ece9e4}
.footer a{color:#ee6216;text-decoration:none}
.footer strong{color:#888;font-weight:600}
@media(max-width:600px){
  .header-card{padding:24px 20px}
  .logo-img{height:30px}
  .header-right{text-align:left}
  .order-num{font-size:26px}
  .card{padding:20px}
  .info-grid{grid-template-columns:1fr}
}
@media print{
  body{background:white}
  .header-card{border-left:6px solid #ee6216!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .card{box-shadow:none}
}
</style>
</head>
<body>
<div class="page">

  <div class="header-card">
    <img src="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTUwIiBoZWlnaHQ9IjMxIiB2aWV3Qm94PSIwIDAgMTUwIDMxIiBmaWxsPSJub25lIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPgo8cGF0aCBkPSJNNDMuNzg4NiAxNC45NjdDNDMuNjI0MiAxNC43OTgzIDQzLjUwOTEgMTQuNTQ1MSA0My40NTk4IDE0LjMwODhDNDMuMzYxMSAxMy44MzYzIDQzLjQ3NjIgMTMuMzYzNyA0My42NzM2IDEyLjk0MThDNDQuMDAyNCAxMi4yNDk4IDQ0LjU5NDMgMTEuNzA5OCA0NS4yNTIgMTEuMzcyM0M0NS43NDUzIDExLjEzNiA0Ni4yODc5IDExLjAwMSA0Ni44MzA1IDExLjA1MTZDNDcuMjQxNiAxMS4xMDIyIDQ3LjY2OTEgMTEuMjU0MSA0Ny45NDg2IDExLjU0MUM0OC4xMjk1IDExLjcyNjcgNDguMjYxMSAxMS45Nzk4IDQ4LjMyNjggMTIuMjMzQzQ4LjQ0MTkgMTIuNzM5MyA0OC4zMTA0IDEzLjMzIDQ4LjAzMDkgMTMuNzY4OEM0Ny43NTEzIDE0LjIyNDQgNDcuMzA3NCAxNC41MjgyIDQ2Ljg0NyAxNC43ODE0QzQ2LjI3MTUgMTUuMDg1MiA0NS42Nzk2IDE1LjMwNDYgNDUuMDA1NCAxNS4zMzgzQzQ0LjU3NzkgMTUuMzU1MiA0NC4wODQ2IDE1LjI4NzcgNDMuNzg4NiAxNC45NjdaIiBmaWxsPSIjMjYyNjI2Ii8+CjxwYXRoIGQ9Ik0zMi4xMzc3IDEyLjM1MjdDMzIuMjIxNCAxMi4zMzYxIDMyLjMyMTggMTIuMzE5NSAzMi4zODg3IDEyLjM1MjdDMzIuNTIyNSAxMi40MDI1IDMyLjU3MjggMTIuNTg1MSAzMi42MDYyIDEyLjczNDZDMzIuNjM5NyAxMi44Njc0IDMyLjY1NjQgMTIuOTgzNiAzMi42NzMxIDEzLjA5OTlDMzIuNzA2NiAxMy40MTU0IDMyLjc0MDEgMTMuNzQ3NSAzMi43NTY4IDE0LjA3OTVDMzIuODIzNyAxNC45NTk2IDMyLjg0MDUgMTUuODIzIDMyLjg3MzkgMTYuNjg2NEMzMi45MDc0IDE4LjE2NDIgMzIuOTQwOSAxOS42NDIgMzIuOTI0MSAyMS4xMTk4QzMyLjkyNDEgMjEuODY3IDMyLjkwNzQgMjIuNTk3NiAzMi44OTA3IDIzLjM0NDhDMzIuODkwNyAyMy42MTA1IDMyLjg5MDcgMjMuODc2MSAzMi44NzM5IDI0LjE0MThDMzIuODU3MiAyNC4zMDc4IDMyLjg1NzIgMjQuNDkwNSAzMi44MjM3IDI0LjY1NjVDMzIuODA3IDI0LjgyMjYgMzIuNzU2OCAyNC45ODg2IDMyLjY4OTkgMjUuMTIxNUMzMi42MjMgMjUuMjcwOSAzMi41MDU4IDI1LjQwMzcgMzIuMzg4NyAyNS41MkMzMi4zMDUgMjUuNjAzIDMyLjIyMTQgMjUuNjg2IDMyLjEzNzcgMjUuNzY5QzMzLjg3NzkgMjUuNzY5IDM1LjYwMTQgMjUuNzY5IDM3LjM0MTYgMjUuNzY5QzM3LjIwNzcgMjUuNjUyOCAzNy4wOTA2IDI1LjUyIDM2Ljk3MzUgMjUuMzg3MUMzNi44NTYzIDI1LjI1NDMgMzYuNzU1OSAyNS4xMDQ5IDM2LjcwNTcgMjQuOTM4OEMzNi42NTU1IDI0Ljc1NjIgMzYuNjM4OCAyNC41NzM1IDM2LjYzODggMjQuMzkwOUMzNi42Mzg4IDIzLjk5MjQgMzYuNjM4OCAyMy42MTA1IDM2LjY1NTUgMjMuMjI4NkMzNi42NzIzIDIyLjQ4MTQgMzYuNjU1NSAyMS43MTc2IDM2LjY1NTUgMjAuOTcwNEMzNi42NTU1IDIwLjUzODYgMzYuNjcyMyAyMC4xMjM1IDM2LjY1NTUgMTkuNjkxOEMzNi42NTU1IDE5LjU1OSAzNi42NTU1IDE5LjQyNjEgMzYuNjU1NSAxOS4yNzY3QzM2LjY3MjMgMTkuMTEwNyAzNi42ODkgMTguOTQ0NiAzNi43NTU5IDE4Ljc5NTJDMzYuODIyOSAxOC42NDU3IDM2LjkyMzMgMTguNTEyOSAzNy4wNDA0IDE4LjM5NjdDMzcuMjU3OSAxOC4xOTc0IDM3LjU1OTEgMTguMTE0NCAzNy44NjAzIDE4LjA5NzhDMzguMDc3OCAxOC4wOTc4IDM4LjI5NTQgMTguMTMxIDM4LjQ3OTQgMTguMjMwNkMzOC42ODAyIDE4LjMzMDMgMzguODQ3NSAxOC40OTYzIDM4Ljk0NzkgMTguNjk1NkMzOS4wNjUxIDE4LjkxMTQgMzkuMDk4NSAxOS4xNDM5IDM5LjExNTMgMTkuMzkyOUMzOS4xMzIgMTkuNTU5IDM5LjExNTMgMTkuNzI1IDM5LjExNTMgMTkuODkxMUMzOS4xMTUzIDIwLjIwNjYgMzkuMTE1MyAyMC41MDU0IDM5LjExNTMgMjAuODIwOUMzOS4xMTUzIDIxLjE4NjIgMzkuMTE1MyAyMS41NjgxIDM5LjExNTMgMjEuOTMzNEMzOS4xMTUzIDIyLjM2NTEgMzkuMTE1MyAyMi44MTM0IDM5LjExNTMgMjMuMjQ1MkMzOS4xMTUzIDIzLjYxMDUgMzkuMTE1MyAyMy45NTkxIDM5LjExNTMgMjQuMzI0NEMzOS4xMTUzIDI0LjQ3MzkgMzkuMTE1MyAyNC42MjMzIDM5LjA4MTggMjQuNzcyOEMzOS4wNDgzIDI0LjkzODggMzguOTY0NyAyNS4wODgyIDM4Ljg2NDMgMjUuMjIxMUMzOC43NDcxIDI1LjM4NzEgMzguNjMgMjUuNTM2NiAzOC40Nzk0IDI1LjY2OTRDMzguNDQ1OSAyNS43MDI2IDM4LjM5NTcgMjUuNzM1OCAzOC4zNjIzIDI1Ljc2OUM0MC44ODg5IDI1Ljc2OSA0My40MzIzIDI1Ljc2OSA0NS45NTkgMjUuNzY5QzQ2LjQ5NDQgMjUuNzY5IDQ3LjAxMzEgMjUuNzY5IDQ3LjU0ODYgMjUuNzY5QzQ3Ljk1MDIgMjUuNzY5IDQ4LjMzNSAyNS43NjkgNDguNzM2NiAyNS43NjlDNDguODcwNCAyNS43NjkgNDguOTg3NiAyNS43NjkgNDkuMTIxNCAyNS43NjlDNDkuMDcxMiAyNS42ODYgNDkuMDIxIDI1LjYwMyA0OC45NzA4IDI1LjUzNjZDNDguODg3MiAyNS40MjAzIDQ4Ljc3MDEgMjUuMzIwNyA0OC42ODY0IDI1LjIyMTFDNDguNjE5NSAyNS4xNTQ3IDQ4LjU2OTMgMjUuMDcxNiA0OC41MzU4IDI0Ljk4ODZDNDguNDM1NCAyNC43NTYyIDQ4LjQwMTkgMjQuNTA3MSA0OC4zODUyIDI0LjI1OEM0OC4zODUyIDI0LjE3NSA0OC4zNjg1IDI0LjA5MiA0OC4zNjg1IDI0LjAwOUM0OC4zNTE3IDIzLjgwOTcgNDguMzY4NSAyMy41OTM4IDQ4LjM2ODUgMjMuMzk0NkM0OC4zNjg1IDIzLjA0NTkgNDguMzY4NSAyMi43MTM4IDQ4LjM2ODUgMjIuMzY1MUM0OC4zNTE3IDIwLjgyMDkgNDguMzY4NSAxOS4yNjAxIDQ4LjM2ODUgMTcuNzE1OUM0OC4zNjg1IDE3LjU4MzEgNDguMzY4NSAxNy40NTAyIDQ4LjM2ODUgMTcuMzE3NEM0OC4zNjg1IDE3LjA2ODMgNDguMzg1MiAxNi44MTkzIDQ4LjQxODcgMTYuNTcwMkM0OC40MzU0IDE2LjQzNzQgNDguNDUyMSAxNi4zMDQ1IDQ4LjQ2ODkgMTYuMTU1MUM0OC40ODU2IDE2LjAyMjMgNDguNTAyMyAxNS44NzI4IDQ4LjQzNTQgMTUuNzU2NkM0OC4zODUyIDE1LjY1NyA0OC4yODQ4IDE1LjU5MDUgNDguMTY3NyAxNS41NTczQzQ4LjAzMzggMTUuNTI0MSA0Ny44ODMyIDE1LjU1NzMgNDcuNzQ5NCAxNS41OTA1QzQ3LjU0ODYgMTUuNjQwMyA0Ny4zODEyIDE1LjY3MzYgNDcuMTYzNyAxNS42OTAyQzQ3LjA2MzMgMTUuNzA2OCA0Ni45NDYyIDE1LjcwNjggNDYuODI5MSAxNS43MDY4QzQ2LjE1OTcgMTUuNzQgNDUuNTc0MSAxNS43NTY2IDQ0Ljk3MTcgMTUuNzU2NkM0NC43NTQyIDE1Ljc1NjYgNDQuNTUzNCAxNS43NTY2IDQ0LjMzNTkgMTUuNzU2NkM0NC4yMDIgMTUuNzU2NiA0NC4wNjgxIDE1Ljc1NjYgNDMuOTM0MyAxNS43NTY2QzQzLjg1MDYgMTUuNzU2NiA0My43NjcgMTUuNzU2NiA0My42ODMzIDE1Ljc3MzJDNDMuNjE2NCAxNS43ODk4IDQzLjU0OTQgMTUuNzg5OCA0My40OTkyIDE1LjgzOTZDNDMuNDMyMyAxNS45MDYgNDMuMzk4OCAxNi4wMDU2IDQzLjM5ODggMTYuMTA1M0M0My40MTU2IDE2LjI3MTMgNDMuNTE2IDE2LjM4NzUgNDMuNjE2NCAxNi41MDM4QzQzLjczMzUgMTYuNjUzMiA0My44MzM5IDE2Ljc4NiA0My45MTc2IDE2LjkxODlDNDMuOTY3OCAxNi45ODUzIDQ0LjAxOCAxNy4wNTE3IDQ0LjA1MTQgMTcuMjE3OEM0NC4wNjgxIDE3LjMzNCA0NC4wODQ5IDE3LjUxNjYgNDQuMTAxNiAxNy42NjYxQzQ0LjEzNTEgMTguMDQ4IDQ0LjExODQgMTguMTgwOCA0NC4xMTg0IDE4LjMzMDNDNDQuMTAxNiAxOS4wNDQyIDQ0LjExODQgMjAuMDU3MSA0NC4xMTg0IDIxLjA1MzRDNDQuMTE4NCAyMS4zODU1IDQ0LjExODQgMjEuNzAxIDQ0LjExODQgMjIuMDMzQzQ0LjExODQgMjIuNTQ3OCA0NC4xMTg0IDIzLjA0NTkgNDQuMTE4NCAyMy41NjA2QzQ0LjExODQgMjMuNjkzNSA0NC4xMTg0IDIzLjgyNjMgNDQuMTE4NCAyMy45NDI1QzQ0LjExODQgMjQuMDkyIDQ0LjEwMTYgMjQuMjQxNCA0NC4wNjgyIDI0LjM5MDlDNDQuMDM0NyAyNC41NTY5IDQ0LjAwMTIgMjQuNzA2MyA0My45MTc2IDI0Ljg3MjRDNDMuODE3MiAyNS4wNTUgNDMuNjY2NiAyNS4yNTQzIDQzLjUzMjcgMjUuMjU0M0M0My4zOTg4IDI1LjIzNzcgNDMuMjgxNyAyNS4wMzg0IDQzLjE5OCAyNC44NzI0QzQzLjEzMTEgMjQuNzIzIDQzLjA5NzYgMjQuNTkwMSA0My4wOTc2IDI0LjQ1NzNDNDMuMDgwOSAyNC4zMDc4IDQzLjA4MDkgMjQuMTI1MiA0My4wODA5IDIzLjk1OTFDNDMuMDgwOSAyMi44NjMzIDQzLjA4MDkgMjEuODAwNiA0My4wODA5IDIwLjczNzlDNDMuMDgwOSAyMC4zMDYyIDQzLjA4MDkgMTkuODU3OSA0My4wODA5IDE5LjQyNjFDNDMuMDgwOSAxOS4yNzY3IDQzLjA4MDkgMTkuMTQzOSA0My4wODA5IDE4Ljk5NDRDNDMuMDY0MiAxOC41NDYxIDQzLjAxNCAxOC4wOTc4IDQyLjg0NjcgMTcuNjgyN0M0Mi41NDU1IDE2Ljk2ODcgNDEuODkyOSAxNi4zODc1IDQxLjE1NjcgMTYuMDM4OUM0MC42NzE0IDE1LjgwNjQgNDAuMTUyNyAxNS42OTAyIDM5LjYxNzIgMTUuNjU3QzM4Ljk5ODEgMTUuNjIzNyAzOC4zNjIzIDE1LjcwNjggMzcuNzU5OSAxNS44NzI4QzM3LjQwODUgMTUuOTU1OCAzNy4wNzM5IDE2LjA3MjEgMzYuNzU1OSAxNi4yMDQ5QzM2Ljc1NTkgMTUuNDkwOSAzNi43NzI3IDE0Ljc3NjkgMzYuNzcyNyAxNC4wNzk1QzM2Ljc3MjcgMTMuNzgwNyAzNi43NzI3IDEzLjQ5ODQgMzYuNzg5NCAxMy4xOTk1QzM2Ljc4OTQgMTMuMDgzMyAzNi44MDYxIDEyLjk4MzYgMzYuODA2MSAxMi44Njc0QzM2LjgyMjkgMTIuNjY4MiAzNi44MjI5IDEyLjQ2ODkgMzYuODU2MyAxMi4yNjk3QzM2Ljg3MzEgMTIuMDcwNCAzNi45MDY1IDExLjg1NDUgMzYuODM5NiAxMS43MzgzQzM2LjgwNjEgMTEuNjcxOSAzNi43NTU5IDExLjYzODcgMzYuNjcyMyAxMS42MDU1QzM2LjUzODQgMTEuNTU1NyAzNi4zNzExIDExLjU4ODkgMzYuMjAzOCAxMS42MjIxQzM2LjA1MzIgMTEuNjU1MyAzNS45MTkzIDExLjY3MTkgMzUuNzY4NyAxMS43MDUxQzM1LjYwMTQgMTEuNzM4MyAzNS40MzQgMTEuNzM4MyAzNS4yNjY3IDExLjc1NDlDMzQuOTMyMSAxMS43NzE1IDM0LjYxNDIgMTEuNzcxNSAzNC4yNzk1IDExLjc3MTVDMzMuNjQzNyAxMS43ODgxIDMzLjAwNzggMTEuNzg4MSAzMi4zNzIgMTEuNzg4MUMzMi4yNTQ4IDExLjk3MDggMzIuMjA0NiAxMi4xNTM0IDMyLjEzNzcgMTIuMzUyN1oiIGZpbGw9IiMyNjI2MjYiLz4KPHBhdGggZD0iTTEyLjg0ODYgMTguMDkyOEMxMy40NDMgMTUuODc4NyAxNC4wMTM3IDEzLjY4ODMgMTQuNTM2OCAxMS40NzQyQzE0LjY1NTcgMTAuOTc0MiAxNC43NzQ2IDEwLjQ3NDMgMTQuODkzNSA5Ljk5ODExQzE1LjA2IDkuMzU1MjkgMTUuMjI2NCA4LjczNjI4IDE1LjM5MjkgOC4xMTcyN0MxNS41MTE3IDcuNjY0OTIgMTUuNjA2OSA3LjIxMjU3IDE1LjcyNTcgNi43NjAyMkMxNS43OTcxIDYuNDUwNzIgMTUuODY4NCA2LjE2NTAyIDE1LjkxNiA1Ljg1NTUxQzE1Ljk2MzUgNS41OTM2MiAxNi4wMTExIDUuMzU1NTUgMTYuMDExMSA1LjA5MzY2QzE2LjAxMTEgNC43ODQxNiAxNS45NjM1IDQuNDUwODQgMTUuODkyMiA0LjE0MTM0QzE1LjgyMDkgMy43ODQyMiAxNS43MjU3IDMuNDUwOSAxNS41ODMxIDMuMTE3NTlDMTUuMjc0IDIuMzA4MTIgMTQuNzc0NiAxLjU3MDA3IDE0LjE1NjQgMC45NzQ4NzNDMTYuOTg2IDAuOTc0ODczIDE5LjgzOTQgMC45NzQ4NzMgMjIuNjY5IDAuOTc0ODczQzIyLjU5NzYgMS4wOTM5MSAyMi41MjYzIDEuMjEyOTUgMjIuNTAyNSAxLjM1NThDMjIuNDMxMiAxLjYxNzY5IDIyLjQwNzQgMS44Nzk1OCAyMi40MDc0IDIuMTY1MjdDMjIuNDMxMiAyLjg3OTUxIDIyLjU3MzkgMy41Njk5NSAyMi43NjQxIDQuMjM2NTdDMjIuOTc4MSA1LjA0NjA0IDIzLjIxNTkgNS44NTU1MiAyMy40NTM3IDYuNjY0OTlDMjMuODEwMyA3Ljg1NTM5IDI0LjE5MDggOS4wNjk1OSAyNC41NDc1IDEwLjI2QzI1LjMwODQgMTIuNzU5OCAyNi4wMjE3IDE1LjI1OTcgMjYuNzM1IDE3Ljc1OTVDMjcuMzUzMyAxNS4zNTQ5IDI3Ljk5NTMgMTIuOTUwMyAyOC43MzI0IDEwLjU2OTVDMjguODUxMyAxMC4xNDEgMjguOTk0IDkuNzEyNDEgMjkuMTEyOSA5LjI4Mzg3QzI5LjMyNjkgOC41NDU4MiAyOS41MTcxIDcuNzgzOTYgMjkuNzMxMSA3LjA0NTkxQzI5Ljg3MzggNi41Njk3NSAzMC4wMTY0IDYuMDkzNTkgMzAuMTM1MyA1LjYxNzQzQzMwLjIzMDQgNS4xODg4OSAzMC4zMjU2IDQuNzYwMzUgMzAuMzQ5MyA0LjMzMThDMzAuMzczMSAzLjk5ODQ5IDMwLjM3MzEgMy42NjUxOCAzMC4zMjU2IDMuMzMxODdDMzAuMjU0MiAyLjkyNzEzIDMwLjA4NzggMi41MjI0IDI5Ljg3MzggMi4xNDE0N0MyOS43MDczIDEuODc5NTggMjkuNTQwOSAxLjYxNzY5IDI5LjMyNjkgMS4zNzk2MUMyOS4yMDggMS4yMTI5NiAyOS4wNjUzIDEuMDcwMTEgMjguOTIyNiAwLjkyNzI2MkMzMC42MzQ3IDAuOTI3MjYyIDMyLjMyMjkgMC45MjcyNjIgMzQuMDM1IDAuOTI3MjYyQzM0LjMyMDMgMC45MjcyNjIgMzQuNTgxOSAwLjkyNzI2MiAzNC44NjcyIDAuOTI3MjYyQzM1LjEyODggMC45MjcyNjIgMzUuMzY2NSAwLjkwMzQ1MSAzNS42MjgxIDAuOTk4NjgzQzM1LjY3NTcgMS4wMjI0OSAzNS43MjMyIDEuMDIyNDkgMzUuNzQ3IDEuMDQ2M0MzNS44NDIxIDEuMTQxNTMgMzUuNzcwOCAxLjMzMiAzNS43MjMyIDEuNDk4NjVDMzUuNjI4MSAxLjc4NDM1IDM1LjU1NjggMi4wMjI0MyAzNS40NjE3IDIuMjM2N0MzMy4zNDU0IDguNjY0ODYgMzAuOTQzOCAxNi40NzM5IDI4Ljc4IDIzLjYxNjNDMjguNjYxMSAyNC4wNDQ4IDI4LjUxODQgMjQuNDQ5NiAyOC4zOTk1IDI0Ljg3ODFDMjguMzI4MiAyNS4wOTI0IDI4LjI4MDYgMjUuMzA2NiAyOC4yMDkzIDI1LjQ5NzFDMjguMTYxNyAyNS42MTYxIDI4LjExNDIgMjUuNzM1MiAyOC4wNjY2IDI1Ljg1NDJDMjguMDE5MSAyNS45NzMzIDI3Ljk3MTUgMjYuMTE2MSAyNy44NzY0IDI2LjE2MzdDMjcuNzU3NSAyNi4yMzUyIDI3LjU2NzMgMjYuMTg3NSAyNy40MDA4IDI2LjEzOTlDMjYuODc3NyAyNS45OTcxIDI2LjQ5NzMgMjUuODU0MiAyNi4wNjkzIDI1LjY2MzhDMjUuMzU1OSAyNS4zNTQzIDI0LjU5NSAyNC45NzMzIDIzLjg4MTcgMjQuNTQ0OEMyMy4yODcyIDI0LjE4NzcgMjIuNjkyOCAyMy44MDY3IDIyLjI2NDcgMjMuMjgzQzIxLjkwODEgMjIuODU0NCAyMS42NzAzIDIyLjMzMDYgMjEuNDU2MyAyMS44MDY5QzIxLjA3NTggMjAuOTAyMiAyMC43OTA1IDE5Ljk3MzcgMjAuNDgxNCAxOS4wNDUxQzIwLjA3NzIgMTcuODA3MSAxOS42NzI5IDE2LjU0NTMgMTkuMjkyNSAxNS4zMDczQzE4Ljg4ODIgMTMuOTc0IDE4LjUwNzggMTIuNjQwOCAxOC4xNzQ5IDExLjI4MzdDMTcuOTg0NyAxMS45NTA0IDE3Ljc5NDQgMTIuNjQwOCAxNy42MDQyIDEzLjMwNzRDMTcuMjk1MSAxNC40MDI2IDE3LjAwOTggMTUuNDczOSAxNi43MjQ0IDE2LjU2OTFDMTYuNDYyOSAxNy41NjkgMTYuMjI1MSAxOC41NDUyIDE1Ljk2MzUgMTkuNTQ1MUMxNS43NDk1IDIwLjQwMjIgMTUuNTExNyAyMS4yNTkzIDE1LjI3NCAyMi4wOTI2QzE1LjEwNzUgMjIuNzExNiAxNC45NjQ4IDIzLjMzMDYgMTQuODIyMiAyMy45MjU4QzE0Ljc1MDggMjQuMjM1MyAxNC42NTU3IDI0LjU2ODYgMTQuNTg0NCAyNC44NzgxQzE0LjUzNjggMjUuMTE2MiAxNC40NjU1IDI1LjMzMDUgMTQuNDE3OSAyNS41Njg1QzE0LjM5NDIgMjUuNjYzOCAxNC4zNzA0IDI1LjczNTIgMTQuMzQ2NiAyNS44MDY2QzE0LjMyMjggMjUuODU0MiAxNC4yNzUzIDI1LjkwMTggMTQuMjI3NyAyNS45NDk1QzE0LjA4NTEgMjYuMDY4NSAxMy44NDczIDI2LjA0NDcgMTMuNjA5NSAyNS45OTcxQzEzLjAzODggMjUuODc4IDEyLjU2MzIgMjUuNzExNCAxMi4wODc3IDI1LjQ5NzFDMTEuMjMxNyAyNS4xNCAxMC4zNTE5IDI0LjY4NzYgOS41NDM0MSAyNC4xNDAxQzkuMTg2NzQgMjMuOTAyIDguODUzODQgMjMuNjE2MyA4LjU2ODUgMjMuMzA2OEM4LjE4ODA1IDIyLjkwMiA3Ljg1NTE2IDIyLjQwMjEgNy41OTM2IDIxLjkwMjFDNy4xMTgwMyAyMS4wMjEyIDYuODA4OTIgMjAuMDkyNyA2LjQ3NjAzIDE5LjE0MDRDNi4wOTU1NyAxOC4wNDUyIDUuNzE1MTIgMTYuOTczOCA1LjMzNDY3IDE1Ljg3ODdDNC40MDczMiAxMy4xNDA4IDMuNTk4ODYgMTAuMzU1MiAyLjk1Njg1IDcuNTQ1ODhDMi43OTA0IDYuODU1NDUgMi42NDc3MyA2LjE2NTAyIDIuNTI4ODQgNS40NzQ1OUMyLjQ4MTI5IDUuMjEyNyAyLjQzMzczIDQuOTc0NjIgMi4zNjIzOSA0LjcxMjczQzIuMjY3MjggNC40MDMyMyAyLjEyNDYyIDQuMTQxMzQgMS45ODE5NSAzLjg1NTY0QzEuNjQ5MDUgMy4xODkwMiAxLjMzOTkzIDIuNDk4NTkgMC44NjQzNjggMS45NTFDMC42NzQxNDIgMS43MzY3MyAwLjQ2MDEzNiAxLjUyMjQ2IDAuMjIyMzU0IDEuMzMxOTlDMC4xNTEwMTkgMS4yNjA1NyAwLjA3OTY4ODcgMS4yMTI5NSAwLjA1NTkxMDUgMS4xMTc3MkMwLjAwODM1NDEzIDEuMDIyNDkgLTAuMDE1NDI3IDAuOTI3MjYzIDAuMDA4MzUxMjMgMC44MzIwMzFDMS43Njc5NCAwLjgzMjAzMSAzLjUwMzc1IDAuODMyMDMxIDUuMjYzMzQgMC44MzIwMzFDNS45MjkxMiAwLjgzMjAzMSA2LjU3MTE0IDAuODMyMDMxIDcuMjEzMTUgMC44MzIwMzFDNy40MDMzOCAwLjgzMjAzMSA3LjU5MzYgMC44MzIwMzEgNy44MDc2MSAwLjgzMjAzMUM3Ljk1MDI3IDAuODMyMDMxIDguMDkyOTQgMC44MzIwMjcgOC4yMTE4MyAwLjg3OTY0M0M4LjMzMDcyIDAuOTI3MjU5IDguNDI1ODQgMS4wNDYzIDguNDk3MTcgMS4xODkxNUM4LjYxNjA2IDEuMzc5NjIgOC42NjM2MiAxLjYxNzY5IDguNzExMTcgMS44MzE5NkM4LjkyNTE4IDIuNzEyODYgOS4xNjI5NiAzLjU0NjE0IDkuNDI0NTIgNC4zNzk0MkMxMC43MzIzIDkuMDIxOTggMTEuNjgzNCAxMy41OTMxIDEyLjg0ODYgMTguMDkyOFoiIGZpbGw9IiMyNjI2MjYiLz4KPHBhdGggZD0iTTQ4LjY4OTUgMjMuMTUzOUM0OS4wMzg0IDIzLjM0NyA0OS40MjYgMjMuNTQwMSA0OS43NzQ5IDIzLjY5NDZDNTAuMDQ2MyAyMy44NDkgNTAuMzU2NCAyMy45NjQ5IDUwLjYyNzggMjQuMDgwN0M1MS4wMTU1IDI0LjE5NjYgNTEuNDAzMSAyNC4yNzM4IDUxLjc5MDggMjQuMzEyNEM1Mi4yOTQ4IDI0LjM4OTcgNTIuODM3NSAyNC40MjgzIDUzLjM0MTUgMjQuMjM1MkM1My41MzUzIDI0LjE1OCA1My43MjkyIDI0LjA4MDcgNTMuODQ1NSAyMy45MjYzQzUzLjkyMyAyMy43NzE4IDUzLjk2MTggMjMuNjE3MyA1My45NjE4IDIzLjQyNDJDNTMuOTYxOCAyMy4yNjk4IDUzLjg4NDIgMjMuMTE1MyA1My44MDY3IDIyLjk5OTRDNTMuNjkwNCAyMi44NDUgNTMuNDk2NiAyMi43Njc3IDUzLjMwMjcgMjIuNjkwNUM1Mi43OTg4IDIyLjQ1ODggNTIuMzMzNiAyMi4yMjcxIDUxLjg2ODMgMjEuOTk1NEM1MS40NDE5IDIxLjgwMjMgNTAuOTc2NyAyMS42MDkyIDUwLjU1MDMgMjEuMzc3NUM1MC4yNDAxIDIxLjE4NDQgNDkuOTMgMjAuOTkxMyA0OS42NTg2IDIwLjcyMUM0OS4zNDg1IDIwLjQxMjEgNDkuMTE1OSAyMC4wMjU5IDQ4Ljk5OTYgMTkuNjAxMUM0OC44ODMzIDE5LjE3NjMgNDguOTIyMSAxOC43MTI5IDQ5LjAzODQgMTguMjQ5NUM0OS4xOTM0IDE3Ljc4NjEgNDkuNDY0OCAxNy4zNjEzIDQ5Ljc3NDkgMTcuMDEzN0M1MC4zOTUyIDE2LjM5NTggNTEuMjA5MyAxNi4wMDk3IDUyLjA2MjIgMTUuODE2NkM1Mi42NDM3IDE1LjcwMDcgNTMuMTg2NCAxNS42NjIxIDUzLjc2NzkgMTUuNjYyMUM1NC4zNDk0IDE1LjY2MjEgNTQuOTY5NyAxNS43MDA3IDU1LjQ3MzcgMTUuNzc4QzU1LjY2NzUgMTUuODE2NiA1NS44NjEzIDE1Ljg1NTIgNTYuMTMyNyAxNS44OTM4QzU2LjMyNjYgMTUuOTMyNCA1Ni41NTkyIDE2LjAwOTcgNTYuNzE0MiAxNi4wODY5QzU2Ljc5MTggMTYuMTI1NSA1Ni44NjkzIDE2LjIwMjggNTYuOTQ2OCAxNi4zMTg2QzU2Ljk4NTYgMTYuMzk1OCA1Ny4wMjQ0IDE2LjQ3MzEgNTcuMDI0NCAxNi41ODg5QzU3LjAyNDQgMTYuNjY2MiA1Ny4wMjQ0IDE2Ljc0MzQgNTcuMDI0NCAxNi44MjA2QzU3LjAyNDQgMTcuMzk5OSA1Ny4wMjQ0IDE3Ljk0MDYgNTcuMDI0NCAxOC41MTk4QzU2Ljc5MTcgMTguMzY1MyA1Ni41OTc5IDE4LjI0OTUgNTYuMzY1MyAxOC4xMzM2QzU2LjA5MzkgMTguMDE3OCA1NS44MjI2IDE3LjkwMTkgNTUuNTUxMiAxNy44MjQ3QzU1LjA4NiAxNy43MDg4IDU0LjY1OTYgMTcuNjcwMiA1NC4xOTQ0IDE3LjY3MDJDNTMuOTYxOCAxNy42NzAyIDUzLjcyOTIgMTcuNzA4OCA1My40OTY2IDE3Ljc4NjFDNTMuMzAyNyAxNy44NjMzIDUzLjEwODkgMTguMDE3OCA1My4wNzAxIDE4LjIxMDlDNTMuMDMxMyAxOC4zNjUzIDUzLjEwODkgMTguNTk3IDUzLjE4NjQgMTguNzEyOUM1My4zNDE1IDE4Ljk0NDYgNTMuNjEyOSAxOS4wMjE4IDUzLjg4NDIgMTkuMTM3N0M1NC40MjcgMTkuMzMwOCA1NC45Njk3IDE5LjQ4NTMgNTUuNTEyNSAxOS42NzgzQzU1LjkzODkgMTkuODMyOCA1Ni4zNjUzIDIwLjAyNTkgNTYuNzUzIDIwLjI1NzZDNTcuMjk1NyAyMC42MDUyIDU3Ljc5OTcgMjEuMTA3MiA1OC4wNzExIDIxLjcyNTFDNTguMzQyNCAyMi4zODE2IDU4LjMwMzcgMjMuMTUzOSA1OC4wMzIzIDIzLjc3MThDNTcuNzYwOSAyNC4zODk3IDU3LjI1NyAyNC44OTE3IDU2LjY3NTUgMjUuMjM5M0M1Ni4xMzI3IDI1LjU4NjggNTUuNTEyNCAyNS43Nzk5IDU0Ljg5MjIgMjUuODk1N0M1NC4xOTQ0IDI2LjA1MDIgNTMuNDU3OCAyNi4wODg4IDUyLjc2IDI2LjA4ODhDNTEuOTQ1OSAyNi4wODg4IDUxLjEzMTggMjUuOTczIDUwLjM5NTIgMjUuODU3MUM1MC4xMjM4IDI1LjgxODUgNDkuODUyNSAyNS43Nzk5IDQ5LjU0MjMgMjUuNzAyN0M0OS40MjYgMjUuNjY0IDQ5LjM0ODUgMjUuNjI1NCA0OS4yNzEgMjUuNTQ4MkM0OS4yMzIyIDI1LjQ3MSA0OS4xOTM0IDI1LjM1NTEgNDkuMTkzNCAyNS4yNzc5QzQ5LjE1NDcgMjUuMTIzNCA0OS4xNTQ3IDI1LjAwNzYgNDkuMTE1OSAyNC44OTE3QzQ4Ljk5OTYgMjQuNDI4MyA0OC44NDQ1IDIzLjg0OSA0OC42ODk1IDIzLjE1MzlaIiBmaWxsPSIjMjYyNjI2Ii8+CjxwYXRoIGQ9Ik02Mi44ODM3IDI0LjAwMTVDNjMuMDI0NiAyNC4zNzg0IDYzLjE2NTQgMjQuNzU1MyA2My4zMDYyIDI1LjEzMjJDNjMuMzUzMiAyNS4zMjA3IDYzLjQ0NzEgMjUuNDYyIDYzLjQ5NCAyNS42NTA1QzYzLjU0MSAyNS43NDQ3IDYzLjU4NzkgMjUuODg2MSA2My42ODE4IDI1LjkzMzJDNjMuODIyNiAyNi4wMjc0IDY0LjAxMDQgMjYuMDc0NSA2NC4xOTgyIDI2LjA3NDVDNjQuNDc5OSAyNi4wNzQ1IDY0LjcxNDYgMjYuMDc0NSA2NC45OTYzIDI2LjA3NDVDNjUuMjMxIDI2LjA3NDUgNjUuNDY1NyAyNi4wNzQ1IDY1LjY1MzUgMjYuMDc0NUM2Ni4wNzYgMjYuMDI3NCA2Ni40NTE2IDI1Ljg4NjEgNjYuODI3MiAyNS42OTc2QzY3LjIwMjcgMjUuNTA5MiA2Ny41MzEzIDI1LjMyMDcgNjcuODYgMjUuMDM4QzY4LjMyOTQgMjQuNjE0IDY4Ljc1MTkgMjQuMDk1NyA2OC45ODY2IDIzLjUzMDNDNjkuMzYyMiAyMi43Mjk0IDY5LjU1IDIxLjc4NzEgNjkuNTUgMjAuODkxOUM2OS41NSAyMC4yMzIzIDY5LjUwMyAxOS42MTk4IDY5LjMxNTMgMTkuMDA3M0M2OS4xMjc1IDE4LjQ0MTkgNjguODkyNyAxNy44NzY1IDY4LjUxNzIgMTcuNDA1NEM2OC4wOTQ3IDE2Ljg0IDY3LjU3ODMgMTYuMzY4OCA2Ni45NjggMTYuMDM5QzY2LjQwNDYgMTUuODAzNSA2NS43OTQ0IDE1LjcwOTIgNjUuMTg0MSAxNS42NjIxQzY0LjgwODUgMTUuNjYyMSA2NC40MzI5IDE1LjY2MjEgNjQuMTA0MyAxNS43NTYzQzYzLjkxNjUgMTUuODAzNSA2My42ODE4IDE1Ljg5NzcgNjMuNDk0IDE2LjAzOUM2My4zMDYyIDE2LjEzMzMgNjMuMTE4NSAxNi4yMjc1IDYyLjkzMDcgMTYuMjI3NUM2Mi44MzY4IDE2LjIyNzUgNjIuNjk1OSAxNi4xMzMzIDYyLjY0OSAxNi4wODYyQzYyLjYwMiAxNS45OTE5IDYyLjYwMjEgMTUuODUwNiA2Mi41MDgyIDE1Ljc1NjNDNjIuNDYxMiAxNS43MDkyIDYyLjM2NzMgMTUuNjYyMSA2Mi4yNzM0IDE1LjY2MjFDNjIuMTc5NSAxNS42NjIxIDYyLjA4NTcgMTUuNzU2MyA2MS45OTE4IDE1LjgwMzVDNjEuODA0IDE1Ljg5NzcgNjEuNjE2MiAxNS44OTc3IDYxLjQyODQgMTUuOTQ0OEM2MS4yNDA2IDE1Ljk0NDggNjEuMDk5OCAxNS45NDQ4IDYwLjkxMiAxNS45NDQ4QzYwLjIwNzggMTUuOTQ0OCA1OS41MDM3IDE1Ljk0NDggNTguODQ2NCAxNS45NDQ4QzU4LjcwNTYgMTUuOTQ0OCA1OC42MTE3IDE1Ljk0NDggNTguNDcwOSAxNS45NDQ4QzU4LjMzIDE1Ljk0NDggNTguMTg5MiAxNS45NDQ4IDU4LjE0MjIgMTUuOTkxOUM1OC4wOTUzIDE2LjAzOSA1OC4wNDgzIDE2LjA4NjEgNTguMDQ4MyAxNi4xODA0QzU4LjA0ODMgMTYuMjI3NSA1OC4wOTUzIDE2LjI3NDYgNTguMTQyMiAxNi4zNjg4QzU4LjIzNjEgMTYuNTU3MyA1OC4zNzcgMTYuNjk4NiA1OC41MTc4IDE2Ljg4NzFDNTguNjExNyAxNy4wMjg0IDU4LjcwNTYgMTcuMTIyNyA1OC43NTI1IDE3LjI2NEM1OC44NDY0IDE3LjQ1MjUgNTguNzk5NSAxNy42ODgxIDU4Ljc5OTUgMTcuOTIzNkM1OC43OTk1IDE4LjA2NSA1OC43OTk1IDE4LjIwNjMgNTguNzk5NSAxOC4zOTQ4QzU4Ljc5OTUgMTguOTEzMSA1OC43OTk1IDE5LjQzMTMgNTguNzk5NSAxOS45NDk2QzU4Ljc5OTUgMjAuNTYyMSA1OC43OTk1IDIxLjEyNzUgNTguNzk5NSAyMS43NEM1OC43OTk1IDIzLjY3MTcgNTguNzUyNSAyNS42NTA1IDU4Ljc5OTUgMjcuNTgyMkM1OC43OTk1IDI3LjkxMiA1OC43OTk1IDI4LjI0MTggNTguNzk5NSAyOC41NzE2QzU4Ljc5OTUgMjguNzYwMSA1OC43OTk1IDI4Ljk0ODUgNTguNzUyNSAyOS4wODk5QzU4LjcwNTYgMjkuMjc4MyA1OC42MTE3IDI5LjQ2NjggNTguNDcwOSAyOS42NTUzQzU4LjMzIDI5Ljg0MzcgNTguMjM2MSAyOS45ODUxIDU4LjA0ODMgMzAuMTczNUM1OS43ODUzIDMwLjE3MzUgNjEuNDc1NCAzMC4xNzM1IDYzLjIxMjMgMzAuMTczNUM2My4xMTg1IDMwLjA3OTMgNjMuMDI0NiAyOS45ODUxIDYyLjkzMDcgMjkuODkwOEM2Mi43NDI5IDI5LjcwMjQgNjIuNjAyMSAyOS40NjY4IDYyLjUwODIgMjkuMTg0MUM2Mi40NjEyIDI4Ljk5NTcgNjIuNDE0MyAyOC44MDcyIDYyLjQxNDMgMjguNjE4N0M2Mi40MTQzIDI4LjM4MzIgNjIuNDE0MyAyOC4xMDA1IDYyLjQxNDMgMjcuODY0OUM2Mi40MTQzIDI3LjQ4OCA2Mi40MTQzIDI3LjE1ODIgNjIuNDE0MyAyNi43ODEyQzYyLjQxNDMgMjQuNzU1MyA2Mi40MTQzIDIyLjc3NjUgNjIuNDE0MyAyMC43NTA1QzYyLjQxNDMgMjAuNTYyMSA2Mi40MTQzIDIwLjM3MzYgNjIuNDE0MyAyMC4xODUyQzYyLjQxNDMgMTkuOTQ5NiA2Mi40MTQzIDE5LjcxNCA2Mi40NjEyIDE5LjUyNTVDNjIuNTA4MiAxOS4yOSA2Mi41NTUxIDE5LjA1NDQgNjIuNjQ5IDE4Ljg2NTlDNjIuNzQyOSAxOC42MzA0IDYyLjkzMDcgMTguNDQxOSA2My4xNjU0IDE4LjM0NzdDNjMuMzUzMiAxOC4yNTM0IDYzLjU0MSAxOC4yMDYzIDYzLjcyODcgMTguMjA2M0M2My45MTY1IDE4LjIwNjMgNjQuMTUxMyAxOC4yMDYzIDY0LjMzOSAxOC4zMDA2QzY0LjYyMDcgMTguMzk0OCA2NC44MDg1IDE4LjU4MzIgNjQuOTk2MyAxOC44MTg4QzY1LjEzNzEgMTkuMDU0NCA2NS4yMzEgMTkuMzM3MSA2NS4zMjQ5IDE5LjYxOThDNjUuNDE4OCAxOS45OTY3IDY1LjUxMjcgMjAuMzczNiA2NS41NTk2IDIwLjc5NzdDNjUuNjA2NiAyMS4yNjg4IDY1LjYwNjYgMjEuNzM5OSA2NS41MTI3IDIyLjI1ODJDNjUuNDY1NyAyMi42ODIyIDY1LjM3MTggMjMuMDU5MiA2NS4xODQxIDIzLjM4OUM2NS4wOTAyIDIzLjU3NzQgNjQuOTAyNCAyMy43NjU5IDY0LjcxNDYgMjMuOTA3MkM2NC40Nzk5IDI0LjA0ODYgNjQuMTk4MiAyNC4xNDI4IDYzLjkxNjUgMjQuMTg5OUM2My41ODc5IDI0LjA5NTcgNjMuMjU5MyAyNC4wOTU3IDYyLjg4MzcgMjQuMDAxNVoiIGZpbGw9IiMyNjI2MjYiLz4KPHBhdGggZD0iTTgwLjQ5NzUgMjMuMDExMkM4MC40OTM2IDIzLjAzMzEgODAuNDkzNiAyMy4wNTEgODAuNDg5NiAyMy4wNjY5QzgwLjQ1NzggMjMuMTYyMyA4MC40MjYgMjMuMjU1NyA4MC4zOTQyIDIzLjM1MTFDODAuMzY0MyAyMy40Mzg2IDgwLjMzMDYgMjMuNTI2MSA4MC4zMDA3IDIzLjYxNTVDODAuMjcwOSAyMy43MDMgODAuMjQ1MSAyMy43OTI0IDgwLjIxNTMgMjMuODgxOUM4MC4xNzM1IDI0LjAwMzEgODAuMTI3OCAyNC4xMjQ0IDgwLjA4NDEgMjQuMjQ1N0M4MC4wNDIzIDI0LjM2MjkgODAuMDAwNiAyNC40NzgyIDc5Ljk1NjkgMjQuNTk1NUM3OS45MjExIDI0LjY5NDkgNzkuODgxMyAyNC43OTQzIDc5Ljg0NTUgMjQuODkzN0M3OS44MTU3IDI0Ljk3OTEgNzkuNzgzOSAyNS4wNjI2IDc5Ljc2MDEgMjUuMTUwMUM3OS43MDQ0IDI1LjM0MjkgNzkuNTg5MSAyNS40ODYgNzkuNDEwMiAyNS41Nzc1Qzc5LjI1NTIgMjUuNjU5IDc5LjA5NjEgMjUuNzMwNSA3OC45MzEyIDI1Ljc5MjFDNzguODQxNyAyNS44MjU5IDc4Ljc1MDMgMjUuODQ5OCA3OC42NTg4IDI1Ljg3OTZDNzguNTgxMyAyNS45MDM1IDc4LjUwNTggMjUuOTI5MyA3OC40MjgyIDI1Ljk1MTJDNzguMzY4NiAyNS45NjkxIDc4LjMwNyAyNS45ODMgNzguMjQ3NCAyNS45OTY5Qzc4LjE3OTggMjYuMDE0OCA3OC4xMTQyIDI2LjAzMjcgNzguMDQ2NiAyNi4wNDg2Qzc4LjAwNjggMjYuMDU4NSA3Ny45NjcxIDI2LjA2NjUgNzcuOTI1MyAyNi4wNzQ0Qzc3Ljg3MzcgMjYuMDg2MyA3Ny44MjIgMjYuMDk2MyA3Ny43NzAzIDI2LjEwODJDNzcuNzMyNSAyNi4xMTYyIDc3LjY5NjcgMjYuMTI0MSA3Ny42NTkgMjYuMTMwMUM3Ny42MDMzIDI2LjE0IDc3LjU0NzcgMjYuMTQ2IDc3LjQ5MiAyNi4xNTU5Qzc3LjQyNDQgMjYuMTY1OCA3Ny4zNTg4IDI2LjE3NzggNzcuMjkxMiAyNi4xODc3Qzc3LjI4NzMgMjYuMTg3NyA3Ny4yODEzIDI2LjE4OTcgNzcuMjc3MyAyNi4xODk3Qzc3LjE5NTggMjYuMTk3NyA3Ny4xMTIzIDI2LjIwNTYgNzcuMDMwOCAyNi4yMTU1Qzc2LjkzMTQgMjYuMjI1NSA3Ni44MzAxIDI2LjIzNTQgNzYuNzMwNyAyNi4yNDczQzc2LjcyMDcgMjYuMjQ5MyA3Ni43MTA4IDI2LjI0OTMgNzYuNzAwOSAyNi4yNTEzQzc2LjQwNDcgMjYuMjYxMyA3Ni4xMDg1IDI2LjI4MzEgNzUuODEyMyAyNi4yNzEyQzc1LjY4MTEgMjYuMjY1MiA3NS41NDk5IDI2LjI2MTMgNzUuNDIwNyAyNi4yNTEzQzc1LjMxNTQgMjYuMjQzNCA3NS4yMSAyNi4yMjk1IDc1LjEwNDcgMjYuMjE5NUM3NS4wMjMyIDI2LjIxMTYgNzQuOTM5NyAyNi4yMDU2IDc0Ljg1ODIgMjYuMTk1N0M3NC43ODg2IDI2LjE4NzcgNzQuNzE5IDI2LjE3MzggNzQuNjQ3NSAyNi4xNjE5Qzc0LjYwMzggMjYuMTUzOSA3NC41NiAyNi4xNDYgNzQuNTE2MyAyNi4xNEM3NC40NjQ2IDI2LjEzMjEgNzQuNDEwOSAyNi4xMjQxIDc0LjM1OTMgMjYuMTE0MkM3NC4zMTE1IDI2LjEwNjIgNzQuMjY1OCAyNi4wOTIzIDc0LjIyMDEgMjYuMDgyNEM3NC4xODQzIDI2LjA3NDQgNzQuMTQ4NiAyNi4wNjY1IDc0LjExNDggMjYuMDU4NUM3NC4wMTU0IDI2LjAzMjcgNzMuOTE0IDI2LjAwODggNzMuODE0NiAyNS45ODFDNzMuNzE5MiAyNS45NTUxIDczLjYyMTggMjUuOTI3MyA3My41MjY0IDI1Ljg5NTVDNzMuNDI1IDI1Ljg2MTcgNzMuMzIzNiAyNS44MjIgNzMuMjIyMiAyNS43ODIyQzczLjEwMyAyNS43MzQ1IDcyLjk4MzcgMjUuNjg4OCA3Mi44Njg0IDI1LjYzNTFDNzIuNTc2MiAyNS40OTk5IDcyLjI5MzkgMjUuMzQ0OSA3Mi4wMjc2IDI1LjE2QzcxLjY5MzYgMjQuOTI5NCA3MS4zODU1IDI0LjY2OSA3MS4xMjEyIDI0LjM2MDlDNzAuODkyNiAyNC4wOTQ2IDcwLjY5OTcgMjMuODAyNCA3MC41NDY3IDIzLjQ4NjNDNzAuNDc1MSAyMy4zMzcyIDcwLjQxMTUgMjMuMTg0MiA3MC4zNTU5IDIzLjAyOTFDNzAuMzIyMSAyMi45MzU3IDcwLjI5NjIgMjIuODM4MyA3MC4yNzA0IDIyLjc0MDlDNzAuMjQ0NSAyMi42NDk1IDcwLjIxODcgMjIuNTU4IDcwLjE5NjggMjIuNDY0NkM3MC4xNzg5IDIyLjM4MTEgNzAuMTY1IDIyLjI5NTYgNzAuMTUxMSAyMi4yMTIxQzcwLjE0MTIgMjIuMTUyNSA3MC4xMjkzIDIyLjA5MjkgNzAuMTE5MyAyMi4wMzEzQzcwLjExOTMgMjIuMDI3MyA3MC4xMTczIDIyLjAyNTMgNzAuMTE3MyAyMi4wMjEzQzcwLjEwOTQgMjEuOTU5NyA3MC4xMDE0IDIxLjg5NjEgNzAuMDk1NSAyMS44MzQ1QzcwLjA2OTYgMjEuNTg0IDcwLjA2NzYgMjEuMzMxNiA3MC4wNzM2IDIxLjA4MTFDNzAuMDc3NiAyMC45NDM5IDcwLjA4NTUgMjAuODA2OCA3MC4wOTc0IDIwLjY2OTZDNzAuMTA1NCAyMC41NjIzIDcwLjExOTMgMjAuNDU2OSA3MC4xMzcyIDIwLjM0OTZDNzAuMTUxMSAyMC4yNTQyIDcwLjE3MyAyMC4xNTg4IDcwLjE5MDkgMjAuMDYzNEM3MC4yMDQ4IDE5Ljk4NTggNzAuMjE4NyAxOS45MDgzIDcwLjIzNjYgMTkuODMwOEM3MC4yNTI1IDE5Ljc2MzIgNzAuMjcyNCAxOS42OTc2IDcwLjI5MDMgMTkuNjNDNzAuMzEyMSAxOS41NDg1IDcwLjMzMiAxOS40NjcgNzAuMzU1OSAxOS4zODc1QzcwLjM3NzcgMTkuMzE0IDcwLjQwMzYgMTkuMjQwNCA3MC40Mjc0IDE5LjE2ODlDNzAuNDUzMyAxOS4wOTEzIDcwLjQ4MTEgMTkuMDEzOCA3MC41MDg5IDE4LjkzODNDNzAuNTU2NiAxOC44MTcgNzAuNjAwNCAxOC42OTE4IDcwLjY1NiAxOC41NzQ1QzcwLjczNzUgMTguMzk5NiA3MC44MjEgMTguMjI0NyA3MC45MTY0IDE4LjA1NzdDNzEuMTQzIDE3LjY1NjIgNzEuNDE5MyAxNy4yODg0IDcxLjc1MzMgMTYuOTY4NEM3Mi4wOTEyIDE2LjY0MjQgNzIuNDY4OSAxNi4zNzIgNzIuODgyMyAxNi4xNTM0QzczLjA0MTQgMTYuMDY5OSA3My4yMDQ0IDE1Ljk5MjQgNzMuMzcxMyAxNS45MjQ4QzczLjQ5MDYgMTUuODc3MSA3My42MTE4IDE1LjgzNzMgNzMuNzMzMSAxNS43OTc2QzczLjgzNjUgMTUuNzYzOCA3My45Mzk4IDE1LjczMiA3NC4wNDMyIDE1LjcwNDFDNzQuMTE0OCAxNS42ODQzIDc0LjE4ODMgMTUuNjcyMyA3NC4yNTk5IDE1LjY1ODRDNzQuMzQ5MyAxNS42NDA1IDc0LjQ0MDggMTUuNjIwNyA3NC41MzAyIDE1LjYwNDhDNzQuNTkzOCAxNS41OTQ4IDc0LjY1NzQgMTUuNTg2OSA3NC43MjEgMTUuNTgwOUM3NC44NjAyIDE1LjU2OSA3NS4wMDEzIDE1LjU1OSA3NS4xNDI0IDE1LjU1MzFDNzUuMjUzOCAxNS41NDkxIDc1LjM2NTEgMTUuNTUxMSA3NS40NzQ0IDE1LjU1MzFDNzUuNTA4MiAxNS41NTMxIDc1LjU0NCAxNS41NTUxIDc1LjU3NzggMTUuNTU5Qzc1LjY5NSAxNS41NjcgNzUuODEyMyAxNS41NzEgNzUuOTI5NiAxNS41ODQ5Qzc2LjAzNSAxNS41OTY4IDc2LjEzODMgMTUuNjE4NyA3Ni4yNDE3IDE1LjYzNjZDNzYuMjg5NCAxNS42NDQ1IDc2LjMzOTEgMTUuNjUyNSA3Ni4zODY4IDE1LjY2MjRDNzYuNDI4NSAxNS42NzA0IDc2LjQ3MDMgMTUuNjgyMyA3Ni41MTIgMTUuNjkyMkM3Ni41NDc4IDE1LjcwMDIgNzYuNTgxNiAxNS43MTAxIDc2LjYxNzQgMTUuNzIwMUM3Ni43MDQ4IDE1Ljc0MzkgNzYuNzkwMyAxNS43Njc4IDc2Ljg3NzggMTUuNzk1NkM3Ni45NTkzIDE1LjgyMTQgNzcuMDM4OCAxNS44NTEyIDc3LjEyMDMgMTUuODc5MUM3Ny4yNTc0IDE1LjkyNDggNzcuMzg4NiAxNS45ODI0IDc3LjUxNzggMTYuMDQ0MUM3Ny43NDY0IDE2LjE1MzQgNzcuOTY3MSAxNi4yNzY2IDc4LjE3NzggMTYuNDE5N0M3OC41NDk1IDE2LjY3MDIgNzguODg1NCAxNi45NjI0IDc5LjE4MTYgMTcuMzAyM0M3OS40NTIgMTcuNjEyNCA3OS42Nzg2IDE3Ljk1MDMgNzkuODU3NSAxOC4zMjIxQzc5LjkzMSAxOC40NzUxIDc5Ljk5MjYgMTguNjMwMiA4MC4wNDgzIDE4Ljc4OTJDODAuMDg2MSAxOC44OTY1IDgwLjExNzkgMTkuMDA3OCA4MC4xNDc3IDE5LjExOTJDODAuMTczNSAxOS4yMTg1IDgwLjE5MzQgMTkuMzIxOSA4MC4yMTMzIDE5LjQyMzNDODAuMjMxMiAxOS41MTQ3IDgwLjI0OTEgMTkuNjA4MiA4MC4yNjY5IDE5LjY5OTZDODAuMjc2OSAxOS43NDkzIDgwLjI4MjggMTkuODAxIDgwLjI4ODggMTkuODUwN0M4MC4yOTg4IDE5Ljk0NjEgODAuMzAyNyAyMC4wNDE1IDgwLjMxNDcgMjAuMTM2OUM4MC4zMzI1IDIwLjI4NiA4MC4zMzQ1IDIwLjQzNTEgODAuMzM0NSAyMC41ODIyQzgwLjMzNDUgMjAuNzE1MyA4MC4zMzI1IDIwLjg1MDUgODAuMzMyNSAyMC45ODM3QzgwLjMzMjUgMjEuMDAzNiA4MC4zMjg2IDIxLjAyMzUgODAuMzI2NiAyMS4wNDUzQzgwLjMwMDcgMjEuMDQ3MyA4MC4yNzY5IDIxLjA0OTMgODAuMjU1IDIxLjA0OTNDNzkuMTUzOCAyMS4wNDkzIDc4LjA1MjYgMjEuMDQ5MyA3Ni45NTEzIDIxLjA1MTNDNzUuOTI5NiAyMS4wNTEzIDc0LjkwNzkgMjEuMDUzMyA3My44ODYyIDIxLjA1NTNDNzMuODA0NyAyMS4wNTUzIDczLjgwNDcgMjEuMDU3MiA3My44MDA3IDIxLjEzODdDNzMuNzkwNyAyMS4yODc4IDczLjgwODYgMjEuNDM2OSA3My44MjA2IDIxLjU4NEM3My44Mjg1IDIxLjY4MzQgNzMuODUyNCAyMS43ODI4IDczLjg3NDIgMjEuODgwMkM3My44OTQxIDIxLjk2OTYgNzMuOTEyIDIyLjA2MTEgNzMuOTM5OCAyMi4xNDY2Qzc0LjAwOTQgMjIuMzYxMiA3NC4xMDI4IDIyLjU2NCA3NC4yMjQxIDIyLjc1NDhDNzQuNDYwNiAyMy4xMjQ1IDc0Ljc2NjggMjMuNDIwNyA3NS4xMzQ1IDIzLjY1OTNDNzUuMjk3NSAyMy43NjQ2IDc1LjQ2ODQgMjMuODUyMSA3NS42NDczIDIzLjkyMzZDNzUuNzU2NyAyMy45Njc0IDc1Ljg2OCAyNC4wMDUxIDc1Ljk4NTMgMjQuMDMxQzc2LjA1NjggMjQuMDQ2OSA3Ni4xMjg0IDI0LjA2ODcgNzYuMTk5OSAyNC4wODI3Qzc2LjI1NzYgMjQuMDk0NiA3Ni4zMTcyIDI0LjEwMDUgNzYuMzc2OSAyNC4xMDg1Qzc2LjQ3NjIgMjQuMTIwNCA3Ni41NzM2IDI0LjEzMDQgNzYuNjczIDI0LjEzODNDNzYuODA0MiAyNC4xNDgyIDc2LjkzNzQgMjQuMTQ4MiA3Ny4wNzA2IDI0LjEzNjNDNzcuMTA2NCAyNC4xMzIzIDc3LjE0NDEgMjQuMTMwNCA3Ny4xNzk5IDI0LjEyODRDNzcuMjc1MyAyNC4xMjA0IDc3LjM3MDcgMjQuMTE2NCA3Ny40NjYyIDI0LjEwMjVDNzcuNTYzNiAyNC4wODg2IDc3LjY2MSAyNC4wNjg3IDc3Ljc1NjQgMjQuMDUwOEM3Ny44MzM5IDI0LjAzNjkgNzcuOTExNCAyNC4wMjMgNzcuOTg4OSAyNC4wMDUxQzc4LjA1NDUgMjMuOTkxMiA3OC4xMTgyIDIzLjk3MTMgNzguMTgzNyAyMy45NTM0Qzc4LjI0MTQgMjMuOTM3NSA3OC4zMDEgMjMuOTIzNiA3OC4zNTg3IDIzLjkwNzdDNzguNDEwNCAyMy44OTM4IDc4LjQ2MiAyMy44Nzc5IDc4LjUxMzcgMjMuODZDNzguNTgzMyAyMy44MzgyIDc4LjY1MDkgMjMuODE0MyA3OC43MTg1IDIzLjc5MDRDNzguNzkgMjMuNzY0NiA3OC44NTk2IDIzLjczODggNzguOTI5MiAyMy43MTI5Qzc5LjAwMjcgMjMuNjg1MSA3OS4wNzYzIDIzLjY1OTMgNzkuMTQ5OCAyMy42MzE0Qzc5LjI1NTIgMjMuNTg5NyA3OS4zNjA1IDIzLjU0NzkgNzkuNDYzOSAyMy41MDQyQzc5LjU3NzIgMjMuNDU2NSA3OS42ODg1IDIzLjQwNjggNzkuNzk3OCAyMy4zNTMxQzc5Ljk3MDggMjMuMjcxNiA4MC4xNDE3IDIzLjE4NjIgODAuMzE0NyAyMy4xMDI3QzgwLjM2ODMgMjMuMDc2OCA4MC40MTggMjMuMDQ3IDgwLjQ3MTcgMjMuMDIxMkM4MC40NzM3IDIzLjAxMzIgODAuNDgxNiAyMy4wMTUyIDgwLjQ5NzUgMjMuMDExMlpNNzMuNzc0OCAxOS4yMzA1Qzc0Ljc1ODggMTkuMjMwNSA3NS43MzQ4IDE5LjIzMDUgNzYuNzE0OCAxOS4yMzA1Qzc2LjcxNjggMTkuMjEwNiA3Ni43MTg4IDE5LjE5NDcgNzYuNzIyNyAxOS4xNzg4Qzc2LjczMjcgMTkuMDk5MyA3Ni43MjI3IDE5LjAxOTggNzYuNzIwNyAxOC45NDAzQzc2LjcxNjggMTguODQ0OCA3Ni42OTY5IDE4Ljc1MzQgNzYuNjc1IDE4LjY2MkM3Ni42NDcyIDE4LjU1NjYgNzYuNjA5NCAxOC40NTUyIDc2LjU1OTcgMTguMzU5OEM3Ni40NzYyIDE4LjE5MjkgNzYuMzY2OSAxOC4wNDc3IDc2LjIxOTggMTcuOTMwNUM3Ni4xNTQyIDE3Ljg3ODggNzYuMDg0NyAxNy44MzUxIDc2LjAwOTEgMTcuNzk3M0M3NS45MzU2IDE3Ljc2MTUgNzUuODYyIDE3LjcyNzcgNzUuNzg2NSAxNy42OTk5Qzc1LjcxMjkgMTcuNjc0IDc1LjYzNTQgMTcuNjU0MiA3NS41NTc5IDE3LjYzODNDNzUuNDcyNCAxNy42MjA0IDc1LjM4NSAxNy42MTI0IDc1LjI5NzUgMTcuNjA4NEM3NS4yNDk4IDE3LjYwNjUgNzUuMjAyMSAxNy42MTg0IDc1LjE1NDQgMTcuNjIwNEM3NS4wNzA5IDE3LjYyNDMgNzQuOTkxNCAxNy42NDQyIDc0LjkxMTkgMTcuNjY4MUM3NC43NzI3IDE3LjcwOTggNzQuNjM3NSAxNy43Njc1IDc0LjUxNDMgMTcuODQ1Qzc0LjI4OTcgMTcuOTgyMSA3NC4xMTQ4IDE4LjE2NSA3My45OTM1IDE4LjM5NzZDNzMuOTQ1OCAxOC40OTEgNzMuOTAwMSAxOC41ODQ0IDczLjg3MjIgMTguNjg1OEM3My44NTQ0IDE4Ljc0OTQgNzMuODMyNSAxOC44MTExIDczLjgxODYgMTguODc0N0M3My44MDI3IDE4Ljk0NjIgNzMuNzkyNyAxOS4wMTk4IDczLjc4MjggMTkuMDkzM0M3My43NzY4IDE5LjEzOSA3My43NzY4IDE5LjE4MjggNzMuNzc0OCAxOS4yMzA1WiIgZmlsbD0iIzI2MjYyNiIvPgo8cGF0aCBkPSJNODAuNTA2OCAyNS43NjY0QzgwLjYwNTggMjUuNjc5NSA4MC42OTkgMjUuNTg2OCA4MC43ODY0IDI1LjQ4ODNDODAuOTI2MSAyNS4zMjYxIDgxLjA0ODQgMjUuMTUyMyA4MS4xMjk5IDI0Ljk2MTFDODEuMjU4MSAyNC42NDgzIDgxLjI1ODEgMjQuMzAwNyA4MS4yNjM5IDIzLjk1MzFDODEuMjY5NyAyMy4xODI1IDgxLjI2MzkgMjIuNDQ2OCA4MS4yNjM5IDIxLjY5OTVDODEuMjYzOSAyMC42MjE5IDgxLjI2OTcgMTkuNTI3IDgxLjI2MzkgMTguNDM3OEM4MS4yNjM5IDE4LjI1ODIgODEuMjYzOSAxOC4wNzg2IDgxLjI2MzkgMTcuOTA0OEM4MS4yNjM5IDE3Ljc4MzIgODEuMjY5NyAxNy42NjE1IDgxLjI2MzkgMTcuNTM5OUM4MS4yNjM5IDE3LjQ2NDYgODEuMjU4MSAxNy4zODkyIDgxLjIzNDggMTcuMzEzOUM4MS4xODgyIDE3LjE0MDEgODEuMDQ4NCAxNy4wMDExIDgwLjkyNjEgMTYuODU2M0M4MC44MDk3IDE2LjcyMyA4MC43MDQ4IDE2LjU4NCA4MC42NDA4IDE2LjQyMThDODAuNTg4NCAxNi4yODg1IDgwLjU3NjcgMTYuMTM3OSA4MC41ODI1IDE1LjkzNTFDODEuMjM0OCAxNS45MzUxIDgxLjg4MTIgMTUuOTM1MSA4Mi41MzM0IDE1LjkzNTFDODIuODAxMiAxNS45MzUxIDgzLjA2OTEgMTUuOTM1MSA4My4zMTM3IDE1LjkzNTFDODMuNTE3NSAxNS45MzUxIDgzLjcwOTcgMTUuOTM1MSA4My45MzY4IDE1Ljg5NDZDODQuMTExNSAxNS44NjU2IDg0LjMxNTMgMTUuODEzNSA4NC40OTU4IDE1Ljc3ODdDODQuNjEyMyAxNS43NTU1IDg0LjcyMyAxNS43MzgyIDg0LjgzOTQgMTUuNzQzOUM4NC45MDkzIDE1Ljc0OTcgODQuOTc5MiAxNS43NjEzIDg1LjAzMTYgMTUuODAxOUM4NS4wNzgyIDE1Ljg0MjQgODUuMTAxNSAxNS45MDYyIDg1LjExODkgMTUuOTY0MUM4NS4xMzA2IDE2LjAxNjIgODUuMTMwNiAxNi4wNjg0IDg1LjEzMDYgMTYuMTI2M0M4NS4xMzY0IDE2LjI4ODUgODUuMTQyMiAxNi40NTA3IDg1LjEzMDYgMTYuNjEyOUM4NS4yMzU0IDE2LjUwMjkgODUuMzQ2MSAxNi4zOTg2IDg1LjQ2MjUgMTYuMjk0M0M4NS42MTM5IDE2LjE2MTEgODUuNzc3IDE2LjAzOTQgODUuOTUxNyAxNS45NDY3Qzg2LjEzMjIgMTUuODU0IDg2LjMzMDIgMTUuNzkwMyA4Ni41MjI0IDE1Ljc0MzlDODYuNzg0NCAxNS42ODYgODcuMDQwNyAxNS42NTcgODcuMzI2IDE1LjY2MjhDODcuNTI0IDE1LjY2MjggODcuNzM5NSAxNS42ODAyIDg3Ljg3MzQgMTUuODA3N0M4Ny45NDkxIDE1Ljg4MyA4Ny45OTU3IDE1Ljk4NzMgODguMDEzMiAxNi4wOTczQzg4LjAzNjUgMTYuMTk1OCA4OC4wMzA2IDE2LjMwMDEgODguMDMwNiAxNi4zOTg2Qzg4LjAzMDYgMTYuNjY1MSA4OC4wMzA2IDE2LjkzMTYgODguMDMwNiAxNy4yMDM5Qzg4LjAzMDYgMTcuNjI2OCA4OC4wMjQ4IDE4LjA0MzkgODguMDI0OCAxOC40MjYyQzg3LjQ4MzIgMTguNDIwNSA4Ny4wNzU2IDE4LjM5NzMgODYuNzAyOSAxOC40MTQ3Qzg2LjQ5MzMgMTguNDI2MiA4Ni4zMDExIDE4LjQ0OTQgODYuMDk3MyAxOC41MTg5Qzg1LjkxMDkgMTguNTgyNyA4NS43MTI5IDE4LjY4MTEgODUuNTQ5OSAxOC44MjAyQzg1LjM3NTIgMTguOTY1IDg1LjIzNTQgMTkuMTU2MiA4NS4xNDgxIDE5LjM2NDhDODUuMDQzMiAxOS42MjU1IDg1LjAzMTYgMTkuOTIwOSA4NS4wMzE2IDIwLjIwNDhDODUuMDMxNiAyMC40MTMzIDg1LjAzMTYgMjAuNjE2MSA4NS4wMzE2IDIwLjgxODlDODUuMDM3NCAyMS41MzE1IDg1LjA0OTEgMjIuMjQ0IDg1LjAzMTYgMjIuOTE2MUM4NS4wMTk5IDIzLjM4NTMgODQuOTk2NyAyMy44MzcyIDg1LjA1NDkgMjQuMzkzM0M4NS4wNzI0IDI0LjU0OTggODUuMDg5OCAyNC43MTIgODUuMTM2NCAyNC44NTY4Qzg1LjIwMDUgMjUuMDc3IDg1LjMxMTEgMjUuMjUwOCA4NS40Mjc2IDI1LjQxODhDODUuNTA5MSAyNS41MzQ2IDg1LjU5NjUgMjUuNjQ0NyA4NS42ODk2IDI1Ljc0OUM4My45NjAxIDI1Ljc2NjQgODIuMjM2NCAyNS43NjY0IDgwLjUwNjggMjUuNzY2NFoiIGZpbGw9IiMyNjI2MjYiLz4KPHBhdGggZD0iTTk4LjIwNzMgMjUuNzU4MkM5NC43ODA5IDI1Ljc1ODIgOTEuMzU0NiAyNS43NTgyIDg3LjkxNSAyNS43NTgyQzg3Ljk0MTQgMjUuNzI1MiA4Ny45NjEzIDI1LjY5MjEgODcuOTgxMSAyNS42Nzg5Qzg4LjMxMTkgMjUuNDA3NyA4OC41ODk3IDI1LjA5MDIgODguODM0NCAyNC43Mzk2Qzg4Ljk5MzIgMjQuNTE0NyA4OS4xMTg4IDI0LjI4MzIgODkuMjExNCAyNC4wMzE4Qzg5LjI3NzYgMjMuODQ2NiA4OS4zMTczIDIzLjY1NDggODkuMzYzNiAyMy40NjNDODkuNDI5NyAyMy4yMDUgODkuNDI5NyAyMi45NDA0IDg5LjQ1NjIgMjIuNjc1OUM4OS41MDkxIDIyLjE4NjQgODkuNDg5MyAyMS43MDM1IDg5LjQ4OTMgMjEuMjE0Qzg5LjQ4OTMgMjAuMDk2MiA4OS40ODkzIDE4Ljk3ODMgODkuNDc2IDE3Ljg2MDRDODkuNDY5NCAxNi45MDEzIDg5LjQ0OTYgMTUuOTQ4OCA4OS40Mjk3IDE0Ljk4OTdDODkuNDE2NSAxNC4zMzQ5IDg5LjQxNjUgMTMuNjggODkuMzkgMTMuMDE4NkM4OS4zNTcgMTIuMDI2NCA4OS4zNzAyIDExLjAyNzYgODkuMzM3MSAxMC4wMzU0Qzg5LjI4NDIgOC4zMzU0NiA4OS4zMTczIDYuNjI4OSA4OS4zMDQgNC45Mjg5NUM4OS4zMDQgNC42NjQzNyA4OS4zMTczIDQuNDA2NCA4OS4yNzEgNC4xNDE4MkM4OS4yNTc3IDQuMDgyMjkgODkuMjY0NCA0LjAxNjE0IDg5LjI2NDQgMy45NDk5OUM4OS4yNjQ0IDMuNzQ0OTQgODkuMjMxMyAzLjUzOTg5IDg5LjE4NSAzLjM0MTQ1Qzg5LjE1MTkgMy4yMDI1NSA4OS4xMjU1IDMuMDU3MDMgODkuMDg1OCAyLjkxODEyQzg4Ljk2MDEgMi40NzQ5NCA4OC43NjgzIDIuMDc4MDcgODguNDE3NyAxLjc2NzE4Qzg4LjI4NTQgMS42NDgxMiA4OC4xNTk3IDEuNTI5MDYgODguMDIwOCAxLjQxNjYxQzg3Ljk0MTQgMS4zNTA0NiA4Ny44ODE5IDEuMjcxMDkgODcuODQyMiAxLjE3ODQ5Qzg3Ljc3NjEgMS4wMTMxMiA4Ny44MTU4IDAuOTAwNjc0IDg4LjAyNzQgMC44Njc2MDFDODguMDg3IDAuODU0MzcyIDg4LjE0NjUgMC44NjA5ODYgODguMjA2IDAuODYwOTg2Qzg5LjI4NDIgMC44NjA5ODYgOTAuMzYyNCAwLjg2NzYwMiA5MS40MzM5IDAuODQ3NzU4QzkxLjkzIDAuODQxMTQzIDkyLjQzMjcgMC44MjEyOTkgOTIuOTI4OCAwLjgzNDUyOEM5NS40MjkxIDAuODk0MDU5IDk3LjkyOTUgMC44NDExNDMgMTAwLjQzNiAwLjg2NzYwMUMxMDAuNTYyIDAuODY3NjAxIDEwMC42ODEgMC44ODc0NDUgMTAwLjgwNyAwLjkwMDY3NEMxMDAuODQgMC45MDA2NzQgMTAwLjg2NiAwLjkwNzI4OSAxMDAuODk5IDAuOTA3Mjg5QzEwMS4xMzEgMC45MjcxMzMgMTAxLjM2MiAwLjk0MDM2MSAxMDEuNTk0IDAuOTY2ODJDMTAxLjcyNiAwLjk4MDA0OSAxMDEuODU5IDEuMDE5NzQgMTAxLjk4NCAxLjAzOTU4QzEwMi4wOTcgMS4wNTk0MiAxMDIuMjAyIDEuMDcyNjUgMTAyLjMxNSAxLjA5MjVDMTAyLjQxNCAxLjExMjM0IDEwMi41MDcgMS4xMzg4IDEwMi42MDYgMS4xNjUyNkMxMDIuNjcyIDEuMTg1MSAxMDIuNzMyIDEuMjA0OTQgMTAyLjc5OCAxLjIxODE3QzEwMy4xMDkgMS4yOTA5MyAxMDMuNDA2IDEuNDEgMTAzLjY5NyAxLjUzNTY3QzEwNC4yODYgMS43ODcwMyAxMDQuODE1IDIuMTMwOTkgMTA1LjI5OCAyLjU1NDMyQzEwNS43NzQgMi45NzEwNCAxMDYuMTg0IDMuNDQ3MjkgMTA2LjUyOCAzLjk3NjQ1QzEwNi43MzMgNC4yOTM5NSAxMDYuOTE5IDQuNjI0NjggMTA3LjA1OCA0Ljk3NTI1QzEwNy4xMyA1LjE2MDQ2IDEwNy4yMDMgNS4zNDU2NyAxMDcuMjY5IDUuNTM3NDlDMTA3LjMxNiA1LjY3NjQgMTA3LjM0MiA1LjgyMTkyIDEwNy4zNzUgNS45Njc0NEMxMDcuNDIxIDYuMTc5MTEgMTA3LjQ1NCA2LjM5MDc3IDEwNy40OTQgNi42MDI0NEMxMDcuNDk0IDYuNjE1NjcgMTA3LjUwMSA2LjYyMjI4IDEwNy41MDEgNi42MzU1MUMxMDcuNTE0IDYuOTU5NjMgMTA3LjUzNCA3LjI4Mzc0IDEwNy41NCA3LjYxNDQ3QzEwNy41NCA3LjgxOTUyIDEwNy41MjcgOC4wMTc5NiAxMDcuNTAxIDguMjIzMDFDMTA3LjQ3NCA4LjQ0MTI5IDEwNy40MjEgOC42NTk1NyAxMDcuMzgyIDguODg0NDdDMTA3LjMzNSA5LjE2ODg5IDEwNy4yNDMgOS40NDAwOSAxMDcuMTQ0IDkuNzA0NjdDMTA2LjkzMiAxMC4yNTM3IDEwNi42NDEgMTAuNzYzIDEwNi4yNjQgMTEuMjE5NEMxMDUuOTk5IDExLjU0MzUgMTA1LjY4OCAxMS44MjEzIDEwNS4zNzEgMTIuMDkyNUMxMDQuODY4IDEyLjUyMjUgMTA0LjMzMiAxMi45MDYxIDEwMy43NTcgMTMuMjQzNUMxMDMuNTUyIDEzLjM2MjUgMTAzLjMzNCAxMy40NjE4IDEwMy4xMjIgMTMuNTY3NkMxMDMuMDQ5IDEzLjYwMDcgMTAzLjA0MyAxMy42MTM5IDEwMy4wODIgMTMuNjhDMTAzLjMwNyAxNC4wMzA2IDEwMy41MzIgMTQuMzg3OCAxMDMuNzU3IDE0LjczODRDMTAzLjkyMiAxNS4wMDMgMTA0LjA5NCAxNS4yNjc1IDEwNC4yNTMgMTUuNTMyMUMxMDQuNTQ0IDE2LjAwODQgMTA0LjgzNSAxNi40NzggMTA1LjExOSAxNi45NTQzQzEwNS4zODQgMTcuMzkwOCAxMDUuNjU1IDE3LjgzNCAxMDUuOTIgMTguMjc3MkMxMDYuMjExIDE4Ljc2IDEwNi41MDIgMTkuMjQ5NSAxMDYuNzkzIDE5LjczOUMxMDcuMTgzIDIwLjM4NzIgMTA3LjU2NyAyMS4wMzU0IDEwNy45NTcgMjEuNjgzN0MxMDguMjIyIDIyLjEyNjggMTA4LjQ5MyAyMi41NjM0IDEwOC43NzEgMjNDMTA5LjA2MiAyMy40NDMxIDEwOS4zOTkgMjMuODUzMyAxMDkuNzUgMjQuMjUwMUMxMTAuMTczIDI0LjcxOTggMTEwLjYyMyAyNS4xNTYzIDExMS4xMTIgMjUuNTU5OEMxMTEuMTE5IDI1LjU2NjQgMTExLjExOSAyNS41NzMgMTExLjEzOSAyNS41ODYzQzExMS4wNzMgMjUuNjA2MSAxMTEuMDA2IDI1LjYzMjYgMTEwLjk0NyAyNS42MzI2QzExMC42ODkgMjUuNjUyNCAxMTAuNDMxIDI1LjY1OSAxMTAuMTggMjUuNjkyMUMxMDkuOTc1IDI1LjcxODYgMTA5Ljc3IDI1LjcwNTMgMTA5LjU2NCAyNS43Mzg0QzEwOS4zOTMgMjUuNzY0OSAxMDkuMjIxIDI1Ljc1MTYgMTA5LjA0OSAyNS43NzgxQzEwOC43OTEgMjUuODE3OCAxMDguNTMzIDI1Ljc5MTMgMTA4LjI3NSAyNS44MzFDMTA3LjkzNyAyNS44NzczIDEwNy42IDI1Ljg1MDkgMTA3LjI2MyAyNS44NzA3QzEwNi4yNjQgMjUuOTQzNSAxMDUuMjcyIDI1Ljg5MDUgMTA0LjI3MyAyNS45MDM4QzEwNC4wNzQgMjUuOTAzOCAxMDMuODY5IDI1Ljg5MDUgMTAzLjY3MSAyNS44NTA5QzEwMy4wNDkgMjUuNzM4NCAxMDIuNTEzIDI1LjQ1NCAxMDIuMDM3IDI1LjAzNzNDMTAxLjcgMjQuNzM5NiAxMDEuNDIyIDI0LjM5NTYgMTAxLjE5NyAyNC4wMTJDMTAwLjk5MiAyMy42NzQ3IDEwMC44IDIzLjMyNDEgMTAwLjYwOCAyMi45ODAxQzEwMC40NDMgMjIuNjg5MSAxMDAuMjc4IDIyLjM5OCAxMDAuMTE5IDIyLjEwN0M5OS44NjA5IDIxLjYzNzQgOTkuNjAyOSAyMS4xNjExIDk5LjM1MTYgMjAuNjkxNUM5OS4wNDczIDIwLjEyMjYgOTguNzQ5NyAxOS41NTM4IDk4LjQ1MiAxOC45ODQ5Qzk4LjEzNDUgMTguMzgzIDk3LjgxNyAxNy43ODc3IDk3LjQ3MyAxNy4yMDU2Qzk3LjE2MjIgMTYuNjc2NCA5Ni44NjQ1IDE2LjEzNCA5Ni41NjAyIDE1LjU5ODNDOTYuNTQ3IDE1LjU3ODQgOTYuNTMzOCAxNS41NjUyIDk2LjQ5NDEgMTUuNTU4NkM5Ni40OTQxIDE1LjU5MTYgOTYuNDk0MSAxNS42MjQ3IDk2LjQ5NDEgMTUuNjU3OEM5Ni40OTQxIDE3LjY4ODUgOTYuNDk0MSAxOS43MjU4IDk2LjQ5NDEgMjEuNzU2NEM5Ni40OTQxIDIyLjEzMzUgOTYuNTAwNyAyMi41MDM5IDk2LjUyMDUgMjIuODgwOUM5Ni41MjcyIDIzLjA0NjMgOTYuNTY2OSAyMy4yMDUgOTYuNTkzMyAyMy4zNzA0Qzk2LjYxMzIgMjMuNDgyOCA5Ni42MjY0IDIzLjU4ODcgOTYuNjU5NSAyMy43MDExQzk2LjY5OTEgMjMuODQgOTYuNzQ1NCAyMy45ODU1IDk2LjgwNSAyNC4xMTc4Qzk2LjkxNzQgMjQuMzgyNCA5Ny4wNTYzIDI0LjYzMzggOTcuMjI4MyAyNC44NjUzQzk3LjQ3OTcgMjUuMTg5NCA5Ny43NjQxIDI1LjQ2NzIgOTguMTE0NyAyNS42ODU1Qzk4LjE0NzcgMjUuNzA1MyA5OC4xODA4IDI1LjczMTggOTguMjEzOSAyNS43NTE2Qzk4LjIxMzkgMjUuNzQ1IDk4LjIxMzkgMjUuNzUxNiA5OC4yMDczIDI1Ljc1ODJaTTk2LjQ0MTIgNC42MTE0NUM5Ni40MTQ3IDQuNzcwMiA5Ni40MTQ3IDEzLjAzMTggOTYuNDQxMiAxMy4xMTEyQzk2LjQ1NDQgMTMuMTExMiA5Ni40Njc2IDEzLjExNzggOTYuNDgwOSAxMy4xMTc4Qzk2LjU2MDIgMTMuMTA0NiA5Ni42Mzk2IDEzLjA5MTMgOTYuNzE5IDEzLjA3MTVDOTYuODExNiAxMy4wNTE3IDk2LjkxMDggMTMuMDQ1IDk3LjAwMzQgMTMuMDE4NkM5Ny4xNjg4IDEyLjk2NTcgOTcuMzI3NSAxMi45MDYxIDk3LjQ5MjkgMTIuODUzMkM5Ny43NDQyIDEyLjc2NzIgOTcuOTgyNCAxMi42NDgyIDk4LjIxMzkgMTIuNTA5M0M5OC42NDM4IDEyLjI1MTMgOTkuMDIwOSAxMS45MjcyIDk5LjM1MTYgMTEuNTU2OEM5OS43MDIyIDExLjE1OTkgOTkuOTg2NiAxMC43Mjk5IDEwMC4xOTggMTAuMjQ3MUMxMDAuMjc4IDEwLjA2ODUgMTAwLjMzNyA5Ljg4MzI3IDEwMC4zOTcgOS42OTE0NUMxMDAuNDM2IDkuNTY1NzcgMTAwLjQ2MyA5LjQzMzQ4IDEwMC40OTYgOS4zMDExOUMxMDAuNTM2IDkuMTIyNTkgMTAwLjU3NSA4Ljk0NCAxMDAuNTc1IDguNzU4NzlDMTAwLjU3NSA4LjY5MjY0IDEwMC41ODIgOC42MjY1IDEwMC41ODIgOC41NTM3NEMxMDAuNTg5IDguMTYzNDggMTAwLjU4OSA3Ljc3MzIyIDEwMC40ODkgNy4zOTYxOUMxMDAuNDM2IDcuMjEwOTggMTAwLjQwMyA3LjAxOTE2IDEwMC4zMzcgNi44NDA1NkMxMDAuMjExIDYuNDg5OTkgMTAwLjAzMyA2LjE2NTg4IDk5Ljc5NDggNS44NjgyMkM5OS41NTY2IDUuNTc3MTggOTkuMjg1NCA1LjMyNTgzIDk4Ljk1NDcgNS4xMjczOUM5OC43Njk1IDUuMDE0OTQgOTguNTcxMSA0LjkyODk1IDk4LjM3MjYgNC44NDI5NkM5OC4yNzM0IDQuNzk2NjYgOTguMTYxIDQuNzcwMiA5OC4wNTUxIDQuNzQzNzRDOTcuOTY5MSA0LjcyMzkgOTcuODgzMiA0LjcwNDA1IDk3Ljc5NzIgNC42OTA4M0M5Ny42NzE1IDQuNjY0MzcgOTcuNTUyNCA0LjYxODA3IDk3LjQyNjcgNC42MTgwN0M5Ny4xMDkyIDQuNTk4MjIgOTYuNzc4NSA0LjYxMTQ1IDk2LjQ0MTIgNC42MTE0NVoiIGZpbGw9IiMyNjI2MjYiLz4KPHBhdGggZD0iTTExNC43ODcgMTUuNzcxOEMxMTUuMDU5IDE1Ljc2MzkgMTE1LjMyOCAxNS43NzcgMTE1LjU5NSAxNS44MDU4QzExNS43OTkgMTUuODI5MyAxMTYuMDAzIDE1Ljg2MzMgMTE2LjIwNyAxNS45QzExNi4zNDMgMTUuOTIzNSAxMTYuNDgyIDE1Ljk1MjMgMTE2LjYxNiAxNS45ODg5QzExNi44NTYgMTYuMDU0MyAxMTcuMDkyIDE2LjEzOCAxMTcuMzE5IDE2LjI0QzExNy43ODcgMTYuNDQ2NyAxMTguMjE3IDE2LjcxNjEgMTE4LjU5OCAxNy4wNTFDMTE4Ljk5MyAxNy4zOTYzIDExOS4zMiAxNy43OTkyIDExOS41ODUgMTguMjU0NEMxMTkuNzEzIDE4LjQ3MTUgMTE5LjgyMyAxOC42OTkxIDExOS45MTcgMTguOTMxOUMxMTkuOTcyIDE5LjA2NTMgMTIwLjAxNCAxOS4yMDQgMTIwLjA1NiAxOS4zNDI2QzEyMC4wOTIgMTkuNDU1MSAxMjAuMTI0IDE5LjU3MDIgMTIwLjE1MiAxOS42ODUzQzEyMC4xNjggMTkuNzQ1NSAxMjAuMTc2IDE5LjgwODMgMTIwLjE4NiAxOS44NzFDMTIwLjIwMiAxOS45NDY5IDEyMC4yMTUgMjAuMDIyOCAxMjAuMjMxIDIwLjEwMTJDMTIwLjIzMyAyMC4xMDkxIDEyMC4yMzMgMjAuMTE5NiAxMjAuMjM2IDIwLjEyNzRDMTIwLjI0NCAyMC4xOTU0IDEyMC4yNTcgMjAuMjY2MSAxMjAuMjYgMjAuMzM0MUMxMjAuMjY1IDIwLjU2OTUgMTIwLjMwMSAyMC44MDIzIDEyMC4yNzMgMjEuMDM3OEMxMjAuMjY3IDIxLjA3OTYgMTIwLjI3IDIxLjEyMTUgMTIwLjI2NyAyMS4xNjA3QzEyMC4yNTcgMjEuMjkxNSAxMjAuMjUyIDIxLjQyMjMgMTIwLjIzMyAyMS41NTA1QzEyMC4yMTggMjEuNjc2MSAxMjAuMTg5IDIxLjc5NjQgMTIwLjE2NSAyMS45MjJDMTIwLjE0NyAyMi4wMTYyIDEyMC4xMjkgMjIuMTEyOSAxMjAuMTA1IDIyLjIwNzFDMTIwLjA3NiAyMi4zMTQ0IDEyMC4wNDUgMjIuNDE5IDEyMC4wMDggMjIuNTIzN0MxMTkuOTY3IDIyLjY0OTIgMTE5LjkyMiAyMi43NzIyIDExOS44NzUgMjIuODk1MUMxMTkuNzcgMjMuMTY0NiAxMTkuNjQyIDIzLjQyMDkgMTE5LjQ5IDIzLjY2OTVDMTE5LjAwNyAyNC40NTQzIDExOC4zMzkgMjUuMDM1IDExNy41MSAyNS40M0MxMTcuMjIyIDI1LjU2ODcgMTE2LjkyNCAyNS42ODEyIDExNi42MTggMjUuNzY3NUMxMTYuNDE0IDI1LjgyMjQgMTE2LjIwNyAyNS44Nzc0IDExNS45OTggMjUuOTIxOEMxMTUuODI4IDI1Ljk1ODUgMTE1LjY1OCAyNS45OTI1IDExNS40ODUgMjYuMDE2QzExNS4xMzcgMjYuMDYwNSAxMTQuNzg3IDI2LjA5NDUgMTE0LjQzNiAyNi4wNjgzQzExNC4xOSAyNi4wNSAxMTMuOTQ3IDI2LjAyMzkgMTEzLjcwNCAyNS45ODk5QzExMy40NzYgMjUuOTU1OCAxMTMuMjQ5IDI1LjkxNjYgMTEzLjAyNCAyNS44NjE3QzExMi40ODcgMjUuNzMzNSAxMTEuOTcyIDI1LjU1MDQgMTExLjUwNCAyNS4yNDk1QzExMS4wNDEgMjQuOTQ4NyAxMTAuNjQzIDI0LjU4MjQgMTEwLjMwNiAyNC4xNDU2QzExMC4wODkgMjMuODYwNCAxMDkuOTA1IDIzLjU1NDQgMTA5Ljc1MSAyMy4yM0MxMDkuNjY3IDIzLjA1MjEgMTA5LjU5NCAyMi44NzE2IDEwOS41MjkgMjIuNjg1OUMxMDkuNDkyIDIyLjU4OTEgMTA5LjQ2OSAyMi40ODcgMTA5LjQ0IDIyLjM4NzZDMTA5LjQwNiAyMi4yNjk5IDEwOS4zNzQgMjIuMTQ5NiAxMDkuMzQ2IDIyLjAzMTlDMTA5LjMzIDIxLjk3MTcgMTA5LjMyMiAyMS45MDg5IDEwOS4zMTIgMjEuODQ2MUMxMDkuMjk5IDIxLjc3MDMgMTA5LjI4MyAyMS42OTE4IDEwOS4yNyAyMS42MTU5QzEwOS4yNyAyMS42MTA3IDEwOS4yNjcgMjEuNjAyOCAxMDkuMjY1IDIxLjU5NzZDMTA5LjI1NCAyMS40OTMgMTA5LjI0MSAyMS4zODU3IDEwOS4yMzMgMjEuMjgxMUMxMDkuMjIzIDIxLjEwMzIgMTA5LjIxIDIwLjkyNTMgMTA5LjIxMiAyMC43NDc0QzEwOS4yMTIgMjAuNTk1NyAxMDkuMjI1IDIwLjQ0MzkgMTA5LjI0MSAyMC4yOTIyQzEwOS4yNTEgMjAuMTc3MSAxMDkuMjcgMjAuMDY0NiAxMDkuMjkzIDE5Ljk1MjFDMTA5LjMyIDE5LjgyNCAxMDkuMzU0IDE5LjY5NTggMTA5LjM4OCAxOS41Njc2QzEwOS40MTkgMTkuNDUyNSAxMDkuNDU4IDE5LjM0MjYgMTA5LjQ5NSAxOS4yMzAxQzEwOS41NTIgMTkuMDU0OCAxMDkuNjI4IDE4Ljg4NDggMTA5LjcxNSAxOC43MkMxMTAuMDI4IDE4LjExMDUgMTEwLjQ0NCAxNy41Nzk0IDExMC45NTcgMTcuMTI0MkMxMTEuMzg5IDE2LjczOTcgMTExLjg2NyAxNi40MzM2IDExMi4zOTkgMTYuMjA2QzExMi42NDIgMTYuMTAxNCAxMTIuODkzIDE2LjAxNzcgMTEzLjE1MiAxNS45NTc1QzExMy4zODUgMTUuOTA1MiAxMTMuNjIgMTUuODYwNyAxMTMuODU4IDE1LjgyOTNDMTE0LjE2NCAxNS43Nzk2IDExNC40NzYgMTUuNzY5MiAxMTQuNzg3IDE1Ljc3MThaTTExNi42NjUgMjEuMjUyM0MxMTYuNjYzIDIxLjI1MjMgMTE2LjY2IDIxLjI1MjMgMTE2LjY1NyAyMS4yNTIzQzExNi42NTcgMjEuMDE5NSAxMTYuNjYgMjAuNzg2NiAxMTYuNjU3IDIwLjU1MzhDMTE2LjY1NSAyMC4zNzU5IDExNi42MzkgMjAuMTk4IDExNi42MjkgMjAuMDIwMkMxMTYuNjI5IDIwLjAwOTcgMTE2LjYyNiAxOS45OTkyIDExNi42MjMgMTkuOTg4OEMxMTYuNjA4IDE5LjkwNSAxMTYuNTk1IDE5LjgyMTMgMTE2LjU3OSAxOS43NDAyQzExNi41NjEgMTkuNjQzNCAxMTYuNTQ4IDE5LjU0NCAxMTYuNTE5IDE5LjQ0NzJDMTE2LjQ3OSAxOS4zMDYgMTE2LjQzIDE5LjE2NzMgMTE2LjM3MiAxOS4wMzM5QzExNi4yNTIgMTguNzUxNCAxMTYuMDg3IDE4LjQ5NzYgMTE1Ljg3IDE4LjI3NzlDMTE1LjcwOCAxOC4xMTMxIDExNS41MjIgMTcuOTgyMyAxMTUuMzA4IDE3Ljg5ODZDMTE1LjA0NiAxNy43OTY2IDExNC43NzEgMTcuNzcwNCAxMTQuNDk0IDE3Ljc3M0MxMTQuNDI2IDE3Ljc3MyAxMTQuMzU1IDE3Ljc4MDkgMTE0LjI4NyAxNy43OTM5QzExNC4xNDMgMTcuODI1MyAxMTQuMDA3IDE3Ljg3NzcgMTEzLjg4NCAxNy45NTYxQzExMy41OTEgMTguMTQ0NSAxMTMuMzY2IDE4LjM5MyAxMTMuMjA3IDE4LjY5OTFDMTEzLjA4NCAxOC45MzE5IDExMi45OSAxOS4xNzc4IDExMi45NCAxOS40Mzk0QzExMi45MTQgMTkuNTcwMiAxMTIuODg1IDE5LjcwMzYgMTEyLjg2OSAxOS44MzQ0QzExMi44NTEgMjAuMDIwMiAxMTIuODMgMjAuMjA1OSAxMTIuODMzIDIwLjM5NDJDMTEyLjgzMyAyMC41MDQxIDExMi44MjUgMjAuNjExNCAxMTIuODIyIDIwLjcyMTJDMTEyLjgyIDIwLjgyODUgMTEyLjgxMiAyMC45MzU3IDExMi44MjIgMjEuMDQwNEMxMTIuODQzIDIxLjIyODcgMTEyLjgzMyAyMS40MTk3IDExMi44NTkgMjEuNjA4MUMxMTIuODc3IDIxLjczMzYgMTEyLjg5IDIxLjg2MTggMTEyLjkxNCAyMS45ODc0QzExMi45MzUgMjIuMTA3NyAxMTIuOTU4IDIyLjIyODEgMTEyLjk5NSAyMi4zNDg0QzExMy4wMzQgMjIuNDgxOCAxMTMuMDY2IDIyLjYxNTIgMTEzLjExIDIyLjc0NkMxMTMuMTYyIDIyLjkwMDQgMTEzLjIzIDIzLjA0OTUgMTEzLjMxNCAyMy4xOTA3QzExMy40MjcgMjMuMzc5MSAxMTMuNTYzIDIzLjU0OTEgMTEzLjc0NiAyMy42NzczQzExNC4xMiAyMy45MzM3IDExNC41MzYgMjQuMDYxOSAxMTQuOTg4IDI0LjA2OTdDMTE1LjE2NiAyNC4wNzIzIDExNS4zMzQgMjQuMDM1NyAxMTUuNDk4IDIzLjk3MjlDMTE1LjgxIDIzLjg1MjYgMTE2LjA1MyAyMy42NDU5IDExNi4yNDQgMjMuMzc2NUMxMTYuNDA0IDIzLjE1MTUgMTE2LjUgMjIuOTAwNCAxMTYuNTU4IDIyLjYzMDlDMTE2LjU2OCAyMi41ODEyIDExNi41ODIgMjIuNTI4OSAxMTYuNTg5IDIyLjQ3OTJDMTE2LjYwNSAyMi4zOTI5IDExNi42MjYgMjIuMzAzOSAxMTYuNjMxIDIyLjIxNUMxMTYuNjQyIDIxLjg5MzIgMTE2LjY1MiAyMS41NzQxIDExNi42NjUgMjEuMjUyM1oiIGZpbGw9IiMyNjI2MjYiLz4KPHBhdGggZD0iTTEyNi4zOTQgMTUuNzcxOEMxMjYuNjY2IDE1Ljc2MzkgMTI2LjkzNiAxNS43NzcgMTI3LjIwMyAxNS44MDU4QzEyNy40MDcgMTUuODI5MyAxMjcuNjExIDE1Ljg2MzMgMTI3LjgxNSAxNS45QzEyNy45NTEgMTUuOTIzNSAxMjguMDkgMTUuOTUyMyAxMjguMjIzIDE1Ljk4ODlDMTI4LjQ2NCAxNi4wNTQzIDEyOC42OTkgMTYuMTM4IDEyOC45MjcgMTYuMjRDMTI5LjM5NSAxNi40NDY3IDEyOS44MjQgMTYuNzE2MSAxMzAuMjA2IDE3LjA1MUMxMzAuNjAxIDE3LjM5NjMgMTMwLjkyOCAxNy43OTkyIDEzMS4xOTIgMTguMjU0NEMxMzEuMzIgMTguNDcxNSAxMzEuNDMgMTguNjk5MSAxMzEuNTI0IDE4LjkzMTlDMTMxLjU3OSAxOS4wNjUzIDEzMS42MjEgMTkuMjA0IDEzMS42NjMgMTkuMzQyNkMxMzEuNyAxOS40NTUxIDEzMS43MzEgMTkuNTcwMiAxMzEuNzYgMTkuNjg1M0MxMzEuNzc1IDE5Ljc0NTUgMTMxLjc4MyAxOS44MDgzIDEzMS43OTQgMTkuODcxQzEzMS44MDkgMTkuOTQ2OSAxMzEuODIzIDIwLjAyMjggMTMxLjgzOCAyMC4xMDEyQzEzMS44NDEgMjAuMTA5MSAxMzEuODQxIDIwLjExOTYgMTMxLjg0MyAyMC4xMjc0QzEzMS44NTEgMjAuMTk1NCAxMzEuODY0IDIwLjI2NjEgMTMxLjg2NyAyMC4zMzQxQzEzMS44NzIgMjAuNTY5NSAxMzEuOTA5IDIwLjgwMjMgMTMxLjg4IDIxLjAzNzhDMTMxLjg3NSAyMS4wNzk2IDEzMS44NzcgMjEuMTIxNSAxMzEuODc1IDIxLjE2MDdDMTMxLjg2NCAyMS4yOTE1IDEzMS44NTkgMjEuNDIyMyAxMzEuODQxIDIxLjU1MDVDMTMxLjgyNSAyMS42NzYxIDEzMS43OTYgMjEuNzk2NCAxMzEuNzczIDIxLjkyMkMxMzEuNzU1IDIyLjAxNjIgMTMxLjczNiAyMi4xMTI5IDEzMS43MTMgMjIuMjA3MUMxMzEuNjg0IDIyLjMxNDQgMTMxLjY1MyAyMi40MTkgMTMxLjYxNiAyMi41MjM3QzEzMS41NzQgMjIuNjQ5MiAxMzEuNTMgMjIuNzcyMiAxMzEuNDgyIDIyLjg5NTFDMTMxLjM3OCAyMy4xNjQ2IDEzMS4yNSAyMy40MjA5IDEzMS4wOTggMjMuNjY5NUMxMzAuNjE0IDI0LjQ1NDMgMTI5Ljk0NyAyNS4wMzUgMTI5LjExOCAyNS40M0MxMjguODMgMjUuNTY4NyAxMjguNTMyIDI1LjY4MTIgMTI4LjIyNiAyNS43Njc1QzEyOC4wMjIgMjUuODIyNCAxMjcuODE1IDI1Ljg3NzQgMTI3LjYwNiAyNS45MjE4QzEyNy40MzYgMjUuOTU4NSAxMjcuMjY1IDI1Ljk5MjUgMTI3LjA5MyAyNi4wMTZDMTI2Ljc0NSAyNi4wNjA1IDEyNi4zOTQgMjYuMDk0NSAxMjYuMDQ0IDI2LjA2ODNDMTI1Ljc5OCAyNi4wNSAxMjUuNTU1IDI2LjAyMzkgMTI1LjMxMSAyNS45ODk5QzEyNS4wODQgMjUuOTU1OCAxMjQuODU2IDI1LjkxNjYgMTI0LjYzMSAyNS44NjE3QzEyNC4wOTUgMjUuNzMzNSAxMjMuNTggMjUuNTUwNCAxMjMuMTExIDI1LjI0OTVDMTIyLjY0OCAyNC45NDg3IDEyMi4yNTEgMjQuNTgyNCAxMjEuOTEzIDI0LjE0NTZDMTIxLjY5NiAyMy44NjA0IDEyMS41MTMgMjMuNTU0NCAxMjEuMzU5IDIzLjIzQzEyMS4yNzUgMjMuMDUyMSAxMjEuMjAyIDIyLjg3MTYgMTIxLjEzNiAyMi42ODU5QzEyMS4xIDIyLjU4OTEgMTIxLjA3NiAyMi40ODcgMTIxLjA0NyAyMi4zODc2QzEyMS4wMTMgMjIuMjY5OSAxMjAuOTgyIDIyLjE0OTYgMTIwLjk1MyAyMi4wMzE5QzEyMC45MzcgMjEuOTcxNyAxMjAuOTMgMjEuOTA4OSAxMjAuOTE5IDIxLjg0NjFDMTIwLjkwNiAyMS43NzAzIDEyMC44OSAyMS42OTE4IDEyMC44NzcgMjEuNjE1OUMxMjAuODc3IDIxLjYxMDcgMTIwLjg3NSAyMS42MDI4IDEyMC44NzIgMjEuNTk3NkMxMjAuODYyIDIxLjQ5MyAxMjAuODQ4IDIxLjM4NTcgMTIwLjg0MSAyMS4yODExQzEyMC44MyAyMS4xMDMyIDEyMC44MTcgMjAuOTI1MyAxMjAuODIgMjAuNzQ3NEMxMjAuODIgMjAuNTk1NyAxMjAuODMzIDIwLjQ0MzkgMTIwLjg0OCAyMC4yOTIyQzEyMC44NTkgMjAuMTc3MSAxMjAuODc3IDIwLjA2NDYgMTIwLjkwMSAxOS45NTIxQzEyMC45MjcgMTkuODI0IDEyMC45NjEgMTkuNjk1OCAxMjAuOTk1IDE5LjU2NzZDMTIxLjAyNiAxOS40NTI1IDEyMS4wNjYgMTkuMzQyNiAxMjEuMTAyIDE5LjIzMDFDMTIxLjE2IDE5LjA1NDggMTIxLjIzNiAxOC44ODQ4IDEyMS4zMjIgMTguNzJDMTIxLjYzNiAxOC4xMTA1IDEyMi4wNTIgMTcuNTc5NCAxMjIuNTY1IDE3LjEyNDJDMTIyLjk5NiAxNi43Mzk3IDEyMy40NzUgMTYuNDMzNiAxMjQuMDA2IDE2LjIwNkMxMjQuMjQ5IDE2LjEwMTQgMTI0LjUgMTYuMDE3NyAxMjQuNzU5IDE1Ljk1NzVDMTI0Ljk5MiAxNS45MDUyIDEyNS4yMjggMTUuODYwNyAxMjUuNDY2IDE1LjgyOTNDMTI1Ljc3MiAxNS43Nzk2IDEyNi4wODMgMTUuNzY5MiAxMjYuMzk0IDE1Ljc3MThaTTEyOC4yNzMgMjEuMjUyM0MxMjguMjcgMjEuMjUyMyAxMjguMjY3IDIxLjI1MjMgMTI4LjI2NSAyMS4yNTIzQzEyOC4yNjUgMjEuMDE5NSAxMjguMjY3IDIwLjc4NjYgMTI4LjI2NSAyMC41NTM4QzEyOC4yNjIgMjAuMzc1OSAxMjguMjQ2IDIwLjE5OCAxMjguMjM2IDIwLjAyMDJDMTI4LjIzNiAyMC4wMDk3IDEyOC4yMzMgMTkuOTk5MiAxMjguMjMxIDE5Ljk4ODhDMTI4LjIxNSAxOS45MDUgMTI4LjIwMiAxOS44MjEzIDEyOC4xODYgMTkuNzQwMkMxMjguMTY4IDE5LjY0MzQgMTI4LjE1NSAxOS41NDQgMTI4LjEyNiAxOS40NDcyQzEyOC4wODcgMTkuMzA2IDEyOC4wMzcgMTkuMTY3MyAxMjcuOTggMTkuMDMzOUMxMjcuODU5IDE4Ljc1MTQgMTI3LjY5NSAxOC40OTc2IDEyNy40NzcgMTguMjc3OUMxMjcuMzE1IDE4LjExMzEgMTI3LjEyOSAxNy45ODIzIDEyNi45MTUgMTcuODk4NkMxMjYuNjUzIDE3Ljc5NjYgMTI2LjM3OSAxNy43NzA0IDEyNi4xMDEgMTcuNzczQzEyNi4wMzMgMTcuNzczIDEyNS45NjMgMTcuNzgwOSAxMjUuODk1IDE3Ljc5MzlDMTI1Ljc1MSAxNy44MjUzIDEyNS42MTUgMTcuODc3NyAxMjUuNDkyIDE3Ljk1NjFDMTI1LjE5OSAxOC4xNDQ1IDEyNC45NzQgMTguMzkzIDEyNC44MTQgMTguNjk5MUMxMjQuNjkxIDE4LjkzMTkgMTI0LjU5NyAxOS4xNzc4IDEyNC41NDcgMTkuNDM5NEMxMjQuNTIxIDE5LjU3MDIgMTI0LjQ5MyAxOS43MDM2IDEyNC40NzcgMTkuODM0NEMxMjQuNDU5IDIwLjAyMDIgMTI0LjQzOCAyMC4yMDU5IDEyNC40NCAyMC4zOTQyQzEyNC40NCAyMC41MDQxIDEyNC40MzIgMjAuNjExNCAxMjQuNDMgMjAuNzIxMkMxMjQuNDI3IDIwLjgyODUgMTI0LjQxOSAyMC45MzU3IDEyNC40MyAyMS4wNDA0QzEyNC40NTEgMjEuMjI4NyAxMjQuNDQgMjEuNDE5NyAxMjQuNDY2IDIxLjYwODFDMTI0LjQ4NSAyMS43MzM2IDEyNC40OTggMjEuODYxOCAxMjQuNTIxIDIxLjk4NzRDMTI0LjU0MiAyMi4xMDc3IDEyNC41NjYgMjIuMjI4MSAxMjQuNjAyIDIyLjM0ODRDMTI0LjY0MiAyMi40ODE4IDEyNC42NzMgMjIuNjE1MiAxMjQuNzE4IDIyLjc0NkMxMjQuNzcgMjIuOTAwNCAxMjQuODM4IDIzLjA0OTUgMTI0LjkyMiAyMy4xOTA3QzEyNS4wMzQgMjMuMzc5MSAxMjUuMTcgMjMuNTQ5MSAxMjUuMzUzIDIzLjY3NzNDMTI1LjcyNyAyMy45MzM3IDEyNi4xNDMgMjQuMDYxOSAxMjYuNTk2IDI0LjA2OTdDMTI2Ljc3NCAyNC4wNzIzIDEyNi45NDEgMjQuMDM1NyAxMjcuMTA2IDIzLjk3MjlDMTI3LjQxNyAyMy44NTI2IDEyNy42NjEgMjMuNjQ1OSAxMjcuODUxIDIzLjM3NjVDMTI4LjAxMSAyMy4xNTE1IDEyOC4xMDggMjIuOTAwNCAxMjguMTY1IDIyLjYzMDlDMTI4LjE3NiAyMi41ODEyIDEyOC4xODkgMjIuNTI4OSAxMjguMTk3IDIyLjQ3OTJDMTI4LjIxMiAyMi4zOTI5IDEyOC4yMzMgMjIuMzAzOSAxMjguMjM5IDIyLjIxNUMxMjguMjQ5IDIxLjg5MzIgMTI4LjI2IDIxLjU3NDEgMTI4LjI3MyAyMS4yNTIzWiIgZmlsbD0iIzI2MjYyNiIvPgo8cGF0aCBkPSJNMTMyLjEwOCAyNS43MjY0QzEzMi4yMjkgMjUuNjE5OSAxMzIuMzM1IDI1LjUxMzQgMTMyLjQ0MiAyNS4zOTM2QzEzMi41NjIgMjUuMjYwNSAxMzIuNjU2IDI1LjExNCAxMzIuNzM2IDI0Ljk1NDNDMTMyLjgwMyAyNC44MjEyIDEzMi44NDMgMjQuNjYxNSAxMzIuODY5IDI0LjUxNUMxMzIuOTEgMjQuMjYyMSAxMzIuOTEgMjQuMDA5MiAxMzIuOTEgMjMuNzQzQzEzMi45MSAyMi40Nzg0IDEzMi45MSAyMS4yMjcxIDEzMi45MSAxOS45NjI2QzEzMi45MSAxOS40NTY4IDEzMi44OTYgMTguOTUwOSAxMzIuOTEgMTguNDQ1MUMxMzIuOTEgMTguMTc4OSAxMzIuOTIzIDE3LjkxMjYgMTMyLjg5NiAxNy42NDY0QzEzMi44ODMgMTcuNDA2OCAxMzIuODQzIDE3LjE2NzIgMTMyLjc0OSAxNi45NTQyQzEzMi42NTYgMTYuNzU0NiAxMzIuNTA5IDE2LjU2ODIgMTMyLjM3NSAxNi4zOTUyQzEzMi4yOTUgMTYuMjg4NyAxMzIuMjE1IDE2LjE5NTUgMTMyLjEzNSAxNi4xMDIzQzEzMi4zMjIgMTYuMTAyMyAxMzIuNTIyIDE2LjExNTYgMTMyLjcwOSAxNi4xMTU2QzEzMy4xNjMgMTYuMTI4OSAxMzMuNjA0IDE2LjEyODkgMTM0LjA1OCAxNi4xMjg5QzEzNC40NTggMTYuMTI4OSAxMzQuODU5IDE2LjExNTYgMTM1LjI1OSAxNi4wNzU3QzEzNS40NzMgMTYuMDYyNCAxMzUuNjg3IDE2LjAzNTggMTM1LjkgMTUuOTgyNUMxMzYuMTI3IDE1LjkyOTMgMTM2LjM1NCAxNS44NjI3IDEzNi41ODEgMTUuNzY5NUMxMzYuNTgxIDE2LjE0MjIgMTM2LjU4MSAxNi41MTUgMTM2LjU4MSAxNi44NzQ0QzEzNi42MjEgMTYuODg3NyAxMzYuNjQ4IDE2Ljg4NzcgMTM2LjY4OCAxNi44NzQ0QzEzNi43MjggMTYuODYxMSAxMzYuNzY4IDE2LjgzNDQgMTM2LjgwOCAxNi44MDc4QzEzNi45OTUgMTYuNjYxNCAxMzcuMTQyIDE2LjQ3NSAxMzcuMzE2IDE2LjM0MTlDMTM3LjUyOSAxNi4xNjg5IDEzNy43OTYgMTYuMDQ5MSAxMzguMDYzIDE1Ljk2OTJDMTM4LjQxMSAxNS44NjI3IDEzOC43NTggMTUuODIyOCAxMzkuMTMyIDE1LjgyMjhDMTM5LjU5OSAxNS44MjI4IDE0MC4wOCAxNS44NzYgMTQwLjQ1MyAxNi4wNDkxQzE0MC42NCAxNi4xNDIyIDE0MC44MDEgMTYuMjYyMSAxNDAuOTg3IDE2LjQyMThDMTQxLjE4OCAxNi41OTQ4IDE0MS40NDEgMTYuODA3OCAxNDEuNjQyIDE2Ljk2NzVDMTQxLjgyOSAxNi43OTQ1IDE0Mi4wMjkgMTYuNjM0OCAxNDIuMjQzIDE2LjUwMTdDMTQyLjYwMyAxNi4yNzU0IDE0Mi45OSAxNi4xMDIzIDE0My40MDQgMTYuMDA5MUMxNDMuNzc4IDE1LjkxNiAxNDQuMTY1IDE1Ljg2MjcgMTQ0LjU1MiAxNS44NjI3QzE0NC45NjYgMTUuODQ5NCAxNDUuMzk0IDE1Ljg4OTMgMTQ1LjgwOCAxNS45ODI1QzE0Ni4zNTUgMTYuMTE1NiAxNDYuODc2IDE2LjM1NTIgMTQ3LjMwMyAxNi43MTQ2QzE0Ny41NTcgMTYuOTE0MyAxNDcuNzcgMTcuMTUzOSAxNDcuOTQ0IDE3LjQyMDFDMTQ4LjExNyAxNy42ODY0IDE0OC4yMzggMTcuOTkyNSAxNDguMjkxIDE4LjMxMkMxNDguMzMxIDE4LjU2NDkgMTQ4LjMzMSAxOC44MzExIDE0OC4zMzEgMTkuMDg0QzE0OC4zMzEgMTkuODQyOCAxNDguMzMxIDIwLjU4ODIgMTQ4LjMzMSAyMS4zMzM2QzE0OC4zMzEgMjEuNjUzMSAxNDguMzMxIDIxLjk3MjYgMTQ4LjMzMSAyMi4zMDU0QzE0OC4zMzEgMjIuNjM4MSAxNDguMzMxIDIyLjk1NzYgMTQ4LjMzMSAyMy4yOTA0QzE0OC4zMzEgMjMuNTU2NiAxNDguMzMxIDIzLjgwOTUgMTQ4LjMzMSAyNC4wNzU4QzE0OC4zMzEgMjQuMzE1NCAxNDguMzQ0IDI0LjU2ODMgMTQ4LjQxMSAyNC43OTQ2QzE0OC40NzggMjUuMDA3NiAxNDguNjI1IDI1LjIwNzIgMTQ4Ljc1OCAyNS4zOTM2QzE0OC44MzggMjUuNTAwMSAxNDguOTMyIDI1LjYwNjYgMTQ5LjA5MiAyNS43Mzk3QzE0Ny4zNTYgMjUuNzM5NyAxNDUuNjIxIDI1LjczOTcgMTQzLjg3MiAyNS43Mzk3QzE0My45OTIgMjUuNjE5OSAxNDQuMDk4IDI1LjUwMDEgMTQ0LjIwNSAyNS4zODAzQzE0NC4zMTIgMjUuMjQ3MiAxNDQuNDA2IDI1LjEyNzQgMTQ0LjQ3MiAyNC45ODA5QzE0NC41MzkgMjQuODQ3OCAxNDQuNTY2IDI0LjY4ODEgMTQ0LjU5MyAyNC41MjgzQzE0NC42MDYgMjQuNDM1MiAxNDQuNjE5IDI0LjMyODcgMTQ0LjYxOSAyNC4yMzU1QzE0NC42MTkgMjQuMTQyMyAxNDQuNjE5IDI0LjA0OTEgMTQ0LjYxOSAyMy45NTZDMTQ0LjYwNiAyMy4xNDQgMTQ0LjYxOSAyMi4zMTg3IDE0NC42MTkgMjEuNTA2N0MxNDQuNjE5IDIxLjE0NzMgMTQ0LjYxOSAyMC44MDEyIDE0NC42MTkgMjAuNDQxOEMxNDQuNjE5IDIwLjA4MjQgMTQ0LjYzMyAxOS43MDk3IDE0NC42MTkgMTkuMzUwM0MxNDQuNjE5IDE5LjIxNzIgMTQ0LjYwNiAxOS4wOTczIDE0NC41OTMgMTguOTc3NUMxNDQuNTY2IDE4LjgxNzggMTQ0LjQ4NiAxOC42NTgxIDE0NC4zOTIgMTguNTI1QzE0NC4yODUgMTguMzc4NSAxNDQuMTUyIDE4LjI1ODcgMTQ0LjAwNSAxOC4xNzg5QzE0My44NDUgMTguMDk5IDE0My42NDUgMTguMDU5MSAxNDMuNDcxIDE4LjA3MjRDMTQzLjIzMSAxOC4wODU3IDE0My4wMDQgMTguMTkyMiAxNDIuODQzIDE4LjM1MTlDMTQyLjY5NyAxOC40OTgzIDE0Mi41OSAxOC42ODQ3IDE0Mi41MzYgMTguODg0NEMxNDIuNDk2IDE5LjA0NDEgMTQyLjQ5NiAxOS4yMDM4IDE0Mi40OTYgMTkuMzYzNkMxNDIuNDk2IDE5LjUxIDE0Mi40OTYgMTkuNjQzMSAxNDIuNDk2IDE5Ljc4OTVDMTQyLjQ5NiAyMC4xNzU2IDE0Mi40OTYgMjAuNTc0OSAxNDIuNDk2IDIwLjk2MDlDMTQyLjQ5NiAyMS45NDYgMTQyLjUxIDIyLjkzMSAxNDIuNDk2IDIzLjkwMjdDMTQyLjQ5NiAyNC4wMzU4IDE0Mi40OTYgMjQuMTgyMyAxNDIuNDk2IDI0LjMxNTRDMTQyLjUxIDI0LjUwMTcgMTQyLjUyMyAyNC43MDE0IDE0Mi42MDMgMjQuODc0NEMxNDIuNjgzIDI1LjA3NDEgMTQyLjgxNyAyNS4yNDcyIDE0Mi45NjQgMjUuNDIwMkMxNDMuMDU3IDI1LjU0IDE0My4xNjQgMjUuNjQ2NSAxNDMuMjcxIDI1Ljc1M0MxNDEuNTIyIDI1Ljc1MyAxMzkuNzg2IDI1Ljc1MyAxMzguMDM3IDI1Ljc1M0MxMzguMTU3IDI1LjYzMzIgMTM4LjI2NCAyNS41MTM0IDEzOC4zNyAyNS4zOTM2QzEzOC40NzcgMjUuMjYwNSAxMzguNTcxIDI1LjE0MDcgMTM4LjYzOCAyNC45OTQyQzEzOC43MDQgMjQuODYxMSAxMzguNzMxIDI0LjcwMTQgMTM4Ljc1OCAyNC41NDE3QzEzOC43NzEgMjQuNDQ4NSAxMzguNzg0IDI0LjM0MiAxMzguNzg0IDI0LjI0ODhDMTM4Ljc4NCAyNC4xNTU2IDEzOC43ODQgMjQuMDYyNCAxMzguNzg0IDIzLjk2OTNDMTM4Ljc3MSAyMy4xNTczIDEzOC43ODQgMjIuMzMyIDEzOC43ODQgMjEuNTJDMTM4Ljc4NCAyMS4xNjA2IDEzOC43ODQgMjAuODE0NSAxMzguNzg0IDIwLjQ1NTFDMTM4Ljc4NCAyMC4wOTU3IDEzOC43OTggMTkuNzIzIDEzOC43ODQgMTkuMzYzNkMxMzguNzg0IDE5LjIzMDUgMTM4Ljc3MSAxOS4xMTA3IDEzOC43NTggMTguOTkwOUMxMzguNzMxIDE4LjgzMTEgMTM4LjY1MSAxOC42NzE0IDEzOC41NTcgMTguNTM4M0MxMzguNDUxIDE4LjM5MTkgMTM4LjMxNyAxOC4yNzIxIDEzOC4xNyAxOC4xOTIyQzEzOC4wMSAxOC4xMTIzIDEzNy44MSAxOC4wNzI0IDEzNy42MzYgMTguMDg1N0MxMzcuMzk2IDE4LjA5OSAxMzcuMTY5IDE4LjIwNTUgMTM3LjAwOSAxOC4zNjUyQzEzNi44NjIgMTguNTExNyAxMzYuNzU1IDE4LjY5OCAxMzYuNzAxIDE4Ljg5NzdDMTM2LjY2MSAxOS4wNTc0IDEzNi42NjEgMTkuMjE3MSAxMzYuNjYxIDE5LjM3NjlDMTM2LjY2MSAxOS41MjMzIDEzNi42NjEgMTkuNjU2NCAxMzYuNjYxIDE5LjgwMjhDMTM2LjY2MSAyMC4xODg5IDEzNi42NjEgMjAuNTg4MiAxMzYuNjYxIDIwLjk3NDJDMTM2LjY2MSAyMS45NTkzIDEzNi42NzUgMjIuOTQ0MyAxMzYuNjYxIDIzLjkxNkMxMzYuNjYxIDI0LjA0OTEgMTM2LjY2MSAyNC4xOTU2IDEzNi42NjEgMjQuMzI4N0MxMzYuNjc1IDI0LjUxNSAxMzYuNjg4IDI0LjcxNDcgMTM2Ljc2OCAyNC44ODc3QzEzNi44NDggMjUuMDg3NCAxMzYuOTgyIDI1LjI2MDUgMTM3LjEyOSAyNS40MzM1QzEzNy4yMjIgMjUuNTUzMyAxMzcuMzI5IDI1LjY1OTggMTM3LjQzNiAyNS43NjYzQzEzNS42MDcgMjUuNzI2NCAxMzMuODU4IDI1LjcyNjQgMTMyLjEwOCAyNS43MjY0WiIgZmlsbD0iIzI2MjYyNiIvPgo8L3N2Zz4=" alt="WhisperRoom" class="logo-img">
    <div class="header-right">
      <div class="order-type">Production Order</div>
      <div class="order-num">${q.quoteNumber||'ORDER'}</div>
      ${(q.rep||REPS[q.ownerId])?`<div style="font-size:11px;color:#888;margin-top:4px;font-weight:600">${q.rep||REPS[q.ownerId]||''}</div>`:''}
      <div class="order-meta">Processed ${issueDate}</div>
      <div class="order-tag">&#x2713; Order Confirmed</div>
      ${q.quoteLabel ? `<div style="margin-top:8px;display:block;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#ee6216;background:rgba(238,98,22,.08);border:1px solid rgba(238,98,22,.25);border-radius:4px;padding:4px 12px;width:fit-content;margin-left:auto">${q.quoteLabel}</div>` : ''}
    </div>
  </div>
  <div class="accent-strip"></div>

  ${c.firstName||c.company ? `<div class="card">
    <div class="card-label">Ship To</div>
    <div class="info-grid">
      ${c.firstName?`<div class="info-item"><label>Name</label><span>${c.firstName} ${c.lastName}</span></div>`:''}
      ${c.company?`<div class="info-item"><label>Company</label><span>${c.company}</span></div>`:''}
      ${c.email?`<div class="info-item"><label>Email</label><span>${c.email}</span></div>`:''}
      ${(c.address||c.city||c.state||c.zip)?`<div class="info-item"><label>Delivery Address</label><span>${[c.address,c.city,(c.state&&c.zip?c.state+' '+c.zip:c.state||c.zip)].filter(Boolean).join(', ')}</span></div>`:''}
      ${q.billing && (q.billing.address || q.billing.email) ? `<div class="info-item" style="margin-top:10px;padding-top:10px;border-top:1px solid #f0f0f0"><label>Bill To</label><span>${[q.billing.email||'',q.billing.address||'',[q.billing.city,(q.billing.state&&q.billing.zip?q.billing.state+' '+q.billing.zip:q.billing.state||q.billing.zip)].filter(Boolean).join(', ')].filter(Boolean).join('<br>')}</span></div>` : ''}
    </div>
  </div>` : ''}

  <div class="card">
    <div class="card-label">Order Specifications</div>
    <div class="info-grid">
      <div class="info-item"><label>Foam Color</label><span>${o.foamColor||'Not specified'}</span></div>
      <div class="info-item"><label>Door Hinge</label><span>${o.hingePreference||'Not specified'}</span></div>
    </div>
    ${o.productionNotes?`<div style="margin-top:16px"><div style="font-size:10px;color:#bbb;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Production Notes</div><div class="notes-box">${o.productionNotes}</div></div>`:''}
    ${o.deliveryNotes?`<div style="margin-top:12px"><div style="font-size:10px;color:#bbb;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Special Delivery Notes</div><div class="notes-box">${o.deliveryNotes}</div></div>`:''}
  </div>

  <div class="card">
    <div class="card-label">Line Items</div>
    <table>
      <thead><tr>
        <th>Item</th>
        <th style="text-align:center">Qty</th>
        <th style="text-align:right">Unit Price</th>
        <th style="text-align:right">Weight</th>
        <th style="text-align:right">Total</th>
      </tr></thead>
      <tbody>${lineRows}</tbody>
    </table>
    <div class="totals">
      <div class="tot"><span>Subtotal</span><span>${fmt(sub)}</span></div>
      ${disc>0?`<div class="tot"><span>Discount${q.discount&&q.discount.type==='pct'?' ('+q.discount.value+'%)':''}</span><span class="discount-val">-${fmt(disc)}</span></div>`:''}
      ${freightTbd?'<div class="tot"><span>Freight</span><span style="color:#888;font-style:italic">TBD</span></div>':freightAmt>0?`<div class="tot"><span>Freight</span><span>${fmt(freightAmt)}</span></div>`:''}
      ${taxAmt>0?`<div class="tot"><span>Sales Tax${q.tax&&q.tax.rate?' ('+(q.tax.rate*100).toFixed(2).replace(/\.?0+$/,'')+'%)':''}</span><span>${fmt(taxAmt)}</span></div>`:''}
      ${(q.taxExempt||q.accessories?.taxexempt)?'<div class="tot"><span style="color:#22c55e;font-weight:700">✓ Tax Exempt</span><span style="color:#22c55e">'+(q.taxExemptCert||q.taxExemptCertificate||'Exempt')+'</span></div>':''}
      <div class="tot grand"><span>Order Total</span><span>${fmt(total)}</span></div>
      ${totalWeight>0?`<div class="tot weight-total"><span>&#x2696; Total Weight</span><span>${totalWeight.toLocaleString()} lbs</span></div>`:''}
    </div>
  </div>
  ${freightTbd?`<div class="card" style="border-left:3px solid #ee6216;background:#fff8f5">
    <p style="margin:0;font-size:12px;color:#666"><strong style="color:#ee6216">Freight Note:</strong> Freight cost is to be determined. A freight estimate will be provided prior to finalizing your order. The total above does not include freight.</p>
  </div>`:''}

  ${o.shipped&&o.shipped.tracking ? `<div class="card">
    <div class="card-label">Shipment</div>
    <div class="info-grid">
      <div class="info-item"><label>Carrier</label><span>${o.shipped.carrier||'—'}</span></div>
      <div class="info-item"><label>Tracking / PRO</label><span>${o.shipped.tracking}</span></div>
      ${o.shipped.date?`<div class="info-item"><label>Date Shipped</label><span>${new Date(o.shipped.date).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</span></div>`:''}
      ${o.shipped.pallets?`<div class="info-item"><label>Pallets</label><span>${o.shipped.pallets}</span></div>`:''}
      ${o.shipped.boxes?`<div class="info-item"><label>Boxes</label><span>${o.shipped.boxes}</span></div>`:''}
    </div>
  </div>` : ''}

  ${o.changeLog&&o.changeLog.length ? `<div class="card">
    <div class="card-label">Change Log</div>
    <div style="font-size:12px;line-height:1.9">
      ${o.changeLog.slice().reverse().map(entry => `
        <div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #f5f5f5;gap:16px">
          <span style="color:#555">${entry.summary}</span>
          <span style="color:#bbb;white-space:nowrap;font-size:11px">${new Date(entry.at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:'America/New_York'})}</span>
        </div>`).join('')}
    </div>
  </div>` : ''}

  <div class="footer">
    <strong>WhisperRoom, Inc.</strong> &middot; 322 Nancy Lynn Lane, Suite 14 &middot; Knoxville, TN 37919<br>
    <a href="tel:18002008168">1-800-200-8168</a> &middot; <a href="mailto:info@whisperroom.com">info@whisperroom.com</a> &middot; <a href="https://www.whisperroom.com" target="_blank">whisperroom.com</a>
  </div>

</div>

<div class="action-bar" id="action-bar">
  <a href="/api/download-order/${encodeURIComponent(q.quoteNumber)}?t=${q._shareToken||''}" class="btn btn-secondary" style="text-decoration:none">&#x2B73;&nbsp; Download PDF</a>
  <button class="btn btn-secondary" onclick="window.print()">&#x1F5A8;&nbsp; Print</button>
</div>

<script>
// Hide action bar on print
window.addEventListener('beforeprint', () => { document.getElementById('action-bar').style.display = 'none'; });
window.addEventListener('afterprint',  () => { document.getElementById('action-bar').style.display = 'flex'; });
</script>
</body>
</html>`;

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch(e) {
      res.writeHead(500); res.end('Error: ' + e.message);
    }
    return;
  }

  // ── API: Process Order ────────────────────────────────────────────
  if (pathname === '/api/process-order' && req.method === 'POST') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    try {
      const body = JSON.parse(await readBody(req));
      const { dealId, quoteNumber, lineItems, freight, tax, discount,
              customer, foamColor, hingePreference, productionNotes,
              deliveryNotes, ownerId, dealName } = body;

      if (!dealId || !quoteNumber) { json({ error: 'Missing dealId or quoteNumber' }, 400); return; }

      // 1. Advance deal to Closed Won
      await httpsRequest({
        hostname: 'api.hubapi.com',
        path: `/crm/v3/objects/deals/${dealId}`,
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
      }, { properties: { dealstage: 'closedwon' } });

      // 1b. Reset line items to the processed quote's exact line items
      try {
        await hsClearDealLineItems(dealId);
        const processedLineItemIds = [];
        const regularItems = (lineItems||[]).filter(i => parseFloat(i.price) >= 0);
        const creditItems2  = (lineItems||[]).filter(i => parseFloat(i.price) < 0);
        for (const item of regularItems) {
          const li = await hsCreateLineItem({
            name: item.name, quantity: String(item.qty),
            price: String(parseFloat(item.price).toFixed(2)),
            hs_product_id: item.productId ? String(item.productId) : undefined,
            description: item.description || '',
          });
          if (li.id) processedLineItemIds.push(li.id);
        }
        for (const cr of creditItems2) {
          const amt = Math.abs(parseFloat(cr.price) * parseInt(cr.qty||1));
          const li = await hsCreateLineItem({ name: cr.name, quantity:'1', price:'0.00', description:`Credit: -$${amt.toFixed(2)}` });
          if (li.id) processedLineItemIds.push(li.id);
        }
        if (freight && freight.total > 0) {
          const fli = await hsCreateLineItem({ name:'Freight', quantity:'1', price:String(parseFloat(freight.total||0).toFixed(2)), description:`LTL freight. Transit: ${freight.transit||'—'}` });
          if (fli.id) processedLineItemIds.push(fli.id);
        }
        if (tax && tax.tax > 0) {
          const tli = await hsCreateLineItem({ name:`Sales Tax (${(tax.rate*100).toFixed(3)}%)`, quantity:'1', price:String(parseFloat(tax.tax).toFixed(2)), description:`State: ${customer?.state||''}` });
          if (tli.id) processedLineItemIds.push(tli.id);
        }
        if (processedLineItemIds.length > 0) await hsBatchAssociateLineItems(dealId, processedLineItemIds);
        console.log(`[process-order] reset ${processedLineItemIds.length} line items on deal ${dealId}`);
      } catch(e) { console.warn('[process-order] line item reset failed:', e.message); }

      // 2. Save order data to DB
      const orderToken = (await db?.query('SELECT share_token FROM quotes WHERE quote_number = $1', [quoteNumber]))?.rows[0]?.share_token || '';
      const orderUrl = `https://sales.whisperroom.com/o/${encodeURIComponent(quoteNumber)}?t=${orderToken}`;
      const orderData = { foamColor, hingePreference, productionNotes, deliveryNotes, processedAt: new Date().toISOString() };

      if (db) {
        try {
          await db.query(`
            CREATE TABLE IF NOT EXISTS orders (
              id           SERIAL PRIMARY KEY,
              quote_number TEXT UNIQUE NOT NULL,
              deal_id      TEXT,
              order_data   JSONB,
              created_at   TIMESTAMPTZ DEFAULT NOW()
            )
          `);
          await db.query(`
            INSERT INTO orders (quote_number, deal_id, order_data)
            VALUES ($1, $2, $3)
            ON CONFLICT (quote_number) DO UPDATE SET
              order_data = EXCLUDED.order_data,
              deal_id    = EXCLUDED.deal_id
          `, [quoteNumber, dealId, JSON.stringify(orderData)]);

          // Also save order link to quotes table
          await db.query('UPDATE quotes SET order_link = $1 WHERE quote_number = $2', [orderUrl, quoteNumber]);
        } catch(e) { console.warn('Order DB save failed:', e.message); }
      }

      // 3. Calculate totals for email
      const sub = (lineItems||[]).reduce((s,i) => s + (parseFloat(i.price)*parseInt(i.qty)), 0);
      const discAmt = discount && discount.value > 0
        ? (discount.type==='pct' ? sub*discount.value/100 : discount.value) : 0;
      const freightTotal = freight ? parseFloat(freight.total||0) : 0;
      const taxTotal = tax ? parseFloat(tax.tax||0) : 0;
      const total = sub - discAmt + freightTotal + taxTotal;
      const totalWeight = (lineItems||[]).reduce((s,i) => s + ((parseFloat(i.weight)||0)*(parseInt(i.qty)||1)), 0);
      const fmt = n => '$' + parseFloat(n||0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,',');
      const c = customer || {};

      // 4. Build notification email
      const lineTable = (lineItems||[]).map(item =>
        `  - ${item.name} (x${item.qty}) — ${fmt(item.price * item.qty)}${item.weight ? ` — ${parseFloat(item.weight)*parseInt(item.qty)} lbs` : ''}`
      ).join('\n');

      const emailBody = [
        `NEW ORDER — ${quoteNumber}`,
        `Deal: ${dealName||quoteNumber}`,
        ``,
        `CUSTOMER`,
        `Name: ${c.firstName||''} ${c.lastName||''}`.trim(),
        c.company ? `Company: ${c.company}` : null,
        c.email   ? `Email: ${c.email}`     : null,
        c.address||c.city||c.state ? `Ship To: ${[c.address,c.city,(c.state&&c.zip?c.state+' '+c.zip:c.state||c.zip)].filter(Boolean).join(', ')}` : null,
        ``,
        `ORDER SPECIFICATIONS`,
        `Foam Color: ${foamColor||'Not specified'}`,
        `Door Hinge: ${hingePreference||'Not specified'}`,
        productionNotes ? `Production Notes: ${productionNotes}` : null,
        deliveryNotes   ? `Delivery Notes: ${deliveryNotes}`     : null,
        ``,
        `LINE ITEMS`,
        lineTable,
        ``,
        `TOTALS`,
        `Subtotal: ${fmt(sub)}`,
        discAmt > 0 ? `Discount: -${fmt(discAmt)}` : null,
        freightTotal > 0 ? `Freight: ${fmt(freightTotal)}` : null,
        taxTotal > 0 ? `Sales Tax: ${fmt(taxTotal)}` : null,
        `Order Total: ${fmt(total)}`,
        totalWeight > 0 ? `Total Weight: ${totalWeight.toLocaleString()} lbs` : null,
        ``,
        `VIEW ORDER PAGE`,
        orderUrl,
        ``,
        `HubSpot Deal: https://app.hubspot.com/contacts/5764220/deal/${dealId}`,
      ].filter(l => l !== null).join('\n');

      // 5. Send emails via HubSpot transactional or direct SMTP
      // Using HubSpot engagement (note) as notification fallback if no SMTP
      const recipients = ['shipping@whisperroom.com', 'accounting@whisperroom.com', 'bentonwhite@whisperroom.com'];

      // Create HubSpot note on deal with full order details
      try {
        await httpsRequest({
          hostname: 'api.hubapi.com',
          path: '/crm/v3/objects/notes',
          method: 'POST',
          headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
        }, {
          properties: {
            hs_note_body: `<b>ORDER PROCESSED — ${quoteNumber}</b><br><br>${emailBody.replace(/\n/g,'<br>')}`,
            hs_timestamp: new Date().toISOString(),
          },
          associations: [{
            to: { id: dealId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }]
          }]
        });
      } catch(e) { console.warn('HubSpot note failed:', e.message); }

      // Send email via HubSpot single send API
      for (const to of recipients) {
        try {
          await httpsRequest({
            hostname: 'api.hubapi.com',
            path: '/crm/v3/objects/emails',
            method: 'POST',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
          }, {
            properties: {
              hs_email_direction: 'EMAIL',
              hs_email_status:    'SENT',
              hs_email_subject:   `New Order: ${quoteNumber} — ${dealName||''}`,
              hs_email_text:      emailBody,
              hs_email_to_email:  to,
              hs_timestamp:       new Date().toISOString(),
            }
          });
        } catch(e) { console.warn(`Email to ${to} failed:`, e.message); }
      }

      console.log(`Order processed: ${quoteNumber}, deal ${dealId} → closedwon`);
      writelog('info', 'order.processed', `Order processed: ${quoteNumber} — ${dealName || '—'}`, { rep: String(ownerId || ''), quoteNum: quoteNumber, dealId: String(dealId || ''), dealName: dealName || null });
      json({ success: true, orderUrl });

      // Upload order PDF to shared orders folder (non-blocking)
      (async () => {
        try {
          const snapRowP = await db?.query('SELECT json_snapshot FROM quotes WHERE quote_number = $1', [quoteNumber]);
          const snapP = snapRowP?.rows[0]?.json_snapshot || {};
          const pdfBufO = await generatePdfBuffer(orderUrl);
          const filename = buildPdfFilename(snapP, quoteNumber, 'Order');
          await gdriveUploadFilePdf(filename, pdfBufO, SHARED_ORDERS_FOLDER);
          console.log(`[process-order] PDF saved to shared orders folder: ${filename}`);
        } catch(e) { console.warn('[process-order] GDrive PDF error:', e.message); }
      })();

    } catch(e) {
      console.error('Process order error:', e.message);
      json({ error: e.message }, 500);
    }
    return;
  }


  // ── PDF Download: Quote ──────────────────────────────────────────
  if (pathname.startsWith('/api/download-order/') && req.method === 'GET') {
    if (!isAuth(req)) { res.writeHead(401); res.end('Unauthorized'); return; }
    const quoteNumber = decodeURIComponent(pathname.replace('/api/download-order/', '').trim());
    try {
      const tokenRow = await db?.query('SELECT share_token, json_snapshot FROM quotes WHERE quote_number = $1', [quoteNumber]);
      const token = tokenRow?.rows[0]?.share_token || '';
      const snap = tokenRow?.rows[0]?.json_snapshot || {};
      const orderUrl = `https://sales.whisperroom.com/o/${encodeURIComponent(quoteNumber)}${token ? '?t=' + token : ''}`;
      const filename = buildPdfFilename(snap, quoteNumber, 'Order');
      await generatePdf(orderUrl, filename, res, req);
    } catch(e) {
      res.writeHead(500); res.end('PDF error: ' + e.message);
    }
    return;
  }

  if (pathname.startsWith('/api/download-quote/') && req.method === 'GET') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    const quoteNumber = decodeURIComponent(pathname.replace('/api/download-quote/', '').trim());
    if (!quoteNumber) { json({ error: 'No quote number' }, 400); return; }

    try {
      // Verify quote exists first
      const quoteData = await getQuoteFromDb(quoteNumber);
      if (!quoteData) { res.writeHead(404); res.end('Quote not found'); return; }

      const filename = buildPdfFilename(quoteData, quoteNumber, 'Quote');
      await generatePdf(
        `https://sales.whisperroom.com/q/${encodeURIComponent(quoteNumber)}`,
        filename, res, req
      );
    } catch(e) {
      console.error('Quote PDF error:', e.message);
      if (!res.headersSent) { res.writeHead(500); res.end('PDF generation failed: ' + e.message); }
    }
    return;
  }

  // ── PDF Download: Invoice ─────────────────────────────────────────
  if (pathname.startsWith('/api/download-invoice/') && req.method === 'GET') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    const quoteNumber = decodeURIComponent(pathname.replace('/api/download-invoice/', '').trim());
    if (!quoteNumber) { json({ error: 'No quote number' }, 400); return; }

    try {
      const quoteData = await getQuoteFromDb(quoteNumber);
      if (!quoteData) { res.writeHead(404); res.end('Invoice not found'); return; }

      const filename = buildPdfFilename(quoteData, quoteNumber, 'Invoice');
      await generatePdf(
        `https://sales.whisperroom.com/i/${encodeURIComponent(quoteNumber)}`,
        filename, res, req
      );
    } catch(e) {
      console.error('Invoice PDF error:', e.message);
      if (!res.headersSent) { res.writeHead(500); res.end('PDF generation failed: ' + e.message); }
    }
    return;
  }

      res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  initDb();
  console.log(`WhisperRoom Quote Builder v${APP_VERSION} running on port ${PORT}`);
  console.log(`HubSpot token: ${HS_TOKEN ? HS_TOKEN.substring(0,12) + '...' : 'NOT SET'}`);
  console.log(`TaxJar key: ${TAXJAR_KEY ? TAXJAR_KEY.substring(0,8) + '...' : 'NOT SET'}`);
  console.log(`HubSpot OAuth: ${HS_CLIENT_ID ? 'configured' : 'password-only mode'}`);
});
