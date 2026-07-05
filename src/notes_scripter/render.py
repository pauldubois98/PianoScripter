"""MusicXML -> SVG pages (Verovio) and PDF (cairosvg + pypdf). All local."""

from __future__ import annotations

import io
from pathlib import Path

import structlog

log = structlog.get_logger()

_VEROVIO_OPTIONS = {
    "scale": 40,
    "adjustPageHeight": False,
    "footer": "none",
    "pageMarginTop": 60,
    "pageMarginBottom": 60,
    "pageMarginLeft": 60,
    "pageMarginRight": 60,
}


def musicxml_to_svgs(musicxml_path: Path) -> list[str]:
    import verovio

    tk = verovio.toolkit()
    tk.setOptions(_VEROVIO_OPTIONS)
    if not tk.loadFile(str(musicxml_path)):
        raise RuntimeError(f"Verovio could not load {musicxml_path}")
    pages = [tk.renderToSVG(i + 1) for i in range(tk.getPageCount())]
    log.info("rendered_svg", pages=len(pages))
    return pages


def svgs_to_pdf(svg_pages: list[str], pdf_path: Path) -> Path:
    import cairosvg
    from pypdf import PdfReader, PdfWriter

    writer = PdfWriter()
    for svg in svg_pages:
        page_pdf = cairosvg.svg2pdf(bytestring=svg.encode())
        for page in PdfReader(io.BytesIO(page_pdf)).pages:
            writer.add_page(page)
    with open(pdf_path, "wb") as f:
        writer.write(f)
    log.info("wrote_pdf", path=str(pdf_path))
    return pdf_path
