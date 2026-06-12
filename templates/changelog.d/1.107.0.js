module.exports = {
  v: '1.107.0', date: 'June 12, 2026', tag: 'feature',
  changes: [
    { t: 'add', d: '**Marketing: GA4 integration (data layer).** New ETL pulls daily sessions, users, engagement, and key events from the Google Analytics Data API into two mirror tables: traffic by channel group (the trend + pacing denominators) and traffic by landing page (the landing-page conversion-rate join against HubSpot forms). Rides the same Google OAuth token as Ads + Search Console — re-mint once with the analytics scope, add the GA4 property id, done. Included in Sync All when configured (skipped silently before setup); GA4 status joins the header line. Feeds the upcoming pacing strip.' },
  ],
};
