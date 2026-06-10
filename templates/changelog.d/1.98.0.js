module.exports = {
  v: '1.98.0', date: 'June 10, 2026', tag: 'feature',
  changes: [
    { t: 'fix', d: '**13 booth models were missing a vent set.** Verified every model against the production BOM (F01 counts) and the spec sheets: the 6060, 7272, 8484, 9696, 10284, 84102, 84126, 96120, 96144, 96168, 102102, 102126 and 102144 all carry one more vent set on the right wall than the layouts showed. All 25 models now match the BOM exactly — in the Booth Builder and the Packing List layout.' },
    { t: 'ui', d: '**One picker instead of two.** Ready-made packages and plain booth sizes now live in a single grouped dropdown — pick either and go.' },
    { t: 'ui', d: '**You can SEE what drags now.** The door, vents, windows and cable walls wear a pulsing ✥ handle in the top-down, so it&apos;s obvious they can be picked up and moved.' },
  ],
};
