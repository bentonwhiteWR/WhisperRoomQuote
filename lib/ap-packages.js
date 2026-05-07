'use strict';

// Source of truth for Audimute Acoustic Package SKUs.
// Each entry: panel counts (1 Velcro Hang Tab Pack per panel) + wholesale cost.
// Keys are the numeric portion of the SKU (e.g., '9696' from "AP 9696").
const AP_PACKAGES = {
  '127':    { p2x4: 0, p1x4: 2, p1x2: 5,  cost: 292.00 },
  '4230':   { p2x4: 0, p1x4: 2, p1x2: 3,  cost: 220.00 },
  '4242':   { p2x4: 0, p1x4: 2, p1x2: 5,  cost: 292.00 },
  '4260':   { p2x4: 0, p1x4: 2, p1x2: 5,  cost: 292.00 },
  '4284':   { p2x4: 1, p1x4: 2, p1x2: 5,  cost: 368.00 },
  '4848':   { p2x4: 0, p1x4: 2, p1x2: 6,  cost: 328.00 },
  '4872':   { p2x4: 1, p1x4: 0, p1x2: 10, cost: 436.00 },
  '4896':   { p2x4: 1, p1x4: 4, p1x2: 6,  cost: 516.00 },
  '6060':   { p2x4: 0, p1x4: 3, p1x2: 7,  cost: 420.00 },
  '6084':   { p2x4: 2, p1x4: 2, p1x2: 7,  cost: 516.00 },
  '7272':   { p2x4: 0, p1x4: 6, p1x2: 10, cost: 696.00 },
  '7296':   { p2x4: 1, p1x4: 6, p1x2: 8,  cost: 700.00 },
  '8484':   { p2x4: 2, p1x4: 4, p1x2: 7,  cost: 628.00 },
  '9696':   { p2x4: 3, p1x4: 0, p1x2: 10, cost: 588.00 },
  '10284':  { p2x4: 3, p1x4: 2, p1x2: 9,  cost: 664.00 },
  '84102':  { p2x4: 3, p1x4: 2, p1x2: 9,  cost: 664.00 },
  '84126':  { p2x4: 3, p1x4: 5, p1x2: 7,  cost: 760.00 },
  '96120':  { p2x4: 3, p1x4: 4, p1x2: 12, cost: 884.00 },
  '96144':  { p2x4: 4, p1x4: 3, p1x2: 12, cost: 904.00 },
  '96168':  { p2x4: 5, p1x4: 2, p1x2: 14, cost: 996.00 },
  '96192':  { p2x4: 6, p1x4: 3, p1x2: 14, cost: 1128.00 },
  '102102': { p2x4: 3, p1x4: 2, p1x2: 11, cost: 736.00 },
  '102126': { p2x4: 4, p1x4: 3, p1x2: 11, cost: 868.00 },
  '102144': { p2x4: 4, p1x4: 3, p1x2: 13, cost: 940.00 },
  '102168': { p2x4: 5, p1x4: 3, p1x2: 13, cost: 1016.00 },
  '102186': { p2x4: 6, p1x4: 3, p1x2: 13, cost: 1092.00 },
};

// Resolve a line-item name (e.g., "AP 9696", "AP-9696", "AP9696") to the BOM.
// Returns null if not in the mapping (caller should render line without breakdown).
function getApPackage(name) {
  if (!name) return null;
  const m = String(name).match(/AP[\s\-_]?(\d+)/i);
  if (!m) return null;
  return AP_PACKAGES[m[1]] || null;
}

function totalPanels(pkg) {
  if (!pkg) return 0;
  return (pkg.p2x4 || 0) + (pkg.p1x4 || 0) + (pkg.p1x2 || 0);
}

// "Includes: 3 - 2'x4' panels. 10 - 1'x2' panels." — drops zero-count sizes.
function formatBreakdown(pkg) {
  if (!pkg) return '';
  const parts = [];
  if (pkg.p2x4) parts.push(`${pkg.p2x4} - 2'x4' panels.`);
  if (pkg.p1x4) parts.push(`${pkg.p1x4} - 1'x4' panels.`);
  if (pkg.p1x2) parts.push(`${pkg.p1x2} - 1'x2' panels.`);
  return parts.length ? 'Includes: ' + parts.join(' ') : '';
}

module.exports = { AP_PACKAGES, getApPackage, totalPanels, formatBreakdown };
