module.exports = {
  v: '1.102.1', date: 'June 11, 2026', tag: 'fix',
  changes: [
    { t: 'fix', d: '**Marketing: digest and content-plan generation no longer rejected by Claude.** First live digest run hit a structured-output rule: array schemas only accept minItems of 0 or 1, and ours asked for 3+ and 5+. The item-count expectations moved into the prompts; the schemas now pass validation.' },
  ],
};
