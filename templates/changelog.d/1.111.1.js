module.exports = {
  v: '1.111.1', date: 'June 12, 2026', tag: 'fix',
  changes: [
    { t: 'fix', d: '**Marketing: AI Citability fixes now state their snapshot context.** A live check showed WhisperRoom cited in the AI Overview while the dashboard said uncited — both were right: the dashboard snapshots the generic-US SERP, while a local browser sees a geo-personalized (Knoxville-friendly) variant, and AI Overview citations rotate per session. Every fix panel now leads with its snapshot date and a spot-check reminder (check from another region, re-run Sync SERP before declaring victory or defeat); the Guide gained the same concept.' },
  ],
};
