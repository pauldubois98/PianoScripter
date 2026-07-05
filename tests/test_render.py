from pathlib import Path

from notes_scripter.render import musicxml_to_svgs, svgs_to_pdf
from notes_scripter.score import events_to_score, score_to_musicxml
from notes_scripter.transcribe import NoteEvent


def test_musicxml_to_svg_to_pdf(tmp_path: Path):
    events = [
        NoteEvent(onset=i * 0.5, offset=i * 0.5 + 0.45, pitch=p, velocity=70)
        for i, p in enumerate([60, 64, 67, 72])
    ]
    score, _ = events_to_score(events, bpm=120.0)
    xml = score_to_musicxml(score, tmp_path / "t.musicxml")

    svgs = musicxml_to_svgs(xml)
    assert svgs and svgs[0].lstrip().startswith("<?xml") or "<svg" in svgs[0]

    pdf = svgs_to_pdf(svgs, tmp_path / "t.pdf")
    assert pdf.exists()
    assert pdf.read_bytes()[:5] == b"%PDF-"
