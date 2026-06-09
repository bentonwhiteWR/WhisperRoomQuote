# Spec-sheet → top-down layout digitization harness

Tools used to digitize the 26 booth top-down layouts (`lib/pl-data/booth-layouts.json`)
from the MDL spec sheets and to build/preview the renderer in `packing-list.html`.

Source PDFs: `C:\Users\bento\Documents\Claude\WR PO System\SpecSheets\MDL-<size>-<S|E>.pdf`
(52 sheets; page 3 of each is the "Top-Down Layout & Modular Panel Configuration" view).

- **render.py** — render a spec-sheet PDF page to PNG (`pypdfium2`). `python render.py <pdf> <outdir> <dpi> [startPage endPage]`.
- **gen-layouts.js** — the digitized geometry (per-size panel layout, extracted from the spec sheets) → regenerates `lib/pl-data/booth-layouts.json` (v2 schema). Edit the `RAW` table here to fix a layout, then `node gen-layouts.js`.
- **layout-render.js** — standalone copy of the SVG renderer (`renderLayoutSvg` + `placeBom` + helpers). Source of truth; spliced into `packing-list.html` by `splice.js`. Edit here, preview, then re-splice.
- **preview.js** — render a set of booths to `preview.html` (synthesizes a BOM per layout) for headless-Chrome screenshotting.
- **mktest.js** — build `test.html`: the REAL page script driven with mock DATA + an error trap + a programmatic drag-swap, to integration-test the page in a browser.
- **splice.js** — replace the renderer block in `packing-list.html` with the verified functions from `layout-render.js`.

Preview/screenshot (headless Chrome):
```
node preview.js "MDL 9696 S" "MDL 4872 E"
chrome --headless=new --screenshot=preview.png --window-size=900,1500 file:///<abs>/preview.html
```

Generated artifacts (PNGs, test.html, preview.html, render dirs) are git-ignored.

**Not yet supported:** MDL 127-LP (a pentagon/corner booth — the rectangular N/S/E/W schema can't represent it).
