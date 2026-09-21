import copy
import pytest
from comsol_mesh_identity import (
    mesh_topology_fingerprint_v2,
    mesh_topology_fingerprint_v3,
    _ordered_bytes,
)


def fixture():
    # Frozen cross-language case in fullmag-ir mesh_hints.rs and MeshData tests.
    return {"nodes":[[0.,0.,0.],[1.,0.,0.],[0.,1.,0.],[0.,0.,1.]],
            "cells":{"types":["tet4"],"offsets":[0,4],"nodes":[0,1,2,3],"global_ordinals":[0],"mesh_parts":["magnetic"]},
            "element_markers":[1],"facets":{"types":[],"roles":[],"offsets":[0],"nodes":[],"global_ordinals":[]},
            "boundary_markers":[],"periodic_boundary_pairs":[],"periodic_node_pairs":[]}


def test_matches_frozen_rust_and_python_mesh_identity():
    assert mesh_topology_fingerprint_v2(fixture()) == "sha256:2071f6b9a2bf468fc82296f34744b07475315a5f0d26c5b06e52b54064f474e2"


def test_v3_matches_frozen_rust_cross_language_fixture():
    mesh = {
        "nodes": [[0.0, -0.0, 1.0e-7], [1.0e-5, 3.0e-9, 1.0e20],
                  [float.fromhex("0x1.5555555555555p-2"), 1.0, 2.0]]
                 + [[float(index), 0.0, 0.0] for index in range(3, 23)],
        "cells": {
            "types": ["tet4", "prism6", "pyramid5", "hex8"],
            "offsets": [0, 4, 10, 15, 23],
            "nodes": list(range(23)),
            "global_ordinals": [9, 8, 7, 6],
            "mesh_parts": ["magnetic", "transition_air", "far_air", "magnetic"],
        },
        "element_markers": [1, 0, 0, 4],
        "facets": {
            "types": ["tri3", "quad4", "tri3"],
            "roles": ["exterior", "material_interface", "periodic_seam"],
            "offsets": [0, 3, 7, 10],
            "nodes": list(range(10)),
            "global_ordinals": [3, 2, 1],
        },
        "boundary_markers": [2, 3, 4],
        "periodic_boundary_pairs": [
            {
                "pair_id": "",
                "source_marker": None,
                "destination_marker": "",
                "marker_a": 2,
                "marker_b": 3,
                "translation": [1.0e-7, -0.0, 1.0e20],
                "tolerance": 3.0e-9,
                "axis_hint": "é",
                "orientation": "prefix",
                "pairing_policy": "prefix-long",
            },
            {
                "pair_id": "é",
                "source_marker": "a",
                "destination_marker": "ab",
                "marker_a": 4,
                "marker_b": 5,
                "translation": None,
                "tolerance": None,
                "axis_hint": "",
                "orientation": None,
                "pairing_policy": "",
            },
        ],
        "periodic_node_pairs": [
            {"pair_id": "", "node_a": 0, "node_b": 1},
            {"pair_id": "é", "node_a": 2, "node_b": 3},
        ],
    }
    assert mesh_topology_fingerprint_v3(mesh) == "sha256:5728d7f6f11efc6f3d4ce4c5b098e3ea76866fd49a31088cf6692652d22c0ff6"


def test_v3_preserves_signed_zero_and_rejects_nonfinite_values():
    mesh = fixture()
    negative_zero = copy.deepcopy(mesh)
    negative_zero["nodes"][0][1] = -0.0
    baseline = mesh_topology_fingerprint_v3(negative_zero)
    positive_zero = copy.deepcopy(negative_zero)
    positive_zero["nodes"][0][1] = 0.0
    assert mesh_topology_fingerprint_v3(positive_zero) != baseline
    nonfinite = copy.deepcopy(mesh)
    nonfinite["periodic_boundary_pairs"] = [
        {"pair_id": "x", "marker_a": 1, "marker_b": 2, "tolerance": float("inf")}
    ]
    with pytest.raises(ValueError, match="finite"):
        mesh_topology_fingerprint_v3(nonfinite)


