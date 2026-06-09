# "Build Your Own Booth" — Configurator Plan

> Drafted 2026-06-09 from a full crawl of whisperroom.com + shop.whisperroom.com + the 2026 catalog PDF (Vol 36), a survey of competitor configurators, and the current state of this repo (v1.84.31: Top-Down Layout with drag-to-rearrange, all 26 sizes digitized, WA-Type-aware PL). Owner: Benton.

---

## 1. The opportunity (what the research says)

**Nobody in this market has a self-serve configurator.** StudioBricks, VocalBooth.com, Demvox, Gretch-Ken — all run consultative flows where a human produces renders/quotes after a form or phone call. StudioBricks' famous "design your booth" is actually a brief → their team mails you 3D sketches. Meanwhile WhisperRoom *already publishes* everything a configurator needs (interchangeable 46″ panel system, per-model top-down diagrams, door-swing/vent/clearance rules) — but only as static spec-sheet PDFs.

**The proven pattern from adjacent industries** (Tuff Shed, Studio Shed): step wizard → visual model that updates per selection → price-as-you-build → **save your design = captured lead with full intent data attached**. Studio Shed's "size → door and window placement → colors" flow on a panelized kit-of-parts is structurally identical to WhisperRoom's product.

**Why this fits *us* specifically:**
- The sales pain is real: panel placement (door wall, hinge side, vent wall, window walls) is decided today in email threads and calls, then hand-translated into the internal **WA Type** codes (`4646 / 4622 / 4040 / 4016` — which wall pair the wide door displaces). Errors and back-and-forth live exactly there.
- The hard parts already exist in this repo:
  - `lib/pl-data/booth-layouts.json` — all 26 sizes, keyed by shell with per-variant (S/E) wall thickness + interior dims (127-LP pentagon pending).
  - A product-accurate top-down SVG renderer (source of truth `bot/specsheet-work/layout-render.js`, spliced into `packing-list.html`) with **drag-to-rearrange + size-compatibility constraint already working**.
  - `repWaType` on quotes, `adaWaType` through orders; the PL generator is fully WA-Type-aware.
  - Hinge (L/R) + foam color (Gray/Orange/Blue/Purple/Burgundy — exactly the 5 the shop sells) already normalized on the quote snap.
  - Customer-facing share-token quote pages, admin notifications, activity log.

So "Build Your Own Booth" is mostly **recombination + persistence + a customer skin**, not greenfield.

## 2. Product vision

A **"Design Your Booth" subtab on the customer-facing quote page**. The customer sees *their* booth (the model on their quote), arranges it, and saves:

- **Top-down view** — the existing interactive layout (drag a panel onto another wall; invalid drops already refused by the size constraint). Add door hinge L/R toggle.
- **Elevation view** (front/side) with **rotate** (▲ N/E/S/W, 90° steps): flat SVG elevations from the same config — door + door window, wall windows, vent ducts, height extension, caster height. Foam color visible through the glass.
- **Foam color picker** (the 5 shop colors; writes the same normalized value the PL already consumes).
- **Save** → persists to the quote, notifies the rep, and the rep's view shows the customer's arrangement → **WA Type / hinge / window walls are derived from it** instead of from prose.

Explicitly out of scope for v1: configurator-driven re-pricing (the quote prices options; the configurator *arranges* them), WebGL/3D, and the public marketing-site version (§8).

## 3. Why 2D SVG and not 3D

The competitor research is clear: a 2D top-down panel picker captures most of the value at a fraction of the cost, and WhisperRoom's own spec sheets already train customers to read top-downs. We get "3D feel" cheaply: top-down + 4 rotatable elevations + existing photography. Benton's SketchUp renders become (a) reference for drawing accurate SVG elevations and (b) optional hero imagery — not a runtime 3D dependency.

## 4. Data model

One JSON blob per room, stored on the quote snap (**no schema migration**):

```js
boothConfig: {
  version: 1,
  mdl: 'MDL 4872 S',
  assign: { N0: 'VNT', N1: 'SOLID', S0: 'DRFRM', S1: 'SOLID', E0: 'WDO3236', W0: 'CBL' },
  hinge: 'R',                    // L | R
  foamColor: 'Gray',             // Gray | Orange | Blue | Purple | Burgundy
  facing: 'S',                   // elevation last viewed
  savedBy: 'customer',           // customer | rep
  savedAt: '2026-06-09T…',
  customerNote: 'door must face the office window'
}
```

- Slot ids are `booth-layouts.json` ids — configurator and PL share one source of truth.
- Today `LAYOUT_STATE` (the drag state in the PL viewer) **resets on every render and is never persisted**. Persistence = serialize `assign` by slot→kind (+pack where it matters), save, and seed `LAYOUT_STATE` from `boothConfig` when present; greedy `placeBom()` stays as fallback + validator (every assigned panel must exist in the BOM pool).
- **WA Type derivation**: door slot + which adjacent wall is narrow + wall module (46/40) → `4646/4622/4040/4016` directly. Rep panel shows: "Door: FRONT-left, hinge R, narrow on the door side → WA Type 4622" with one-click apply to `repWaType`.

