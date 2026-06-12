// AI citability engine (intel-roadmap layer 3). For a keyword where an AI
// Overview exists but doesn't cite WhisperRoom (while we rank top-10), this
// produces the actual fix — not advice: an answer-first rewrite of the page
// opening, FAQ Q&As, ready-to-paste JSON-LD, and heading restructure — by
// reading OUR ranking page plus the top page the AI actually cites instead.
//
// URLs are never user-supplied: our_url and the cited refs come straight from
// marketing_serp_snapshots (the POST takes only a keyword), so this can't be
// pointed at arbitrary targets. Results cache in marketing_citability (one row
// per keyword, regenerate overwrites) so repeat views don't re-spend.

const https = require('https');
const http  = require('http');
const { jsonCall } = require('./claude');

// ── tiny page fetcher: GET → text, follow a few redirects, strip to prose ──
function _get(url, redirects = 4) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve({ ok: false, error: 'bad url' }); }
    const mod = u.protocol === 'http:' ? http : https;
    const r = mod.request(u, { method: 'GET', timeout: 15000, headers: { 'user-agent': 'WhisperRoomMarketing/1.0 (+https://whisperroom.com)' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(_get(new URL(res.headers.location, u).toString(), redirects - 1));
      }
      if (res.statusCode >= 400) { res.resume(); return resolve({ ok: false, error: 'HTTP ' + res.statusCode }); }
      const chunks = []; let size = 0;
      res.on('data', c => { size += c.length; if (size <= 1.5e6) chunks.push(c); });
      res.on('end', () => resolve({ ok: true, html: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', e => resolve({ ok: false, error: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ ok: false, error: 'timeout' }); });
    r.end();
  });
}

function _decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
}

// HTML → { title, meta, headings, sections, opening, jsonld, text }.
// v1.110.0 — upgraded from a flat text blob to a structural read so the
// model can make ANCHORED edits: `sections` pairs each heading with the
// first ~350 chars of copy under it (the model references real locations),
// and `opening` is the verbatim current page opening (the exact text an
// answer-first rewrite replaces).
function _stripTags(s) {
  return _decodeEntities(s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function _pageDigest(html, textCap) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const meta  = (html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["']/i) || [])[1] || '';
  const jsonld = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map(m => m[1].trim().slice(0, 2000)).slice(0, 4);
  // Section map: each h1-h3 with the copy that follows it (up to the next heading).
  const hMatches = [...html.matchAll(/<(h[1-3])[^>]*>([\s\S]*?)<\/\1>/gi)];
  const sections = hMatches.map((m, i) => {
    const tag = m[1].toUpperCase();
    const headingText = _stripTags(m[2]);
    const bodyStart = m.index + m[0].length;
    const bodyEnd = i + 1 < hMatches.length ? hMatches[i + 1].index : Math.min(html.length, bodyStart + 6000);
    const excerpt = _stripTags(html.slice(bodyStart, bodyEnd)).slice(0, 350);
    return { h: `${tag}: ${headingText}`, excerpt };
  }).filter(s => s.h.length > 5).slice(0, 40);
  const headings = sections.map(s => s.h).slice(0, 30);
  const text = _decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<(\/?)(p|div|li|h[1-6]|br|tr|section|article)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, textCap);
  const opening = text.slice(0, 1200);
  return { title: _decodeEntities(title).trim(), meta: _decodeEntities(meta).trim(), headings, sections, opening, jsonld, text };
}

const CIT_SYSTEM = [
  'You are a senior SEO/GEO EDITOR for WhisperRoom, a US manufacturer of modular sound-isolation booths. Your job: make WhisperRoom pages the source AI Overviews and LLMs cite.',
  'You will get: a keyword, WhisperRoom\'s ranking page (title, meta, section map with the copy under each heading, the verbatim current opening, full body text), and the page the AI Overview currently cites instead.',
  '',
  'YOU ARE EDITING AN EXISTING PAGE, NOT WRITING A NEW ONE. This page already ranks top-10 — the current content earned that. Propose the SMALLEST set of changes that makes the answer extractable by an LLM. Preserve the page\'s voice, structure, and substance. A fix that throws away working content is a bad fix.',
  '',
  'GROUNDING (hard rule): every factual claim in your copy (price, size, lead time, spec, material, certification, count) must appear in OUR PAGE\'s provided text. If a fix genuinely needs a fact the page does not state, write "[VERIFY: what to confirm]" in its place AND list it in `verify`. Never transplant facts from the competitor page into our copy. Never invent.',
  'REUSE (hard rule): build the answer-first rewrite out of the page\'s OWN sentences wherever possible — reorder, tighten, and join what is already there before writing anything new. In `answer_first_rewrite.reused`, name which existing sentences/facts you reused.',
  'ANCHORING (hard rule): every change names its exact location. `answer_first_rewrite.replaces` = the VERBATIM current opening text being replaced (quote it from the provided opening). Each heading fix\'s `current` = a VERBATIM heading from the section map, or \'INSERT AFTER: "<verbatim heading>"\' for additions. No floating advice.',
  'ANTI-STUFFING (hard rule): use the keyword only where it naturally answers the query — never repeat it for density, never bolt on sections that exist solely to chant the term. LLMs cite pages that answer cleanly; stuffing reads as spam to them too. If the page already answers a sub-question well, point to it in `keep` instead of duplicating it.',
  '',
  'In `keep`, list 2-5 things the page already does well that nobody should "fix" while implementing your changes.',
  'Each FAQ item carries `basis`: the page sentence or section that supports the answer, or "[VERIFY: ...]" if it needs confirmation. An FAQ answer with no basis and no verify flag is not allowed.',
  '',
  'Hard rules for any copy you write:',
  '- Never use the word "soundproof" — say "sound isolation" or "sound-isolating". (Quoting the keyword itself verbatim is fine.)',
  '- Never use em dashes.',
  '- Short sentences, benefit-focused, factual. No hype.',
  'The answer_first_rewrite.text must directly answer the query in the first two sentences (extractable by an LLM), then support with specifics from the existing page. 120-200 words.',
  'Produce 3-6 faq items and 3-8 heading_fixes.',
  'schema_jsonld must be valid JSON-LD a developer can paste as-is: FAQPage from your faq items, plus Product where the page sells a booth (use only facts present on the page; never invent prices or ratings).',
  'In competitor_takeaways, name what the cited page does STRUCTURALLY that ours does not — structure is what you may borrow; their facts are not.',
].join('\n');

// v1.110.0 — anchored-edit schema. The old shape was free strings, which is
// exactly what let fixes float ("add an H2 about prices") instead of editing
// the real page. Every fix now carries its anchor: the verbatim text it
// replaces or follows, the basis sentence behind an FAQ answer, and a
// `verify` list for anything the page doesn't actually state.
// No array length constraints — Claude's structured-output validator
// rejects minItems>1/maxItems; counts live in the system prompt.
const CIT_SCHEMA = {
  type: 'object',
  properties: {
    score:        { type: 'integer', description: 'Current citability 0-100.' },
    diagnosis:    { type: 'string', description: '2-4 sentences: why the AI cites the other page and not ours.' },
    keep:         { type: 'array', items: { type: 'string' }, description: 'What the page already does well — implementers must not break these.' },
    answer_first_rewrite: {
      type: 'object',
      properties: {
        replaces: { type: 'string', description: 'VERBATIM quote of the existing opening text this replaces.' },
        text:     { type: 'string', description: 'The replacement opening, 120-200 words.' },
        reused:   { type: 'string', description: 'Which existing page sentences/facts were reused in the rewrite.' },
      },
      required: ['replaces', 'text', 'reused'], additionalProperties: false,
    },
    faq:          { type: 'array', items: { type: 'object', properties: { q: { type: 'string' }, a: { type: 'string' }, basis: { type: 'string', description: 'The page sentence/section supporting this answer, or [VERIFY: ...].' } }, required: ['q', 'a', 'basis'], additionalProperties: false } },
    heading_fixes: { type: 'array', items: { type: 'object', properties: { current: { type: 'string', description: 'VERBATIM existing heading, or INSERT AFTER: "<verbatim heading>".' }, proposed: { type: 'string' }, why: { type: 'string' } }, required: ['current', 'proposed', 'why'], additionalProperties: false } },
    schema_jsonld: { type: 'string' },
    verify:       { type: 'array', items: { type: 'string' }, description: 'Facts used that must be confirmed before publishing.' },
    competitor_takeaways: { type: 'string' },
  },
  required: ['score', 'diagnosis', 'keep', 'answer_first_rewrite', 'faq', 'schema_jsonld', 'heading_fixes', 'verify', 'competitor_takeaways'],
  additionalProperties: false,
};

async function runCitability({ db, keyword, force = false }) {
  if (!db) return { ok: false, error: 'no db' };
  keyword = String(keyword || '').trim().toLowerCase();
  if (!keyword) return { ok: false, status: 400, error: 'keyword required' };

  if (!force) {
    const c = await db.query(`SELECT * FROM marketing_citability WHERE keyword = $1`, [keyword]);
    if (c.rows[0]) return { ok: true, cached: true, keyword, result: c.rows[0].result, created_at: c.rows[0].created_at };
  }

  const s = await db.query(`
    SELECT DISTINCT ON (keyword) keyword, our_rank, our_url, ai_overview,
           ai_overview_cited, ai_overview_refs, paa_questions, search_volume
    FROM marketing_serp_snapshots WHERE keyword = $1
    ORDER BY keyword, checked_on DESC`, [keyword]);
  const snap = s.rows[0];
  if (!snap) return { ok: false, status: 404, error: 'No SERP snapshot for that keyword.' };
  if (!snap.our_url) return { ok: false, status: 400, error: 'We have no ranking URL captured for that keyword.' };

  const ours = await _get(snap.our_url);
  if (!ours.ok) return { ok: false, status: 502, error: `Could not fetch our page (${ours.error}).` };
  // 24k chars (~6k tokens) — long product pages were getting half-read at 12k,
  // which is where generic, ungrounded fixes came from (v1.110.0).
  const ourDigest = _pageDigest(ours.html, 24000);

  // The first cited ref with a fetchable URL that isn't us — what "winning" looks like.
  let compDigest = null, compRef = null;
  for (const ref of (snap.ai_overview_refs || [])) {
    if (!ref.url || (ref.domain || '').includes('whisperroom')) continue;
    const page = await _get(ref.url);
    if (page.ok) { compDigest = _pageDigest(page.html, 8000); compRef = ref; break; }
  }

  const user = [
    `Keyword: "${keyword}" — WhisperRoom ranks #${snap.our_rank ?? '?'} organically${snap.search_volume != null ? `, ~${snap.search_volume} searches/mo` : ''}.`,
    `AI Overview: present, WhisperRoom NOT cited. Cited sources: ${(snap.ai_overview_refs || []).map(r => r.domain).filter(Boolean).join(', ') || '(none captured)'}.`,
    (snap.paa_questions || []).length ? `People-Also-Ask on this SERP: ${(snap.paa_questions || []).join(' | ')}` : '',
    '',
    `=== OUR PAGE (${snap.our_url}) ===`,
    `Title: ${ourDigest.title}`,
    ourDigest.meta ? `Meta description: ${ourDigest.meta}` : 'Meta description: none.',
    `CURRENT PAGE OPENING (verbatim — answer_first_rewrite.replaces quotes from here):\n${ourDigest.opening}`,
    `SECTION MAP (each heading + the copy under it — anchor heading_fixes to these verbatim):\n${ourDigest.sections.map(s => `${s.h}\n  ${s.excerpt}`).join('\n')}`,
    ourDigest.jsonld.length ? `Existing JSON-LD (truncated):\n${ourDigest.jsonld.join('\n---\n')}` : 'Existing JSON-LD: none found.',
    `FULL BODY TEXT (truncated at 24k chars — the grounding source for every fact):\n${ourDigest.text}`,
    '',
    compDigest
      ? `=== THE PAGE THE AI CITES (${compRef.url}) ===\nTitle: ${compDigest.title}\nHeadings:\n${compDigest.headings.join('\n')}\nBody text (truncated):\n${compDigest.text}`
      : '=== No cited competitor page could be fetched — audit ours on its own merits. ===',
  ].filter(Boolean).join('\n');

  const res = await jsonCall({ system: CIT_SYSTEM, user, schema: CIT_SCHEMA, maxTokens: 5000 });
  if (!res.ok) return res;

  const result = Object.assign({}, res.data, {
    our_url: snap.our_url, our_rank: snap.our_rank, search_volume: snap.search_volume,
    cited_competitor: compRef ? compRef.url : null,
  });
  await db.query(`
    INSERT INTO marketing_citability (keyword, our_url, result, model)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (keyword) DO UPDATE SET our_url = $2, result = $3, model = $4, created_at = NOW()`,
    [keyword, snap.our_url, JSON.stringify(result), res.model]);
  return { ok: true, cached: false, keyword, result };
}

// ── bulk mode (v1.103.0) ─────────────────────────────────────────────────
// Generates fixes for the top-N uncited candidates that DON'T have one yet
// (by volume, then rank). Runs in the background — 10 fixes ≈ 3-5 minutes of
// page fetches + Claude calls, far past a request timeout — so the endpoint
// returns {queued} immediately and progress lands in the 'citability' sync row.
let _bulkRunning = false;
async function runCitabilityBulk({ db, limit = 10 }) {
  if (!db) return { ok: false, error: 'no db' };
  if (_bulkRunning) return { ok: false, status: 409, error: 'A bulk run is already in progress — give it a few minutes.' };
  limit = Math.min(Math.max(parseInt(limit) || 10, 1), 25);
  const cand = (await db.query(`
    WITH latest AS (
      SELECT DISTINCT ON (keyword) keyword, our_rank, our_url, ai_overview, ai_overview_cited, search_volume
      FROM marketing_serp_snapshots ORDER BY keyword, checked_on DESC
    )
    SELECT l.keyword FROM latest l
    LEFT JOIN marketing_citability c ON c.keyword = l.keyword
    WHERE l.ai_overview AND NOT l.ai_overview_cited AND l.our_rank <= 10
      AND l.our_url IS NOT NULL AND c.keyword IS NULL
    ORDER BY l.search_volume DESC NULLS LAST, l.our_rank ASC
    LIMIT $1`, [limit])).rows.map(r => r.keyword);
  if (!cand.length) return { ok: true, queued: 0, note: 'Every candidate already has a generated fix.' };

  _bulkRunning = true;
  (async () => {
    let done = 0, failed = 0;
    for (const keyword of cand) {
      try {
        const r = await runCitability({ db, keyword });
        if (r.ok) done++; else { failed++; console.warn(`[citability-bulk] ${keyword}: ${r.error}`); }
      } catch (e) { failed++; console.warn(`[citability-bulk] ${keyword}: ${e.message}`); }
    }
    _bulkRunning = false;
    try {
      await db.query(
        `INSERT INTO marketing_syncs (report_type, last_synced_at, rows_synced, error)
         VALUES ('citability', NOW(), $1, $2)
         ON CONFLICT (report_type) DO UPDATE SET last_synced_at = NOW(), rows_synced = $1, error = $2`,
        [done, failed ? `${failed} of ${cand.length} failed — see logs` : null]);
    } catch (e) { /* non-fatal */ }
    console.log(`[citability-bulk] finished: ${done} generated, ${failed} failed`);
  })();
  return { ok: true, queued: cand.length };
}

module.exports = { runCitability, runCitabilityBulk };
