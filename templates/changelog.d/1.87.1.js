// First conflict-free changelog fragment — see README.md in this directory.
module.exports = {
  v: '1.87.1', date: 'June 9, 2026', tag: 'fix',
  changes: [
    { t: 'fix', d: '**Two people can finally push at the same time.** Every version bump used to edit the same three lines (top of the changelog array, top of the DEVLOG table, the package.json version), so parallel pushes by two reps always merge-conflicted — and the changelog file is the one that crash-loops the server when a merge goes wrong. Changelog entries now live one-file-per-version in templates/changelog.d/ (this entry is the first), DEVLOG table rows auto-merge (union merge), and a new scripts/ship.sh does the fetch → rebase → verify → push dance in one command with clear guidance when the rare real conflict remains. The pre-commit check now validates changelog fragments too, and a fresh clone gets rebase-friendly git defaults from scripts/install-hooks.sh.' },
  ],
};
