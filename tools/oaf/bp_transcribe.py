"""Basic Pitch baseline over the same wav, using the ONNX model (same as the app)."""

import json
import sys
import time

from basic_pitch import ICASSP_2022_MODEL_PATH
from basic_pitch.inference import predict, Model

wav, out_json = sys.argv[1], sys.argv[2]
model = Model(ICASSP_2022_MODEL_PATH)
t0 = time.perf_counter()
_, midi_data, note_events = predict(wav, model)
dt = time.perf_counter() - t0

notes = [
    {
        "onset": round(float(s), 3),
        "offset": round(float(e), 3),
        "pitch": int(p),
        "velocity": round(float(a), 3),
    }
    for s, e, p, a, _ in note_events
]
notes.sort(key=lambda n: (n["onset"], n["pitch"]))
with open(out_json, "w") as f:
    json.dump(notes, f, indent=1)
print(f"{len(notes)} notes | total inference {dt:.2f}s")
for n in notes:
    name = "C C#D D#E F F#G G#A A#B"[(n["pitch"] % 12) * 2 : (n["pitch"] % 12) * 2 + 2].strip()
    print(
        f"  {n['onset']:6.2f}-{n['offset']:6.2f}  {name}{n['pitch'] // 12 - 1}  v={n['velocity']:.2f}"
    )
