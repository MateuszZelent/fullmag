"""Checks for the independent Palace CPW input deck without solving."""

import json
from collections import Counter
from hashlib import sha256

import meshio
import numpy as np
import pytest

from rf_cpw_reference import make_case
from rf_palace_preflight import material_boundaries, write_case


def test_all_external_faces_are_unique_and_owned_by_one_port_or_shield():
    case = make_case(cpw=2)
    triangles, tags = material_boundaries(case)
    all_faces = case.tetrahedra[:, ((0, 1, 2), (0, 1, 3), (0, 2, 3), (1, 2, 3))]
    face_counts = Counter(map(tuple, np.sort(all_faces.reshape(-1, 3), axis=1)))
    exterior = {face for face, count in face_counts.items() if count == 1}
    assert len(exterior) == len(triangles)
    assert exterior == set(map(tuple, np.sort(triangles, axis=1)))
    for tag, position in ((101, case.axes_m[0][0]), (102, case.axes_m[0][-1])):
        coordinates = case.points_m[triangles[tags == tag]]
        assert len(coordinates) > 0
        assert np.all(coordinates[:, :, 0] == position)
        # Finite-conductivity Cu reaches both port planes as volume cells.
        assert np.any(np.all((coordinates[:, :, 2] >= 0) & (coordinates[:, :, 2] <= 10e-9), axis=1))
    assert set(tags) == {101, 102, 103}
    coordinates = case.points_m[triangles]
    center = (case.points_m.max(axis=0) + case.points_m.min(axis=0)) / 2
    normals = np.cross(coordinates[:, 1] - coordinates[:, 0], coordinates[:, 2] - coordinates[:, 0])
    assert np.all(np.einsum("ij,ij->i", normals, coordinates.mean(axis=1) - center) > 0)


def test_deck_round_trips_si_geometry_and_preserves_probe_order(tmp_path):
    case = make_case(cpw=1)
    directory = tmp_path / "deck"
    write_case(case, directory, mode=2, sample_step_nm=20)
    mesh = meshio.read(directory / "cpw.msh")
    np.testing.assert_array_equal(mesh.points, case.points_m)
    np.testing.assert_array_equal(mesh.get_cells_type("tetra"), case.tetrahedra)
    np.testing.assert_array_equal(
        mesh.get_cell_data("gmsh:physical", "tetra"), case.material_id + 1
    )
    config = json.loads((directory / "palace.json").read_text())
    assert config["Model"]["L0"] == 1
    assert config["Domains"]["Materials"][1]["Conductivity"] == 5.88e7
    assert config["Solver"]["Driven"]["Samples"][0]["Freq"] == [22.12]
    input_port, output_port = config["Boundaries"]["WavePort"]
    assert input_port["Mode"] == output_port["Mode"] == 2
    assert input_port["Excitation"] == 1
    assert "Excitation" not in output_port
    probes = config["Domains"]["Postprocessing"]["Probe"]
    assert [p["Index"] for p in probes] == list(range(1, 162))
    xyz = np.asarray([p["Center"] for p in probes])
    np.testing.assert_allclose(xyz[:, 0], 0)
    np.testing.assert_allclose(xyz[:, 1], np.linspace(-1600e-9, 1600e-9, 161))
    np.testing.assert_allclose(xyz[:, 2], -7.5e-9)
    manifest = json.loads((directory / "manifest.json").read_text())
    assert manifest["status"] == "inputs_only"
    assert manifest["port_model"] == "shielded_wave_port"
    for name, expected in manifest["sha256"].items():
        assert sha256((directory / name).read_bytes()).hexdigest() == expected
    with pytest.raises(FileExistsError):
        write_case(case, directory, mode=2, sample_step_nm=20)
