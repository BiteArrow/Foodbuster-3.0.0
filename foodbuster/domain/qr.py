"""Branded QR codes. The SVG is built as an element tree (xml.etree), so every attribute is escaped by the library."""

from __future__ import annotations

import xml.etree.ElementTree as ET

import qrcode
from qrcode.constants import ERROR_CORRECT_H

SVG_NS = "http://www.w3.org/2000/svg"


def _f(value: float) -> str:
    return f"{value:.2f}".rstrip("0").rstrip(".")


def qr_svg(data: str, *, dark: str = "#10231C", accent: str = "#E4572E", light: str = "#FFFFFF", logo: bool = True) -> str:
    code = qrcode.QRCode(error_correction=ERROR_CORRECT_H, border=0, box_size=1)
    code.add_data(data)
    code.make(fit=True)
    matrix = code.get_matrix()
    n = len(matrix)
    quiet = 3
    size = n + quiet * 2
    logo_span = (max(5, int(n * 0.2)) | 1) if logo else 0
    logo_start = (n - logo_span) // 2

    def in_finder(r: int, c: int) -> bool:
        return (r < 7 and c < 7) or (r < 7 and c >= n - 7) or (r >= n - 7 and c < 7)

    def in_logo(r: int, c: int) -> bool:
        return bool(logo) and logo_start <= r < logo_start + logo_span and logo_start <= c < logo_start + logo_span

    svg = ET.Element("svg", {"xmlns": SVG_NS, "viewBox": f"0 0 {size} {size}", "shape-rendering": "geometricPrecision",
                             "role": "img", "aria-label": "QR-код"})
    ET.SubElement(svg, "rect", {"width": str(size), "height": str(size), "rx": "2", "fill": light})
    cells = ET.SubElement(svg, "g", {"fill": dark})
    for r, row in enumerate(matrix):
        for c, on in enumerate(row):
            if on and not in_finder(r, c) and not in_logo(r, c):
                ET.SubElement(cells, "rect", {"x": _f(c + quiet + 0.06), "y": _f(r + quiet + 0.06), "width": "0.88", "height": "0.88", "rx": "0.26"})
    for r0, c0 in ((0, 0), (0, n - 7), (n - 7, 0)):
        x, y = c0 + quiet, r0 + quiet
        ET.SubElement(svg, "rect", {"x": _f(x + 0.5), "y": _f(y + 0.5), "width": "6", "height": "6", "rx": "1.7", "fill": "none",
                                    "stroke": dark, "stroke-width": "1"})
        ET.SubElement(svg, "rect", {"x": _f(x + 2), "y": _f(y + 2), "width": "3", "height": "3", "rx": "0.9", "fill": accent})
    if logo:
        lx = logo_start + quiet + 0.5
        span = logo_span - 1
        ET.SubElement(svg, "rect", {"x": _f(lx), "y": _f(lx), "width": _f(span), "height": _f(span), "rx": _f(span * 0.3), "fill": dark})
        ET.SubElement(svg, "circle", {"cx": _f(lx + span / 2), "cy": _f(lx + span / 2), "r": _f(span * 0.3), "fill": "none",
                                      "stroke": accent, "stroke-width": _f(span * 0.12)})
        ET.SubElement(svg, "circle", {"cx": _f(lx + span / 2), "cy": _f(lx + span / 2), "r": _f(span * 0.1), "fill": light})
    return ET.tostring(svg, encoding="unicode")
