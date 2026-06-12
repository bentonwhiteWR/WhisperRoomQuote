module.exports = {
  v: '1.109.0', date: 'June 12, 2026', tag: 'feature',
  changes: [
    { t: 'add', d: '**Marketing: 🎯 Landing Page Conversion (GA4 × HubSpot × GSC).** New section on the Search Console tab: sessions, engagement, GA4 conversions, CVR, HubSpot leads, and lead rate per landing page, each classified against the site median. The Read column finally splits the two failure modes that used to look identical: 🔧 page problems (traffic engages but doesn&apos;t convert — fix the page), ✏️ snippet problems (page converts but its Google listing pulls half the normal CTR — fix the title/meta), plus ⚠ engagement problems and 🚀 hidden converters worth more traffic.' },
    { t: 'add', d: '**Marketing: 📡 funnel-breakage radar — insurance on the whole pipeline.** Three new daily checks: form conversions stopped or collapsed vs the 4-week norm (when GA4 sessions held steady while forms died, the alert says &quot;near-certain breakage&quot; — test the forms now); new-contact flow down 50%+; and any GA4 channel&apos;s weekly sessions down 40%+ with channel-specific guidance (organic → cross-check rankings vs tracking; paid → check for paused campaigns or billing). Pure SQL, no API spend, volume floors keep quiet weeks quiet.' },
  ],
};
