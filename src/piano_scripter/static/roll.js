// Live piano-roll rendering: pure canvas code, no Vue dependency.
const ROLL_SPAN = 12; // seconds visible
const ROLL_LO = 21, ROLL_HI = 108; // piano range

/** Draw one frame of the scrolling roll. events: [[onset, offset, pitch, velocity], ...] */
function drawPianoRoll(canvas, events, nowSeconds) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--accent").trim();
  const border = css.getPropertyValue("--border").trim();
  const muted = css.getPropertyValue("--muted").trim();
  const t0 = nowSeconds - ROLL_SPAN;
  const rowH = h / (ROLL_HI - ROLL_LO + 1);
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  for (let p = 24; p <= ROLL_HI; p += 12) { // C guide lines, one per octave
    const y = Math.round(h - (p - ROLL_LO + 1) * rowH) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  ctx.fillStyle = accent;
  for (const [onset, offset, pitch, velocity] of events) {
    if (offset < t0) continue;
    const x = Math.max(0, ((onset - t0) / ROLL_SPAN) * w);
    const xw = Math.max(2, ((Math.min(offset, nowSeconds) - Math.max(onset, t0)) / ROLL_SPAN) * w);
    const y = h - (pitch - ROLL_LO + 1) * rowH;
    ctx.globalAlpha = 0.35 + 0.65 * (velocity / 127);
    ctx.fillRect(x, y + 0.5, xw, Math.max(2, rowH - 1));
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = muted; // playhead on the right edge
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(w - 1.5, 0); ctx.lineTo(w - 1.5, h); ctx.stroke();
  ctx.setLineDash([]);
}
