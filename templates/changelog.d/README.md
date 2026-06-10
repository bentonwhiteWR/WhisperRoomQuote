# changelog.d — conflict-free changelog entries

One file per version, named `<version>.js`. **Never edit `templates/changelog.js` to add an entry** — that's the file two parallel pushes always conflicted in.

Format (same fields the legacy inline array uses):

```js
module.exports = {
  v: '1.87.1', date: 'June 9, 2026', tag: 'fix',   // tag: fix | feature | ui | log | security
  changes: [
    { t: 'fix', d: 'What changed, in user-facing language. HTML entities for quotes: &quot; &apos; &Prime;' },
  ],
};
```

- `t` per change: `fix` | `add` | `ui` | `log` | `security`.
- Apostrophe gotcha from v1.72.11 applies here too: prefer `&apos;` inside `d` strings.
- Entries render on `/changelog` above the legacy array, sorted newest-first by `v`.
- `scripts/check-syntax.js` (pre-commit) validates any staged fragment; the server skips (and warns about) a malformed one instead of crashing.
