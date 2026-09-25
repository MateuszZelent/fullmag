import copy
import pytest
from comsol_magnetic_support import magnetic_element_indices, tet4_cells


def fixture():
    mesh = {"cells": {"types": ["tet4"] * 3, "offsets": [0, 4, 8, 12], "nodes": [0, 1, 2, 3] * 3}, "element_markers": [7, 0, 7]}
    parts = [
        {"id": "film", "role": "magnetic_object", "element_selector": {"kind": "element_marker_set", "markers": [7]}},
        {"id": "air", "role": "air", "element_selector": {"kind": "element_range", "start": 1, "count": 1}},
    ]
    return mesh, parts


def test_explicit_marker_partition_and_range_agree():
    mesh, parts = fixture()
    assert magnetic_element_indices(mesh, parts) == [0, 2]
    parts[0]["element_selector"] = {"kind": "element_marker_set", "markers": [0]}
    parts[1]["element_selector"] = {"kind": "element_marker_set", "markers": [7]}
    assert magnetic_element_indices(mesh, parts) == [1]  # Marker zero is not intrinsically air.


@pytest.mark.parametrize("defect", ["missing", "overlap", "same_role_overlap", "bool", "outside", "unknown", "absent_marker", "duplicate_marker", "duplicate_id", "no_magnet", "missing_markers"])
def test_ambiguous_support_is_rejected(defect):
    mesh, parts = fixture()
    if defect == "missing": parts.pop()
    elif defect == "overlap": parts[1]["element_selector"]["start"] = 0
    elif defect == "same_role_overlap":
        extra = copy.deepcopy(parts[0]); extra["id"] = "other"; parts.append(extra)
    elif defect == "bool": parts[1]["element_selector"]["start"] = True
    elif defect == "outside": parts[1]["element_selector"]["count"] = 10
    elif defect == "unknown": parts[1]["role"] = "vacuum"
    elif defect == "absent_marker": parts[0]["element_selector"]["markers"] = [8]
    elif defect == "duplicate_marker": parts[0]["element_selector"]["markers"] = [7, 7]
    elif defect == "duplicate_id": parts[1]["id"] = "film"
    elif defect == "no_magnet": parts[0]["role"] = "air"
    elif defect == "missing_markers": mesh.pop("element_markers")
    with pytest.raises(ValueError): magnetic_element_indices(mesh, parts)


def test_surface_selectors_do_not_add_volume():
    mesh, parts = fixture()
    parts.append({"role": "interface", "element_selector": {"kind": "boundary_face_range", "start": 0, "count": 999}})
    assert magnetic_element_indices(mesh, parts) == [0, 2]


@pytest.mark.parametrize("field,value", [("types", ["hex8"] * 3), ("offsets", [0, 4, 9, 12]), ("nodes", [False] * 12)])
def test_malformed_native_connectivity_rejected(field, value):
    mesh, parts = fixture()
    mesh["cells"][field] = value
    with pytest.raises(ValueError): magnetic_element_indices(mesh, parts)


def test_native_tet4_decoding_preserves_element_order():
    mesh, _ = fixture()
    mesh["cells"]["nodes"] = list(range(12))
    assert tet4_cells(mesh) == [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11]]
