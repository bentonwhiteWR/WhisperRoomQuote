// scripts/seed-test-vendors.js
//
// One-time browser-console seed for the three reference vendors
// extracted from the Excel POs in C:\Users\bento\Documents\Claude\
// WR PO System\Old PO Files\ (Bertelkamp / Carpenter / Foss).
//
// HOW TO USE
//   1. Log into staging (test-sales-portal-production.up.railway.app)
//   2. Open the /vendors page
//   3. Open DevTools console (Ctrl+Shift+J)
//   4. Paste this entire file's contents and press Enter
//   5. Refresh the page — vendors appear in the list
//
// Idempotent: if a vendor with the same name already exists, the
// script updates it via PATCH instead of erroring on duplicate.
// Re-run any time to refresh prices/contacts.

(async () => {
  const VENDORS = [
    // ── Bertelkamp Automation, Inc. ────────────────────────────────
    {
      name: 'Bertelkamp Automation, Inc.',
      address_lines: ['P.O. Box 11643', 'Knoxville, TN 37939-1643'],
      phone: '865-588-7691',
      contacts: [{ name: 'Tyler Bailes' }, { name: 'Eric Hanson' }],
      send_to_emails: ['tbailes@bertelkamp.com'],
      cc_emails: [],
      payment_terms: '',
      freight_terms: 'For all orders that require freight shipping, please ship COLLECT via ABF Freight. Account # 189059.',
      standard_notes: 'Please send confirmation of order.',
      catalog: [
        { sku: '',      description: 'EXTRUSION AT 88" (Part 1530)',          mfg: '80/20',  mfg_part_no: '1530', default_qty: 20,   unit_price: 142.956, price_updated_date: '2026-02-18' },
        { sku: '',      description: 'EXTRUSION AT 82" (Part 1530)',          mfg: '80/20',  mfg_part_no: '1530', default_qty: 30,   unit_price: 133.209, price_updated_date: '2026-02-18' },
        { sku: '',      description: 'EXTRUSION AT 70" (Part 1530)',          mfg: '80/20',  mfg_part_no: '1530', default_qty: 10,   unit_price: 113.715, price_updated_date: '2026-02-18' },
        { sku: '',      description: 'CUT CHARGE — 1530',                     mfg: '80/20',  mfg_part_no: '7020', default_qty: 30,   unit_price:   3.6005, price_updated_date: '2026-02-18' },
        { sku: '',      description: '1 1/2" DOUBLE PANEL RETAINER',          mfg: '80/20',  mfg_part_no: '2515', default_qty: 60,   unit_price:   8.474, price_updated_date: '2026-02-18' },
        { sku: '12098', description: 'Standard Hinge No Tab Nylon Black',     mfg: '80/20',  mfg_part_no: '',     default_qty: 5000, unit_price:   8.436, price_updated_date: '2025-09-24' },
        { sku: '',      description: 'Plastic Combi Hinge 25, Non-detachable, Black', mfg: 'FATH', mfg_part_no: '', default_qty: 3000, unit_price: 3.35, price_updated_date: '2025-10-20' },
        { sku: '',      description: 'PST-4890-5000-60 LIFT TABLE',           mfg: 'VESTIL', mfg_part_no: '',     default_qty: 1,    unit_price: 6800,    price_updated_date: '2017-04-11' },
        { sku: '',      description: 'EHLT-4896-4-56 ELECTRIC HYDR LIFT TABLE 4K 48x96', mfg: 'VESTIL', mfg_part_no: '', default_qty: 1, unit_price: 6720.85, price_updated_date: '2022-06-21' },
        { sku: '',      description: 'VCC-115-1 VOLTAGE CHANGE TO 115V 1 PHASE', mfg: 'VESTIL', mfg_part_no: '', default_qty: 1,    unit_price:  89.90, price_updated_date: '2022-06-21' },
        { sku: '',      description: 'EXTRUSION AT 82" (Part 1515)',          mfg: '80/20',  mfg_part_no: '1515', default_qty: 2,    unit_price:  43.46, price_updated_date: '2016-04-29' },
        { sku: '',      description: 'CUT CHARGE — 1515',                     mfg: '80/20',  mfg_part_no: '7020', default_qty: 2,    unit_price:   1.95, price_updated_date: '2016-04-29' },
      ],
    },

    // ── Carpenter (foam) ────────────────────────────────────────────
    {
      name: 'Carpenter',
      address_lines: ['5306 East Morris Boulevard', 'Morristown, TN 37813'],
      phone: '423-581-8681',
      contacts: [{ name: 'Bridget Hoke' }, { name: 'Ben Collins' }],
      send_to_emails: ['Bridget.Hoke@carpenter.com'],
      cc_emails: [],
      payment_terms: '',
      freight_terms: '',
      standard_notes: 'Please provide product with the following tolerances: LENGTH & WIDTH +/- 1/8". THICKNESS +/- 1/16". IMPORTANT: Do not fold or crease foam sheets — this would render the foam unusable. Please send confirmation of order.',
      catalog: [
        { sku: '2720620', description: 'Foam Sheet 95.5" x 35.5" x 1" (CZ40140WT)',     mfg: 'Carpenter', mfg_part_no: 'CZ40140WT', default_qty: 120, unit_price: 15.79, price_updated_date: '2021-09-23' },
        { sku: '2720600', description: 'Foam Sheet 89.5" x 41.5" x 1" (CZ40140WT)',     mfg: 'Carpenter', mfg_part_no: 'CZ40140WT', default_qty: 240, unit_price: 17.25, price_updated_date: '2021-09-23' },
        { sku: '2720612', description: 'Foam Sheet 65.5" x 41.5" x 1" (CZ40140WT)',     mfg: 'Carpenter', mfg_part_no: 'CZ40140WT', default_qty: 120, unit_price: 12.79, price_updated_date: '2021-09-23' },
        { sku: '2720595', description: 'Foam Sheet 41.5" x 41.5" x 1" (CZ40140WT)',     mfg: 'Carpenter', mfg_part_no: 'CZ40140WT', default_qty: 120, unit_price:  2.81, price_updated_date: '2021-09-23' },
        { sku: '2740331', description: 'Foam Block 22.25" x 22.25" x 1.125" (CZ20100WT)', mfg: 'Carpenter', mfg_part_no: 'CZ20100WT', default_qty: 600, unit_price:  2.98, price_updated_date: '2021-09-23' },
        { sku: '2740329', description: 'Foam Block 22.25" x 7" x 1.125" (CZ20100WT)',   mfg: 'Carpenter', mfg_part_no: 'CZ20100WT', default_qty: 700, unit_price:  1.41, price_updated_date: '2021-09-23' },
        { sku: '2740327', description: 'Foam Block 7" x 7" x 1.125" (CZ20100WT)',       mfg: 'Carpenter', mfg_part_no: 'CZ20100WT', default_qty: 200, unit_price:  0.58, price_updated_date: '2021-09-23' },
      ],
    },

    // ── AJ Nonwovens-Hampton (Foss) ─────────────────────────────────
    {
      name: 'AJ Nonwovens-Hampton (Foss)',
      address_lines: ['11 Merrill Industrial Drive', 'Hampton, NH'],
      phone: '603-929-6116',
      contacts: [{ name: 'Jack Beehler' }],
      send_to_emails: ['jack.beehler@ajnw.com'],
      cc_emails: [],
      payment_terms: '1%10, Net 30',
      freight_terms: '',
      billing_address_override: 'WhisperRoom, Inc.\n322 Nancy Lynn Lane, Suite 14\nKnoxville, TN 37919\nAttn: Accounting\n800-200-8138',
      standard_notes: 'Ensure that color is consistent with previous shipments. Call with dimensions prior to shipping. Hold shipment until instructions received.',
      catalog: [
        { sku: '6A46A22X050P', description: 'Gray Tweed Duralock — 48" wide (price per LYD)', mfg: 'Foss', mfg_part_no: '6A46A22X050P', default_qty: 6000, unit_price: 4.14, price_updated_date: '2022-04-14' },
      ],
    },
  ];

  const opts = { credentials: 'include', headers: { 'Content-Type': 'application/json' } };

  // 1) Load existing vendors so we can update-or-create
  const listRes = await fetch('/api/vendors?archived=1', opts);
  const listJson = await listRes.json();
  if (!listRes.ok) { console.error('Failed to list vendors:', listJson); return; }
  const existing = new Map((listJson.vendors || []).map(v => [v.name, v]));

  let created = 0, updated = 0, failed = 0;
  for (const v of VENDORS) {
    try {
      const cur = existing.get(v.name);
      let r, action;
      if (cur) {
        action = 'PATCH';
        r = await fetch('/api/vendors/' + cur.id, { ...opts, method: 'PATCH', body: JSON.stringify(v) });
      } else {
        action = 'POST';
        r = await fetch('/api/vendors', { ...opts, method: 'POST', body: JSON.stringify(v) });
      }
      const j = await r.json();
      if (!r.ok) { failed++; console.error(`✗ ${v.name} (${action}):`, j); continue; }
      if (action === 'POST') { created++; console.log(`✓ Created vendor: ${v.name} (id=${j.vendor.id}, ${v.catalog.length} catalog items)`); }
      else                   { updated++; console.log(`✓ Updated vendor: ${v.name} (id=${j.vendor.id}, ${v.catalog.length} catalog items)`); }
    } catch(e) {
      failed++;
      console.error(`✗ ${v.name}:`, e.message);
    }
  }
  console.log(`Done — created ${created}, updated ${updated}, failed ${failed}. Refresh /vendors to see them.`);
})();