## 5. Constraint rules (the validity engine)

The drag size-constraint exists; layer the rest on as data:

| Rule | Source |
|---|---|
| Exactly one door (or one WAD); VNT panel count fixed per model (1–4) | spec sheets / BOM |
| Cable-passage count fixed per model (2–8) | spec sheets |
| Window width by panel series: 26″ on 42/60/84/102-series, 32″ on 48/72/96-series; heights 30/36/42/48″ | catalog + blog |
| WAD only on booths with ≥5′ walls; initial-order only | catalog |
| Door swing 30″, opens outward → show sweep + clearance hint | spec sheets |
| Vent wall protrudes 5.5″; 6″ host-room clearance | spec sheets |
| Narrow slots: solid only (46″-family components can't shrink) | booth-layouts.json |
| Initial-order-only options flagged once ordered: WAD, wall windows, 10″ HX, ADA | catalog |

Phase-3 nicety: "will it fit my room?" — host-room W×L×H in, booth + 6″ clearance + door sweep drawn inside it, collisions flagged. (Lead-gen gold; trivial on the same SVG.)

## 6. Build phases

**Phase A — persist + constrain + WA Type, rep-side. (~2–3 sessions)**
1. `boothConfig` persistence (save/load on the quote snap; PL seeds from it).
2. Constraint engine v1 (door/vent/window counts, narrow-slot rules) on top of the existing size check.
3. Hinge toggle + foam swatch in the layout tab (writes the existing quote fields).
4. WA Type suggestion panel + one-click apply to `repWaType`.
5. Extract the renderer into a shared `assets/booth-layout.js` consumed by PL + quote-builder + (next phase) the shared quote page — fold the `splice.js` pipeline into it.

**Phase B — customer-facing subtab on the shared quote. (~1 week)**
1. "🏗 Design Your Booth" tab on the share-token quote page, customer mode (friendly labels — "Wall with Ventilation" — no pack codes; visual polish per the brand: Satoshi/DM Sans, #ee6216 accent, charcoal-on-light like the site).
2. `POST /api/shared-quote/<token>/booth-config` — rate-limited, server-side constraint validation, `savedBy:'customer'`, admin notification ("Customer arranged their booth on W-…"), activity log entry.
3. Rep sees the customer layout with a diff vs. their own; accept = copy to canonical config + apply WA Type.

**Phase C — elevations + rotate + foam color. (~1–2 weeks; needs Benton's SketchUp refs)**
1. Flat SVG elevation per wall (door + window sizes, vent boxes + RFU, HX, caster). Same one-carpet visual language as the top-down.
2. Rotate N/E/S/W; foam color tints interior through glass + a swatch strip.
3. Ships in both rep and customer modes.

**Phase D — document + order flow.**
1. Configured top-down (+ front elevation) rendered into the quote PDF — customers approve a document showing *their* layout.
2. Order processing locks the config; WA Type / hinge / window walls flow to the order form + CP inputs.

## 7. UX sketch (customer mode)

```
┌─ Quote W-2026060912 ────────────────────────────────┐
│ [Summary] [Pricing] [🏗 Design Your Booth] [Files]  │
│                                                     │
│   MDL 4872 S — arrange your booth                   │
│   ┌───────────────┐   ┌──────────────────────┐      │
│   │   TOP-DOWN    │   │  FRONT VIEW  ◀ ▶     │      │
│   │ (drag a wall) │   │  (rotate)            │      │
│   └───────────────┘   └──────────────────────┘      │
│   Door hinge:  ( L | R● )                           │
│   Foam color:  ●Gray ○Orange ○Blue ○Purple ○Burg.   │
│   Note to us:  [door must face the window____]      │
│                          [ Save my layout ]         │
└─────────────────────────────────────────────────────┘
```

Invalid drops keep the current red-dash refusal, plus a one-line reason ("Windows this size fit 48-series walls only").

## 8. Later / bigger bets (not now)

- **Public configurator on whisperroom.com** feeding the HubSpot quote flow (portal 5764220) — same engine, embedded pre-quote; turns "Get final pricing" into design-first lead capture. Category-first per the competitive research, but a marketing-org decision (Webflow site coordination).
- **Price-as-you-build** (Tuff Shed's highest-leverage conversion feature) — needs reconciliation with rep-owned quote pricing first.
- Host-room fit checker as a standalone marketing tool / quiz step (quiz.whisperroom.com already funnels "help me choose").

## 9. Open questions for Benton

1. Customer freedom: can customers move **vent/cable** walls too, or only door/window (vent fixed to back)? Spec sheets say all 46″ components are interchangeable; production reality may differ.
2. Lock customer edits after order processing (config frozen at PO time)?
3. SketchUp exports: one render per wall type per series (door/vent/window/solid × 40″/46″) would cover all elevations — feasible to produce?
4. 127-LP pentagon: skip in the configurator (2 corner booths) or add its special-case layout first?
5. Are there panel arrangements production would refuse (e.g., door directly adjacent to vent wall) that aren't captured in any published rule?
