"""Export the ByteDance piano transcription model to ONNX for the web app.

Produces the variants consumed by web/src/engine/bytedance.js:
  bytedance-fp32.onnx  (~174 MB)  "best" (hop 0.25)
  bytedance-fp16.onnx  (~88 MB)   "fast" (hop 1.0) and "balanced" (hop 0.5)
  bytedance-int8.onnx  (~144 MB)  optional (--int8): dynamic-quantized MatMuls;
                                  larger than fp16 (GRU weights stay fp32), so
                                  the web app does not use it by default

Usage (from the repo root):
  uv run python tools/export_onnx.py --out web/public/models
  uv run python tools/export_onnx.py --out web/public/models --verify path/to/clip.wav

The --verify pass compares ONNX vs PyTorch on a real clip. Raw activations can
differ at the 1e-3 level (the log-mel front end amplifies float noise near the
clamp floor), so the gate is event-level: identical note events (F1 = 1.0 at
50 ms tolerance) plus a loose max-abs sanity bound for fp32.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

SEGMENT_SAMPLES = 160000  # 10 s at 16 kHz

# ONNX output names, in the order Note_pedal returns them (dict -> tuple)
HEADS = [
    "reg_onset",
    "reg_offset",
    "frame",
    "velocity",
    "reg_pedal_onset",
    "reg_pedal_offset",
    "pedal_frame",
]
KEY_FOR_HEAD = {
    "reg_onset": "reg_onset_output",
    "reg_offset": "reg_offset_output",
    "frame": "frame_output",
    "velocity": "velocity_output",
    "reg_pedal_onset": "reg_pedal_onset_output",
    "reg_pedal_offset": "reg_pedal_offset_output",
    "pedal_frame": "pedal_frame_output",
}


class ExportWrapper(torch.nn.Module):
    """Wraps Note_pedal to return a fixed tuple (dict outputs don't export)."""

    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, audio):
        out = self.model(audio)
        return tuple(out[KEY_FOR_HEAD[h]] for h in HEADS)


def load_model():
    from piano_transcription_inference import PianoTranscription

    transcriptor = PianoTranscription(device=torch.device("cpu"))
    model = transcriptor.model
    model.eval()
    return transcriptor, model


def export_fp32(model, path: Path) -> None:
    wrapper = ExportWrapper(model)
    dummy = torch.zeros(1, SEGMENT_SAMPLES, dtype=torch.float32)
    torch.onnx.export(
        wrapper,
        dummy,
        str(path),
        input_names=["audio"],
        output_names=HEADS,
        opset_version=17,
        dynamic_axes={"audio": {0: "batch"}, **{h: {0: "batch"} for h in HEADS}},
    )
    # the dynamo exporter may write weights to a sidecar .data file; the web
    # loader wants one self-contained file
    import onnx

    model_proto = onnx.load(str(path))
    _isolate_internal_outputs(model_proto)
    data_file = path.with_suffix(path.suffix + ".data")
    onnx.save(model_proto, str(path))
    data_file.unlink(missing_ok=True)
    print(f"wrote {path} ({path.stat().st_size / 1e6:.1f} MB)")


def _isolate_internal_outputs(model) -> None:
    """Route graph outputs that are also consumed internally through Identity.

    The velocity head feeds both a graph output and the reg_onset conditioning;
    the fp16 converter mis-types such shared edges (Mul bound to fp16 + fp32).
    """
    import onnx

    internal_inputs = {i for n in model.graph.node for i in n.input}
    for out in model.graph.output:
        if out.name not in internal_inputs:
            continue
        raw = out.name + "_raw"
        for n in model.graph.node:
            n.output[:] = [raw if o == out.name else o for o in n.output]
            n.input[:] = [raw if i == out.name else i for i in n.input]
        model.graph.node.append(
            onnx.helper.make_node("Identity", [raw], [out.name], name=f"identity_{out.name}")
        )


def export_fp16(fp32_path: Path, path: Path) -> None:
    import onnx
    from onnxconverter_common import float16

    model = onnx.load(str(fp32_path))
    # keep_io_types: the JS side always feeds/reads float32
    model_fp16 = float16.convert_float_to_float16(model, keep_io_types=True)
    onnx.save(model_fp16, str(path))
    print(f"wrote {path} ({path.stat().st_size / 1e6:.1f} MB)")


