# Email Reply Assistant — vendored from Gabe's repo

The intelligence lives in `system-prompt.txt` (rules, voice templates, locked phrases, product facts) and `product-links.json` / `product-specs.json` (product → spec PDF + YouTube overview + scraped specs). Both are copied verbatim from:

    https://github.com/gabewhite438/whisperroom-reply-assistant

These files change frequently in Gabe's repo. **To update**, copy the latest versions in:

    cp ../../whisperroom-reply-assistant/system-prompt.txt .
    cp ../../whisperroom-reply-assistant/product-links.json .
    cp ../../whisperroom-reply-assistant/product-specs.json .

Then commit with a one-line "sync assistant from upstream" message and note the upstream commit SHA in the commit body so the source point is recoverable.

## What lives here vs. in quote-server.js

- `assistant/email-reply.html` — frontend port of Gabe's `template.html`. Strips the API-key UI (key is server-side here) and the "Recent Leads from HubSpot" picker (paste-only flow per Benton's call). Keeps Gabe's post-processing (em-dash scrub, URL force-injection, intro-line replacement) intact.
- `quote-server.js` route `POST /api/email-reply` — server-proxy to Anthropic so the key is never in the browser.
- `quote-server.js` route `GET /email-reply` — serves the HTML with `__PRODUCT_LINKS__` injected at request time.

## Env var

`ANTHROPIC_API_KEY` must be set in Railway (staging + prod). Without it the endpoint returns a clear error and the UI shows a config message.
