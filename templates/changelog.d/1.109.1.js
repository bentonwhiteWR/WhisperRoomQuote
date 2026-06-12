module.exports = {
  v: '1.109.1', date: 'June 12, 2026', tag: 'fix',
  changes: [
    { t: 'fix', d: '**Marketing: Landing Page Conversion query crash.** The section errored with &quot;operator does not exist: date &gt;= integer&quot; — Postgres mis-inferred the days parameter&apos;s type in the GA4 date window. Cast added; the table renders once GA4 data is synced.' },
  ],
};
