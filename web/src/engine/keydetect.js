// Krumhansl-Schmuckler key detection on a duration-weighted pitch-class
// histogram — the same family of algorithm music21's analyze("key") uses.

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const SHARP_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const FLAT_NAMES = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"];

function correlation(x, y) {
  const n = x.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i];
    my += y[i];
  }
  mx /= n;
  my /= n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    dx += (x[i] - mx) ** 2;
    dy += (y[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

function fifthsFor(tonicPc, mode) {
  const majorPc = mode === "major" ? tonicPc : (tonicPc + 3) % 12;
  const raw = (majorPc * 7) % 12;
  return raw > 6 ? raw - 12 : raw;
}

/** qnotes -> { fifths, name } (e.g. { fifths: -3, name: "c minor" }) or null. */
export function detectKey(qnotes) {
  if (!qnotes.length) return null;
  const hist = new Array(12).fill(0);
  for (const q of qnotes) hist[q.pitch % 12] += q.durQl;
  if (!hist.some((v) => v > 0)) return null;

  let best = null;
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const [mode, profile] of [["major", MAJOR_PROFILE], ["minor", MINOR_PROFILE]]) {
      const rotated = hist.map((_, i) => hist[(i + tonic) % 12]);
      const score = correlation(rotated, profile);
      if (!best || score > best.score) best = { tonic, mode, score };
    }
  }
  const fifths = fifthsFor(best.tonic, best.mode);
  const names = fifths < 0 ? FLAT_NAMES : SHARP_NAMES;
  const tonicName = names[best.tonic];
  const name =
    best.mode === "major" ? `${tonicName} major` : `${tonicName.toLowerCase()} minor`;
  return { fifths, name };
}
