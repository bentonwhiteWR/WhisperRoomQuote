// Assembly Manual builder.
//
// Replaces the legacy Excel/VBA workflow that lived in the packing-list
// software. The VBA copied per-section PDFs from a Z: drive structure
// into a Merge folder, then asked Acrobat to merge them. This module does
// the same thing, but the source PDFs live in Google Drive (under the
// `Server` shared drive → `AssemblyManuals/`) and the merge happens in
// memory with pdf-lib. Output PDF is returned to the caller for streaming
// back to the rep's browser.
//
// Source folder layout (under env GDRIVE_ASSEMBLY_MANUALS_FOLDER):
//   CoverManuals/, WarrantyManuals/, OverseasManuals/, ADAManuals/,
//   HXManuals/, JackPanelManuals/, ASSORTED/, SeriesManuals/,
//   VentilationManuals/, RMManuals/, RampManuals/, StepManuals/,
//   SLManuals/, EFPManuals/, BassTrapManuals/
//
// Each section pulls one PDF from a specific folder by substring match
// in the filename (mirrors the VBA's `InStr(Filename, X) > 0` checks).
// Sections are gated by the rep's checkbox selections. The merged PDF
// is the section files concatenated in the alphabetical order of their
// `order` keys: A < B < C ... < I < I1 < J ... < SA < SB.

const ASSEMBLY_MANUALS_ROOT = process.env.GDRIVE_ASSEMBLY_MANUALS_FOLDER || '';

let _deps = {};
function init(deps) { _deps = deps || {}; }

// SECTION CONFIG. One row per section the manual could include. Editing
// this table is how new sections / folders / gates get added — no new
// code branches required.
//
//   order:  controls page sequence (string-sorted alphabetically)
//   folder: Drive folder name under the AssemblyManuals root
//   match:  substring to look for in the filename (string OR fn(ctx))
//   when:   gating function (opts, ctx) => bool; omitted = always include
//
// `ctx` is the derived context: { model, adaSize, size, isLP }.
// `opts` is the raw rep-supplied checkbox state.
//
// (Section E, the customer-specific Packing List, is supplied by the
// rep as an uploaded file in the endpoint payload — handled separately
// inside buildAssemblyManual, not via this table.)
const SECTIONS = [
  { order: 'A',  folder: 'CoverManuals',       match: ctx => ctx.model                                            },
  { order: 'B',  folder: 'WarrantyManuals',    match: 'Warranty'                                                  },
  { order: 'C',  folder: 'WarrantyManuals',    match: 'Inspect Components'                                        },
  { order: 'D',  folder: 'WarrantyManuals',    match: 'Caution'                                                   },
  { order: 'F',  folder: 'OverseasManuals',    match: 'OVERSEAS',           when: o => !!o.overseas               },
  { order: 'G',  folder: 'ADAManuals',         match: ctx => ctx.adaSize,   when: o => !!o.ada && !!o.adaSize     },
  { order: 'H',  folder: 'HXManuals',          match: 'Height',             when: o => !!o.hx                     },
  { order: 'I',  folder: 'JackPanelManuals',   match: 'Jack',               when: o => !!o.jackPanel              },
  { order: 'I1', folder: 'ASSORTED',           match: 'EXPANSION',          when: o => !!o.expansion              },
  { order: 'J',  folder: 'SeriesManuals',      match: ctx => ctx.model                                            },
  // Vent: K = base, L = upgrades. Both are non-LP unless model contains "LP".
  // If RM (roof mount) is checked we skip both K and L — section M takes over.
  { order: 'K',  folder: 'VentilationManuals', match: ctx => ctx.isLP ? 'LP Vent system'   : 'Ventilation System',   when: o => !o.rm },
  { order: 'L',  folder: 'VentilationManuals', match: ctx => ctx.isLP ? 'LP Vent Upgrades' : 'Ventilation Upgrades', when: o => !o.rm },
  { order: 'M',  folder: 'RMManuals',          match: ctx => ctx.size,      when: o => !!o.rm                     },
  { order: 'N',  folder: 'RampManuals',        match: 'ADA',                when: o => !!o.ramp                   },
  { order: 'O',  folder: 'StepManuals',        match: 'STEP',               when: o => !!o.step                   },
  { order: 'P',  folder: 'SLManuals',          match: 'Studio Light',       when: o => !!o.studioLight            },
  { order: 'Q',  folder: 'EFPManuals',         match: ctx => ctx.model,     when: o => !!o.efp                    },
  { order: 'R',  folder: 'Assorted',           match: 'APPackage',          when: o => !!o.ap                     },
  { order: 'SA', folder: 'JackPanelManuals',   match: 'MJP',                when: o => !!o.multiJackPanel         },
  { order: 'SB', folder: 'BassTrapManuals',    match: 'BASS',               when: o => !!o.bassTraps              },
];

// Folder ID cache. Folders don't move often; 1h TTL is fine and keeps
// production load on Drive minimal during a busy build session.
const _folderCache = new Map();
const FOLDER_CACHE_MS = 60 * 60 * 1000;

async function _resolveFolderId(name) {
  const cached = _folderCache.get(name);
  if (cached && (Date.now() - cached.fetchedAt) < FOLDER_CACHE_MS) return cached.id;
  if (!ASSEMBLY_MANUALS_ROOT) {
    throw new Error('GDRIVE_ASSEMBLY_MANUALS_FOLDER env var not set');
  }
  const folder = await _deps.gdrive.gdriveFindFolder(name, ASSEMBLY_MANUALS_ROOT);
  if (!folder?.id) {
    throw new Error(`Assembly Manuals subfolder "${name}" not found in Drive (parent=${ASSEMBLY_MANUALS_ROOT})`);
  }
  _folderCache.set(name, { id: folder.id, fetchedAt: Date.now() });
  return folder.id;
}

