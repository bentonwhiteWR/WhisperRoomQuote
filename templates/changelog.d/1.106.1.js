module.exports = {
  v: '1.106.1', date: 'June 12, 2026', tag: 'fix',
  changes: [
    { t: 'fix', d: '**Marketing: 📊 Pulse form charts group by the actual form.** HubSpot names conversion events &quot;Page title: Form name&quot;, so one form looked like many (a separate entry per page it&apos;s embedded on) and a page rename split a form&apos;s history in two — the WhisperRoom Quiz showed as both &quot;Find Your WhisperRoom: …&quot; and &quot;WhisperRoom Quiz: …&quot;. Both charts and their drill-downs now group by the form name itself (page prefix dropped), with an editable alias table for forms that were themselves renamed.' },
  ],
};
