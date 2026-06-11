// Shared Claude (Anthropic) helper for the marketing module's AI features —
// the weekly digest, the AI-citability engine, and content-plan generation.
// Mirrors router.js's ad-rewrite call (raw HTTPS, no SDK, json_schema output)
// so all marketing AI calls behave the same; router's own copy is left alone
// to avoid touching shipped code.
//
// Model: claude-opus-4-8 (the project default, proven working on this key via
// ad rewrites). Override per-deploy with MARKETING_AI_MODEL in Railway.

const https = require('https');

const DEFAULT_MODEL = process.env.MARKETING_AI_MODEL || 'claude-opus-4-8';

function apiKey() { return process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || ''; }

function _messages(key, payloadStr, timeoutMs) {
  return new Promise((resolve) => {
    const r = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payloadStr),
      },
      timeout: timeoutMs,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let j; try { j = JSON.parse(raw); } catch { j = {}; }
        if (res.statusCode >= 400) {
          const m = (j.error && j.error.message) || raw.slice(0, 200);
          resolve({ ok: false, status: res.statusCode, error: `Claude ${res.statusCode}: ${m}` });
        } else resolve({ ok: true, json: j });
      });
    });
    r.on('error', e => resolve({ ok: false, status: 502, error: 'Claude request failed: ' + e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ ok: false, status: 504, error: 'Claude request timed out.' }); });
    r.write(payloadStr); r.end();
  });
}

// One structured call: system + user in, schema-validated object out.
// Returns { ok, data } or { ok: false, status, error }.
async function jsonCall({ system, user, schema, maxTokens = 3000, model = DEFAULT_MODEL, timeoutMs = 90000 }) {
  const key = apiKey();
  if (!key) return { ok: false, status: 503, error: 'ANTHROPIC_API_KEY is not set in Railway.' };
  const payload = JSON.stringify({
    model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema } },
  });
  const out = await _messages(key, payload, timeoutMs);
  if (!out.ok) return out;
  try {
    const txt = (out.json.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    return { ok: true, data: JSON.parse(txt), model };
  } catch {
    return { ok: false, status: 502, error: 'Could not parse the model output as JSON.' };
  }
}

module.exports = { jsonCall, apiKey, DEFAULT_MODEL };
