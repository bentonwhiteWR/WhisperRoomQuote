module.exports = {
  v: '1.87.2', date: 'June 9, 2026', tag: 'fix',
  changes: [
    { t: 'fix', d: '**Dev setup self-heals.** Claude sessions now check at startup whether the pre-commit syntax hook and the rebase-friendly git config are installed, and run scripts/install-hooks.sh themselves when missing — no manual one-time setup on a new clone or machine. Closes the loop on the v1.87.1 parallel-push workflow.' },
  ],
};