def test_v3_rejects_role_aliases_outside_the_rust_typed_contract():
    mesh = fixture()
    mesh["cells"]["mesh_parts"] = ["magnetic_object"]
    with pytest.raises(ValueError, match="unsupported enum"):
        mesh_topology_fingerprint_v3(mesh)


def test_input_dictionary_order_does_not_change_typed_identity():
    mesh=fixture(); reverse=dict(reversed(list(mesh.items())))
    reverse["cells"]=dict(reversed(list(mesh["cells"].items())))
    assert mesh_topology_fingerprint_v2(mesh)==mesh_topology_fingerprint_v2(reverse)


def test_nanometer_float_encoding_uses_serde_exponents():
    assert _ordered_bytes({"z":1e-7,"a":1e-5}) == b'{"z":1e-7,"a":0.00001}'


@pytest.mark.parametrize("key",["nodes","cells","facets","periodic_node_pairs"])
def test_missing_topology_is_not_filled_from_defaults(key):
    mesh=fixture();mesh.pop(key)
    with pytest.raises(ValueError):mesh_topology_fingerprint_v2(mesh)


def test_geometry_change_invalidates_identity():
    mesh=fixture();other=copy.deepcopy(mesh);other["nodes"][1][0]=1.0001
    assert mesh_topology_fingerprint_v2(mesh)!=mesh_topology_fingerprint_v2(other)


@pytest.mark.parametrize("value", [float("nan"), float("inf"), -float("inf")])
def test_nonfinite_periodic_tolerance_is_rejected(value):
    mesh = fixture()
    mesh["periodic_boundary_pairs"] = [{"pair_id": "x", "marker_a": 1, "marker_b": 2, "tolerance": value}]
    with pytest.raises(ValueError, match="finite"):
        mesh_topology_fingerprint_v2(mesh)


def test_legacy_tolerance_alias_is_not_silently_ignored():
    mesh = fixture()
    mesh["periodic_boundary_pairs"] = [{"pair_id": "x", "marker_a": 1, "marker_b": 2, "tolerance_m": 1e-12}]
    with pytest.raises(ValueError, match="tolerance_m"):
        mesh_topology_fingerprint_v2(mesh)


@pytest.mark.parametrize("ordinals", [[], [False], [-1], [0.0], [0, 1]])
def test_noncanonical_ordinals_are_rejected(ordinals):
    mesh = fixture()
    mesh["cells"]["global_ordinals"] = ordinals
    with pytest.raises(ValueError, match="global_ordinals"):
        mesh_topology_fingerprint_v2(mesh)


def test_optional_none_and_pair_key_order_follow_typed_encoding():
    mesh = fixture()
    pair = {"pair_id": "x", "marker_a": 1, "marker_b": 2, "translation": [1e-7, 0., 0.], "tolerance": 1e-12}
    mesh["periodic_boundary_pairs"] = [pair]
    other = copy.deepcopy(mesh)
    other["periodic_boundary_pairs"] = [dict(reversed(list(pair.items())), source_marker=None, axis_hint=None)]
    assert mesh_topology_fingerprint_v2(mesh) == mesh_topology_fingerprint_v2(other)


@pytest.mark.parametrize("value, expected", [
    (1e-6, b"1e-6"), (1e-5, b"0.00001"),
    (1e15, b"1000000000000000.0"), (1e16, b"1e+16"),
    (1e20, b"1e+20"), (-0.0, b"-0.0"),
])
def test_float_notation_boundaries_match_pinned_zmij_policy(value, expected):
    # zmij 1.0.21 lib.rs: f64 uses fixed notation for exponents -5..=15.
    # These assert its documented source policy, not an executed Rust fixture.
    assert _ordered_bytes(value) == expected
