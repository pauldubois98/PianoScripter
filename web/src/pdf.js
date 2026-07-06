// Client-side PDF export: Verovio SVG pages -> one PDF via jsPDF + svg2pdf.
// Verovio outputs pure path geometry (SMuFL glyphs as <path> defs), so no
// font embedding is needed. Loaded lazily: only when the user clicks PDF.

export async function svgsToPdf(svgPages) {
  const [{ jsPDF }] = await Promise.all([import("jspdf"), import("svg2pdf.js")]);
  let doc = null;
  for (const svgText of svgPages) {
    const holder = document.createElement("div");
    holder.innerHTML = svgText;
    const svg = holder.querySelector("svg");
    // Verovio page size is in px units (viewBox tenths scaled); use pt at 96dpi
    const widthPx = parseFloat(svg.getAttribute("width")) || 2100;
    const heightPx = parseFloat(svg.getAttribute("height")) || 2970;
    const wPt = (widthPx * 72) / 96;
    const hPt = (heightPx * 72) / 96;
    if (!doc) {
      doc = new jsPDF({ unit: "pt", format: [wPt, hPt], orientation: wPt > hPt ? "l" : "p" });
    } else {
      doc.addPage([wPt, hPt], wPt > hPt ? "l" : "p");
    }
    // svg2pdf needs the element in the DOM for computed styles
    holder.style.position = "absolute";
    holder.style.left = "-99999px";
    document.body.appendChild(holder);
    try {
      await doc.svg(svg, { x: 0, y: 0, width: wPt, height: hPt });
    } finally {
      holder.remove();
    }
  }
  return doc.output("blob");
}
