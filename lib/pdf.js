// PDF generation via Puppeteer
// Extracted from quote-server.js — named exports, no behavior changes.
// Host must call `init({ puppeteer })` before any pdf function is invoked.

let _puppeteer;

function init(deps) {
  _puppeteer = deps.puppeteer;
}

// Shared Chromium launch flags. Beyond the usual sandbox/gpu disables:
//   --disable-crash-reporter / --disable-breakpad → don't spawn the crashpad
//     handler, the subprocess that fails to fork ("chrome_crashpad_handler:
//     Resource temporarily unavailable") under memory/PID pressure on Railway,
//     and which can orphan/accumulate otherwise.
//   the rest trim other startup subprocesses/work.
const _BASE_LAUNCH_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox',
  '--disable-dev-shm-usage', '--disable-gpu',
  '--single-process', '--no-zygote',
  '--disable-crash-reporter', '--disable-breakpad',
  '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-networking', '--disable-sync',
];

let _pdfBusy = false;

// Shared single-flight semaphore. ALL PDF generation — both the on-demand
// download path (generatePdf) AND the Drive-upload buffer path
// (generatePdfBuffer, used by invoices/quotes/orders/vendor POs) — must
// serialize through this. Railway's memory/process budget can't handle two
// Chromium instances at once; the symptom when it does is a launch failure:
// "Failed to launch the browser process … Cannot fork … Resource temporarily
// unavailable". Returns false if it waited past maxWaitMs without acquiring.
async function _acquirePdf(maxWaitMs) {
  let waited = 0;
  while (_pdfBusy) {
    await new Promise(r => setTimeout(r, 300));
    waited += 300;
    if (waited > maxWaitMs) return false;
  }
  _pdfBusy = true;
  return true;
}
function _releasePdf() { _pdfBusy = false; }

// Launch Chromium with a few retries. Fork failures under transient memory/PID
// pressure usually clear once the previous job's processes are reaped.
async function _launchWithRetry(opts, attempts) {
  let lastErr;
  const tries = attempts || 3;
  for (let i = 0; i < tries; i++) {
    try { return await _puppeteer.launch(opts); }
    catch (e) {
      lastErr = e;
      console.warn(`[pdf] Chromium launch attempt ${i + 1}/${tries} failed: ${e.message}`);
      if (i < tries - 1) await new Promise(r => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw lastErr;
}

// Shared, semaphore-guarded Chromium session. EVERY Puppeteer launch in the
// app should go through this (PDF generation here AND freight carrier-tracking
// scrapes in lib/freight.js) so that only ONE Chromium ever runs at a time.
// Railway's container can't fork a second browser under memory/PID pressure —
// the symptom is exactly "Failed to launch the browser process … posix_spawn
// chrome_crashpad_handler: Resource temporarily unavailable". Uses the hardened
// _BASE_LAUNCH_ARGS (single-process, no-zygote, crashpad off) which keep the
// subprocess/PID footprint minimal.
//   opts.maxWaitMs  – how long to wait for the shared renderer (default 60s)
//   opts.extraArgs  – launch args appended to _BASE_LAUNCH_ARGS
//   opts.defaultViewport / opts.attempts – passed through to launch/retry
// Throws "Browser busy — timed out waiting for its turn" if it can't acquire.
async function withBrowser(opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  opts = opts || {};
  if (!_puppeteer) throw new Error('Puppeteer not available');
  const got = await _acquirePdf(opts.maxWaitMs == null ? 60000 : opts.maxWaitMs);
  if (!got) throw new Error('Browser busy — timed out waiting for its turn');
  let browser;
  try {
    browser = await _launchWithRetry({
      args: [..._BASE_LAUNCH_ARGS, ...(opts.extraArgs || [])],
      defaultViewport: opts.defaultViewport || { width: 1200, height: 900 },
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    }, opts.attempts);
    return await fn(browser);
  } finally {
    if (browser) await browser.close().catch(() => {});
    _releasePdf();
  }
}

// Generate PDF buffer from an internal page URL (uses Puppeteer).
// Serialized through the shared semaphore (waits up to 60s for its turn).
async function generatePdfBuffer(pageUrl) {
  if (!_puppeteer) throw new Error('Puppeteer not available');
  const got = await _acquirePdf(60000);
  if (!got) throw new Error('PDF renderer busy — timed out waiting for its turn');
  console.log(`GDrive: generating PDF for ${pageUrl}`);
  let browser;
  try {
    browser = await _launchWithRetry({
      args: [..._BASE_LAUNCH_ARGS, '--disable-web-security', '--disable-features=IsolateOrigins'],
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
    _releasePdf();
  }
}

async function generatePdf(pageUrl, filename, res, req) {
  if (!_puppeteer) {
    res.writeHead(503); res.end('PDF generation not available'); return;
  }
  const got = await _acquirePdf(30000);
  if (!got) { res.writeHead(503); res.end('PDF busy — try again'); return; }
  let browser;
  try {
    const cookies = req.headers.cookie || '';
    const sessionCookie = cookies.split(';')
      .map(c => c.trim())
      .find(c => c.startsWith('wr_qt_session=') || c.startsWith('wr_oauth_session='));

    browser = await _launchWithRetry({
      args: _BASE_LAUNCH_ARGS,
      defaultViewport: { width: 1200, height: 900 },
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });

    const page = await browser.newPage();

    if (sessionCookie) {
      const eqIdx = sessionCookie.indexOf('=');
      const name  = sessionCookie.slice(0, eqIdx).trim();
      const value = sessionCookie.slice(eqIdx + 1).trim();
      // Derive cookie domain from the target page so staging and prod both work
      let cookieDomain = 'sales.whisperroom.com';
      try { cookieDomain = new URL(pageUrl).hostname; } catch(e) {}
      await page.setCookie({ name, value, domain: cookieDomain, path: '/', httpOnly: true });
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
    if (browser) await browser.close().catch(() => {});
    _releasePdf();
  }
}

module.exports = {
  init,
  withBrowser,
  generatePdfBuffer,
  generatePdf,
};
