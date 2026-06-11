module.exports = {
  v: '1.101.1', date: 'June 11, 2026', tag: 'feature',
  changes: [
    { t: 'add', d: '**Marketing: SEO Intel click-to-filter.** The eight stat cards (Top 3, Top 10, Not ranking, Buried, AI Overview, Cited in AI, Featured snippet) now filter the rank tracker on click — click again or hit Keywords tracked to clear. The &quot;Outranking you most&quot; domains do the same: click reddit.com to see exactly which keywords it beats you on. A filter bar above the table shows what&apos;s active.' },
    { t: 'fix', d: '**Marketing: search volume column no longer silently empty.** Google Ads rejects an entire volume request when ANY keyword breaks its rules (over 80 characters, over 10 words, special symbols) — and the expanded 500-keyword list pulled raw search queries that did. One bad keyword nulled every volume while KD kept working. Now: keywords Google Ads would reject are pre-filtered (they just skip volume), a rejected request bisects itself so one bad keyword can&apos;t take down the rest, and every failure is logged with the offending keyword named. Run a force refresh to backfill volumes.' },
  ],
};
