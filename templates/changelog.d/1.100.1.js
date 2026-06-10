module.exports = {
  v: '1.100.1', date: 'June 10, 2026', tag: 'fix',
  changes: [
    { t: 'fix', d: '**Radar: the organic-decay check works now.** Its first scan failed with &quot;invalid input syntax for type integer: 0.4&quot; — Postgres guessed the 40% drop threshold was an integer because it multiplies the clicks column. Explicit float cast; run another scan to pick up any decay alerts the first one missed.' },
    { t: 'fix', d: '**Changelog: the 📡 Radar entry is back on v1.99.0.** A parallel-push merge had replaced it with a duplicate of the v1.100.0 booth-art entry.' },
  ],
};
