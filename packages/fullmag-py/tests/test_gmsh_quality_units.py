"""SI conversion contract for quality extracted from scaled Gmsh coordinates."""
from dataclasses import asdict

import pytest

from fullmag.meshing._gmsh_swept import _quality_volumes_in_si
from fullmag.meshing._gmsh_types import MeshQualityReport


def test_scaled_quality_preserves_dimensionless_metrics_and_input():
    original = MeshQualityReport(
        n_elements=2, sicn_min=-0.1, sicn_max=0.9, sicn_mean=0.4,
        sicn_p5=0.1, sicn_histogram=[1, 1], gamma_min=0.2,
        gamma_mean=0.5, gamma_histogram=[1, 1], volume_min=1.0,
        volume_max=3.0, volume_mean=2.0, volume_std=1.0,
        avg_quality=0.6, element_volume=[1.0, 3.0],
        element_sicn=[-0.1, 0.9], element_gamma=[0.2, 0.8],
        element_tags=[17, 21], quality_source="gmsh",
    )
    before = asdict(original)
    converted = _quality_volumes_in_si(original, 1e6)
    assert converted is not original
    assert asdict(original) == before
    for name in ("volume_min", "volume_max", "volume_mean", "volume_std"):
        assert getattr(converted, name) == pytest.approx(before[name] * 1e-18, rel=1e-14, abs=0)
    assert converted.element_volume == pytest.approx([1e-18, 3e-18], rel=1e-14, abs=0)
    dimensional = {"volume_min", "volume_max", "volume_mean", "volume_std", "element_volume"}
    assert {k: v for k, v in asdict(converted).items() if k not in dimensional} == {
        k: v for k, v in before.items() if k not in dimensional
    }


def test_absent_quality_stays_absent():
    assert _quality_volumes_in_si(None, 1e6) is None


def _assert_quality_matches_si_nodes(mesh, *, domains):
    import numpy as np
    assert set(mesh.cell_types.tolist()) == {"tet4"}
    vertices = np.asarray(mesh.nodes)[np.asarray(mesh.cell_nodes).reshape(-1, 4)]
    matrices = np.stack((vertices[:, 1] - vertices[:, 0],
                         vertices[:, 2] - vertices[:, 0],
                         vertices[:, 3] - vertices[:, 0]), axis=1)
    volumes = np.abs(np.linalg.det(matrices)) / 6
    assert volumes.size > 0
    assert mesh.quality is not None
    np.testing.assert_allclose(mesh.quality.element_volume, volumes, rtol=1e-8, atol=0)
    for report, expected in [(mesh.quality, volumes)] + (
        [(report, volumes[np.asarray(mesh.element_markers) == marker])
         for marker, report in mesh.per_domain_quality.items()] if domains else []
    ):
        assert expected.size > 0
        np.testing.assert_allclose(
            [report.volume_min, report.volume_max, report.volume_mean, report.volume_std],
            [expected.min(), expected.max(), expected.mean(), expected.std()],
            rtol=1e-8, atol=0,
        )
    if domains:
        assert mesh.per_domain_quality


@pytest.mark.parametrize("lateral_size", [200e-9, 400e-9])
def test_ring_quality_is_in_cubic_metres(lateral_size):
    import fullmag as fm
    from fullmag.meshing._gmsh_swept import generate_swept_box_cylinder_ring_mesh
    from fullmag.meshing._gmsh_types import AirboxOptions, MeshOptions
    body = fm.Difference(
        base=fm.Box(size=(200e-9, 200e-9, 10e-9), name="film_base"),
        tool=fm.Cylinder(radius=25e-9, height=10e-9, name="hole"),
        name="film",
    )
    mesh = generate_swept_box_cylinder_ring_mesh(
        body, 40e-9, 1,
        options=MeshOptions(compute_quality=True, per_element_quality=True),
        airbox=AirboxOptions(size=(lateral_size, lateral_size, 90e-9), center=(0, 0, 0)),
    )
    _assert_quality_matches_si_nodes(mesh, domains=True)


def test_cylinder_quality_is_not_scaled_twice():
    from fullmag.meshing._gmsh_swept import generate_swept_cylinder_mesh
    from fullmag.meshing._gmsh_types import MeshOptions
    mesh = generate_swept_cylinder_mesh(
        radius=50e-9, height=10e-9, hmax=25e-9, n_layers=1,
        options=MeshOptions(compute_quality=True, per_element_quality=True),
    )
    _assert_quality_matches_si_nodes(mesh, domains=False)
