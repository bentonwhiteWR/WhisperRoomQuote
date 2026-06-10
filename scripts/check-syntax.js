#!/usr/bin/env node
// Pre-commit syntax check. Catches the class of bug where a JS file parses
// in your editor but throws SyntaxError at `node` startup (mismatched quotes,
// over-escaped chars in template literals, stray semicolons, etc.) — the
// exact thing that crash-looped Railway in v1.72.11.
//
// What it does:
//   1. Find staged JS files (`git diff --cached --name-only --diff-filter=ACM`).
//   2. Run `node --check` on each — fails fast on syntax errors.
//   3. If `templates/changelog.js` is staged, ALSO require + invoke it
//      (catches errors that only surface when the template string is built,
//      not just parsed — e.g. inner-string escapes that fool --check).
//   4. If `lib/packing-list.js` is staged, ALSO require + init + generate()
//      with an empty list — catches broken exports / missing data files.
//   5. Strict-parse staged .json files AND reject a UTF-8 BOM — PowerShell's
//      `Set-Content -Encoding utf8` writes one, `require()` tolerates it, but
//      puppeteer's installer (parse-json) does not → Railway build failure
//      (bit us on the v1.84.28 package.json bump).
//
// Exit 0 → commit proceeds. Exit non-zero → git pre-commit hook aborts.

const { execSync } = require('child_process');
const path = require('path');

function red(s)   { return '\x1b[31m' + s + '\x1b[0m'; }
function green(s) { return '\x1b[32m' + s + '\x1b[0m'; }
function dim(s)   { return '\x1b[2m'  + s + '\x1b[0m'; }

function stagedFiles() {
  try {
    const out = execSync('git diff --cached --name-only --diff-filter=ACM', { encoding: 'utf8' });
    return out.split(/\r?\n/).filter(Boolean);
  } catch (e) {
    console.error(red('Could not list staged files: ' + e.message));
    process.exit(2);
  }
}

function checkSyntax(file) {
  try {
    execSync('node --check ' + JSON.stringify(file), { stdio: 'pipe' });
    return null;
  } catch (e) {
    return (e.stderr ? e.stderr.toString() : e.message).trim();
  }
}

function smokeTest(file) {
  // Resolve from repo root.
  const abs = path.resolve(process.cwd(), file);
  try {
    delete require.cache[require.resolve(abs)];
    const mod = require(abs);
    if (file === 'templates/changelog.js' && typeof mod === 'function') {
      const html = mod();
      if (typeof html !== 'string' || html.length < 100) {
        return 'changelog template returned suspiciously short output (' + (html && html.length) + ' chars)';
      }
    }
    if (file === 'lib/packing-list.js' && mod && typeof mod.init === 'function' && typeof mod.generate === 'function') {
      mod.init();
      mod.generate([]); // empty quote should just return {rooms:[], …} without throwing
    }
    // changelog.d fragments: the server SKIPS a malformed one (won't crash),
    // so this commit gate is what stops a bad entry shipping silently.
    if (/^templates[\/\\]changelog\.d[\/\\].+\.js$/.test(file)) {
      if (!mod || typeof mod.v !== 'string' || !/^\d+\.\d+\.\d+$/.test(mod.v) || !Array.isArray(mod.changes) || !mod.changes.length) {
        return 'changelog fragment must export { v: "x.y.z", date, tag, changes:[{t, d}, …] }';
      }
      for (const c of mod.changes) {
        if (!c || typeof c.t !== 'string' || typeof c.d !== 'string') return 'each change needs string fields t and d';
      }
    }
    return null;
  } catch (e) {
    return (e.stack || e.message);
  }
}

function checkJson(file) {
  try {
    const buf = require('fs').readFileSync(path.resolve(process.cwd(), file));
    if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
      return 'file starts with a UTF-8 BOM — strict JSON parsers (e.g. puppeteer’s installer) reject it and the Railway build fails. Re-save without BOM.';
    }
    JSON.parse(buf.toString('utf8'));
    return null;
  } catch (e) {
    return e.message;
  }
}

const files = stagedFiles();
const jsFiles = files.filter(f => /\.js$/.test(f) && !f.startsWith('node_modules/'));
const jsonFiles = files.filter(f => /\.json$/.test(f) && !f.startsWith('node_modules/'));
const failures = [];

if (!jsFiles.length && !jsonFiles.length) {
  console.log(dim('[check-syntax] no staged .js/.json files — skipping'));
  process.exit(0);
}

console.log(dim('[check-syntax] checking ' + jsFiles.length + ' staged JS + ' + jsonFiles.length + ' JSON file(s)…'));
for (const f of jsonFiles) {
  const jsonErr = checkJson(f);
  if (jsonErr) failures.push({ file: f, kind: 'json', err: jsonErr });
}
for (const f of jsFiles) {
  const syntaxErr = checkSyntax(f);
  if (syntaxErr) {
    failures.push({ file: f, kind: 'syntax', err: syntaxErr });
    continue;
  }
  // Targeted smoke tests — only for files where parse-OK doesn't prove load-OK.
  if (f === 'templates/changelog.js' || f === 'lib/packing-list.js' || /^templates[\/\\]changelog\.d[\/\\].+\.js$/.test(f)) {
    const loadErr = smokeTest(f);
    if (loadErr) failures.push({ file: f, kind: 'smoke', err: loadErr });
  }
}

if (failures.length) {
  console.error('');
  console.error(red('✗ pre-commit check FAILED (' + failures.length + ' issue' + (failures.length === 1 ? '' : 's') + '):'));
  for (const f of failures) {
    console.error('');
    console.error(red(f.kind === 'syntax' ? '  Syntax error in ' : f.kind === 'json' ? '  Invalid JSON in ' : '  Load error in ') + f.file);
    console.error(f.err.split('\n').map(l => '    ' + l).join('\n'));
  }
  console.error('');
  console.error(dim('To bypass (NOT recommended), run: git commit --no-verify'));
  process.exit(1);
}

console.log(green('[check-syntax] ok'));
