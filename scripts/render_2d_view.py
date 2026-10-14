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
    "window_paths": ("#0e7490", 0.0011, None),
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
    # Dimensions are offset outside the geometry, so their extent must widen the frame
    # or the witness lines and the text fall outside the viewBox and are clipped.
    for d in contract.get("dimensions") or []:
        try:
            pts += [tuple(d["start"]), tuple(d["end"])]
        except (KeyError, TypeError):
            continue
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
    dims = dimension_svg(contract, pad)
    # Model Y grows upward, SVG Y grows downward: flip it about the drawing's top.
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.4f} {h:.4f}" '
        f'width="{w * scale:.0f}" height="{h * scale:.0f}">'
        f'<rect x="0" y="0" width="{w:.4f}" height="{h:.4f}" fill="#ffffff"/>'
        f'<g transform="translate({pad - x0:.4f},{h - pad + y0:.4f}) scale(1,-1)">{body}</g>'
        f'<g transform="translate({pad - x0:.4f},{h - pad + y0:.4f}) scale(1,-1)">{dims}</g>'
        f"</svg>"
    )


def dimension_svg(contract, pad):
    """Builds dimension strings (line, witness ticks and the text) as SVG."""
    dims = contract.get("dimensions") or []
    if not dims:
        return ""
    parts = []
    for d in dims:
        try:
            (x0, y0), (x1, y1) = d["start"], d["end"]
        except (KeyError, TypeError, ValueError):
            continue
        off = float(d.get("offset", -1.5))
        horizontal = abs(x1 - x0) >= abs(y1 - y0)
        if horizontal:
            dy = y0 + off
            a, b = (x0, dy), (x1, dy)
            w0, w1 = (x0, y0), (x0, dy)
            v0, v1 = (x1, y1), (x1, dy)
        else:
            dx = x0 + off
            a, b = (dx, y0), (dx, y1)
            w0, w1 = (x0, y0), (dx, y0)
            v0, v1 = (x1, y1), (dx, y1)
        text = d.get("text") or ""
        tx, ty = ((a[0] + b[0]) / 2.0, a[1] - 0.8) if horizontal else (a[0] - 0.8, (a[1] + b[1]) / 2.0)
        parts.append(
            f'<path d="M {a[0]:.3f} {a[1]:.3f} L {b[0]:.3f} {b[1]:.3f}" '
            f'stroke="#0573bf" stroke-width="0.0011" fill="none"/>'
        )
        for s0, s1 in ((w0, w1), (v0, v1)):
            parts.append(
                f'<path d="M {s0[0]:.3f} {s0[1]:.3f} L {s1[0]:.3f} {s1[1]:.3f}" '
                f'stroke="#0573bf" stroke-width="0.0008" fill="none"/>'
            )
        # Text is drawn outside the flipped group, so counter-flip it.
        # The group this sits in is Y-flipped, so counter-flip the glyphs about the
        # text's own baseline or the label renders mirrored.
        parts.append(
            f'<g transform="translate({tx:.3f},{ty:.3f}) scale(1,-1)">'
            f'<text x="0" y="0" font-family="Helvetica" font-size="1.6" '
            f'fill="#0573bf" text-anchor="middle">{text}</text></g>'
        )
    return "\n".join(parts)


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