// Find the first PDF in `folderName` whose name contains `needle`.
// Case-sensitive substring (matches VBA's InStr). Multiple matches are
// allowed (we pick the first and log a warning) — the VBA's For Each
// loop overwrote silently when multiple files matched, which was a
// latent bug. We're explicit instead.
async function _findFileByMatch(folderName, needle) {
  const folderId = await _resolveFolderId(folderName);
  const files = await _deps.gdrive.gdriveListFilesInFolder(folderId);
  const matches = files.filter(f =>
    /\.pdf$/i.test(f.name) && f.name.includes(needle)
  );
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    console.warn(`[assembly-manual] ${matches.length} matches for "${needle}" in ${folderName}, using "${matches[0].name}". Others: ${matches.slice(1).map(m => m.name).join(', ')}`);
  }
  return matches[0];
}

// Pull "4848" out of "MDL 4848 S" / "MDL 4848 LP" / "MDL 6262 S Vocal".
// Used for the roof-mount section (M) which looks for the size digits
// in the RM PDF filenames.
function _extractSize(model) {
  const m = String(model || '').match(/MDL\s+(\d+)/i);
  return m ? m[1] : '';
}

// LP variants get a different ventilation PDF (LP Vent system / LP Vent Upgrades).
function _isLP(model) {
  return /\bLP\b/i.test(String(model || ''));
}

// Plan the manual without doing any Drive reads or PDF work. Useful for
// pre-flight (e.g., the modal that previews which sections will be
// included before the rep hits Build).
function planSections(opts = {}) {
  const ctx = {
    model:    String(opts.model || '').trim(),
    adaSize:  String(opts.adaSize || '').trim(),
    size:     _extractSize(opts.model),
    isLP:     _isLP(opts.model),
  };
  const plan = [];
  for (const s of SECTIONS) {
    if (s.when && !s.when(opts, ctx)) continue;
    const needle = typeof s.match === 'function' ? s.match(ctx) : s.match;
    if (!needle) continue;
    plan.push({ order: s.order, folder: s.folder, needle });
  }
  if (opts.includePackingList) {
    plan.push({ order: 'E', folder: '(user upload)', needle: 'PackingList' });
  }
  plan.sort((a, b) => a.order.localeCompare(b.order));
  return { ctx, plan };
}

// Build the merged PDF.
//   opts.model:                  'MDL 4848 S' (required)
//   opts.adaSize:                '4622' (when opts.ada is true)
//   opts.<boolean checkboxes>:   ada, hx, jackPanel, multiJackPanel, studioLight,
//                                ap, overseas, rm, ramp, step, bassTraps, efp, expansion
//   opts.packingListPdfBuffer:   optional Buffer of an uploaded packing list
//
// Returns: { pdfBuffer: Buffer, sectionsIncluded: [...], missing: [...] }
async function buildAssemblyManual(opts = {}) {
  if (!opts.model) throw new Error('model is required');
  const { ctx, plan } = planSections({
    ...opts,
    includePackingList: !!opts.packingListPdfBuffer,
  });

  const sectionsIncluded = [];
  const missing = [];
  const loadedSections = []; // { order, buffer, fileName }

  // Fetch each section's PDF. Sequential rather than parallel — Drive
  // throttles aggressive parallel reads, and we're talking ~10-20 small
  // files per build, so the latency impact is negligible.
  for (const s of plan) {
    if (s.order === 'E') {
      // Packing list comes from the upload, not Drive
      loadedSections.push({ order: 'E', buffer: opts.packingListPdfBuffer, fileName: 'PackingList.pdf' });
      sectionsIncluded.push({ ...s, fileName: 'PackingList.pdf' });
      continue;
    }
    let file;
    try {
      file = await _findFileByMatch(s.folder, s.needle);
    } catch (e) {
      missing.push({ ...s, error: e.message });
      continue;
    }
    if (!file) {
      missing.push({ ...s, error: 'No matching file in folder' });
      continue;
    }
    try {
      const buffer = await _deps.gdrive.gdriveDownloadFile(file.id);
      loadedSections.push({ order: s.order, buffer, fileName: file.name });
      sectionsIncluded.push({ ...s, fileName: file.name, fileId: file.id });
    } catch (e) {
      missing.push({ ...s, fileName: file.name, error: e.message });
    }
  }

  // Sort by order key so the merged PDF flows in the right sequence.
  loadedSections.sort((a, b) => a.order.localeCompare(b.order));
  sectionsIncluded.sort((a, b) => a.order.localeCompare(b.order));

  // Merge using pdf-lib. Load each source doc, copy its pages into the
  // output, append in order. ignoreEncryption handles old AcroForm-style
  // PDFs that have benign encryption flags but no password.
  const { PDFDocument } = require('pdf-lib');
  const merged = await PDFDocument.create();
  for (const ls of loadedSections) {
    try {
      const src = await PDFDocument.load(ls.buffer, { ignoreEncryption: true });
      const pages = await merged.copyPages(src, src.getPageIndices());
      for (const pg of pages) merged.addPage(pg);
    } catch (e) {
      console.error(`[assembly-manual] Failed to merge ${ls.fileName}: ${e.message}`);
      missing.push({ order: ls.order, fileName: ls.fileName, error: `Merge failed: ${e.message}` });
    }
  }

  const pdfBytes = await merged.save();
  return {
    pdfBuffer:        Buffer.from(pdfBytes),
    sectionsIncluded,
    missing,
    ctx,
  };
}

module.exports = {
  init,
  SECTIONS,
  planSections,
  buildAssemblyManual,
};
