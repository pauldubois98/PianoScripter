"""Run the realtime O&F TFLite models over a wav, chunk by chunk.

Outputs a note list (onset, offset, midi pitch, velocity) and timing stats.
"""

import json
import sys
import time

import numpy as np
import soundfile as sf
from ai_edge_litert.interpreter import Interpreter

SR = 16000
CHUNK = 17920  # model input: 1.12 s
FRAMES = 32  # frames per chunk -> 35 ms/frame
FRAME_S = CHUNK / SR / FRAMES
MIDI_LO = 21  # 88 keys from A0

ONSET_T = 0.5
FRAME_T = 0.5


def load_16k_mono(path):
    audio, sr = sf.read(path, dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)
    if sr != SR:
        n = int(round(len(audio) * SR / sr))
        x_old = np.linspace(0, 1, len(audio), endpoint=False)
        x_new = np.linspace(0, 1, n, endpoint=False)
        audio = np.interp(x_new, x_old, audio).astype(np.float32)
    return audio


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


def run_chunks(model_path, audio, fresh_interpreter_per_chunk=False):
    """Feed audio sequentially in CHUNK-sized pieces; return stacked probs."""
    it = Interpreter(model_path=model_path)
    it.allocate_tensors()
    in_idx = it.get_input_details()[0]["index"]
    outs = {d["name"]: d["index"] for d in it.get_output_details()}

    n_chunks = int(np.ceil(len(audio) / CHUNK))
    padded = np.zeros(n_chunks * CHUNK, dtype=np.float32)
    padded[: len(audio)] = audio

    onset_p, frame_p, vel = [], [], []
    times = []
    for c in range(n_chunks):
        if fresh_interpreter_per_chunk and c > 0:
            it = Interpreter(model_path=model_path)
            it.allocate_tensors()
            in_idx = it.get_input_details()[0]["index"]
            outs = {d["name"]: d["index"] for d in it.get_output_details()}
        t0 = time.perf_counter()
        it.set_tensor(in_idx, padded[c * CHUNK : (c + 1) * CHUNK])
        it.invoke()
        times.append(time.perf_counter() - t0)
        onset_p.append(sigmoid(it.get_tensor(outs["onset_logits"])[0]))
        frame_p.append(sigmoid(it.get_tensor(outs["frame_logits"])[0]))
        vel.append(it.get_tensor(outs["velocity_values"])[0])
    return (
        np.concatenate(onset_p),
        np.concatenate(frame_p),
        np.concatenate(vel),
        times,
    )


def decode_notes(onset_p, frame_p, vel):
    """Standard O&F decoding: onset starts a note, frame sustains it."""
    n_frames = onset_p.shape[0]
    notes = []
    active = {}  # pitch -> [start_frame, velocity]
    for t in range(n_frames):
        for p in range(88):
            onset = onset_p[t, p] > ONSET_T and (t == 0 or onset_p[t - 1, p] <= ONSET_T)
            sounding = frame_p[t, p] > FRAME_T
            if p in active:
                if onset and t - active[p][0] > 1:  # retrigger
                    s, v = active.pop(p)
                    notes.append((s, t, p, v))
                    active[p] = [t, vel[t, p]]
                elif not sounding:
                    s, v = active.pop(p)
                    notes.append((s, t, p, v))
            elif onset:
                active[p] = [t, vel[t, p]]
    for p, (s, v) in active.items():
        notes.append((s, n_frames, p, v))
    notes.sort()
    return [
        {
            "onset": round(s * FRAME_S, 3),
            "offset": round(e * FRAME_S, 3),
            "pitch": p + MIDI_LO,
            "velocity": float(np.clip(v, 0, 1)),
        }
        for s, e, p, v in notes
    ]


if __name__ == "__main__":
    model, wav, out_json = sys.argv[1], sys.argv[2], sys.argv[3]
    stateless = len(sys.argv) > 4 and sys.argv[4] == "--stateless"
    audio = load_16k_mono(wav)
    onset_p, frame_p, vel, times = run_chunks(model, audio, stateless)
    notes = decode_notes(onset_p, frame_p, vel)
    with open(out_json, "w") as f:
        json.dump(notes, f, indent=1)
    rt = np.mean(times) / (CHUNK / SR)
    print(
        f"{len(notes)} notes | chunk inference mean {np.mean(times) * 1000:.0f} ms "
        f"(max {np.max(times) * 1000:.0f}) | realtime factor {rt:.2f}x"
    )
    for n in notes:
        name = "C C#D D#E F F#G G#A A#B"[(n["pitch"] % 12) * 2 : (n["pitch"] % 12) * 2 + 2].strip()
        print(
            f"  {n['onset']:6.2f}-{n['offset']:6.2f}  {name}{n['pitch'] // 12 - 1}  v={n['velocity']:.2f}"
        )
