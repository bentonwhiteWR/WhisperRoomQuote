module.exports = {
  v: '1.110.0', date: 'June 12, 2026', tag: 'feature',
  changes: [
    { t: 'add', d: '**Marketing: AI Citability fixes are now anchored, grounded, surgical edits.** The generator was producing generic advice because it half-read long pages and nothing forced it to respect the existing content. Now it reads twice as much page text plus a section map (each heading with the copy under it), and every fix must anchor to real text: the answer-first rewrite quotes the exact opening it replaces and names which existing sentences it reuses; heading fixes quote the verbatim current heading; every FAQ answer cites the page sentence backing it; an &quot;Already working — don&apos;t touch&quot; list protects the good parts; and any fact the page doesn&apos;t state lands in a &quot;⚠ Verify before publishing&quot; list instead of being invented. Hard anti-stuffing rule: the keyword appears only where it naturally answers the query. Existing cached fixes keep the old format — press ↻ to regenerate one under the new logic.' },
  ],
};
