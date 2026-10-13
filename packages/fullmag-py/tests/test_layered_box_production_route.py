"""Actual Gmsh proof for scoped Box caps in the production shared-domain route."""
from __future__ import annotations

import numpy as np
import pytest

from fullmag.model.geometry import Box
from fullmag.meshing._gmsh_swept import generate_swept_tetrahedral_box_airbox_mesh
from fullmag.meshing._gmsh_types import AirboxOptions, MeshOptions


def test_scoped_box_production_route_recertifies_final_periodic_si_mesh() -> None:
    pytest.importorskip("gmsh")
    body = Box(120e-9, 80e-9, 20e-9, name="periodic-film")
    scoped_field = {
        "kind": "ComponentRestrictedBox",
        "params": {
            "GeometryName": body.geometry_name,
            "VIn": 8e-9, "VOut": 20e-9,
            "XMin": -15e-9, "XMax": 15e-9,
            "YMin": -15e-9, "YMax": 15e-9,
            "ZMin": -4e-9, "ZMax": 4e-9,
        },
    }
    mesh = generate_swept_tetrahedral_box_airbox_mesh(
        body, 20e-9, 2, order=1, distribution="fixed", recombine=False,
        airbox=AirboxOptions(
            size=(120e-9, 80e-9, 40e-9), minimum_element_size=10e-9,
            maximum_element_size=20e-9, grading_mode="geometric", boundary_marker=99,
        ),
        options=MeshOptions(
            size_fields=[scoped_field], periodic_pair_ids=["x_faces", "y_faces"],
            compute_quality=True, per_element_quality=True,
        ),
    )
    assert scoped_field["_gmsh_status"] == "applied"
    assert set(mesh.cell_types) == {"tet4"}
    assert set(mesh.facet_types) == {"tri3"}
    assert set(mesh.element_markers) == {0, 1}
    assert mesh.realization_report is not None
    assert mesh.realization_report.requested_topology == "tet4"
    assert mesh.realization_report.resolved_topology == "tet4"
    assert mesh.realization_report.resolved_layers == len(np.unique(mesh.nodes[:, 2])) - 1
    assert mesh.realization_report.requested_layers == mesh.realization_report.resolved_layers
    assert mesh.periodic_mesh_certificate is not None
    assert mesh.periodic_mesh_certificate["certificate_status"] == "accepted"
    assert {row["pair_id"] for row in mesh.periodic_boundary_pairs} == {"x_faces", "y_faces"}
    assert len(mesh.periodic_node_pairs) > 0
    assert mesh.quality is not None and mesh.per_domain_quality is not None
    assert set(mesh.per_domain_quality) == {0, 1}
    assert mesh.quality.n_elements == mesh.n_elements
    assert len(mesh.quality.element_volume) == mesh.n_elements
    assert len(mesh.quality.element_sicn) == mesh.n_elements
    assert len(mesh.quality.element_gamma) == mesh.n_elements
    # Volume alignment detects stale extraction or a second conversion of SI.
    points = mesh.nodes[mesh.elements]
    volumes = np.einsum(
        "ij,ij->i", points[:, 1] - points[:, 0],
        np.cross(points[:, 2] - points[:, 0], points[:, 3] - points[:, 0]),
    ) / 6.0
    assert np.all(volumes > 0.0)
    np.testing.assert_allclose(mesh.quality.element_volume, volumes, rtol=1e-12, atol=0.0)
    np.testing.assert_allclose(sum(volumes), 120e-9 * 80e-9 * 40e-9, rtol=1e-12, atol=0.0)
    magnetic = mesh.element_markers == 1
    np.testing.assert_allclose(sum(volumes[magnetic]), 120e-9 * 80e-9 * 20e-9, rtol=1e-12, atol=0.0)
    used_magnetic_nodes = np.unique(mesh.elements[magnetic])
    z_values = mesh.nodes[used_magnetic_nodes, 2]
    expected_planes = np.asarray([-10e-9, 0.0, 10e-9])
    assert np.all(np.min(np.abs(z_values[:, None] - expected_planes), axis=1) < 1e-15)
    assert all(np.any(np.abs(z_values - plane) < 1e-15) for plane in expected_planes)


@pytest.mark.parametrize("override, expected", [
    ({"algorithm_3d": 10}, "algorithm_3d"),
    ({"optimize": "Netgen"}, "optimizer"),
    ({"boundary_layer_count": 1}, "boundary layers"),
])
def test_scoped_box_rejects_unexecuted_options_before_gmsh(monkeypatch, override, expected) -> None:
    from fullmag.meshing import _gmsh_swept
    body = Box(120e-9, 80e-9, 20e-9, name="guarded-film")
    field = {"kind": "ComponentRestrictedBox", "params": {"GeometryName": body.geometry_name}}
    def unexpected_gmsh_import():
        raise AssertionError("unsupported intent must be rejected before entering Gmsh")
    monkeypatch.setattr(_gmsh_swept, "_import_gmsh", unexpected_gmsh_import)
    with pytest.raises(ValueError, match=expected):
        generate_swept_tetrahedral_box_airbox_mesh(
            body, 20e-9, 2, order=1, distribution="fixed", recombine=False,
            airbox=AirboxOptions(size=(120e-9, 80e-9, 40e-9)),
            options=MeshOptions(size_fields=[field], **override),
        )


def test_scoped_box_public_de_smoke_materializes_exact_caps(monkeypatch) -> None:
    """The 4.01 um airbox exposes mixed cap z values hidden by a short box."""
    from pathlib import Path
    import fullmag as fm
    pytest.importorskip("gmsh")
    monkeypatch.setenv("FULLMAG_DE_SMOKE_SAMPLING", "k10")
    monkeypatch.setenv("FULLMAG_DE_SMOKE_MODAL_TARGET", "nearest")
    monkeypatch.setenv("FULLMAG_DE_SMOKE_TARGET_FREQUENCY_GHZ", "12.0")
    script = Path(__file__).resolve().parents[3] / "examples/fem_de_smoke_numeric.py"
    fm.reset()
    try:
        loaded = fm.load_problem_from_script(script, lightweight_assets=False)
        runtime = loaded.problem.runtime
        ir = loaded.to_ir(
            requested_backend=runtime.backend_target,
            execution_mode=runtime.execution_mode,
            execution_precision=runtime.execution_precision,
            _copy_cached_geometry_assets=False,
        )
        mesh = ir["geometry_assets"]["fem_domain_mesh_asset"]["mesh"]
        assert len(mesh["nodes"]) > 0
        assert set(mesh["cells"]["types"]) == {"tet4"}
        assert len(mesh["periodic_node_pairs"]) > 0
    finally:
        fm.reset()
