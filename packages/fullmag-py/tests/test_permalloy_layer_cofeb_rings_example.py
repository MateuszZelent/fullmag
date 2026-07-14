
from __future__ import annotations

import ast
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
EXAMPLE = ROOT / "examples" / "permalloy_layer_cofeb_rings_relax_300nm.py"


def _call_keywords(tree: ast.AST, attribute: str) -> list[dict[str, ast.expr]]:
    matches: list[dict[str, ast.expr]] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            continue
        if node.func.attr == attribute:
            matches.append({keyword.arg: keyword.value for keyword in node.keywords if keyword.arg})
    return matches


def test_thin_permalloy_layer_uses_hxt_with_gmsh_optimizer_and_single_swept_prism_layer() -> None:
    tree = ast.parse(EXAMPLE.read_text(encoding="utf-8"), filename=str(EXAMPLE))

    mesh_defaults = next(
        keywords
        for keywords in _call_keywords(tree, "defaults")
        if "algorithm_3d" in keywords
    )
    assert ast.literal_eval(mesh_defaults["algorithm_3d"]) == 10
    assert ast.literal_eval(mesh_defaults["smoothing_steps"]) == 4
    assert ast.literal_eval(mesh_defaults["optimize"]) == "Gmsh"
    assert ast.literal_eval(mesh_defaults["optimize_iterations"]) == 4

    layer_mesh = next(
        keywords
        for keywords in _call_keywords(tree, "mesh")
        if "mesh_strategy" in keywords
        and ast.literal_eval(keywords["mesh_strategy"]) == "swept_prism"
    )
    assert ast.literal_eval(layer_mesh["maximum_element_size"].left) == 20
    assert ast.literal_eval(layer_mesh["minimum_element_size"].left) == 1.6
    assert ast.literal_eval(layer_mesh["mesh_strategy"]) == "swept_prism"
    assert ast.literal_eval(layer_mesh["through_thickness_elements"]) == 1
    assert ast.literal_eval(layer_mesh["through_thickness_distribution"]) == "fixed"
    assert ast.literal_eval(layer_mesh["sweep_face_meshing"]) == "triangular"
