module.exports = {
  v: '1.91.0', date: 'June 10, 2026', tag: 'feature',
  changes: [
    { t: 'add', d: '**Inventory: archive old components.** In Adjust Inventory mode every row gets a 🗄 Archive button — archived components disappear from the grid, the category counts and the summary cards. A new &quot;Archived&quot; filter chip shows them (dimmed) with a ♻ Restore button, so nothing is ever deleted. Each archive/restore is recorded in the component&apos;s history. Archived codes still auto-deduct if an order ships with one, so stock stays honest.' },
    { t: 'ui', d: '**Inventory: On Hand cell shading matches the flags.** Low stock shades the On Hand cell amber; Not enough / negative shades it red — scannable at a glance without reading the Flags column.' },
  ],
};
