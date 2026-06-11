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

// HTML → { title, headings, jsonld, text } — crude but plenty for an audit.
function _pageDigest(html, textCap) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const jsonld = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map(m => m[1].trim().slice(0, 2000)).slice(0, 4);
  const headings = [...html.matchAll(/<(h[1-3])[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map(m => `${m[1].toUpperCase()}: ${_decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()}`)
    .filter(h => h.length > 4).slice(0, 30);
  const text = _decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<(\/?)(p|div|li|h[1-6]|br|tr|section|article)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, textCap);
  return { title: _decodeEntities(title).trim(), headings, jsonld, text };
}

const CIT_SYSTEM = [
  'You are a senior SEO/GEO editor for WhisperRoom, a US manufacturer of modular sound-isolation booths. Your job: make WhisperRoom pages the source AI Overviews and LLMs cite.',
  'You will get: a keyword, WhisperRoom\'s ranking page (digested), and the page the AI Overview currently cites instead. Produce the concrete fix.',
  'Hard rules for any copy you write:',
  '- Never use the word "soundproof" — say "sound isolation" or "sound-isolating". (Quoting the keyword itself verbatim is fine.)',
  '- Never use em dashes.',
  '- Short sentences, benefit-focused, factual. No hype.',
  'The answer_first_rewrite must directly answer the query in the first two sentences (extractable by an LLM), then support with specifics from the existing page. 120-200 words.',
  'schema_jsonld must be valid JSON-LD a developer can paste as-is: FAQPage from your faq items, plus Product where the page sells a booth (use only facts present on the page; never invent prices or ratings).',
  'In competitor_takeaways, name what the cited page does structurally that ours does not.',
].join('\n');

const CIT_SCHEMA = {
  type: 'object',
  properties: {
    score:        { type: 'integer', description: 'Current citability 0-100.' },
    diagnosis:    { type: 'string', description: '2-4 sentences: why the AI cites the other page and not ours.' },
    answer_first_rewrite: { type: 'string' },
    faq:          { type: 'array', maxItems: 6, items: { type: 'object', properties: { q: { type: 'string' }, a: { type: 'string' } }, required: ['q', 'a'], additionalProperties: false } },
    schema_jsonld: { type: 'string' },
    heading_fixes: { type: 'array', maxItems: 8, items: { type: 'string' } },
    competitor_takeaways: { type: 'string' },
  },
  required: ['score', 'diagnosis', 'answer_first_rewrite', 'faq', 'schema_jsonld', 'heading_fixes', 'competitor_takeaways'],
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
  const ourDigest = _pageDigest(ours.html, 12000);

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
    `Headings:\n${ourDigest.headings.join('\n')}`,
    ourDigest.jsonld.length ? `Existing JSON-LD (truncated):\n${ourDigest.jsonld.join('\n---\n')}` : 'Existing JSON-LD: none found.',
    `Body text (truncated):\n${ourDigest.text}`,
    '',
    compDigest
      ? `=== THE PAGE THE AI CITES (${compRef.url}) ===\nTitle: ${compDigest.title}\nHeadings:\n${compDigest.headings.join('\n')}\nBody text (truncated):\n${compDigest.text}`
      : '=== No cited competitor page could be fetched — audit ours on its own merits. ===',
  ].filter(Boolean).join('\n');

  const res = await jsonCall({ system: CIT_SYSTEM, user, schema: CIT_SCHEMA, maxTokens: 4000 });
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

module.exports = { runCitability };
