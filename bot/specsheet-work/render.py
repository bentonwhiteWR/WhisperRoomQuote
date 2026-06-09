import sys, os
import pypdfium2 as pdfium

# Usage: render.py <pdf_path> <out_dir> <dpi> [page_start page_end]
pdf_path = sys.argv[1]
out_dir = sys.argv[2]
dpi = float(sys.argv[3]) if len(sys.argv) > 3 else 100
os.makedirs(out_dir, exist_ok=True)
scale = dpi / 72.0

pdf = pdfium.PdfDocument(pdf_path)
n = len(pdf)
start = int(sys.argv[4]) if len(sys.argv) > 4 else 0
end = int(sys.argv[5]) if len(sys.argv) > 5 else n
end = min(end, n)
base = os.path.splitext(os.path.basename(pdf_path))[0]
print(f"{base}: {n} pages, rendering [{start},{end}) @ {dpi}dpi")
for i in range(start, end):
    page = pdf[i]
    bmp = page.render(scale=scale)
    img = bmp.to_pil()
    out = os.path.join(out_dir, f"{base}-p{i+1:02d}.png")
    img.save(out)
    print(f"  page {i+1}: {img.size} -> {out}")
pdf.close()
