// Measure structure -> MusicXML (score-partwise). The only consumer is
// Verovio, but the output is standard MusicXML and downloadable as-is.

import { buildMeasures } from "./score.js";
import { detectKey } from "./keydetect.js";

const DIVISIONS = 4; // per quarter note: sixteenth = 1 division

const TYPE_FOR_QL = new Map([
  [4, ["whole", 0]],
  [3, ["half", 1]],
  [2, ["half", 0]],
  [1.5, ["quarter", 1]],
  [1, ["quarter", 0]],
  [0.75, ["eighth", 1]],
  [0.5, ["eighth", 0]],
  [0.25, ["16th", 0]],
]);

const SHARP_SPELLINGS = [
  ["C", 0], ["C", 1], ["D", 0], ["D", 1], ["E", 0], ["F", 0],
  ["F", 1], ["G", 0], ["G", 1], ["A", 0], ["A", 1], ["B", 0],
];
const FLAT_SPELLINGS = [
  ["C", 0], ["D", -1], ["D", 0], ["E", -1], ["E", 0], ["F", 0],
  ["G", -1], ["G", 0], ["A", -1], ["A", 0], ["B", -1], ["B", 0],
];

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function pitchXml(midi, useFlats) {
  const [step, alter] = (useFlats ? FLAT_SPELLINGS : SHARP_SPELLINGS)[midi % 12];
  const octave = Math.floor(midi / 12) - 1;
  return (
    `<pitch><step>${step}</step>` +
    (alter ? `<alter>${alter}</alter>` : "") +
    `<octave>${octave}</octave></pitch>`
  );
}

function noteXml(item, useFlats) {
  const duration = Math.round(item.durQl * DIVISIONS);
  if (item.kind === "rest") {
    if (item.wholeMeasure) {
      return `<note><rest measure="yes"/><duration>${duration}</duration><voice>1</voice></note>`;
    }
    const [type, dots] = TYPE_FOR_QL.get(item.durQl);
    return (
      `<note><rest/><duration>${duration}</duration><voice>1</voice>` +
      `<type>${type}</type>${"<dot/>".repeat(dots)}</note>`
    );
  }
  const [type, dots] = TYPE_FOR_QL.get(item.durQl);
  let xml = "";
  item.pitches.forEach((midi, i) => {
    const ties =
      (item.tieStop ? '<tie type="stop"/>' : "") +
      (item.tieStart ? '<tie type="start"/>' : "");
    const tied =
      item.tieStop || item.tieStart
        ? "<notations>" +
          (item.tieStop ? '<tied type="stop"/>' : "") +
          (item.tieStart ? '<tied type="start"/>' : "") +
          "</notations>"
        : "";
    xml +=
      "<note>" +
      (i > 0 ? "<chord/>" : "") +
      pitchXml(midi, useFlats) +
      `<duration>${duration}</duration>` +
      ties +
      "<voice>1</voice>" +
      `<type>${type}</type>${"<dot/>".repeat(dots)}` +
      tied +
      "</note>";
  });
  return xml;
}

function measureXml(items, index, { clef, fifths, bpm }) {
  let xml = `<measure number="${index + 1}">`;
  if (index === 0) {
    xml +=
      "<attributes>" +
      `<divisions>${DIVISIONS}</divisions>` +
      `<key><fifths>${fifths}</fifths></key>` +
      "<time><beats>4</beats><beat-type>4</beat-type></time>" +
      `<clef><sign>${clef.sign}</sign><line>${clef.line}</line></clef>` +
      "</attributes>";
    if (bpm != null) {
      // text-only tempo mark, matching build_score (glyph marks break PDF export)
      xml +=
        '<direction placement="above"><direction-type>' +
        `<words>${Math.round(bpm)} BPM</words>` +
        `</direction-type><sound tempo="${Math.round(bpm)}"/></direction>`;
    }
  }
  const useFlats = fifths < 0;
  for (const item of items) xml += noteXml(item, useFlats);
  return xml + "</measure>";
}

/**
 * qnotes + metadata -> { musicxml, key } where key is the detected key name
 * (or null). Mirrors score.build_score + score_to_musicxml.
 */
export function buildMusicXml(qnotes, bpm, { title = "Transcription", composer = "" } = {}) {
  const detected = detectKey(qnotes);
  const fifths = detected ? detected.fifths : 0;
  const { measures, nMeasures } = buildMeasures(qnotes);

  const parts = [
    { id: "P1", hand: "R", clef: { sign: "G", line: 2 }, tempo: true },
    { id: "P2", hand: "L", clef: { sign: "F", line: 4 }, tempo: false },
  ];

  let xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<score-partwise version="3.1">' +
    `<work><work-title>${esc(title)}</work-title></work>` +
    "<identification>" +
    (composer ? `<creator type="composer">${esc(composer)}</creator>` : "") +
    "<encoding><software>NoteScripter</software></encoding>" +
    "</identification>" +
    "<part-list>" +
    parts
      .map(
        (p) =>
          `<score-part id="${p.id}"><part-name></part-name>` +
          "<score-instrument id=\"" + p.id + "-I1\"><instrument-name>Piano</instrument-name></score-instrument>" +
          "</score-part>"
      )
      .join("") +
    "</part-list>";

  for (const p of parts) {
    xml += `<part id="${p.id}">`;
    for (let m = 0; m < nMeasures; m++) {
      xml += measureXml(measures[p.hand][m], m, {
        clef: p.clef,
        fifths,
        bpm: p.tempo ? bpm : null,
      });
    }
    xml += "</part>";
  }
  xml += "</score-partwise>";
  return { musicxml: xml, key: detected ? detected.name : null };
}