def export_int8(fp32_path: Path, path: Path) -> None:
    """Quantize MatMul weights only, keeping the two mel-filterbank MatMuls
    fp32 (their dynamic range makes per-tensor int8 catastrophic). Conv and
    GRU stay fp32: ConvInteger wrecks accuracy and ort has no dynamic GRU."""
    import onnx
    from onnxruntime.quantization import QuantType, quantize_dynamic

    model = onnx.load(str(fp32_path))
    producers = {o: n for n in model.graph.node for o in n.output}

    def ancestors(node):
        seen, stack = set(), list(node.input)
        while stack:
            p = producers.get(stack.pop())
            if p and p.name not in seen:
                seen.add(p.name)
                stack.extend(p.input)
        return seen

    # front end = ancestor closure of the BatchNorms with no BN ancestor (bn0)
    bns = [n for n in model.graph.node if n.op_type == "BatchNormalization"]
    bn_names = {n.name for n in bns}
    frontend: set[str] = set()
    for bn in bns:
        anc = ancestors(bn)
        if not (anc & bn_names):
            frontend |= anc | {bn.name}
    mel_matmuls = [n.name for n in model.graph.node if n.op_type == "MatMul" and n.name in frontend]

    quantize_dynamic(
        str(fp32_path),
        str(path),
        weight_type=QuantType.QUInt8,
        op_types_to_quantize=["MatMul"],
        nodes_to_exclude=mel_matmuls,
    )
    print(f"wrote {path} ({path.stat().st_size / 1e6:.1f} MB)")


def _run_pytorch(model, segment: np.ndarray) -> dict[str, np.ndarray]:
    with torch.no_grad():
        out = model(torch.from_numpy(segment[None, :]))
    return {h: out[KEY_FOR_HEAD[h]].numpy() for h in HEADS}


def _run_onnx(path: Path, segment: np.ndarray) -> dict[str, np.ndarray]:
    import onnxruntime

    sess = onnxruntime.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    outputs = sess.run(HEADS, {"audio": segment[None, :]})
    return dict(zip(HEADS, outputs))


def _note_f1(ref: list, est: list, tol: float = 0.05) -> float:
    matched = 0
    used = set()
    for r in ref:
        for j, e in enumerate(est):
            if j in used:
                continue
            if e["midi_note"] == r["midi_note"] and abs(e["onset_time"] - r["onset_time"]) <= tol:
                matched += 1
                used.add(j)
                break
    precision = matched / len(est) if est else 0.0
    recall = matched / len(ref) if ref else 0.0
    return 2 * precision * recall / (precision + recall) if precision + recall else 0.0


def _events_from_outputs(transcriptor, outputs: dict[str, np.ndarray]) -> list:
    from piano_transcription_inference.utilities import RegressionPostProcessor

    post = RegressionPostProcessor(
        transcriptor.frames_per_second,
        classes_num=transcriptor.classes_num,
        onset_threshold=transcriptor.onset_threshold,
        offset_threshold=transcriptor.offset_threshod,  # upstream typo
        frame_threshold=transcriptor.frame_threshold,
        pedal_offset_threshold=transcriptor.pedal_offset_threshold,
    )
    output_dict = {KEY_FOR_HEAD[h]: outputs[h][0] for h in HEADS}
    note_events, _ = post.output_dict_to_midi_events(output_dict)
    return note_events


def verify(transcriptor, model, out_dir: Path, clip: Path) -> bool:
    from notes_scripter import transcribe as nstranscribe

    audio = nstranscribe.trim_silence(nstranscribe.load_audio(clip))
    segment = np.zeros(SEGMENT_SAMPLES, dtype=np.float32)
    usable = min(len(audio), SEGMENT_SAMPLES)
    segment[:usable] = audio[:usable]

    ref_out = _run_pytorch(model, segment)
    ref_events = _events_from_outputs(transcriptor, ref_out)
    print(f"reference: {len(ref_events)} notes in the first 10 s")

    ok = True
    for name in ["fp32", "fp16", "int8"]:
        path = out_dir / f"bytedance-{name}.onnx"
        if not path.exists():
            continue
        got = _run_onnx(path, segment)
        diff = max(float(np.max(np.abs(got[h] - ref_out[h]))) for h in HEADS)
        f1 = _note_f1(ref_events, _events_from_outputs(transcriptor, got))
        passed = f1 >= 0.98 if name != "fp32" else (f1 >= 0.98 and diff < 5e-3)
        ok &= passed
        print(
            f"{name}: note F1 {f1:.3f} (>= 0.98), max abs diff {diff:.2e} "
            f"{'OK' if passed else 'FAIL'}"
        )
    return ok


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path("web/public/models"))
    parser.add_argument("--verify", type=Path, default=None, help="audio clip for parity check")
    parser.add_argument("--skip-export", action="store_true", help="only run --verify")
    parser.add_argument("--int8", action="store_true", help="also export the int8 variant")
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    transcriptor, model = load_model()

    fp32 = args.out / "bytedance-fp32.onnx"
    if not args.skip_export:
        export_fp32(model, fp32)
        export_fp16(fp32, args.out / "bytedance-fp16.onnx")
        if args.int8:
            export_int8(fp32, args.out / "bytedance-int8.onnx")

    if args.verify:
        if not verify(transcriptor, model, args.out, args.verify):
            sys.exit(1)


if __name__ == "__main__":
    main()
