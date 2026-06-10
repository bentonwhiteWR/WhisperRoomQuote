# Booth Builder component-art import.
# Pulls Benton's SketchUp face-on renders from Z:\Sketchup\BoothBuilderClaude\
# Components, alpha-crops them, normalizes exposure to the 46-Wall reference,
# downscales to 800px tall and writes WebP into assets/booth-art/.
#
#   python bot/specsheet-work/import-art.py
#
# Render rules (for new components):
#   - SketchUp camera: Parallel Projection, straight-on front view
#   - Export PNG with transparent background (current exports already do this)
#   - Component fills the frame; ~2400px wide is plenty
#   - Keep the same material/lighting setup as "46 Wall.png" — the importer
#     gain-corrects exposure, but consistent lighting beats correction
#
# After adding a render: add a MAP row + (if it's a NEW kind of part) a
# manifest entry in assets/layout-render.js ELEV_ART, then re-run this.
from PIL import Image
import numpy as np
import os

SRC = r'Z:/Sketchup/BoothBuilderClaude/Components'
DST = os.path.join(os.path.dirname(__file__), '..', '..', 'assets', 'booth-art')
REF = '46 Wall.png'             # exposure reference
MAP = {
    '46 Wall.png':            'wall-46.webp',
    '46VntWall.png':          'wall-46-vnt.webp',
    '3236 WDO.png':           'wall-46-wdo3236.webp',
    '30DoorLeft.png':         'door-30-left.webp',
    'Mid Wall Seam Seal.png': 'seal-mid.webp',
    'Corner Seam Seal.png':   'seal-corner.webp',
}

def load_cropped(name):
    im = Image.open(os.path.join(SRC, name)).convert('RGBA')
    a = np.array(im)
    ys, xs = np.where(a[..., 3] > 8)
    return im.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))

def med_lum(im):
    a = np.array(im).astype(np.float32)
    rgb = a[..., :3][a[..., 3] > 200]
    return float(np.median(0.299 * rgb[:, 0] + 0.587 * rgb[:, 1] + 0.114 * rgb[:, 2]))

ref = med_lum(load_cropped(REF))
print(f'reference ({REF}) median luminance: {ref:.1f}')
for src, dst in MAP.items():
    im = load_cropped(src)
    lum = med_lum(im)
    if abs(lum - ref) > 6:
        gain = ref / max(lum, 1)
        a = np.array(im).astype(np.float32)
        a[..., :3] = np.clip(a[..., :3] * gain, 0, 255)
        im = Image.fromarray(a.astype(np.uint8))
        print(f'  {src}: luminance {lum:.0f} -> gain {gain:.2f}')
    if im.height > 800:
        im = im.resize((round(im.width * 800 / im.height), 800), Image.LANCZOS)
    p = os.path.join(DST, dst)
    im.save(p, 'WEBP', quality=80, method=6)
    # aspect goes into the ELEV_ART manifest (parallel projection ⇒ aspect
    # IS the real w/h proportion, so heights derive from known widths)
    print(f'{dst:26} {im.width}x{im.height}  aspect={im.width / im.height:.4f}  {os.path.getsize(p) // 1024}KB')
