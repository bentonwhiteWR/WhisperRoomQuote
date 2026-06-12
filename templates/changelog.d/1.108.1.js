module.exports = {
  v: '1.108.1', date: 'June 12, 2026', tag: 'fix',
  changes: [
    { t: 'fix', d: '**Marketing: GA4 sync state is always visible in the header.** An unconfigured or misconfigured GA4 was skipped silently by Sync All (by design, so the sync never fails pre-setup) — which made a mangled key paste look like &quot;nothing happened&quot;. The status line now always shows one of three GA4 states: synced (with row count and any error), ready but never synced, or not configured with the missing/unreadable variable named.' },
  ],
};
