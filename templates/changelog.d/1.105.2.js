module.exports = {
  v: '1.105.2', date: 'June 12, 2026', tag: 'fix',
  changes: [
    { t: 'fix', d: '**Marketing: 📊 Pulse form charts say WHY they&apos;re empty and fix it in one click.** The form sections looked silently empty after a sync because the new conversion fields only land when the HubSpot contacts sync re-pulls on the new code. The empty state now reports how many contacts carry the fields: when it&apos;s zero, a &quot;⟳ Sync HubSpot contacts now&quot; link runs the targeted contacts-only sync (faster than Sync All — skips Google Ads and Search Console) and refreshes the tab when done; otherwise it suggests a longer date range.' },
  ],
};
