"""
Renders a BIMWorks 2D view contract to SVG/PDF/PNG for review.

Why this exists
---------------
Reviewing a drawing means looking at it, and there was no way to do that from the
backend. An earlier throwaway version of this script parsed SVG paths by taking every
number as an x,y pair, which is wrong for arcs (`A rx ry rot large sweep x y` carries
radii and flags before the endpoint) and drew the door swing at the title-block corner
instead of at its hinge. This version builds real SVG and lets an SVG renderer handle
the path grammar.

Usage
-----
    from render_2d_view import render
    contract = manager.slice_2d_vector_plan(cut_elevation=4.0)
    render(contract, "plan.pdf")        # also writes plan.png

Lineweights are expressed as a fraction of the drawing's larger dimension, because a
fixed weight renders a 46 ft plan as a solid black block.
"""
import re

import pymupdf

#: partition -> (colour, weight as a fraction of the drawing size, dash pattern)
STYLE = {
    "projection_paths": ("#8b939c", 0.0011, None),
    "hidden_paths": ("#9ea6ae", 0.0009, "0.012 0.012"),
    "grids": ("#7373a6", 0.0009, "0.03 0.012 0.004 0.012"),
    "swing_paths": ("#0573bf", 0.0013, None),
    "cut_paths": ("#0d0d1f", 0.0026, None),
}
_NUM = r"[-+]?(?:\d+\.?\d*|\.\d+)"


def build_svg(contract, pad=3.0, pixel_width=1400.0):
    """Builds a standalone SVG for a 2D view contract (coordinates in model units)."""
    pts = []
    for key in STYLE:
        for entry in contract.get(key, []) or []:
            nums = [float(v) for v in re.findall(_NUM, entry.get("d", ""))]
            pts += [(nums[i], nums[i + 1]) for i in range(0, len(nums) - 1, 2)]
    if not pts:
        raise ValueError("the view contract contains no geometry to draw")

    x0, x1 = min(p[0] for p in pts), max(p[0] for p in pts)
    y0, y1 = min(p[1] for p in pts), max(p[1] for p in pts)
    w = (x1 - x0) + 2 * pad
    h = (y1 - y0) + 2 * pad
    span = max(w, h, 1e-6)
    scale = pixel_width / span

    parts = []
    for key, (colour, weight_frac, dash) in STYLE.items():
        dash_attr = f' stroke-dasharray="{dash}"' if dash else ""
        for entry in contract.get(key, []) or []:
            d = (entry.get("d") or "").strip()
            if not d:
                continue
            parts.append(
                f'<path d="{d}" fill="none" stroke="{colour}" '
                f'stroke-width="{weight_frac * span:.4f}"{dash_attr} stroke-linecap="round"/>'
            )

    body = "\n".join(parts)
    # Model Y grows upward, SVG Y grows downward: flip it about the drawing's top.
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.4f} {h:.4f}" '
        f'width="{w * scale:.0f}" height="{h * scale:.0f}">'
        f'<rect x="0" y="0" width="{w:.4f}" height="{h:.4f}" fill="#ffffff"/>'
        f'<g transform="translate({pad - x0:.4f},{h - pad + y0:.4f}) scale(1,-1)">{body}</g>'
        f"</svg>"
    )


def render(contract, out_pdf, dpi=150):
    """Writes `out_pdf` and a sibling `.png`, returning (png_path, width, height)."""
    svg = build_svg(contract).encode("utf-8")
    pdf_bytes = pymupdf.open("svg", svg).convert_to_pdf()
    pymupdf.open("pdf", pdf_bytes).save(out_pdf)
    pix = pymupdf.open(out_pdf)[0].get_pixmap(dpi=dpi)
    png = out_pdf.rsplit(".", 1)[0] + ".png"
    pix.save(png)
    return png, pix.width, pix.height


if __name__ == "__main__":  # pragma: no cover - manual review helper
    import sys

    sys.path.insert(0, "backend")
    from ifc_service import BimModelManager

    manager = BimModelManager()
    manager.reset_model()
    out = sys.argv[1] if len(sys.argv) > 1 else "plan.pdf"
    print(render(manager.slice_2d_vector_plan(cut_elevation=4.0), out))
