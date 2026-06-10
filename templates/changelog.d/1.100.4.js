module.exports = {
  v: '1.100.4', date: 'June 10, 2026', tag: 'fix',
  changes: [
    { t: 'fix', d: '**Re-imported booth renders show up without a hard refresh.** The art files keep stable names and a day-long browser cache, so updated renders (like the VSS+EFS color fix) kept showing stale — every art URL now carries a version that bumps automatically on each import, flushing all browser caches at once.' },
  ],
};
