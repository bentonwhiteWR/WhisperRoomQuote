module.exports = {
  v: '1.105.0', date: 'June 12, 2026', tag: 'feature',
  changes: [
    { t: 'add', d: '**Marketing: 📊 Pulse drill-downs — every number opens the records behind it.** KPI cards (new contacts, form conversions, deals created/won, won revenue), funnel stages, donut slices, win/loss reason bars, velocity buckets, lead-flow source chips, and form rows are now clickable: a popup lists the actual HubSpot contacts or deals with source, stage, amount, and close info, each row deep-linking to its HubSpot record. Drill counts always match the number clicked — the popup uses the exact same grouping as the chart.' },
    { t: 'add', d: '**Marketing: 📊 Pulse form-conversion charts.** Two new sections: Form Conversions (weekly stacked bars per form, top forms colored and the long tail folded into &quot;Other&quot;) and Form Conversions by Source (each form&apos;s submissions split by the contact&apos;s first-touch channel). Counts each contact&apos;s first form submission — the new-lead view. The HubSpot sync now pulls the conversion-event fields; press Sync All once after this deploy to backfill them.' },
  ],
};
