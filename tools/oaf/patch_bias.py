"""Fix tf2onnx's dropped FULLY_CONNECTED biases in the converted O&F model.

For every TFLite FULLY_CONNECTED op, locate the ONNX node producing the same
output tensor name; if it's a bias-less MatMul, insert Add(bias) after it,
with bias values read from the TFLite file.
"""

import sys

import numpy as np
import onnx
from onnx import helper, numpy_helper
from ai_edge_litert.interpreter import Interpreter

tflite_path, onnx_in, onnx_out = sys.argv[1], sys.argv[2], sys.argv[3]

it = Interpreter(model_path=tflite_path)
it.allocate_tensors()
tnames = {d["index"]: d["name"] for d in it.get_tensor_details()}
fc_ops = []  # (output_name, bias_array)
for op in it._get_ops_details():
    if op["op_name"] == "FULLY_CONNECTED" and len(op["inputs"]) == 3 and op["inputs"][2] != -1:
        out_name = tnames[op["outputs"][0]]
        bias = it.get_tensor(op["inputs"][2])
        fc_ops.append((out_name, np.asarray(bias, dtype=np.float32)))
print(f"tflite FULLY_CONNECTED ops with bias: {len(fc_ops)}")

m = onnx.load(onnx_in)
g = m.graph
producer = {o: n for n in g.node for o in n.output}
init_names = {i.name for i in g.initializer}

patched = skipped_gemm = missing = 0
new_inits = []
for out_name, bias in fc_ops:
    n = producer.get(out_name)
    if n is None:
        missing += 1
        print("  no ONNX node for:", out_name)
        continue
    if n.op_type == "Gemm" and len(n.input) == 3:
        skipped_gemm += 1
        continue
    if n.op_type != "MatMul":
        print(f"  unexpected op {n.op_type} for {out_name}")
        continue
    # rename matmul output, add bias Add producing the original name
    raw = out_name + "__nobias"
    n.output[0] = raw
    bname = out_name + "__bias"
    if bname not in init_names:
        new_inits.append(numpy_helper.from_array(bias, bname))
        init_names.add(bname)
    add = helper.make_node("Add", [raw, bname], [out_name], name=out_name + "__bias_add")
    # insert right after the matmul to keep topological order
    idx = list(g.node).index(n)
    g.node.insert(idx + 1, add)
    patched += 1

g.initializer.extend(new_inits)
onnx.checker.check_model(m, full_check=False)
onnx.save(m, onnx_out)
print(f"patched: {patched}, gemm-with-bias skipped: {skipped_gemm}, missing: {missing}")
print("saved", onnx_out)
