module.exports = {
  v: '1.89.1', date: 'June 10, 2026', tag: 'ui',
  changes: [
    { t: 'ui', d: '**Inventory: cells locked until you press 🔓 Adjust Inventory.** The grid now shows plain read-only values by default — no accidental edits, and the columns line up cleanly under their headers. Press Adjust Inventory to unlock On Hand / Build Point / Build Qty for editing; Save or Discard re-locks the grid.' },
    { t: 'ui', d: 'Inventory: removed the Finished and In Process columns from the grid (still tracked behind the scenes and still accepted by Sync from Excel — just not shown).' },
  ],
};
