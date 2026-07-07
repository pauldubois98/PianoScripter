import sys
from ai_edge_litert.interpreter import Interpreter

for path in sys.argv[1:]:
    print(f"=== {path}")
    it = Interpreter(model_path=path)
    it.allocate_tensors()
    for d in it.get_input_details():
        print("  in :", d["name"], d["shape"], d["dtype"].__name__)
    for d in it.get_output_details():
        print("  out:", d["name"], d["shape"], d["dtype"].__name__)
