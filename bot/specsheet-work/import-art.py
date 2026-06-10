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
    'Components_3236 WDO.png':            'wall-46-wdo3236.webp',
    'Components_30DoorLEFT.png':          'door-30-left.webp',
    'Components_Mid Wall Seam Seal.png':  'seal-mid.webp',
    'Components_Corner Seam Seal.png':    'seal-corner.webp',
    # side views of the vent wall (wall edge + ducts + fan) — composited at
    # the booth edge when the vent sits on a wall ADJACENT to the facing one
    'Components_VentilationLeftSide.png':  'vent-side-left.webp',
    'Components_VentilationRightSide.png': 'vent-side-right.webp',
}
# The door logo plate ("WhisperRoom" below the window) in door-30-left at
# 800px-tall scale — re-pasted unmirrored into the right-hinge variant so a
# flipped door doesn't show mirror-image text.
DOOR_LOGO_BOX = (195, 382, 266, 408)   # x1,y1,x2,y2 in the 456x800 art

def load_cropped(name):
    im = Image.open(os.path.join(SRC, name)).convert('RGBA')
    a = np.array(im)
    ys, xs = np.where(a[..., 3] > 8)
    return im.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))

def save(im, dst):
    p = os.path.join(DST, dst)
    im.save(p, 'WEBP', quality=80, method=6)
    print(f'{dst:26} {im.width}x{im.height}  aspect={im.width / im.height:.4f}  {os.path.getsize(p) // 1024}KB')
    return im

for src, dst in MAP.items():
    im = load_cropped(src)
    if im.height > 800:
        im = im.resize((round(im.width * 800 / im.height), 800), Image.LANCZOS)
    im = save(im, dst)
    if dst == 'door-30-left.webp':  # logo box re-checked against the Components_ re-upload
        # right-hinge variant: mirror the whole door, then put the logo patch
        # back unmirrored at its mirrored location
        x1, y1, x2, y2 = DOOR_LOGO_BOX
        patch = im.crop(DOOR_LOGO_BOX)
        flipped = im.transpose(Image.FLIP_LEFT_RIGHT)
        flipped.paste(patch, (im.width - x2, y1))
        save(flipped, 'door-30-right.webp')
