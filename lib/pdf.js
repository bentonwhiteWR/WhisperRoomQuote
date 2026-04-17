// PDF generation via Puppeteer
// Extracted from quote-server.js — named exports, no behavior changes.
// Host must call `init({ puppeteer })` before any pdf function is invoked.

let _puppeteer;

function init(deps) {
  _puppeteer = deps.puppeteer;
}

let _pdfBusy = false;

// Generate PDF buffer from an internal page URL (uses Puppeteer)
async function generatePdfBuffer(pageUrl) {
  if (!_puppeteer) throw new Error('Puppeteer not available');
  console.log(`GDrive: generating PDF for ${pageUrl}`);
  let browser;
  try {
    browser = await _puppeteer.launch({
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

async function generatePdf(pageUrl, filename, res, req) {
  if (!_puppeteer) {
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

    browser = await _puppeteer.launch({
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

module.exports = {
  init,
  generatePdfBuffer,
  generatePdf,
};
