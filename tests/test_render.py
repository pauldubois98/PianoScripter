from pathlib import Path

from notes_scripter.pipeline import rebuild
from notes_scripter.render import musicxml_to_svgs, svgs_to_pdf
from notes_scripter.score import build_score, quantize, score_to_musicxml
from notes_scripter.transcribe import NoteEvent


def make_qnotes():
    events = [
        NoteEvent(onset=i * 0.5, offset=i * 0.5 + 0.45, pitch=p, velocity=70)
        for i, p in enumerate([60, 64, 67, 72, 48])
    ]
    return quantize(events, bpm=120.0)


def test_musicxml_to_svg_to_pdf(tmp_path: Path):
    qnotes = make_qnotes()
    score, _ = build_score(qnotes, bpm=120.0)
    xml = score_to_musicxml(score, tmp_path / "t.musicxml")

    svgs = musicxml_to_svgs(xml)
    assert svgs and "<svg" in svgs[0]

    pdf = svgs_to_pdf(svgs, tmp_path / "t.pdf")
    assert pdf.read_bytes()[:5] == b"%PDF-"


def test_rebuild_outputs(tmp_path: Path):
    out = rebuild(make_qnotes(), 120.0, tmp_path)
    assert out.midi.read_bytes()[:4] == b"MThd"
    assert out.pdf.read_bytes()[:5] == b"%PDF-"
    assert out.musicxml.exists()
    assert out.svg_pages
    assert out.n_notes == len(make_qnotes())
