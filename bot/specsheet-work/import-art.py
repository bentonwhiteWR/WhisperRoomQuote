# Booth Builder component-art import.
# Pulls Benton's SketchUp face-on renders from Z:\Sketchup\BoothBuilderClaude\
# Components, alpha-crops them, downscales to 800px tall and writes WebP into
# assets/booth-art/. Lighting/exposure is kept EXACTLY as rendered — Benton
# lights the renders deliberately for depth (do not "normalize" them).
#
#   python bot/specsheet-work/import-art.py
#
# Render rules (for new components):
#   - SketchUp camera: Parallel Projection, straight-on front view
#   - Export PNG with transparent background (current exports already do this)
#   - Component fills the frame; ~2400px wide is plenty
#
# After adding a render: add a MAP row + (if it's a NEW kind of part) a
# manifest entry in assets/layout-render.js ELEV_ART, then re-run this.
from PIL import Image
import numpy as np
import os

SRC = r'Z:/Sketchup/BoothBuilderClaude/Components'
DST = os.path.join(os.path.dirname(__file__), '..', '..', 'assets', 'booth-art')
MAP = {
    'Components_46Wall.png':              'wall-46.webp',
    'Components_46VentWall.png':          'wall-46-vnt.webp',
    # windows: 32-series live in a 46″ wall, 26-series in a 40″ wall.
    # (no 43″/31″-wall window renders exist — per Benton the 26-series art
    # stands in for those; the renderer picks by host-wall width)
    'Components_3230 WDO.png':            'wall-46-wdo3230.webp',
    'Components_3236 WDO.png':            'wall-46-wdo3236.webp',
    'Components_3242 WDO.png':            'wall-46-wdo3242.webp',
    'Components_3248 WDO.png':            'wall-46-wdo3248.webp',
    'Components_2630 WDO.png':            'wall-40-wdo2630.webp',
    'Components_2636 WDO.png':            'wall-40-wdo2636.webp',
    'Components_2642 WDO.png':            'wall-40-wdo2642.webp',
    'Components_2648 WDO.png':            'wall-40-wdo2648.webp',
    'Components_30DoorLEFT.png':          'door-30-left.webp',
    'Components_Mid Wall Seam Seal.png':  'seal-mid.webp',
    'Components_Corner Seam Seal.png':    'seal-corner.webp',
    # side views of the vent wall (wall edge + ducts + fan) — composited at
    # the booth edge when the vent sits on a wall ADJACENT to the facing one
    'Components_ventilationLeftSide.png':  'vent-side-left.webp',
    'Components ventilationRightSide.png': 'vent-side-right.webp',
    # WA (wide-access) door — 49″ frame, 32″ leaf, 16×48 window; with-ramp
    # variant shows the ramp foot at the door sill
    'Components_WADoorLeftNoRamp.png':     'door-wa-left.webp',
    'Components_WADoorLeftWithRamp.png':   'door-wa-ramp-left.webp',
    # ADA ramp: top-down plan + side profile. Protrudes 3′ 9⅝″ (45.625″).
    'Components_RampTopDown.png':          'ramp-top.webp',
    'Components_RampSideView.png':         'ramp-side.webp',
    # ventilation upgrades: VSS (4 silencer ducts) and VSS+EFS combo —
    # front view, top-down plan and both side profiles
    'Components_46VntWallVSS.png':         'wall-46-vnt-vss.webp',
    'Components_46vntVSS_EFS.png':         'wall-46-vnt-vss-efs.webp',
    'Components_46vntVSS_EFS Top Down.png': 'vent-vss-efs-top.webp',
    'Components_VSSandEFSLeftSide.png':    'vent-vss-efs-side-left.webp',
    'Components_VSSandEFSRightSide.png':   'vent-vss-efs-side-right.webp',
}
# the ramp wedge is too thin for the stray-line filter — plain bbox crop
RAW_BBOX = {'ramp-top.webp', 'ramp-side.webp'}
# Right-hinge door variants: mirror the left render, then re-paste the logo
# plate ("WhisperRoom" below the window) unmirrored so the text stays
# readable. Boxes are x1,y1,x2,y2 at the 800px-tall import scale.
DOORS = {
    'door-30-left.webp':      ('door-30-right.webp',      (195, 382, 266, 408)),
    'door-wa-left.webp':      ('door-wa-right.webp',      (210, 558, 272, 586)),
    'door-wa-ramp-left.webp': ('door-wa-ramp-right.webp', (208, 549, 268, 578)),
}

def load_cropped(name, raw=False):
    im = Image.open(os.path.join(SRC, name)).convert('RGBA')
    a = np.array(im)
    mask = a[..., 3] > 8
    if raw:
        ys, xs = np.where(mask)
        return im.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
    # crop to the LARGEST contiguous block of content — strays (a leftover
    # SketchUp edge floating beside the component) get dropped even when
    # they're full-height lines
    def main_run(profile, thresh):
        on = profile > thresh
        runs, start = [], None
        for i, v in enumerate(on):
            if v and start is None: start = i
            if not v and start is not None: runs.append((start, i)); start = None
        if start is not None: runs.append((start, len(on)))
        # widest run wins (the component dwarfs any stray line)
        return max(runs, key=lambda r: r[1] - r[0])
    c0, c1 = main_run(mask.sum(axis=0), mask.shape[0] * 0.01)
    r0, r1 = main_run(mask.sum(axis=1), mask.shape[1] * 0.01)
    return im.crop((c0, r0, c1, r1))

def save(im, dst):
    p = os.path.join(DST, dst)
    im.save(p, 'WEBP', quality=80, method=6)
    print(f'{dst:26} {im.width}x{im.height}  aspect={im.width / im.height:.4f}  {os.path.getsize(p) // 1024}KB')
    return im

for src, dst in MAP.items():
    im = load_cropped(src, dst in RAW_BBOX)
    if im.height > 800:
        im = im.resize((round(im.width * 800 / im.height), 800), Image.LANCZOS)
    im = save(im, dst)
    if dst in DOORS:
        rdst, box = DOORS[dst]
        x1, y1, x2, y2 = box
        patch = im.crop(box)
        flipped = im.transpose(Image.FLIP_LEFT_RIGHT)
        flipped.paste(patch, (im.width - x2, y1))
        save(flipped, rdst)

# bump the renderer's art cache-buster so browsers drop the day-long cache of
# the (stable) filenames and pick up the re-imported renders immediately
import re
rp = os.path.join(os.path.dirname(__file__), '..', '..', 'assets', 'layout-render.js')
r = open(rp, encoding='utf8').read()
m = re.search(r'const ART_VERSION = (\d+);', r)
if m:
    nv = int(m.group(1)) + 1
    r = r.replace(m.group(0), 'const ART_VERSION = %d;' % nv)
    open(rp, 'w', encoding='utf8', newline='').write(r)
    print('ART_VERSION bumped to', nv)
else:
    print('WARNING: ART_VERSION not found in layout-render.js — bump it manually')
