from __future__ import annotations

import ast
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
EXAMPLE = ROOT / "examples" / "permalloy_layer_bimeron_prism_single_layer_relax_300nm.py"


def _calls(tree: ast.AST, attribute: str) -> list[ast.Call]:
    return [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == attribute
    ]


def test_bimeron_example_contains_only_one_centered_layer_and_one_prism_layer() -> None:
    tree = ast.parse(EXAMPLE.read_text(encoding="utf-8"), filename=str(EXAMPLE))

    assert len(_calls(tree, "geometry")) == 1
    assert not _calls(tree, "Cylinder")

    bimeron = next(
        call
        for call in _calls(tree, "bimeron")
        if isinstance(call.func.value, ast.Attribute)
        and call.func.value.attr == "texture"
    )
    bimeron_keywords = {keyword.arg: keyword.value for keyword in bimeron.keywords if keyword.arg}
    assert ast.unparse(bimeron_keywords["radius"]) == "BIMERON_RADIUS"
    assert ast.unparse(bimeron_keywords["wall_width"]) == "BIMERON_WALL_WIDTH"
    assert ast.literal_eval(bimeron_keywords["vorticity"]) == 1
    assert ast.literal_eval(bimeron_keywords["background_sign"]) == 1
    assert ast.literal_eval(bimeron_keywords["plane"]) == "xy"

    thin_film = next(
        call
        for call in _calls(tree, "thin_film")
        if isinstance(call.func.value, ast.Attribute)
        and isinstance(call.func.value.value, ast.Name)
        and call.func.value.value.id == "layer"
    )
    mesh_keywords = {keyword.arg: keyword.value for keyword in thin_film.keywords if keyword.arg}
    assert ast.unparse(mesh_keywords["maximum_element_size"]) == "20 * NM"
    assert ast.unparse(mesh_keywords["minimum_element_size"]) == "1.6 * NM"
    assert ast.literal_eval(mesh_keywords["layers"]) == 1
    assert ast.literal_eval(mesh_keywords["topology"]) == "prismatic"
    assert ast.literal_eval(mesh_keywords["exact_layers"]) is True
    assert ast.literal_eval(mesh_keywords["transition"]) == "pyramid_to_tetrahedra"


def test_bimeron_minimization_uses_accepted_step_table_autosave() -> None:
    tree = ast.parse(EXAMPLE.read_text(encoding="utf-8"), filename=str(EXAMPLE))

    table_calls = _calls(tree, "tableautosave")
    assert len(table_calls) == 1
    table_call = table_calls[0]
    assert isinstance(table_call.func.value, ast.Call)
    assert isinstance(table_call.func.value.func, ast.Attribute)
    assert table_call.func.value.func.attr == "add_relax"
    table_keywords = {keyword.arg: keyword.value for keyword in table_call.keywords if keyword.arg}
    assert ast.literal_eval(table_keywords["every_steps"]) == 1
    assert not any(
        isinstance(call.func.value, ast.Name) and call.func.value.id == "study"
        for call in table_calls
    )
