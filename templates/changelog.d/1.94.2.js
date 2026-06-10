module.exports = {
  v: '1.94.2', date: 'June 10, 2026', tag: 'fix',
  changes: [
    { t: 'fix', d: '**Booth Builder: right-hinge doors keep a readable logo.** The flipped door now uses a dedicated render with the WhisperRoom plate re-pasted unmirrored, instead of a blind mirror that reversed the text.' },
    { t: 'ui', d: '**Seam seals read with depth.** Mid-wall and corner seals cast a soft shadow onto the panels they overlap (matching the SketchUp assembly reference), and corner seals sit proud of the booth edge so they break the silhouette like the real part.' },
    { t: 'fix', d: '**Vent wall lighting restored.** The import no longer &quot;corrects&quot; exposure — the renders are lit deliberately for depth.' },
  ],
};
