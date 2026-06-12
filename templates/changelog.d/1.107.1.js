module.exports = {
  v: '1.107.1', date: 'June 12, 2026', tag: 'fix',
  changes: [
    { t: 'fix', d: '**Marketing: GA4 can authenticate with a service-account key.** The shared-token route needed the whisperroomwr Google login (2FA on Benton&apos;s phone) and Google hard-blocked the personal-account consent. The GA4 ETL now prefers a service-account key (GA4_SA_KEY env, raw JSON or base64): no password, no 2FA, and the Ads + Search Console refresh token stays completely untouched. The original token route remains as a fallback if the token is ever re-minted with the analytics scope.' },
  ],
};
