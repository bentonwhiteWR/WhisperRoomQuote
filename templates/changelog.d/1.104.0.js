module.exports = {
  v: '1.104.0', date: 'June 12, 2026', tag: 'feature',
  changes: [
    { t: 'add', d: '**Marketing: 📊 Pulse — the HubSpot picture, as charts.** New tab on /marketing that turns the synced HubSpot mirror into a visual briefing: a KPI strip with prior-period deltas (new contacts, deals created/won, won revenue, win rate, median days to close), lead flow by first-touch source as a stacked gradient area chart, the lifecycle funnel for the window&apos;s cohort, won revenue by source as a donut, Pipeline Rhythm (deals-created bars against a won-revenue line so the sales-cycle lag is visible), why-we-win / why-we-lose reason bars, and a days-to-close histogram with the median bucket highlighted. One new endpoint ships all eight aggregates in a single response; everything renders from that one fetch, and the shared date-range selector drives it. Read-only — recommendations stay in Growth Engine and Radar.' },
  ],
};
