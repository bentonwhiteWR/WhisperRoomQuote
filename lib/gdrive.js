// Google Drive integration
// Extracted from quote-server.js — named exports, no behavior changes.
// Host must call `init({ httpsRequest, getDb, writelog })` before any gdrive function is invoked.

const crypto = require('crypto');
const https  = require('https');

let _httpsRequest;
let _getDb;      // function returning the db pool (or null)
let _writelog;

function init(deps) {
  _httpsRequest = deps.httpsRequest;
  _getDb        = deps.getDb;
  _writelog     = deps.writelog;
}

const GDRIVE_ROOT_FOLDER   = process.env.GDRIVE_ROOT_FOLDER || '';
const SHARED_ORDERS_FOLDER = '0AKEFNM5_Dl8jUk9PVA'; // WhisperRoom Orders folder

let _gdriveToken       = null;
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

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(creds.private_key).toString('base64url');
  const jwt = `${header}.${payload}.${sig}`;

  const tokenRes = await _httpsRequest({
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
  const res = await _httpsRequest({
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

  const res = await _httpsRequest({
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

async function gdriveCreateDealFolders(dealName, quoteNumber, companyName) {
  try {
    const folderName = getCompanyFolderName(dealName, companyName);
    const safeName = folderName.replace(/[/\:*?"<>|]/g, '-').trim();
    const dealFolder = await gdriveEnsureFolder(safeName, GDRIVE_ROOT_FOLDER);
    if (!dealFolder?.id) { console.warn('GDrive: failed to create deal folder'); return null; }

    // Save folder ID to DB
    const db = _getDb();
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
    const db = _getDb();
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
      _writelog('error', 'error.gdrive', `No folder ID for ${quoteNumber} — PDF not uploaded: ${filename}`, { quoteNum: quoteNumber });
      return;
    }

    console.log(`GDrive: uploading "${filename}" to folder ${dealFolderId}`);
    const result = await gdriveUploadFilePdf(filename, pdfBuffer, dealFolderId);
    if (result?.error) {
      console.warn(`GDrive upload error:`, JSON.stringify(result.error));
      _writelog('error', 'error.gdrive', `Drive upload failed for ${filename}: ${JSON.stringify(result.error)}`, { quoteNum: quoteNumber });
    } else {
      console.log(`GDrive: uploaded "${filename}" — id:`, result?.id);
    }
  } catch(e) {
    console.warn(`GDrive savePdf error:`, e.message);
    _writelog('error', 'error.gdrive', `Drive savePdf threw: ${e.message}`, { quoteNum: quoteNumber });
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
    const req = https.request({
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

module.exports = {
  init,
  GDRIVE_ROOT_FOLDER,
  SHARED_ORDERS_FOLDER,
  getGDriveToken,
  gdriveRequest,
  gdriveCreateFolder,
  gdriveFindFolder,
  gdriveEnsureFolder,
  gdriveRenameFolder,
  gdriveUploadFile,
  getCompanyFolderName,
  gdriveCreateDealFolders,
  gdriveSavePdfToDeal,
  gdriveUploadFilePdf,
};
