#!/usr/bin/env node
// Read-only diagnostic. Does NOT modify anything in HubSpot.
//
// Usage:
//   HS_TOKEN=pat-xxx node scripts/audit-product-price-history.js
//   HS_TOKEN=pat-xxx node scripts/audit-product-price-history.js audimute   (filter by name substring)
//
// Prints the price-change history of each product (who / what / when changed it),
// so you can see HOW a catalog price reverted. HubSpot stamps every change with a
// sourceType:
//   CRM_UI       → a person edited it by hand in HubSpot
//   IMPORT       → a CSV import overwrote it   (most common cause of "it reverted weeks later")
//   WORKFLOW     → a HubSpot workflow set it
//   INTEGRATION  → a connected app / sync (sourceId = the app id)
//   API          → a private-app token wrote it directly (sourceId = the app id)
//   MIGRATION/BATCH_UPDATE/etc → bulk operations

const https = require('https');

const HS_TOKEN = process.env.HS_TOKEN;
const FILTER   = (process.argv[2] || '').toLowerCase(); // optional name substring

if (!HS_TOKEN) { console.error('Set HS_TOKEN env var'); process.exit(1); }

function hsRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'api.hubapi.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${HS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Fetch all products WITH the full history of the price property.
async function fetchAllWithPriceHistory() {
  let all = [], after = null, page = 0;
  do {
    let path = '/crm/v3/objects/products?limit=50' +
               '&properties=name,price,hs_sku' +
               '&propertiesWithHistory=price';
    if (after) path += `&after=${encodeURIComponent(after)}`;
    const r = await hsRequest('GET', path);
    if (r.status >= 400) { console.error('HubSpot error', r.status, r.body); process.exit(1); }
    const results = r.body?.results || [];
    all.push(...results);
    after = r.body?.paging?.next?.after || null;
    page++;
    if (!after || results.length === 0) break;
  } while (page < 40);
  return all;
}

function fmt(ts) {
  // ts is an ISO string from HubSpot
  try { return new Date(ts).toISOString().replace('T', ' ').slice(0, 16); }
  catch { return ts; }
}

async function main() {
  console.log('Fetching products with price history…\n');
  const all = await fetchAllWithPriceHistory();
  console.log(`Total products: ${all.length}`);

  let products = all;
  if (FILTER) {
    products = all.filter(p => (p.properties?.name || '').toLowerCase().includes(FILTER));
    console.log(`Filtered to "${FILTER}": ${products.length}`);
  }

  // Only show products whose price actually changed more than once.
  const changed = products
    .map(p => ({
      name: p.properties?.name || '(no name)',
      sku: p.properties?.hs_sku || '',
      current: p.properties?.price,
      history: (p.propertiesWithHistory?.price || []),
    }))
    .filter(p => p.history.length > 1);

  // Sort by most recent change, newest first.
  changed.sort((a, b) => {
    const at = a.history[0]?.timestamp || '';
    const bt = b.history[0]?.timestamp || '';
    return bt.localeCompare(at);
  });

  if (!changed.length) {
    console.log('\nNo products have more than one recorded price value.');
    return;
  }

  console.log(`\n${changed.length} product(s) have a multi-entry price history:\n`);
  console.log('═'.repeat(90));

  for (const p of changed) {
    console.log(`\n【${p.name}】${p.sku ? '  sku:' + p.sku : ''}   current price: ${p.current}`);
    // history is newest-first from HubSpot
    for (const h of p.history.slice(0, 8)) {
      const who = h.updatedByUserId ? `user#${h.updatedByUserId}` : '';
      const src = [h.sourceType, h.sourceId, who].filter(Boolean).join(' / ');
      console.log(`    ${fmt(h.timestamp)}   $${h.value}   ←  ${src || '(unknown source)'}`);
    }
    if (p.history.length > 8) console.log(`    … (${p.history.length - 8} older entries)`);
  }

  console.log('\n' + '═'.repeat(90));
  console.log('\nLook at the sourceType on the line that set the WRONG (old) price:');
  console.log('  IMPORT      → find it in HubSpot ▸ Settings ▸ Import & Export ▸ Imports, and stop re-running it');
  console.log('  INTEGRATION → a connected app is syncing products and overwriting price (sourceId = app id)');
  console.log('  WORKFLOW    → a workflow is setting price; find it under Automation');
  console.log('  API         → a private-app token wrote it (sourceId = app id); check what else uses that token');
  console.log('  CRM_UI      → a person edited it manually (user# tells you who)');
}

main().catch(e => { console.error(e); process.exit(1); });
