// Changelog page template — extracted from quote-server.js
// Returns the fully rendered HTML for /changelog.

module.exports = function renderChangelog() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Changelog — WhisperRoom</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='%231a1a1a'/><text x='50%25' y='56%25' dominant-baseline='middle' text-anchor='middle' font-size='18'>📝</text></svg>">
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root{--bg:#0f0f0f;--surface:#1a1a1a;--surface2:#222;--border:#2a2a2a;--orange:#ee6216;--text:#e8e8e8;--muted:#888;--green:#22c55e;--red:#ef4444;--yellow:#f59e0b;--blue:#3b82f6;}
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;}
  .topbar{display:flex;align-items:center;justify-content:space-between;padding:0 20px;height:52px;background:#1a1a1a;border-bottom:1px solid rgba(255,255,255,.1);position:sticky;top:0;z-index:100;}
  .logo{font-family:'Syne',sans-serif;font-size:18px;font-weight:800;color:#f0ede8;text-decoration:none;}.logo span{color:#e8531a;}
  .back{font-size:11px;font-weight:700;color:var(--muted);text-decoration:none;padding:5px 10px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:6px;letter-spacing:.05em;text-transform:uppercase;}
  .main{max-width:860px;margin:0 auto;padding:32px 24px;}
  h1{font-family:'Syne',sans-serif;font-size:24px;font-weight:800;margin-bottom:4px;}h1 span{color:var(--orange);}
  .subtitle{font-size:12px;color:var(--muted);margin-bottom:32px;}
  .version-block{margin-bottom:28px;border:1px solid var(--border);border-radius:10px;overflow:hidden;}
  .version-header{padding:12px 18px;background:var(--surface);display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--border);}
  .version-num{font-family:'Syne',sans-serif;font-size:15px;font-weight:800;color:var(--orange);}
  .version-date{font-size:11px;color:var(--muted);}
  .version-tag{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;padding:2px 7px;border-radius:4px;margin-left:auto;}
  .tag-fix{background:rgba(59,130,246,.15);color:var(--blue);}
  .tag-feature{background:rgba(34,197,94,.12);color:var(--green);}
  .tag-logging{background:rgba(238,98,22,.12);color:var(--orange);}
  .tag-ui{background:rgba(168,85,247,.15);color:#a855f7;}
  .version-body{padding:14px 18px;background:var(--surface);}
  .change-item{display:flex;gap:10px;padding:5px 0;border-bottom:1px solid var(--border);font-size:13px;line-height:1.5;}
  .change-item:last-child{border-bottom:none;}
  .change-type{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;padding:2px 6px;border-radius:3px;white-space:nowrap;height:fit-content;margin-top:2px;}
  .ct-fix{background:rgba(59,130,246,.15);color:var(--blue);}
  .ct-add{background:rgba(34,197,94,.12);color:var(--green);}
  .ct-log{background:rgba(238,98,22,.12);color:var(--orange);}
  .ct-ui{background:rgba(168,85,247,.15);color:#a855f7;}
  .ct-security{background:rgba(245,158,11,.12);color:var(--yellow);}
</style>
</head>
<body>
<div class="topbar">
  <a href="/deals" class="logo">Whisper<span>Room</span> — Changelog</a>
  <a href="/admin-log" class="back">← Admin Log</a>
</div>
<div class="main">
  <h1>Patch <span>Notes</span></h1>
  <div class="subtitle">Full history of changes to the WhisperRoom sales tool</div>

  ${[
    {
      v:'1.72.36', date:'June 7, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Top-Down Layout: WhisperRoom-styled visuals.** Panels now read like the real product instead of color-coded blocks: all walls are booth-dark, the door is the one orange accent (WR brand), vent slots get an intake/exhaust duct icon, cable slots get small passage holes, window slots show a lighter glass inset. The actual <b>ventilation system protrudes outside the back wall</b> as a small assembly w/ an orange RFU dot (mirrors the spec-sheet diagrams). DRFRM slots get a <b>door swing arc</b> drawn into the interior so the rep can sanity-check L/R hinge at a glance. Interior gets a subtle foam-pattern floor. Whole SVG sits on a soft gradient with a drop shadow, like the 2023 spec sheets.'},
      ]
    },
    {
      v:'1.72.35', date:'June 7, 2026', tag:'log',
      changes:[
        {t:'log', d:'**Dev log: weight-reconciliation oracle captured.** Benton noted the sum of all PL weights across booths should equal the quote weight. Today there\'s no multi-booth grand total on the PL, and PL=net vs quote=gross (off by pallets × 144). Tomorrow: add a multi-booth grand total + a Gross line using PALLETS_PER_MDL.'},
      ]
    },
    {
      v:'1.72.34', date:'June 7, 2026', tag:'log',
      changes:[
        {t:'log', d:'**Dev log: closeout of the June 7 session (28 versions).** No app change — refreshed the internal DEVLOG to reflect the full final state: PL Phase 2 complete (viewer redesign, 13 feature-sub rules, hinge + foam swaps wired from the quote, Top-Down Layout tab with 3 booths seeded, pre-commit hook, 40" WA narrow swap via the Z02 bundle). Tomorrow: CP-generated PLs to unblock ADA / Studio Light / HX, plus the remaining 22 booth layouts.'},
      ]
    },
    {
      v:'1.72.33', date:'June 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Top-Down Layout: +2 booths.** MDL 4242 S (3.5′×3.5′ square, 4×40″ walls) and MDL 4848 S (4′×4′ square, 4×46″ walls) added to <code>lib/pl-data/booth-layouts.json</code>. Their E variants pick up the same layout via the variant fallback (4242 E → 4242 S, etc.). Rectangular booths (4260, 4872 already done, 7272, etc.) need a per-MDL digitization pass against the spec sheets — those slot grids are non-trivial and going one at a time tomorrow alongside the CP-generated PLs.'},
      ]
    },
    {
      v:'1.72.32', date:'June 7, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Top-Down Layout: narrow slot now flips 22″ → 19″ when WA Door is on.** Layout slots used to pin to a single wall family (e.g. <code>STDWL22</code>), so when WA swapped one C111 → C112 (STDWL19) the placer\'s regex didn\'t match and C112 fell out of the wall pool. Slots now carry a <code>families</code> array — N-narrow and S-narrow accept both <code>STDWL22</code> and <code>STDWL19</code>; S-wide accepts both <code>STDWL46</code> and <code>WA STDDRFRM</code>. The SVG renders at the placed panel\'s real width via <code>panelInteriorWidth()</code>, so the narrow slot visually shrinks from 22″ to 19″ when WA fires.'},
      ]
    },
    {
      v:'1.72.31', date:'June 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Packing List now reads the quote\'s hinge + foam.** The customer\'s accepted hinge/foam preference (or the rep\'s preference if not yet accepted) flows straight from the saved quote into the PL — no more URL-param dance or "Gray default" surprise on a quote that explicitly picked Blue. Customer-accepted wins, then rep preference, then <code>?hinge=</code>/<code>?foam=</code> for testing. Hinge stored as "Left Hand"/"Right Hand" on the quote, normalized to "Left"/"Right" for the swap rules. Also dropped the now-redundant <b>Config</b> row from the PL viewer — those selectors only updated the label client-side and didn\'t actually re-fetch.'},
      ]
    },
    {
      v:'1.72.30', date:'June 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**WA Door on 40″-wall booths: C10 → Z02 (the STDWL7 / WL16 bundle).** One <code>C10 STDWL16</code> narrow now swaps to one <code>Z02 STDWL7 / WL16</code> — a single pack that ships a 7″ wall + a 16″ wall together (45 lb). Geometry: 40+16 = 49+7 = 56″. The 7″ piece becomes the new narrow on the WA-door side; the 16″ in the same box keeps the booth\'s inventory of 16″ walls unchanged. No inner-shell change on 40″ E/ENV booths (no IEP bundle equivalent exists). Layout SVG now also reports the Z02 slot as 7″.'},
      ]
    },
    {
      v:'1.72.29', date:'June 7, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**WA Door narrow-wall swap: 40″-wall case backed out pending verification.** Benton clarified the adjacent panel on 40″-wall booths "loses 9″" (door grows 40→49), but every 40″-wall booth in the data carries STDWL16 (C10) as its narrow — 16−9 = 7 has no matching wall code, and 40+16 ≠ 49+19. Reverting the speculative 16→19 / 11.5→14.5 swap until a CP-generated PL confirms whether the 16″ wall is removed entirely, the booth physically extends, or another wall absorbs the delta. 46″-wall booths still get the correct 22→19 + 17.5→14.5 swap (geometry conserves cleanly).'},
      ]
    },
    {
      v:'1.72.28', date:'June 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**WA Door: narrow-wall shrink swap, plus layout shows real widths.** The WA doorframe is 49″ (vs. the std 46″/40″), so one of the adjacent narrow walls now flips to absorb the difference: on 46″-wall booths <code>C111 STDWL22 → C112 STDWL19</code> (3″ shrink); on 40″-wall booths <code>C10 STDWL16 → C112 STDWL19</code>. Inner shell on E/ENV follows: <code>K112 IEPWL17.5 → K113 IEPWL14.5</code> (46″) or <code>K09 IEPWL11.5 → K113 IEPWL14.5</code> (40″). Top-Down Layout now reads each placed panel\'s real interior width — Z03/Z04 render as 49″ and C112 as 19″ in the SVG, where before they showed at the slot nominal (46″ / 22″). 40″-wall geometry is wired per the current spec note ("16″ → 19″") and will be re-verified against tomorrow\'s generated PLs.'},
      ]
    },
    {
      v:'1.72.27', date:'June 7, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Top-Down Layout: WA Door now fills the door slot.** The WA doorframe codes (Z03 / Z04 — pack `WA STDDRFRM R/L`) and the WDO window wall (C104 etc.) used to be excluded from the layout\'s wall pool because the placer only matched <code>STDWL{N}</code>-prefixed packs. The pool filter now also accepts <code>WA STDDRFRM</code> (treated as size-agnostic DRFRM since the Z25 / Z120 adapter handles wall-size compatibility), and explicitly excludes the swinging door panels (C113 / C115 / C14 / C15 / C16 / C17 / Z05 / Z06 — they hang inside the doorframe slot, not as their own panel). Result: WA-equipped booths now show the WA doorframe (orange) on the front-wall slot exactly like the STD version did.'},
      ]
    },
    {
      v:'1.72.26', date:'June 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Booth layouts moved to a data file.** Top-down booth layouts (previously hardcoded in <code>packing-list.html</code>) now live in <code>lib/pl-data/booth-layouts.json</code> alongside the BOM data. The PL API response ships only the layouts referenced by the current quote\'s rooms, so the wire payload stays small as more layouts are added. <b>S / E / SNV / ENV variants of the same booth size share one layout</b> — the lookup falls back to the base "MDL XXXX S" entry when the exact variant isn\'t defined. To add a layout, add an entry under <code>layouts</code> in the JSON file; the schema is documented inline in <code>_meta._schema</code>.'},
      ]
    },
    {
      v:'1.72.25', date:'June 7, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Packing List: Top-Down Layout tab (mock, MDL 4872 S only).** Each PL block now has two tabs: 📦 Packing List (the existing table) and 🏗 Top-Down Layout. The Layout tab renders the booth as an SVG floor plan with each wall slot color-coded by component kind (Solid / Vent / Cable / Door / Window). Wall components from the BOM are auto-placed into slots by family (STDWL46 / STDWL22) + preference (vent → back wall, door frame → front wall, solid → sides). Unplaced wall components surface in a warning under the diagram. Other MDLs show a "Layout not yet defined" placeholder until we hand-author their slot grids. Printing forces the PL tab regardless of which is selected.'},
      ]
    },
    {
      v:'1.72.24', date:'June 7, 2026', tag:'log',
      changes:[
        {t:'log', d:'**Dev log: end-of-session writeup for June 7.** No app change — refreshed the internal DEVLOG with today\'s 18-version session: PL viewer redesign, 11 substitution rules (VSS/EFS/MJP/DESK/WDO/WA Door/STEP/RFU/Bass Traps/Ramp/RM), config-driven hinge + foam swaps, and the pre-commit syntax-check hook (which already caught a real bug on its first commit). Tomorrow: verify against Benton\'s CP-generated PLs and unblock ADA / Studio Light / HX.'},
      ]
    },
    {
      v:'1.72.23', date:'June 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Packing List: RM (Roof Mount Ventilation) substitution.** A <code>RM</code> or <code>RM 4260 E</code>-style quote line now rewrites the booth\'s BOM: every ceiling component swaps to its <code>... RM</code> variant (e.g. A06 STD4872CL → A34 STD4872CL RM), and every plain VNT wall swaps to the matching CBL wall of the same size (e.g. C102 STDWL46 VNT → C117 STDWL46 CBL). On E / ENV booths the inner shell follows the same swap — I06 → I30 (IEP ceiling), K102 → K117 (IEP wall). Wall sizes without a CBL counterpart (STDWL16, IEPWL11.5) silently stay VNT — data gap, not a bug. VNT NV variants are intentionally NOT swapped (no CBL NV exists; defer SNV/ENV+RM until Benton confirms).'},
      ]
    },
    {
      v:'1.72.22', date:'June 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Packing List: foam color is now a real component swap.** Picking a non-Gray foam in the PL header rewrites the booth\'s foam row (E01 / E02 / E03 in the base BOM) to the matching colored variant — Purple (PUR: E04 / E05 / E06), Orange (OR: E07 / E08 / E09), Burgundy (BUR: E10 / E11 / E12), or Blue (BL: E13 / E14 / E15). Foam dropdown options corrected to the five real colors (Gray, Purple, Orange, Burgundy, Blue) — old list had Beige / Black which aren\'t real and was missing Purple / Orange.'},
      ]
    },
    {
      v:'1.72.21', date:'June 7, 2026', tag:'feature',
      changes:[
        {t:'ui', d:'**Packing List: RAMP rule now matches bare <code>RAMP</code> too,** not just <code>WA RAMP</code>. Both feed the same 3-box ramp kit (Z62 + Z63 + Z64). ADA will cascade through this rule when that lands. <code>RAMP SYS</code> still stays unmapped.'},
      ]
    },
    {
      v:'1.72.20', date:'June 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Packing List: WA RAMP (3-box ramp system).** A <code>WA RAMP</code> line on a quote now adds the three-box ramp kit to the PL: <b>Z62</b> (RAMP WITH ADAPTER, 32 lb) + <b>Z63</b> (2 MIDDLE RAMPS, 42 lb) + <b>Z64</b> (3 LOWER RAMPS, 37 lb). Quote-line qty multiplies all three through. Matches rows 26–28 of the ENT &amp; Allergy reference PL. Bare <code>RAMP</code> and <code>RAMP SYS</code> stay unmapped pending tomorrow\'s verification.'},
      ]
    },
    {
      v:'1.72.19', date:'June 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Packing List: Bass Traps substitution.** A <code>BASS TRAPS</code> line on a quote adds one <b>E16 (BASS TRAP 2 W/ VELCRO, 5 lb)</b> row to the PL — each E16 pack contains 2 traps. Quote-line qty multiplies through, so Practice / Recording presets that bump BASS TRAPS to qty 3 produce 3 E16 rows (6 traps), and Drum presets at qty 4 produce 4 (8 traps). Singular "BASS TRAP" also matches; <code>BASS TRAP 2</code>-style SKU strings do not (left unmapped).'},
      ]
    },
    {
      v:'1.72.18', date:'June 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Packing List: RFU substitution (additive).** An explicit <code>RFU</code> line on a quote now adds one extra <b>F14 (REMOTE FAN UNIT, 5 lb)</b> row to the PL — on top of whatever the base BOM already includes (most booths ship with one by default). Useful for replacement RFUs ordered for existing booths or doubling up. Exact match only.'},
      ]
    },
    {
      v:'1.72.17', date:'June 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Packing List: STEP substitution.** A <code>STEP</code> line on a quote now adds one <b>S01 (EXTERIOR STEP, 30 lb)</b> row to the PL. Exact-match only — bare "STEP" with no suffix; anything else stays in the unmapped flag.'},
      ]
    },
    {
      v:'1.72.16', date:'June 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Packing List: hinge swap now actually swaps components.** Base BOMs ship right-default. When the room hinge is Left, the PL now flips: <code>C113↔C115</code> (STD door 30), <code>C114↔C116</code> (STDWL46 DRFRM), <code>C14↔C15</code> (STD door 24), <code>C07↔C08</code> (STDWL40 DRFRM), <code>C16↔C17</code> (generic door). On E / ENV booths the inner shell flips too: <code>M01↔M02</code> (small-wall IEPDOOR), <code>K114↔K115</code> (46"-wall IEPDOOR), and inswing variants <code>L02↔L03</code> / <code>L04↔L05</code>. Bare jambs (L01, K116) are non-handed and stay put. Runs <i>after</i> WA Door so WA components — which already pick their own L/R from hinge — don\'t get double-flipped. Net weight unchanged (L/R pairs have identical weights).'},
      ]
    },
    {
      v:'1.72.15', date:'June 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Packing List: WA Door (Wide Access) substitution.** Quote lines like <code>WA UPG STD 40</code> / <code>STD 46</code> / <code>ENH 40</code> / <code>ENH 46</code> (and bare <code>WA UPG</code>) now swap the standard door + doorframe in the BOM for the WA equivalents: <b>Z03/Z04</b> (R/L door frame) + <b>Z05/Z06</b> (R/L door), plus a wall-size-specific adapter — <b>Z25</b> for 40" walls or <b>Z120</b> for 46" walls. L/R picked from the room hinge selector. On ENH booths (E / ENV), also swaps the inner-shell door + jamb (<b>Z10/Z11</b> + <b>Z09</b>) and adds <b>Z19</b> (WAJMBAD/IEPSSMID). Correctly handles both inner-door families: small-wall booths (M01/L01) and 46"-wall booths (K114/K116). 43" wall booths leave the line in the unmapped flag (no WA exists for that wall size).'},
      ]
    },
    {
      v:'1.72.14', date:'June 7, 2026', tag:'log',
      changes:[
        {t:'log', d:'**Pre-commit syntax check added.** New `scripts/check-syntax.js` runs `node --check` on every staged `.js` file and smoke-tests `templates/changelog.js` and `lib/packing-list.js` (require + invoke). Wired as `.git/hooks/pre-commit` (and tracked under `scripts/git-hooks/` so a fresh clone can install via `scripts/install-hooks.sh`). Would have caught the v1.72.11 deploy crash before push. `/bump` now runs the check before reporting back, and `CLAUDE.md` documents the workflow.'},
      ]
    },
    {
      v:'1.72.13', date:'June 7, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Hotfix: deployment crash.** The v1.72.11 / 1.72.12 changelog entries had an over-escaped apostrophe inside a single-quoted JS string, which Node parsed as an early string terminator and threw <code>SyntaxError: Unexpected identifier</code> at startup. Both staging and prod containers had been crash-looping since 1.72.11. Apostrophe re-escaped correctly. Restarts cleanly.'},
      ]
    },
    {
      v:'1.72.12', date:'June 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**WDO rule now handles double-shell (E / ENV) booths.** When a window is on an E-variant booth, the PL also swaps the matching inner IEPWL{N} wall (inner size = outer − 4.5: STDWL40 ↔ IEPWL35.5, STDWL46 ↔ IEPWL41.5, STDWL43 ↔ IEPWL38.5). The smallest WDO in each family (e.g. WDO 2630 on 35.5, WDO 3230 on 41.5) uses a single-piece bundle (K02 / K103). Larger WDOs ship as TOP + BOT (e.g. WDO 2648 → K05 top + K06 bottom). S / SNV (single-shell) booths are unchanged. Two-window quotes generate two BOT components.'},
      ]
    },
    {
      v:'1.72.11', date:'June 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Packing List: WDO (window) substitution.** A <code>WDO 3236 S</code> line on the quote now <b>swaps one standard wall component</b> in the booth\'s BOM for the matching window-wall variant (e.g. on MDL 4872 S: C101 STDWL46 → C104 STDWL46 WDO3236). Defaults to the booth\'s primary (longest) STDWL{N} wall; explicit overrides like <code>WDO 43" 2636 S</code> use the named wall size. Multiple windows (or qty &gt; 1) swap one wall each. If the booth has no matching standard wall to swap (e.g. ADA already replaced it), the WDO line stays in the unmapped-features flag for manual adjustment instead of silently adding extras.'},
      ]
    },
    {
      v:'1.72.10', date:'June 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Packing List: MJP and DESK substitution rules.** <code>MJP</code> on a quote now injects an <b>F09 (MULTI JACK PANEL)</b> row on the PL. <code>Office Desk S</code> → <b>S02 (OFFICE DESK SMALL)</b>; <code>Office Desk L</code> → <b>S03 (OFFICE DESK LARGE)</b>. MJP follows a "constant 1 per quote line" rule (unlike VSS/EFS which scale with vent count). Companion hardware (<code>MJP ADPT</code>, <code>MJP EXT</code>) is intentionally NOT treated as MJP and still flags in the unmapped-features list. Quote-line qty multiplies through (e.g. MJP qty 3 → three F09 rows). Internally, the rule registry was refactored to an extensible predicate-based form so the remaining features (windows, ADA, hinge) can plug in cleanly.'},
      ]
    },
    {
      v:'1.72.9', date:'June 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Packing List: VSS and EFS feature substitution.** The PL generator now turns <code>VSS &lt;size&gt;</code> and <code>EFS &lt;size&gt;</code> quote line items into the actual <b>F02 (Ventilation Silencing System)</b> and <b>F03 (Exterior Fan Silencer)</b> component rows on the PL — one per vent set in the booth (F01 qty). Bare <code>VSS</code> / <code>EFS</code> with no size suffix counts as exactly one. Feature qty &gt; 1 on the quote multiplies through. Matched features no longer appear in the orange "optional features" flag box.'},
      ]
    },
    {
      v:'1.72.8', date:'June 7, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Packing List MDL line abbreviates feature names** to match the printed PL. Quote line items like <code>EFS 4872</code>, <code>VSS 4872</code>, <code>WDO 3236 S</code>, <code>Office Desk S</code>, <code>ADA 7272 S</code> now render as <code>EFS / VSS / WDO 3236 / DESK / ADA</code> in the booth title. Internal hardware/upgrades (HEPA, HX, AP, CP, EFP, cable upgrades, vent set, foam, etc.) are hidden from the title — they still appear in the BOM rows below. Duplicates are deduped.'},
      ]
    },
    {
      v:'1.72.7', date:'June 7, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Packing List layout now closely mirrors the real printed PL.** Each booth is its own one-page PL: centered WhisperRoom logo with <b>SOUND ISOLATION ENCLOSURES</b> tagline, editable date top-right, and a deal reference top-left. Below that, the <b>MDL line</b> (booth + its options, e.g. <code>MDL 4872 S / ADA / EFS / VSS / MJP / WDO 3236 / DESK</code>) and the <b>Totals box</b> (Cubic Feet / Pounds / Cubic Meters / Kilograms) on the left, with a big <b>PACKING LIST</b> title and an editable <b>S/N</b> field on the right. The "Heads up" banner is gone. Multi-room quotes paginate one booth per page. S/N and date persist in browser per-quote.'},
      ]
    },
    {
      v:'1.72.6', date:'June 7, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Packing List redesigned to match the printed PL layout.** The viewer now mirrors the shop-floor PL: real WhisperRoom logo + address header, Customer / Project info block, and a per-room table with grouped <b>Length / Width / Thickness / Weight</b> columns (Inches + Mtrs, Pounds + Kilograms), then <b>Code · Part # · Package Contents</b>. The <b>Quantity column is gone</b> — each physical item is its own row, so a BOM entry of qty 4 prints as four rows. Overall feel matches the Vendor PO / Quote docs (white card, orange accent).'},
      ]
    },
    {
      v:'1.72.5', date:'June 5, 2026', tag:'log',
      changes:[
        {t:'log', d:'**Dev log: end-of-session writeup for June 5.** No app change — refreshed the internal DEVLOG (Current focus + full session recap of today: Packing List generator, /weights tooling, Duplicate/Add Pallet, QB Activity, Drive PDF fix, pallet reductions).'},
      ]
    },
    {
      v:'1.72.4', date:'June 5, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Freight: lowered pallet counts on several large booths.** After re-checking real skid heights, these models now ship on fewer pallets &mdash; the short skid is consolidated onto a taller one: <b>MDL 10284, 96192, 102168, 102186</b> and their No-Vent (NV) twins. <b>MDL 102126</b> pallet 3 footprint was also corrected. Freight quotes, the Quote Weight box, the packing-list/weights tools, and order processing all reflect the new counts.'},
      ]
    },
    {
      v:'1.72.3', date:'June 5, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Google Ads Improvement Engine is now brand- and impression-share-aware.** The Budget Reallocation board used to tell you to <em>increase</em> any high-ROAS campaign — including branded ones. But branded paid clicks mostly re-buy demand your organic listings already win for free, so that ROAS overstates the real lift. Branded winners now land in a new <strong>▽ Test Pull-Back</strong> column (test trimming bids and watch total paid+organic revenue), and <strong>▲ Increase</strong> is reserved for non-branded campaigns that genuinely lose impressions to budget (high budget-lost impression share) at a strong return. Each card now shows its impression share and a one-line reason for the call.'},
        {t:'add', d:'**Attribution-gap campaigns are flagged, not punished.** Ecommerce / Shopify / remarketing campaigns that convert outside HubSpot used to look like “$0 revenue → cut it.” They now go to a separate <strong>⌕ Investigate</strong> column so you verify in Google Ads / Shopify before pulling spend.'},
        {t:'add', d:'**Ad diagnoses now use real Quality Score, not guesses.** Each campaign’s keyword Quality Scores roll up to pinpoint the actual weak link — below-average <em>expected CTR</em> → Ad Copy Opportunity, low <em>ad relevance</em> → restructure the ad group, low <em>landing-page experience</em> → Landing Page Opportunity — instead of inferring it from CTR vs. conversion rate.'},
        {t:'add', d:'**One-click AI ad rewrites.** Ad Copy opportunities now have a <strong>✨ Generate AI rewrites</strong> button that calls Claude (back end from v1.72.2), seeded with that campaign’s weakest-scoring search terms, and returns ready-to-test headlines and descriptions in WhisperRoom voice. Local quick-drafts still show instantly as a fallback.'},
      ]
    },
    {
      v:'1.72.2', date:'June 5, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Google Ads data, deeper (back end).** The Ads sync now also pulls <strong>Quality Score</strong> and its three components (expected CTR, ad relevance, landing-page experience) per keyword, and <strong>Impression Share</strong> + lost-impression-share (budget vs. rank) per campaign. This is the data that lets the dashboard say <em>why</em> a campaign underperforms — bad ad copy vs. wrong landing page vs. needs more budget — instead of guessing. (Run a Sync to populate it; the upcoming Growth Engine update will surface it.)'},
        {t:'add', d:'**AI ad-copy rewrites (back end).** New endpoint that uses Claude to rewrite a campaign’s ad copy, grounded in the actual search terms people convert on, in WhisperRoom voice (no “soundproof”, no em dashes, within Google’s character limits). The Growth Engine’s Google Ads Improvement Engine will call this so a high-spend/low-CTR campaign comes with real, ready-to-test headlines and descriptions.'},
      ]
    },
    {
      v:'1.72.1', date:'June 5, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Add Pallet default size is now 90 × 47 × 40 in** (was 48 × 40 × 48) — matches a typical WhisperRoom skid, still editable per pallet.'},
      ]
    },
    {
      v:'1.72.0', date:'June 5, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Quote Builder: add extra pallets to a quote.** When a quote has a booth plus a lot of loose components that need their own skid, hit <b>+ Add Pallet</b> in the Quote Weight box and set its L &times; W &times; H. Extra pallets flow into the pallet count, the ABF freight quote (total weight redistributes across all skids), and the International Shipping request &mdash; and they save with the quote and carry into order processing. Booth pallets are still auto-counted as before.'},
      ]
    },
    {
      v:'1.71.3', date:'June 5, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**“Why this page?” explanation on every Ideal Page recommendation.** Next to each ideal commercial page you’ll now see a small <strong>ⓘ Mapped / Matched / Category</strong> tag — hover it to see exactly how that page was chosen: an explicit commercial page mapping (your site architecture), a token/intent match against your commercial pages, or the /all-booths category fallback. When the correct page already ranks, it notes that Search Console confirms it. Makes the picks easy to trust and validate.'},
        {t:'add', d:'**One source of truth for ideal pages.** The corrected Commercial Page Mapping now drives the Ideal Page everywhere — Revenue Opportunity Engine, Opportunity Action Engine, Target Page Analysis, and the Growth Engine all read the same mapping, so the dashboards can’t disagree on which page should rank for a keyword.'},
      ]
    },
    {
      v:'1.71.2', date:'June 5, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Fixed the “ideal page” always defaulting to /products/drum-booth.** The Target Page Analysis (in Search Console, the Action Engine, and Growth Engine) was picking the ideal commercial page by keyword overlap — but the word “booth” appears in nearly every product URL, so every booth query tied and the tie broke to the highest-traffic booth page (drum-booth). It now uses a **Commercial Page Mapping** of intent → the correct page from your site architecture: recording → /application/recording, podcast → /application/broadcasting, audiology → /application/audiology, voice over → /application/voice-over, office → /products/office-booth, drum → /products/drum-booth, and generic soundproof/sound booth → /all-booths. (The mapping is easy to edit if a page moves.)'},
        {t:'add', d:'**Page-type aware.** Pages are now tagged by type — Product, Application, Category, Package, Blog, Home — so you can see at a glance what kind of page is ranking vs. what should. And when the correct commercial page is already ranking, it’s marked ✓ Right page and diagnosed for CTR / Ranking / Content / Authority instead of being mislabeled a wrong-page problem.'},
      ]
    },
    {
      v:'1.71.1', date:'June 5, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Duplicate Quote button moved into the Customer Information header.** It now sits at the top-right of section 1 instead of up by + New Quote.'},
      ]
    },
    {
      v:'1.71.0', date:'June 5, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Quote Builder: &ldquo;Duplicate Quote&rdquo; button.** Next to <b>+ New Quote</b>, hit <b>Duplicate Quote</b>, search any past quote by customer, deal name, or quote number, and pick it &mdash; its line items (product, price, description, qty, weight) copy straight into your current quote, and prices re-verify against the catalog just like opening a quote. Perfect for near-identical orders. (Customer &amp; freight stay as your current quote &mdash; it duplicates the products, not the whole quote, and asks before replacing items you have already added.)'},
      ]
    },
    {
      v:'1.70.2', date:'June 5, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**New “⚡ Growth Engine” tab — a marketing director in a dashboard.** Where the Ad Spend and Search Console tabs report on each channel, Growth Engine answers “if we could only work on 5 marketing actions this month, what should they be?” It fuses Google Ads, Search Console, and HubSpot revenue into one prioritized plan.'},
        {t:'add', d:'**Growth Priorities board** auto-sorts every opportunity into 🎯 Do Now / ⏭ Next / 👀 Monitor / 🚫 Ignore (so blog/informational topics fall away and booth-buying opportunities rise). **“If you do 5 things this month” summary** with the total revenue upside + spend savings. **Opportunity Queue** ranks SEO + Paid opportunities by a unified Growth Score (revenue × commercial intent / paid quality × confidence × proven revenue) with the root-cause diagnosis for each.'},
        {t:'add', d:'**Target Page Analysis, Google Ads Improvement Engine, and Budget Reallocation.** See whether the right page is ranking for each keyword; get per-campaign recommendations (rewrite ads on high-spend/low-CTR, check the landing page on high-CTR/low-conversion, scale strong-ROAS campaigns, cut wasted spend) with suggested ad headlines/descriptions; and a “where should the next $1,000 go” board grouping campaigns into Increase / Maintain / Reduce / Pause by return on ad spend.'},
      ]
    },
    {
      v:'1.70.1', date:'June 5, 2026', tag:'fix',
      changes:[
        {t:'add', d:'**Internal /weights: click any model to see its pallet dimensions.** Click a row to expand it and view every pallet&rsquo;s L &times; W &times; H (with cubic feet and the longest dimension per skid). Makes it easy to judge whether a booth can really ship on fewer pallets &mdash; big wall panels need a long skid no matter how light the load is. Also flags when a model&rsquo;s pallet count differs from the dimensions on file.'},
      ]
    },
    {
      v:'1.70.0', date:'June 5, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**QB Activity finder now reads much more like the QuickBooks audit log.** Each record shows richer detail pulled from data we already fetch: status (<b>Paid / Open / Overdue</b>), an <b>edited&nbsp;N&times;</b> indicator, linked transactions, and memos. The action label now matches QB&rsquo;s wording (&ldquo;<b>Edited</b>&rdquo; instead of &ldquo;Updated&rdquo;).'},
        {t:'add', d:'**New event types surfaced: Emailed, Attachments, and Deletes.** &ldquo;<b>Emailed</b>&rdquo; rows appear when an invoice/estimate/receipt was sent in the range; &ldquo;<b>Attachment</b>&rdquo; rows come from QuickBooks&rsquo; Attachable records; and <b>deleted</b> records now show via Change Data Capture (last ~30 days only — a QBO limit). New <b>Event types</b> filter chips (Created / Edited / Emailed / Attachments / Deleted) sit alongside the record-type filter.'},
        {t:'log', d:'**Still no &ldquo;who,&rdquo; and not per-edit history** — QuickBooks doesn&rsquo;t expose either through its API. Each record still shows as one row at its latest state (plus separate Emailed/Attachment/Deleted events), not a separate row for every individual edit. For the user and full history, open the record&rsquo;s Audit History in QBO.'},
      ]
    },
    {
      v:'1.69.2', date:'June 5, 2026', tag:'fix',
      changes:[
        {t:'add', d:'**Internal /weights: new Net/Pallet column.** Shows net (BOM) weight &divide; pallet count for each model, measured against the 1,800 lb-per-pallet max. Color-coded &mdash; red over the max, amber when close, green with a &darr; hint when the weight alone would allow fewer pallets. New summary cards count models over the max and models that could potentially drop a pallet. (The hint is weight-only; pallet count is also limited by panel size/volume, so any reduction is a manual judgment call.)'},
      ]
    },
    {
      v:'1.69.1', date:'June 5, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Smarter SEO diagnosis — stops defaulting to “rewrite title/meta.”** The Action Engine now figures out the <em>real</em> constraint for each keyword instead of assuming CTR. Six opportunity types: <strong>CTR</strong> (ranking is fine, clicks are weak), <strong>Ranking</strong> (clicks fine, position weak), <strong>Content</strong> (strong page, thin topical coverage), <strong>Authority</strong> (relevant page, out-muscled by competitors), <strong>Landing Page</strong> (the wrong page is ranking), and <strong>Missing Page</strong> (no commercial page exists) — each with its own tailored action.'},
        {t:'add', d:'**CTR judged against WhisperRoom’s own benchmark, not a generic curve.** Modern results pages (AI Overviews, shopping, Reddit, video) mean a #6 ranking rarely gets the “textbook” 4-5% CTR. The dashboard now computes your <em>own</em> median CTR by position from your commercial booth keywords and flags CTR problems relative to that — so it stops over-flagging CTR. Revenue estimates were recalibrated to your real top-3 CTR too.'},
        {t:'add', d:'**Target Page Analysis: “is the right page ranking?”** Every keyword now shows the real ranking page vs the ideal commercial page with a clear verdict — ✓ Right page, ✗ Wrong page, or ⊘ No commercial page — answered *before* recommending an action. So “recording booth” ranking on a blog post gets a “strengthen /application/recording + link from the blog” plan, not a blog title rewrite.'},
      ]
    },
    {
      v:'1.69.0', date:'June 5, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Packing Lists: &ldquo;View Packing List&rdquo; button on the Quote Builder (next to Build Assembly Manual).** Generates the packing list for the saved quote in a new tab &mdash; one section per room. It reads your quote line items, treats each <b>MDL&hellip;</b> line as a booth and the lines under it as that booth&rsquo;s options, and builds the booth&rsquo;s full component list (codes, descriptions, quantities, weights, dimensions, pack codes) straight from the packing-list data &mdash; weights are exact. Each room defaults to <b>Left hinge / Gray foam</b> (change per room), and you can edit quantities, remove, or add component lines before printing. <b>In progress:</b> the optional-feature component swaps (windows, EFS, VSS, studio light, ADA, HX, etc.) are not auto-applied yet &mdash; those quote lines are listed under each room as a reminder to add their parts manually until the feature rules are finished. This is the first piece of the packing-list system replacing the old Excel/VBA workflow.'},
      ]
    },
    {
      v:'1.68.0', date:'June 5, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Accounting &rarr; new &ldquo;QB Activity&rdquo; tab: a fast finder for what changed in QuickBooks.** Pick a date range and the record types (invoices, payments, bills, expenses, credit memos, journal entries, deposits, customers, vendors, and more), then type to filter instantly by name, doc number, type, or amount. Every row links straight to that record in QuickBooks. Built because QuickBooks&rsquo; own audit-log search is painful. <b>Note:</b> QuickBooks does not expose the audit log&rsquo;s &ldquo;who&rdquo; through its API, so this shows <b>what</b> changed and <b>when</b> (and links you there), but not which user did it, and it does not include deleted records &mdash; open the record in QuickBooks for its per-transaction Audit History.'},
      ]
    },
    {
      v:'1.67.11', date:'June 5, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**SEO engine now uses the REAL page Google ranks for each query — no more guessing.** We pull query→page data straight from Search Console, so the Revenue Opportunity table shows the actual <strong>Ranking Page</strong> for each keyword (with a Commercial / Blog / Other tag) plus that page’s clicks, impressions, CTR, and position. The Action Engine uses this to give much smarter advice.'},
        {t:'add', d:'**Page-strategy recommendations.** Each opportunity now reads the real ranking page and recommends the right move: if a <strong>commercial page already ranks</strong> → optimize it (title/meta or content + links). If a <strong>blog post ranks but a sales page exists</strong> → <em>don’t</em> rewrite the blog — strengthen the commercial page and add internal links from the blog to it (with the exact pages to link from). If <strong>no commercial page exists</strong> → flagged as a Landing Page Opportunity with a full brief to build one. Each card shows “Ranks today → Target” so you can see exactly which page to act on.'},
      ]
    },
    {
      v:'1.67.10', date:'June 5, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Weights: refreshed MDL 102168 ENV after its packing list was corrected** (net 4455 → 4303 lb).'},
      ]
    },
    {
      v:'1.67.9', date:'June 5, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**“Commercial Booth Opportunities” mode for the SEO engine — focused on selling booths.** A new toggle (🎯 Commercial Booth / All Organic) on the Revenue Opportunity Engine, Executive Summary, and Action Engine. It scores every organic query for booth-buying intent (0-100) based on product/category terms (booth, soundproof, vocal, recording, podcast, audiology, audiometric, hearing test, office, drum, broadcast, isolation…), buying terms (cost, price, quote, package, for sale, supplier, portable…), whether you also run it in Google Ads, paid conversions, and whether it maps to a product/category page — and heavily downweights general blog topics (microphone tips, music theory, ear training, record players, etc.). That intent is blended into the ranking so booth-selling keywords outrank high-traffic blog terms.'},
        {t:'add', d:'**Commercial Booth is the default**, so the top recommendations now answer “what should we do next to sell more booths?” instead of being dominated by informational blog traffic. A new <strong>Intent</strong> column shows each query’s 0-100 booth-buying score. <strong>All Organic</strong> stays one click away for content and traffic research.'},
      ]
    },
    {
      v:'1.67.8', date:'June 5, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Weights: refreshed MDL 102168 SNV after its packing list was corrected** (net 2449 → 2367 lb).'},
      ]
    },
    {
      v:'1.67.7', date:'June 5, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Weights: refreshed MDL 102186 ENV after its packing list was corrected** (net 4883 → 4731 lb).'},
      ]
    },
    {
      v:'1.67.6', date:'June 5, 2026', tag:'feature',
      changes:[
        {t:'fix', d:'**Search Console totals now match Google.** The GSC tab’s headline Clicks / Impressions / CTR / Avg Position cards and the Organic Performance chart were summing the per-query data, which Google trims (it hides rare “anonymized” searches), so our totals read far below Search Console’s own “Total clicks.” We now pull the un-trimmed daily totals straight from Google for those headline numbers, so they line up with what you see in Search Console. The branded split is labeled “of named queries,” since that can only be measured on the searches Google shows us.'},
        {t:'add', d:'**Revenue Opportunity Engine.** A ranked table that answers “if we improve one keyword’s ranking this month, which one earns the most added revenue?” It blends your Search Console rankings, the matching Google Ads conversion rate for each search term, and your HubSpot closed-won revenue into a single Revenue Opportunity dollar estimate and a 0-100 score, focused on queries ranking in positions 4-15.'},
        {t:'add', d:'**Opportunity Action Engine + “What to do next” summary.** For each top keyword it diagnoses the single biggest bottleneck — Ranking, CTR, or Content Gap — and gives a recommended action, priority, estimated revenue impact, confidence, and reasoning. A plain-English executive summary at the top of the tab surfaces the top 3-5 moves and the total upside. Queries whose paid version converts above your account average are flagged ⭐ Commercially validated.'},
        {t:'add', d:'**Execution Assistant: every recommendation comes with the actual work.** A “Show the work” panel on each action generates the next step — 3 title-tag + 3 meta-description drafts for CTR fixes (with character counts and one-click copy), a full content brief for content gaps (page type, H1, primary/secondary keywords, real questions to answer, H2 outline), internal-link source pages + a checklist for ranking fixes, and the supporting Google Ads proof for commercially-validated keywords. Secondary keywords, questions, and link sources are pulled from your real Search Console data; copy drafts follow WhisperRoom voice and are labeled drafts to review.'},
      ]
    },
    {
      v:'1.67.5', date:'June 5, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Fix: PDF uploads to Drive failing ("Failed to launch the browser process").** The shipment-tracking poller was opening its own background browser without coordinating with the PDF generator, so when a rep saved a quote at the same time the tracking poller ran, the server tried to open two browsers at once and ran out of room — the PDF upload then failed to launch. All browser work now shares one slot and runs one-at-a-time, so quote/invoice/PO PDF uploads stop colliding with background tracking. (Tracking yields to your PDF, retrying on its next cycle.)'},
      ]
    },
    {
      v:'1.67.4', date:'June 5, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Freight: the two largest models now count pallets correctly.** MDL 102168 and MDL 102186 (S/E/SNV/ENV) were missing from the pallet-count table the order-processing freight step uses, so an order with one of those booths under-counted pallets. Added them (102168 and 102186 each ship on 3 pallets standard / 5 enhanced, matching the quote-builder pallet data). Also fills in their gross weights on the internal weights page.'},
        {t:'fix', d:'**Weights: refreshed MDL 96192 SNV and ENV after their packing lists were corrected.**'},
      ]
    },
    {
      v:'1.67.3', date:'June 5, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**/weights: refreshed with the final rounded packing-list weights.** The net weights now come from the re-pulled base packing lists, where every component weight was rounded to the nearest pound — so all 104 model net weights are clean whole numbers. This is the real reconciliation data; the delta column against the HubSpot price book is now meaningful.'},
      ]
    },
    {
      v:'1.67.2', date:'June 5, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**/weights: NV variants now show pallet counts.** SNV and ENV models had a blank pallet count (and therefore no gross weight) because they are not listed separately in the pallet map. They now inherit their vented base count (SNV uses the S count, ENV uses the E count), since they ship on the same pallets.'},
      ]
    },
    {
      v:'1.67.1', date:'June 5, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Search Console tab: a daily performance chart, just like Google’s.** New <strong>Organic Performance</strong> graph at the top of the GSC tab plots Clicks, Impressions, CTR, and Avg Position over time (click any metric to toggle it, hover any day for exact numbers). Same dual-axis look you get inside Search Console, sitting right next to your closed-revenue data.'},
        {t:'add', d:'**Striking Distance report: the queries you’re about to rank for.** Surfaces searches where you sit at average position 10-20 (page 2) with real impressions. These are the closest to breaking onto page 1, so pushing the page behind one of them up a few spots is the highest-return organic move.'},
        {t:'add', d:'**CTR Opportunity report: pages worth a title rewrite.** Flags page-1 pages whose click-through rate trails what’s normal for their rank (e.g. sitting at #3 but getting clicked like a #8). Each row shows the estimated extra clicks if CTR rose to par, so you can prioritize which titles and descriptions to rewrite.'},
        {t:'add', d:'**Movers report: what changed vs last period.** Compares this window to the one right before it and ranks the biggest organic-click gainers and losers, by query or by page. A quick read on what’s trending up and what slipped.'},
      ]
    },
    {
      v:'1.67.0', date:'June 5, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Internal: hidden /weights reconciliation page.** A back-end tool (admin URL, no nav link) that lists every MDL with its net weight from the packing-list bill-of-materials, pallet count, pallet weight, computed gross, and the current HubSpot price-book weight side by side — with the delta flagged. Used to keep the price-book shipping weights honest against the real PL data.'},
      ]
    },
    {
      v:'1.66.2', date:'June 5, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Opening a quote now silently refreshes line-item weights to the current catalog.** Prices still prompt ("update to current?") since price is what you are quoting — but weights just sync quietly in the background (no popup), so when an order gets processed the shipping weight is accurate. Saves a click and keeps freight numbers right.'},
      ]
    },
    {
      v:'1.66.1', date:'June 5, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Fix: the new "Rebind Quote" button did nothing when clicked.** It called a text-escaping helper that exists in the Quote Builder but not the Deal Hub, so the click handler errored out before the picker could open. Removed the unneeded call — Rebind Quote now opens as intended.'},
      ]
    },
    {
      v:'1.66.0', date:'June 5, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Deal Hub: "Rebind Quote" admin tool.** When a quote gets made under the wrong deal, open the deal, hit **⇄ Rebind Quote** (in the admin button row), pick the quote, search the correct deal, and move it — the quote (and any order tied to it) re-attaches to the right deal and the destination deal opens so you can confirm. (Note: HubSpot line items pushed onto the original deal are not auto-moved; re-push from the Quote Builder if they need to follow.)'},
      ]
    },
    {
      v:'1.65.12', date:'June 4, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Deal Hub payment chip refreshes every 5 minutes** (was 30). The ACH "funds available / clearing / deposited" chip reads a table our poller syncs from HubSpot payments — that sync now runs every 5 min, so a payment shows up much sooner. (Note: the payout *date* itself still comes from HubSpot and can lag the payment regardless.)'},
      ]
    },
    {
      v:'1.65.11', date:'June 4, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**WR PO System: the purple Receive button no longer shows on a draft PO.** It now appears only once the PO is officially created (Create/Download PDF), matching the rest of the draft-vs-created behavior.'},
      ]
    },
    {
      v:'1.65.10', date:'June 4, 2026', tag:'log',
      changes:[
        {t:'log', d:'**WR PO System: Knoxville Corrugated added to the vendor import (67 box items).** Josh cleaned up the Knoxcor spreadsheet, so it is now parsed in — two-line (wrapped) descriptions merged, BOTTOM/TOP box splits handled, and the VSS/IEP renames applied. Brings the bulk importer to 42 vendors / 291 items. Internal supply-chain tooling; no change to the quote builder.'},
      ]
    },
    {
      v:'1.65.9', date:'June 4, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**WR PO System: a PO is now only "officially created" when you press Create/Download PDF.** Picking a vendor under "+ New PO" now starts a hidden **draft** and opens the editor — it no longer shows up in the Vendor Hub list until you generate the PDF, which promotes it to OPEN. Abandon a draft (just close the tab) and nothing clutters the list.'},
        {t:'ui', d:'**Removed the delete (×) button from the PO table.** Delete a PO from the PO itself (the doc page) instead — keeps deletes deliberate.'},
        {t:'ui', d:'**Vendors list: hide the "—" placeholder when a vendor has no contact name** (the cell is just left blank now).'},
      ]
    },
    {
      v:'1.65.8', date:'June 4, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**WR PO System: Payment Terms is now a full-width field.** It was crammed into a 3-column row, making it a small click target next to the wider Freight Terms field. Payment Terms now gets its own full line (in both the PO editor and the Vendor editor) so you can click anywhere on it to edit.'},
      ]
    },
    {
      v:'1.65.7', date:'June 4, 2026', tag:'log',
      changes:[
        {t:'log', d:'**WR PO System: bulk vendor importer (41 vendors, 224 catalog items).** Parsed Josh’s Excel purchase-order files into the vendor catalog — a one-time seed script (`scripts/seed-vendors-from-excel.js`) that adds the remaining suppliers/items alongside the original three. Internal supply-chain tooling; no change to the quote builder.'},
      ]
    },
    {
      v:'1.65.6', date:'June 4, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Deal Hub: clicking a quote now loads it no matter where you click on the row.** Before, only the top-left strip (quote # / date) actually opened the quote — the dollar amount, the model/label, and the whole bottom row were dead zones, so clicks there did nothing and it felt like you had to hunt for the right spot. The click-blocking was only supposed to protect the small View / Copy / Invoice / Process buttons; it was accidentally covering whole rows. Now the entire card is clickable (including the “Load →” hint), and only those buttons are excluded.'},
      ]
    },
    {
      v:'1.65.5', date:'June 4, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Fixed the “New Quote keeps reloading the same customer” loop.** If a contact had an active deal (so the quote auto-linked to it), hitting **New Quote** could snap that same contact and deal right back in — and trying to switch customers got stuck bouncing through the “Quote Already in Progress” box. Cause: clearing the form kicked off a background look-up of the *old* contact’s deals that finished a beat later and re-linked the deal (which then re-filled the contact). New Quote now drops the old contact first and skips that look-up, and a stale look-up can no longer re-link a customer you’ve already moved on from.'},
      ]
    },
    {
      v:'1.65.4', date:'June 4, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Copy Quote Link / View Quote now always point at the right quote.** When you pushed one quote and then opened a *different* one for the same customer (without “Start New Quote”), the Copy Link button could stitch the previously-pushed quote number onto the currently-open quote’s share token — producing a link that was off by one (e.g. `…W-…02` with `…01`’s token) and didn’t work. The shareable link is now built from a single locked source (the saved quote’s number **and** its own token, always set together), never from the editable/predicted number field. If a quote hasn’t actually been pushed yet, the buttons say “Push to HubSpot first” instead of fabricating a link.'},
      ]
    },
    {
      v:'1.65.3', date:'June 3, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Search Console tab: which content actually closes revenue.** The **Organic Pages** table now shows **Leads / Deals / Revenue** next to clicks — it ties each organic landing page to closed-won HubSpot revenue (by matching the contact’s first-touch page), so you can see which blog posts and pages drive real deals, not just traffic. (Best-effort URL match; organic revenue is still channel-level since Google withholds the query.)'},
        {t:'add', d:'**Sortable, paginated GSC tables + a “Hide /blog” filter.** Every column in the **Paid × Organic Overlap**, **Organic Queries**, and **Organic Pages** tables is now click-to-sort, with Prev/Next paging through *all* terms/queries/pages (not just the top 200). The Organic Pages table has a **“Hide /blog” toggle** for a clean non-blog snapshot. Plus the **Organic Leads** and **Organic Closed Rev** cards are now clickable — they pop open the underlying HubSpot contacts / deals.'},
        {t:'add', d:'**Sync GSC honors the selected date range** (14 / 30 / 90 / 180 / 365 days) — pick a range, hit Sync GSC, and it pulls exactly that window.'},
      ]
    },
    {
      v:'1.65.2', date:'June 3, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Search Console data now actually populates (fast).** Added a dedicated **“Sync GSC”** button on the Google Search Console tab that pulls organic data just for the selected date range — so you don’t have to wait on the full 365-day Sync All (where GSC ran dead-last). Also made the organic import **batched** (it was inserting row-by-row over 100k+ daily rows, which crawled) and added a GSC line to the status bar so you can see organic sync status + any errors. Sync All now pulls a lighter 120-day GSC window.'},
        {t:'fix', d:'**Disk-capacity guard on all syncs.** A large organic pull had filled the shared Postgres volume and briefly took the app down. Every sync now checks the database size first and **refuses with a clear message if the DB is near the volume’s limit** — instead of filling the disk. (Volume was also grown 0.5 GB → 5 GB.) Tunable via the `PG_SOFT_LIMIT_MB` env var (default 4500 MB).'},
      ]
    },
    {
      v:'1.65.1', date:'June 3, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Marketing dashboard is now tabbed: “Google Ad Spend” + new “Google Search Console”.** The existing paid-search view is unchanged (just lives under the first tab); the new tab pulls your **organic** Search Console data. Top section is the **Paid × Organic Overlap** — it flags terms you’re *paying* for that you already rank for organically (**Cannibalization** → worth testing pulling paid) vs. terms you pay for with no organic presence (**Organic gap** → paid is doing the work, e.g. competitor names). Plus an organic KPI strip (clicks / impressions / CTR / avg position, branded vs non-branded) tied to HubSpot organic leads + closed revenue, and Top Organic Queries / Pages tables. Shares the same date-range + attribution selectors as the Ad Spend tab.'},
        {t:'add', d:'**Search Console pulls through our own Google API connection** (new `marketing/gsc-etl.js` + `marketing_gsc_queries`/`marketing_gsc_pages` tables). Run it via **↻ Sync All** or a `gsc`-only sync. Note: organic *query→deal* attribution isn’t possible (Google withholds the organic search term), so organic revenue is tied to HubSpot at the **channel** level (ORGANIC_SEARCH), not per keyword.'},
      ]
    },
    {
      v:'1.65.0', date:'June 3, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Accountant Payouts Portal — a password-gated public page at `/portal/payouts`.** Lets an outside accountant view the exact HubSpot Payouts data (payouts grouped by deposit date, expandable to member payments, summary KPIs, CSV) without a WhisperRoom login. Fully walled off from the rest of the app: its own `wr_acct_session` cookie + in-memory session, no nav to anything else. Password lives ONLY in the `ACCOUNTANT_PORTAL_PASSWORD` env var (nothing hardcoded) — **the portal is disabled (503) until that env var is set in Railway.** `noindex` on every route, HTTPS-only Secure cookie, constant-time password check, 8-attempts/min login rate-limit.'},
        {t:'add', d:'**Shared `buildHubspotPayouts()` helper.** The payouts-building logic (succeeded `hs_payments` grouped by `hs_payout_date`) was extracted into one function so the internal `/api/accounting/hubspot-payouts` route and the portal’s `/api/portal/payouts` route return identical data from a single source.'},
      ]
    },
    {
      v:'1.64.0', date:'June 3, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Sales by State now reports on the fiscal year (Nov 1 – Oct 31), not the calendar year.** The two columns are the two most recent complete fiscal years — **FY2024** (Nov ’23 – Oct ’24) and **FY2025** (Nov ’24 – Oct ’25), each labeled with its date range. Deals are bucketed by close date into the fiscal year they fall in (Nov/Dec roll into the next FY). CSV export and column headers follow the FY labels.'},
        {t:'add', d:'**New “Income-tax nexus” column on Sales by State.** Alongside the existing sales-tax nexus threshold, each state now shows its corporate income/franchise-tax economic-nexus trigger — a factor-presence dollar amount where the state has one (e.g. CA $757,070, NY $1.283M, $500k for CO/CT/MA/PA/TN/WV), “No corp income tax” for NV/OH/SD/TX/WA/WY, or “Physical presence” where there’s no bright-line. Reference only (~2025–26) — confirm with the accountant. Backed by a new `INCOME_NEXUS` map + `incomeNexusLabel()` in `lib/states.js`.'},
      ]
    },
    {
      v:'1.63.1', date:'June 3, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**HubSpot Payouts tab "Invalid time value" fix.** The payout-date parser only understood epoch-ms and bare `YYYY-MM-DD`; HubSpot returns `hs_payout_date` as a full ISO timestamp, so the code appended `T00:00:00Z` onto an already-complete string → invalid date → `toISOString()` threw and the whole tab 500’d. Parser now handles epoch-ms, bare date, and full ISO, and returns null (groups under "unknown") instead of throwing. Client date formatter also guards against bad values.'},
      ]
    },
    {
      v:'1.63.0', date:'June 3, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**New “HubSpot Payouts” tab on Accounting.** Sits right next to HubSpot Fees. Pick a month and it lists every HubSpot payout (bank deposit) that settled that month, each one expandable to show the individual payments that made it up (invoice, customer, method, gross, fee, net). Summary cards up top: # payouts, # payments, gross collected, total HubSpot fees, net deposited, refunds. Expand/Collapse-all buttons + CSV export (per-payment rows with per-payout subtotals + grand total). Each payout group ties to one bank deposit so you can reconcile against the bank statement line-by-line.'},
        {t:'add', d:'**`GET /api/accounting/hubspot-payouts?month=YYYY-MM`.** Pulls succeeded `hs_payments` whose `hs_payout_date` falls in the month (UTC boundaries — payout date is a date-type property) and groups them by settlement date. Payments not yet settled (null payout date) are excluded — they have no deposit yet and still show on the Fees tab.'},
      ]
    },
    {
      v:'1.62.0', date:'June 3, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Quote Label auto-fills with the package name.** When you pick a package and the Quote Label is blank, it now fills in with that package’s name automatically (and updates if you switch packages). If you’ve typed your own label, it’s left alone. Individual MDL selections don’t auto-fill.'},
        {t:'add', d:'**“Copy Quote Link” button on the quote-created popup.** The success window after pushing a quote now has a Copy Quote Link button right next to View Quote — copies the clean clickable hyperlink (Quote Label → package → MDL) ready to paste into a client email.'},
      ]
    },
    {
      v:'1.61.4', date:'June 3, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Copied quote links now use a descriptive label.** The copied hyperlink reads “WhisperRoom Quote — &lt;name&gt;” using, in priority: the Quote Label → the package name → the MDL number (falls back to the quote number if none). Cleaner and more recognizable when pasted into a client email. Works from both the Quote Builder and the Deal Hub.'},
      ]
    },
    {
      v:'1.61.3', date:'June 3, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Fixed the "Couldn\'t load records" error on some marketing drill-down popups** (the Search Terms **Deals** & **True ROAS** cells and the **Share of closed revenue** pills). The query was sorting by a column phrased slightly differently than it was selected, which Postgres rejects on a de-duplicated list. Now sorts correctly — those popups open as expected.'},
      ]
    },
    {
      v:'1.61.2', date:'June 3, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Marketing dashboard — more click-through to the underlying HubSpot records.** The **Share of closed revenue** and **Ad-acquisition quality** pills are now clickable: each opens a popup listing the closed-won deals behind that segment / bucket, linked straight to HubSpot. In the **Search Terms** table, the **Leads**, **Deals**, and **True ROAS** cells are clickable too — Leads opens the attributed contacts, Deals the attributed deals, and True ROAS the closed-won deals behind that term’s revenue. Every popup uses the same attribution model + window as the number you clicked, so the counts reconcile.'},
        {t:'ui',  d:'**Campaign segment cleanup.** “**LP Testing (US/CAN) - Combined” is now classified as **Audiology** (it drives audiology closes), a new **Competitors** segment was added (e.g. “Competitors - Sound Booths”), and campaigns that previously showed as **Unclassified** are now bundled into **Mixed**.'},
      ]
    },
    {
      v:'1.61.1', date:'June 3, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Another round on the intermittent PDF “Cannot fork” failures.** Pointed Chromium at its real binary instead of the Debian wrapper script (which forks extra processes on every launch) and turned off Chromium’s crash reporter (the exact subprocess that was failing to start). Should cut down the “Drive … upload failed” errors. Underlying cause is the server running low on resources, so if it recurs, the box needs more memory.'},
      ]
    },
    {
      v:'1.61.0', date:'June 3, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Sales by State now shows each state’s economic-nexus threshold.** New "State threshold" column lists what triggers a sales-tax obligation there (e.g. “$100k”, “$100k or 200 txns”, “$500k and 100 txns”, “No sales tax”) — so you can see at a glance where our sales are approaching a state’s threshold. Reference figures (~2025–2026); confirm with the accountant. Included in the CSV export too.'},
        {t:'add', d:'**Copy Quote now copies a clean clickable link.** The 🔗 copy buttons in the Quote Builder and Deal Hub now put a formatted hyperlink on your clipboard (“WhisperRoom Quote W-…”) instead of a raw URL — paste it into an email and it shows as a tidy link instead of a long address.'},
      ]
    },
    {
      v:'1.60.1', date:'June 3, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Sales by State report polish.** Full state names instead of abbreviations, dropped the "Unknown" row (excluded deals noted in a footnote), and added a **Nexus rule** column. Rows are now color-coded: **green** = collecting tax where we have nexus; **yellow** = needs a look (a nexus state showing $0 tax, or tax collected somewhere we have no nexus).'},
      ]
    },
    {
      v:'1.60.0', date:'June 3, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**New "Sales by State" report** under Accounting (new tab). Shows Closed Won + Shipped deals grouped by ship-to state for **2024 and 2025** side by side — deal count, net sales, and tax collected per state, with totals and a one-click **CSV export** for the accountant. Built from HubSpot deal data (where the ship-to state lives); cross-check against QuickBooks if you need booked-revenue figures.'},
      ]
    },
    {
      v:'1.59.6', date:'June 2, 2026', tag:'feature',
      changes:[
        {t:'feature', d:'**Marketing dashboard: "ad-acquisition quality" strip on the paid funnel.** A new line under the funnel splits your closed-won deals into how customers actually found us through ads: **Prospecting touch** (a genuine non-branded search — real new-customer acquisition), **Branded-only** (they only ever searched for us by name), and **Unknown** (clicked an ad but no detail to tell). It answers “how much of our ad ROAS is winning new customers vs recapturing people who already know us?” Honest caveat shown on the strip: we only store each contact&rsquo;s first and last ad touch, so the prospecting count is a floor — the real number is at least that high.'},
      ]
    },
    {
      v:'1.59.5', date:'June 2, 2026', tag:'add',
      changes:[
        {t:'add', d:'**Ship calendar: "Track with carrier" button.** Click a shipment on the Shipping ship calendar and the detail popup now has a button that opens the carrier&rsquo;s own live tracking page (ABF, Old Dominion, FedEx, UPS, USPS) for that PRO/tracking number — no more copy-pasting into the carrier site.'},
      ]
    },
    {
      v:'1.59.4', date:'June 2, 2026', tag:'feature',
      changes:[
        {t:'feature', d:'**Marketing dashboard: click any number to see the records behind it.** The HubSpot Contacts and Closed Revenue cards, plus the Quotes / Closed / Revenue stages on the paid funnel, are now clickable — each opens a popup listing the actual contacts or deals that make up that number, every row linking straight to its HubSpot record. The list respects the same date range and attribution model as the card you clicked, so the count always matches.'},
        {t:'feature', d:'**Funnel “maturity” bar.** A new bar under the funnel shows how much of the window&rsquo;s spend is old enough (past our ~29-day sales cycle) to have had a fair chance to close — so a recent window&rsquo;s ROAS reads as a floor that will rise, not a verdict.'},
        {t:'feature', d:'**“Why these differ from HubSpot &rsaquo; Ads” explainer.** An expandable panel under the funnel spells out the six reasons our numbers won&rsquo;t exactly match HubSpot&rsquo;s Ads tool (close-date vs click-date, ROAS vs ROI, lifecycle-stage gap, gclid coverage, credit model, currency).'},
      ]
    },
    {
      v:'1.59.3', date:'June 2, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Order email no longer breaks the CC line.** When you hit Email on an order, the CC list (saved addresses + your rep email) was joined with commas, which Outlook reads as one bad address. Now joined with semicolons so the CC recipients come through correctly.'},
      ]
    },
    {
      v:'1.59.2', date:'June 2, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Assembly manuals: EFP now matches the exact "{size} {type} EFP" filename** (e.g. an MDL 9696 E pulls "9696 E EFP.pdf"). Simplified from the previous attempt to the literal naming convention.'},
      ]
    },
    {
      v:'1.59.0', date:'June 2, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Tidied the top navbar.** “Suppliers” (Audimute POs) is no longer its own nav button — it now lives under **Vendor Hub** as a tab. Open Vendor Hub and use the **WhisperRoom POs · Audimute POs** switcher at the top to flip between the two PO systems. One fewer button up top, and the two purchasing areas are grouped where you’d expect.'},
        {t:'ui', d:'Under the hood, the navbar is now a single shared component instead of being copied into every page — so it stays consistent and is quicker to adjust going forward.'},
      ]
    },
    {
      v:'1.58.3', date:'June 2, 2026', tag:'add',
      changes:[
        {t:'add', d:'**Audimute POs can now hold multiple tracking numbers.** When a PO ships in several boxes with separate tracking numbers, enter them comma-separated in the Tracking Number field on the Suppliers dashboard. The 📦 tracking widget lists each number with its own Track ↗ link and Copy button.'},
      ]
    },
    {
      v:'1.58.2', date:'June 2, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**New users now resolve their HubSpot owner correctly.** A newly-added HubSpot user (e.g. Josh) wasn&rsquo;t getting matched to an owner ID at login, so their session had none — which silently disables their notifications and rep attribution. The lookup used HubSpot&rsquo;s exact-email filter, which misses owners whose record email differs in casing. It now also pages through all owners and matches case-insensitively, so new logins resolve automatically (existing sessions self-heal on next load). No more per-user hardcoding needed.'},
      ]
    },
    {
      v:'1.58.1', date:'June 2, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Fixed intermittent PDF failures ("Failed to launch the browser process… Cannot fork").** All server-side PDF generation is now serialized through one semaphore. The background "save to Drive" path (invoices, quotes, orders, vendor POs) was bypassing the single-at-a-time gate, so two PDFs generating at once could overload the server and fail to launch — which is why some invoice/PO PDFs silently didn&rsquo;t generate. Chromium launches also now retry a few times for transient hiccups.'},
      ]
    },
    {
      v:'1.58.0', date:'June 2, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Vendor PO: confirm before saving vendor-profile fields.** Editing the Vendor info, Freight Terms, Payment Terms, or Standing Vendor Notes on a PO now asks whether to save the change to the vendor for future POs (OK = update the vendor profile, Cancel = this PO only) — same pattern as the existing unit-price prompt.'},
        {t:'add', d:'**Vendor PO: "REVISION n" stamp.** Pressing "Update PO" (regenerating a PO that already has a PDF) now stamps "REVISION 1/2/3…" in red just under the date in the top-right of the PO. The first PDF is not a revision.'},
        {t:'add', d:'**Vendor PO: overage tracking on receiving.** When you receive more than was ordered, the extra is flagged as "⚠ OVERAGE — N over" on the receive screen and in the PO receipt log. The overage also flows into invoice matching: the expected bill total now uses max(ordered, received) × unit price, so Kim&rsquo;s reconcile total goes up by the overage × unit price and a partial bill won&rsquo;t falsely read as fully billed.'},
      ]
    },
    {
      v:'1.57.3', date:'June 2, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Renamed the Quote Builder’s freight-area button from “Truckload” to “Truckload Estimator.”'},
      ]
    },
    {
      v:'1.57.2', date:'June 2, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Truckload diagram now lines up same-size pallets.** Within each truck, pallets are grouped by footprint (all the 102s in a row, then the 90×52s, etc.) instead of interleaving by booth — a cleaner, more realistic load picture. Ordering only; doesn’t change the truck count or split any rooms.'},
      ]
    },
    {
      v:'1.57.1', date:'June 2, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Truckload calc now keeps each booth (“room”) together on one truck.** Two packing rules: (1) fewest trucks first, then (2) never split a single booth’s pallets across trucks. Previously it packed pallet-by-pallet, so a booth with a mix (say a 102″ pallet + a 90×52) could get its pieces optimized onto different trucks. Now the calculator groups by booth and packs whole rooms — still sharing width between booths inside a truck to keep the count down.'},
      ]
    },
    {
      v:'1.57.0', date:'June 2, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Quote Builder’s 🚚 Truckload button now opens a popup** instead of jumping to the Orders page — the calculator appears right over the quote, pre-filled with its booths. Close it and you’re back on the quote, nothing lost.'},
        {t:'log', d:'**Truckload calculator is now one shared component** (`/assets/truckload-calc.js`) used by both the Orders subtab and the Quote Builder popup, so there’s a single engine to maintain (no duplicated logic). Theme-adaptive, so it looks right on both the dark dashboards and the lighter Quote Builder.'},
      ]
    },
    {
      v:'1.56.0', date:'June 2, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Truckload calculator moved into the Orders page** as its own “🚚 Truckload” tab (the standalone /truckload page is gone). Open an order and hit “🚚 Estimate truckloads” in the drawer to jump to it pre-filled, or open it empty and add models by hand. The Quote Builder also gets a **🚚 Truckload** button next to the freight estimate that opens it pre-filled with the current quote’s booths.'},
        {t:'add', d:'**New truck list:** 53′ dry van (52′ usable), 28′ pup (27′ usable), 40′ container (39′ usable), 20′ container (19′ usable). Containers use a 92″ interior width. Removed the 48′ van and the Custom option.'},
      ]
    },
    {
      v:'1.55.0', date:'June 2, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Truckload calc: pallet rotation for tighter loads.** Pallets can now lie sideways when their long side fits across the trailer width (98″) and turning saves length — e.g. a 90×52 pallet rotated costs 52″ of trailer length instead of 90″. Rotated pallets are marked ⟳ in the diagram and tooltip. This often drops the truck count (10× single-pallet 90×52 booths now fit in one 52′ truck instead of two). Narrow 47″ pallets still pair side-by-side, which packs tighter than rotating them.'},
        {t:'add', d:'**Wide Access (WA) toggle per booth.** Each booth row has a “WA” checkbox; when checked, one 47″ pallet on that booth (if it has one) becomes a 52″ pallet — the wide-access door’s wider crate — and the layout/truck count update accordingly. Flagged “WA” in the legend and breakdown.'},
        {t:'fix', d:'**Hid the ENV/SNV (no-vent) models from the picker.** They duplicated the standard E/S pallet dimensions and cluttered the list. Pre-fill from an order still recognizes them, normalized back to the plain E/S model.'},
      ]
    },
    {
      v:'1.54.0', date:'June 2, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Truckload calculator now draws a to-scale layout diagram.** Each truck gets a top-down floor plan with every pallet placed to scale and labeled with its L×W footprint, color-coded by model (with a legend). The engine was upgraded from a linear-feet estimate to real 2D placement (same two-lane, floor-only, no-split rules), so the picture matches the count. Hover a pallet for its full L×W×H and model.'},
        {t:'fix', d:'**Default truck is now 52′, not 53′.** Matches the trailers WhisperRoom actually uses (usable floor ≈ 618″). 48′ / 26′ box / custom options unchanged.'},
      ]
    },
    {
      v:'1.53.0', date:'June 1, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Truckload calculator** (new page at <code>/truckload</code>). Estimate how many truckloads a set of booths needs — pick a truck (53′ dry van default, plus 48′, 26′ box, or custom dimensions), add booth models + quantities, and it returns trucks needed, total pallets, linear feet used, and a per-truck fill bar. Models the load as <b>floor space only (no stacking)</b> with two side-by-side lanes: narrow pallets (≤ half the trailer width) pair up two-to-a-row, wide booth pallets (52–54″) block the full width, and pallets are packed truck-by-truck so a pallet never splits across two trucks. Open it standalone, or hit “🚚 Estimate truckloads” in an order’s drawer to pre-fill from that order’s booths.'},
      ]
    },
    {
      v:'1.52.1', date:'June 1, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Tennessee sales tax was undercollecting 0.5%.** TN is origin-based for in-state sellers, so all TN orders source to our Morristown / Hamblen County rate of **9.75%** (7% state + 2.75% local) — but TaxJar was resolving our origin ZIP to **9.25%** (missing the 0.5% city portion), so every TN order came up short. Added a `minRate` floor (0.0975) to the TN nexus config: when TaxJar returns a rate below it, the tax is recomputed on the same taxable base at 9.75%. Floors up only — a higher rate is left alone. (Already-collected orders from before this fix undercollected; reconcile separately.)'},
      ]
    },
    {
      v:'1.52.0', date:'June 1, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Sales Goal report — pick any of the last 13 months.** The Sales Goal view header now has a month dropdown (current month + 12 prior). Selecting a past month re-runs the whole report against that month: its deals populate the "View deals counted" list, the headline shows that month&rsquo;s full total (labeled "total" instead of "MTD"), and the goal tiers reflect the trailing-12-month average ending that month. Defaults to the current month as before.'},
        {t:'add', d:'**Notification when an acoustic-package color is confirmed.** When an AP order&rsquo;s color flips from "Unknown" to a real color (the moment we send Audimute the PO), Benton and Jill now get a notification: "AP color confirmed: &lt;color&gt; — time to send Audimute the PO," with an Open-order link. Fires once on the Unknown&rarr;color transition.'},
        {t:'fix', d:'**WA Type selector now reliably appears on WA/ADA orders.** Hardened the v1.51.7 fix: the orders drawer now shows the WA Type dropdown whenever a WA/ADA line item is present (checking both `name` and `productName`), and when the booth dimensions can&rsquo;t be parsed to narrow the list it falls back to all four canonical types (4016/4040/4622/4646) so the rep can always make a selection.'},
      ]
    },
    {
      v:'1.51.7', date:'June 1, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Orders drawer now shows the WA Type selector for WA/ADA orders.** Previously the pop-out order drawer only revealed the WA Type dropdown if a value had already been saved — so an order with a Wide Access / ADA booth but no type picked yet had no way to set it. The drawer now detects WA/ADA line items and offers the eligible types for the booth&rsquo;s dimensions (e.g. a 40-series booth shows 4016/4040), matching the order-processing flow. A previously-saved value is always preserved even if it&rsquo;s outside the eligible set.'},
      ]
    },
    {
      v:'1.51.6', date:'May 29, 2026', tag:'log',
      changes:[
        {t:'log', d:'**End-of-session DEVLOG writeup for 2026-05-29.** Today shipped WR PO System Phases 2 (Receive) and 3 (Kim&rsquo;s invoice matching) end-to-end plus heavy iteration on `/vpo/` (PDF is now a snapshot, not a live doc — only "Update PO" regenerates). Current focus block rewritten; session writeup captures Phase 4 (QB Bills API auto-stub) as deferred until Kim asks. No runtime change.'},
      ]
    },
    {
      v:'1.51.5', date:'May 29, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Sales Goal report crashed — `esc is not defined`.** v1.51.4 used `esc(...)` in the new "View deals counted" block but `reports-dashboard.html` exposes the helper as `escapeHtml`. Three call sites swapped to `escapeHtml`; the deal-ID link uses `encodeURIComponent` instead since it&rsquo;s a URL segment.'},
      ]
    },
    {
      v:'1.51.4', date:'May 29, 2026', tag:'add',
      changes:[
        {t:'add', d:'**"View deals counted" expandable list on Sales Goal.** Below the 12-month chart on `/reports` → Sales Goal, a collapsed `<details>` block listing every deal counted toward this month&rsquo;s MTD revenue. Columns: closedate / deal name / stage pill (Won / Shipped) / total / tax / net revenue, plus a HubSpot deep link per row. Footer row totals the net revenue and ties out to the headline MTD number. Helpful for spotting missing or double-counted deals (and refunds — which are explicitly NOT included; a note in the block points to reconcile for those). New `mtdDeals` array on the `/api/reports/sales-goal` response with per-deal details; `dealname` added to the HubSpot properties pull.'},
      ]
    },
    {
      v:'1.51.3', date:'May 29, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Removed Arizona + Utah from `NEXUS_STATES`.** We no longer have nexus in those states (per the rep, TaxJar&rsquo;s already been corrected). `lib/states.js` now lists 14 states (was 16). The tax calculator was over-charging AZ and UT orders &mdash; from this version forward, those ZIP codes route through the same "no nexus → tax: 0" path as any non-nexus state. The Quote Builder Nexus States popup will reflect the new list automatically (it&rsquo;s sourced from the same map).'},
      ]
    },
    {
      v:'1.51.2', date:'May 29, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Marketing — Spend → Quote → Close → Revenue funnel + segment overlay.** New funnel strip below the KPI cards (above the Campaigns table) showing Spend → Quotes → Closed → Revenue with **cost-per-quote**, **cost-per-closed-deal (CAC)**, and ROAS — driven by the same model-windowed numbers as the cards, so they always agree. "Quote" = a deal that reached the Sent-Quote stage or beyond (HubSpot Sales Pipeline). Respects the active attribution toggle (First / Last / All) and date range.'},
        {t:'add', d:'**Per-campaign funnel columns + segment tags.** The Campaigns table gains <em>Segment</em> (color-coded tag from `segment_map.json`), <em>Quotes</em>, <em>CPQ</em>, and <em>CAC</em> columns, plus a one-line "share of closed revenue by segment" rollup under the funnel. Built on the existing gclid/UTM attribution join — no duplicate query. (Data note: WhisperRoom\'s paid revenue is ~77% Branded/General "Mixed" with Voice Over the only segment-specific winner, so the segment view rides on the campaign table as an overlay rather than replacing it.)'},
      ]
    },
    {
      v:'1.51.1', date:'May 29, 2026', tag:'add',
      changes:[
        {t:'add', d:'**Tax Nexus States reference popup on the Quote Builder.** Small "Nexus States" button in the Sales Tax section header opens a modal listing every state where WhisperRoom is registered to collect sales tax, with a green YES / muted NO pill in the "Taxes Freight" column. Backed by a new `GET /api/nexus-states` endpoint that serializes `lib/states.js`&rsquo;s `NEXUS_STATES` map — single source of truth, so the popup never drifts from what the calculator actually does. Cached client-side after first open. Useful when a rep is on the phone with a customer asking about tax in their state.'},
      ]
    },
    {
      v:'1.51.0', date:'May 29, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**WR PO System Phase 3 — Kim&rsquo;s invoice matching workflow.** New **Vendor Bills** tab on `/accounting` (5th tab on `reconcile.html`). Lists vendor POs in status SENT / PARTIAL / RECEIVED / CLOSED with a per-row Outstanding column (`PO Total − sum(invoiced)`). Fully-invoiced POs are hidden by default; toggle the checkbox to show them. Each row has two buttons: **Open in QB** opens a blank New Bill page in QuickBooks in a new tab (Kim picks the vendor and adds lines manually — QB Online doesn&rsquo;t support vendor pre-fill via URL params; Phase 4 will add an API stub-create). **Mark Bill Received** opens a modal capturing `{vendor invoice #, invoice date, vendor total, QB Bill #, notes}`. Live discrepancy banner shows when the entered total ≠ outstanding (matches green / partial bill amber / over-bill red). On save, `POST /api/vendor-pos/:poNumber/invoice` appends to `invoice_data.events`, sums totals, and flips PO status to **CLOSED** when fully received AND fully invoiced (within $0.01). Stamps `closed_at`. Supports partial bills out of the box — multiple events per PO. PO row links to `/vpo/` (new tab) for cross-reference.'},
      ]
    },
    {
      v:'1.50.10', date:'May 29, 2026', tag:'log',
      changes:[
        {t:'add', d:'**Marketing — segment classifier groundwork (read-only).** New `marketing/segment_map.json` (Gabe-editable config) maps Google Ads campaigns → buyer segments (Audiology / Education / Voice Over / Music·Recording / Office·Privacy / Broadcast·Podcast) by keyword rules + exact overrides, with a "Mixed" bucket for cross-segment campaigns (Branded/General/Competitor/Remarketing/Shopping). New read-only diagnostic `GET /api/marketing/segments/proposed` classifies EVERY campaign in `marketing_campaigns` (all-time) and returns per-segment spend rollups + the Mixed/Unclassified lists for review. No UI yet — this is the data-grounding step before the Segment Performance section is built (awaiting sign-off on the mapping).'},
      ]
    },
    {
      v:'1.50.9', date:'May 29, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Closed Revenue + True ROAS now window on closedate, not createdate.** "Closed Revenue (90d)" was summing closed-won deals *created* in the window; it now sums deals that *closed* in the window — the intuitive meaning, and the same basis HubSpot\'s Ads tool uses. Verified against live HubSpot: the gclid-attributed closed-won pool moves from ~$291k (createdate) to ~$433k (closedate), reconciling cleanly with HubSpot\'s "All ad interactions" revenue (~$487k; the residual is the no-gclid ad-clickers we structurally can\'t see). All deal-based coverage metrics moved to closedate for consistency; contact counts stay on createdate (a cohort question, and how first-touch was validated).'},
        {t:'ui', d:'**"HubSpot Contacts" card relabeled to reflect the real signal.** Was "HubSpot Contacts (All ad interactions)" — but that count is effectively "contacts carrying a gclid" (proven: 223 gclid vs 224 all). Now labels per model: <em>first-touch paid</em> / <em>last-touch paid</em> / <em>gclid / paid touch</em>. Tooltip clarifies it\'s a provable floor — HubSpot\'s Ads tool counts more ad interactions (no-gclid clicks) so it reads higher.'},
        {t:'ui', d:'**Closed Revenue + True ROAS tooltips** now state the basis: closed-won by closedate, single-touch full deal-amount credit (matching HubSpot\'s crediting, not a fractional multi-touch split).'},
      ]
    },
    {
      v:'1.50.8', date:'May 29, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Marketing — attribution model selector.** New First interaction / Last click / All ad interactions toggle on the marketing dashboard, beside the date range. It re-drives the closed-loop cards (Closed Revenue, HubSpot Contacts, True ROAS) and the per-campaign + per-search-term lead/deal/revenue columns. All three models run off fields the ETL already ingests (first_* and latest_* source pairs + gclid) — no re-sync needed. <em>First</em> = HubSpot&rsquo;s "First ad interaction" (strict first touch); <em>Last click</em> = latest_source paid, windowed on the last-touch date; <em>All</em> = any known ad touch (first OR latest paid, or a gclid present) ≈ HubSpot&rsquo;s "All ad interactions" (close, not exact — we store first + latest + gclid, not full event history).'},
        {t:'add', d:'**New "HubSpot Contacts" KPI card.** Unique HubSpot contacts attributed to paid search under the selected model — the people-level analog to Google Conversions. Flipping the selector toggles it between the first-touch and all-interactions contact counts, lining up with the matching HubSpot Ads report.'},
        {t:'ui', d:'**Conversions card relabeled "Google Conversions."** Clarifies it&rsquo;s Google Ads conversion <em>events</em> (form fills, calls, etc., possibly several per person, fractional under data-driven attribution) — NOT unique HubSpot contacts. Tooltip explains the distinction and points to the new HubSpot Contacts card for the people-level number.'},
        {t:'fix', d:'**HubSpot contact sync no longer drops viral-month rows.** Contact ingestion now uses 7-day buckets (was 30) so a spike month can&rsquo;t blow a single bucket past HubSpot&rsquo;s 10k search-API cap (which had silently dropped ~4k of the most-recent contacts). Deals stay on monthly buckets — they never approach the cap — so only the contact sync runs the extra queries.'},
      ]
    },
    {
      v:'1.50.7', date:'May 29, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Send button stays on Vendor Hub rows after status flips to SENT.** Was hidden once a PO was sent; now stays visible for both OPEN and SENT so Josh can reopen the mail draft if he closed it by accident. Click on an already-SENT PO skips the status PATCH (it&rsquo;s already SENT) and just re-opens the mailto. Hidden on PARTIAL / RECEIVED / CLOSED / CANCELLED. Toast wording differs: first send shows "Draft opened… (PO marked Sent.)", re-send shows "Draft re-opened."'},
      ]
    },
    {
      v:'1.50.6', date:'May 29, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Shortened the "Update PO" confirm text** to just "This will replace the existing PO." (was a multi-paragraph explanation).'},
      ]
    },
    {
      v:'1.50.5', date:'May 29, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**"Update PO" now confirms before replacing the Drive PDF.** Clicking the button when it&rsquo;s in "Update PO" mode (i.e. a PDF already exists) fires a confirm: "This will replace the existing PDF in the Drive folder with the current state of the PO… The shared Drive link stays the same. Continue?" First-time generations (label = "Create / Download PDF") still go straight through with no prompt.'},
      ]
    },
    {
      v:'1.50.4', date:'May 29, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**"Create / Download PDF" → "Update PO" once a PDF exists.** First click on a fresh PO says "Create / Download PDF" — generates, uploads to Drive, downloads. Once `pdf_drive_file_id` is set on the row, subsequent visits show "Update PO" instead. Same endpoint (`POST /api/vendor-pos/:n/pdf`) — server-side regen + Drive PATCH-in-place still overwrites the existing Drive file via the stored file ID, so vendors keep the same shared link if Josh circulated it. After any successful generation the button label is sticky at "Update PO".'},
      ]
    },
    {
      v:'1.50.3', date:'May 29, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Send button on the Vendor Hub table.** Each OPEN PO row gets a green **Send** button (between Open and Receive). Flips the row to SENT, then opens a `mailto:` draft addressed to the vendor&rsquo;s send-to/cc with the standard greeting + "Attached is WhisperRoom Purchase Order WP-… Please confirm receipt…". Josh attaches the PDF before sending. Uses a hidden anchor click so the listing stays put and refreshes.'},
        {t:'fix', d:'**Dropped the "View online: /vpo/…" link from the Send body.** Both the table Send button and the existing `/vpo/` Send button. The PDF is the artifact for the vendor; no need for the internal link in vendor-facing mail.'},
      ]
    },
    {
      v:'1.50.2', date:'May 29, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Receipt log header pared back.** Dropped the "— not on vendor PDF" suffix from the Internal tag; just says "Internal" now.'},
      ]
    },
    {
      v:'1.50.1', date:'May 29, 2026', tag:'feature',
      changes:[
        {t:'fix', d:'**PDF no longer auto-regenerates on edits.** The Drive PDF is now a snapshot of what was sent to the vendor — it only changes when Josh explicitly hits the **Create / Download PDF** button on `/vpo/`. Stripped the fire-and-forget regen calls from POST `/api/vendor-pos` (create), PATCH `/api/vendor-pos` (every edit), and POST `/api/vendor-pos/:poNumber/receive`. The `/pdf` endpoint (the explicit button) still generates fresh + uploads + downloads as before.'},
        {t:'add', d:'**Receipt log on the `/vpo/` page.** Below the sincerely block, when there&rsquo;s any receive history, a purple-accented "Receipt Log" section lists every receive event (date, who, items). Auth-only — Puppeteer scrapes `/vpo/` via share-token (no auth), so the vendor-facing PDF stays clean. Also hidden in `@media print` for the same reason if a rep prints the page. Carries an "Internal — not on vendor PDF" tag so there&rsquo;s no confusion.'},
        {t:'add', d:'**Receive button on the Vendor Hub table.** Each row gains a purple Receive button (or "Receipts" when the PO is already RECEIVED/CLOSED — same modal, read-only view). Opens an inline modal matching the `/vpo/` Receive UX: per-line Ordered / Received / Remaining / Receiving Now, plus the historical event log. Saves to the same `/api/vendor-pos/:poNumber/receive` endpoint and refreshes the listing.'},
      ]
    },
    {
      v:'1.50.0', date:'May 29, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**WR PO System Phase 2 — Receive workflow.** New purple **Receive** button in the `/vpo/` action bar (auth-only; status-gated so it doesn&rsquo;t appear on RECEIVED/CLOSED/CANCELLED POs). Opens a modal showing each line item with Ordered / Received-so-far / Remaining / Receiving Now columns. Default value for each input is the line&rsquo;s remaining qty (so hitting Save with no edits records a full receipt of everything still open). The bottom half shows the **Receipt Log** — every prior receive event with who and when, plus the items received. The same modal serves as the read-only receipts view when the PO is fully received (button label flips to "Receipts" and the input column disappears). Backend: new `POST /api/vendor-pos/:poNumber/receive` endpoint that appends an event to `received_data.events`, recomputes per-line totals, and derives the new status — `RECEIVED` if every line&rsquo;s cumulative received qty meets or exceeds its ordered qty, `PARTIAL` if any received qty is > 0 but not all lines are full. Stamps `received_at` on first full-receive. Logs to `vendor-po.received` for the audit trail. Fires the standard PDF regen + Drive overwrite after the status update so the doc on Drive reflects the new state. **Open follow-up:** receive history isn&rsquo;t yet shown on the PDF render — Phase 3.'},
      ]
    },
    {
      v:'1.49.14', date:'May 29, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Back link on the PO builder.** New ← Vendor Hub button top-left of `/vpo/`. Visible only to authenticated reps (share-token vendor views don&rsquo;t see it). Edit-mode banner bumped down to row 2 so the two don&rsquo;t overlap. Both hidden in `@media print` so the PDF render stays clean.'},
      ]
    },
    {
      v:'1.49.13', date:'May 29, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Delete POs from the Vendor Hub table.** New red × button on each row in the Vendor Hub Purchase Orders tab. Confirms then DELETEs and refreshes the table. The server-side gate that only allowed deletes of OPEN POs is gone — table cleanup is unrestricted (the audit log captures the prior status so deletions stay traceable).'},
        {t:'fix', d:'**Vendor PO number prefix: WV → WP.** New POs start with `WP-{YY}{MM}{DD}{NN}` ("WhisperRoom Purchase"). Existing WV- POs stay as-is — no migration; both prefixes coexist.'},
        {t:'ui', d:'**PDF download filename now leads with the vendor name.** Was `{po_number}.pdf` → now `{Vendor Name} - {po_number}.pdf` (e.g. `Bertelkamp Automation Inc - WP-26052901.pdf`). Sorts the downloads folder by vendor when Josh saves a few in a row. Server-side filename + browser `a.download` attribute both updated; `VENDOR_NAME` baked into the `/vpo/` JS so the client knows the sanitized name.'},
        {t:'add', d:'**Price-change prompt for catalog-linked lines.** When Josh edits the unit price on a line that came from the vendor&rsquo;s catalog (has a `catalog_id`), and the new price differs from the catalog price, a confirm fires after the PO save: "Price for `X` changed from $A to $B. Keep this price for future orders?" If yes, the vendor catalog row is updated (with today&rsquo;s date stamped as `price_updated_date`) so the next PO prefills with the new price. Description / SKU / MFG / qty edits stay PO-only (don&rsquo;t propagate to the catalog) — per request, only price changes prompt.'},
      ]
    },
    {
      v:'1.49.12', date:'May 29, 2026', tag:'log',
      changes:[
        {t:'fix', d:'**Added `.gitignore` and untracked two accidentally-committed `.code-workspace` files.** The v1.49.11 commit used `git add -A` and swept in `lib/Viking Idle Game.code-workspace` + `lib/Work.code-workspace` (local IDE config). New `.gitignore` covers `*.code-workspace`, `node_modules/`, `.env*`, `.DS_Store`, etc. so future bulk-adds stay clean. Files removed from the index with `git rm --cached` so local copies are preserved.'},
      ]
    },
    {
      v:'1.49.11', date:'May 29, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Nav bar audit + consistency.** Audited the topbar nav across all 9 dashboards; the canonical set is now: Deal Hub / Quotes / Orders / Shipping / Reports / Accounting / Suppliers / Vendor Hub / Marketing. Added Marketing to 7 dashboards that didn&rsquo;t have it (orders, reconcile, reports, shipping, suppliers, vendor-pos, email-reply). Added Accounting to marketing-dashboard.html. Removed the Email Reply self-link from `assistant/email-reply.html` — Email Reply opens via the ✉ icon button on Deal Hub (popup modal); no dedicated nav slot. Deleted the orphaned `vendors-dashboard.html` (the `/vendors` route 302-redirects to `/vendor-pos#vendors` since v1.49.3; the file was unreferenced).'},
      ]
    },
    {
      v:'1.49.10', date:'May 29, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Tax calc now works in the ZIP-only freight flow.** The Quote Builder lets reps run a freight quote with just a ZIP code (no city/state) — but in that path the tax call was silently returning $0 because `lib/taxjar.js:18-20` short-circuits to `tax: 0` when state is empty (it doesn&rsquo;t match anything in `NEXUS_STATES`). Added a `zipToState()` helper in `lib/states.js` that maps the ZIP-3 prefix to a US state via USPS Sectional Center ranges (~55 ranges, ~30 LOC). `calculateTaxProper` now derives state from ZIP when the input state is empty before doing the nexus lookup; explicit state still wins when present. Canadian postal codes / non-state territories return empty and tax stays $0 (correct — no US nexus there). Wired into `taxjar.init({ zipToState })` from the existing module destructure.'},
      ]
    },
    {
      v:'1.49.9', date:'May 29, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Create / Download PDF was throwing "Invalid character in header content [Content-Disposition]".** Node&rsquo;s HTTP layer strictly rejects non-ASCII characters in raw header values; the PDF filename was using an em-dash (`WV-… — Vendor.pdf`), which blew up serialization and prevented the browser download. Switched to a hyphen and ASCII-stripped the vendor name in `_regenerateVendorPoPdf`; added a defensive non-ASCII strip in the response header path too for any future unicode that sneaks in (accented vendor names, etc.). Drive upload + browser download both work now.'},
      ]
    },
    {
      v:'1.49.8', date:'May 28, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Removed the Expected Delivery row from the `/vpo/` doc.** Lives only on the Vendor Hub listing now (where it&rsquo;s inline-editable). The doc was showing it twice in two places, redundant.'},
      ]
    },
    {
      v:'1.49.7', date:'May 28, 2026', tag:'feature',
      changes:[
        {t:'fix', d:'**TOTAL row recomputes on edits.** Added `refreshTotal()` to the `/vpo/` JS; it sums every line&rsquo;s qty × unit price and updates `#poGrandTotal`. Called after every line edit (qty/price commit), catalog-picker add, "+ Blank Line", and remove. Previously the TOTAL stayed at the server-rendered value until page refresh.'},
        {t:'add', d:'**"Create / Download PDF" button on the doc.** Replaces the Print/Save PDF button. Clicking it `POST`s to a new `/api/vendor-pos/:poNumber/pdf` endpoint that (1) generates a fresh PDF via Puppeteer, (2) uploads/overwrites in `GDRIVE_VENDOR_POS_FOLDER`, (3) streams the bytes back with `Content-Disposition: attachment` so the browser saves it locally as `{po_number}.pdf`. Refactored `_regenerateVendorPoPdf` to return `{buf, filename}`; existing fire-and-forget callers ignore the return.'},
        {t:'ui', d:'**× removes a line with no confirm.** The "Remove this line?" confirm popup on the line × button is gone — clicking × clears the row immediately. Edits autosave, so accidentally-removed lines are easy enough to re-add via the catalog picker.'},
        {t:'add', d:'**Standing Vendor Notes are now editable on the doc.** Click the standing notes block to edit. Saves to both the PO snapshot and the vendor record (same as the other vendor_snapshot fields) so the next PO Josh creates for that vendor inherits the latest notes.'},
      ]
    },
    {
      v:'1.49.6', date:'May 28, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**+ New PO opens the new PO in a new tab.** Previously redirected the current tab; now the listing stays put while the new `/vpo/` opens fresh. Listing also refreshes so the new PO shows up immediately in the table.'},
      ]
    },
    {
      v:'1.49.5', date:'May 28, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**`/vpo/` is now the primary PO edit surface.** Clicking "+ New PO" on the Vendor Hub opens a tiny "pick a vendor" modal; on Create the server stamps an empty `OPEN` PO and the browser is redirected to `/vpo/{po_number}` where all editing happens. The "Edit" button on each listing row was replaced with "Open" (same behavior — opens the doc page in a new tab). Empty-lines POST is now allowed; POs are filled in on the doc.'},
        {t:'add', d:'**Full editability on the PO doc.** The entire vendor block and the Ship-To block are now editable inline: vendor address (multi-line textarea), send-to emails (comma-separated, mailto: links suppressed in edit mode so clicks open the editor instead of the mail client), freight + payment terms (already in v1.49.4), plus all six ship-to fields (name, address line 1, address line 2, ATTN, phone, email). Ship-to overrides save to `po_data.ship_to`; the WhisperRoom default still shows when no override is set.'},
        {t:'add', d:'**Vendor edits auto-propagate to the vendor profile.** When the rep edits any vendor_snapshot field on the PO doc, the change PATCHes both the PO (snapshot) and the vendor record (`/api/vendors/:id`) in parallel — so the next PO Josh creates for that vendor starts with the updated info. The v1.49.2 confirm prompt ("save to profile?") is gone; it&rsquo;s automatic now.'},
        {t:'add', d:'**Catalog picker on "+ Add Line".** Clicking + Add Line opens a popup overlay listing the vendor&rsquo;s catalog items with checkboxes. Pick any subset → "Add Selected" appends them as PO lines with default qty + price pre-filled. Already-on-PO items are disabled (checked + greyed) so they can&rsquo;t be added twice. There&rsquo;s also a "+ Blank Line" button in the picker footer for one-off items.'},
        {t:'add', d:'**Send / Cancel / Delete buttons on the doc page.** When viewed by an authenticated rep, the top-right action bar gains: Send (when OPEN — flips status to SENT and opens mailto), Cancel PO (when OPEN/SENT/PARTIAL — flips to CANCELLED), Delete (when OPEN). All gated server-side via `isAuth(req)` so vendors hitting the share-token link see only the Print button.'},
      ]
    },
    {
      v:'1.49.4', date:'May 28, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Edit-in-place on the PO doc page (`/vpo/:poNumber`).** When an authenticated rep opens the PO link, every editable field on the doc lights up on hover and accepts a click to edit: line item SKU, description, MFG, MFG Part #, qty, unit price; PO Notes (textarea); Expected Delivery date; vendor block phone, contacts (comma-separated), freight terms, payment terms. Add new lines via a "+ Add Line" button at the bottom of the table; remove with the × on each row. Each blur fires a PATCH `/api/vendor-pos/:poNumber`; the server kicks off PDF regen + Drive overwrite as before. A small "Edit mode" pill in the top-left shows "Saving…" → "Saved" status on every change. Mode is server-gated on `isAuth(req)` — Puppeteer scrapes `/vpo/` with the share token only, so PDF rendering still sees the clean read-only doc. `@media print` rules also hide all edit chrome so the browser&rsquo;s built-in print preview matches what vendors get. Escape cancels an active edit; Enter commits (Ctrl+Enter in textareas).'},
      ]
    },
    {
      v:'1.49.3', date:'May 28, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Vendor Hub: merged Vendors + Vendor POs into one page with tabs.** `/vendor-pos` is now a single page with two tabs &mdash; **Purchase Orders** (default) and **Vendors**. `/vendors` redirects to `/vendor-pos#vendors` so old bookmarks still work. The nav link across all 9 dashboards collapsed from two links to one ("Vendor Hub"). The page-sub blurb about "Suppliers Josh orders from..." was dropped (per request).'},
        {t:'ui', d:'**Reverted the v1.49.2 orange theming pass on the PO modal.** Section labels back to muted (was orange); PO Lines table header back to surface2/muted (was orange tint); lines-add background and total back to standard (was orange); modal&rsquo;s 3px orange top border removed; vendor info form back to surface2 background (was orange); catalog header back to muted (was orange); PO# in listing back to text color (was orange); OPEN status pill back to neutral gray (was orange). Kept: orange "+ New PO" / "+ New Vendor" buttons, orange filter-pill active state, subtle orange tint on "checked" catalog rows, orange tab indicator.'},
      ]
    },
    {
      v:'1.49.2', date:'May 28, 2026', tag:'ui',
      changes:[
        {t:'ui',  d:'**Vendor PO doc (`/vpo/:poNumber`) polish.** Header now uses the WhisperRoom SVG logo (same one as the Audimute `/po/` doc) instead of the styled "WhisperRoom" text — loaded from `assets/whisperroom-logo.svg.b64` at startup, served via new `wrLogoImg()` helper. Removed "ORDER CONFIRMED BY: ___ DATE: ___" sign-off line. Billing block now drops "Attn: Accounting" and adds `accounting@whisperroom.com`. PO contact name is hardcoded to "Josh Fletcher" everywhere (was the logged-in rep, which surfaced "Benton" on docs from Benton&rsquo;s sessions). DRAFT status badge removed (status enum changed — see below).'},
        {t:'fix', d:'**Vendor PO status lifecycle simplified — no more draft + approve gate.** Per request: when Josh hits Create, the PO is live (status OPEN), no approval step. New lifecycle: `OPEN → SENT → PARTIAL → RECEIVED → CLOSED` (+ `CANCELLED`). The modal&rsquo;s Save+Approve+Unapprove buttons collapsed into just "Create PO" / "Save Changes" + "Send (Mailto)". POST `/api/vendor-pos` now stamps `OPEN` instead of `DRAFT`; the transition map (`_VENDOR_PO_TRANSITIONS`) lost DRAFT/APPROVED entries.'},
        {t:'ui',  d:'**Editable vendor info inside the PO modal.** The vendor block (phone, address, contacts, send-to + cc emails, freight + payment terms, standing notes) became a full editable form (previously a read-only display). On Save, if any field changed vs the loaded snapshot, a confirm prompt asks whether to also save the changes back to the vendor profile via PATCH `/api/vendors/:id`. Either way the PO snapshot captures the edited values. Vendor name itself stays read-only (changing it would create a new vendor).'},
        {t:'ui',  d:'**Listing table fields + inline edit + View button.** Table now mirrors the Audimute `/suppliers` shape: PO # / Vendor / Status / Lines / Total / Expected (inline-editable date) / Sent / Created / Actions. Each row has [View] (opens `/vpo/...` in new tab) and [Edit] (opens modal). Expected date is inline-editable — typing turns the field orange ("dirty") and `onblur` PATCHes. The Expected Delivery field was removed from the modal — it lives only on the table now.'},
        {t:'ui',  d:'**More orange in the PO creation modal.** Section labels became orange with subtle dividers; PO Lines block has an orange-tinted header and borders; catalog "checked" rows tint orange; running total displays in orange; modal gets a 3px orange top border. The bland gray modal got a brand-aligned identity pass.'},
        {t:'fix', d:'**PDF auto-generates on initial create and on every edit.** Was previously only firing on DRAFT→APPROVED transitions; now fires on POST (so a PDF exists in Drive the moment Josh hits Create) and on any subsequent PATCH that touches lines/notes/vendor info or transitions into SENT. Skipped for CANCELLED / CLOSED.'},
        {t:'fix', d:'**Send always saves first.** `sendPo()` previously skipped saving when the PO already existed, so edits sitting in the modal would not make it onto the SENT version. Now always calls savePo() before transitioning + opening the mailto draft.'},
      ]
    },
    {
      v:'1.49.1', date:'May 28, 2026', tag:'log',
      changes:[
        {t:'add', d:'**Reference vendor seed script for trial.** Added `scripts/seed-test-vendors.js` — a browser-console-paste IIFE that loads the three example vendors from the old Excel POs (Bertelkamp Automation, Carpenter, AJ Nonwovens-Hampton/Foss) into the new vendor catalog, complete with the ~20 catalog items they carry (extrusions, foam sheets, Duralock rolls, etc.). Idempotent — re-runs PATCH the existing rows instead of duplicating. Paste into DevTools console at `/vendors` while logged into staging to populate. No runtime change.'},
      ]
    },
    {
      v:'1.49.0', date:'May 28, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**WR PO System — Phase 1 part 2: Vendor PO builder.** New `/vendor-pos` page (Vendor POs nav link added across all 9 dashboards). Click "+ New PO" → pick a vendor from the dropdown → all vendor info auto-fills (address, contacts, send-to emails, freight + payment terms, standing notes) → the vendor&rsquo;s catalog appears as a checkable table. Tick items to add them to the PO; default qty + unit price prefill from the catalog and stay editable in the lines table below. "+ Add Custom Line" handles one-off items. Save creates the PO as DRAFT with a `WV-{YY}{MM}{DD}{NN}` number. Lifecycle: DRAFT → APPROVED (Josh self-approves, status flip is the audit trail) → SENT (opens mailto:vendor.send_to_emails with the PO link in the body; Josh manually attaches the PDF). Edits after SENT regenerate the PDF and overwrite the Drive file in place via stored `pdf_drive_file_id`. Cancel and Delete (DRAFT only) options. The PO document at `/vpo/:poNumber` is a printable HTML page (vendor block / WhisperRoom ship-to / line items / freight + payment terms / standing notes / sign-off line / billing address) that Puppeteer scrapes to PDF — same pipeline as quotes/invoices/orders. Drive uploads land in `GDRIVE_VENDOR_POS_FOLDER` (env var set in Railway). Backed by new `vendor_pos` table (`vendor_snapshot` JSONB freezes the vendor record at PO creation time so historical POs stay correct even when Josh edits a vendor later). Phase 2 (receive workflow + Kim&rsquo;s invoice match modal + urgency dashboard) lands in v1.50 once Josh has run a few real POs through this.'},
      ]
    },
    {
      v:'1.48.0', date:'May 28, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**WR PO System — Phase 1: Vendor catalog.** New `/vendors` page (Vendors nav link added across all dashboards). Josh can create, edit, and archive vendors here, each with: vendor address, multiple contacts, multiple TO + CC emails, payment terms, freight terms (e.g. Bertelkamp&rsquo;s "Ship COLLECT via ABF Account #189059"), standing notes, billing address override, and an inline catalog editor (SKU, description, MFG, MFG part #, default qty, unit price, price-last-updated date — the last is a free-text hint, no auto-staleness flagging per spec). Backed by a new `vendors` Postgres table (JSONB columns for repeating fields) and a full CRUD API at `/api/vendors`. This is the foundation for the Vendor PO builder coming in v1.49. Audimute AP POs (`supplier_pos` table, `/suppliers` page) are unchanged &mdash; that&rsquo;s a separate sales-rep-oriented drop-ship system.'},
      ]
    },
    {
      v:'1.47.2', date:'May 28, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Final Mile Delivery button repositioned inline with the freight description line.** Final placement: directly right of the "Address auto-filled from ship-to. ABF LTL rate with 25% markup applied." paragraph, right-aligned via flex justify-content:space-between. Dropped the standalone row added in v1.47.1. Modal + email behavior unchanged.'},
      ]
    },
    {
      v:'1.47.1', date:'May 28, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Final Mile Delivery button moved below the freight controls.** v1.47.0 put the button in the upper-right of the Freight Estimate section header; per request, it now sits in its own row above the existing "Delivery &amp; Installation" row, matching that row\'s layout exactly (title + 1-line description on the left, button on the right, divider above). Same modal + email behavior as before. Description: "Optional. ArcBest white-glove inside delivery quote (2-man, room of choice, stairs)."'},
        {t:'ui', d:'**Final Mile email copy tweaks:** opening line changed from "Good morning" to "Hello"; subject changed from "Final Mile Quote Request — {custName} — {city}, {state}" to "WhisperRoom FM RFQ".'},
      ]
    },
    {
      v:'1.47.0', date:'May 28, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Final Mile Delivery quote request button in the Quote Builder.** New "Final Mile Delivery" button in the upper-right of the Freight Estimate section header. Opens a small modal asking for box count (the only thing the system can&rsquo;t know automatically), then drafts a mailto: to <code>finalmile@arcb.com</code> with pallet dimensions (from BOOTH_DATA per line item), total weight, freight Class 100, Origin 37813, the customer&rsquo;s ship address, and the standard Final Mile services line (2 man, 45 mins, SS, arrival notice, liftgate, inside delivery to room of choice, 2 flights of stairs max, dunnage removal). Same style + behavior as the existing "Request Installation" button below it. Pre-flight requires line items + a complete ship address; no HubSpot push needed since the email doesn&rsquo;t carry a quote link.'},
      ]
    },
    {
      v:'1.46.14', date:'May 28, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**HubSpot invoice creation: block ACH-only invoices over $100k.** HubSpot caps ACH at $100k per transaction (CC: $250k); the draft&rarr;open transition on ACH-only invoices over $100k fails with "the total amount exceeds the maximum allowed," leaving a "WR-DRAFT" orphan with a dead Pay Now link (404). New red warning in the Create Invoice modal fires when the quote total is >$100k AND Credit/Debit Card is unchecked; Create button is disabled until CC is re-enabled. CC being in the allowed methods lifts the cap &mdash; customer doesn&rsquo;t have to use it. Alt workaround per HubSpot docs: enable partial payments on the invoice so the customer pays in sub-$100k chunks. Discovered after a $170k quote (Travis) got stuck with CC unchecked.'},
      ]
    },
    {
      v:'1.46.13', date:'May 27, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Marketing — bump per-endpoint row LIMIT so 365d view returns full data.** After v1.46.12 backfilled 7,485 campaign-day rows for the full year, the 365d dashboard view still showed only $248k of spend vs HubSpot\'s $346k. Root cause: `/api/marketing/campaigns`, `/keywords`, and `/search-terms` all had a hardcoded `LIMIT 5000` in their SQL, leftover from when the table only held 90 days. With 365d in the table, the ORDER BY date DESC kept the most recent 5,000 rows (~227 days at 22 campaigns/day) and silently dropped the older ~138 days. Bumped `/campaigns` to LIMIT 50000, `/keywords` and `/search-terms` to LIMIT 200000 — well above any realistic 365d footprint. No re-sync needed; the data is already in the table, this just sends more of it to the browser. After this fix the 365d Total Spend should reconcile to ~$346k, First-Touch ROAS to ~2.2x (HubSpot reports 1.97x — within 12%, the residual is deal-window definition differences between `createdate` vs `closedate`).'},
      ]
    },
    {
      v:'1.46.12', date:'May 27, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Marketing — fix the window mismatch that inflated 365d True ROAS by ~4x.** The dispatcher in `marketing/router.js` had Google Ads ETL defaulting to 90d while HubSpot defaulted to 365d. When the v1.46.11 date-range picker drove the dashboard\'s 365d view, queries returned 365 days of revenue but only 90 days of Google Ads spend (because that\'s all the table had). Result: True ROAS = 365d-rev / 90d-spend, ~4x inflated. Cross-checked against HubSpot\'s "First ad interaction" report: ours showed 7.85x first-touch, HubSpot showed 1.96x (96% ROI) — a ~4x gap matching the window asymmetry. Bumped Google Ads default to 365d so Sync All pulls a full year and both windows align. Three section titles ("Campaigns / Keywords / Search Terms (last 90 days)") are now dynamic and update with the selected date range — they were hardcoded strings before. Page subtitle updated to say 365 days. **Action required: click Sync All on the dashboard to backfill the 275 days of historical Google Ads data.** ON CONFLICT upserts keep the longer pull idempotent — no risk of duplicates against existing 90-day rows.'},
      ]
    },
    {
      v:'1.46.11', date:'May 27, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Marketing dashboard — date range selector + sortable columns.** Pill-style date range bar above the cards (`Last 14d / 30d / 90d / 180d / 365d`, default 90d) drives `?days=N` on all six marketing endpoints, so the entire dashboard re-queries when the range changes. KPI card labels + the attribution coverage panel title update dynamically to reflect the selected range. Heads-up text notes that the Google Ads ETL defaults to 90 days so 180d/365d won\'t show extra data without a longer sync. All three data tables (Campaigns, Keywords, Search Terms) now have sortable column headers — click any header to sort by it; click again to flip direction; the active column shows ▲/▼. Default sort stays "Spend desc" so existing reading patterns survive. Derived columns (CPC, CPA, GA4 ROAS, True ROAS) are pre-computed so sorting works on them too. The 200-row cap on Keywords + Search Terms now applies AFTER sort, so sorting by Revenue lets you see the top-revenue terms even if their spend is low. Six endpoints accept `?days=N` (bounded [1, 730]); helper `_parseDays(req)` extracts it from the URL.'},
      ]
    },
    {
      v:'1.46.10', date:'May 27, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Audimute PO header now uses the WhisperRoom SVG logo.** The supplier PO page (`/po/:poNumber`) was using a text-styled "WhisperRoom" header element; swapped it for the same inline SVG logo the quote + invoice pages use. The `.logo-img` styling was already present in the PO template (40px desktop / 28px mobile), just no `<img>` element was being rendered. No other PO content changed.'},
      ]
    },
    {
      v:'1.46.9', date:'May 27, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Marketing — search-term-level closed-loop attribution.** The 2026-05-27 diagnostic revealed HubSpot stores the literal search term users typed in `first_source_data_2` (e.g. "sound booth", "vocal booth", "audiology booth") — previously thought to be a gclid. That unlocks per-keyword closed-loop ROAS for free: just JOIN on the normalized term. New endpoint `/api/marketing/search-term-attribution` returns leads / deals / revenue / True ROAS per search term, mirroring `/api/marketing/campaign-attribution`. Search Terms table on `marketing-dashboard.html` now shows four new columns alongside the existing Spend / Clicks / CPC / Conv. / CPA — same color-coded True ROAS pill as the Campaigns table. PAID_SEARCH only (organic-search keyword attribution would need referrer parsing on the HubSpot side, which we don\'t pull). No aliases applied — search terms are user-typed strings, nothing to alias.'},
      ]
    },
    {
      v:'1.46.8', date:'May 27, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Marketing — recover $17.3k of unattributed paid spend via campaign alias map.** v1.46.7 fixed the JOIN but left two big-spend campaigns showing $0 attribution: `**LP General (US/CAN) - Combined` ($9.5k 90-day spend) and `**LP Testing (US/CAN) - Combined` ($7.8k). Root cause: Google Ads renamed the A/B variants into a single "Combined" parent, but HubSpot retains the campaign name at first touch — so historical contacts still carry `**lp general (us/can) - b` and `**lp testing (us/can) - a`. Added `HUBSPOT_CAMPAIGN_ALIASES` map at the top of `marketing/router.js` (2 entries today, extend as more campaigns rename); injected into the campaign-attribution JOIN via `unnest($1::text[], $2::text[])` CTE so the list stays in JS and the SQL stays generic. Expected recovery: ~514 historical contacts now route to the right campaign, unlocking visibility on whether those two campaigns are actually profitable.'},
      ]
    },
    {
      v:'1.46.7', date:'May 27, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Marketing — per-campaign attribution columns now actually populate.** v1.46.1\'s JOIN matched HubSpot contacts to Google Ads campaigns via `first_source_data_2 = campaign_name` filtered to `first_source_data_1 = google` — but HubSpot doesn\'t store either of those fields the way we assumed. Diagnostic against 22,534 contacts proved: for PAID_SEARCH contacts, `first_source_data_1` holds the campaign name (lowercased) and `first_source_data_2` holds the search keyword. The `data_1 = google` filter was eliminating everything. Rewrote the JOIN to match `LOWER(REPLACE(first_source_data_1, \'+\', \' \'))` against the campaign name (handles case + the "+" vs space difference in "Office Booth - Privacy + Competitors"). Dropped the dead `first_converting_campaign` branch (only 25 of 22,534 contacts have it set). Known gap: campaigns renamed in Google Ads (A/B variants merged into "Combined") leave ~500 historical contacts unmatched — would need a manual mapping table to recover.'},
        {t:'add', d:'**True ROAS split into First-Touch and Any-Touch.** Previous single ROAS card filtered on `first_source IS NOT NULL OR gclid IS NOT NULL` — but `first_source` is set on 100% of contacts, so it was effectively counting ALL revenue, not paid revenue. Headline 9.14x was misleading. Now two cards side by side: First-Touch (`first_source = PAID_SEARCH`, matches HubSpot\'s "First ad interaction" report — most conservative) and Any-Touch (`first_source = PAID_SEARCH OR gclid IS NOT NULL`, matches Google Ads\' default last-click attribution — catches customers who first found us via organic but did click an ad along the way). Showing both surfaces a strategic signal: if First-Touch < 1x but Any-Touch > 3x, paid is profitable as a closer, not as an acquisition channel. The gap between the two IS the information. Closed Revenue card now shows any-touch paid revenue (was: all-source revenue). New API fields on `/api/marketing/attribution-coverage`: `revenue_first_touch`, `deals_won_first_touch`, `revenue_any_touch`, `deals_won_any_touch`.'},
      ]
    },
    {
      v:'1.46.6', date:'May 27, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Payment chip now reads HubSpot\'s actual funds-deposited date.** HubSpot exposes `hs_payout_date` on Commerce Payments — null until settlement completes, then populated with the real bank-deposit date (the "Funds deposited to account ****X" event in the HubSpot UI). We now pull this through the webhook + 30-min poll into a new `actual_payout_date` column on `deal_payment_status` and surface it as `actualPayoutDate` in the deal payment info. Chip priority order rewritten: (1) failed → red, (2) actualPayoutDate set → green "✓ Funds deposited", (3) card + succeeded → green "✓ CC Paid", (4) ACH + estimated payout date → yellow "ACH clearing · funds X", (5) ACH otherwise → yellow "ACH initiated". This replaces the v1.46.5 "past estimated date → green" heuristic — that was a workaround for not having the real signal, and would have flipped chips green prematurely when HubSpot hadn\'t yet confirmed deposit. Now the green chip only appears when HubSpot says funds are actually in the bank. DB: idempotent `ADD COLUMN IF NOT EXISTS actual_payout_date DATE` on `deal_payment_status`. Failure to populate (e.g. the column is null because the poll hasn\'t caught up) gracefully falls through to the yellow clearing state.'},
      ]
    },
    {
      v:'1.46.5', date:'May 27, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**ACH chip flips to green on the payout date, not when HubSpot says succeeded.** Previously the green "✓ Funds available" chip required `hs_latest_status === succeeded` AND past payout date. In practice HubSpot\'s status lags real bank availability by hours-to-days — the chip would stay yellow ("ACH clearing · funds 5/27") even after the funds actually hit our account. New rule: once we\'re past the estimated payout date and the payment isn\'t marked `failed`, treat funds as available. Failed always wins (red chip is checked first), so the safety property is preserved. Justification: HubSpot calibrates the estimated payout date to land AFTER the ACH return window, so absence of a `failed` flip by that date is a strong signal funds actually cleared.'},
      ]
    },
    {
      v:'1.46.4', date:'May 27, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Invoice cards mirror the deal-card payment chip.** When a HubSpot invoice is paid, the row in the right-side hub panel now shows the same processor chip the deal card already shows (`✓ CC Paid` / `💳 ACH clearing · funds 5/27` / `✓ Funds available` / `🚨 Payment failed`) instead of a generic green "✓ Paid" badge. Falls back to "✓ Paid" when there\'s no mirrored payment data (e.g. Stripe-paid invoices, which still also show the Stripe channel badge). Also dropped the redundant tiny "ACH"/"CC" badge that sat next to "Paid" — the new chip carries that info.'},
        {t:'ui', d:'**Payment chip: bank name + last-4 dropped from all chip variants.** The `· Bank ...1234` suffix has been removed from every chip (`CC Paid`, `ACH clearing`, `Funds available`, `Payment failed`) on both deal cards and invoice rows. The full processor detail still lives in HubSpot if needed.'},
        {t:'fix', d:'**CC Paid chip no longer requires last-4 to render.** The card-succeeded branch was gated on `pi.last4` — when HubSpot didn\'t populate `hs_payment_method_last_4` on a payment (some processors omit it), the chip was suppressed entirely even though the deal was clearly paid via card. Now any card + succeeded state surfaces the chip. Fixes the case observed earlier today where a CC-paid HubSpot invoice didn\'t show the green chip on its deal card.'},
      ]
    },
    {
      v:'1.46.3', date:'May 27, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Deal Hub: rep filter and deal-card clicks now feel instant.** Two perceived-latency wins on the board. (1) **Rep filter is now client-side.** Switching reps previously re-fetched `/api/deals/list` from the server, which round-tripped HubSpot search (~1–3s). All deals are already in the browser\'s `allDeals` array (loaded once on page open, refreshed every 60s), so the rep dropdown now filters that array in-memory via `applyFilter()` — zero network. The 60s auto-refresh pulls all reps so the cache stays comprehensive. (2) **Deal cards paint instantly from cache.** Clicking a card previously showed "Loading…" while waiting for `/api/deals/:id/hub` (~1–2s, 5 parallel HubSpot + DB queries). Now the right panel renders immediately from the cached board data (name, amount, stage, payment chips, pipeline, action buttons) — the quotes/invoices/orders sections show "Loading quotes…" until the fetch returns, then fill in. Race-condition guard added: if a user clicks deal B before A\'s fetch returns, A\'s response is discarded. Pure UI perf — no API or behavior changes.'},
      ]
    },
    {
      v:'1.46.2', date:'May 27, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Process Order email: CC Josh on custom-build orders.** When an order has the CUST badge (custom wall component, hole, or other custom work — flagged by `garyFlag`), the Process Order email already CCs `gamos@whisperroom.com`; now also CCs `jfletcher@whisperroom.com` (Josh) so he sees the same context Gary does. Applied in both surfaces that trigger Process Order — the Quote Builder (`quote-builder.html`) and the Deal Hub overlay (`deals-dashboard.html`). Non-CUST orders are unchanged.'},
      ]
    },
    {
      v:'1.46.1', date:'May 26, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Marketing dashboard — closed-loop attribution shipped + visual polish.** Two new endpoints: `GET /api/marketing/campaign-attribution` joins Google Ads campaigns to HubSpot contacts to HubSpot deals (first-touch attribution via `first_converting_campaign` then `first_source_data_2`, filtered to PAID_SEARCH / google sources, deals not date-filtered so old contacts still attribute when they close). `GET /api/marketing/attribution-coverage` returns the trust thermometer — what % of recent closed-won deals + revenue + contacts have a known marketing source. Campaign table extended with four new columns (Leads / Deals / Revenue / True ROAS) merged in client-side; True ROAS rendered as a color-coded pill (green ≥ 3x, yellow 1–3x, red < 1x) for instant scanning. New attribution coverage panel above the KPI cards (three progress bars: deals attributed, revenue attributed, contacts with a source) with the same color rule (green ≥ 60%, yellow 30–60%, red < 30%). Two new KPI cards (Closed Revenue from real HubSpot deals + True ROAS vs Google Ads spend) added alongside the existing GA4-estimated value/ROAS — both shown so you can compare GA4-assumed to actual-revenue. Single-touch first-touch only (multi-touch would need full event history we don\'t pull); match HubSpot Ads view to "First ad interaction" for apples-to-apples validation. Coverage is bounded by attribution match quality (exact name match on `first_converting_campaign` / `first_source_data_2`) — the coverage panel surfaces gaps.'},
        {t:'add', d:'**HubSpot sync — per-bucket progress logging.** Sync runners now `console.log` per bucket completion (`[hubspot-etl] contacts 3/12 ...: N rows in T s · total=X`) so Railway logs show real-time progress instead of silence. Also writes intermediate `marketing_syncs` rows after each bucket, so the dashboard status count climbs in real time during long syncs rather than staying frozen until the entire multi-hour sync finishes. Addresses the v1.46.0 UX gap where the user had no way to tell if a sync was making progress vs hung.'},
      ]
    },
    {
      v:'1.46.0', date:'May 26, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Marketing dashboard — HubSpot sync now date-bucketed for complete coverage.** v1.44.0 hit HubSpot\'s hard 10,000-result cap on the search API and silently truncated — and because the sort was ascending, we got the *oldest* 10k records and missed the most-recently-modified (i.e. the most attribution-relevant) ones. The fix splits the 365-day lookback into ~30-day buckets (12 per year) and runs each as its own search query — each bucket has its own 10k headroom, so coverage now scales linearly with the lookback window. Real example: WhisperRoom has ~26.6k contacts modified in the last year — under v1.44.0 we got 10k (oldest); v1.46.0 gets all 26.6k across 12 buckets. Sort is now DESCENDING within each bucket, and buckets run newest-first, so the most useful data lands immediately even if the request times out partway through. Bucket errors are recorded but don\'t abort the remaining buckets (partial coverage > no coverage). If any individual bucket ever hits 10k (a viral month, etc.), the sync surfaces a warning via `marketing_syncs.error` so the dashboard reflects the truncation. Applies to both contacts and Sales-Pipeline deals.'},
      ]
    },
    {
      v:'1.45.0', date:'May 26, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Reconcile: refunded deals now included + editable HubSpot deal popup.** Two related fixes on the Accounting → Reconcile page. (1) The HubSpot deal fetch was filtering to `dealstage IN [closedwon, 845719]` only, so any deal moved to the Refund stage (`895819`) never appeared in the reconciler — refunded deals can now be matched against their QB refund_receipts. (2) Clicking a HubSpot row in the reconcile table previously opened a read-only detail popup; the six HubSpot deal properties (Date, Ship State, Freight, Tax Rate, Tax $, Total) are now editable inline with a Save button. Save PATCHes the deal in HubSpot and updates the reconciler table in-place without a full reload. Subtotal + Discount remain read-only because they come from the local quote snapshot rather than the HubSpot deal record.'},
      ]
    },
    {
      v:'1.44.0', date:'May 26, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Marketing dashboard — HubSpot ingestion (first leg of closed-loop attribution).** New `marketing/hubspot-etl.js` pulls HubSpot contacts and Sales-Pipeline deals into two new `marketing_hubspot_*` Postgres tables. Contacts carry the gclid (`hs_google_click_id`), both first-touch (`hs_analytics_*`) and latest-touch (`hs_latest_source*`) attribution pairs, plus lifecycle/lead-status — enough for the attribution layer to choose its model per query without re-syncing. Deals carry stage, USD amount, close date, won/lost flags, days-to-close, and a denormalized `primary_contact_id` resolved via the v4 associations API (preferring labels matching /primary/i, falling back to first associated contact). Sales Pipeline only (`pipeline = "default"`); Test + Ecommerce pipelines excluded as noise. Incremental sync via `hs_lastmodifieddate` filter + cursor pagination, default 365-day lookback for first sync. The existing `Sync All` button now refreshes everything (3 Google Ads reports + 2 HubSpot objects); new explicit report types `hubspot_contacts` / `hubspot_deals` / `hubspot_all` available on the `/api/marketing/sync` POST for targeted refresh. Status panel surfaces HubSpot sync timestamps + row counts alongside Google Ads — does NOT block the Sync All button if `HS_TOKEN` is missing (Google Ads can still sync independently). Auth reuses the existing `HS_TOKEN` Railway env var. No new npm deps — uses Node built-in `https`. **No attribution joins or dashboard view changes yet** — that\'s the next PR, once the data is live and Gabe has eyeballed the raw ingestion.'},
      ]
    },
    {
      v:'1.43.0', date:'May 26, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Marketing dashboard — keyword + search-term aggregation views.** The two TODO stubs below the campaigns table (left over from v1.39.0 scaffolding) are now real aggregation tables following the `renderCampaigns` pattern. Keywords aggregate by `keyword_id` and show keyword text, match type, spend, clicks, CPC, conversions, CPA. Search terms aggregate by normalized (lowercased, trimmed) search term and show the same metrics minus match type. Both sort by spend descending and cap the display at the top 200 by spend (full row count still in the section header) — keeps the page responsive when a 90-day pull returns thousands of distinct keywords. ROAS isn\'t shown for either since `conversion_value` is a campaign-level metric in Google Ads and isn\'t pulled by the `keyword_view` or `search_term_view` reports.'},
      ]
    },
    {
      v:'1.42.3', date:'May 26, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Bot assistant: catalog PDF URL updated.** The three catalog links in `assistant/system-prompt.txt` (Discovery lead intro, Contact Lead catalog block, vague-Discovery fallback) pointed to the old hyphenated filename. Swapped to the new URL — same HubSpot file host, just no hyphen.'},
      ]
    },
    {
      v:'1.42.2', date:'May 22, 2026', tag:'logging',
      changes:[
        {t:'log', d:'**DEVLOG: full session writeup for 2026-05-22.** Captured today\'s three-thread day — promote sweep clearing yesterday\'s staging backlog (v1.38.2 → v1.39.0 landed on main), marketing dashboard handoff to Gabe + his same-day v1.40.0 Google Ads ETL implementation (and the version-collision rebase), quote expiration indicators (v1.41.0) ahead of the Audimute price-book bump, the unrelated HubSpot file-replacement lockout, and the end-of-day v1.42.0 fix opening up `/marketing` after Gabe\'s ownerId-allowlist rejection. Current focus block updated to reflect today\'s state — four versions sitting on staging (v1.40.0 / v1.41.0 / v1.42.0 / v1.42.1), main still on v1.39.0. Yesterday\'s open EOD items (notification history empty, TaxJar 33104 verification) both confirmed resolved by user during the day.'},
      ]
    },
    {
      v:'1.42.1', date:'May 22, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Marketing sync fixed — `google-ads-api` upgraded v17 → v23.** Every Google Ads sync was failing with `12 UNIMPLEMENTED: GRPC target method can\'t be resolved`. The pinned v17 library targets a Google Ads API version Google has since sunset, so calls died at the gRPC layer before reaching authentication — not an auth or credential issue. Bumped the dependency to `^23.0.0` (current latest, targets a supported API version). No change needed in `marketing/google-ads-etl.js` — the `customer.report()` interface is stable across these versions. Sync now reaches Google; the remaining gate is the developer-token access level (Explorer vs Basic).'},
      ]
    },
    {
      v:'1.42.0', date:'May 22, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Marketing dashboard opened up to all reps (temporary).** Gabe was hitting an ownerId mismatch on the v1.40.0 allowlist (Benton + Gabe only) — until that\'s diagnosed, the page + APIs are accessible to any authenticated user, and the nav link in the Deal Hub topbar shows for everyone. Re-gating is one config change: set `MARKETING_ALLOWLIST` in `marketing/router.js` to a non-empty array of ownerIds. Empty array = open.'},
      ]
    },
    {
      v:'1.41.0', date:'May 22, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Quote expiration indicators across Deal Hub + Quote Builder.** Quotes are now treated as expired 30 days after their save date (matches the "Valid for 30 days" footer on the PDF). New yellow chip (EXP Nd) appears in the last 7 days; red EXPIRED chip after day 30. Shown on (a) each quote card in the Deal Hub right-panel quotes list, (b) each deal card in the main board (suppressed once the deal is accepted/paid/has a payment type — already locked in). When an expired quote is loaded into the quote builder, a dismissable amber/red banner shows at the top of the page nudging the rep to revise pricing. Accepted quotes never trigger the chip or banner — pricing was committed when the customer signed off. Useful for the Audimute price-book bump on 2026-05-22 since pre-bump quotes will roll into "expired" over the next 30 days and the rep gets a visible nudge to refresh.'},
      ]
    },
    {
      v:'1.40.0', date:'May 22, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Marketing dashboard — Google Ads sync is live.** The three ETL runners in `marketing/google-ads-etl.js` (`syncCampaigns`, `syncKeywords`, `syncSearchTerms`) are no longer stubs. `_getCustomer()` builds the `google-ads-api` client from the five `GOOGLE_ADS_*` Railway env vars; each runner pulls a daily-segmented report for the last N days (default 90) — `campaign`, `keyword_view` and `search_term_view` respectively — and upserts into `marketing_campaigns` / `marketing_keywords` / `marketing_search_terms`. Idempotent — re-running the same range overwrites via the composite key on each table. Google Ads API failures (bad credentials, unapproved developer token, wrong customer_id) are caught per-runner and written to `marketing_syncs.error`, so the dashboard status bar shows the reason instead of a bare 500. The "Sync All" button now populates the campaign, keyword and search-term tables in one pass.'},
      ]
    },
    {
      v:'1.39.0', date:'May 22, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Marketing dashboard scaffolding** — new `/marketing` page for Benton + Gabe (allowlisted by ownerId). Isolated to a `marketing/` folder so Gabe can iterate without touching shared app files. `marketing/schema.sql` defines `marketing_campaigns` / `marketing_keywords` / `marketing_search_terms` / `marketing_syncs` tables (auto-created on first load). `marketing/router.js` handles all routes (`GET /marketing`, `GET /api/marketing/status`, `POST /api/marketing/sync`, plus `GET /api/marketing/{campaigns,keywords,search-terms}`). `marketing/google-ads-etl.js` is a stub — fetch logic TODO once Gabe has the developer token + OAuth refresh token. quote-server.js mounts the module via a single `marketingRouter.handle(req, res, ctx)` call early in the request handler. Dashboard page shows status, summary KPI cards, and per-campaign aggregation table. `google-ads-api` npm package pre-installed. Nav link shows on Deal Hub topbar only for the allowlist (Benton + Gabe).'},
      ]
    },
    {
      v:'1.38.6', date:'May 22, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**TaxJar ZIP-rejection fallback actually works now.** v1.37.4 dropped `to_zip` on the retry, which made TaxJar 400 with `"No to zip, required when country is US"` — TaxJar requires to_zip for US shipments. Fixed: retry now SUBSTITUTES the rejected ZIP with a known-good `fallbackZip` per state (FL 33101, TN 37201, TX 78701, etc. — biggest commercial city in each nexus state). Returned rate reflects that fallback ZIP\'s local surtax (e.g. FL 33101 → Miami-Dade 7%, not state base 6%), so approximate but not silent. Banner still surfaces the warning so the rep knows to verify the ZIP. Configured in `lib/states.js` NEXUS_STATES map.'},
      ]
    },
    {
      v:'1.38.5', date:'May 22, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Freight Quote Ref "Open ↗" now uses the same URLs as the Get Freight popup\'s Book Online button.** v1.38.4 used generic tracking pages; the rep correctly pointed out we already had the right URLs in `bookOnlineSelected()` — ABF\'s `https://arcb.com/tools/rate-quote.html#/<quoteId>` deep-link and OD\'s `rate-reference-search.html` page. Manual ABF entries now deep-link directly to the specific quote (no clipboard needed); manual OD entries open the rate-reference-search page + copy the ref to clipboard. Get Freight already-populated entries continue to use the carrier-provided `quoteUrl` from the API response when present.'},
      ]
    },
    {
      v:'1.38.4', date:'May 22, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Editable Freight Quote Ref on the orders drawer.** Field is now always visible (was hidden until Get Freight populated it) and lets reps paste references they got outside the app. New carrier picker (ABF / Old Dominion) sits next to the reference input. Open ↗ button copies the ref to the clipboard and opens the carrier\'s tracking page (`arcb.com/tools/tracking.html` for ABF, `odfl.com/...ship-ltl-freight.html` for OD). Get Freight still pre-populates with the carrier-specific deep-link as before. Saves to the existing `order_data.freightRef` slot — no schema change.'},
      ]
    },
    {
      v:'1.38.3', date:'May 22, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Overdue-ship-date sweep:** background poller runs every 6h (plus 2 min after startup) checking `supplier_pos` rows where `expected_ship_date < CURRENT_DATE`, `tracking_number IS NULL`, and `status NOT IN (complete, cancelled)`. Each match fires a `po-overdue` notification to Jill + Benton (`⏰ PO past ship date — <deal>`). De-duped via new `overdue_notified_at` column on `supplier_pos` (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, no migration needed). PATCH endpoint clears the stamp when `expected_ship_date` or `tracking_number` is updated so the sweep can re-fire if the new date also goes by without tracking.'},
      ]
    },
    {
      v:'1.38.2', date:'May 22, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Audimute PO: auto-status transitions + tracking widget + notification fan-out.** (1) `/api/supplier-pos/:poNumber` PATCH now auto-advances status when the rep doesn\'t set one explicitly: setting `expected_ship_date` from a pending/sent PO → `confirmed`; setting `tracking_number` from anything less than shipped → `shipped`. Logged as `auto: true` change-log entries so the timeline shows what triggered the transition. (2) Suppliers-dashboard tracking column gets a 📦 button (only visible when tracking_number is set). Click opens a popover showing the tracking number + a status pill ("In Transit" if shipped, "Delivered" if complete) + a "🔍 Open in Google" link (auto-detects carrier via search) + a "✓ Mark Delivered → Complete" button when status is `shipped`. (3) Process-order with AP items now notifies BOTH Jill and Benton (was Jill only); new notification trigger on PO creation fires the same Jill+Benton pair so they get a paper trail when the PO is generated.'},
      ]
    },
    {
      v:'1.38.1', date:'May 22, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Clicking a quote from Deal Hub no longer pops a "Load X? This will replace your current quote." confirm.** The quote builder\'s `loadFromHistoryEntry()` was firing the confirm on every load, including the URL-param entry from Deal Hub where the page is fresh and there\'s nothing to replace. Now gated on `skipClose` — same flag we already use to signal "called from Deal Hub / URL-param load, not from the in-page History panel". Clicks from the in-page History panel still confirm so the rep doesn\'t accidentally overwrite unsaved work.'},
      ]
    },
    {
      v:'1.38.0', date:'May 22, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**New payment type: "Shopify".** Available everywhere the existing payment types live: Quote Builder Process Order modal (both quote-builder.html block instances), Deal Hub Process Order modal, Deal Hub Modify Order modal, and the admin Payment Method override dropdown. Server-side: added to the validation list in `/api/orders/:q/add-charge`, the PAY_TYPE_HS_VALUES map (in both spots that have it), and every internal label dict. Card chip shows `✓ Shopify` in green (same treatment as HS / CC / ACH / Other — all paid types). Behaviorally identical to other paid types — sets `payment_status=paid` on the HubSpot deal, creates the QB invoice + auto-payment. Requires a matching "Shopify" option on the HubSpot deal `payment_type` enum field (user is adding that separately).'},
      ]
    },
    {
      v:'1.37.14', date:'May 22, 2026', tag:'ui',
      changes:[
        {t:'add', d:'**Payment-status chip now mirrors into the Deal Hub right panel.** When a deal is selected, the ACH-clearing (amber) / Funds-available (green) / Payment-failed (red, pulsing) chip — same `renderPaymentChip(deal.paymentInfo)` that drives the deal-card chip — also renders next to the other badges in the hub header meta row. Was previously only visible on the card; now visible inside the open deal too so the rep doesn\'t have to glance back at the board to see ACH state.'},
      ]
    },
    {
      v:'1.37.13', date:'May 22, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Deal Hub default view is now always "All Reps" — no more auto-switch to your own deals ~15s after page load.** `loadCurrentUser()` was setting the rep dropdown to the logged-in user\'s ownerId once `/api/me` returned, which is why the board would change view a few seconds after opening. Removed that block; the dropdown stays on "All Reps" until the rep explicitly picks a name. Admin log button visibility is unchanged.'},
      ]
    },
    {
      v:'1.37.12', date:'May 21, 2026', tag:'log',
      changes:[
        {t:'log', d:'**DEVLOG: full session writeup for 2026-05-21.** Captured today\'s 30-version run across notification system end-to-end (v1.37.0–v1.37.11), Closed Lost hideable toggle column (v1.36.x), AP/Audimute PO freight charges in the suppliers dashboard, the hang-tab SKU `AHDAC000482` line item, Modify Order line items + Own Shipping, the Save-Changes-silently-ships bug fix (v1.34.5), TaxJar city/state fallback for retired ZIPs, the `/promote` no-confirmation tweak, and the self-inflicted v1.37.9 backtick-broke-the-bell incident. Current focus block flags the open history-empty issue for tomorrow.'},
      ]
    },
    {
      v:'1.37.11', date:'May 21, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Notification confirm + read-all endpoints now lazy-hydrate the session** (matching the GET endpoints from v1.37.2). Previously a rep whose session hadn\'t been hit GET-side first would get a silent `{success: false}` on confirm — the UI removed the notification from the active list optimistically, but the DB row stayed unread, so the next poll brought it back and history never picked it up. Also: confirm endpoint now returns `rowsUpdated` count so we can detect no-ops in future diagnostics.'},
      ]
    },
    {
      v:'1.37.10', date:'May 21, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Notification bell came back from the dead.** The v1.37.9 light-mode CSS comment in `/assets/notif-bell.js` had literal backticks around `:root.light` — inside a JS template literal that holds the CSS string. The backticks terminated the template literal early, the rest of the file parsed as a syntax error, the script never ran, and the bell vanished from every page. Replaced the backticks with plain text in the comment. Lesson: don\'t put backticks inside a backtick-delimited template literal, even in CSS comments.'},
      ]
    },
    {
      v:'1.37.9', date:'May 21, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Notification dropdown: light mode styling.** The shared `/assets/notif-bell.js` snippet had hardcoded dark colors that looked rough on the light theme — `#1a1a1a` panel on a white page, etc. Added `:root.light` overrides for the dropdown panel surfaces, text colors, card borders/backgrounds, links, and footer. Bell button + badge in the topbar stay dark since the topbars themselves stay dark in light mode.'},
      ]
    },
    {
      v:'1.37.8', date:'May 21, 2026', tag:'log',
      changes:[
        {t:'log', d:'**DEVLOG bookkeeping.** Current focus reflects v1.37.7 on prod (Jeromy process-order trigger + REP_EMAILS sync). Staging clean.'},
      ]
    },
    {
      v:'1.37.7', date:'May 21, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Notification session hydration: synced `lib/notify.js` REP_EMAILS to match the real login emails.** The two REP_EMAILS maps in the codebase had drifted — `lib/notify.js` had placeholder/guessed values (`sarah@whisperroom.com`, `jill@whisperroom.com`, `travis@whisperroom.com`, `gabe@whisperroom.com`, etc.) while `orders-dashboard.html` had the real production emails (`ssmith@`, `jholdway@`, `tsingleton@`, `gabrielwhite@`, etc.). The v1.37.4 hydration fallback uses lib/notify.js, so Sarah\'s session (email `ssmith@whisperroom.com`) couldn\'t resolve to owner `38143901` because notify.js only had `sarah@`. Synced lib/notify.js to mirror the orders-dashboard map. All reps\' sessions now hydrate correctly on the first notification API hit.'},
      ]
    },
    {
      v:'1.37.6', date:'May 21, 2026', tag:'add',
      changes:[
        {t:'add', d:'**Notification: new "order processed" trigger for Jeromy.** Every successful `/api/process-order` now fires `createNotification(JEROMY_OWNER_ID, \'order-processed\', ...)`. Title carries flag chips (`· RM` / `· CUST` / `· INTL`) so he can spot long-lead-time or international orders at a glance. He was previously only notified on order-modified addendums (after the fact); now he sees the order the moment a rep processes it.'},
      ]
    },
    {
      v:'1.37.5', date:'May 21, 2026', tag:'log',
      changes:[
        {t:'log', d:'**DEVLOG bookkeeping.** Current focus reflects v1.37.4 on prod (notification system + TaxJar ZIP fallback). Staging clean. v1.37.0–v1.37.4 session detail collapsed into a `<details>` block for the next session to skim.'},
      ]
    },
    {
      v:'1.37.4', date:'May 21, 2026', tag:'fix',
      changes:[
        {t:'add', d:'**Tax: auto-fallback to city/state-level rate when TaxJar rejects the ZIP.** When TaxJar 400s with `"to_zip X is not used within to_state Y"` (e.g. FL ZIP `33104` — retired or business-only), `lib/taxjar.js` automatically retries the same request without `to_zip` (and without `to_street`, which is meaningless without a ZIP). TaxJar then returns a city/state-level rate. Result carries `usedStateFallback: true` + a `fallbackReason` message. Quote builder shows a yellow info banner under the tax result: "⚠ Using city/state-level rate — ZIP not recognized, local surtax may be slightly higher. Override below if you know the exact rate." Rep no longer dead-ends on retired ZIPs.'},
        {t:'fix', d:'**Notification session hydration: fall back to local REP_EMAILS map when HubSpot Owners API misses.** v1.37.2 added lazy-hydration of `session.ownerId` via HubSpot Owners API by email. Observed in testing: HubSpot Owners can miss when the Owner record\'s stored email differs in casing from the session email. Now `_hydrateSessionOwnerId` falls back to a reverse case-insensitive lookup in the hardcoded `REP_EMAILS` map (`lib/notify.js`) — which is our source of truth for notification routing anyway. Session ownerId now resolves for any rep with an email in REP_EMAILS, regardless of HubSpot Owners API state.'},
      ]
    },
    {
      v:'1.37.3', date:'May 21, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Tax calculation: surface TaxJar\'s actual error message instead of "Bad Request".** When TaxJar rejects an address (e.g. ZIP `33104` returned `"to_zip 33104 is not used within to_state FL"`), `lib/taxjar.js` was throwing away the explanation and only returning `res.body.error` which is just the HTTP status text ("Bad Request"). Swapped to prefer `res.body.detail` so the rep-facing error translation regex (which looks for `/zip|postal/i`) now catches it and shows the friendly "Invalid ZIP code — please verify the ship-to ZIP and try again." instead of a generic failure.'},
        {t:'fix', d:'**Tax: in-nexus but 0% TaxJar result no longer silently hides the result box.** Previously `renderTaxResult()` early-returned if both `rate` and `tax` were 0, so the rep saw nothing on the page and assumed the button didn\'t work. Now it shows a yellow warning: "TaxJar returned 0% for FL on this address — add the ship-to city and re-run (some ZIPs need a city to disambiguate). Or enter tax manually below." Truly empty state (no fetch yet) still hides as before.'},
      ]
    },
    {
      v:'1.37.2', date:'May 21, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Notifications: auto-heal sessions that have a NULL ownerId.** Sessions created before the owner_id login mapping (or where the HubSpot Owners API was rate-limited at login) had `session.ownerId = null`, which made `/api/notifications` return an empty list even though notifications were correctly being inserted for that rep\'s HubSpot owner_id. Now the notification endpoints lazy-hydrate the session: on the first hit with a missing ownerId, do a one-shot HubSpot Owners lookup by `session.email`, stamp the result onto both the in-memory cache and the DB sessions row, and continue. No more logout/login dance.'},
      ]
    },
    {
      v:'1.37.1', date:'May 21, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Notification system: tighter polling + owner-id fallback + debug endpoint.** (1) Bell poll dropped from 60s → 30s, and now also refreshes on tab focus / visibility change so accepting a quote in one tab then switching back shows the badge immediately. (2) Accept-quote notification now falls back to `quotes.rep_id` when HubSpot doesn\'t return a `hubspot_owner_id` on the deal — was silently dropping notifications when the HubSpot owner property was missing. (3) `lib/notify.js` logs every `createNotification` call (success + skipped reasons) so Railway logs surface trigger problems. (4) `GET /api/notifications/debug` returns session info + the rep\'s 10 most-recent notifications (read + unread) + the latest 5 across all reps — hit it in your browser to verify the loop end-to-end without needing Railway log access.'},
      ]
    },
    {
      v:'1.37.0', date:'May 21, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Notification system, end-to-end.** Bell icon on every internal dashboard (Deal Hub, Orders, Shipping, Reports, Suppliers, Reconcile) — green badge + pulsing border when you have unread notifications. Click → dropdown listing your active notifications with a **✓ Confirm** button per row (sole way to clear a notification from the active list — clicking "Open →" navigates without confirming so you can revisit). **View history →** link swaps the active list for previously-confirmed notifications (latest 200). New shared snippet at `/assets/notif-bell.js` — drop a `<div id="notifBellMount"></div>` into any page topbar to enable it. Was a half-built skeleton (table + API existed, only orders dashboard surfaced it, no Confirm UX, no history); this commit finishes the system and unifies it across all pages.'},
        {t:'add', d:'**New notification triggers:** (1) Order processed with an Acoustic Package → notifies Jill (`36330944`) "🎨 Audimute PO needed — create + send from the Suppliers tab" so she doesn\'t have to manually check the suppliers dashboard. (2) Stripe `payment_intent.processing` webhook → notifies the owning rep "🏦 ACH payment initiated — funds typically clear in 3-5 business days" — fires when the customer commits to paying ACH, not just when funds settle (the existing `invoice.paid` notification still fires when ACH clears).'},
        {t:'add', d:'**New API endpoints:** `GET /api/notifications` now returns *unread only* (was: all 50). `GET /api/notifications/history?limit=200` returns confirmed (read=true) notifications, backing the history view. `POST /api/notifications/:id/confirm` is the new explicit confirmation endpoint (legacy `POST /api/notifications/:id` still works — same handler). Confirm scope is locked to the session\'s owner so a rep can\'t confirm another rep\'s notification by guessing IDs.'},
        {t:'log', d:'**Stripe webhook event subscriptions needed.** For the ACH-initiated notification to fire, the Stripe Dashboard webhook endpoint at `/api/stripe/webhook` must subscribe to `payment_intent.processing`. Existing subscriptions (`invoice.paid`, `invoice.payment_failed`, `invoice.voided`) are unchanged.'},
      ]
    },
    {
      v:'1.36.6', date:'May 21, 2026', tag:'log',
      changes:[
        {t:'log', d:'**DEVLOG bookkeeping.** Current focus reflects v1.36.5 on prod (Closed Lost toggle column + PO freight UI in suppliers-dashboard). Staging clean.'},
      ]
    },
    {
      v:'1.36.5', date:'May 21, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Removed the dead freight UI from the Deal Hub AP PO modal.** v1.35.1 → v1.36.2 had added Additional Charges inputs to the wrong modal (deals-dashboard.html). v1.36.4 put the real working version in the suppliers-dashboard modal where reps actually edit POs. This commit deletes the orphaned UI + JS + payload wiring from the Deal Hub side so there\'s only one freight code path. Server-side handling and the suppliers-dashboard UI are unchanged.'},
      ]
    },
    {
      v:'1.36.4', date:'May 21, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Additional Charges (freight) section added to the SUPPLIERS DASHBOARD edit modal — which is where reps actually work.** Earlier versions (v1.35.1 → v1.36.2) had been wiring the freight inputs into the Deal Hub\'s AP PO modal, but reps almost always edit POs from `/suppliers` not the Deal Hub. The suppliers-dashboard edit modal (Edit button on each PO row) now has an "Additional Charges" section above Notes with a "+ Add Charge" button. Click it → reveals Amount + Description inputs → Save → freight saved to `po_data.freight` and renders on the customer-facing `/po/:poNumber` as a Freight row in the totals. "× Remove Charge" clears the freight on next save.'},
      ]
    },
    {
      v:'1.36.3', date:'May 21, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Closed Lost button glow now green + consistent (no longer flickers off when the main board returns hits).** Previously the glow rule required main board to have zero results AND Closed Lost to have matches — so the glow turned on briefly between when the probe returned and when the main search returned, then flipped off if main had any hits. Now the rule is just "Closed Lost has matches AND column is hidden" — the rep gets the signal whenever there\'s something worth revealing, regardless of what the main board shows. Color switched from orange to green (positive "we found something" cue, distinct from the orange Shopify Orders attention-pulse).'},
      ]
    },
    {
      v:'1.36.2', date:'May 21, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**AP PO Edit modal: Additional Charges section moved to sit directly above Notes** (per user request). v1.36.0 had pinned it to the top of the modal under the title; user wanted it adjacent to Notes since both are PO-line additions. Same fields (Freight $ + Description), same `po_data.freight = {amount, description}` schema.'},
      ]
    },
    {
      v:'1.36.1', date:'May 21, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Closed Lost column now squeezes in next to Shipped instead of wrapping to a new row.** The board grid was hard-coded to `repeat(4, minmax(170px, 1fr))` so the 5th column had nowhere to go. Added a `.board.show-closedlost` modifier that switches to `repeat(5, minmax(140px, 1fr))` — the four existing columns shrink ~17% and Closed Lost slots in on the right. Mobile (≤480px) was already a vertical stack, so nothing changes there.'},
      ]
    },
    {
      v:'1.36.0', date:'May 21, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Closed Lost is now a proper hideable column.** New "○ Closed Lost" toggle button in the Deal Hub toolbar (next to "HubSpot Only"). Off by default — board stays clean. Click to reveal the column at the far right, populated with the 100 most recent Closed Lost deals. The button **glows orange** when you type a search and the only matches live in Closed Lost (none on the active board) — visual cue that the deal you\'re looking for is over there, click to reveal. Replaces the v1.35.0 banner + temp-column UX, which was confusing.'},
        {t:'ui', d:'**AP PO modal: freight section moved to the top.** Now lives in a dedicated "Additional Charges" card right under the title bar (above Ship-To), so it\'s the first thing you see when opening Edit. Was previously buried below the items list — easy to miss. Same `po_data.freight = {amount, description}` schema as v1.35.1; the layout is the only thing that changed.'},
      ]
    },
    {
      v:'1.35.1', date:'May 21, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**AP Purchase Orders can now carry a freight charge with description.** New `Freight ($)` + `Freight description` inputs in the AP PO modal (both Create and Edit). Stored as `po_data.freight = {amount, description}`; accepted by both the create POST and the edit PATCH. Customer-facing PO page (`/po/:poNumber`) renders a Subtotal + Freight line when freight is set, with the description inline. Auto-draft Audimute email (from Deal Hub + suppliers-dashboard "Send") includes the freight line in the Order Summary. Change log records freight added/removed/changed events. Use case: Canadian POs where Audimute ships the package and bills WhisperRoom for the leg.'},
      ]
    },
    {
      v:'1.35.0', date:'May 21, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Closed Lost recovery via Deal Hub search.** Deal Hub board still excludes `closedlost` from its default columns (zero noise), but typing in the search bar now ALSO probes Closed Lost server-side. If hits come back, a banner appears under the search box: "🔍 Not on the board, but found 2 deal(s) in Closed Lost matching \'jill smith\' [Show on board →]". Clicking the button injects those deals as a temporary "Closed Lost (search)" column at the far right of the board with muted styling — disappears when search is cleared. Solves the Jill-misclassification case where a deal accidentally sent to Closed Lost vanishes entirely from view with no way to recover it. New endpoint: `GET /api/deals/search-closedlost?q=...` — HubSpot search filtered to `dealstage=closedlost` + DB-by-quote/contact lookup, capped at 20 results, gated at ≥3 chars.'},
      ]
    },
    {
      v:'1.34.6', date:'May 21, 2026', tag:'log',
      changes:[
        {t:'log', d:'**Dev workflow: `/promote` no longer pauses for a confirmation prompt.** Per user preference — the pre-flight already lists what\'s about to land on main, which is enough context. Skill now runs the merge dance directly after stating the commits + proposed merge message. Edited `.claude/commands/promote.md` to remove the "Confirm to proceed?" step. Other guardrails (working-tree-clean check, never force-push to main, halt on upstream divergence) all preserved.'},
      ]
    },
    {
      v:'1.34.5', date:'May 21, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Orders dashboard: Save Changes no longer silently ships the order.** Bug: typing a tracking number in the drawer + pressing Save Changes was merging `shipmentFields.tracking` into `order_data.shipped.tracking` on the server — which is the field the board, calendar, and Tracking tab all read to classify an order as Shipped. So the order moved to the Shipped column without the Ship It modal, email draft, or HubSpot dealstage advance ever firing. Fix: Save Changes now writes draft shipment fields to a separate `order_data.shipmentDraft` slot. The form repopulates from `shipmentDraft.*` (falling back to `shipped.*` for already-shipped orders, then the legacy HS fallbacks). Ship It still writes to `order_data.shipped` and clears the draft. HubSpot deal-property sync (freight_carrier / tracking_number / etc.) still happens on Save — only the dealstage advance was already gated and stays gated behind `markShipped`, which only Ship It sends.'},
      ]
    },
    {
      v:'1.34.4', date:'May 21, 2026', tag:'log',
      changes:[
        {t:'log', d:'**DEVLOG bookkeeping.** Current focus updated post-promote — v1.34.3 is now on prod (AP/Audimute email-flow tweaks + hang tab packs as Audimute PO line item). Staging clean. Captured the Closed Lost search-recovery UX in the "Queued / discussed" section for next session.'},
      ]
    },
    {
      v:'1.34.3', date:'May 21, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Audimute PO: hang tab pack row description now includes the quantity** — reads "16 WhisperRoom Velcro Hang Tab Packs" instead of just "WhisperRoom Velcro Hang Tab Packs". Quantity matches the Qty cell, just spelled out for Audimute\'s readability when scanning the line.'},
      ]
    },
    {
      v:'1.34.2', date:'May 21, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Audimute PO: hang tab packs now render as a dedicated line item in the items table.** Item column = `AHDAC000482` (monospace bold), Qty column = total tab packs across all AP packages on the PO, Description = "WhisperRoom Velcro Hang Tab Packs". Color / Unit Cost / Total dashed since tabs are included in the AP package price (informational, not a billable extra). Pulled the SKU back out of the Panel Totals lower box — the items table is now the authoritative place for it. v1.34.1 put the SKU in the wrong spot; this is what Audimute actually asked for.'},
      ]
    },
    {
      v:'1.34.1', date:'May 21, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Audimute PO: SKU `AHDAC000482` now shown to the left of "Total WhisperRoom Velcro Hang Tab Packs"** on the grand-total row in the Panel Totals section of `/po/:poNumber`. Per Audimute\'s request — lets them scan the SKU at a glance when fulfilling the tab packs. Monospace font, muted gray so it visually separates from the description. (Superseded by v1.34.2 — moved to the items table.)'},
      ]
    },
    {
      v:'1.34.0', date:'May 21, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Process Order shipping email auto-CCs Jill (`jholdway@whisperroom.com`) on any AP-containing order.** Same mechanism as the existing Gary auto-CC for RM / Custom Hole orders: when the order has an AP item (or the rep filled in an AP color), Jill is appended to the CC list on the `shipping@whisperroom.com` mailto draft. She handles the Audimute step downstream, so she needs the same context the shipping team gets.'},
        {t:'add', d:'**Suppliers tab "Send" button now CCs Benton on every Audimute send.** `bentonwhite@whisperroom.com` is added to the mailto CC list when reps click Send (or Resend) on an Audimute PO from the suppliers dashboard. Paper trail without having to dig through the suppliers tab.'},
        {t:'add', d:'**Creating an AP PO from the Deal Hub modal auto-opens the Audimute email draft.** Same as if you hit the suppliers-dashboard "Send" button manually right after — saves a step (you were going to send it next anyway) and keeps the body wording + CC list uniform regardless of where the PO was created. Note: this opens the draft, it does NOT mark the PO as sent — the "sent" mark only fires when you actually click Send from the suppliers dashboard, which has the PATCH side-effect.'},
      ]
    },
    {
      v:'1.33.2', date:'May 21, 2026', tag:'log',
      changes:[
        {t:'log', d:'**DEVLOG bookkeeping.** Current focus block updated post-promote — v1.33.1 is now the most recent on prod (Modify Order line items inline + Own Shipping toggle + T&C cleanup + process-order PDF upsert + global logo redirect). Staging is clean.'},
      ]
    },
    {
      v:'1.33.1', date:'May 21, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Quote builder right-panel summary: "Own Freight" instead of "Not quoted" when Own Shipping is toggled on.** The Freight summary line in the right rail now mirrors the toggle state — pickup fee → "Pickup Fee $X", delivery+install → "Included with install", own shipping → "Own Freight" (italic muted), tbd → "TBD", real freight → "$X", nothing → "Not quoted". Was previously showing "Not quoted" when Own Shipping was on, which read like the rep forgot to quote.'},
      ]
    },
    {
      v:'1.33.0', date:'May 21, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Modified-order line items now show inline on the customer order page.** When you Modify Order and merge a quote in, the addendum\'s actual line items (the products themselves) are appended to the bottom of the main Line Items table with an orange "Added" badge and a left accent stripe — not just summarized in the lower-right "Order Adjustments" block. Credit-memo addendums get red "Credit" badges and red totals. The Order Adjustments block stays put with the full reconciliation (products + freight + tax). Reps no longer have to point customers at the small totals block to see what changed.'},
        {t:'add', d:'**"Own Shipping" toggle in the Freight Estimate area.** Sits next to the TBD button on the quote builder. Click it when the customer is arranging their own carrier — the freight line on the quote/order/invoice changes from "Freight: $X" to "Shipping: Client will arrange own shipping" with no dollar amount, and the total excludes any freight charge. Stored as `freightData.ownShipping = true` so it survives save/load alongside the existing `tbd` flag. Mutually exclusive with TBD (different concept: TBD = "we\'ll quote later", Own Shipping = "we won\'t quote, customer doesn\'t want us to"). Starting a fresh ABF estimate or override automatically clears it.'},
        {t:'ui', d:'**Terms & Conditions cleanup across quote + invoice + order pages.** Removed "Any damage during shipping must be reported within five business days." and the entire "Standard delivery requires recipient to offload boxes from pallet. Standard delivery does not include extra services and fees related to those services such as Liftgate, Inside Delivery, Sort and Segregate and storage fees." paragraph. Added "WhisperRoom is not responsible for any issues or damages related to transportation." Applied to both T&C blocks in the quote builder live-preview AND the customer-facing quote/order/invoice pages on the server, plus the quote builder footer that had the standalone "Standard delivery requires recipient to offload boxes from pallet." line.'},
        {t:'ui', d:'**WhisperRoom logo (top-left of every internal page) is now a link to Deal Hub.** Wraps the logo in `<a href="/deals">` across Deal Hub, Orders, Quotes (quote-builder), Shipping (already had it), Reports, Suppliers, Reconcile, Admin Log, Email Reply, Email Reply Logs, and Changelog. CSS gets `text-decoration:none` so the visual is identical. Customer-facing pages (login, quote/order PDF headers) intentionally NOT changed — those should not redirect customers into the internal app.'},
        {t:'fix', d:'**Process Order now upserts the PDF in the shared orders folder** (find-by-name → overwrite, else create) instead of always creating fresh. Was the missing half of the existing add-charge/void-addendum upsert behavior — if process-order ever ran twice (force re-process, etc.) you ended up with two PDFs of the same name, and subsequent Modify Order regens patched the wrong (older) copy while the visible file stayed stale. One file per order, period.'},
      ]
    },
    {
      v:'1.32.3', date:'May 20, 2026', tag:'log',
      changes:[
        {t:'log', d:'**DEVLOG: full session writeup for 2026-05-20.** Captured today\'s 18-version marathon: Shopify-parts dry-run preview, Email Reply logging + reviewer, Assembly Manual builder (replaces the Excel/VBA workflow), Supplier Spend report (with drilldown + open-in-QB links), Ship Calendar on /shipping with status-aware tiles, plus the Shopify-API auth exploration and the HubSpot workflow rewrite. Current focus block at the top of `DEVLOG.md` updated with open follow-ups for the next session.'},
      ]
    },
    {
      v:'1.32.2', date:'May 20, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Supplier drilldown: filter out payments + add "Open in QB ↗" per row.** Bill Payment / Credit Card Payment / Payment rows are now stripped server-side — reps want to see what was charged to AP, not the entries that paid those bills off. Header now reads "...payments excluded." New "QB" column on each row with an "Open ↗" link that deep-links to the transaction in QuickBooks Online (`app.qbo.intuit.com/app/<type>?txnId=<id>&realmId=<...>`). Type → path mapping covers Bills, Cash/CC Expenses, Vendor Credits, Checks, Journal Entries, Credit Card Credits. Unknown types show a "—" instead. Response now also returns `qbRealmId` so links scope to the right QB company.'},
      ]
    },
    {
      v:'1.32.1', date:'May 20, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Ship Calendar tiles were all stuck on "Pending"** because the lookup against the shipping-board record read `s.status`, but the actual field is `s.trackStatus`. Fixed the status read, and corrected the rest of the field names in the summary popup to match the real shape: `trackDelivered` (not `delivered_at`), `trackEta` (not `eta`), `trackLastEvent` (not `last_event`), `trackUpdated` (not `last_event_at`), and `city`+`state` (no `destination` field). Delivered date now also shows "Signed: <name>" when the carrier returned a signer.'},
      ]
    },
    {
      v:'1.32.0', date:'May 20, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Ship Calendar on the Shipping page.** New sub-tab strip on `/shipping` — "📅 Ship Calendar" (default) and "📦 Tracking" (the existing table). Calendar mirrors the orders-dashboard month view but cross-references each order against the live shipment data so tile colors reflect *current* status, not just shipped-or-not: orange = In Production, blue = In Transit, yellow = Out for Delivery, green = Delivered, red = Exception, gray = Pending/Unknown. Legend strip below the grid explains the colors.'},
        {t:'add', d:'**Shipment summary popup on tile click.** Instead of the heavy edit drawer the Orders page opens, clicking a calendar tile here pops a compact summary card: status badge, MDL(s), pallet count, ship date, carrier + tracking number when shipped, delivery date when delivered, ETA when in transit, destination + last tracking event when available. Footer has "Open in Tracking →" (jumps to the Tracking tab) and "View order ↗" (opens the deal in the orders dashboard in a new tab).'},
        {t:'log', d:'**Calendar auto-refreshes when shipments reload.** Hitting the Refresh button on the Tracking tab now also re-renders the calendar with the new statuses — no need to flip back and forth.'},
      ]
    },
    {
      v:'1.31.3', date:'May 20, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Suppliers tab: "view →" drilldown buttons were dead** because of an HTML attribute escaping bug — `JSON.stringify(name)` returns a string wrapped in double quotes, which broke the surrounding `onclick="..."` attribute the moment any vendor row rendered. Switched the drilldown to `data-vendor-id` / `data-vendor-name` attributes + a single delegate click listener on the table, so vendor names with quotes/apostrophes/anything-weird no longer break the markup.'},
        {t:'fix', d:'**Filter QB\'s "Not Specified" bucket out of the vendor list.** QB tags every Bill/Purchase that has no vendor assigned (sales tax filings, bank fees, journal entries, payroll, credit-card processor payments, etc.) as the literal `Not Specified` — these aren\'t suppliers but were dominating the table at ~47% of total. The QB UI itself hides this row from the same report. Now stripped out of `rows`, but tracked separately as `notSpecifiedTotal` in the response and surfaced in the summary line as "+ $X uncategorized ⓘ" with a hover tooltip explaining what it is. Table percentages are now out of the named-vendor total only.'},
      ]
    },
    {
      v:'1.31.2', date:'May 20, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Assembly Manual: distinguish ADA (full package) from WA UPG (door only).** Per user spec — ADA line item means the full ADA-compatible package (door + Ramp + Elevated Floor), so all three auto-tick. WA UPG means just the Wide Access door alone — no Ramp, no EFP. Previously both triggered the same cascade. Now only `ADA ` line items trigger Ramp + EFP auto-tick; `WA UPG ` ticks just the ADA Door + ADA Size. Also removed the server-side cascade introduced in v1.31.1 — frontend pre-fill is now the source of truth (so WA UPG quotes don\'t get force-included Ramp/EFP).'},
        {t:'ui', d:'**Assembly Manual modal — light mode support.** Modal was hard-coded to dark colors (#1a1a1a surface, white-on-dark text) and looked broken on light theme. Switched all colors to the existing theme CSS variables (`--surface`, `--text`, `--muted`, `--border`, `--accent`). Status box (success/warn/error) now reads cleanly in either theme. Dropdown options force `<option>` background to follow theme so the popup doesn\'t fall back to OS defaults.'},
      ]
    },
    {
      v:'1.31.1', date:'May 20, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Assembly Manual: SNV/ENV models normalize to S/E + skip ventilation.** WhisperRoom doesn\'t ship dedicated "no-vent" manuals — an MDL XXXX SNV uses the same Cover/Series/EFP/etc PDFs as the vented S variant, and just omits the ventilation pages. `_stripMdlPrefix` now strips `SNV → S` and `ENV → E`, so file matching against names like "4848 S EFP.pdf" works even when the rep picks "MDL 4848 SNV". New `ctx.isNV` flag gates the K + L ventilation sections off for those models.'},
        {t:'fix', d:'**EFP cascade now enforced server-side too.** Frontend already pre-ticks EFP + Ramp when ADA is detected, but the backend now also forces `efp = true` and `ramp = true` whenever `ada` is on — belt-and-suspenders so a direct API caller (or an accidentally unticked checkbox) still gets the right sections. Combined with the SNV/ENV normalization above, this fixes the "EFP not pulling when ADA is on quote" report.'},
      ]
    },
    {
      v:'1.31.0', date:'May 20, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Suppliers tab on Reports (steps 2 + 3 of 3).** New "Suppliers" tab on `/reports` showing QB vendor spend pulled from QB\'s `VendorExpenses` report. Range picker covers YTD, trailing 12 months, this/last month, this/last quarter, and custom date range. Sortable table (Vendor / Total / % of total) with hover rows and a click-through "view →" link on each row that opens a drilldown modal listing every Bill / Cash Purchase / Credit Card Purchase for that vendor in the same range (`TransactionListByVendor` report). Summary line above the table shows date range, vendor count, grand total, and whether the data is fresh-from-QB or 24h-cached. "↻ Refresh" button busts the cache. New endpoint `GET /api/reports/supplier-spend/detail?vendorId=...&range=...` carries the drilldown.'},
      ]
    },
    {
      v:'1.30.4', date:'May 20, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Assembly Manual: EFP / Cover / Series file matching.** Files in those folders are named with the size+variant stem only (e.g. `4848 S EFP.pdf`), NOT the full `MDL ` prefix. Section config now matches on `ctx.modelStem` (the model with `MDL ` stripped) instead of `ctx.model`. EFP, Cover, and Series sections will now actually pull.'},
        {t:'ui', d:'**ADA Size dropdown — always show all 4 options.** Previously cloned from `repWaType` which only populates when an ADA/WA UPG line item is on the quote. Now hardcodes `4016, 4040, 4622, 4646` so reps can build manuals for rooms not currently on the quote.'},
        {t:'ui', d:'**Build button now shows a spinning indicator** instead of just disabling. Modal stays closable during the build — fetch runs async in the background, download still fires when the merge completes. Status text now says so explicitly.'},
        {t:'ui', d:'**Removed the Overseas checkbox + retired the Overseas section** (no longer relevant per user). Backend section F is gone, frontend checkbox is gone, no migration needed.'},
      ]
    },
    {
      v:'1.30.3', date:'May 20, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Assembly Manual modal — form + pre-fill rework.** Removed the "Jack Panel (OLD)" checkbox (not needed). Renamed "EFP (Window)" → "EFP (Elevated Floor Package)" — the underlying Drive files are still EFP*.pdf, just the label was wrong.'},
        {t:'fix', d:'**Assembly Manual pre-fill — actually loop line items with starts-with rules.** Previous detection used loose substring matches and missed common cases (e.g., Studio Light line items that start with "SL "). New rules: `RM ` prefix → Roof Mount; `ADA ` or `WA UPG` prefix → ADA + auto-fill ADA Size from `repWaType` (or first dropdown option as default); `SL ` prefix → Studio Light; `EFP ` prefix → EFP. ADA-triggered cascade: when ADA is detected (or WA Type is set on the quote), Ramp and EFP are auto-ticked too. Substring rules retained for HX, Bass Traps, MJP, Acoustic Package, Step, Expansion.'},
      ]
    },
    {
      v:'1.30.2', date:'May 20, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Supplier-spend: correct QB report name.** v1.28.1 used `ExpensesByVendorSummary` which Intuit renamed to `VendorExpenses` in their API. The old name returns a misleading code-5020 "Permission Denied Error" instead of 404, which sent us down a false trail looking at user roles. Switched to the current names: `VendorExpenses` for the summary and `TransactionListByVendor` for the drilldown. Retest `/api/reports/supplier-spend?range=ytd` — should return real data now.'},
      ]
    },
    {
      v:'1.30.1', date:'May 20, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Move Admin Tools button into the Email Reply output panel.** v1.29.0 put it in the topbar, which is hidden when the page is iframed inside the Deal Hub popup (embed mode) — so admins inside the popup couldn\'t see it. Moved to the bottom-right of the Generated Reply panel, renamed from "⚙ Logs" to "Admin Tools". Visible in both standalone and embedded modes. Still opens the logs viewer in a new tab.'},
      ]
    },
    {
      v:'1.30.0', date:'May 20, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Assembly Manual builder — quote-builder button + modal (step 2 of 2).** New "🛠 Build Assembly Manual" button under the existing action stack on the quote builder. Click → modal opens pre-filled from the current quote: detects the MDL from line items, reads the WA Type as ADA size, and ticks the right checkboxes by scanning line-item names for HX / Studio Light / Bass Traps / EFP / Multi Jack Panel / Acoustic Package / Roof Vent / Ramp / Step / Expansion / Jack Panel. Rep verifies, clicks "Build & Download" → server pulls source PDFs from Drive, merges with pdf-lib, streams the result as a download. Status banner inside the modal surfaces missing-section warnings (e.g., a folder didn\'t have a file matching the expected substring) so the rep can confirm before delivering the PDF to the floor. ADA Size dropdown mirrors the rep WA Type dropdown options exactly — one source of truth.'},
        {t:'fix', d:'**Filter out invalid MDL names from the QB-driven model list.** `/api/assembly-manual/models` was returning typos like "MDL 9696 B" and one-off entries like "MDL 102186 CL Repl" that don\'t map to real assembly-manual variants. Now filtered against the canonical naming pattern: `MDL <digits>` optionally followed by ` LP`, then suffix in {E, S, ENV, SNV}. Anything else is dropped. (Underlying typo still lives in QB — flag with Kim if it bothers anyone there too.)'},
      ]
    },
    {
      v:'1.29.1', date:'May 20, 2026', tag:'log',
      changes:[
        {t:'fix', d:'**Email reply logs viewer — drop the admin gate.** v1.29.0 hid the reviewer behind `ADMIN_REP_EMAILS`. Simplifying: any authed rep can now see the logs (the content is the same email-body text they\'re already typing into the assistant — no extra PII exposure). Removed the env var, the `isAdmin(req)` helper, the page + API gates, and the `__IS_ADMIN__` injection on `/email-reply`. "⚙ Logs" button in the topbar is always visible now.'},
      ]
    },
    {
      v:'1.29.0', date:'May 20, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Email reply assistant — input/output logging + reviewer page.** Every call to `/api/email-reply` now writes a row to the new `email_reply_logs` table capturing: rep info, voice picked, full input, full output, model, token usage (input/output/cache-read/cache-creation), duration, status (`success`/`anthropic_error`/`empty_reply`/`exception`), and any error message. Logging is fire-and-forget so a DB hiccup never blocks the rep\'s reply. New reviewer page `/email-reply-logs` shows the most recent entries with search (substring on input or output), pagination, status chips, token counts, and click-to-expand full-text input/output side-by-side with copy buttons. Admin-only — gated by new env var `ADMIN_REP_EMAILS` (comma-separated). A "⚙ Logs" button appears in the Email Reply topbar for admins (hidden for everyone else); opens the reviewer in a new tab. Feedback capture (thumbs up/down, edited final) is v2 — not in this release.'},
      ]
    },
    {
      v:'1.28.2', date:'May 20, 2026', tag:'log',
      changes:[
        {t:'add', d:'**Assembly Manual builder — backend (step 1 of 2).** Replaces the legacy Excel/VBA workflow that lived in the packing-list software. Three new endpoints: `GET /api/assembly-manual/models` (MDL list from QB, filtered to `Name LIKE \'MDL %\'`, 24h cache), `POST /api/assembly-manual/plan` (dry-run that returns which sections WOULD be included for given options — no Drive reads), `POST /api/assembly-manual/build` (downloads matching PDFs from Drive, merges with pdf-lib, streams response as application/pdf). New module `lib/assembly-manual.js` carries the section config table (~20 sections each gated by checkbox + folder + filename-substring rules) and the merge logic. New helpers `gdriveListFilesInFolder` + `gdriveDownloadFile` in `lib/gdrive.js` (with proper binary-safe download — the existing _httpsRequest string-concats response bodies and corrupts PDFs). New dep: `pdf-lib`. New env var: `GDRIVE_ASSEMBLY_MANUALS_FOLDER` — set this to the Drive folder ID of `Server/AssemblyManuals/` before testing. Step 2 (Build Assembly Manual button + modal on quote builder, with feature pre-fill from quote state) lands next.'},
      ]
    },
    {
      v:'1.28.1', date:'May 20, 2026', tag:'log',
      changes:[
        {t:'add', d:'**Supplier-spend report — backend (step 1 of 3).** New endpoint `GET /api/reports/supplier-spend?range=ytd|12m|month|lastmonth|quarter|lastquarter|custom` returns a flat array of vendors sorted by total spend descending, sourced from QB\'s `ExpensesByVendorSummary` report (covers Bills, cash purchases, credit-card purchases). 24h in-memory cache keyed by date range; bypass via `?refresh=1`. `lib/quickbooks.js` gains a generic `fetchReport(name, params)` wrapper + specific `fetchExpensesByVendorSummary` and `fetchExpensesByVendorDetail` helpers. No UI yet — the tile + range picker + sortable table land in v1.29.0, drilldown in v1.29.1. Test by curling the endpoint while authed.'},
      ]
    },
    {
      v:'1.28.0', date:'May 20, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Create QB Invoice button now does a dry-run preview first.** Click → server builds the full QB payload (Shopify lookup, addresses, line items, totals, memo) but DOES NOT touch QB / Postgres / HubSpot. Returns the assembled payload. Frontend renders it in a confirm dialog so the rep can verify: data source (Shopify canonical vs HubSpot mirror), bill-to + ship-to, every line + amount, total, memo, AND whether a row already exists in shopify_qb_invoices. OK = commit; Cancel = nothing happens. Lets you iterate on a deal without having to clean up Postgres after each test. New request flag: `{dryRun:true}`. Server returns a `preview:true` envelope with the payload.'},
        {t:'fix', d:'**Shopify-parts payment ReferenceError ("Contact name not defined").** Payment privateNote at quote-server.js:3264 referenced `contactName` but the actual variable is `customerName`. Threw `ReferenceError` inside the payment try/catch every time → QB invoice created but payment step ALWAYS failed with that message. One-character rename.'},
        {t:'add', d:'**Surface Shopify-fallback reason in the toast.** When the Shopify lookup fails and the endpoint falls back to the HubSpot mirror (no canonical addresses, no split shipping), the toast now warns: "⚠ Shopify lookup failed (<reason>) — used HubSpot mirror, address/shipping may be incomplete." Response now also returns `dataSource` + `shopifyError`.'},
        {t:'ui', d:'**Trim Create QB Invoice confirm dialog.** Dropped the internal-plumbing lines ("Pull Shopify line items from HubSpot", "Patch HubSpot deal payment_status=paid") and the "Cannot be undone" caveat. Dialog now lists only the two user-facing outcomes.'},
      ]
    },
    {
      v:'1.27.0', date:'May 19, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Shopify-parts QB invoice now uses Shopify as source of truth.** HubSpot\'s Shopify integration only mirrors deal name + total — no customer, address, line items, tax, or shipping breakdown. Without that detail, every auto-invoice was minimal and risked QB tax surprises (the v1.26.5 saga). New `lib/shopify.js` Admin API client. When the rep clicks Create QB Invoice, server parses the Shopify order # from the deal name (regex /#(\\d+)/), fetches the canonical order from Shopify, and builds the QB invoice from THAT: real ship-to + bill-to addresses, customer name + email, itemized line items (mapped by SKU first then product name, fallback to "Shopify Order Line" with original name + SKU in description), shipping as its own QB line (mapped to a "Shipping" or "Freight" item if you have one in QB), tax as its own line at the bottom. Invoice total = exactly what Shopify charged the customer.'},
        {t:'add', d:'**Graceful fallback if Shopify unavailable.** If SHOPIFY_ACCESS_TOKEN/SHOPIFY_STORE_DOMAIN aren\'t set, OR the order # can\'t be parsed from the deal name, OR Shopify returns 404 — the endpoint falls back to the v1.26.x HubSpot-only path (collapsed line for deal.amount). Memo on every invoice carries `[Data source: shopify|hubspot]` so you can tell which path ran. shopifyError surfaces in the memo when the fallback fires.'},
        {t:'log', d:'**Two new env vars** (set on staging + prod already): `SHOPIFY_ACCESS_TOKEN` (Custom App access token from Shopify admin → Develop apps), `SHOPIFY_STORE_DOMAIN` (the canonical xxxxx.myshopify.com URL, not the custom domain). Token scopes needed: `read_orders` (60-day window — sufficient for this flow), `read_customers`, `read_products`. Optional `SHOPIFY_API_VERSION` defaults to 2024-10.'},
      ]
    },
    {
      v:'1.26.5', date:'May 19, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Shopify-parts QB invoice — force zero tax + pass ship-to address.** v1.26.4 created invoices but QB AST was adding TN tax to non-nexus orders because (a) no ship-to address was passed so AST defaulted to the company\'s home state, and (b) line items weren\'t marked non-taxable so `globalTaxCalc:NotApplicable` alone wasn\'t enough to stop it. Three fixes: (1) every QB line now carries `TaxCodeRef: { value: \'NON\' }` (QB\'s built-in non-taxable tax code). (2) BillAddr + ShipAddr are built from the HubSpot contact\'s address (line1/city/state/zip) and passed to createInvoice. (3) TxnTaxDetail = { TotalTax: 0 } as belt-and-suspenders. Invoice total now matches what Shopify charged the customer exactly, no AST surprises.'},
      ]
    },
    {
      v:'1.26.4', date:'May 19, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Shopify-parts auto-invoice: collapsed-line fallback when HubSpot has no line items.** Turns out Shopify\'s HubSpot integration doesn\'t push line-item associations onto deals for small parts orders — only the deal name + amount. v1.26.0 treated no-line-items as a hard error (422 NO_LINE_ITEMS), which made the button always fail for the most common case. Now falls back to a single QB line: Item = "Shopify Order Line", Qty = 1, UnitPrice = deal.amount, Description = deal name (which carries the Shopify order # for cross-reference). Invoice total still matches what Shopify charged. If HubSpot DOES have line items (rare for Shopify, common for app-built invoices), the original itemized path still runs.'},
      ]
    },
    {
      v:'1.26.3', date:'May 19, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Shopify drawer rows — type chip + left-edge accent.** Each row now shows a 🛋 Booth (blue) or 🛒 Parts (purple) chip on the meta row, plus a colored left edge (same color). Lets you tell booth vs parts at a glance without reading section headers — useful when scanning the drawer or when sections grow mixed in the future. Threshold matches server (≥$5k = Booth, <$5k = Parts).'},
      ]
    },
    {
      v:'1.26.2', date:'May 19, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Shopify drawer — new "📋 Parts Orders — Needs QB Invoice" section.** Without this, the only way to find a Shopify parts order to invoice was scrolling the Shipped column of the main Deal Hub board hoping to spot ecommerce-owned deals — bad workflow for Kim. Now the 🛒 Shopify drawer has a dedicated section listing every small (<$5k, post-cutoff) Shopify deal that hasn\'t been QB-invoiced yet. Click row → opens the deal → green "Create QB Invoice & Mark Paid" button right at the top. Server-side: /api/shopify-pending now returns small orders too (filtered to `needsQbInvoice`), and includes `needsInvoiceCount` in the response. The drawer badge glows + counts BOTH booth verifications AND parts-to-invoice (priorities visible separately in the tooltip).'},
        {t:'fix', d:'**Backdated SHOPIFY_QB_CUTOFF_DATE default from 2026-05-19 to 2026-05-12** (one week back) so existing Shopify orders from this past week are eligible for QB auto-invoice. Useful for Kim to test on real orders without waiting for new ones. Env var override still works if you want to change the cutoff later.'},
      ]
    },
    {
      v:'1.26.1', date:'May 19, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Hot-fix: Deal Hub board broken on v1.26.0 — `shopifyQbRes is not defined`.** Added a 4th query to the /api/deals/list Promise.all (the new shopify_qb_invoices lookup) but forgot to add the variable to the destructure. Result: board threw a 500 + red error on every load. One-line fix. Should have caught with a smoke test before pushing — apologies.'},
      ]
    },
    {
      v:'1.26.0', date:'May 19, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Shopify parts orders — one-click QB invoice + mark paid.** Kim used to manually create a QuickBooks invoice + record the payment for every small Shopify order (<$5k) that came through HubSpot. Now there\'s a big green "📋 Create QB Invoice & Mark Paid" button on each eligible Shopify deal in the Deal Hub overlay. Click → confirm → server pulls HubSpot line items + contact, looks up each line item by name in QB (fallback to a generic "Shopify Order Line" item with the original name in the description), creates the invoice against the shared "Shopify Web Orders" QB customer, marks it paid via QB createPayment using the same payment method + deposit account as the regular Process Order flow, patches HubSpot deal payment_status=paid. Single tracking row in new `shopify_qb_invoices` table keys idempotency (button hides after success).'},
        {t:'add', d:'**Backfill marker for historicals.** Older Shopify deals Kim already manually invoiced in QB get a small "Mark as already invoiced manually →" link below the button. Inserts a sentinel row (mode=\'backfill\', null invoice ID), button hides. Lets Kim clean up the backlog so it stops cluttering her view.'},
        {t:'add', d:'**Cutoff gate.** Button only shows on Shopify deals CREATED on or after 2026-05-19 (today). Pre-cutoff deals already went through Kim\'s manual flow — we don\'t want to double-invoice. Cutoff is `SHOPIFY_QB_CUTOFF_DATE` env override-able. Server enforces the cutoff too (422 error if a stale client tries to invoice an old deal).'},
        {t:'add', d:'**Semi-auto by design, not full auto.** Kim still clicks once per order so eyes-on stays in the loop while we learn what edge cases come up (weird SKU names, missing tax, contact mismatches). Once trusted, flip a switch to full auto via HubSpot Workflow → webhook fire. Today: 30+ seconds of QB data entry → 2 seconds of one click in our app.'},
        {t:'log', d:'**Tax handling for v1:** line items go to QB as-is with `globalTaxCalc:NotApplicable`. The total matches what Shopify charged (line items already include whatever tax Shopify computed). Books revenue with tax included; if accounting wants separate tax treatment we\'ll iterate. Two new env vars: `SHOPIFY_QB_CUSTOMER_NAME` (default "Shopify Web Orders") and `SHOPIFY_QB_FALLBACK_ITEM_NAME` (default "Shopify Order Line"). The fallback item must exist in QB (Products & Services → New non-inventory item) before this works — server returns a clear 503 with instructions if missing.'},
      ]
    },
    {
      v:'1.25.3', date:'May 19, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Quote Builder pre-flight: look up payment by quote_number, not stale deal_id.** v1.25.2 fell back to /api/quote-snapshot which returns `quotes.deal_id` — but that value is STALE after a Merge Deal (post-merge the HubSpot invoice + payment live on the surviving deal, our quote still points at the pre-merge deal that was deleted). Reproed with W-1105142607: quotes.deal_id=60256026416, but the invoice WR-1210 + failed payment are on the surviving deal 60256150594 (Shopify #2145). New endpoint GET /api/deal-payment-status-by-quote/:quoteNumber searches HubSpot for the invoice by `quote_number` field, walks invoice → current deal association, then looks up our payment_status row by the actual current dealId. ~300ms latency per click but bulletproof against merges. Deal Hub side unchanged (its currentDealId is always the post-merge surviving deal, so the existing by-dealId lookup works fine).'},
      ]
    },
    {
      v:'1.25.2', date:'May 19, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Quote Builder pre-flight: resolve dealId reliably even on loaded quotes.** v1.25.1 added the check to openOrderModal but relied solely on `window._lastPushedDealId` / `linkedDeal` / `selectedDeal`. Those globals are populated when a quote is freshly pushed, but in certain quote-load paths they don\'t get set — so the check silently no-op\'d. Now falls back to a /api/quote-snapshot/:quoteNumber lookup as last resort: gives us the dealId for any historical quote regardless of how it was loaded. Also added a `[pay-preflight]` console log at each branch so we can see in the browser console whether the check is firing, what dealId was resolved, and what the payment state is. Reused Deal Hub pattern — extracted into a named `_payClearanceCheck(quoteNumber)` helper so future entry points can call it.'},
      ]
    },
    {
      v:'1.25.1', date:'May 19, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Payment pre-flight warning fires IMMEDIATELY at button click, on both Process Order buttons.** v1.25.0 buried the ACH-clearing / failed-payment confirm inside `confirmProcessOrderFromHub` — fired only after the rep had already opened the modal AND filled in foam / hinge / AP color / payment-method. Now the check runs at the click of the button: the blue "Process →" button in Deal Hub (`processOrderFromHub`) AND the orange "📦 Process Order" button in the Quote Builder (`openOrderModal`). New lightweight endpoint GET /api/deal-payment-status/:dealId returns the mirrored payment row so Quote Builder can hit it without pulling the full deal list. Deal Hub still prefers its in-memory `allDeals` cache (no fetch) and falls back to the endpoint only when the deal isn\'t cached.'},
      ]
    },
    {
      v:'1.25.0', date:'May 19, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Payment-state chips on Deal Hub cards + ACH clearing soft-warning on Process Order.** Mirrors each deal\'s latest HubSpot Commerce Payment into a new `deal_payment_status` table so the Deal Hub card shows: amber "💳 ACH clearing · funds 5/20 · BoA ...0228" while ACH is in flight, green "✓ Funds available" once HubSpot marks it succeeded past the estimated payout date, green "✓ CC Paid" for card payments that succeeded, and a pulsing red "🚨 Payment failed" chip when a payment fails or is reversed (the fraud case Benton flagged). Process Order modal now soft-blocks: confirm modal appears if the latest payment is ACH not yet cleared ("If you process now and the ACH bounces, we ship for free") or marked failed, with default = cancel.'},
        {t:'add', d:'**Two write paths keep the table fresh.** Existing `/api/webhooks/invoice-paid` handler extended to also walk invoice → commerce_payments associations and upsert the payment record — instant update on the happy path. New 30-min polling sync scans `/crm/v3/objects/commerce_payments/search` for anything modified since the last poll (60-min lookback for safety) and upserts. The poll catches everything the webhook misses: ACH pending → succeeded transitions, payment failures, and any webhook delivery hiccups. Started from `lib/db.js` `onAfterInit` matching the existing tracking-poller pattern.'},
        {t:'add', d:'**Status-transition notifications.** When a row\'s `latest_status` transitions to `succeeded` and the payment_method is ACH, fires `notifyRep()` with "💰 ACH Funds Available — Ready to process order" (skipped for CC since the existing invoice-paid notification already covers that case). When transitions to `failed`, fires "🚨 Payment Failed — Do NOT process this order; investigate in HubSpot" with bank/last-4 details. Both debounced via `cleared_notified_at` / `failed_notified_at` columns so the polling sync can\'t double-fire.'},
        {t:'add', d:'**No date math needed on our side.** HubSpot already computes `hs_estimated_payout_date` on the commerce_payments object using their own 3-vs-4-weekday + cutoff rules — we just store it. Property mapping: `hs_payment_method_type` (card/ach/etc), `hs_payment_method_bank_or_issuer`, `hs_payment_method_last_4`, `hs_initiated_date`, `hs_estimated_payout_date`, `hs_latest_status`, `hs_latest_status_updated_date`, `hs_initial_amount`, `hs_payment_source_id`.'},
        {t:'log', d:'**Removed throwaway debug endpoints.** `/api/debug/hs-invoice/:id` and `/api/debug/hs-invoices-for-deal/:dealId` (added earlier in v1.24.x to enumerate HubSpot invoice + payment properties for this feature) are gone now that we know the property names. Recoverable from git history (commits 3947d7c, 70882b5) if needed again.'},
      ]
    },
    {
      v:'1.24.6', date:'May 19, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Intl shipping email — drop the parenthetical on SHIPMENT VALUE.** Removed the "(for insurance, products only — excludes freight & tax)" tail from v1.24.5. Line now reads just `SHIPMENT VALUE: $X,XXX.XX`. Forwarders know what the value is for.'},
      ]
    },
    {
      v:'1.24.5', date:'May 19, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**International Shipping Request — adds SHIPMENT VALUE line for insurance calc.** The overseas-quote email built by the 🌐 International Shipping Request modal already includes name / address / pallet dims / total weight. Per request, now also includes a SHIPMENT VALUE line directly under TOTAL WEIGHT showing the products-only value (line-item subtotal minus discount, excludes freight + tax) so the freight forwarder can quote insurance correctly. Format: `SHIPMENT VALUE: $X,XXX.XX (for insurance, products only — excludes freight & tax)`.'},
      ]
    },
    {
      v:'1.24.4', date:'May 18, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Email Reply popup — shrink the modal, keep the panel sizing.** v1.24.3 fixed the dead space by stretching the panels to fill the iframe, which made everything feel too big. Switching strategies: panels are back to their natural `min-height: 520px`, and the modal itself shrinks to 600px tall (from 88vh / 900px) so the popup\'s bottom edge lands right at the Generate Reply button instead of having ~250px of empty space below. `max-height: 92vh` keeps it from overflowing tiny windows.'},
      ]
    },
    {
      v:'1.24.3', date:'May 18, 2026', tag:'ui',
      changes:[
        {t:'ui',  d:'**Email Reply popup — panels fill the iframe height.** Bottom 30-40% of the modal was dead space because the panels had a fixed `min-height: 520px` and the iframe was 88vh (~800-900px). In embed mode now: body is locked to 100vh, `main` fills the viewport, panel `min-height` is killed and panels use `height:100%` so they fill the grid cells. Textareas and the reply output now grow to use the available space instead of capping at ~320px.'},
        {t:'add', d:'**Email Reply voice auto-selected from logged-in rep.** First-load now fetches /api/me, maps the rep\'s HubSpot owner ID to the matching voice (Jill / Sarah / Travis) and sets the dropdown. Only fires when the rep hasn\'t already made an explicit pick (don\'t stomp their localStorage choice). Reps outside the supported voice set (Benton / Gabe / Kim / Chet / Jeromy) stay blank — they manually choose since there\'s no voice tuned for them. Soft default: doesn\'t write to localStorage on auto-select, so it re-resolves cleanly if the rep mapping ever changes.'},
      ]
    },
    {
      v:'1.24.2', date:'May 18, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Shopify Orders drawer — ≥$5k only.** User confirmed the small-parts auto-ship orders don\'t need sales-team quotes, so the "Small Orders" section was dropping noise into a drawer meant for booth-sized verification only. Server-side: /api/shopify-pending now filters out amount < SHOPIFY_VERIFY_THRESHOLD ($5k) before building the response, so the badge count also reflects only ≥$5k orders. Client-side: dropped the "Small Orders — No Quote Yet" section entirely. Drawer now has two sections: Awaiting Verification (≥$5k, no quote yet) and In Progress / Quoted (≥$5k, has quote).'},
        {t:'fix', d:'**Shopify deals now actually appear on the Deal Hub board.** Re-surfaced the v1.20.11 investigation finding: HubSpot\'s multi-stage `dealstage IN [...]` search filter is unreliable for ecommerce-owned (Shopify-created) deals. Even with v1.21.4 no longer excluding ecommerce deals from the board, the underlying HubSpot search quirk meant recent Shopify deals didn\'t actually show up in the main fetch — reps had to text-search by name or order # to find them. Fix: dedicated ecommerce-owner catch-all pass in /api/deals/list, mirroring the existing closedwon catch-all (which exists for the same reason). Filters by `hubspot_owner_id = ECOMMERCE_OWNER_ID` + `dealstage IN BOARD_STAGES`, paginated up to 500 deals. Runs only on the default load (no `stage`, `q`, or `rep` param) — when a human rep is filtered in, ecommerce deals aren\'t theirs. Recent Shopify orders (typically in Shipped stage from the auto-workflow) should now show up at the top of the Shipped column sorted by recency.'},
        {t:'ui',  d:'**Email Reply popup — dark mode parity.** Opening the ✉️ Email Reply popup while the dashboard is in dark mode was a wall of bright white (the popup loaded Gabe\'s light-only theme regardless). New `?theme=dark` query param on /email-reply applies a dark CSS variable override matching the WhisperRoomQuote dark palette. openEmailReply() now reads the dashboard\'s current theme (`html.light` class) and passes `theme=dark` or `theme=light` to the iframe URL. Light mode unchanged.'},
      ]
    },
    {
      v:'1.24.1', date:'May 18, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Email Reply Assistant — icon-only popup instead of new tab.** Moved the entry point from a labeled "✉️ Email Reply" link on the left side of the Deal Hub topbar (which opened a new tab) to a compact ✉️ icon-only button on the RIGHT side next to the theme toggle. Click now opens a modal that iframes `/email-reply?embed=1` (rep stays on the Deal Hub instead of leaving). Modal: 88vh × max-1180px wide, centered, dimmed backdrop. Close via ✕, ESC key, or backdrop click. Iframe is lazy-loaded on first open so the dashboard\'s initial paint isn\'t blocked by fetching the email-reply page. New `?embed=1` query param on the email-reply page suppresses its own topbar + footer when iframed, so reps don\'t see nested nav chrome. The standalone `/email-reply` URL still works (without `?embed=1`) for anyone who bookmarks it.'},
      ]
    },
    {
      v:'1.24.0', date:'May 18, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Email Reply Assistant — new ✉️ Email Reply button in Deal Hub topbar.** Opens a paste-and-generate tool in a new tab. Rep picks a voice (Jill / Sarah / Travis), pastes a customer email or HubSpot lead notification, hits Generate, gets a personalized reply with the right spec PDF + YouTube overview URLs auto-injected, copies to clipboard, sends from Gmail. Single-shot per email. Vendored from Gabe\'s repo (gabewhite438/whisperroom-reply-assistant): system prompt (~1900 lines of locked phrases, voice templates, product facts, no-em-dash rule), product-links.json (71 products → spec PDF + overview video URL), product-specs.json (scraped specs). Anthropic call goes through new POST /api/email-reply server proxy with the API key server-side (not baked into HTML like Gabe\'s standalone tool) and prompt caching via cache_control:ephemeral. Frontend post-processing intact: em-dash scrub, URL force-injection into the three-link block, intro-line replacement with each rep\'s exact preferred opening (Jill: "Hello [Name]", Sarah: time-of-day greeting, Travis: no greeting). Existing-customer detection bypasses formal intro replacement. New env var ANTHROPIC_API_KEY required in Railway — without it the endpoint returns a clear "not configured" message.'},
      ]
    },
    {
      v:'1.23.2', date:'May 18, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Sales Goal — three polish tweaks.** (1) Tier badges now say "+5% BONUS / +10% BONUS / +15% BONUS" instead of "+5% SALARY / …" — clearer that it\'s an additional payout, not a base-pay change. (2) Each month bar now shows deal count underneath the month abbreviation (e.g. "MAY · 14 deals") so reps can see whether a low-revenue month was low-volume or low-AOV at a glance. (3) The "120% — $617K" tick label was getting clipped at the right edge because the tick sits at left:100% and the centered label extended half-off the container. Now right-anchored (left:auto; right:0) so it sits flush inside the bar zone.'},
      ]
    },
    {
      v:'1.23.1', date:'May 18, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'**Sales Goal report — progress bar layout fix.** The MTD-stats line on the right and the tier labels (90% / 100% / 120%) were stacking on the same horizontal band above the bar and crashing into each other when the right-side text got long ("39.4% of 100% goal · No tier yet · $259,904 to 5% tier"). Two changes: (1) tier labels moved BELOW the bar via `bottom:-22px` instead of `top:-16px` — now they have their own dedicated row and never overlap header text. (2) right-side header text now stacked vertically (pct + tier on top line, "to next tier" hint as muted second line) with right-alignment and gap; also `flex-wrap: wrap` on the container so it reflows cleanly on narrow widths. Removed redundant `$0` / `$617K` endpoint labels since the tier labels under the bar already convey position.'},
      ]
    },
    {
      v:'1.23.0', date:'May 18, 2026', tag:'feature',
      changes:[
        {t:'add', d:'**Sales Goal report — monthly bonus tier dashboard, top of /reports.** New default sub-tab "Sales Goal" shows the 12-month moving average of net revenue (Closed Won + Shipped deals, amount minus tax, freight included) and publishes the current month\'s 100% goal (= moving avg × 1.05) plus the 90% / 120% tier numbers that drive the sales-team monthly salary bonus (5% / 10% / 15%, step function, capped at 15%). Goal is LOCKED at the moment the month starts so the bonus target can\'t shift under the team\'s feet — recompute window is the 12 fully-completed prior calendar months. UI: hero strip with target + three tier badges (active tier glows), MTD progress bar with tier marks at 90/100/120 so reps can see exactly how far to the next tier, 12-month bar chart with the moving-average dotted line, data-quality footer showing how many deals used the canonical HubSpot total_tax_amount vs. back-calc from tax_rate (the legacy fallback). Endpoint GET /api/reports/sales-goal — paginates HubSpot deals (dealstage IN [closedwon, 845719]) over the 13-month window, buckets by closedate in EST, prefers total_tax_amount with rate-calc + nexus-aware freightTaxable fallback for legacy deals. Includes Shopify ecommerce deals (owner 49384873) since those are real company revenue. 5-minute in-memory cache shared across all viewers — first load ~1-3s, repeat loads instant.'},
      ]
    },
    {
      v:'1.21.10', date:'May 15, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**HubSpot freight_cost / amount / tax sync gaps — three connected fixes.** (1) <b>/api/process-order</b>: the closedwon PATCH only carried dealstage + total_tax_amount + ap_color + payment_type, so the deal\'s amount / tax_rate / freight_cost / discount stayed at whatever quote creation last wrote — stale if the rep edited freight/tax/discount between create and process. The Freight LINE ITEM did get rebuilt, but the deal-level freight_cost property never updated. Now the closedwon PATCH carries the full final-state financials (amount, tax_rate, total_tax_amount, freight_cost, discount). This is the FINAL financial sync — after this point the deal is locked from further /api/create-deal writes. (2) <b>/api/create-deal open-stage path</b>: dealPatchProps had amount/tax_rate/total_tax_amount/discount but was missing freight_cost. So updating a quote on an open deal silently failed to push freight to HubSpot. Added freight_cost with the same delivery_install carve-out as the new-deal-create branch (when mode is delivery_install, the combined charge IS the deal freight). (3) <b>/api/create-deal locked-stage path</b>: the 2026-05-13 financial-PATCH-on-closed-deals behavior was overreaching — that was intended for Merge / Modify workflows, but Merge uses /api/deals/:id/merge and Modify uses /api/orders/:q/add-charge, neither of which goes through /api/create-deal. So the locked-stage patch was firing on ANY new quote creation against a closed deal and silently rewriting its financials. Removed: closed-stage deals are now read-only from /api/create-deal. The supported way to update a closed deal\'s financials is the Modify Order button (addendums).'},
      ]
    },
    {
      v:'1.21.9', date:'May 15, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'When a rep manually picks "Ecommerce" in the rep dropdown, the system now auto-redirects to the logged-in user as the deal owner. Reps shouldn\'t manually own deals under the ecommerce/Shopify bucket (49384873) — that\'s reserved for Shopify-auto-created deals. On change, dropdown swaps back to the rep\'s own name and a toast confirms: "Ecommerce routes to the rep — owner set to {name}". Programmatic dropdown sets (e.g. loadDeal restoring a Shopify deal\'s original ownership) don\'t fire the change handler, so existing Shopify deal ownership stays intact when re-opened. Current user\'s ownerId is now stashed on `window._currentUserOwnerId` from `/api/me` for the redirect handler to use.'},
      ]
    },
    {
      v:'1.21.8', date:'May 15, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'**Critical:** "Creating Quote" spinner stuck forever when rep selected "Ecommerce" as the owner. The dropdown option at `quote-builder.html:842` had `value="ecommerce"` (string) while every other rep option has a numeric HubSpot owner ID. Selecting Ecommerce sent `ownerId: "ecommerce"` to /api/create-deal, which then tried to set HubSpot\'s `hubspot_owner_id: "ecommerce"` — invalid value, HubSpot rejected it, and the error path apparently swallowed the failure (spinner never resolved). Fix: changed dropdown value to the real ID `49384873` (ecommerce@whisperroom.com). Also updated REP_NAMES and REP_NUMBERS maps to use the numeric ID. Added server-side normalization in /api/create-deal: any legacy `ownerId === "ecommerce"` is now mapped to ECOMMERCE_OWNER_ID before being sent to HubSpot — belt-and-suspenders so this can never recur even if some old code path or saved snapshot still uses the string.'},
      ]
    },
    {
      v:'1.21.7', date:'May 15, 2026', tag:'fix',
      changes:[
        {t:'ui', d:'Line-item Weight column header renamed "Unit Weight" (more accurate — it IS per-unit, and the totalWeight calc multiplies by qty automatically). Reverts v1.21.6\'s line-total display change; the per-unit display + total-at-bottom is what reps wanted all along.'},
        {t:'ui', d:'Tax-exempt now shows "Tax Exempt" in the quote summary on the right rather than "Not calculated". Removes ambiguity — reps were double-checking whether tax was missing vs intentionally skipped.'},
        {t:'fix', d:'Create-deal fetch now has a 90s hard timeout. Previously a hung HubSpot/QB call left the "Creating Quote…" spinner spinning forever with no way for the rep to recover, see what failed, or know whether the deal partially created. Now an AbortError surfaces a clear message: "Request timed out after 90 seconds. The HubSpot/QB call may still complete in the background — check /admin-log or refresh and verify the deal exists before retrying." Addresses the recent report of a rep stuck on "Creating Quote" indefinitely.'},
      ]
    },
    {
      v:'1.21.6', date:'May 15, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Line-item Weight column now shows LINE TOTAL (per-unit × qty) instead of just per-unit, matching how the adjacent Total column shows price × qty. **Reverted in v1.21.7** — turns out reps prefer per-unit display in that cell with the qty-multiplied total at the bottom.'},
      ]
    },
    {
      v:'1.21.5', date:'May 15, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Shopify Orders button was invisible in light mode — used hardcoded dark-mode colors (rgba(255,255,255,.08) background, #f0ede8 text) instead of theme-aware CSS vars. Switched to var(--surface2)/var(--text)/var(--border) so it renders correctly in both light and dark mode. Glow state now uses var(--orange-dim) + var(--orange) for the colored text, which scales appropriately to whatever `--orange` resolves to per theme (#c94f0e in light, #ee6216 in dark). Badge also re-themed.'},
      ]
    },
    {
      v:'1.21.4', date:'May 15, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Ecommerce-owned (Shopify) deals are no longer hidden from the main Deal Hub board. They now appear in their HubSpot stage column (typically Shipped, since that\'s where the Shopify auto-creation workflow drops them) AND in the dedicated Shopify Orders drawer. The drawer is the curated lens for verification workflow (glow + Awaiting Verification section); the board is the full pipeline view. Ownership stays at ecommerce@whisperroom.com even after merging — these are Shopify-originated business and shouldn\'t count toward any individual rep\'s pipeline graph. Removes the v1.21.0 exclusion and the v1.21.1 `_shopify` flag workaround that was hiding them. mergeShopifyIntoAllDeals() retained as a safety net for the brief window where a Shopify deal has been polled by the drawer but not yet by the 60s board refresh.'},
      ]
    },
    {
      v:'1.21.3', date:'May 15, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Shopify drawer button now shows "🛒 Shopify Orders" instead of just the emoji. Matches the uppercase letter-spacing weight of the other board-toolbar buttons (HubSpot Only, etc.) — easier to recognize at a glance, especially for reps who haven\'t seen the drawer yet.'},
      ]
    },
    {
      v:'1.21.2', date:'May 15, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Merge Deal modal now has a "⇅ Swap Direction" button on the confirm step. Previously the merge was strictly one-way: the deal you clicked Merge Into on was always the "wrong" deal (deleted), the deal you searched for was always the "correct" deal (survivor). Now you can flip which is which after both are selected — useful when starting from a Shopify auto-created deal that should be the survivor, pulling another deal\'s quotes IN to it (instead of moving the Shopify deal\'s data INTO the other). Step 2 confirm card redesigned to show both deals clearly: a red "Delete" card on top, the swap button between, and a green "Keep" card below. The header "Wrong deal:" label stays in sync with the current Delete side after each swap.'},
      ]
    },
    {
      v:'1.21.1', date:'May 15, 2026', tag:'fix',
      changes:[
        {t:'ui', d:'Moved 🛒 Shopify Orders button from the main topbar (next to the notification bell) into the board-toolbar next to the All Reps rep filter. Better visual association with the board itself — it\'s a board-context action, not a global app action.'},
        {t:'fix', d:'Shopify drawer now only shows deals CREATED on or after 2026-05-12 (configurable via SHOPIFY_CUTOFF_DATE env var). Pre-cutoff Shopify deals are historical clutter — small parts orders that long ago auto-shipped via the integration before the booth-verification workflow started. The drawer was previously showing all of them mixed in. Server filters via a HubSpot `createdate GTE <cutoff>` filter; sort changed from hs_lastmodifieddate DESC to createdate DESC so newest orders appear first.'},
        {t:'fix', d:'Clicking a Shopify deal in the drawer now properly loads the deal hub overlay with full data (was just showing "Deal" title before). Root cause: v1.21.0 excluded ecommerce-owned deals from /api/deals/list to keep them off the main board, but `renderHub` does `allDeals.find(d => d.id === dealId)` for the overlay header — so Shopify deals returned undefined and the overlay rendered with empty data. Fix: keep Shopify deals findable in allDeals (merged from the /api/shopify-pending cache after every loadDeals refresh), but flag them with `_shopify: true` so renderBoard skips them from column rendering. Best of both: drawer-only display + working overlay lookups.'},
      ]
    },
    {
      v:'1.21.0', date:'May 15, 2026', tag:'feature',
      changes:[
        {t:'add', d:'New 🛒 Shopify Orders drawer in the Deal Hub topbar. Pulls every deal owned by ecommerce@whisperroom.com (HubSpot user 49384873 — the owner the Shopify integration auto-assigns) and surfaces them in their own slide-out panel instead of mixing them into the regular board columns. Three sections by urgency: (1) "Awaiting Verification" — booth-sized orders (amount ≥ $5k) with no quote in our DB yet, orange "Booth — Verify" chip; (2) "Small Orders — No Quote Yet" — under-$5k Shopify deals still untouched, no chip; (3) "In Progress / Quoted" — Shopify deals where sales has created a real quote. Click any row → opens the standard deal hub overlay → "+ New Quote" → normal quote-builder flow. Button glows orange with a pulse animation when there are pending booth-sized orders awaiting Jill\'s verification; neutral gray with a count badge when the queue is empty. Polls every 60s so a new Shopify order triggers the glow within a minute without a page refresh.'},
        {t:'add', d:'Deal Hub board now auto-refreshes every 60 seconds. Matches the admin-log polling cadence. Currently-open deal hub overlay is unaffected by the background refresh (overlay state lives separately from card render). Means a new Shopify order, a stage advance from Stripe paid webhook, or any other deal change shows up on the board within ~60s without the rep manually reloading.'},
        {t:'add', d:'Ecommerce-owned deals are now excluded from the main /api/deals/list response (the Shopify drawer is their home — they shouldn\'t double-show in the Shipped column). Also sidesteps the HubSpot search-index quirk from May 14 where some Shopify deals weren\'t coming back via multi-stage filter queries. Two new constants in quote-server.js: ECOMMERCE_OWNER_ID (default 49384873, override via env) and SHOPIFY_VERIFY_THRESHOLD (default $5000, override via env) — both configurable without code changes if the integration setup ever moves.'},
        {t:'log', d:'New endpoint GET /api/shopify-pending — returns { pendingCount, all: [...] } with every ecommerce-owned deal flagged isPending (≥$5k AND no quote in our DB) and hasQuote (some quote bound to this deal_id). Closedlost deals filtered out server-side. Bounded result count (Shopify volume is small) so paginated cap at 10 × 100 = 1000 deals is plenty.'},
      ]
    },
    {
      v:'1.20.12', date:'May 14, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Reverted v1.20.11. The dedicated Shipped catch-all pass surfaced more old shipped deals, but did NOT find the specific Shopify-generated deal the rep was hunting — meaning the deal isn\'t coming back from HubSpot\'s search even when explicitly filtered to dealstage=845719. Root cause is elsewhere (likely the Shopify deal has a stage ID other than 845719 even though it displays as "Shipped" in HubSpot UI, OR a pipeline-mismatch, OR a permission/scope issue). Reverting the catch-all pass while we investigate so the board doesn\'t fill with old shipped deals that weren\'t even the actual problem.'},
      ]
    },
    {
      v:'1.20.11', date:'May 14, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Shipped deals were falling off the Deal Hub when the team had recent activity on other deals. Root cause: the Closed Won stage had a dedicated catch-all pass at /api/deals/list (fetches every Closed Won regardless of how stale) but Shipped (845719) didn\'t — it relied entirely on the main 1000-deal paginated fetch sorted by hs_lastmodifieddate DESC. Once 1000 other deals had been touched after a shipped deal, it would silently disappear from the board. Discovered when a Shopify-generated deal in Shipped wasn\'t appearing for any rep even with All Reps + Hide HubSpot Only off. Fix: refactored the dedicated-pass logic into a shared helper and now runs it for BOTH closedwon AND 845719. Same 10-page (=2000-deal) safety cap per stage. Identical reasoning: Shipped deals are active orders the team is still working on (production, shipping, tracking) — they need to be visible regardless of recency. Note: HubSpot search index has a known ~5-60s lag on newly-modified objects, so a brand-new shipped deal may still take a moment to appear — but it won\'t silently vanish anymore. (Reverted in v1.20.12 — did not solve the actual problem.)'},
      ]
    },
    {
      v:'1.20.10', date:'May 14, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Deal cards in the Deal Hub now turn green when an invoice is paid (in addition to existing triggers: quote accepted, payment type set). Server-side: /api/deals/list aggregates `paid: true` if any quote on the deal has `json_snapshot.stripe.status === "paid"` — toggle-gated, so flipping Stripe OFF returns the deal-card UI to pure HubSpot signals. Client-side: `dealGreen` now also checks `d.paid` and HubSpot\'s `d.paymentStatus === "paid"`, so HubSpot Payments-paid invoices also trigger green (matching whatever automation you already have in HubSpot).'},
        {t:'add', d:'On `invoice.paid` Stripe webhook, the HubSpot deal stage auto-advances to "Verbal Confirmation" (`contractsent`) if it\'s currently in an earlier stage. Skips deals already at `contractsent`, `closedwon`, `845719` (Shipped), or `closedlost` — never walks a deal backwards or stomps a closed state. Mirrors the manual quote-accept advance pattern (~line 4287) but gated on current stage. Three new log events: `stripe.deal-stage-advanced` (success), `stripe.deal-stage-noop` (already at or past target), `error.stripe.deal-stage` (HubSpot rejected the patch).'},
      ]
    },
    {
      v:'1.20.9', date:'May 14, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Stripe webhook was getting 401 Unauthorized on every delivery attempt — `invoice.paid` events have been bouncing off our server since v1.20.0 shipped, never reaching the handler. Root cause: the global auth middleware at quote-server.js:564 rejects any `/api/*` request without a session cookie, and `/api/stripe/webhook` wasn\'t in the `isPublicRoute` allowlist. Stripe doesn\'t have session cookies (it authenticates via signed body), so every attempt failed before the signature-verification handler ran. Caught it by inspecting Stripe Workbench → Webhooks → Event deliveries; saw 9+ `401 ERR` attempts going back to yesterday. Fix: added `/api/stripe/webhook` to the public-routes list — the handler still verifies the Stripe signature, so security is preserved (only requests with a valid `Stripe-Signature` header matching `STRIPE_WEBHOOK_SECRET` get processed). Already-queued events will retry automatically over the next hour; can also click "Resend" in Stripe dashboard for immediate replay.'},
      ]
    },
    {
      v:'1.20.8', date:'May 14, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Deal Hub invoice rows now reflect Stripe payment status. When a customer pays via Stripe, the webhook updates `json_snapshot.stripe.status` to "paid" — the Deal Hub now reads that overlay and shows the row as green/Paid, with a purple "Stripe" badge so the rep can tell the payment channel. New "Stripe ↗" link in the row jumps directly to the Stripe Dashboard page for that invoice. Test-mode keys auto-route to dashboard.stripe.com/test/invoices/...; live keys would route to /invoices/...'},
        {t:'add', d:'The existing Stripe ON/OFF toggle in /admin-log now also gates the Deal Hub display. When OFF, the server skips the Stripe overlay entirely — invoice rows render as pure HubSpot data (no Stripe badge, no Stripe link, status from `hs_invoice_status`). Data on the snapshot is preserved; flipping back ON instantly restores the full Stripe view. Tradeoff worth knowing: a Stripe-paid invoice will appear "open" in the Deal Hub while toggle is OFF — that\'s the intended fast-bail-out behavior, not a bug.'},
        {t:'log', d:'NOT changed in this push: HubSpot invoice status. HubSpot computes `hs_invoice_status` from Payment records, so manually patching it via API may not stick. The proper sync would create a HubSpot Payment record via API linked to the invoice — deferred to a follow-up. For now: our Deal Hub is the rep\'s source of truth; HubSpot UI will continue showing Stripe-paid invoices as "open" until that sync ships or HubSpot invoice creation is disabled entirely.'},
      ]
    },
    {
      v:'1.20.7', date:'May 14, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Stripe invoices now accept ACH and wire transfer alongside credit card. Per-quote toggles in the Create Invoice modal let reps disable any combination of methods — the typical use case is unchecking Credit Card on $50k+ orders to skip the ~3.4% processing fee in favor of wire ($8 flat) or ACH (0.8%, capped at $5). The existing $50k CC fee warning still surfaces dynamically. New checkbox: "Wire Transfer — $8 flat fee, recommended for $25k+ orders" in both the quote builder modal (`invoiceAllowWire`) and the deal hub mini-invoice modal (`dhInvoiceAllowWire`). All three default ON for new quotes.'},
        {t:'add', d:'lib/stripe.js: createInvoiceForQuote now builds `payment_settings.payment_method_types` dynamically from allowCC/allowACH/allowWire flags. When wire is on, also passes the required `payment_method_options.customer_balance.bank_transfer.type: us_bank_transfer` (Stripe rejects the invoice without it). Defensive guard: if wire is requested but the customer has no name on file, drops wire from the list and logs `stripe.invoice.wire-dropped` rather than 400-ing the whole invoice (Stripe customer_balance requires a name).'},
        {t:'add', d:'ACH due-date stretch: when allowACH is true, days_until_due defaults to 14 instead of 7. ACH takes 4–5 business days to clear at the bank-network level; a 7-day window would show legitimate ACH payers "past due" reminders before their bank confirms. Caller can still override explicitly via the daysUntilDue param. The active method list and effective due-date now surface in `stripe.invoice.created` log meta (`paymentMethods`, `daysUntilDue`) so we can verify from /admin-log which methods a customer actually saw on each invoice.'},
      ]
    },
    {
      v:'1.20.6', date:'May 13, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Stripe hosted invoice now shows the quote discount as a single "Discount" row under the subtotal (the standard B2B-invoice convention) instead of v1.20.5\'s per-line "(N% off, was $X)" notation. Implementation: `lib/stripe.js` creates a one-shot Stripe Coupon (percent_off, duration=once, max_redemptions=1, named "N% Off — Quote W-XXX") and attaches it to the invoice via `discounts[]`. Freight/tax/install invoiceitems are marked `discountable: false` so the coupon only applies to product lines — matches HubSpot\'s `hs_discount_percentage` scope exactly. /api/create-invoice now passes `discountPct` through. `previewTotalCents` updated to mirror Stripe\'s aggregate-then-round math so it matches `amount_due` to the cent.'},
        {t:'ui', d:'Polish on the Stripe hosted invoice: added a friendly footer ("Thank you for choosing WhisperRoom. Questions? Reply to the email this came with, or contact your sales rep."), and surfaced Quote Number + Deal ID as `custom_fields` on the invoice so customer support can trace back to the source order from the Stripe dashboard or the hosted page. Logo, brand color, business name, and accent color are configured separately in the Stripe Dashboard → Settings → Branding (one-time, no code) and apply automatically to all hosted invoices.'},
      ]
    },
    {
      v:'1.20.5', date:'May 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Stripe invoices now apply the quote-level discount. HubSpot path was already passing `hs_discount_percentage` on each line item, but Stripe has no per-line percentage field, so the discount silently dropped — invoice total matched the gross instead of the net. Fix: `lib/stripe.js` now bakes `item.lineDiscount` into the cents amount before posting the invoiceitem, and appends "(N% off, was $X)" to the line description so the customer sees the discount on the hosted invoice. Only product lines carry `lineDiscount` (freight/tax/install carry 0), so the discount stays product-only just like the HubSpot path. Also updated `/api/create-invoice` to apply the same discount math when computing `previewTotalCents`, so the success-log preview matches Stripe\'s finalized amount_due instead of showing a confusing pre-discount expectation.'},
      ]
    },
    {
      v:'1.20.4', date:'May 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Stripe invoices were doubling on the first v1.20.3 test — real total roughly 2x expected. Root cause: v1.20.3 fixed the $0 bug by passing `pending_invoice_items_behavior: include` on the new invoice, which works on a clean customer but ALSO sweeps in any orphan pending invoiceitems left behind by prior failed runs (every pre-v1.20.3 attempt created invoiceitems that never attached to anything — they accumulated as pending on the customer). New invoice = today\'s items + yesterday\'s ghost items = doubled total. Fix: draft the (empty) invoice FIRST, then create each invoiceitem with `invoice: draft.id` so it attaches directly. No pending-bucket interaction at all, so orphan items from any past or future failed run cannot contaminate. `pending_invoice_items_behavior: exclude` set explicitly as belt-and-suspenders. Note: stale pending invoiceitems on test customers from earlier runs are still sitting in Stripe sandbox — harmless under the new flow, but worth cleaning up via Stripe dashboard (test mode → Customers → find each → delete pending invoiceitems) or by deleting the test customers entirely.'},
      ]
    },
    {
      v:'1.20.3', date:'May 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Stripe invoices were finalizing at $0 even when the quote had real line items. Root cause: Stripe API versions ≥ 2022-11-15 default `pending_invoice_items_behavior` to `exclude`, which means the freshly-created `/v1/invoiceitems` did not attach to the draft invoice. Now `lib/stripe.js` passes `pending_invoice_items_behavior: include` on the `/v1/invoices` POST so the items attach as expected. (Diagnostic `/api/debug/stripe-diagnostic` already had this flag, which is why diagnostic invoices worked but rep-flow invoices did not.)'},
        {t:'log', d:'Added a fail-loud guard in `lib/stripe.js`: if the caller passes `expectedTotalCents > 0` but Stripe returns `amount_due = 0`, we now throw a clear error instead of returning a silently empty invoice. Surfaces as `error.stripe.invoice` in `/admin-log`. `/api/create-invoice` now passes `previewTotalCents` through so this assertion has real data to compare against.'},
      ]
    },
    {
      v:'1.20.2', date:'May 13, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Stripe integration on/off toggle, backed by kv_store.stripe_enabled (default ON). New pill button "Stripe: ON|OFF" in the /admin-log topbar — click flips it without redeploy. When OFF: /api/create-invoice skips Stripe creation entirely (HubSpot path runs unchanged), and /i/:quoteNumber Pay Now ignores any prior stripe.hostedUrl on the snapshot and falls back to HubSpot payment_link. Webhook handler stays active either way so in-flight Stripe invoices can still be marked paid. Two new routes: GET /api/stripe-toggle (read state, auth required) + POST /api/stripe-toggle (flip, auth required, writelogs stripe.toggle with rep + new state). 10-second in-memory cache on the read path so we don\'t hit the DB on every page load.'},
        {t:'fix', d:'Stripe invoices for $0-total quotes no longer get created. Stripe finalizes a $0 invoice as immediately PAID, which surfaces as a confusing "already paid" hosted invoice when the rep clicks Pay Now. New guard sums `invoiceLineItems` positive-price entries in cents BEFORE calling Stripe; if total ≤ 0, logs `stripe.invoice.skipped` with reason + line counts + previewTotalCents, no Stripe API call. The "already paid" report from today\'s staging test was almost certainly this case — quote either had zero products, all-credit lines, or some other path that left invoiceLineItems with no positive entries. Diagnostic improvement: stripe.invoice.created log meta now includes lineItemCount, positiveItemCount, previewTotalCents so we can see exactly what went over.'},
      ]
    },
    {
      v:'1.20.1', date:'May 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Two staging-test issues from v1.20.0: (1) Stripe `/v1/invoiceitems` rejected `price_data.product_data` with "unknown parameter" — that\'s a Checkout-Sessions-only field. Invoice items require either a Product ID via `price_data.product` or the simpler `amount`+`description` shape. Switched to amount + description (qty pre-multiplied into amount, qty prefix baked into the description so "2 × MDL Whisper" still reads). Trade-off: line shows as one combined amount rather than Stripe\'s native "2 × $X.XX" breakdown. Revisit when we need explicit qty display. (2) Customer email was missing on the body sent to /api/create-invoice, causing stripe.invoice.skipped — now falls back through body.customer.email → json_snapshot.customer.email → HubSpot contact lookup via resolvedContactId. The `emailSource` is logged in stripe.invoice.created meta so we can see where it came from.'},
      ]
    },
    {
      v:'1.20.0', date:'May 13, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Stripe Invoice integration (Option A — May 12, 2026 plan, first cut). Clicking Create Invoice now creates BOTH a HubSpot invoice (unchanged) AND a Stripe Invoice from the same line items (post-credits, post-install, with freight + tax as separate items). The Pay Now button on our invoice page (/i/:quoteNumber) prefers the Stripe hosted_invoice_url when available; HubSpot\'s payment link stays as fallback for legacy quotes, Canadian/international orders (Stripe skipped — wire transfer only), and any case where Stripe creation failed. Stripe state stashed on json_snapshot.stripe ({ customerId, invoiceId, hostedUrl, invoicePdf, amountDue, status, finalizedAt }) — no schema migration. Webhook handler at POST /api/stripe/webhook with signature verification (STRIPE_WEBHOOK_SECRET) handles invoice.paid / invoice.payment_failed / invoice.voided — writes paidAt/voidedAt to snapshot, fires rep notification on paid, writelogs the event. Hard-locked to sk_test_ keys for now. New module lib/stripe.js (init({ deps }) pattern, form-urlencoded helper, find-or-create customer by email).'},
        {t:'log', d:'Three new writelog events surface this in /admin-log: stripe.invoice.created (success, includes hostedUrl), stripe.invoice.skipped (Canadian or no email), error.stripe.invoice (creation failed — HubSpot URL still works as fallback). Webhook adds stripe.invoice-paid / stripe.invoice-payment-failed / stripe.invoice-voided plus stripe.webhook.bad-signature for tamper attempts.'},
      ]
    },
    {
      v:'1.19.19', date:'May 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Tax-not-calculated confirm popup no longer fires for quotes where Calculate Tax was run and TaxJar correctly returned $0 because the destination state has no nexus. Bug was at the push-quote guard in quote-builder.html: the condition was (!taxData || !_taxAmountFn) which fired the warning whenever the computed tax amount was zero — including the legitimate no-nexus case where taxData is set to { inNexus: false, tax: 0 }. Reps had to dismiss the warning on every CA/NY/TX/etc. quote. New condition is just !taxData — warning only fires when Calculate Tax was never run (rep skipped it). Tax exempt and freight-only quotes still bypass the guard as before. Direct fix on main; landed in staging via merge.'},
      ]
    },
    {
      v:'1.19.18', date:'May 13, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Quote builder pop-up legibility in light mode. Four targeted fixes: (1) defined --text2 (#555 light / #aaa dark) and --orange (alias for --accent) in CSS root so modal inline styles that used var(--text2,#aaa) and var(--orange,#ee6216) as fallbacks now resolve to a readable color in light mode instead of the white-ish fallback. Affects folderPromptModal, partsFreightModal, dealHubOverlay drive-folder rows. (2) Added body:not(.dark) overrides for .success-modal-title / .success-modal-msg / .success-modal-actions .btn-secondary — these still had hardcoded color:#fff and rgba(255,255,255,*) from the original dark-theme design, so the "Quote Pushed!" confirmation popup was unreadable in light mode. The earlier submit-overlay had been overridden but the post-success modal was missed. (3) intlShippingOverlay\'s pallet-summary block had hardcoded background:rgba(255,255,255,.05) — invisible on cream. Switched to var(--surface2) + var(--border). (4) contactGuardOverlay\'s "Keep Quote" button had rgba(255,255,255,.08) background — switched to var(--surface2) so it actually appears as a button in light mode.'},
      ]
    },
    {
      v:'1.19.17', date:'May 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Locked-stage deal financial patch (v1.19.15) now checks HubSpot\'s response status too — was missing the same status-check fix v1.19.16 added to the non-locked branch. Without it, a HubSpot rejection on a closed-won deal would silently swallow the patch and the deal\'s financial fields would stay frozen. Logs [deal sync] locked-stage patch deal X (closedwon) → status=200 amount=$Y on success; writelogs error.deal_sync_failed with body on rejection. financialPatch has no enum fields so rejection is rare, but worth covering. Per Puerto Rico test today where the rep saw no [deal sync] line at all — almost certainly running the locked-stage path with no logging.'},
      ]
    },
    {
      v:'1.19.16', date:'May 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Deal-sync patch on quote update now logs HubSpot\'s response status + body. httpsRequest resolves on ANY status (incl. 400) without throwing, so before this any HubSpot rejection was silently swallowed — the patch fell through, quote_number got saved, and the deal\'s amount/freight/tax fields just stayed at whatever they were. New behavior: status >= 400 is treated as a failure, triggers the no-state retry, and if THAT also fails it writelogs error.deal_sync_failed with the rep + HubSpot\'s error body so we can see exactly what HS objected to. The next quote-update attempt that doesn\'t sync the deal will leave breadcrumbs in Railway logs ([deal sync] full patch deal X → status=200 amount=$Y or [deal sync] full patch deal X REJECTED by HubSpot: ...).'},
      ]
    },
    {
      v:'1.19.15', date:'May 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Quote updates on closed-won/shipped/closed-lost deals now update the FINANCIAL fields on the HubSpot deal (amount, tax_rate, total_tax_amount, discount, freight_cost) even though the deal is in a "locked" stage. Before: any deal in DEAL_LOCKED_STAGES skipped the entire deal patch — addresses, owner, AND amount all stayed frozen. Now: the lock still protects shipping/billing addresses, contact, dealname, and dealstage from being rewritten, but financial fields always track the most recent quote. Per 2026-05-13 ask: "It should always update the deal amount (with the freight/tax fields too) to the most recently created, updated, or revised quote." Logs deal_sync_locked_financial when this fires.'},
      ]
    },
    {
      v:'1.19.14', date:'May 13, 2026', tag:'logging',
      changes:[
        {t:'log', d:'More addendum tax diagnostics. v1.19.13 ShipAddr fix didn\'t help — even with a matched item (ItemRef:1092 FOAM 4) AST still returned TotalTax:0 / NetAmountTaxable:0. Added two more Railway log lines per addendum: (1) QB customer record\'s Taxable flag + DefaultTaxCodeRef + saved ShipAddr/BillAddr, and (2) the exact ShipAddr/BillAddr we sent. If Taxable=false on the QB customer, that\'s the cause — AST zero-taxes every invoice for tax-exempt customers regardless of line tax codes. Cheap one-shot query.'},
      ]
    },
    {
      v:'1.19.13', date:'May 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Addendum invoice ShipAddr/BillAddr construction now matches process-order exactly — uses conditional spread to omit missing fields, instead of sending empty strings. The addendum diagnostic from v1.19.11 showed AST returning TaxLine with TaxPercent:0 + NetAmountTaxable:0 even though we tagged lines TAX and didn\'t suppress. Empty-string Line1/City in ShipAddr can break AST\'s jurisdiction lookup silently — it falls back to a 0% rate. Process-order omits missing fields entirely, which is what AST needs. This is the only payload difference between the two paths.'},
      ]
    },
    {
      v:'1.19.12', date:'May 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Order-modified mailto: CC list now joined with ";" instead of "," so Outlook reads accounting + Benton as two separate recipients. RFC 6068 says comma but Outlook (the main client at WhisperRoom) treats comma-joined addresses as one malformed entry and only CCs the first. Process-order\'s notification mailto uses the same separator for the same reason.'},
      ]
    },
    {
      v:'1.19.11', date:'May 13, 2026', tag:'logging',
      changes:[
        {t:'log', d:'Revert v1.19.10 — wrong diagnosis. Tax not passing wasn\'t about source-quote suppression; user\'s example had tax computed. Suppression logic restored to v1.19.9 (suppress when exempt or source-quote tax=$0). Added Railway diagnostic logging: tax decision (state/amount/suppress flag), QB lines payload (per-line TaxCodeRef + ItemRef), and QB invoice response (TxnTaxDetail, TotalAmt, GlobalTaxCalculation). Next addendum will leave breadcrumbs in Railway logs so we can see whether AST received what we sent and why it didn\'t compute.'},
      ]
    },
    {
      v:'1.19.10', date:'May 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Addendum invoices now actually tax in nexus states. v1.19.9 decided whether to suppress AST based on the SOURCE quote\'s computed tax — which was $0 for freight-only change quotes where the rep skipped Calculate Tax (the tax-confirm guard from v1.19.3 only fires when there are product line items). A TN freight-only addendum should still get TN tax via AST. New rule: suppress AST only when the order is tax-exempt OR the customer\'s ship-to state is NOT in NEXUS_STATES — purely a function of the order, not the source quote. Logs [add-charge] tax decision: state=TN nexus=true exempt=false → AST so we can see in Railway what fired.'},
        {t:'fix', d:'Freight TaxCodeRef on addendum invoices now falls back to NEXUS_STATES[state].taxFreight when the source quote didn\'t carry freightTaxed (i.e., rep didn\'t compute tax). TN.taxFreight=true means freight gets TAX_CODE and AST taxes it. Without this fallback, a freight-only change quote in TN would mark freight EXEMPT and AST would miss it — exactly what just happened.'},
      ]
    },
    {
      v:'1.19.9', date:'May 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Addendum QB invoice now puts freight and tax in their proper places — mirrors process-order\'s structure. Was dumping everything as generic SalesItemLineDetail lines. Now: products → SalesItemLineDetail with matched ItemRef + per-line TaxCodeRef; discount → DiscountLineDetail (applied BEFORE freight); freight → SalesItemLineDetail with SHIPPING_ITEM_ID (routes to QB\'s Shipping totals row) + freightTaxed-aware TaxCodeRef; install/pickup → fallback item with EXEMPT tax. Tax itself is no longer a line — QB Automated Sales Tax computes it from the per-line TaxCodeRef. Suppression rules match process-order: AST silenced when the addendum tax is $0 (non-nexus ship-to) or the order is tax-exempt. Ad-hoc lines path (legacy `body.lines`) keeps the flat structure since it has no per-line type info.'},
      ]
    },
    {
      v:'1.19.8', date:'May 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Order-modified email now CCs bentonwhite@whisperroom.com alongside accounting@. Was only CC\'ing accounting before. Multiple CCs joined with comma per RFC 6068.'},
      ]
    },
    {
      v:'1.19.7', date:'May 13, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Modify Order quote picker now shows the full line-item breakdown for each candidate quote — every product line (name + qty + ext amount), freight, install, pickup fee, and Sales Tax with rate. Was showing only quote number + date + total + first 2 item names. Rep can now identify the right quote at a glance without leaving the modal. Hub data projection expanded to include freight/install/tax/pickupFee per quote.'},
      ]
    },
    {
      v:'1.19.6', date:'May 13, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Remove addendum (paid included). The Modify modal\'s Remove button now works on PAID addendums too — it deletes the QB auto-payment first (which un-pays the invoice) and then the QB invoice/credit memo. Previously paid addendums were blocked with a "use refund flow instead" message; per 2026-05-13 spec, Remove should be the universal undo. Order page + Deal Hub auto-update to reflect the removal. Partial-failure cases (QB rejects one of the two deletes) are surfaced via toast so the rep knows to clean up manually.'},
        {t:'fix', d:'Order PDF in the shared orders folder + per-deal Drive folder now ACTUALLY overwrites instead of accumulating duplicate "Order (1).pdf" / "Order (2).pdf" files on each addendum. New helpers in lib/gdrive.js: gdriveFindFileByName, gdriveUpdateFilePdfContent, gdriveUpsertFilePdf. Upsert searches by name in the parent folder; if found, PATCH the file content; if not, create new. add-charge + void-addendum both use upsert now, as does gdriveSavePdfToDeal internally.'},
        {t:'fix', d:'Order-modified email mailto now always fires on success (was gated on order-not-shipped) and shows a visible toast "📧 Email draft opened — click Send in your mail client to notify shipping" 600ms after the popup. Reps were missing the auto-opened mail-client window and never clicking Send. Console.log added for diagnosis.'},
      ]
    },
    {
      v:'1.19.5', date:'May 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Select Rate in the orders dashboard now keeps the side drawer open. The v1.14.1 behavior closed the drawer (delegating to saveOrder) so reps had to reopen it to keep editing tracking, ship date, hardware box, etc. — annoying when they just want to apply the rate and continue. saveOrder() now accepts { keepDrawerOpen: true } and Select Rate passes it. Regular Save Changes flow still closes (unchanged).'},
        {t:'fix', d:'AP badge on deal cards no longer shows when only OLD (superseded) quotes had AP. New rule: the badge only fires when (a) the most recent quote has AP, or (b) a processed order on this deal has AP. The aggregation used to OR AP across every quote in deal history, so a deal where a customer first asked about AP and then chose a different config still showed AP forever. Production-lead-time flags (RM, CUSTOM HOLES) still aggregate across all quotes since Gary needs visibility on any prior request.'},
      ]
    },
    {
      v:'1.19.4', date:'May 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Addendum submit was 500ing with "applyToFreight is not defined" — leftover reference in the writelog meta object after v1.19.3 removed the local variable. Now logs the source quote\'s freight portion (addFreight) instead. node --check doesn\'t catch this kind of unused-identifier-in-object-shorthand bug; only surfaces at runtime when the endpoint actually fires.'},
      ]
    },
    {
      v:'1.19.3', date:'May 13, 2026', tag:'feature',
      changes:[
        {t:'fix', d:'Shipping/Jeromy email corrected to shipping@whisperroom.com (was jeromy@). Affects lib/notify.js REP_EMAILS and the mailto: in the order-modified email.'},
        {t:'add', d:'Quote-push tax guard. When the rep tries to push a quote that has product line items, isn\'t tax-exempt, and has $0 tax computed, a confirm dialog asks "No sales tax has been calculated. Continue without tax?" Catches the case where a rep forgets to hit Calculate Tax on a taxable order. Freight-only / install-only quotes skip the guard.'},
        {t:'ui', d:'Removed "Apply net to Freight Cost" checkbox from the Modify Order modal. The source quote\'s freight slot is now the source of truth — if the source quote has freight, that amount auto-bumps the order\'s Freight Cost field. If the source quote has no freight, the field stays untouched. Voiding an addendum reverses just the freight portion.'},
        {t:'add', d:'Addendums now carry rich structure when merged from a quote: lineItems (with weight), freight, freightTaxed, installAmount/Mode, pickupFee, discount, taxAmount, taxRate, weight. Customer-facing order page renders tax (from TaxJar carried through the source quote) as a "Sales Tax (9.25%)" row under Order Adjustments, and shows added weight + new total weight when addendums contribute physical items. QB invoice always suppresses AST on addendums and includes our tax as an explicit line — keeps math precise and customer-facing invoice total matches the order page.'},
      ]
    },
    {
      v:'1.19.2', date:'May 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Deal Hub "+ New Quote" now properly binds the contact in the quote builder. The deal\'s contact info auto-filled the customer form fields but skipped the metadata that tells the system "this contact is already in HubSpot" — window._loadedContactId, _loadedContactAddress, the contact-search box value, and the view-contact button visibility. Result: pushing the quote fired "Possible Duplicate Contact" because create-deal couldn\'t tell the form was pre-filled from a real contact vs. a rep typing a new contact whose email collided. Now linkDealById sets the same metadata block that _doFillContact sets when picking from the dropdown — no more duplicate prompt on freshly-linked deals.'},
      ]
    },
    {
      v:'1.19.1', date:'May 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Quote builder no longer blocks pushing a quote that has no line items as long as it has freight, installation, or a pickup fee. Came up while building a freight-only "change quote" for the v1.19.0 addendum-merge workflow — a $500 shipping-upgrade quote has no products and was getting blocked at the push step with "Please add at least one product." New guard only fires when the quote is truly empty (no items AND no freight AND no install AND no pickup).'},
      ]
    },
    {
      v:'1.19.0', date:'May 13, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Order Addendums: quote-merge workflow. Replaces the multi-line builder with a quote picker. Rep builds a normal "change quote" on the deal first (freight upgrade, wall change, credit line — whatever the customer wants), then opens Modify on the original order and picks that quote. Server pulls the source quote\'s lineItems + freight + install + discount, derives net, creates QB Invoice (net positive) or Credit Memo (net negative). The source quote keeps its W- number and continues to exist as a regular quote — if the customer ultimately doesn\'t accept the change, it just sits there as a quote. Per-line server validation still allows ad-hoc `lines` array submissions (kept for future "Quick Charge" UI, but no UI fires this path today).'},
        {t:'add', d:'Order PDF auto-regenerates on every addendum add and void. Same shared-orders folder + per-deal Final Order folder as process-order writes to. Non-blocking IIFE — response returns before the PDF upload completes. So the Drive copy now reflects the live totals; reps can pass the PDF link without it being stale.'},
        {t:'add', d:'In-app notification bell on the orders dashboard topbar. Polls /api/notifications on load and every 60s, shows an orange unread badge, dropdown lists the last 50 notifications with relative timestamps. Click a notification to mark it read; if it has a quote_num, opens the order drawer. Mark-all-read button. The notification system was already wired server-side (lib/notify.js, /api/notifications GET) but no client surfaced it — first time it\'s actually visible.'},
        {t:'add', d:'Jeromy gets two notifications on every order modification: in-app (createNotification fires server-side, surfaces in his orders dashboard bell) + email (mailto: opens the rep\'s mail client with the order-modified details pre-filled, rep clicks Send to deliver — same pattern as process-order\'s notification email). Skipped when the order already shipped (Jeromy already let it go; modification is informational for accounting only at that point).'},
        {t:'add', d:'Deal Hub data projection now includes per-order paymentType and addendums[] so the Modify modal has everything inline without a second fetch.'},
        {t:'add', d:'lib/quickbooks.js: createCreditMemo, getCreditMemo, deleteCreditMemo (introduced in v1.18.1, kept). Addendum data model: type ("invoice"|"credit"), lines[], qbId, sourceQuoteNumber (new — set when merged from a quote).'},
      ]
    },
    {
      v:'1.18.2', date:'May 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Customer-facing order page /o/<quoteNumber> now reflects active addendums in the totals. v1.18.1 shipped the create / track / void flow but forgot to update the customer view of the order — adding a $500 upcharge would update the deal amount, the QB invoice, and the addendums chip in Deal Hub, but the customer-facing order page still showed the original total. New behavior: an "Order Adjustments" subsection appears in the totals card (above the grand total) listing each per-line adjustment with its description. Negatives styled green like discounts. Grand total now equals subtotal − discount + freight/pickup/install + tax + addendumNet (where addendumNet is signed: credit-memo addendums subtract). Voided addendums are excluded. Legacy v1.18.0 single-line addendums render correctly via fallback.'},
      ]
    },
    {
      v:'1.18.1', date:'May 13, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Order Addendums moved from the orders dashboard drawer to the Deal Hub. Every order row in the Deal Hub now has a "Modify" button that opens a modal with two sections: (1) Existing addendums for this order with status badges (Paid / Open / Credit / Voided) + void buttons on unpaid ones; (2) Add new — a multi-line builder where each row is description + amount (negative for credits), plus an "+ Add line" button. Net total + resulting QB doc type (Invoice or Credit Memo) preview live as the rep types. The order row also shows a small color-coded chip summarizing active addendums (e.g. "+$450 · 2" or "−$200"). The orders dashboard drawer no longer has any addendum UI.'},
        {t:'add', d:'Addendums now support multi-line + credits. Net positive across all lines → QB Invoice (with auto-payment for non-PO types, mirroring create-qb-invoice). Net negative → QB Credit Memo (no auto-payment; rep applies/refunds in QB). Net zero is rejected (split into separate addendums). Each line stored individually on order_data.addendums[i].lines for audit. lib/quickbooks.js gains createCreditMemo + getCreditMemo + deleteCreditMemo. Void endpoint now handles both QB doc types via the addendum\'s type field.'},
        {t:'ui', d:'DocNumber convention: invoices stay as W-{QUOTE}-A{n} but credit memos use W-{QUOTE}-C{n} so accounting can tell the two apart at a glance in QB. Real example: Russell Turner shipping upgrade = -A1; foam-downgrade refund = -C1.'},
      ]
    },
    {
      v:'1.18.0', date:'May 13, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Order Addendums — handle post-process charges like shipping upgrades without overwriting the original order. New "+ Add Charge" button in the order drawer\'s Shipment section opens a modal (description, amount, payment type, optional PO #, "Apply to Freight" checkbox). Submitting creates a new QB invoice with DocNumber {QUOTE}-A{n} (e.g. W-1605132601-A1) plus auto-payment for non-PO types. Each addendum tracked in order_data.addendums forever with audit trail (id, description, amount, payment, paidAt, addedBy, addedAt). Drawer shows the list with status badges (Paid/Open/Voided) and a total billed summary ($X original + $Y addendums). Real incident May 12: Russell Turner upgraded his shipping after order processed; Sarah manually created a 2nd invoice. Now systemized.'},
        {t:'add', d:'POST /api/orders/:quoteNumber/add-charge — new endpoint, mirrors the create-qb-invoice + auto-payment pattern. Honors the same tax suppression rules (tax-exempt or zero-tax orders skip AST). Updates HubSpot deal amount to original + sum(active addendums) so deal revenue stays accurate. Defaults Add Charge\'s payment type to the original order\'s payment type. Logs order.addendum-added with rep + amount + invoice info.'},
        {t:'add', d:'POST /api/orders/:quoteNumber/addendums/:id/void — void an UNPAID addendum. Paid addendums block (use refund flow when Stripe lands). Marks the addendum voided rather than deleting (audit preserved). Deletes the QB invoice; reverses freight-cost bump if applicable; re-syncs HS deal amount. Logs order.addendum-voided.'},
      ]
    },
    {
      v:'1.17.0', date:'May 13, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Reports → Quotes sub-tab. Pick a rep in the sidebar, see their last 7 days of quotes as a 7-column grid (today highlighted in orange on the right). Each tile shows quote number, customer/company, total, time of day, and a "New" (green) or "Rev" (orange) badge. New = first quote for that deal_id; Rev = subsequent quote (price changed → new quote number). Tiles link to the quote page. Empty days show "No quotes." Header shows totals at a glance (e.g. "12 quotes · 8 new · 4 revisions"). Powered by new endpoint GET /api/reports/quotes-timeline?rep=<ownerId> which runs one SQL query with a correlated subquery counting prior quotes per deal_id. In-place edits where the rep re-saved without changing the price aren\'t tracked (the schema has no audit log) — punted per discussion, can be added later by introducing updated_at + update_count columns.'},
      ]
    },
    {
      v:'1.16.5', date:'May 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Quote number sequence now correctly starts at 01 when the first new quote of the day is a revision of a prior-day quote. generateFreeQuoteNumber was seeding its search sequence from the loaded quote\'s seq regardless of whether the dateKey matched today\'s, so revising yesterday\'s W-1605122602 (seq 02) for the first time today would land at W-1605132602 instead of W-1605132601. Now: only honor the client\'s seq when its dateKey matches today\'s; otherwise restart at 01. previewNextQuoteNumber was already correct (always starts at 1) — bug was creation-side only, so the preview UI showed the right number but the saved quote got a different one when revising across days.'},
      ]
    },
    {
      v:'1.16.4', date:'May 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Rep dropdown no longer auto-flips to the deal owner when a deal is linked. Companion fix to v1.16.3 contact-owner notification — without this, the popup would warn "Sarah is the contact owner" but the dropdown silently changed to Sarah anyway (via the auto-link path: contact-search → single-deal-suggested → auto-link → linkDealById → fetch deal → set repSelect.value = hubspot_owner_id). The dropdown now reflects "who is building this quote" (logged-in rep), not "who originally owned the deal." Shopify deals still auto-route to Ecommerce — those are imported automation that should never be credited to a human rep.'},
      ]
    },
    {
      v:'1.16.3', date:'May 13, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Contact-owner notification when building a quote for someone else\'s contact. The contact-search API now returns hubspot_owner_id (was being silently dropped — lib/hubspot.js properties array). When a rep selects a contact whose owner is a different rep, a modal shows "X is already the contact owner of Y" with Continue and Cancel buttons. Notification only — the rep dropdown is NOT auto-flipped (so a rep intentionally taking over a contact doesn\'t accidentally route the deal to the original owner). Silent when the contact has no owner, the owner IS the current rep, or the owner is the ecommerce bucket. Triggered by a real incident May 13: Sarah built a quote for Jogesh without knowing Jill owned the contact.'},
      ]
    },
    {
      v:'1.16.2', date:'May 12, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Stripe diagnostic was 400ing on every invoice item with "You may only specify one of these parameters: amount, quantity." Stripe\'s /v1/invoiceitems treats `amount` (total cents) and `quantity` as mutually exclusive — quantity only works with `price_data[unit_amount]`. Diagnostic items are all qty=1 so dropped `quantity` and kept `amount`. When we wire the real implementation we\'ll use the price_data path so multi-quantity WR orders display "2 × $3,500" cleanly on the customer\'s Stripe invoice.'},
      ]
    },
    {
      v:'1.16.1', date:'May 12, 2026', tag:'logging',
      changes:[
        {t:'log', d:'Stripe diagnostic endpoints (staging-only, hard-locked to sk_test_ keys). GET /api/debug/stripe-diagnostic creates one test Customer + four test invoice line items + one finalized Invoice, returns hosted_invoice_url + invoice_pdf so we can verify the integration end-to-end before wiring Stripe into /api/process-order. Companion GET /api/debug/stripe-cleanup?invoice=in_xxx&customer=cus_xxx voids the invoice and deletes the customer so the dashboard stays tidy. First step toward replacing HubSpot Invoices with Stripe Invoices for customer-facing payment (Option 2 from the May 12 discussion).'},
      ]
    },
    {
      v:'1.16.0', date:'May 12, 2026', tag:'feature',
      changes:[
        {t:'add', d:'HubSpot Fees tab on the Accounting page. Pick a month and see Transactions, Gross, Total HubSpot Fees (the headline figure to enter as a monthly QB expense), Processor Fee, Platform Fee, Net Deposited, and Refunds. Per-payment table beneath with date, invoice number, customer, method, and the three fee components. CSV download for the accountant. Powered by GET /api/accounting/hubspot-fees?month=YYYY-MM which paginates through HubSpot Payments search filtered to succeeded + hs_payments processor and aggregates hs_fees_amount + hs_platform_fee.'},
        {t:'ui', d:'Renamed the Accounting page URL from /reconcile to /accounting (the page title was already "Accounting"; only the URL lagged). All cross-page nav links updated to /accounting. /reconcile keeps working — 302-redirects to /accounting with the query string preserved so the QB OAuth callback (?qb=connected) and any bookmarks still land. The QB OAuth callback now redirects to /accounting directly.'},
      ]
    },
    {
      v:'1.15.3', date:'May 12, 2026', tag:'logging',
      changes:[
        {t:'log', d:'Diagnostic endpoint GET /api/debug/hubspot-payments?limit=3 dumps the full HubSpot Payment property schema plus a few recent payments with all property values populated. Used to identify which property name carries the processor fee before building the monthly HubSpot Fees summary card on the reports dashboard — guessing the field name risks a silent $0 column.'},
      ]
    },
    {
      v:'1.15.2', date:'May 12, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Tax Exempt now restores when reopening a saved quote. The flag was already being saved to local history (accessories.taxexempt) and to the server snapshot (taxExempt), but loadFromHistoryEntry\'s accessories-restore loop hardcoded only residential/liftgate/limitedaccess/loadingdock — the Tax Exempt checkbox stayed unchecked on revising quotes. Also restores the Tax Exempt Certificate # text (now saved to local history alongside the flag), shows the cert-input row when exempt, and mirrors the click-handler side effects (clears taxData, hides the tax-result panel) so the loaded quote matches the original state.'},
      ]
    },
    {
      v:'1.15.1', date:'May 12, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'The orders-dashboard Create Invoice button (/api/orders/:quoteNumber/create-qb-invoice) now auto-creates a QB Payment for non-PO orders, mirroring what /api/process-order does. This endpoint is the recovery path when the original process-order didn\'t reach QB, so it needed to produce the same end state — invoice AND payment. Previously it stopped at invoice creation, leaving the rep to mark-paid manually. Defaults: paymentMethod "Hubspot", deposit "Southeast Bank Regular Checking 2545". PO orders skip auto-payment (payment hasn\'t arrived yet). Auto-payment failures log + surface in the response without rolling back the invoice. Logged as order.qb-payment-auto with via:"create-qb-invoice" so we can distinguish from process-order auto-payments.'},
      ]
    },
    {
      v:'1.15.0', date:'May 12, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'QB invoice tax suppression. The Tax Exempt checkbox on the quote builder previously had ZERO effect on the QB invoice — every line was sent with TaxCodeRef=TAX regardless, and QB Automatic Sales Tax then computed tax from the ship-to address. Same bug hit non-nexus states: TaxJar correctly returned $0 (NY isn\'t in NEXUS_STATES) but QB AST still added NY tax because NY was an active agency in the QB tax center. Both QB invoice paths now detect (snapshot.taxExempt === true) OR (TaxJar tax === $0) and send GlobalTaxCalculation:"NotApplicable" plus EXEMPT_CODE on every line + freight — silences AST entirely for that invoice. Does NOT override the amount for non-zero nexus-state orders (QB AST rejects per-invoice amount overrides for AST companies — see v1.7.10).'},
        {t:'fix', d:'Process Order guardrail. Re-processing a quote that already had an order row used to wipe every rep-edited field (shipped carrier, tracking, date, boxes, hardwareBox, freightCost, freightRef, serialNumber, qbInvoiceId) because the INSERT ... ON CONFLICT replaced order_data entirely. Now: server returns 409 with code:"ORDER_EXISTS" and the client (Quote Builder + Deal Hub) prompts the rep to confirm. On confirm, retries with force:true — and the server then MERGES the new orderData into the existing row so saved fields survive. Also: when a qbInvoiceId is already linked, the QB invoice creation step is skipped so force re-process doesn\'t duplicate the QB invoice. Logs blocked and forced re-processes for visibility.'},
      ]
    },
    {
      v:'1.14.1', date:'May 12, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Select Rate in the Get Freight modal now also persists the order (same as clicking Save Changes). Previously it staged the carrier / cost / ship date / freight ref in the drawer but waited for the rep to hit Save Changes separately — easy to miss. Now Select Rate applies + saves + closes the drawer in one click. Both toasts (rate-applied + order-updated) show in sequence.'},
      ]
    },
    {
      v:'1.14.0', date:'May 12, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Freight Quote Ref field on the order drawer. When a rep selects a rate card in the Get Freight modal, the carrier\'s saved-quote identifier (ABF quoteId or OD referenceNumber) plus the carrier page URL are stashed on the order. The field shows e.g. "ABF: LTLX8W1316" with an "Open ↗" button — ABF deep-links to the saved quote on arcb.com; OD copies the reference to the clipboard and opens its rate-reference-search page. Persists in order_data.freightRef so the rep can come back tomorrow and still pull the quote. Field is hidden when no ref is saved. ABF rate cards now also carry a quoteId field server-side (previously only the assembled quoteUrl was sent).'},
      ]
    },
    {
      v:'1.13.7', date:'May 12, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Freight modal: clicking a rate card now writes carrier, freight cost, AND the pickup date (to "Date Shipped") into the drawer immediately — no longer waits for the explicit Select Rate button. Switching cards rewrites with the latest selection. Select Rate still works (closes modal + toast) and re-applies idempotently.'},
        {t:'fix', d:'Freight modal: pickup date now propagates to the drawer\'s Date Shipped field. Previously the field stayed empty / on its prior value when a rate was selected, since only carrier + cost were pushed.'},
      ]
    },
    {
      v:'1.13.6', date:'May 12, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Select Rate on an ABF card with a dynamic discount now applies the net (discounted) cost to the order\'s freight field, not the standard rate. Per-rep direction: we book in advance to capture the discount, so the net IS our actual cost. Toast already showed the net headline; the underlying value the order saves now matches.'},
      ]
    },
    {
      v:'1.13.5', date:'May 12, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'ABF rate cards with a dynamic discount now lead with the net (discounted) estimate in orange, followed by the −$X.XX dyn. discount note (green) and the actual standard cost (muted) below it. Previously the actual cost was the headline and the discount lived underneath — flipped because the rep wants the discounted price visually dominant. Cards without a dynamic discount are unchanged.'},
      ]
    },
    {
      v:'1.13.4', date:'May 12, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Get Freight Quote modal: Pickup Date input moved to the main form (above Accessorials) so the rep sets it before pressing Get Rates. The date is sent with the rate request and drives ABF\'s ShipMonth/Day/Year (so TRDAYS / DUEDATE / transit display now reflect the actual pickup day, not server "today"). OD\'s SOAP rate API has no pickup-date field, so OD rates remain pickup-date-agnostic (called out in code comment). Default = today on modal open.'},
        {t:'ui', d:'Get Freight Quote modal: the post-rates Contact Phone field is removed entirely — was never required for rate quoting, and the dormant in-app ABF booking flow (kept for possible future revival) now pulls phone from the order\'s customer snapshot automatically.'},
        {t:'fix', d:'Re-opening the freight modal after selecting a rate no longer leaves the prior Book Online / Select Rate booking sub-section visible — it\'s now hidden on every modal open.'},
      ]
    },
    {
      v:'1.13.3', date:'May 12, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'OD rate requests no longer add +120 lbs per pallet. Our stored per-pallet weight is already gross (booth + accessories + wooden pallet), which is what OD wants — the extra 120 was double-counting pallet weight and pushing OD rates higher than they should be. Comment block updated to reflect that ABF is the side that needs adjustment (its buildAbfUrl helper subtracts ABF_PALLET_DEDUCT_LBS because ABF rates off product weight only). Affects /api/orders-freight only; QB /api/freight is ABF-only and was already correct.'},
      ]
    },
    {
      v:'1.13.2', date:'May 12, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'ABF rate cards in the orders dashboard "Get Freight" popup now surface the dynamic discount when ABF returns one. Shown beneath the standard cost as `−$XX.XX dyn. discount` (green) plus a `$YY.YY net est.` line. Parsed value was already available from lib/freight.js parseAbfXml (DYNDISC element) but had never been wired through /api/orders-freight to the card render — only the quote builder warned about it. The discount is not guaranteed at booking, so it stays visually subordinate to the actual cost; reps see what ABF *might* knock off when they book on arcb.com.'},
      ]
    },
    {
      v:'1.13.1', date:'May 12, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'ABF rate requests now subtract 144 lbs of pallet wood from each pallet weight before calling ABF. Our stored per-pallet weight is the gross floor weight (booth + accessories + wooden pallet), and ABF rates off product-only weight — they add pallet weight on their side. Without this we over-reported by ~144 lbs/pallet and ABF returned higher rates than its own public quote page. Floored at 0 so an unusually light pallet doesn\'t send a negative weight. Applied in lib/freight.js buildAbfUrl, so both the QB /api/freight path and the orders dashboard /api/orders-freight path benefit. OD path unchanged (its existing +120 adjustment stays).'},
      ]
    },
    {
      v:'1.13.0', date:'May 12, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Process Order is now blocked when the shipping address is incomplete. Required fields: street address, city, state, ZIP. Enforced on the server (/api/process-order returns 400 with the missing-field list) and pre-checked on both clients (Quote Builder reads the live DOM and toasts; Deal Hub reads the saved snapshot and toasts the rep back to the quote since the Hub modal can\'t edit ship-to). ZIP-only is still fine for rate quoting (v1.12.1/v1.12.2) — this only gates actual fulfillment. Server logs blocked attempts as `process-order.blocked-no-ship-address` with the missing fields + rep so we can see if any rep is hitting it repeatedly.'},
      ]
    },
    {
      v:'1.12.4', date:'May 12, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Orders dashboard now resolves multi-pallet booths for the full HubSpot product catalog. The orders dashboard was carrying its own copy of BOOTH_DATA (separate from quote-builder.html) that had diverged: missing every MDL shell larger than 9696 (so MDL 96120, 96144, 96168, 96192, 102102, 102126, 102144, 102168, 102186 and all NV variants returned "—"), plus several shared entries had stale pallet dims (Drum Booth, MDL 4848 S, MDL 7272 E, MDL 9696 S/E, etc.). Synced the orders-dashboard copy from QB (the source of truth — that\'s the widget reps verify against real shipments). Quote-builder.html:1806 stays the master copy; orders-dashboard.html:714 must be kept in lockstep.'},
        {t:'fix', d:'Orders dashboard pallets now carry the FULL shipment weight (booth + accessories), not just the booth item\'s weight. Previous logic distributed only the booth\'s own per-unit weight across its pallets, so a 2,985-lb shipment with a 2,236-lb booth + 749 lbs of accessories was rated by ABF as just 2,236 lbs — under-reporting the freight. Now mirrors what quote-builder does at the freight-call site (sum total then distribute across pallets).'},
        {t:'ui', d:'Suppressed misleading "N items missing pallet data" warning when at least one booth was identified. Accessories like ADA, HX, SL, WDO, AP, VSS, EFS, BASS TRAPS etc. ride along on the booth\'s pallets — they\'re not separate freight, so flagging them as "missing" caused unnecessary alarm. Still surfaces the warning when NO booth matched (genuinely unknown shipment shape).'},
      ]
    },
    {
      v:'1.12.3', date:'May 12, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Orders dashboard freight modal now pulls in multi-pallet booths correctly. Root cause: BOOTH_DATA lookup was a strict exact-string match on item.name, but HubSpot product names often carry a suffix (color, finish, e.g. "Drum Booth - Slate" or "MDL 9696 E - White"), so the lookup missed and the modal fell back to a single default pallet for every order. New findBoothData() helper tries exact → case-insensitive exact → longest-key prefix match with a word boundary, so "Drum Booth - Slate" → 3 pallets and "MDL 9696 E - White" → "MDL 9696 E" (2 pallets, not "MDL 9696 S").'},
        {t:'ui', d:'Removed the green "Book ABF Shipment" button from the freight modal. ABF and Old Dominion both use the blue "Book Online" button now (deep-links to the carrier\'s booking page). bookShipment() + /api/book-abf-shipment endpoint kept dormant in case in-app booking is revived later.'},
      ]
    },
    {
      v:'1.12.2', date:'May 12, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Tax calculation no longer blocks on missing ship-to state — only the destination ZIP is required, matching the v1.12.1 freight relaxation. Follow-up to Travis\'s test: freight worked from ZIP alone but tax still threw the "Please fill in the ship-to state and zip code" alert immediately after. If TaxJar rejects without a state, the error now surfaces inline in the tax status row instead of as a blocking popup.'},
      ]
    },
    {
      v:'1.12.1', date:'May 12, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Freight quote no longer blocks on missing ship-to city/state — only the destination ZIP is required now. The client-side "Please fill in the ship-to address first" alert was a UX speed bump for reps doing quick rate checks (e.g. when a lead only has a ZIP). ABF geocodes city/state from ZIP server-side, so this is purely a validator relaxation.'},
        {t:'log', d:'lib/freight.js buildAbfUrl now omits ConsCity / ConsState from the ABF URL entirely when blank, instead of sending empty params (ABF rejects `ConsCity=&ConsState=`). If the rep fills city/state, those still pass through as before.'},
      ]
    },
    {
      v:'1.12.0', date:'May 11, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Process Order modal (both Deal Hub AND Quote Builder) now includes a Shipping Email Recipients module — same shape as the orders dashboard drawer. To field auto-fills with the contact email; rep can add CCs with the + CC button. Captured at process-order time and stored on the order so when Jeromy later opens it on the Orders dashboard to ship, the recipients are already populated and shown one per line — no re-typing.'},
        {t:'log', d:'Backend /api/process-order extended: extracts shipEmailTo + shipEmailCc from the request body, normalizes (lowercase + trim, falls back To to customer.email when blank, filters empty CCs), and persists into order_data.shipEmailTo / order_data.shipEmailCc. The orders dashboard PATCH endpoint already accepted these fields so the orders drawer just reads what process-order saved.'},
      ]
    },
    {
      v:'1.11.0', date:'May 11, 2026', tag:'feature',
      changes:[
        {t:'add', d:'New "📞 Log Call" button in the Deal Hub action row. Opens a modal with a textarea for the conversation notes — submit creates a real HubSpot Call activity (engagement) on the deal, attributed to the logged-in rep, marked OUTBOUND/COMPLETED, with an auto-generated title ("Call with <contact> — <date>"). Shows up in HubSpot\'s deal timeline and counts toward the rep\'s call-volume reports — same as if they\'d logged it in HubSpot directly.'},
        {t:'log', d:'Backend: POST /api/deals/:dealId/log-call creates a Call object via /crm/v3/objects/calls with an inline association to the deal (associationTypeId 206 = Call→Deal, HUBSPOT_DEFINED). Properties set: hs_timestamp, hs_call_body, hs_call_title, hs_call_direction=OUTBOUND, hs_call_status=COMPLETED, hubspot_owner_id. Logs deal.call-logged on success and error.log-call on HubSpot rejection.'},
      ]
    },
    {
      v:'1.10.4', date:'May 11, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'"Select Rate" toast was reading "null — null applied · $undefined" because closeFreightModal() reset the _selected* state vars before the toast template ran. Snapshot the values into locals before closing. (Same bug existed in the v1.10.1-and-earlier "Rate Only" button — just got more visible now that Select Rate is the primary action.)'},
      ]
    },
    {
      v:'1.10.3', date:'May 11, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'ABF Guaranteed rate cards: transit slot now reads "2 business days · by Wed, May 13" (using the advertised transit string + a friendly formatted delivery date) instead of the raw GUARANTEEDDELDATE in YYYY-MM-DD format. Matches the readability of Standard LTL\'s transit display.'},
      ]
    },
    {
      v:'1.10.2', date:'May 11, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Get Freight modal action flow restructured. Clicking a rate card now just highlights it (no auto-open of carrier site, no auto-clipboard) — those moved to explicit buttons in the booking sub-section. New button "Book Online ↗" opens the carrier\'s quote page in a new tab and (for OD) copies the reference number to clipboard. New button "Select Rate" applies the carrier + freight cost to the order\'s shipment fields and closes the modal. The existing "Book ABF Shipment" button still appears for bookable ABF Standard LTL rates.'},
        {t:'ui', d:'Removed the misleading ↗ glyph from rate cards (it implied click-to-open which is no longer the behavior). Card hover title updated to "Click to select this rate".'},
      ]
    },
    {
      v:'1.10.1', date:'May 11, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Get Freight modal: removed the Special Instructions field (was ABF-only) and the Rate Only button from the booking sub-section after a rate is selected. Section now shows just Pickup Date / Contact Phone, plus the Book ABF Shipment button when a bookable ABF rate is selected.'},
      ]
    },
    {
      v:'1.10.0', date:'May 11, 2026', tag:'feature',
      changes:[
        {t:'add', d:'ABF Guaranteed Transit Options now appear as additional rate cards in the Get Freight modal when ABF can guarantee the lane. Each guaranteed-by-time option (e.g. "Guaranteed by 12:00 PM" / "Guaranteed by 5:00 PM") gets its own card with the option\'s price and delivery date — same shape as ABF\'s Time Critical tab on arcb.com. Cards click-through to the same arcb.com rate-quote page (sharing the parent quote ID) so the rep can see the full breakdown and book on ABF\'s site.'},
        {t:'log', d:'parseAbfXml now extracts <GUARANTEEDOPTIONS> from the rate response (each <OPTION>: GUARANTEEDCHARGE / GUARANTEEDDELDATE / GUARANTEEDBYTIME), per the official ArcBest XML API docs. Returned as `guaranteedOptions[]` on the parsed result; the orders-freight endpoint generates one carrier-card row per option.'},
        {t:'log', d:'parseAbfXml quote-id parsing narrowed to the documented `<QUOTEID>` element (no more fallback candidates — confirmed by ArcBest API docs).'},
        {t:'ui',  d:'In-app "Book ABF Shipment" button now gates on `bookable: true` (was: gated on carrier name only). ABF Guaranteed cards are intentionally bookable: false because Time-Critical requires extra BOL fields beyond what our internal book flow supports — rep books those on arcb.com directly via the existing card-click deep-link.'},
      ]
    },
    {
      v:'1.9.15', date:'May 11, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'OD pallet weight constant corrected from 140 lbs → 120 lbs per pallet (v1.9.14 used 140; actual is 120).'},
        {t:'ui',  d:'Removed the blue "Book on OD.com ↗" button from the Get Freight modal\'s booking sub-section. With the OD card now opening OD\'s reference-search page directly on click (and the reference number copied to clipboard), the separate book button was redundant. Selecting an OD rate now just shows "Rate Only" alongside the ABF book button when an ABF rate is selected.'},
      ]
    },
    {
      v:'1.9.14', date:'May 11, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'OD rate requests now add 140 lbs per pallet (the pallet itself) to the per-item weight. OD prices off gross weight including the pallet; ABF prices off product weight (unchanged on the ABF path). Last remaining knob in the OD price-discrepancy investigation — combined with v1.9.12 (no double-count) and v1.9.13 (NMFC), OD rates from the modal should now match what OD\'s own page returns.'},
      ]
    },
    {
      v:'1.9.13', date:'May 11, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'OD rate requests now include NMFC 027880 sub 02 on every freight item (matching what we already send to ABF). Per OD\'s API docs and WSDL, when both ratedClass and nmfc are provided, nmfc wins — so OD will now price based on the actual commodity classification instead of a generic freight class. Fixes a rate discrepancy where OD was returning class-only rates that didn\'t match the NMFC-based pricing the account is contracted for.'},
      ]
    },
    {
      v:'1.9.12', date:'May 11, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'OD rates in the Get Freight modal were displaying ~$50–$200 too high — every quote since the OD integration was added. Root cause: parseOdSoap was summing netFreightCharge + fuelSurcharge + totalAccessorialCharge, but OD\'s netFreightCharge is already the all-in total (gross + fuel + accessorial all included). Verified against the API docs sample (page 30): grossFreightCharge 140 + fuelSurcharge 58.10 + totalAccessorialCharge 1092.50 = 1290.60 = netFreightCharge exactly. So we were double-counting fuel and accessorials. Fix is one line: total = netCharge. Going forward OD rates will match what OD\'s own page shows.'},
        {t:'add', d:'Clicking an OD rate card now copies the rate reference number to your clipboard AND opens OD\'s rate-reference-search page in a new tab. Reps just paste (Ctrl+V) into OD\'s search field instead of retyping. A toast confirms the copy. Workaround for OD\'s search page using a JS-submitted form with no URL parameter we can deep-link.'},
      ]
    },
    {
      v:'1.9.11', date:'May 11, 2026', tag:'feature',
      changes:[
        {t:'add', d:'OD rate cards in the Get Freight modal now show a "Ref: XXXX" reference number when one is returned. The rate API\'s requestReferenceNumber flag is now enabled on every OD call (the WSDL confirms this is purely read-only — no booking happens, just adds a quote-side reference to the response). Useful as a paste-ready ID the rep can quote to OD support if they need to follow up on a specific quote. Reference appears inline next to "Transit:" — only when OD returns a real (non-zero, non-empty) value.'},
        {t:'log', d:'parseOdSoap parses <referenceNumber> from the SOAP response, treats "0" as no-reference (the docs sample shows 0 even with the flag on), and logs real refs as "[orders-freight] OD <shipType> referenceNumber: ...".'},
      ]
    },
    {
      v:'1.9.10', date:'May 11, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'OD carrier cards in the Get Freight modal no longer click-through to OD\'s ship-LTL tool — that URL was a generic quote page (not a saved-rate viewer), so it was misleading. Reason: OD doesn\'t expose saved rate quotes anywhere on their public site or myOD portal in a way we can deep-link. ABF cards still click-through to arcb.com (where saved quotes ARE viewable). The "Book on OD.com" button in the booking sub-section is unaffected — it still opens OD\'s tool with destination pre-filled, which is the right tool for actually booking.'},
        {t:'ui',  d:'The ↗ external-open glyph now only appears on cards that have a real deep-link (i.e. ABF), so the rep knows at a glance which clicks open externally vs which just select the rate.'},
      ]
    },
    {
      v:'1.9.9', date:'May 11, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Clicking a carrier card in the Get Freight modal now opens that carrier\'s own quote page in a new tab — ABF\'s rate-quote viewer (https://arcb.com/tools/rate-quote.html#/<quoteId>) for ABF rows, OD\'s ship-LTL tool with the destination pre-filled for OD rows. Lets the rep see everything the carrier shows on its own site, including service notes the rate API doesn\'t expose (e.g. "Delivery is only available on Tuesday, Wednesday, and Thursday" for restricted destinations). Also still selects the rate locally so the existing Use This Rate / Book flow works the same.'},
        {t:'add', d:'A small ↗ glyph appears next to the service label when the carrier card has a deep-link, so the rep knows clicking opens an external page.'},
        {t:'log', d:'parseAbfXml now extracts an ABF quote ID from the rate response (tries RATEQUOTENUMBER, QUOTENUMBER, QUOTEID, QUOTEREF, RATEQUOTEID, RESPID and a couple of attribute styles), used to build the deep-link. All matching candidates are logged so a missed XML element shape can be added on the next test.'},
      ]
    },
    {
      v:'1.9.8', date:'May 11, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Get Freight modal now surfaces ABF service-level notes inline under the carrier card (e.g. "Delivery is only available on Tuesday, Wednesday, and Thursday." for destinations with restricted delivery days). Yellow ⚠ banner appears below the rate so the rep sees the constraint before booking. Note text is parsed defensively from several possible XML element names (NOTE / MESSAGE / SERVICEMSG / DELIVERYNOTE / etc.) and ITEM elements with descriptive FOR attributes — if a real-world ABF note slips past the parser, the raw XML is logged so the missed element can be added.'},
      ]
    },
    {
      v:'1.9.7', date:'May 11, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Orders dashboard drawer Quote Weight block reformatted to match the Quote Builder\'s widget exactly: Total weight on its own line, Pallets count, then "Pallet 1: 102"×52"×44"" / "Pallet 2: ..." per-pallet dimensions listed below. Replaces the v1.9.6 single-line summary so the orders side reads identically to the quote side.'},
      ]
    },
    {
      v:'1.9.6', date:'May 11, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Orders dashboard drawer now shows an Estimated shipment line above the Shipment section: pallet count and total weight, computed from the order\'s line items + the booth pallet map. At-a-glance answer to "how big is this order to ship?" before opening the Get Freight modal. If any line item has no pallet mapping, a yellow ⚠ marker calls out how many — hover for the SKU list.'},
        {t:'ui',  d:'Get Freight modal now shows column headers (Length / Width / Height / Weight) above the pallet-dimension inputs. Previously the four inputs had only placeholder hints that disappeared once filled — hard to tell which column was which after entering numbers.'},
        {t:'log', d:'Refactor: pallet/weight calculation extracted from openFreightModal into a shared computeShipmentEstimate(order) helper, so the drawer\'s estimate line and the freight modal\'s pre-fill use the exact same logic and stay in sync.'},
      ]
    },
    {
      v:'1.9.5', date:'May 11, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Deal Hub now shows every Closed Won deal regardless of recency. Previously the board fetched the 200 most-recently-modified deals and filtered them into columns, so Closed Won deals that had been silent for weeks (customer build pending, awaiting approval, etc.) fell off the back and the Closed Won column would appear empty even when there were active orders sitting in it.'},
        {t:'log', d:'Two-part fix on /api/deals/list: (1) when no specific stage is requested, the main fetch is now filtered to the 5 board stages (appointmentscheduled, qualifiedtobuy, contractsent, closedwon, 845719) so the per-page budget isn\'t eaten by Closed Lost; (2) a dedicated Closed Won pass paginates every Closed Won deal regardless of recency (10-page safety cap = 2000 deals) and merges into the result, deduped by deal id. Rep filter is respected in both passes.'},
        {t:'ui',  d:'Frontend deal-board request bumped from limit=200 to limit=500 for headroom across the other four columns.'},
      ]
    },
    {
      v:'1.9.4', date:'May 11, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Deleting a QB invoice from the Accounting page now also deletes the QB Payment(s) we created on order processing or via Mark as Paid. Previously the invoice would go but the payment was left applied to a now-missing invoice — a reconcile and accounting hazard. Payments are deleted first (so a failed invoice delete leaves nothing orphaned), then the invoice, then qbPayments / qbPaidAt are cleared from the local order_data alongside the existing qbInvoiceId / qbDocNumber cleanup. Per-payment success/failure is logged on the qb.invoice.deleted activity entry; a missing payment (already gone) is treated as success and doesn\'t block the invoice delete.'},
        {t:'log', d:'New lib helpers: qb.getPayment(id), qb.deletePayment(id). Mirror the existing getInvoice/deleteInvoice pattern (fetch for SyncToken, POST operation=delete). getPayment returns null on 404 so callers can treat already-deleted payments as no-ops.'},
      ]
    },
    {
      v:'1.9.3', date:'May 8, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'The customer-facing invoice page now shows the International / Canadian Order block (wire-transfer notice + customs broker line) the same way the quote page does. Previously the quote had this block but the invoice didn\'t, so customers who accepted a Canadian quote got an invoice with no mention of the wire-transfer requirement or the broker info on file. Block only renders when the order has the canadian flag set.'},
      ]
    },
    {
      v:'1.9.2', date:'May 8, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Reconcile now uses the deal\'s HubSpot total_tax_amount field as the source of truth when present, instead of reverse-calculating from tax_rate × deal total. Removes the round-trip math (and its rounding mismatches with QB\'s tax) for any deal pushed from this app since total_tax_amount started getting populated. If total_tax_amount is empty (legacy deal, manual deal), reconcile falls back to the existing tax_rate reverse-calc unchanged. A literal "0" counts as set (tax-exempt deals stay at 0, don\'t fall through). The /api/reconcile/hs-deals response now also returns taxSource ("hubspot" | "rate-calc" | null) for diagnostics.'},
      ]
    },
    {
      v:'1.9.1', date:'May 8, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Shipping an order from the Orders dashboard no longer overwrites the deal\'s "Freight + Install Cost" (HubSpot freight_cost) with the entered actual freight. Ship-time freight now writes only to actual_freight_cost, leaving the originally-quoted amount intact for reporting and reconciliation. (The HS-only-legacy branch already did this correctly; the regular DB-backed branch had a vestigial double-write.)'},
      ]
    },
    {
      v:'1.9.0', date:'May 8, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Audimute PO documents now include a Change Log section near the bottom showing every edit since the PO was created — who, when, and what changed (color, ship-to address, status, expected ship date, tracking number, notes). Visible on both the screen view and the printed/PDF copy so the supplier can see updates at a glance. Powered by the existing logs table; no schema changes.'},
        {t:'fix', d:'Expected Ship Date no longer "resets to invalid date" when saved on the Suppliers dashboard. Root cause: node-postgres was parsing DATE columns to JS Date objects, which round-tripped through JSON as ISO timestamps that <input type="date"> rejects. Added a pg type parser that returns DATE columns as raw YYYY-MM-DD strings (the format every consumer in this app already expected). Also fixes the silent off-by-one in the late-PO highlight logic on the Suppliers board.'},
        {t:'fix', d:'Verifying-and-overriding the Ship-To address on PO creation now actually persists. The v1.8.0 dialog was sending the edited customer object to the create endpoint, but the endpoint was only reading apItems and notes — body.customer was silently dropped. Create now merges body.customer over the order snapshot.'},
        {t:'ui',  d:'PO status bar (Status / Expected Ship / Tracking) is no longer hidden on the printed/PDF copy. Print button stays hidden in PDFs.'},
        {t:'log', d:'Both PATCH branches (po_data edits + column-level inline edits) now compute structured per-field diffs (kind, label, from, to, item) and emit them as supplier-po.edited log events. PO creation also emits a supplier-po.created seed event. The new PO Change Log queries these by event prefix + meta.poNumber.'},
      ]
    },
    {
      v:'1.8.0', date:'May 8, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Audimute POs are now editable. Open an existing PO from the AP badge in the Deal Hub or the Edit button on the Suppliers dashboard. Editable: ship-to address, per-item color, and notes. Line items themselves stay tied to the underlying order — to change those, delete the PO and recreate from the order.'},
        {t:'add', d:'Ship-to address is now verified-and-editable when you first create a PO. The dialog pre-fills from the order\'s customer snapshot but every field (name, company, address, city, state, zip, country) is an input — override anything that needs to ship somewhere else before submitting.'},
        {t:'add', d:'Status-aware edit guards: \'pending\' edits freely; \'sent\', \'confirmed\', \'shipped\' show a banner reminding you Audimute won\'t be auto-notified; \'complete\' is locked (Edit button disabled, server returns 403).'},
        {t:'add', d:'Existing-PO badges in the Deal Hub now open in edit mode (with View ↗ link in the header and Delete button in the footer) instead of jumping straight to the public PO page. The badge becomes the single point of access for view/edit/delete.'},
        {t:'log', d:'New PATCH branch on /api/supplier-pos/:poNumber accepts customer / apItems / poNotes for po_data updates. apItems updates only mutate the per-item color field; name/qty/price are preserved server-side so the request body can\'t tamper with pricing. Edit events go to the admin log as supplier-po.edited.'},
      ]
    },
    {
      v:'1.7.33', date:'May 8, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Delete button added to each row on the Suppliers dashboard. Clicking Delete prompts for confirmation then permanently removes the PO from the database. Deletion is logged in the activity log.'},
      ]
    },
    {
      v:'1.7.32', date:'May 8, 2026', tag:'feature',
      changes:[
        {t:'add', d:'International quotes now include a Country field in the quote builder (appears when Canadian / International Destination is checked). Country is stored in the customer snapshot and shown in the Ship To address on quote, invoice, and order pages.'},
        {t:'add', d:'"All international orders must be prepaid in full with bank wire transfer." now appears on quotes, invoices, and order pages whenever the Canadian / International flag is set.'},
      ]
    },
    {
      v:'1.7.31', date:'May 8, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'PO number format changed from WR-PO-YYYYMM-NNNN to WR{YY}{MM}{DD}{NN} (e.g. WR26050801). The sequential counter now resets each day and is 2 digits. Uses Eastern time to match the issue date printed on the document.'},
      ]
    },
    {
      v:'1.7.30', date:'May 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Audimute PO document overhauled with full BOM. Each AP SKU now resolves to its panel breakdown (2\'x4\', 1\'x4\', 1\'x2\') and Audimute wholesale cost from a single source-of-truth mapping (lib/ap-packages.js). Items table is now QTY | ITEM | DESCRIPTION | COLOR | UNIT COST | TOTAL — description shows "Includes: N - 2\'x4\' panels. N - 1\'x2\' panels." plus "N total WhisperRoom Velcro Hang Tab Packs" per item.'},
        {t:'add', d:'Panel Totals summary block below the items table aggregates panel counts × qty across all line items: shows total 2\'x4\', 1\'x4\', 1\'x2\' panels needed, plus a grand total of WhisperRoom Velcro Hang Tab Packs (1 per panel). This is the pull list Audimute fulfills against.'},
        {t:'fix', d:'PO pricing now uses Audimute wholesale cost (e.g. AP 9696 = $588) instead of the customer-facing retail price from the snapshot. Set at PO creation time so each PO is self-contained. Falls back to the snapshot price only if the SKU isn\'t in the mapping.'},
        {t:'ui',  d:'Removed the "From" (WhisperRoom) block from the PO. Vendor block updated to: Audimute / Attn: Elizabeth Wade / 23700 Aurora Road / Bedford Heights, Ohio 44146 / (216) 591-1891 x320 / ewade@audimute.com. Parties row is now 2-column (Vendor + Ship To).'},
        {t:'ui',  d:'Items missing a color show "— TBD —" in red on the PO so it\'s obvious what still needs an answer before sending.'},
      ]
    },
    {
      v:'1.7.29', date:'May 7, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'"Create Audimute PO" was failing with "quoteNumber required" because the request body was being read as a string and never JSON.parse\'d. Same bug existed silently on the supplier-pos PATCH endpoint (status/tracking updates from the Suppliers board) and the orders mark-paid endpoint (custom amount/date/method overrides were ignored). All three now JSON.parse the body correctly.'},
        {t:'fix', d:'AP PO dialog was always showing "no shipping address on file" because it was reading the deal\'s HubSpot contact instead of the order\'s snapshot customer (which has the actual ship-to). The hub endpoint now returns the snapshot customer per order and the dialog uses it first, falling back to the deal contact only if the snapshot is empty.'},
        {t:'ui',  d:'Renamed AP chip states for clarity: "AP !" red = not submitted (was gray), "AP ⏳" yellow = PO in flight, "AP ✓" green = delivered. Quote-row chip stays a neutral orange since it\'s a presence indicator only (PO state lives on the order). Same scheme on pipeline deal cards and order cards in the deal hub.'},
      ]
    },
    {
      v:'1.7.28', date:'May 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'AP chip now appears on the deal card itself in the pipeline (alongside RM and CUST), with status-aware coloring: gray "AP" = no PO yet, yellow "AP ⏳" = at least one Audimute PO in flight, green "AP ✓" = all PO orders delivered. Aggregate is computed across every quote+order on the deal so you can see Audimute status at a glance from the kanban board.'},
        {t:'add', d:'AP chip also appears on each quote row inside the deal hub right panel — flagged on whichever specific quote(s) include AP line items.'},
        {t:'log', d:'/api/deals/list now returns hasAP and apStatus per deal (single LATERAL-style supplier_pos lookup batched for the whole page); /api/deals/:id/hub returns hasAP per quote.'},
      ]
    },
    {
      v:'1.7.27', date:'May 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Audimute PO management moved to the Deal Hub. Each order in the deal hub right panel now shows an "AP" badge if the order contains acoustic-package line items. Three states: gray (no PO yet — click to create), yellow ⏳ (PO submitted to Audimute, in flight), green ✓ (delivered). Status flips to green when the Suppliers board status is set to "complete".'},
        {t:'add', d:'New Create Audimute PO dialog. Triggered from the AP badge click. Lists every AP line item from the order with its quantity, plus a per-item color picker (defaults to the order\'s AP color). Ship-to is shown for confirmation. Notes field for anything Elizabeth needs. Each PO is created with one entry per AP item, each carrying its own color — supports orders with mixed packages or different colors per package.'},
        {t:'add', d:'PO document (/po/:poNumber) now displays the chosen color per line item as an inline chip in the items table, replacing the single-color "Acoustic Package Specifications" block. Existing legacy POs (pre-1.7.27) still render with the old global color for backward compatibility.'},
        {t:'fix', d:'Removed the AP Purchase Order section from the Orders dashboard drawer entirely — it was crowding the production-focused view and the new deal-hub badge is a much cleaner home. The badge handles create / view / status all in one place.'},
        {t:'log', d:'Deal hub /api/deals/:id/hub endpoint now returns apItems[], apColor, and po (latest supplier PO row) per order in a single query (LATERAL join), so the badge has everything it needs without an extra round trip.'},
      ]
    },
    {
      v:'1.7.26', date:'May 7, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'AP Purchase Order section now appears in the orders drawer when an order has an AP color set, even if the line item naming doesn\'t match the strict "AP 4848" pattern. Previously it required line items beginning with "AP " (space) — orders with names like "AP-4848", "AP4848", or "Acoustic Package …", or older orders with no json_snapshot, never showed the section even though they were AP orders.'},
        {t:'fix', d:'Server-side AP detection (POST /api/supplier-pos) broadened to match "AP[space|-|_]<digit>" and "Acoustic Package …" across name/productName/sku/description, so the PO creation step accepts the same orders the UI surfaces.'},
        {t:'log', d:'Added a console.debug "[AP detect]" line on drawer open showing snapshot/line-item state — makes it easy to diagnose why the AP section did/didn\'t appear for a given order.'},
      ]
    },
    {
      v:'1.7.25', date:'May 7, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Folder search race condition — when typing quickly in the "Rebind Drive Folder" or "Merge Legacy Folder" search boxes, a slow earlier request could return after a newer one and overwrite results with stale data, making results appear wrong or disappear. Fixed with AbortController: each new search cancels any in-flight request before firing. Also cancels pending searches when the modal is opened/reopened.'},
        {t:'fix', d:'"Merge Legacy Folder" modal now auto-runs the search immediately when it opens, since the search box is pre-populated with the deal name. Previously the user had to delete a character or click Search to trigger anything.'},
        {t:'fix', d:'Deals board search ("searchAllDeals") had the same stale-result race condition — rapidly typed queries could render out-of-order results. Fixed with AbortController.'},
        {t:'fix', d:'Quote builder deal search had a duplicate event listener — one from the HTML oninput attribute and one from addEventListener — causing two immediate API calls plus a debounced one on every keystroke. Removed the duplicate, leaving only the debounced listener.'},
        {t:'fix', d:'Added autocomplete="off" and spellcheck="false" to both Drive folder search inputs to prevent browser autocomplete from filling values silently (without triggering oninput).'},
      ]
    },
    {
      v:'1.7.24', date:'May 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Auto-create QB Payment when an order is processed, for all payment types EXCEPT PO. Runs immediately after the QB invoice is created using the same defaults as the manual Mark Paid flow (PaymentMethod "Hubspot", deposit "Southeast Bank Regular Checking 2545"). PO orders stay open until payment actually arrives — those can still be marked paid manually from the orders drawer. Auto-payment failures are logged but don\'t block invoice creation.'},
      ]
    },
    {
      v:'1.7.23', date:'May 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'"Mark as Paid" button in the Orders admin dropdown — creates a QB Payment record applied to the linked invoice. Mirrors the QB "Receive Payment" screen exactly: payment method "Hubspot", deposit to "Southeast Bank Regular Checking 2545", payment date today. All three values can be overridden in the dialog. Amount pre-filled with current invoice balance and accepts $/comma formatting. Supports partial payments — click again to record the balance later. Dialog defaults configurable via QB_PAYMENT_METHOD_NAME / QB_DEPOSIT_ACCOUNT_NAME env vars.'},
        {t:'add', d:'QB balance check on the orders drawer — when a QB invoice is linked, the admin section shows current balance ("Paid in Full" green badge, partial paid breakdown, or balance due in amber). Live read from QB so it reflects payments entered manually in QB too.'},
      ]
    },
    {
      v:'1.7.22', date:'May 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Audimute Purchase Order system — the foundation for supplier management. Orders with AP items now show a "Create Audimute PO" button in the admin dropdown. Creates a clean, branded PO document at /po/:poNumber with a shareable link, including ship-to (customer address), AP line items, AP color, and reference number.'},
        {t:'add', d:'Suppliers dashboard at /suppliers — tracks all Audimute POs in a table with status (pending → sent → confirmed → shipped → complete), expected ship date, tracking number, and late-order highlighting (red row when expected ship date has passed). Inline editable ship date and tracking fields with Save button.'},
        {t:'add', d:'Send PO email — one-click opens a pre-filled mailto: draft to ewade@audimute.com with PO link, ship-to address, item list, and AP color. Automatically marks PO as sent.'},
        {t:'add', d:'"Suppliers" nav link added to all dashboard pages (Quotes, Orders, Shipping, Reports, Accounting, Deal Hub).'},
      ]
    },
    {
      v:'1.7.21', date:'May 7, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Freight Cost field on the orders dashboard now accepts "$500", "$1,200.00", "500", etc. Previously the field was type="number" so any "$" or comma silently invalidated the input and nothing transferred to HubSpot. Switched to type="text" with a parseFreightCost() helper that strips $/commas/whitespace before parsing.'},
      ]
    },
    {
      v:'1.7.20', date:'May 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'"Create QB Invoice" button in the Orders admin dropdown. Reads line items, freight, discount, tax, customer, and billing from the stored quote snapshot and creates a QB invoice using the same logic as process-order. Shows existing QB invoice link (with overwrite warning) if one is already linked. Works for orders where process-order QB step failed or where details changed.'},
        {t:'add', d:'DEVLOG.md — full audit of backend, frontend, and security written to the repo. Covers what works well, improvement areas, and critical issues.'},
      ]
    },
    {
      v:'1.7.19', date:'May 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'When an order is marked shipped, the QB invoice "Memo on statement (hidden)" field (PrivateNote) is now populated with "Freight Cost: $XXX.XX" alongside the existing carrier, tracking, ship date, and serial number updates. Internal-only — does not appear on the customer-facing invoice.'},
      ]
    },
    {
      v:'1.7.18', date:'May 7, 2026', tag:'ui',
      changes:[
        {t:'ui',  d:'QB Invoices is now the first tab on the Accounting page and auto-loads the last 90 days when you open the page.'},
        {t:'add', d:'Search box on the QB Invoices tab. Filters the loaded invoices by customer name, doc number, or bill email as you type. Press Enter (or click "Search All") to fetch all invoices across all time — no date filter — then type to narrow results.'},
        {t:'fix', d:'Server endpoint /api/qb/invoices now accepts no date params to return all invoices; credit/refund fetches are skipped in the all-time path.'},
      ]
    },
    {
      v:'1.7.17', date:'May 7, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Quote Builder top nav now includes "Accounting" link, matching the Deal Hub and other dashboards.'},
      ]
    },
    {
      v:'1.7.16', date:'May 7, 2026', tag:'ui',
      changes:[
        {t:'add', d:'Search box on the Accounts Receivable tab. Filters the visible rows by company name or doc number as you type (case-insensitive substring match). Works in combination with the existing aging-bucket filter — search applies on top of whichever bucket is selected. Aging summary boxes still reflect the full open-invoice picture.'},
      ]
    },
    {
      v:'1.7.15', date:'May 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'QB invoice "Note to customer" (CustomerMemo) is now hardcoded to: "Finance charges of 1.5% per month will be added to invoices not paid by the due date." Previously the field carried the deal name, which was redundant with the invoice number and customer company already on the invoice.'},
      ]
    },
    {
      v:'1.7.14', date:'May 7, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'QB invoice Bill To section now includes the rep-entered Bill To Name (in BillAddr.Line1, with the street address shifted to Line2) and the Bill To Email (on BillEmail.Address, falling back to the customer\'s primary email when no separate billing email was entered).'},
      ]
    },
    {
      v:'1.7.13', date:'May 7, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'QB invoices now default to "apply discount before sales tax" automatically. Sets ApplyTaxAfterDiscount: true on every invoice we create via the API, so the More Options toggle in QB starts in the correct state without needing to flip it manually each time. Result: taxable subtotal = post-discount, matching TaxJar exactly.'},
      ]
    },
    {
      v:'1.7.12', date:'May 7, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Billing address now actually transfers to the QB invoice. The server-side fix from v1.7.9 was reading body.billing, but neither the quote builder\'s confirmProcessOrder nor the deal hub\'s confirmProcessOrderFromHub was sending it — only the customer (ship-to) object. Both clients now include the billing object in the process-order POST: quote builder pulls from the live #bill* form fields (null when "Same as ship-to" is checked), and the deal hub passes through snap.billing from the loaded snapshot.'},
      ]
    },
    {
      v:'1.7.11', date:'May 7, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Reverted the TxnTaxDetail QB tax override introduced in v1.7.9–v1.7.10. The root cause of the tax/discount mismatch was a QB Online setting ("apply tax before/after discount") rather than a code issue. With that setting flipped to post-discount and AST re-enabled, QB AST naturally taxes the correct base — no API override required. The billing address fix from v1.7.9 (using the rep\'s separate billing object instead of always copying the ship address) is retained.'},
      ]
    },
    {
      v:'1.7.10', date:'May 7, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'QB invoice creation was returning a 2010 "failed to parse json object" error after v1.7.9 enabled the tax override. Cause: the TaxLineDetail.Override field and top-level TxnTaxDetail.TotalTax field appear in some QB SDK samples but are not valid JSON request properties — QB rejected the entire payload. Removed both. The remaining structure (TxnTaxCodeRef + TaxLine with explicit Amount, TaxPercent, NetAmountTaxable, TaxRateRef) is the documented non-AST override path. Requires QB Online with Automated Sales Tax disabled.'},
      ]
    },
    {
      v:'1.7.9', date:'May 7, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'QB invoice tax now matches the quote exactly. QB Online\'s Automated Sales Tax was taxing the gross subtotal (pre-discount), while TaxJar taxes the net (post-discount) — the legally correct base. Result: QB invoices were over-collecting tax by (rate × discount). Fix uses QB\'s per-invoice override flag (TxnTaxDetail.TaxLineDetail.Override:true) to force the TaxJar amount through, leaving AST enabled for everything else. AST keeps tracking liability normally; only the displayed tax dollar amount is overridden.'},
        {t:'fix', d:'QB invoice billing address now uses the rep\'s separate billing address when present, instead of always copying the shipping address. Previously the process-order route never read the billing object from the request body, so QB always saw ship-to in the Bill To field.'},
      ]
    },
    {
      v:'1.7.8', date:'May 7, 2026', tag:'security',
      changes:[
        {t:'security', d:'QB invoice deletion gating switched from HubSpot ownerId to login email. Allowed by default: bentonwhite@whisperroom.com and accounting@whisperroom.com. The previous ownerId allowlist (36303670 / 38732178) wasn\'t matching the accounting@ login. Override env var renamed: QB_INVOICE_DELETE_OWNERS → QB_INVOICE_DELETE_EMAILS (comma-separated, case-insensitive).'},
      ]
    },
    {
      v:'1.7.7', date:'May 7, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Deal Hub Process Order modal now pre-fills foam color, door hinge, AP color, and WA type from the rep\'s saved selections (with fallback to customer-accepted values) — matching the quote builder. Previously the snapshot endpoint stripped out the rep fields, so the modal opened blank even when those values had been chosen at quote time.'},
      ]
    },
    {
      v:'1.7.6', date:'May 7, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'WA Type selector now appears in the Deal Hub Process Order modal when the order contains a WA UPG or ADA item — matching the quote builder behavior. The selector pre-populates from the snapshot\'s saved WA type (if any) and lets the rep override it before sending. Both the deal hub and quote builder now behave consistently.'},
      ]
    },
    {
      v:'1.7.5', date:'May 7, 2026', tag:'security',
      changes:[
        {t:'security', d:'QB invoice deletion is now restricted to Benton + Kim only (by HubSpot ownerId). Server returns 403 for other users; the Delete button is hidden in the UI for everyone else. Successful deletions are logged with user, invoice #, customer, and total. Override the allowlist with QB_INVOICE_DELETE_OWNERS env var (comma-separated ownerIds). Note: requires HubSpot OAuth login — password-only sessions cannot delete.'},
      ]
    },
    {
      v:'1.7.4', date:'May 7, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Top-nav "Reconcile" link renamed to "Accounting" — the page now hosts Reconcile, QB Invoices, and AR sub-tabs. Page title and header subtitle updated to match.'},
      ]
    },
    {
      v:'1.7.3', date:'May 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Reconciler → Accounts Receivable tab. Shows all open (unpaid) QB invoices with aging summary boxes (Current / 1–30 / 31–60 / 61–90 / 90+ days late) — counts and dollar totals per bucket. Filterable by bucket, sorted oldest-due first.'},
        {t:'add', d:'QB Invoices tab now shows Terms (Net 30, Due on receipt) and a smart Status column ("Paid", "Due in Nd", "N days late") color-coded green/gray/amber/red.'},
        {t:'add', d:'Status filter on QB Invoices tab: All / Paid / Open / Due Soon (≤7d) / Overdue.'},
        {t:'add', d:'Per-row Delete button on both QB Invoices and AR tabs — opens a confirmation modal showing customer + total before permanently deleting from QuickBooks. Also clears the qbInvoiceId from the linked local order if any.'},
      ]
    },
    {
      v:'1.7.2', date:'May 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Reconciler: new "QB Invoices" tab shows all QB invoices in a date range (defaults to last 90 days), with Paid/Open status badges and a direct "Open in QB" link to pull up each invoice in QuickBooks Online.'},
        {t:'fix', d:'Deal Hub now loads up to 1,000 deals by default (was capped at 200) using cursor-based HubSpot pagination.'},
      ]
    },
    {
      v:'1.7.1', date:'May 7, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'QB Custom Field DefinitionIds were swapped — P.O. Number was writing to the Serial Number field and vice versa. Corrected: DefinitionId 1 = P.O. Number, 3 = Serial Number.'},
        {t:'add', d:'QB invoice now sets payment terms automatically: PO orders use Net 30, all other payment types use Due on receipt. Term names are configurable via QB_TERM_NET30 / QB_TERM_UPON_RECEIPT env vars.'},
      ]
    },
    {
      v:'1.7.0', date:'May 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'QuickBooks invoice is now auto-created when an order is processed. Line items are matched to QB items by exact name (falls back to a generic "Product" item). Freight uses QB\'s dedicated Shipping totals row via the SHIPPING_ITEM_ID magic value — not a line item. Discount is excluded from freight. Sales tax handled by QB\'s Automated Sales Tax / TaxJar using the ship-to address.'},
        {t:'add', d:'QB invoice is updated automatically when Jeromy ships an order — carrier populates ShipMethodRef, tracking number populates TrackingNum, ship date populates ShipDate, and serial number fills Custom Field "Serial Number".'},
        {t:'add', d:'QB invoice now carries Sales Rep (Custom Field), P.O. Number (Custom Field, when payment type is PO), and BillEmail from the order.'},
        {t:'fix', d:'QB customer DisplayName now defaults to company name when present (B2B), falling back to person name. Previously only the individual\'s name was used.'},
        {t:'fix', d:'Freight taxability on QB invoice now follows WR\'s own TaxJar calculation (freightTaxed flag) — prevents QB from adding freight tax in states where WR didn\'t charge it.'},
        {t:'add', d:'WA Type selector added to the Process Order modal (auto-populated from quote, dynamic options from line items). WA Type also shown in the Orders dashboard right-side drawer.'},
        {t:'fix', d:'Submit overlay text unreadable in light mode — title and message text now use correct theme variables.'},
      ]
    },
    {
      v:'1.6.4', date:'May 6, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'New quotes on existing deals now always get a fresh quote number. Previously, linking a deal made the system treat any new quote as an in-place revision — silently reusing the prior quote number even when prices/discount/freight differed. Revision-mode is now triggered only when a rep explicitly loads a historical quote to update.'},
        {t:'fix', d:'Folder picker now opens for every new quote, even when the contact has a prior Drive folder. The existing folder is offered as a one-click option but is no longer auto-bound. Files for new deals on returning customers no longer silently land in the old folder.'},
      ]
    },
    {
      v:'1.3.3', date:'Apr 21, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Payment type now reliably included in the mailto email after order processing — replaced inline IIFE with a pre-computed variable to avoid potential closure evaluation issues.'},
      ]
    },
    {
      v:'1.3.2', date:'Apr 21, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Orders dashboard: Delete Order moved inside a collapsed "Admin Override" drawer to prevent accidental clicks.'},
      ]
    },
    {
      v:'1.3.1', date:'Apr 21, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Payment type now included in the mailto email that opens after order processing (was only added to the server-side HubSpot note, not the mail client template).'},
      ]
    },
    {
      v:'1.3.0', date:'Apr 21, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Payment type now visible on order PDF and order link for all orders, including those processed before v1.2.9 — falls back to a live HubSpot deal lookup when not stored locally.'},
      ]
    },
    {
      v:'1.2.9', date:'Apr 21, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Payment type now shown in order processed email (after total weight) and on the order PDF / order link totals section; PO number included when payment type is PO.'},
      ]
    },
    {
      v:'1.2.8', date:'Apr 20, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Pickup Fee redesigned as a green checkbox with always-visible $ input; removed "(empty)" label text.'},
      ]
    },
    {
      v:'1.2.7', date:'Apr 20, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Pickup Fee button added to freight section — overrides freight with a non-taxable pickup amount; shows as "Pickup Fee" on quote, invoice, and order PDFs.'},
      ]
    },
    {
      v:'1.2.6', date:'Apr 20, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Bill To Name field added to quote builder (above billing email); appears on quote, invoice, and order PDFs, and syncs to HubSpot bill_to_name property.'},
      ]
    },
    {
      v:'1.2.5', date:'Apr 20, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Ecommerce added to rep dropdown; deals with "Shopify" in the name auto-assign to Ecommerce when linked.'},
      ]
    },
    {
      v:'1.2.4', date:'Apr 20, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Corrected pallet dimensions for MDL 9696 E and Drum Booth: two pallets at 90×52×45 and one at 102×52×45.'},
      ]
    },
    {
      v:'1.2.3', date:'Apr 18, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Deal Hub card sort: was secretly re-sorting client-side by HubSpot\\u2019s hs_lastmodifieddate, which treats any HubSpot activity (views, note edits, field touches) as a reason to bump a card up. Now strictly sorts by lastActivityAt from our system \u2014 quote pushed, order processed, quote accepted. Deals without any of those sink to the bottom by amount.'},
        {t:'fix', d:'Unintegrated dot logic: was gated on a narrow stage list (only Sent/Updated Quote stages got the dot). Now any deal without a quote / accepted flag / payment type in our system gets dimmed + gray dot, regardless of HubSpot stage. Emily-Love-type cases (no quotes, not in early stage) are now correctly flagged.'},
      ]
    },
    {
      v:'1.2.2', date:'Apr 18, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Versioning convention refined in HANDOFF.md: MINOR (1.2 → 1.3) now bumps only on meaningful new features (not on every merge to main). PATCH (1.2.0 → 1.2.1) for bug fixes and small tweaks. MAJOR (1 → 2) reserved for rewrites. Rule of thumb: if you\\u2019d say "I added X" → MINOR; "I fixed X" → PATCH.'},
      ]
    },
    {
      v:'1.2.1', date:'Apr 18, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Customer-facing invoice page: "Change Specs" button now always shows (was gated behind q.accepted, so it only appeared when the customer had clicked Accept on the /q/ page first — invoices sent directly by the rep had no spec-change path).'},
      ]
    },
    {
      v:'1.2.0', date:'Apr 18, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Release bump: everything from 1.1.15 through 1.1.104 rolls into the 1.2.0 release milestone. Going forward: MINOR bump (1.2 \u2192 1.3) on every merge to main; PATCH counts commits on staging between releases; MAJOR reserved for rewrites. Documented in HANDOFF.md §3.'},
        {t:'add', d:'This release: Process Order overhaul (Deal Hub modal + quote builder parity), payment method tracking, Mobile overhaul (Deal Hub + quote builder + customer pages), Ship Calendar with pallet color coding, RM + Custom Holes production flags, Orders dashboard redesign, Reports rebuild Step 1 (hero KPIs + rep filter), retroactive changelog + version discipline, admin payment-method override.'},
      ]
    },
    {
      v:'1.1.104', date:'Apr 18, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Deal Hub detail panel quote rows now show RM / CUST chips per quote so you can tell which specific revision contains the flagged line items. Previously only the deal card (aggregate) showed them. /api/deals/:id/hub now returns hasRM + hasCustomHole on each quote.'},
      ]
    },
    {
      v:'1.1.103', date:'Apr 18, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Custom holes tracking: line items starting with "CUST HOLE " (CUST HOLE E or CUST HOLE S) now flag the order as Custom Holes — 1-month lead, Gary (production manager) notified.'},
        {t:'add', d:'On Process Order: server prepends "CUSTOM HOLES — " to production notes (idempotent, survives re-processing). Shipping email CCs gamos@whisperroom.com (same as RM) and includes "Gary, this order includes Custom Holes." line when detected. Both flags can apply together — prefix becomes "RM + CUSTOM HOLES — " and both Gary lines appear.'},
        {t:'ui',  d:'Amber "CUST" chip on Deal Hub board cards, orders dashboard table rows, and ship calendar cells. Distinct from the red "RM" chip so you can tell them apart at a glance; deals with both show both chips.'},
      ]
    },
    {
      v:'1.1.102', date:'Apr 18, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Deal Hub admin override: new Payment Method dropdown in the admin panel lets you change a deal\\u2019s payment type (HubSpot Invoice / Credit Card / ACH / PO / Other) or clear it. Non-PO choices save automatically on change; PO shows a PO Number input + Save PO button so the number can be entered first.'},
        {t:'add', d:'New endpoint PATCH /api/deals/:id/payment-type \u2014 maps lowercase client values to HubSpot\\u2019s uppercase enum, mirrors payment_status, logs admin override to the admin log, logs HubSpot failures to Railway.'},
        {t:'ui',  d:'Removed "(1-month lead time)" from the RM notice line in the shipping notification email \u2014 Gary already knows.'},
      ]
    },
    {
      v:'1.1.101', date:'Apr 18, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Deal Hub Process Order now opens the shipping notification email (was only happening from the quote builder\\u2019s orange Process Order button). Added openShippingNotifyEmail() helper to deals-dashboard.html that mirrors the quote-builder email format: to=shipping@, cc=accounting@+bentonwhite@ (+ gamos@ if RM), subject, full order body with line items, totals, ship-to, production notes, and order URL.'},
        {t:'ui',  d:'Light-mode Process Order modal: Cancel button and other secondary controls used rgba(255,255,255,.6) text which fell through my CSS override. Extended coverage to include .6/.65/.7/.75 alpha whites as --text, and invisible .08 white backgrounds now use --bg so the button has a visible surface against the cream modal.'},
      ]
    },
    {
      v:'1.1.100', date:'Apr 18, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Process Order mailto: switched from window.location.href / window.open to a programmatic anchor-click (create <a>, append, .click(), remove). This is the most reliable way to trigger native mailto handlers — browsers treat it as a user-initiated click instead of programmatic navigation, which bypasses popup blocker heuristics. Added console.log traces so the dispatch is visible in DevTools if it still doesn\\u2019t open.'},
        {t:'ui',  d:'Removed the manual "Send Shipping Email" button from the success box — the email must open automatically, not require a click.'},
        {t:'ui',  d:'Light-mode Process Order modal labels (Payment Method, Foam, Hinge, AP) now use --text instead of --muted for primary labels, darker --border lines, and adapted input backgrounds. Primary radio/selection labels were getting lost against the cream surface.'},
      ]
    },
    {
      v:'1.1.99', date:'Apr 18, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Process Order: HubSpot deal PATCH was failing with 400 because payment_type values were sent lowercase (hs/cc/ach/po/other) but HubSpot\\u2019s dropdown enum uses uppercase (HS, CC, ACH, PO, Other). Added a client\u2192HubSpot mapping at the server boundary and normalize incoming HubSpot values back to lowercase when we read them for the UI. Deals will now move to Closed Won correctly.'},
      ]
    },
    {
      v:'1.1.98', date:'Apr 18, 2026', tag:'fix',
      changes:[
        {t:'ui',  d:'Process Order modal now adapts to light/dark theme — was hard-coded dark regardless of theme. In light mode the modal bg, text, inputs, and AP color picker all render light; in dark mode they stay dark. Fixes unreadable AP color options in Opera/Chrome where native select chrome ignored forced dark styling.'},
        {t:'log', d:'Process Order deal PATCH failures now also log to Railway stdout (console.error) with status + HubSpot rejection body + sent props. No need to expand the admin log entry to diagnose.'},
      ]
    },
    {
      v:'1.1.97', date:'Apr 18, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Process Order AP color picker options are now dark-themed on Chrome/Opera: added inline color-scheme:dark to the select so the browser renders the native dropdown with dark OS chrome. Previous fix via body.dark CSS only applied when the user had explicitly toggled dark theme.'},
        {t:'fix', d:'Process Order mailto now tries window.open first (with window.location.href as fallback) — more reliable across browsers when a mailto handler is registered but popup-style triggers behave differently than navigation-style.'},
      ]
    },
    {
      v:'1.1.96', date:'Apr 18, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Process Order: if the full HubSpot deal PATCH (stage + ap_color + payment_type + po_) returns 400, we now automatically retry with just dealstage=closedwon so the deal at least moves. Both failures are logged (stage-patch + stage-patch-retry) with the full HubSpot response body and the props we sent — next time this happens we\\u2019ll have enough data to fix the actual bad property.'},
      ]
    },
    {
      v:'1.1.95', date:'Apr 18, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Process Order HubSpot deal-stage PATCH was silently swallowing HubSpot errors — if HubSpot returned 4xx/5xx, the deal stayed in its previous stage but the order still saved and the UI showed success. Now surfaces a non-2xx response as error.process-order.stage-patch in the admin log so the issue is visible.'},
        {t:'ui',  d:'Process Order success box now includes a manual "✉ Send Shipping Email" button alongside the order link. Auto-mailto (window.location.href = mailto:) can be blocked silently by the browser or OS, so the manual fallback guarantees the email can be opened.'},
        {t:'ui',  d:'Toast text changed from "Email draft opened!" to "Order processed" since we can\\u2019t actually guarantee the mail client opened.'},
      ]
    },
    {
      v:'1.1.94', date:'Apr 18, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Process Order AP color picker options are now readable — the dropdown options were using the browser default light gray (barely visible on dark theme). Applied dark-theme option styling globally so every select respects the theme.'},
      ]
    },
    {
      v:'1.1.93', date:'Apr 18, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Roof Mounted Ventilation (RM) tracking: any line item starting with "RM " now flags the order for Gary (production manager) — 1-month lead time.'},
        {t:'add', d:'On Process Order: server auto-prepends "RM — " to production notes; quote-builder mailto now cc\\u2019s gamos@whisperroom.com and includes "Gary, this order includes Roof Mounted Ventilation (1-month lead time)" in the email body.'},
        {t:'ui',  d:'Red "RM" chip on Deal Hub board cards, orders dashboard rows, and ship calendar cells so the flag is visible everywhere a deal surfaces.'},
        {t:'ui',  d:'Ship calendar now shows "Parts" instead of "?" for orders with 0 pallets and no MDL items (parts-only orders). "?" still appears for unknown/missing pallet data.'},
      ]
    },
    {
      v:'1.1.92', date:'Apr 18, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Ship calendar cells now wrap long deal names instead of truncating with ellipsis. Day cells grow vertically to fit the content.'},
        {t:'ui', d:'Strips noise suffixes from calendar labels ("– New Deal", "— Quote", "— Revision", "— Updated Quote") so the meaningful part of the deal name shows through. Full original name still appears on hover.'},
      ]
    },
    {
      v:'1.1.91', date:'Apr 18, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Ship calendar cells now show the deal name as the primary label, with the MDL in muted type next to it (was: MDL only)'},
      ]
    },
    {
      v:'1.1.90', date:'Apr 18, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Orders dashboard: monthly ship calendar below the orders list — renders each order on its planned/actual ship date with click-through to the detail drawer'},
        {t:'add', d:'Pallet cap color coding per day cell: green ≤3, yellow 4-5, red 6+ (soft indicator — does not prevent adding more)'},
        {t:'add', d:'Pallet count auto-computed from line items when processing an order — saved to order_data.shipped.pallets. Jeromy can edit afterward in the drawer.'},
        {t:'ui',  d:'Orders table now caps at ~10 rows with an internal scroll + sticky header instead of a long page scroll'},
        {t:'ui',  d:'Day cells show total pallet count badge and list each shipment\\u2019s pallet qty + MDL'},
        {t:'ui',  d:'Calendar month nav (Prev / Today / Next), Today cell highlighted in orange, outside-month days dimmed'},
      ]
    },
    {
      v:'1.1.89', date:'Apr 18, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'"E" now labeled "Enhanced" (not "Electric") in the Standard vs Enhanced split'},
        {t:'fix', d:'Top Customers by Value no longer double-counts quote revisions — was summing every revision as its own deal (e.g. AMP showing $528k for a $173k deal with 3 revisions). Now uses max total per unique deal_id.'},
        {t:'ui',  d:'Replaced broken hand-drawn US sales map with an expanded "Top States" bar chart showing count + % share — accurate, readable, and mobile-friendly'},
      ]
    },
    {
      v:'1.1.88', date:'Apr 18, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Reports rebuild Step 1: new "At a glance" hero row with 4 decision-oriented KPIs — Revenue MTD (vs last month), Pipeline Value, Win Rate (vs 90d avg), Avg Deal Size (vs 90d avg)'},
        {t:'add', d:'Rep filter dropdown in the reports sidebar — all KPIs recompute scoped to the selected rep'},
        {t:'ui',  d:'Mobile-responsive reports: sidebar collapses to a horizontal chip row, KPI strip switches to 2-column on tablet and 1-column on narrow'},
        {t:'ui',  d:'Topbar scrolls horizontally on narrow screens to match Deal Hub pattern'},
      ]
    },
    {
      v:'1.1.87', date:'Apr 18, 2026', tag:'feature',
      changes:[
        {t:'add', d:'HANDOFF.md now documents the version-bump + changelog discipline — every push bumps package.json patch version and adds a templates/changelog.js entry'},
      ]
    },
    {
      v:'1.1.86', date:'Apr 18, 2026', tag:'ui',
      changes:[
        {t:'ui',  d:'Mobile overhaul of Deal Hub — hub panel slides in as overlay on narrow screens, topbar scrolls horizontally instead of clipping Sign Out'},
        {t:'ui',  d:'Collapsible Kanban columns on Fold-cover / ≤480px — tap a column header to expand/collapse'},
        {t:'ui',  d:'Column totals now displayed under each stage header (Sent, Verbal, Won, Shipped) — color-matched to the stage'},
        {t:'ui',  d:'Quote builder topbar: fixed nav-button pile-up at tablet widths by switching to horizontal scroll ≤1024px'},
        {t:'ui',  d:'Customer order page /o/:id: table collapses to name/qty/total on mobile (was overflowing with 5 columns)'},
        {t:'add', d:'Retroactive changelog reconstruction from v1.1.15 to v1.1.86'},
      ]
    },
    {
      v:'1.1.85', date:'Apr 17, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Restore orderModal HTML to DOM — the div only existed inside a PDF template string, so document.getElementById returned null and the orange Process Order button did nothing'},
        {t:'fix', d:'Open order modal before awaiting HubSpot payment-type prefill so a slow fetch never blocks the modal from appearing'},
        {t:'fix', d:'Wrap renderOrderSummaryQB() in try/catch so a rendering error cannot block the modal from opening'},
        {t:'fix', d:'Silence Puppeteer "old Headless" deprecation warning in UPS tracking scraper (headless: true → headless: "new")'},
      ]
    },
    {
      v:'1.1.84', date:'Apr 17, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Orange Process Order button in quote builder now opens the same modal used on the Deal Hub — collects payment type, PO number, order summary, and production notes'},
        {t:'add', d:'Quote label surfaced on Deal Hub cards and quote rows — takes precedence over MDL model string when set'},
      ]
    },
    {
      v:'1.1.83', date:'Apr 17, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Deal Hub cards and column headers restyled — cleaner spacing, tighter type scale, clearer stage colors'},
      ]
    },
    {
      v:'1.1.82', date:'Apr 17, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Process Order modal now shows a live order summary — line items, discount, freight, tax, total, and ship-to address'},
      ]
    },
    {
      v:'1.1.81', date:'Apr 17, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Switched all internal dashboards to Satoshi font family for a more consistent brand feel'},
      ]
    },
    {
      v:'1.1.80', date:'Apr 17, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Process Order modal launched from the Deal Hub — previously the blue "Process" button redirected into the quote builder'},
        {t:'add', d:'Payment method tracking via HubSpot custom properties payment_type (HS / CC / ACH / PO / Other) and po_ (PO number)'},
        {t:'add', d:'Payment badges on Deal Hub cards now reflect specific payment method instead of generic paid/PO tag'},
        {t:'add', d:'Notes & Order Specs carry over to Production Notes automatically when processing an order'},
      ]
    },
    {
      v:'1.1.78', date:'Apr 17, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Replaced text logo with WhisperRoom SVG logo across all pages (topbar, PDFs, customer-facing quote/invoice/order pages)'},
      ]
    },
    {
      v:'1.1.77', date:'Apr 17, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Locked deal payment amount is now additive — paying a second invoice adds to amount_paid instead of replacing it'},
      ]
    },
    {
      v:'1.1.75', date:'Apr 17, 2026', tag:'security',
      changes:[
        {t:'security', d:'Closed Won / Shipped deals locked against quote sync overwrites — prevents a late quote revision from rewriting a finalized deal'},
      ]
    },
    {
      v:'1.1.72', date:'Apr 17, 2026', tag:'feature',
      changes:[
        {t:'add', d:'HANDOFF.md onboarding doc — full project context, workflow, env vars, gotchas for new collaborators'},
      ]
    },
    {
      v:'1.1.70', date:'Apr 17, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'gdriveSavePdfToDeal: fall back to a sibling quote folder on the same deal when the current quote lacks gdrive_folder_id (covers legacy quotes)'},
        {t:'log', d:'Surface the real error on order PDF upload instead of generic failure message'},
        {t:'fix', d:'GDRIVE_ORDERS_FOLDER env var now overrides hardcoded orders folder ID'},
      ]
    },
    {
      v:'1.1.65', date:'Apr 17, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Phase 2 refactor: extracted inline HTML dashboards (deals, quotes, orders, shipping, reports, admin-log) from quote-server.js into separate .html files'},
      ]
    },
    {
      v:'1.1.60', date:'Apr 17, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Phase 1 refactor: extracted states, utils, logger, auth, db, hubspot, gdrive, pdf, taxjar, notify, and freight helpers from monolithic quote-server.js into lib/*.js modules'},
        {t:'ui', d:'Each lib module exports init({ deps }) — dependencies wired once at server startup'},
      ]
    },
    {
      v:'1.1.55', date:'Apr 17, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Quote number collision handler no longer produces 11-digit numbers when the daily sequence rolls over'},
      ]
    },
    {
      v:'1.1.50', date:'Apr 17, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Skip US-only state enums up front for Canadian provinces instead of retrying on HubSpot rejection'},
        {t:'fix', d:'Invoice address PATCH now includes hs_collect_address_types: "billing_address" — resolves HubSpot 400 conflict errors'},
      ]
    },
    {
      v:'1.1.45', date:'Apr 17, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Folder picker always prompts on new deals, even when the contact already has a prior Drive folder — each deal now gets its own folder'},
        {t:'log', d:'Invoice address PATCH errors now log the full request body for diagnosis'},
      ]
    },
    {
      v:'1.1.40', date:'Apr 17, 2026', tag:'feature',
      changes:[
        {t:'add', d:'PUBLIC_BASE_URL env var for building customer-facing links — staging and prod now point to their own domains'},
        {t:'fix', d:'Client-side links use location.origin instead of hardcoded sales.whisperroom.com'},
        {t:'fix', d:'PDF cookie domain derived from request host instead of hardcoded'},
      ]
    },
    {
      v:'1.1.35', date:'Apr 17, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Quote number timezone bug — quote numbers now generate with correct local date (America/New_York) instead of UTC'},
        {t:'fix', d:'Allow staging Railway URL in OAuth redirect allowlist'},
      ]
    },
    {
      v:'1.1.30', date:'Apr 16, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Catch-up: multiple iterations on Deal Hub — card layout, pipeline stages, filter toggles, deal search refinements'},
      ]
    },
    {
      v:'1.1.25', date:'Apr 16, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Catch-up: continued quote-server refinements — HubSpot deal matching, contact search, owner assignment edge cases'},
      ]
    },
    {
      v:'1.1.20', date:'Apr 15, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Catch-up: tracking and shipping polish — column headers, status badges, tracking link fallbacks'},
      ]
    },
    {
      v:'1.1.15', date:'Apr 15, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Catch-up: quote builder and orders dashboard iterations — freight display, invoice flow tweaks, small UI fixes'},
      ]
    },
    {
      v:'1.1.14', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Canadian freight now uses correct NMFC codes (027880/02) matching legacy system'},
        {t:'fix', d:'Postal code spaces stripped automatically — "M4W 1B7" and "M4W1B7" both work'},
        {t:'fix', d:'Zip space stripping applied at server, freight request, and customer record save'},
      ]
    },
    {
      v:'1.1.13', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Ship It button now saves serial number, production notes, foam color, and hinge preference — same as Save Changes'},
      ]
    },
    {
      v:'1.1.12', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Ship date showing one day early — YYYY-MM-DD strings parsed as UTC midnight, now treated as local noon'},
      ]
    },
    {
      v:'1.1.11', date:'Apr 13, 2026', tag:'log',
      changes:[
        {t:'log', d:'Full shipping error coverage: error.refresh-tracking, error.track, error.ship-deal, error.ship-hubspot-deal, error.shipping-board, error.order-ship, error.tracking-poller'},
        {t:'log', d:'All error log entries now include rep via getRepFromReq()'},
      ]
    },
    {
      v:'1.1.10', date:'Apr 13, 2026', tag:'log',
      changes:[
        {t:'log', d:'Rep name now shows on ALL error log entries — getRepFromReq() helper added'},
        {t:'log', d:'Tax errors include rep from request body'},
      ]
    },
    {
      v:'1.1.09', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'TaxJar errors now log to system log with state/zip/city'},
        {t:'fix', d:'Tax route body hoisted out of try block — prevents body is not defined crash'},
        {t:'ui',  d:'Tax errors show plain English: invalid ZIP/city/state/timeout messages'},
      ]
    },
    {
      v:'1.1.08', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'TaxJar errors now logged to system log (error.tax event)'},
        {t:'ui',  d:'Tax error messages translated to plain English for reps'},
      ]
    },
    {
      v:'1.1.07', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'httpsGet 15-second timeout — freight no longer hangs for 5+ minutes'},
        {t:'fix', d:'parseAbfXml reads ABF ERROR tags and returns actionable messages'},
        {t:'fix', d:'Freight body scope fix — body is not defined crash resolved'},
        {t:'ui',  d:'Invalid ZIP/city/state/weight shown as plain English to reps'},
      ]
    },
    {
      v:'1.1.06', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Freight route body hoisted — prevented unhandledRejection crash'},
        {t:'log', d:'Freight errors now correctly log with dest zip/state/city'},
      ]
    },
    {
      v:'1.1.05', date:'Apr 13, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Rename Deal button in deal panel — updates HubSpot, Google Drive folder, and all DB quotes'},
        {t:'log', d:'deal.renamed logged to activity feed on success'},
      ]
    },
    {
      v:'1.1.04', date:'Apr 13, 2026', tag:'log',
      changes:[
        {t:'log', d:'Full error logging on all critical routes: accept-quote, create-invoice, process-order, abf-booking, order-save, unship, orders-list, hubspot'},
        {t:'add', d:'Gabe Troubleshooting Handbook added to handoff doc'},
      ]
    },
    {
      v:'1.1.03', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Duplicate quote.pushed log removed — was firing from both /api/history and /api/create-deal'},
      ]
    },
    {
      v:'1.1.02', date:'Apr 13, 2026', tag:'log',
      changes:[
        {t:'log', d:'Freight error logging added to quote builder, orders-freight, and ABF inner catch'},
      ]
    },
    {
      v:'1.1.01', date:'Apr 13, 2026', tag:'ui',
      changes:[
        {t:'ui',  d:'Admin log rebuilt — favicon, live dot, rep/event dropdowns, date range filter, stats bar, version badge, clear button'},
      ]
    },
    {
      v:'1.1.00', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'quote.pushed log correctly labels New deal vs Revision — meta includes isNewDeal and existingDealId'},
      ]
    },
    {
      v:'1.0.96', date:'Apr 13, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Logging system launched — logs table in PostgreSQL, writelog() helper, admin log page at /admin-log'},
        {t:'log', d:'Events: quote.pushed, deal.created, invoice.created, order.shipped, order.unshipped, order.deleted, order.processed, task.accounting'},
        {t:'log', d:'Errors: error.freight, error.tax, error.hubspot, error.save'},
      ]
    },
    {
      v:'1.0.95', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Accounting task on Ship It fires for ALL reps, not just Jeromy — assigned to Kim Dalton'},
        {t:'fix', d:'Task includes deal name, serial number, carrier, PRO/tracking, freight cost'},
      ]
    },
    {
      v:'1.0.94', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Unship preserves all shipment data — only reverts HubSpot dealstage to Closed Won'},
        {t:'fix', d:'Delete button now visible to all reps'},
        {t:'fix', d:'HS-only orders: Ship It creates DB record so order persists on board'},
      ]
    },
    {
      v:'1.0.93', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Serial number field changed to textarea for multi-line support'},
        {t:'fix', d:'HS-only orders (HS-{dealId}) save directly to HubSpot via PATCH'},
      ]
    },
    {
      v:'1.0.92', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Credits line items created BEFORE the HubSpot loop — were never being sent'},
        {t:'fix', d:'Credit descriptor line: "Credit applied in MDL XXXX above: -$XX.XX"'},
        {t:'fix', d:'anchor variable hoisted to outer scope — fixed ReferenceError on credit push'},
      ]
    },
    {
      v:'1.0.91', date:'Apr 13, 2026', tag:'feature',
      changes:[
        {t:'add', d:'OD Freight rating added alongside ABF — LTL, GTD, GTE via SOAP XML'},
        {t:'add', d:'OD Book URL pre-fills dest zip on odfl.com'},
        {t:'fix', d:'httpsGet timeout 15 seconds, parseAbfXml reads ERROR tags'},
      ]
    },
    {
      v:'1.0.90', date:'Apr 13, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Freight rating modal on orders board — Get Freight button fetches ABF rate per order'},
        {t:'add', d:'Orders board drag-and-drop sort with position persistence'},
      ]
    },
    {
      v:'1.0.89', date:'Apr 9, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Quote notes displayed on /q/ and /i/ client pages in orange-bordered box'},
        {t:'fix', d:'Canadian province state handling — retry without state fields if HubSpot rejects'},
      ]
    },
    {
      v:'1.0.88', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Orders dashboard — In Production / Shipped / All Orders / HubSpot Closed Won tabs'},
        {t:'add', d:'Orders drawer with foam color, hinge, serial number, production notes, delivery notes'},
        {t:'add', d:'Ship It button with carrier/tracking/date/pallets/boxes/hardware box fields'},
        {t:'add', d:'HubSpot deal stage advances to Shipped (845719) on Ship It'},
      ]
    },
    {
      v:'1.0.87', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Notifications system — bell icon in Deal Hub, fires on quote accept and payment marked'},
        {t:'add', d:'HubSpot workflow: task on accept → emails rep via internal email notification'},
      ]
    },
    {
      v:'1.0.86', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Merge Deal feature — move all quotes/orders to correct deal, delete wrong deal, merge Drive folders'},
        {t:'add', d:'Merge Legacy folder — import old AllContacts Drive folders into deal structure'},
      ]
    },
    {
      v:'1.0.85', date:'Apr 9, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Deal hub panel load parallelized with Promise.all — 5 independent HubSpot calls fire simultaneously'},
        {t:'fix', d:'Hub panel load time reduced from 5-7s to near-instant'},
      ]
    },
    {
      v:'1.0.84', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Activity Timeline in deal panel — full HubSpot engagement history per deal'},
        {t:'add', d:'Invoice panel in deal hub showing status, payment method, amounts'},
        {t:'add', d:'Orders panel in deal hub showing production/shipped status'},
      ]
    },
    {
      v:'1.0.83', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Create Invoice button per quote in deal hub — creates HubSpot invoice from quote snapshot'},
        {t:'add', d:'Invoice linked to deal and contact in HubSpot'},
        {t:'add', d:'Payment link fetched and stored in DB after invoice creation'},
      ]
    },
    {
      v:'1.0.82', date:'Apr 9, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Deal delete — removes HubSpot deal and all DB quote records'},
        {t:'fix', d:'Stage override in admin panel — single click moves deal to any stage'},
        {t:'fix', d:'Payment status picker — Not Paid / PO Received / Paid with color coding'},
      ]
    },
    {
      v:'1.0.81', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Deal Hub kanban board — Sent/Updated, Verbal, Closed Won, Shipped columns'},
        {t:'add', d:'Right-side hub panel with quotes, pipeline stepper, next action, admin overrides'},
        {t:'add', d:'Auto-filters to logged-in rep deals on load'},
        {t:'add', d:'HubSpot-only deal toggle to hide/show unintegrated deals'},
      ]
    },
    {
      v:'1.0.80', date:'Apr 9, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Share token stored in DB column only — stripped from json_snapshot before save'},
        {t:'fix', d:'getShareToken() prefers _loadedShareToken over _lastShareToken'},
        {t:'fix', d:'Both tokens synced on push, cleared on new quote, server fallback fetch if missing'},
      ]
    },
    {
      v:'1.0.79', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Shareable quote links (/q/:quoteNumber) with token validation'},
        {t:'add', d:'Customer-facing quote accept flow — foam color, hinge, notes captured on accept'},
        {t:'add', d:'Shareable invoice links (/i/:quoteNumber)'},
        {t:'add', d:'Customer-facing order status pages (/o/:quoteNumber)'},
      ]
    },
    {
      v:'1.0.78', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'PDF download for quotes, invoices, orders via Puppeteer'},
        {t:'add', d:'PDF semaphore — only one PDF generates at a time to stay within Railway memory limits'},
        {t:'add', d:'Google Drive auto-upload: quotes to Quotes/, invoices to Invoices/'},
      ]
    },
    {
      v:'1.0.77', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Google Drive integration — service account JWT auth, deal folder creation with subfolders'},
        {t:'add', d:'Subfolders: Quotes, Invoices, Purchase Orders, Drawings & Specs, Shipping, Final Order'},
        {t:'add', d:'Drive folder ID saved to DB, linked to quote record'},
      ]
    },
    {
      v:'1.0.76', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Process Order flow — moves deal to Closed Won, creates order record, sends confirmation email'},
        {t:'add', d:'Foam/hinge no longer required to process order'},
        {t:'add', d:'Changelog uses OAuth session name (window._sessionRepName)'},
      ]
    },
    {
      v:'1.0.75', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'TaxJar sales tax integration — nexus states, freight taxability per state'},
        {t:'add', d:'Tax exempt checkbox per quote'},
        {t:'add', d:'Tax included in HubSpot deal amount and order total'},
      ]
    },
    {
      v:'1.0.74', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'ABF freight rate integration — pallets, weight, accessories (residential, liftgate, limited access)'},
        {t:'add', d:'Freight accessorial preferences saved per customer email'},
        {t:'add', d:'BOOTH_DATA for pallet dims, freight weight = sum of all line item weights'},
      ]
    },
    {
      v:'1.0.73', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'OD tracking via direct REST API (api.odfl.com) — replaces AfterShip for OD shipments'},
        {t:'add', d:'ABF tracking via XML API (abfs.com) — replaces AfterShip for ABF shipments'},
        {t:'add', d:'UPS/FedEx/USPS tracking via Puppeteer scrape'},
        {t:'add', d:'Shipping board — 90-day window of shipped deals with live tracking status'},
      ]
    },
    {
      v:'1.0.59', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Credits tab in price book — 35 credit items from WR_CREDITS list, red CR badge styling'},
        {t:'add', d:'Negative price inputs supported — custom items can have negative prices'},
        {t:'fix', d:'Credits excluded from HubSpot line items — sum applied as hs_discount on invoice'},
      ]
    },
    {
      v:'1.0.58', date:'Apr 9, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'ABF delivered status false positives — now requires DELIVERYDATE in XML, not just status text match'},
        {t:'add', d:'"Arrived at Terminal" label added for shipments at local service center'},
      ]
    },
    {
      v:'1.0.57', date:'Apr 9, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'AfterShip fully removed — all tracking now uses direct carrier APIs'},
        {t:'fix', d:'Hub panel parallelized with Promise.all — 5 HubSpot calls fire simultaneously'},
        {t:'add', d:'fetchAndCacheTracking() seeds cache immediately on Ship It instead of AfterShip'},
      ]
    },
    {
      v:'1.0.56', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'fetchABFTracking() — ABF XML trace API, parses status/dates/signature/destination'},
        {t:'add', d:'fetchABFTransitDays() — ABF transit time API for ETA backfill on shipping board'},
        {t:'add', d:'fetchAndCacheTracking() rewritten — OD REST API, ABF direct XML, UPS/FedEx/USPS Puppeteer'},
        {t:'add', d:'/api/debug/od-tracking — raw OD API debug endpoint'},
        {t:'fix', d:'initTrackingCache — clears bogus same-day delivered_at entries'},
      ]
    },
    {
      v:'1.0.55', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Initial import — full system on Railway: Node.js server, PostgreSQL, HubSpot OAuth'},
        {t:'add', d:'Quote builder with product search, line items, customer fields, HubSpot push'},
        {t:'add', d:'Quote history in DB, contact/deal search, quote numbering by rep'},
        {t:'add', d:'HubSpot 30-day OAuth sessions, DB-backed, products cached with 15min TTL'},
      ]
    },
    ].map(v => `
    <div class="version-block">
      <div class="version-header">
        <div class="version-num">v${v.v}</div>
        <div class="version-date">${v.date}</div>
        <div class="version-tag tag-${v.tag}">${v.tag}</div>
      </div>
      <div class="version-body">
        ${v.changes.map(c => `
          <div class="change-item">
            <span class="change-type ct-${c.t === 'log' ? 'log' : c.t === 'add' ? 'add' : c.t === 'ui' ? 'ui' : c.t === 'security' ? 'security' : 'fix'}">${c.t === 'log' ? 'log' : c.t === 'add' ? 'new' : c.t === 'ui' ? 'ui' : c.t === 'security' ? 'sec' : 'fix'}</span>
            <span>${c.d}</span>
          </div>`).join('')}
      </div>
    </div>`).join('')}
</div>
</body>
</html>`;
};
