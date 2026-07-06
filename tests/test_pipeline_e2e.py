"""Full pipeline test — needs the ~165 MB model checkpoint. Run with: pytest -m slow"""

from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from piano_scripter import pipeline

FREQS = {60: 261.63, 64: 329.63, 67: 392.0, 72: 523.25, 48: 130.81, 55: 196.0}


def synth_song(path: Path, sr: int = 16000) -> None:
    def piano_note(f: float, dur: float, amp: float = 0.3) -> np.ndarray:
        t = np.linspace(0, dur, int(sr * dur), endpoint=False)
        return np.exp(-3 * t) * sum(
            (amp / (h * h)) * np.sin(2 * np.pi * f * h * t) for h in range(1, 6)
        )

    song = [(0.0, 60, 0.5), (0.5, 64, 0.5), (1.0, 67, 0.5), (1.5, 72, 1.0), (0.0, 48, 1.0)]
    audio = np.zeros(int(sr * 4.0))
    for onset, pitch, dur in song:
        x = piano_note(FREQS[pitch], dur)
        i = int(onset * sr)
        audio[i : i + len(x)] += x
    audio /= np.abs(audio).max() * 1.2
    sf.write(str(path), audio, sr)


@pytest.mark.slow
@pytest.mark.parametrize("effort", ["ultra", "fast", "balanced", "best"])
def test_full_pipeline(tmp_path: Path, effort: str):
    wav = tmp_path / "song.wav"
    synth_song(wav)
    out = pipeline.run(wav, tmp_path / "out", effort=effort)
    assert out.midi.exists()
    assert out.musicxml.exists()
    assert out.pdf.read_bytes()[:5] == b"%PDF-"
    assert out.n_notes >= 3
    assert out.svg_pages
