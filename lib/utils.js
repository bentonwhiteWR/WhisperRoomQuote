// Small pure helpers — no init() needed
const crypto = require('crypto');

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function parseCookies(req) {
  const list = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const parts = p.split('=');
    if (parts[0]) list[parts[0].trim()] = (parts[1] || '').trim();
  });
  return list;
}

function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
  });
}

function validateShareToken(quoteData, requestedToken) {
  if (!quoteData) return false;
  const storedToken = quoteData._shareToken || quoteData.shareToken;
  if (!storedToken) return true; // legacy quotes without token — allow during transition
  if (!requestedToken) return false;
  return storedToken === requestedToken;
}

// Build consistent PDF filename: "Company Label QuoteNumber (Type).pdf"
function buildPdfFilename(quoteData, quoteNumber, type, dealName) {
  const c = quoteData?.customer || {};
  const company = (c.company || '').trim();
  const stripDateSuffix = s => (s||'').replace(/\s*[·—\-–]\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s*$/i, '').trim();
  const resolvedName = company
    || stripDateSuffix(dealName || quoteData?.dealName || '')
    || [c.firstName, c.lastName].filter(Boolean).join(' ');
  const label = (quoteData?.quoteLabel || '').trim();
  const parts = [resolvedName, label, quoteNumber].filter(Boolean);
  const safe = parts.join(' ').replace(/[/\\:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
  return type ? `${safe} (${type}).pdf` : `${safe}.pdf`;
}

// Rate limiter for public routes — state kept inside the module
const rateLimitMap = new Map(); // ip → { count, resetAt }

function checkRateLimit(ip, max = 30, windowMs = 60000) {
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

// Purge expired rate-limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 300000);

module.exports = {
  generateToken,
  parseCookies,
  readBody,
  validateShareToken,
  buildPdfFilename,
  checkRateLimit,
};
