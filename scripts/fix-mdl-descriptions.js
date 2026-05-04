#!/usr/bin/env node
// Usage: HS_TOKEN=pat-xxx node scripts/fix-mdl-descriptions.js
// Add --apply to actually update HubSpot. Without --apply it only prints the plan.

const https = require('https');

const HS_TOKEN = process.env.HS_TOKEN;
const APPLY    = process.argv.includes('--apply');

if (!HS_TOKEN) { console.error('Set HS_TOKEN env var'); process.exit(1); }

// ── HubSpot request helper ────────────────────────────────────────
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

// ── Fetch ALL products (paginated) ────────────────────────────────
async function fetchAll() {
  let all = [], after = null, page = 0;
  do {
    let path = '/crm/v3/objects/products?limit=100&properties=name,description,hs_sku';
    if (after) path += `&after=${encodeURIComponent(after)}`;
    const r = await hsRequest('GET', path);
    const results = r.body?.results || [];
    all.push(...results);
    after = r.body?.paging?.next?.after || null;
    page++;
    if (!after || results.length === 0) break;
  } while (page < 20);
  return all;
}

// ── Parse description (old or new format) → array of lines ───────
function parseDesc(desc) {
  if (!desc) return [];
  // New format already uses newlines
  if (desc.includes('\n')) return desc.split('\n').map(l => l.trim()).filter(Boolean);
  // Old format: first separator is "; " then ". "
  // Split on ". " but not decimal numbers like "8.5'"
  const parts = desc.split(/\.\s+/).map(p => p.trim()).filter(Boolean);
  // Remove trailing period from last part
  if (parts.length && parts[parts.length-1].endsWith('.')) {
    parts[parts.length-1] = parts[parts.length-1].slice(0, -1).trim();
  }
  // First part may have "; " joining type and isolation — replace with space
  if (parts.length) parts[0] = parts[0].replace(/;\s+/g, ' ');
  // Fix dimension spacing: "5 ' x 7'" → "5' x 7'"
  if (parts.length) parts[0] = parts[0].replace(/(\d)\s+'/g, "$1'");
  return parts;
}

// ── Extract number from a line like "Standard Ventilation Systems (3)" ──
function extractCount(line) {
  const m = line.match(/\((\d+)\)/);
  return m ? parseInt(m[1]) : null;
}

// ── Build corrected description ───────────────────────────────────
function fixDesc(desc) {
  const lines = parseDesc(desc);
  if (!lines.length) return desc;

  // Find vent count
  const ventLine  = lines.find(l => /ventilation systems?/i.test(l));
  const lightLine = lines.find(l => /\blight/i.test(l));
  const ventCount = ventLine  ? extractCount(ventLine)  : null;
  const lightIdx  = lines.findIndex(l => /\blight/i.test(l));

  // Fix light count if it doesn't match vent count
  if (ventCount !== null && lightIdx >= 0) {
    const currentLightCount = extractCount(lines[lightIdx]);
    if (currentLightCount !== ventCount) {
      lines[lightIdx] = lines[lightIdx].replace(/\(\d+\)/, `(${ventCount})`);
    }
  }

  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  console.log(`Fetching all products from HubSpot…`);
  const all = await fetchAll();
  console.log(`Total products: ${all.length}`);

  const mdl = all.filter(p => /^MDL\b/i.test(p.properties?.name || ''));
  console.log(`MDL products:   ${mdl.length}\n`);

  const changes = [];

  for (const p of mdl) {
    const name    = p.properties?.name || '';
    const oldDesc = p.properties?.description || '';
    const newDesc = fixDesc(oldDesc);

    // Detect if anything actually changed
    const descChanged    = newDesc !== oldDesc;

    if (descChanged) {
      changes.push({ id: p.id, name, oldDesc, newDesc });
    }
  }

  if (!changes.length) {
    console.log('✓ All MDL descriptions are already correct. Nothing to change.');
    return;
  }

  console.log(`${changes.length} MDL products need updates:\n`);
  console.log('─'.repeat(80));

  for (const c of changes) {
    console.log(`\n【${c.name}】 (id: ${c.id})`);
    console.log('  BEFORE:');
    c.oldDesc.split('\n').forEach(l => console.log(`    ${l}`));
    console.log('  AFTER:');
    c.newDesc.split('\n').forEach(l => console.log(`    ${l}`));
  }

  console.log('\n' + '─'.repeat(80));
  console.log(`\nTotal: ${changes.length} products would be updated.`);

  if (!APPLY) {
    console.log('\n[DRY RUN] Add --apply flag to actually update HubSpot.');
    return;
  }

  // Apply changes
  console.log('\nApplying updates…');
  let ok = 0, fail = 0;
  for (const c of changes) {
    const r = await hsRequest('PATCH', `/crm/v3/objects/products/${c.id}`, {
      properties: { description: c.newDesc }
    });
    if (r.status >= 200 && r.status < 300) {
      console.log(`  ✓ ${c.name}`);
      ok++;
    } else {
      console.error(`  ✗ ${c.name}: status ${r.status}`, r.body);
      fail++;
    }
  }
  console.log(`\nDone — ${ok} updated, ${fail} failed.`);
}

main().catch(e => { console.error(e); process.exit(1); });
