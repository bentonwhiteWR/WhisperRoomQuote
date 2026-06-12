module.exports = {
  v: '1.109.2', date: 'June 12, 2026', tag: 'fix',
  changes: [
    { t: 'fix', d: '**Marketing: HubSpot deals sync no longer silently truncates.** Since June 10 the deals mirror had been incomplete — a bulk update touched 10,000+ deals inside one 30-day sync window, and HubSpot&apos;s search API caps any window at 10k results without warning. Deals now sync in weekly windows (the same fix contacts received after the April viral-month cap hit), so no realistic bulk edit can blow the cap again. Run one HubSpot sync after this deploy to backfill the truncated window.' },
  ],
};
