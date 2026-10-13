"""Derive the nonmagnetic variant of the pinned scientific inspection fixture."""
import ast


SCRIPT_NAME = "fem_antenna_standalone_inspection.py"


def standalone_source(source):
    tree = ast.parse(source)
    removed, changed, solves = set(), 0, 0
    body = []
    for node in tree.body:
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
            function = node.value.func
            if isinstance(function, ast.Attribute) and function.attr == "add_antenna_field_solve":
                solves += 1
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target = node.targets[0]
            if isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name) and target.value.id == "probe":
                if target.attr not in {"Ms", "Aex", "alpha", "m"} or target.attr in removed:
                    raise ValueError("Unexpected probe physics in pinned fixture")
                removed.add(target.attr)
                continue
            if isinstance(target, ast.Name) and target.id == "probe":
                call = node.value
                if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Attribute) or call.func.attr != "geometry":
                    raise ValueError("Unexpected probe constructor in pinned fixture")
                call.func.attr = "geometry_object"
                call.keywords.append(ast.keyword(arg="type", value=ast.Constant(value="geometry")))
                changed += 1
        body.append(node)
    if removed != {"Ms", "Aex", "alpha", "m"} or changed != 1 or solves != 1:
        raise ValueError("Standalone fixture must remove exactly the magnetic probe state")
    tree.body = body
    tree.body[0] = ast.Expr(value=ast.Constant(value=(
        "Standalone V/RT0/H inspection without magnets, dynamics, Relax or Run. "
        "Derived from the pinned external-lead fixture; not closed-circuit, RF, "
        "per-ampere basis, LLG or FFT qualification."
    )))
    return (ast.unparse(ast.fix_missing_locations(tree)) + "\n").encode("utf-8")
