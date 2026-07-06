"""Generate JSON fixtures from the Python reference pipeline for the JS tests.

Run from the repo root:  uv run python tools/make_fixtures.py
Writes to web/tests/fixtures/. Commit the output: the vitest suite checks the
JS ports (quantize, ByteDance postprocessor, Basic Pitch note creation, trim)
against these reference results.
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from notes_scripter import score, transcribe, ultra  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "web" / "tests" / "fixtures"

FREQS = {60: 261.63, 64: 329.63, 67: 392.0, 72: 523.25, 48: 130.81, 55: 196.0}


def synth_song(sr: int = 16000) -> np.ndarray:
    """Same little arpeggio the Python e2e test uses, with padded silence."""

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
    return audio.astype(np.float32)


def rounded(arr: np.ndarray, decimals: int = 5) -> list:
    return [round(float(v), decimals) for v in np.asarray(arr).ravel()]


def fixture_quantize() -> None:
    rng = np.random.default_rng(42)
    notes = []
    t = 0.13
    for _ in range(40):
        pitch = int(rng.integers(36, 96))
        dur = float(rng.choice([0.11, 0.24, 0.5, 0.77, 1.4]))
        notes.append(transcribe.NoteEvent(round(t, 3), round(t + dur, 3), pitch, 80))
        t += float(rng.choice([0.12, 0.25, 0.26, 0.49]))
    # a chord (same onset, several pitches) and an exact duplicate
    notes.append(transcribe.NoteEvent(1.0, 1.5, 60, 70))
    notes.append(transcribe.NoteEvent(1.0, 1.5, 64, 75))
    notes.append(transcribe.NoteEvent(1.0, 1.5, 60, 90))
    bpm = 96.0
    qnotes = score.quantize(list(notes), bpm)
    (OUT / "quantize.json").write_text(
        json.dumps(
            {
                "bpm": bpm,
                "notes": [asdict(n) for n in notes],
                "expected": [asdict(q) for q in qnotes],
            }
        )
    )
    print(f"quantize.json: {len(notes)} notes -> {len(qnotes)} qnotes")


def fixture_bytedance_post() -> None:
    """Synthetic activation matrices -> reference postprocessor output."""
    from piano_transcription_inference.utilities import RegressionPostProcessor

    rng = np.random.default_rng(7)
    n_frames, classes = 400, 88
    heads = {
        "reg_onset_output": rng.uniform(0, 0.05, (n_frames, classes)),
        "reg_offset_output": rng.uniform(0, 0.05, (n_frames, classes)),
        "frame_output": rng.uniform(0, 0.05, (n_frames, classes)),
        "velocity_output": rng.uniform(0.3, 0.9, (n_frames, classes)),
        "reg_pedal_onset_output": rng.uniform(0, 0.05, (n_frames, 1)),
        "reg_pedal_offset_output": rng.uniform(0, 0.05, (n_frames, 1)),
        "pedal_frame_output": rng.uniform(0, 0.1, (n_frames, 1)),
    }

    def bump(mat, center, width, height):
        for d in range(-width, width + 1):
            f = center + d
            if 0 <= f < n_frames:
                mat[f] = max(mat[f], height * (1 - abs(d) / (width + 1)))

    events = [(30, 40, 100), (95, 42, 60), (95, 46, 60), (160, 40, 80), (300, 70, 55)]
    for onset_f, pitch, dur in events:
        col = pitch - 21
        bump(heads["reg_onset_output"][:, col], onset_f, 3, 0.9)
        end_f = min(onset_f + dur, n_frames - 1)
        heads["frame_output"][onset_f:end_f, col] = 0.8
        bump(heads["reg_offset_output"][:, col], end_f, 4, 0.7)
    # one pedal press
    heads["pedal_frame_output"][100:200, 0] = 0.9
    bump(heads["reg_pedal_offset_output"][:, 0], 200, 4, 0.8)

    # round BEFORE computing the reference: the JSON round-trip must not
    # change the values either side sees (ties at bump peaks flip detection)
    heads = {k: np.round(v, 5).astype(np.float32) for k, v in heads.items()}
    post = RegressionPostProcessor(
        100,
        classes_num=88,
        onset_threshold=0.3,
        offset_threshold=0.3,
        frame_threshold=0.1,
        pedal_offset_threshold=0.2,
    )
    note_events, pedal_events = post.output_dict_to_midi_events(dict(heads))
    (OUT / "bytedance_post.json").write_text(
        json.dumps(
            {
                "nFrames": n_frames,
                "heads": {k.replace("_output", ""): rounded(v) for k, v in heads.items()},
                "expectedNotes": [
                    {
                        "onset": round(float(e["onset_time"]), 5),
                        "offset": round(float(e["offset_time"]), 5),
                        "pitch": int(e["midi_note"]),
                        "velocity": int(e["velocity"]),
                    }
                    for e in note_events
                ],
                "expectedPedals": [
                    {
                        "onset": round(float(e["onset_time"]), 5),
                        "offset": round(float(e["offset_time"]), 5),
                    }
                    for e in pedal_events
                ],
            }
        )
    )
    print(f"bytedance_post.json: {len(note_events)} notes, {len(pedal_events)} pedals")


def fixture_basicpitch() -> None:
    """Real Basic Pitch activations for the synth song -> reference events."""
    audio = synth_song()
    audio_22k = ultra.librosa.resample(
        audio, orig_sr=transcribe.SAMPLE_RATE, target_sr=ultra.BP_SAMPLE_RATE
    )
    output = ultra._run_model(audio_22k)
    # round BEFORE computing the reference (see fixture_bytedance_post)
    note_m = np.round(output["note"], 5).astype(np.float32)
    onset_m = np.round(output["onset"], 5).astype(np.float32)
    events = ultra._output_to_notes(note_m, onset_m, melodia_trick=True)
    events_stream = ultra._output_to_notes(note_m, onset_m, melodia_trick=False)
    times = ultra._frames_to_time(note_m.shape[0])
    notes = sorted(
        (
            transcribe.NoteEvent(
                onset=float(times[start]),
                offset=float(times[min(end, len(times) - 1)]),
                pitch=pitch,
                velocity=min(127, max(1, round(amplitude * 127))),
            )
            for start, end, pitch, amplitude in events
        ),
        key=lambda n: (n.onset, n.pitch),
    )
    (OUT / "basicpitch.json").write_text(
        json.dumps(
            {
                "rows": int(note_m.shape[0]),
                "note": rounded(note_m),
                "onset": rounded(onset_m),
                "expectedEvents": [
                    [int(a), int(b), int(p), round(float(amp), 5)] for a, b, p, amp in events
                ],
                "expectedEventsStream": [
                    [int(a), int(b), int(p), round(float(amp), 5)] for a, b, p, amp in events_stream
                ],
                "expectedNotes": [asdict(n) for n in notes],
            }
        )
    )
    print(f"basicpitch.json: {output['note'].shape[0]} frames, {len(events)} events")


def fixture_trim() -> None:
    """Deterministic tone-in-silence signal; JS rebuilds it and checks bounds."""
    sr = transcribe.SAMPLE_RATE
    audio = np.zeros(sr * 4, dtype=np.float32)
    t = np.arange(sr * 2) / sr
    audio[sr : sr * 3] = 0.5 * np.sin(2 * np.pi * 440.0 * t).astype(np.float32)
    trimmed = transcribe.trim_silence(audio)
    (OUT / "trim.json").write_text(
        json.dumps(
            {
                "sampleRate": sr,
                "durationS": 4,
                "toneStartS": 1,
                "toneEndS": 3,
                "toneHz": 440.0,
                "amplitude": 0.5,
                "expectedLength": int(len(trimmed)),
            }
        )
    )
    print(f"trim.json: trimmed length {len(trimmed)} of {len(audio)}")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    fixture_quantize()
    fixture_bytedance_post()
    fixture_basicpitch()
    fixture_trim()


if __name__ == "__main__":
    main()
