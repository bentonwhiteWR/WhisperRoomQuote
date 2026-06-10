module.exports = {
  v: '1.89.2', date: 'June 10, 2026', tag: 'ui',
  changes: [
    { t: 'fix', d: '**Inventory: column headers no longer cover the first rows.** The sticky header was getting pinned inside the table instead of to the top of the page (an overflow/sticky conflict) — it now sits above the first row and sticks neatly under the top bar as you scroll.' },
    { t: 'ui', d: '**Inventory: components grouped into categories.** The grid is now organized into sections — Ceilings, Floors, Standard/IEP Walls, Standard/IEP Windows, Doors &amp; Door Frames, Seam Seals, Height Extensions, Ventilation, Jacks &amp; Electrical, Foam, Acoustic Treatment, Caster Plates, Lights, Support Beams, Ramps &amp; Elevated Floor, Accessories. Ceilings and Floors each include both the standard and IEP versions. Click a category header to collapse/expand it (remembered per browser); searching or filtering shows every match regardless.' },
  ],
};
