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
  // Exhausted 20 attempts — extend to 3-digit seq
  for (let attempt = 0; attempt < 80; attempt++) {
    const candidate = `W-${dateKey}${String(seq).padStart(2, '0')}`;
    const existing = await db.query(
      `SELECT deal_id, contact_id FROM quotes WHERE quote_number = $1 LIMIT 1`,
      [candidate]
    );
    if (existing.rows.length === 0) return candidate;
    const ex = existing.rows[0];
    const sameDeal    = dealId    && ex.deal_id    && ex.deal_id    === dealId;
    const sameContact = contactId && ex.contact_id && ex.contact_id === contactId;
    if (sameDeal || sameContact) return candidate;
    seq++;
  }
  // True last resort — should never reach here
  return `W-${dateKey}${String(seq).padStart(2, '0')}`;
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
function buildPdfFilename(quoteData, quoteNumber, type, dealName) {
  const c = quoteData?.customer || {};
  const company = (c.company || '').trim();
  // Prefer explicit dealName arg, then customer company, then snapshot dealName
  // Strip date suffix from deal names (e.g. "Acme Corp - Apr 2026" → "Acme Corp")
  const stripDateSuffix = s => (s||'').replace(/\s*[·—\-–]\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s*$/i, '').trim();
  const resolvedName = company
    || stripDateSuffix(dealName || quoteData?.dealName || '')
    || [c.firstName, c.lastName].filter(Boolean).join(' ');
  const label = (quoteData?.quoteLabel || '').trim();
  const parts = [resolvedName, label, quoteNumber].filter(Boolean);
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

      const CLOSED_STAGES = new Set(['closedwon', '845719', 'closedlost']);

      const deals = (batchRes.body?.results || [])
        .filter(d => !CLOSED_STAGES.has(d.properties.dealstage))
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

      // ── DB search for quote numbers / contact names / company names ──
      // Run in parallel with HubSpot search when q is provided
      let dbMatchDealIds = new Set();
      if (q && db) {
        try {
          const dbSearch = await db.query(
            `SELECT DISTINCT deal_id FROM quotes
             WHERE deal_id IS NOT NULL AND (
               lower(quote_number)   LIKE $1 OR
               lower(customer_name)  LIKE $1 OR
               lower(company)        LIKE $1 OR
               lower(deal_name)      LIKE $1
             )
             LIMIT 50`,
            [`%${q.toLowerCase()}%`]
          );
          dbSearch.rows.forEach(r => { if (r.deal_id) dbMatchDealIds.add(String(r.deal_id)); });
        } catch(e) { console.warn('[deals list] DB search error:', e.message); }
      }

      const filters = [];
      if (stage) filters.push({ propertyName: 'dealstage', operator: 'EQ', value: stage });
      if (rep)   filters.push({ propertyName: 'hubspot_owner_id', operator: 'EQ', value: rep });

      // If DB matched deal IDs and no HubSpot text query needed, fetch by ID
      let hsDeals = [];
      if (q && dbMatchDealIds.size > 0) {
        // Fetch matched deals by ID from HubSpot (up to 50)
        const idFilters = [{ propertyName: 'hs_object_id', operator: 'IN', values: [...dbMatchDealIds] }];
        if (rep) idFilters.push({ propertyName: 'hubspot_owner_id', operator: 'EQ', value: rep });
        const idRes = await httpsRequest({
          hostname: 'api.hubapi.com',
          path: '/crm/v3/objects/deals/search',
          method: 'POST',
          headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
        }, {
          filterGroups: [{ filters: idFilters }],
          properties: ['dealname','dealstage','amount','hubspot_owner_id','hs_lastmodifieddate',
                       'closedate','payment_status','tracking_number','carrier__c'],
          limit: 50,
        });
        hsDeals = idRes.body?.results || [];

        // Also run HubSpot name search and merge (deduped)
        const nameRes = await httpsRequest({
          hostname: 'api.hubapi.com',
          path: '/crm/v3/objects/deals/search',
          method: 'POST',
          headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
        }, {
          filterGroups: filters.length ? [{ filters }] : [],
          properties: ['dealname','dealstage','amount','hubspot_owner_id','hs_lastmodifieddate',
                       'closedate','payment_status','tracking_number','carrier__c'],
          sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
          query: q,
          limit: 50,
        });
        const nameDeals = nameRes.body?.results || [];
        const seen = new Set(hsDeals.map(d => d.id));
        nameDeals.forEach(d => { if (!seen.has(d.id)) { seen.add(d.id); hsDeals.push(d); } });
      } else {
        // Normal load — no search query
        const searchBody = {
          filterGroups: filters.length ? [{ filters }] : [],
          properties: ['dealname','dealstage','amount','hubspot_owner_id','hs_lastmodifieddate',
                       'closedate','payment_status','tracking_number','carrier__c'],
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
        hsDeals = res2.body?.results || [];
      }

      const deals = hsDeals.map(d => ({
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
          `SELECT
             q.deal_id,
             q.quote_number,
             q.total,
             q.created_at,
             (q.json_snapshot->>'accepted')::text        as accepted,
             (q.json_snapshot->>'acceptedAt')::text      as accepted_at,
             q.json_snapshot->'lineItems'                as line_items,
             o.created_at                               as order_at
           FROM quotes q
           LEFT JOIN orders o ON o.quote_number = q.quote_number
           WHERE q.deal_id = ANY($1)
           ORDER BY q.created_at DESC`,
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
              lastQuoteAt: r.created_at || null,
              lastActivityAt: r.created_at || null,
            };
          } else {
            // Keep updating lastActivityAt with the most recent event across all quotes for this deal
            const existing = byDeal[r.deal_id];
            const ts = r.created_at ? new Date(r.created_at).getTime() : 0;
            const currentBest = existing.lastActivityAt ? new Date(existing.lastActivityAt).getTime() : 0;
            if (ts > currentBest) existing.lastActivityAt = r.created_at;
          }
          // Track order timestamp and acceptedAt as activity signals regardless of which quote
          const dealEntry = byDeal[r.deal_id];
          if (r.order_at) {
            const orderTs = new Date(r.order_at).getTime();
            const cur = dealEntry.lastActivityAt ? new Date(dealEntry.lastActivityAt).getTime() : 0;
            if (orderTs > cur) dealEntry.lastActivityAt = r.order_at;
          }
          if (r.accepted_at) {
            try {
              const acceptTs = new Date(r.accepted_at).getTime();
              const cur = dealEntry.lastActivityAt ? new Date(dealEntry.lastActivityAt).getTime() : 0;
              if (acceptTs > cur) dealEntry.lastActivityAt = r.accepted_at;
            } catch(e) {}
          }
          if (r.accepted === 'true') {
            // Any quote for this deal being accepted marks the deal as accepted
            byDeal[r.deal_id].accepted = true;
          }
        });
        deals.forEach(d => {
          if (byDeal[d.id]) Object.assign(d, byDeal[d.id]);
        });
      }

      // Sort by most meaningful activity: DB-tracked events (quote push, order, accept)
      // Deals with no DB activity sort by HubSpot modified date at the bottom
      deals.sort((a, b) => {
        const aTime = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0;
        const bTime = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0;
        // Both have DB activity — sort by that
        if (aTime && bTime) return bTime - aTime;
        // Only one has DB activity — it goes first
        if (aTime && !bTime) return -1;
        if (!aTime && bTime) return 1;
        // Neither has DB activity — fall back to HubSpot modified date
        return new Date(b.modified || 0).getTime() - new Date(a.modified || 0).getTime();
      });

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

      json({ deals, total: deals.length });
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
      const { customer, lineItems, freight, tax, discount, total, ownerId, dealName, existingDealId, existingContactId, billing, isRevision, linkedDealId: bodyLinkedDealId, confirmContactOverride, quoteLabel, bindFolderId, notes, repFoamColor, repHingePreference, repApColor } = body;
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
            // Filter credits (negative price) from both sides for consistent comparison
            const storedItems = (stored.json_snapshot?.lineItems || []).filter(i => parseFloat(i.price) >= 0).length;
            const newTotal    = parseFloat(total) || 0;
            const newItems    = (lineItems || []).filter(i => parseFloat(i.price) >= 0).length;
            const totalMatch  = Math.abs(storedTotal - newTotal) < 0.01;
            const countMatch  = storedItems === newItems;
            console.log(`[save] in-place check: deal=${existingDealId} storedTotal=${storedTotal} newTotal=${newTotal} storedItems=${storedItems} newItems=${newItems} totalMatch=${totalMatch} countMatch=${countMatch}`);
            if (totalMatch && countMatch) {
              _inPlaceUpdate = true;
              _existingQuoteNumber = stored.quote_number;
              console.log(`[save] in-place update detected — keeping quote number ${_existingQuoteNumber}`);
            } else {
              console.log(`[save] new quote required — ${!totalMatch ? `total changed ($${storedTotal} → $${newTotal})` : `item count changed (${storedItems} → ${newItems})`}`);
            }
          } else {
            console.log(`[save] no stored snapshot for deal ${existingDealId} — treating as new quote`);
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
          shipping_address:      customer.address    || '',
          shipping_city:         customer.city       || '',
          shipping_zipcode:      customer.zip        || '',
          shipping_first_name:   customer.firstName  || '',
          shipping_last_name:    customer.lastName   || '',
          shipping_phone_number: customer.phone      || '',
          billing_address:       billing ? billing.address || '' : customer.address || '',
          billing_city:          billing ? billing.city    || '' : customer.city    || '',
          billing_zipcode:       billing ? billing.zip     || '' : customer.zip     || '',
          billing_first_name:    billing ? (billing.firstName || customer.firstName || '') : (customer.firstName || ''),
          billing_last_name:     billing ? (billing.lastName  || customer.lastName  || '') : (customer.lastName  || ''),
          billing_phone_number:  billing ? (billing.phone     || customer.phone     || '') : (customer.phone     || ''),
          dealname: dealName || undefined,
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
          shipping_zipcode: customer.zip || '',
          shipping_first_name: customer.firstName || '',
          shipping_last_name: customer.lastName || '',
          shipping_phone_number: customer.phone || '',
          billing_address: billing ? billing.address || '' : customer.address || '',
          billing_city: billing ? billing.city || '' : customer.city || '',
          billing_state: billing ? (toStateFull(billing.state) || billing.state || '') : (toStateFull(customer.state) || customer.state || ''),
          billing_zipcode: billing ? billing.zip || '' : customer.zip || '',
          billing_first_name:    billing ? (billing.firstName || customer.firstName || '') : (customer.firstName || ''),
          billing_last_name:     billing ? (billing.lastName  || customer.lastName  || '') : (customer.lastName  || ''),
          billing_phone_number:  billing ? (billing.phone     || customer.phone     || '') : (customer.phone     || ''),
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
          notes: notes || '',
          repFoamColor:       repFoamColor       || '',
          repHingePreference: repHingePreference || '',
          repApColor:         repApColor         || '',
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
      ${c.phone?`<div class="info-item"><label>Phone</label><span>${c.phone}</span></div>`:''}
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

  

  ${(() => {
    const foam  = q.acceptedFoam  || q.repFoamColor       || '';
    const hinge = q.acceptedHinge || q.repHingePreference || '';
    const ap    = q.acceptedApColor || q.repApColor        || '';
    if (!foam && !hinge && !ap) return '';
    return `<div class="card" style="border-left:3px solid #22c55e;background:#f0fdf4">
    <div class="card-label" style="color:#166534">Order Specs</div>
    <div class="info-grid">
      ${foam  ? `<div class="info-item"><label>Foam Color</label><span style="color:#166534">${foam}</span></div>`  : ''}
      ${hinge ? `<div class="info-item"><label>Door Hinge</label><span style="color:#166534">${hinge}</span></div>` : ''}
      ${ap    ? `<div class="info-item"><label>Acoustic Package Color</label><span style="color:#166534">${ap}</span></div>`     : ''}
    </div>
  </div>`;
  })()}

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
      console.log(`[quote-page] ${quoteId} customer.phone="${q.customer?.phone||'MISSING'}" keys=${Object.keys(q.customer||{}).join(',')}`);
      const fmt = n => '$' + parseFloat(n||0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,',');
      const hasApOnQuote = (q.lineItems||[]).some(i => i.name && /^AP\s/i.test(i.name));
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
      ${c.phone?`<div class="info-item"><label>Phone</label><span>${c.phone}</span></div>`:''}
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

  

  ${(() => {
    const foam  = q.acceptedFoam  || q.repFoamColor       || '';
    const hinge = q.acceptedHinge || q.repHingePreference || '';
    const ap    = q.acceptedApColor || q.repApColor        || '';
    if (!foam && !hinge && !ap) return '';
    return `<div class="card" style="border-left:3px solid #22c55e;background:#f0fdf4">
    <div class="card-label" style="color:#166534">Order Specs</div>
    <div class="info-grid">
      ${foam  ? `<div class="info-item"><label>Foam Color</label><span style="color:#166534">${foam}</span></div>`  : ''}
      ${hinge ? `<div class="info-item"><label>Door Hinge</label><span style="color:#166534">${hinge}</span></div>` : ''}
      ${ap    ? `<div class="info-item"><label>Acoustic Package Color</label><span style="color:#166534">${ap}</span></div>`     : ''}
    </div>
  </div>`;
  })()}

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
<div id="accept-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:200;align-items:center;justify-content:center;padding:16px;overflow-y:auto">
  <div style="background:white;border-radius:14px;padding:32px;max-width:440px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.3);max-height:90vh;overflow-y:auto;margin:auto">
    <h2 style="font-size:18px;font-weight:800;color:#1a1a1a;margin-bottom:6px">One last step!</h2>
    <p style="font-size:13px;color:#888;margin-bottom:24px">Please answer the following before accepting your quote. These are required before your order ships — you can choose <em>Undecided</em> if you need more time.</p>

    <div style="margin-bottom:20px">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#555;margin-bottom:10px">Foam Color</div>
      <img src="data:image/webp;base64,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" alt="Foam color options" style="width:100%;border-radius:8px;margin-bottom:12px;display:block">
      <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center" id="foam-grid">
        <label onclick="selectFoamSwatch(this,'Gray')" style="display:flex;flex-direction:column;align-items:center;gap:5px;padding:8px 6px;border:2px solid #eee;border-radius:10px;cursor:pointer;transition:all .15s;flex:1;min-width:70px" title="Gray">
          <input type="radio" name="foam" value="Gray" style="display:none">
          <div style="width:40px;height:40px;border-radius:50%;background:#4a4a4a;border:2px solid rgba(0,0,0,.15);flex-shrink:0"></div>
          <span style="font-size:11px;font-weight:600;color:#555;text-align:center;line-height:1.2">Gray</span>
        </label>
        <label onclick="selectFoamSwatch(this,'Orange')" style="display:flex;flex-direction:column;align-items:center;gap:5px;padding:8px 6px;border:2px solid #eee;border-radius:10px;cursor:pointer;transition:all .15s;flex:1;min-width:70px" title="Orange">
          <input type="radio" name="foam" value="Orange" style="display:none">
          <div style="width:40px;height:40px;border-radius:50%;background:#d4611a;border:2px solid rgba(0,0,0,.15);flex-shrink:0"></div>
          <span style="font-size:11px;font-weight:600;color:#555;text-align:center;line-height:1.2">Orange</span>
        </label>
        <label onclick="selectFoamSwatch(this,'Blue')" style="display:flex;flex-direction:column;align-items:center;gap:5px;padding:8px 6px;border:2px solid #eee;border-radius:10px;cursor:pointer;transition:all .15s;flex:1;min-width:70px" title="Blue">
          <input type="radio" name="foam" value="Blue" style="display:none">
          <div style="width:40px;height:40px;border-radius:50%;background:#1a5fa8;border:2px solid rgba(0,0,0,.15);flex-shrink:0"></div>
          <span style="font-size:11px;font-weight:600;color:#555;text-align:center;line-height:1.2">Blue</span>
        </label>
        <label onclick="selectFoamSwatch(this,'Purple')" style="display:flex;flex-direction:column;align-items:center;gap:5px;padding:8px 6px;border:2px solid #eee;border-radius:10px;cursor:pointer;transition:all .15s;flex:1;min-width:70px" title="Purple">
          <input type="radio" name="foam" value="Purple" style="display:none">
          <div style="width:40px;height:40px;border-radius:50%;background:#5c2a82;border:2px solid rgba(0,0,0,.15);flex-shrink:0"></div>
          <span style="font-size:11px;font-weight:600;color:#555;text-align:center;line-height:1.2">Purple</span>
        </label>
        <label onclick="selectFoamSwatch(this,'Burgundy')" style="display:flex;flex-direction:column;align-items:center;gap:5px;padding:8px 6px;border:2px solid #eee;border-radius:10px;cursor:pointer;transition:all .15s;flex:1;min-width:70px" title="Burgundy">
          <input type="radio" name="foam" value="Burgundy" style="display:none">
          <div style="width:40px;height:40px;border-radius:50%;background:#6e1a2a;border:2px solid rgba(0,0,0,.15);flex-shrink:0"></div>
          <span style="font-size:11px;font-weight:600;color:#555;text-align:center;line-height:1.2">Burgundy</span>
        </label>
        <label onclick="selectFoamSwatch(this,'Undecided')" style="display:flex;flex-direction:column;align-items:center;gap:5px;padding:8px 6px;border:2px solid #eee;border-radius:10px;cursor:pointer;transition:all .15s;flex:1;min-width:70px" title="Undecided">
          <input type="radio" name="foam" value="Undecided" style="display:none">
          <div style="width:40px;height:40px;border-radius:50%;background:#e0e0e0;border:2px solid #ccc;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:18px">?</div>
          <span style="font-size:11px;font-weight:600;color:#555;text-align:center;line-height:1.2">Undecided</span>
        </label>
      </div>
    </div>

    <div style="margin-bottom:28px">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#555;margin-bottom:10px">Door Hinge</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px" id="hinge-grid">
        <label onclick="selectHinge(this,'Left Hand')" style="display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 8px;border:2px solid #eee;border-radius:10px;cursor:pointer;transition:all .15s;text-align:center">
          <input type="radio" name="hinge" value="Left Hand" style="display:none">
          <img src="data:image/png;base64,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" alt="Left Hinge" style="width:120px;height:120px;object-fit:contain;border-radius:6px">
          <span style="font-size:13px;font-weight:700;color:#333">Left Hand</span>
          <span style="font-size:11px;color:#888;line-height:1.3">Hinges on left,<br>opens right</span>
        </label>
        <label onclick="selectHinge(this,'Right Hand')" style="display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 8px;border:2px solid #eee;border-radius:10px;cursor:pointer;transition:all .15s;text-align:center">
          <input type="radio" name="hinge" value="Right Hand" style="display:none">
          <img src="data:image/png;base64,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" alt="Right Hinge" style="width:120px;height:120px;object-fit:contain;border-radius:6px">
          <span style="font-size:13px;font-weight:700;color:#333">Right Hand</span>
          <span style="font-size:11px;color:#888;line-height:1.3">Hinges on right,<br>opens left</span>
        </label>
      </div>
      <label onclick="selectHinge(this,'Undecided')" style="display:flex;align-items:center;gap:8px;padding:10px 12px;border:2px solid #eee;border-radius:8px;cursor:pointer;font-size:13px;font-weight:500;transition:all .15s">
        <input type="radio" name="hinge" value="Undecided" style="display:none">
        <span style="width:22px;height:22px;border-radius:50%;background:#e0e0e0;border:2px solid #ccc;display:inline-flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0">?</span>
        Undecided — WhisperRoom will follow up
      </label>
    </div>

    <div style="margin-bottom:20px">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#555;margin-bottom:8px">Message to WhisperRoom <span style="font-weight:400;text-transform:none;letter-spacing:0;color:#bbb">(optional)</span></div>
      <textarea id="customer-note" rows="3" placeholder="Any questions, special instructions, or delivery notes..." style="width:100%;padding:10px 12px;border:2px solid #eee;border-radius:8px;font-size:14px;font-family:inherit;resize:vertical;box-sizing:border-box"></textarea>
    </div>

    ${hasApOnQuote ? `<div style="margin-bottom:20px">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#555;margin-bottom:10px">Acoustic Package Color <span style="font-weight:400;text-transform:none;letter-spacing:0;color:#bbb">(optional)</span></div>
      <img src="data:image/jpeg;base64,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" alt="AP color options" style="width:100%;border-radius:8px;margin-bottom:12px;display:block">
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:8px" id="ap-swatch-grid">
        ${[['White','#f0eeea'],['Asteroid','#7a8a95'],['Graphite','#3a3d40'],['Onyx','#1a1a1a'],['Coffee Bean','#3d2010'],['Vanilla','#c8b97a'],['Birch','#c4a882'],['Fern','#3d5a2a'],['Green Apple','#8a9a3a'],['Waterfall','#2e8fa0'],['Quarry Blue','#5a6e78'],['Lapis','#1e3a6e'],['Lemon','#f5c518'],['Pumpkin','#c45c22'],['Geranium','#c0282a'],['Orchid','#7a1a3a']].map(([name,hex]) =>
          '<label onclick="selectApSwatch(this,\'' + name + '\')" style="display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px 4px;border:2px solid transparent;border-radius:8px;cursor:pointer;transition:all .15s" title="' + name + '">' +
          '<input type="radio" name="ap_color" value="' + name + '" style="display:none">' +
          '<div style="width:34px;height:34px;border-radius:50%;background:' + hex + ';border:1px solid rgba(0,0,0,.15);flex-shrink:0"></div>' +
          '<span style="font-size:8px;font-weight:600;text-align:center;color:#777;line-height:1.2">' + name + '</span>' +
          '</label>'
        ).join('')}
      </div>
      <label style="display:flex;align-items:center;gap:8px;padding:8px 12px;border:2px solid #eee;border-radius:8px;cursor:pointer;font-size:13px;font-weight:500" id="ap-undecided-label">
        <input type="radio" name="ap_color" value="Undecided" style="accent-color:#ee6216" onchange="clearApSwatches()"> Undecided — WhisperRoom will follow up
      </label>
    </div>` : ''}

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

${q.accepted ? `
<div style="position:fixed;bottom:0;left:0;right:0;background:#1a7a4a;color:white;padding:20px 28px;z-index:100;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:20px;flex-wrap:wrap">
  <span style="font-size:15px;font-weight:700">&#x2713;&nbsp;&nbsp;Quote Accepted</span>
  <span style="font-size:13px;opacity:.8">A WhisperRoom representative will be in touch shortly.</span>
  <button onclick="window.print()" style="padding:8px 16px;background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.4);border-radius:6px;color:white;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit">&#x2B07; Download PDF</button>
</div>
` : `
<div class="action-bar" id="action-bar">
  <button class="btn btn-accept" id="accept-btn" onclick="acceptQuote()">&#x2713;&nbsp;&nbsp;Accept This Quote</button>
  <button class="btn btn-primary" onclick="window.print()">&#x2B07;&nbsp;&nbsp;Download PDF</button>
  <button class="btn btn-secondary" id="share-btn" onclick="(function(b){if(navigator.clipboard){navigator.clipboard.writeText(window.location.href).then(function(){b.textContent='\u2713 Copied!';setTimeout(function(){b.textContent='Share Link'},2000)}).catch(function(){prompt('Copy link:',window.location.href)})}else{prompt('Copy link:',window.location.href)}})(this)">Share Link</button>
</div>

<div id="accepted-bar" style="display:none;position:fixed;bottom:0;left:0;right:0;background:#1a7a4a;color:white;text-align:center;padding:20px;font-size:15px;font-weight:700;z-index:100;font-family:inherit">
  &#x2713;&nbsp;&nbsp;Quote Accepted &mdash; A WhisperRoom representative will be in touch shortly.
</div>
`}

<script>
  document.title = 'Quote ${q.quoteNumber||''}${q.dealName ? ' - ' + q.dealName.replace(/[<>]/g,'') : ''}';

  function selectFoamSwatch(label, value) {
    const radio = label.querySelector('input[type="radio"]');
    if (radio) radio.checked = true;
    document.querySelectorAll('#foam-grid label').forEach(l => {
      l.style.borderColor = '#eee';
      l.style.background = '';
    });
    label.style.borderColor = '#ee6216';
    label.style.background = '#fff8f0';
  }

  function selectHinge(label, value) {
    const radio = label.querySelector('input[type="radio"]');
    if (radio) radio.checked = true;
    document.querySelectorAll('#hinge-grid label, #hinge-undecided').forEach(l => {
      l.style.borderColor = '#eee';
      l.style.background = '';
    });
    label.style.borderColor = '#ee6216';
    label.style.background = '#fff8f0';
  }

  function updateLabels() {
    // Legacy — handled by selectFoamSwatch/selectHinge now
  }

  async function acceptQuote() {
    const btn = document.getElementById('accept-btn');
    if (!btn) return;

    // Show foam/hinge selection modal first
    const modal = document.getElementById('accept-modal');
    if (modal) { modal.style.display = 'flex'; return; }
  }

  function selectApSwatch(label, name) {
    // Check the hidden radio
    const radio = label.querySelector('input[type="radio"]');
    if (radio) radio.checked = true;
    // Clear undecided
    const ud = document.getElementById('ap-undecided-label');
    if (ud) { ud.style.borderColor = '#eee'; ud.style.background = 'white'; }
    // Highlight selected swatch, clear others
    document.querySelectorAll('#ap-swatch-grid label').forEach(l => {
      l.style.borderColor = 'transparent';
      l.style.background = '';
    });
    label.style.borderColor = '#ee6216';
    label.style.background = '#fff8f0';
  }

  function clearApSwatches() {
    document.querySelectorAll('#ap-swatch-grid label').forEach(l => {
      l.style.borderColor = 'transparent';
      l.style.background = '';
    });
    const ud = document.getElementById('ap-undecided-label');
    if (ud) { ud.style.borderColor = '#ee6216'; ud.style.background = '#fff8f0'; }
  }

  async function submitAcceptance() {
    const foam  = document.querySelector('input[name="foam"]:checked')?.value  || '';
    const hinge = document.querySelector('input[name="hinge"]:checked')?.value || '';
    const apColor = document.querySelector('input[name="ap_color"]:checked')?.value || '';
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
          apColor: apColor,
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
                    jsonb_set(
                      jsonb_set(COALESCE(json_snapshot, '{}'), '{accepted}', 'true'),
                      '{acceptedAt}', $2
                    ),
                    '{acceptedFoam}', $3
                  ),
                  '{acceptedHinge}', $4
                ),
                '{acceptedApColor}', $6
              ),
              '{acceptedNote}', $5
            ) WHERE quote_number = $1`,
            [
              quoteNumber,
              JSON.stringify(acceptedAt),
              JSON.stringify(body.foamColor || ''),
              JSON.stringify(body.hingePreference || ''),
              JSON.stringify(body.customerNote || ''),
              JSON.stringify(body.apColor || ''),
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
              hs_task_body: `Customer accepted quote #${quoteNumber} for ${dealName}. Ready to create invoice.\n\nFoam Color: ${body.foamColor || 'Not selected'}\nHinge: ${body.hingePreference || 'Not selected'}${body.apColor ? '\nAP Color: ' + body.apColor : ''}${body.customerNote ? '\n\nCustomer Note: "' + body.customerNote + '"' : ''}`,
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
            body.apColor ? `AP: ${body.apColor}` : null,
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
            hs_note_body: `✓ Quote #${quoteNumber} accepted by customer on ${new Date().toLocaleDateString('en-US', {month:'long',day:'numeric',year:'numeric'})}.\n\nFoam Color: ${body.foamColor || 'Not selected'}\nHinge Preference: ${body.hingePreference || 'Not selected'}${body.apColor ? '\nAP Color: ' + body.apColor : ''}${body.customerNote ? '\n\nCustomer Note: "' + body.customerNote + '"' : ''}`,
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
      const { quoteNumber, dealId, folderId } = JSON.parse(await readBody(req));
      if (!folderId) { json({ error: 'Missing folderId' }, 400); return; }
      if (!db) { json({ error: 'No database' }, 500); return; }
      let updated = 0;
      // Update all quotes for this deal if dealId provided
      if (dealId) {
        const r = await db.query(
          'UPDATE quotes SET gdrive_folder_id = $1 WHERE deal_id = $2',
          [folderId, String(dealId)]
        );
        updated = r.rowCount || 0;
        console.log(`[drive] bound folder ${folderId} to all quotes for deal ${dealId} (${updated} rows)`);
      }
      // Also update by quoteNumber as fallback
      if (quoteNumber) {
        await db.query(
          'UPDATE quotes SET gdrive_folder_id = $1 WHERE quote_number = $2',
          [folderId, quoteNumber]
        );
        console.log(`[drive] bound folder ${folderId} to quote ${quoteNumber}`);
      }
      json({ success: true, updated });
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

      // Build a list of needles to try — full name plus each comma-separated segment
      // e.g. "University of Utah, Dept of Linguistics" → also try "UNIVERSITY OF UTAH"
      const needles = [needle];
      if (company.includes(',')) {
        company.split(',').forEach(seg => {
          const n = normalize(seg.trim());
          if (n.length >= 4 && !needles.includes(n)) needles.push(n);
        });
      }
      // Also try first two words as a fallback for very long names
      const firstTwo = needle.split(' ').slice(0, 3).join(' ');
      if (firstTwo.length >= 4 && !needles.includes(firstTwo)) needles.push(firstTwo);

      // Get dest folder ID from DB — try quote first, then fall back to any quote for the same deal
      let destFolderId = null, destFolderName = null, destDealId = null;
      if (db && quoteNumber) {
        const row = await db.query('SELECT gdrive_folder_id, deal_id, company, deal_name FROM quotes WHERE quote_number = $1 LIMIT 1', [quoteNumber]);
        destFolderId   = row.rows[0]?.gdrive_folder_id || null;
        // Use deal_name (reflects renames) over company (stale snapshot) for display
        destFolderName = row.rows[0]?.deal_name || row.rows[0]?.company || company;
        destDealId     = row.rows[0]?.deal_id || null;
        // If no folder on this quote, check other quotes for the same deal
        if (!destFolderId && destDealId) {
          const fallback = await db.query(
            'SELECT gdrive_folder_id, deal_name, company FROM quotes WHERE deal_id = $1 AND gdrive_folder_id IS NOT NULL ORDER BY created_at DESC LIMIT 1',
            [destDealId]
          );
          if (fallback.rows[0]?.gdrive_folder_id) {
            destFolderId   = fallback.rows[0].gdrive_folder_id;
            destFolderName = fallback.rows[0].deal_name || fallback.rows[0].company || destFolderName;
            console.log(`[scan-orders] used fallback folder from deal ${destDealId}: ${destFolderId}`);
          }
        }
        // If still no folder, try any quote with this deal_id regardless of current quote
        if (!destFolderId && destDealId) {
          const anyQ = await db.query(
            'SELECT gdrive_folder_id, deal_name FROM quotes WHERE deal_id = $1 AND gdrive_folder_id IS NOT NULL LIMIT 1',
            [String(destDealId)]
          );
          if (anyQ.rows[0]?.gdrive_folder_id) {
            destFolderId   = anyQ.rows[0].gdrive_folder_id;
            destFolderName = anyQ.rows[0].deal_name || destFolderName;
          }
        }
      }
      // Fetch actual Drive folder name to show accurate destination
      if (destFolderId) {
        try {
          const token = await getGDriveToken();
          if (token) {
            const folderMeta = await httpsRequest({
              hostname: 'www.googleapis.com',
              path: `/drive/v3/files/${destFolderId}?fields=name&supportsAllDrives=true`,
              method: 'GET',
              headers: { 'Authorization': `Bearer ${token}` }
            });
            if (folderMeta.body?.name) destFolderName = folderMeta.body.name;
          }
        } catch(e) { /* non-fatal — display name only */ }
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

      // Match files whose name contains ANY of the needles (deduped)
      const matches = allFiles.filter(f => {
        const fn = normalize(f.name);
        return needles.some(n => fn.includes(n));
      });
      // Dedupe by id in case multiple needles match the same file
      const seen = new Set();
      const uniqueMatches = matches.filter(f => seen.has(f.id) ? false : (seen.add(f.id), true));

      if (allFiles.length > 0 && uniqueMatches.length === 0) {
        console.warn(`[scan-orders] No match for needles [${needles.join(', ')}] among ${allFiles.length} files. Sample names:`, allFiles.slice(0,3).map(f => f.name));
      }
      console.log(`[scan-orders] quote=${quoteNumber} needles=[${needles.join('|')}] — ${allFiles.length} total files, ${uniqueMatches.length} matches, destFolder=${destFolderId||'none'}`);

      json({ files: uniqueMatches, destFolderId, destFolderName });
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
          // Step 1: Copy to contact folder (only needs read access on source)
          const copyRes = await httpsRequest({
            hostname: 'www.googleapis.com',
            path: `/drive/v3/files/${fileId}/copy?supportsAllDrives=true&fields=id,name`,
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
          }, { parents: [destFolderId] });

          if (copyRes.body?.error) {
            console.warn(`[move-order-files] Copy failed for ${fileId}:`, JSON.stringify(copyRes.body.error));
            results.push({ id: fileId, success: false, error: copyRes.body.error.message });
            continue;
          }

          const movedName = copyRes.body?.name || fileId;

          // Step 2: Trash the original (trash requires less permission than delete)
          try {
            await httpsRequest({
              hostname: 'www.googleapis.com',
              path: `/drive/v3/files/${fileId}?supportsAllDrives=true`,
              method: 'PATCH',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
            }, { trashed: true });
            console.log(`[move-order-files] Moved "${movedName}" → contact folder (original trashed)`);
          } catch(trashErr) {
            // Non-fatal — file copied successfully, original stays in Orders folder
            console.warn(`[move-order-files] Copied but could not trash "${movedName}": ${trashErr.message}`);
          }

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
      // Also fetch DB row for share_token and deal_id
      const row = db ? (await db.query(
        'SELECT deal_id, deal_name, share_token, json_snapshot FROM quotes WHERE quote_number = $1',
        [qNum]
      ))?.rows[0] : null;
      json({
        lineItems:       snap.lineItems    || [],
        freight:         snap.freight      || null,
        tax:             snap.tax          || null,
        discount:        snap.discount     || { type:'pct', value:0 },
        customer:        snap.customer     || {},
        billing:         snap.billing      || null,
        ownerId:         snap.ownerId      || null,
        dealId:          snap.dealId       || row?.deal_id || null,
        dealName:        snap.dealName     || row?.deal_name || '',
        notes:           snap.notes        || '',
        quoteLabel:      snap.quoteLabel   || '',
        shareToken:      row?.share_token  || snap._shareToken || null,
        accepted:        snap.accepted     || false,
        acceptedFoam:    snap.acceptedFoam    || '',
        acceptedHinge:   snap.acceptedHinge   || '',
        acceptedApColor: snap.acceptedApColor || '',
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
      const { dealId, quoteNumber, lineItems, freight, tax, discount, ownerId, contactId, customer, allowCC, allowACH } = body;

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

      // Build allowed payment methods — semicolon-separated enum values
      const paymentMethods = [];
      if (allowCC !== false)  paymentMethods.push('credit_or_debit_card');
      if (allowACH !== false) paymentMethods.push('ach');
      // Default to both if nothing passed
      const allowedPayments = paymentMethods.length > 0
        ? paymentMethods.join(';')
        : 'credit_or_debit_card;ach';

      const invoiceProps = {
        hs_invoice_status: 'draft',
        hs_currency:       'USD',
        hs_title:          quoteNumber ? `Invoice — ${quoteNumber}` : 'Invoice',
        hs_invoice_date:   today,
        hs_due_date:       today,
        hs_allowed_payment_methods: allowedPayments,
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
          q.company as q_company,
          q.rep_id
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
      const { customer, foamColor, hingePreference, apColor, productionNotes, deliveryNotes, shipped, changes, repName, freightCost, shipEmailTo, shipEmailCc, markShipped, serialNumber, shipmentFields } = body;

      if (!db) { json({ error: 'No database' }, 500); return; }

      // ── HubSpot-only orders (HS-{dealId}) — patch directly to HubSpot, no DB ──
      if (quoteNumber.startsWith('HS-')) {
        const hsDealId = quoteNumber.replace('HS-', '');
        try {
          const hsProps = {};
          if (serialNumber    !== undefined) hsProps.description      = String(serialNumber || '');
          if (apColor !== undefined && apColor !== null) hsProps.ap_color = String(apColor || '');
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
        apColor:          apColor          !== undefined ? apColor          : currentOrderData.apColor,
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
          if (apColor !== undefined && apColor !== null) hsProps.ap_color = String(apColor || '');
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
          const cRow = await db.query(
            `SELECT q.company, q.customer_name, q.json_snapshot
             FROM quotes q WHERE q.quote_number = $1 LIMIT 1`,
            [quoteNumber]
          );
          if (cRow.rows[0]) {
            orderCompany = cRow.rows[0].company ||
              cRow.rows[0].json_snapshot?.customer?.company ||
              cRow.rows[0].customer_name || '';
          }
          // If still empty, try looking up via deal_id
          if (!orderCompany && dealId) {
            const dRow = await db.query(
              `SELECT company, customer_name, json_snapshot FROM quotes WHERE deal_id = $1 AND company IS NOT NULL AND company != '' ORDER BY created_at DESC LIMIT 1`,
              [String(dealId)]
            );
            orderCompany = dRow.rows[0]?.company ||
              dRow.rows[0]?.json_snapshot?.customer?.company ||
              dRow.rows[0]?.customer_name || '';
          }
        } catch(e) { console.warn('[ship] company lookup failed:', e.message); }
      }
      console.log(`[ship] company for file scan: "${orderCompany}" (quoteNumber=${quoteNumber})`);
      json({ success: true, shipped: isNowShipped, quoteNumber, company: orderCompany });

      // ── Accounting task when Jeromy ships ────────────────────────
      // Fire when: Ship It is clicked AND shipper is Jeromy (38732186)
      if (isNowShipped && !wasShipped && dealId) {
        (async () => {
          try {
            const sf2        = updatedOrderData.shipped || {};
            const foamC      = updatedOrderData.foamColor     || currentOrderData.foamColor     || '—';
            const apC        = updatedOrderData.apColor       || currentOrderData.apColor       || null;
            const serial     = updatedOrderData.serialNumber || currentOrderData.serialNumber || '—';
            const fc2        = updatedOrderData.freightCost   || currentOrderData.freightCost   || '—';
            const dealRow    = await db?.query('SELECT deal_name FROM quotes WHERE quote_number = $1 LIMIT 1', [quoteNumber]);
            const dealNameT  = dealRow?.rows[0]?.deal_name || quoteNumber;
            const fcDisplay  = fc2 !== '—' ? `$${parseFloat(fc2).toFixed(2)}` : '—';

            const taskBody = [
              `Deal: ${dealNameT}`,
              `Serial Number: ${serial}`,
              `Foam Color: ${foamC}`,
              apC ? `AP Color: ${apC}` : null,
              `Carrier: ${sf2.carrier || '—'}`,
              `PRO / Tracking: ${sf2.tracking || '—'}`,
              `Freight Cost: ${fcDisplay}`,
            ].filter(Boolean).join('\n');

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
            await gdriveSavePdfToDeal(quoteNumber, 'Final Order', buildPdfFilename(snapO, quoteNumber, 'Order', dnO), pdfBufO);
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
      ${c.phone?`<div class="info-item"><label>Phone</label><span>${c.phone}</span></div>`:''}
      ${(c.address||c.city||c.state||c.zip)?`<div class="info-item"><label>Delivery Address</label><span>${[c.address,c.city,(c.state&&c.zip?c.state+' '+c.zip:c.state||c.zip)].filter(Boolean).join(', ')}</span></div>`:''}
      ${q.billing && (q.billing.address || q.billing.email) ? `<div class="info-item" style="margin-top:10px;padding-top:10px;border-top:1px solid #f0f0f0"><label>Bill To</label><span>${[q.billing.email||'',q.billing.address||'',[q.billing.city,(q.billing.state&&q.billing.zip?q.billing.state+' '+q.billing.zip:q.billing.state||q.billing.zip)].filter(Boolean).join(', ')].filter(Boolean).join('<br>')}</span></div>` : ''}
    </div>
  </div>` : ''}

  <div class="card">
    <div class="card-label">Order Specifications</div>
    <div class="info-grid">
      <div class="info-item"><label>Foam Color</label><span>${o.foamColor||'Not specified'}</span></div>
      <div class="info-item"><label>Door Hinge</label><span>${o.hingePreference||'Not specified'}</span></div>
      ${o.apColor ? `<div class="info-item"><label>Acoustic Package Color</label><span style="display:inline-flex;align-items:center;gap:8px">${o.apColor}<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:${({Lemon:'#f5c518',Vanilla:'#c8b97a',Birch:'#c4a882',White:'#f0eeea','Green Apple':'#8a9a3a',Fern:'#3d5a2a',Waterfall:'#2e8fa0',Asteroid:'#7a8a95',Orchid:'#7a1a3a',Pumpkin:'#c45c22',Geranium:'#c0282a',Lapis:'#1e3a6e',Onyx:'#1a1a1a',Graphite:'#3a3d40','Coffee Bean':'#3d2010','Quarry Blue':'#5a6e78'}[o.apColor]||'#aaa')};border:1px solid rgba(0,0,0,.2)"></span></span></div>` : `<div class="info-item"><label>Acoustic Package Color</label><span style="color:#aaa">None</span></div>`}
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
              customer, foamColor, hingePreference, apColor, productionNotes,
              deliveryNotes, ownerId, dealName } = body;

      if (!dealId || !quoteNumber) { json({ error: 'Missing dealId or quoteNumber' }, 400); return; }

      // 1. Advance deal to Closed Won + set ap_color if present
      const closedWonProps = { dealstage: 'closedwon' };
      if (apColor) closedWonProps.ap_color = apColor;
      await httpsRequest({
        hostname: 'api.hubapi.com',
        path: `/crm/v3/objects/deals/${dealId}`,
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
      }, { properties: closedWonProps });

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
      const orderData = { foamColor, hingePreference, apColor, productionNotes, deliveryNotes, processedAt: new Date().toISOString() };

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
        c.phone   ? `Phone: ${c.phone}`     : null,
        c.address||c.city||c.state ? `Ship To: ${[c.address,c.city,(c.state&&c.zip?c.state+' '+c.zip:c.state||c.zip)].filter(Boolean).join(', ')}` : null,
        ``,
        `ORDER SPECIFICATIONS`,
        `Foam Color: ${foamColor||'Not specified'}`,
        apColor ? `AP Color: ${apColor}` : `AP Color: None`,
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

      // Create AP color task for Benton (non-blocking) if order has an AP item
      const hasApItem = (lineItems || []).some(i => i.name && /^AP\s/i.test(i.name));
      if (hasApItem) {
        (async () => {
          try {
            const apColorLabel = apColor || 'Unknown';
            const taskRes = await httpsRequest({
              hostname: 'api.hubapi.com',
              path: '/crm/v3/objects/tasks',
              method: 'POST',
              headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
            }, {
              properties: {
                hs_task_subject:  `🎨 AP Color Needed — ${dealName || quoteNumber}`,
                hs_task_body:     `Order ${quoteNumber} includes an Acoustic Package.\n\nAP Color: ${apColorLabel}\n\nSubmit order to Audimute once color is confirmed.\n\nOrder: ${orderUrl}\nHubSpot Deal: https://app.hubspot.com/contacts/5764220/deal/${dealId}`,
                hs_task_status:   'NOT_STARTED',
                hs_task_type:     'TODO',
                hs_task_priority: 'HIGH',
                hubspot_owner_id: '36303670', // Benton
                hs_timestamp:     new Date().toISOString(),
              },
              associations: [{ to: { id: String(dealId) }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 216 }] }]
            });
            console.log(`[process-order] AP task created: ${taskRes.body?.id}`);
          } catch(e) { console.warn('[process-order] AP task failed:', e.message); }
        })();
      }

      // Upload order PDF to shared orders folder (non-blocking)
      (async () => {
        try {
          const snapRowP = await db?.query('SELECT json_snapshot, deal_name FROM quotes WHERE quote_number = $1', [quoteNumber]);
          const snapP    = snapRowP?.rows[0]?.json_snapshot || {};
          const dealNameP = snapRowP?.rows[0]?.deal_name || dealName || '';
          const pdfBufO  = await generatePdfBuffer(orderUrl);
          const filename = buildPdfFilename(snapP, quoteNumber, 'Order', dealNameP);
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
