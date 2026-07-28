from __future__ import annotations

import importlib
import json
from collections import Counter
from pathlib import Path
from unittest.mock import Mock

import numpy as np
import pytest

import fullmag as fm
import fullmag.meshing._gmsh_generators as gmsh_generators
import fullmag.meshing._gmsh_types as gmsh_types
from fullmag.meshing._gmsh_extraction import (
    _GMSH_TO_FULLMAG_NODE_PERMUTATION,
    _extract_mesh_data,
)
from fullmag.meshing._gmsh_types import MeshData, MeshOptions, _cell_jacobian_determinants
from fullmag.meshing._gmsh_swept import (
    SWEEP_STRATEGY_PRISM,
    _extract_swept_mesh_data,
    generate_swept_box_mesh,
    generate_swept_cylinder_mesh,
    generate_swept_mesh,
)


FIXTURE = Path(__file__).parent / "fixtures" / "gmsh" / "mixed_prism_pyramid_airbox.geo"

CELL_FACES = {
    "Tetrahedron 4": ((0, 2, 1), (0, 1, 3), (1, 2, 3), (2, 0, 3)),
    "Prism 6": (
        (0, 2, 1),
        (3, 4, 5),
        (0, 1, 4, 3),
        (1, 2, 5, 4),
        (2, 0, 3, 5),
    ),
    "Pyramid 5": (
        (0, 3, 2, 1),
        (0, 1, 4),
        (1, 2, 4),
        (2, 3, 4),
        (3, 0, 4),
    ),
}


def test_gmsh_prism6_node_order_has_an_explicit_canonical_permutation() -> None:
    assert _GMSH_TO_FULLMAG_NODE_PERMUTATION[6] == (0, 1, 2, 3, 4, 5)


def _physical_entities(gmsh, *, dim: int, name: str) -> list[int]:
    for group_dim, group_tag in gmsh.model.getPhysicalGroups(dim):
        if gmsh.model.getPhysicalName(group_dim, group_tag) == name:
            return list(gmsh.model.getEntitiesForPhysicalGroup(group_dim, group_tag))
    raise AssertionError(f"missing physical group {name!r}")


def _elements(gmsh, *, dim: int, entities: list[int]):
    for entity in entities:
        element_types, element_tags, node_tags = gmsh.model.mesh.getElements(dim, entity)
        for element_type, tags, flat_nodes in zip(element_types, element_tags, node_tags):
            name, _, _, node_count, _, _ = gmsh.model.mesh.getElementProperties(
                element_type
            )
            for index, element_tag in enumerate(tags):
                start = index * node_count
                stop = start + node_count
                yield name, int(element_tag), tuple(int(tag) for tag in flat_nodes[start:stop])


def _faces(cells):
    for domain, cell_name, element_tag, nodes in cells:
        for local_face in CELL_FACES[cell_name]:
            yield tuple(sorted(nodes[index] for index in local_face)), (domain, element_tag)


def test_gmsh_feasibility_freezes_mixed_p1_topology(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert FIXTURE.is_file(), f"missing frozen Gmsh feasibility fixture: {FIXTURE}"

    gmsh = pytest.importorskip("gmsh")
    version = getattr(gmsh, "__version__", "unknown")
    assert version == "4.15.2", (
        f"mixed-P1 fixture requires Gmsh 4.15.2; detected {version}"
    )

    splitter_module = importlib.import_module("fullmag.meshing._gmsh_swept")
    prism_splitter = Mock(
        side_effect=AssertionError("feasibility fixture called production tet splitter")
    )
    monkeypatch.setattr(splitter_module, "_split_prism_to_tets", prism_splitter)

    gmsh.initialize()
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.open(str(FIXTURE))

        film_entities = _physical_entities(gmsh, dim=3, name="film")
        air_entities = _physical_entities(gmsh, dim=3, name="air")
        film_cells = [
            ("film", *cell)
            for cell in _elements(gmsh, dim=3, entities=film_entities)
        ]
        air_cells = [
            ("air", *cell)
            for cell in _elements(gmsh, dim=3, entities=air_entities)
        ]
        cells = film_cells + air_cells

        diagnostics = (
            f"Gmsh {version}; film={Counter(cell[1] for cell in film_cells)}; "
            f"air={Counter(cell[1] for cell in air_cells)}"
        )
        assert {cell[1] for cell in film_cells} == {"Prism 6"}, diagnostics
        assert {cell[1] for cell in air_cells} == {
            "Pyramid 5",
            "Tetrahedron 4",
        }, diagnostics
        assert not {"Pyramid 5", "Tetrahedron 4"}.intersection(
            cell[1] for cell in film_cells
        ), diagnostics

        film_node_tags = sorted({node for _, _, _, nodes in film_cells for node in nodes})
        grouped_film_node_tags, film_coordinates = (
            gmsh.model.mesh.getNodesForPhysicalGroup(
                3,
                next(
                    tag
                    for dim, tag in gmsh.model.getPhysicalGroups(3)
                    if gmsh.model.getPhysicalName(dim, tag) == "film"
                ),
            )
        )
        z_coordinates = sorted(float(value) for value in film_coordinates[2::3])
        film_thickness = max(z_coordinates) - min(z_coordinates)
        plane_tolerance = max(1e-15, 1e-8 * film_thickness)
        planes: list[float] = []
        for z_coordinate in z_coordinates:
            if not planes or abs(z_coordinate - planes[-1]) > plane_tolerance:
                planes.append(z_coordinate)
        assert film_node_tags == sorted(
            int(tag) for tag in grouped_film_node_tags
        ), diagnostics
        assert len(film_node_tags) == len(z_coordinates), diagnostics
        assert len(planes) == 2, f"{diagnostics}; film normal-coordinate planes={planes}"

        top_bottom = list(
            _elements(
                gmsh,
                dim=2,
                entities=_physical_entities(gmsh, dim=2, name="film_top_bottom"),
            )
        )
        lateral = list(
            _elements(
                gmsh,
                dim=2,
                entities=_physical_entities(gmsh, dim=2, name="film_lateral"),
            )
        )
        airbox_outer = list(
            _elements(
                gmsh,
                dim=2,
                entities=_physical_entities(gmsh, dim=2, name="airbox_outer"),
            )
        )
        assert {face[0] for face in top_bottom} == {"Triangle 3"}, diagnostics
        assert {face[0] for face in lateral} == {"Quadrilateral 4"}, diagnostics
        film_boundary_faces = {tuple(sorted(face[2])) for face in top_bottom + lateral}
        film_lateral_faces = {tuple(sorted(face[2])) for face in lateral}
        outer_airbox_faces = {tuple(sorted(face[2])) for face in airbox_outer}

        pyramid_bases = {
            tuple(
                sorted(
                    nodes[index]
                    for index in CELL_FACES["Pyramid 5"][0]
                )
            )
            for _, cell_name, _, nodes in air_cells
            if cell_name == "Pyramid 5"
        }
        assert pyramid_bases and pyramid_bases.issubset(film_lateral_faces), (
            f"{diagnostics}; air pyramids escaped the quad transition"
        )

        far_air_tets = [
            nodes
            for _, cell_name, _, nodes in air_cells
            if cell_name == "Tetrahedron 4"
            and all(
                tuple(sorted(nodes[index] for index in local_face))
                not in film_boundary_faces
                for local_face in CELL_FACES["Tetrahedron 4"]
            )
        ]
        assert far_air_tets, f"{diagnostics}; missing far-air tetrahedra"

        face_owners: dict[tuple[int, ...], list[tuple[str, int]]] = {}
        for face, owner in _faces(cells):
            face_owners.setdefault(face, []).append(owner)
        owner_counts = Counter(len(owners) for owners in face_owners.values())
        assert set(owner_counts).issubset({1, 2}), f"{diagnostics}; owner_counts={owner_counts}"

        explicit_faces = [
            tuple(sorted(nodes))
            for _, _, nodes in _elements(
                gmsh,
                dim=2,
                entities=[tag for _, tag in gmsh.model.getEntities(2)],
            )
        ]
        assert len(explicit_faces) == len(set(explicit_faces)), (
            f"{diagnostics}; duplicate explicit faces detected"
        )
        assert all(face in face_owners for face in explicit_faces), (
            f"{diagnostics}; orphan explicit face detected"
        )
        one_owner_faces = {
            face for face, owners in face_owners.items() if len(owners) == 1
        }
        assert one_owner_faces == outer_airbox_faces, (
            f"{diagnostics}; one-owner faces differ from named outer airbox; "
            f"unexpected={one_owner_faces - outer_airbox_faces}; "
            f"missing={outer_airbox_faces - one_owner_faces}"
        )

        assert film_boundary_faces, f"{diagnostics}; missing film boundary facets"
        assert all(
            len(face_owners.get(face, ())) == 2
            and {domain for domain, _ in face_owners[face]} == {"film", "air"}
            for face in film_boundary_faces
        ), f"{diagnostics}; film is not fully enclosed by conforming air"

        extracted = _extract_mesh_data(gmsh, has_physical_groups=True)
        extracted_node_tags, _, _ = gmsh.model.mesh.getNodes()
        extracted_node_index = {
            int(tag): index for index, tag in enumerate(extracted_node_tags)
        }
        film_boundary_face_indices = {
            tuple(sorted(extracted_node_index[node] for node in face))
            for face in film_boundary_faces
        }
        outer_airbox_face_indices = {
            tuple(sorted(extracted_node_index[node] for node in face))
            for face in outer_airbox_faces
        }
        roles_by_nodes = {
            tuple(sorted(int(node) for node in extracted.facet_node_ids(index))): str(role)
            for index, role in enumerate(extracted.facet_roles)
        }
        assert all(
            roles_by_nodes[face] == "material_interface"
            for face in film_boundary_face_indices
        )
        assert all(roles_by_nodes[face] == "exterior" for face in outer_airbox_face_indices)
        prism_splitter.assert_not_called()
    finally:
        gmsh.finalize()


@pytest.mark.parametrize(("layers", "expected_planes"), [(1, 2), (2, 3), (3, 4)])
def test_body_only_box_prism_mesh_has_exact_requested_layers(
    layers: int,
    expected_planes: int,
) -> None:
    gmsh = pytest.importorskip("gmsh")
    assert getattr(gmsh, "__version__", "unknown") == "4.15.2"

    mesh = generate_swept_box_mesh(
        (8.0e-9, 5.0e-9, 3.0e-9),
        hmax=2.0e-9,
        n_layers=layers,
        thin_axis=2,
        order=1,
        recombine=True,
    )

    assert set(mesh.cell_types.tolist()) == {"prism6"}
    tolerance = max(1.0e-15, 1.0e-8 * 3.0e-9)
    planes: list[float] = []
    for coordinate in sorted(float(value) for value in mesh.nodes[:, 2]):
        if not planes or abs(coordinate - planes[-1]) > tolerance:
            planes.append(coordinate)
    assert len(planes) == expected_planes
    mesh.validate_strict()


@pytest.mark.parametrize("axis", [0, 1, 2])
def test_body_only_box_prism_mesh_honours_explicit_sweep_axis(axis: int) -> None:
    pytest.importorskip("gmsh")
    size = [9.0e-9, 7.0e-9, 5.0e-9]
    mesh = generate_swept_box_mesh(
        tuple(size),
        hmax=2.0e-9,
        n_layers=1,
        thin_axis=axis,
        order=1,
        recombine=True,
    )

    tolerance = max(1.0e-15, 1.0e-8 * size[axis])
    planes: list[float] = []
    for coordinate in sorted(float(value) for value in mesh.nodes[:, axis]):
        if not planes or abs(coordinate - planes[-1]) > tolerance:
            planes.append(coordinate)
    assert len(planes) == 2
    assert np.isclose(planes[0], -size[axis] / 2.0, atol=tolerance)
    assert np.isclose(planes[1], size[axis] / 2.0, atol=tolerance)
    assert set(mesh.cell_types.tolist()) == {"prism6"}
    mesh.validate_strict()


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"n_layers": 0}, "n_layers must be >= 1"),
        ({"n_layers": 1, "order": 2}, "order=1"),
        ({"n_layers": 1, "thin_axis": 3}, "thin_axis"),
        ({"n_layers": 1, "distribution": "linear"}, "fixed distribution"),
    ],
)
def test_body_only_box_prism_mesh_rejects_unsupported_request(
    kwargs: dict[str, object],
    message: str,
) -> None:
    with pytest.raises((TypeError, ValueError), match=message):
        generate_swept_box_mesh(
            (8.0e-9, 5.0e-9, 3.0e-9),
            hmax=2.0e-9,
            **kwargs,
        )


def test_explicit_prism_strategy_rejects_non_box_geometry() -> None:
    opts = fm.meshing.MeshOptions(mesh_strategy=SWEEP_STRATEGY_PRISM)
    geometry = fm.Cylinder(radius=4.0e-9, height=2.0e-9)

    with pytest.raises(TypeError, match="supports only axis-aligned Box"):
        generate_swept_mesh(
            geometry,
            hmax=2.0e-9,
            n_layers=1,
            order=1,
            options=opts,
        )


def test_body_only_box_prism_path_never_calls_prism_splitter(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("gmsh")
    swept_module = importlib.import_module("fullmag.meshing._gmsh_swept")
    splitter = Mock(side_effect=AssertionError("prism splitter called"))
    monkeypatch.setattr(swept_module, "_split_prism_to_tets", splitter)

    mesh = generate_swept_box_mesh(
        (8.0e-9, 5.0e-9, 3.0e-9),
        hmax=2.0e-9,
        n_layers=1,
        order=1,
        recombine=True,
    )

    assert set(mesh.cell_types.tolist()) == {"prism6"}
    splitter.assert_not_called()


def test_body_only_box_prism_uses_one_exact_uniform_extrusion_group(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gmsh = pytest.importorskip("gmsh")
    calls: list[tuple[list[int], list[float], bool]] = []
    real_extrude = gmsh.model.geo.extrude

    def recording_extrude(*args, **kwargs):
        calls.append(
            (
                list(kwargs["numElements"]),
                list(kwargs["heights"]),
                bool(kwargs["recombine"]),
            )
        )
        return real_extrude(*args, **kwargs)

    monkeypatch.setattr(gmsh.model.geo, "extrude", recording_extrude)
    mesh = generate_swept_box_mesh(
        (8.0e-9, 5.0e-9, 3.0e-9),
        hmax=2.0e-9,
        n_layers=3,
        thin_axis=2,
        order=1,
    )

    assert calls == [([3], [1.0], True)]
    assert set(mesh.cell_types.tolist()) == {"prism6"}


def test_body_only_box_prism_extraction_is_independent_of_gmsh_block_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gmsh = pytest.importorskip("gmsh")
    real_get_elements = gmsh.model.mesh.getElements

    def reversed_blocks(*args, **kwargs):
        element_types, element_tags, node_tags = real_get_elements(*args, **kwargs)
        order = list(range(len(element_types) - 1, -1, -1))
        return (
            np.asarray([element_types[index] for index in order]),
            [element_tags[index] for index in order],
            [node_tags[index] for index in order],
        )

    monkeypatch.setattr(gmsh.model.mesh, "getElements", reversed_blocks)
    swept_module = importlib.import_module("fullmag.meshing._gmsh_swept")
    splitter = Mock(side_effect=AssertionError("prism splitter called"))
    monkeypatch.setattr(swept_module, "_split_prism_to_tets", splitter)

    mesh = generate_swept_box_mesh(
        (8.0e-9, 5.0e-9, 3.0e-9),
        hmax=2.0e-9,
        n_layers=2,
        thin_axis=2,
        order=1,
    )

    assert set(mesh.cell_types.tolist()) == {"prism6"}
    mesh.validate_strict()
    splitter.assert_not_called()


def test_body_only_box_prism_rejects_wrong_realized_gmsh_family(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tet_mesh = MeshData.from_legacy_tet4(
        nodes=_REFERENCE_CELLS["tet4"],
        elements=[[0, 1, 2, 3]],
        element_markers=[1],
        boundary_faces=[[0, 2, 1]],
        boundary_markers=[1],
    )
    swept_module = importlib.import_module("fullmag.meshing._gmsh_swept")
    monkeypatch.setattr(swept_module, "_extract_mesh_data", lambda _gmsh: tet_mesh)

    with pytest.raises(RuntimeError, match="required prism6-only.*tet4"):
        _extract_swept_mesh_data(
            Mock(),
            1.0,
            requested_axis=2,
            requested_layers=1,
        )


def test_body_only_box_prism_rejects_wrong_realized_layer_count(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    prism_mesh = MeshData(
        nodes=_REFERENCE_CELLS["prism6"],
        cell_types=["prism6"],
        cell_offsets=[0, 6],
        cell_nodes=list(range(6)),
        cell_global_ordinals=[0],
        element_markers=[1],
        facet_types=[],
        facet_roles=[],
        facet_offsets=[0],
        facet_nodes=[],
        facet_global_ordinals=[],
        boundary_markers=[],
    )
    swept_module = importlib.import_module("fullmag.meshing._gmsh_swept")
    monkeypatch.setattr(swept_module, "_extract_mesh_data", lambda _gmsh: prism_mesh)

    with pytest.raises(RuntimeError, match="requested 2 layers.*resolved 1"):
        _extract_swept_mesh_data(
            Mock(),
            1.0,
            requested_axis=2,
            requested_layers=2,
        )


def test_body_only_box_prism_reports_requested_and_resolved_realization(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("gmsh")
    swept_module = importlib.import_module("fullmag.meshing._gmsh_swept")
    messages: list[str] = []
    monkeypatch.setattr(swept_module, "emit_progress", messages.append)

    generate_swept_box_mesh(
        (8.0e-9, 5.0e-9, 3.0e-9),
        hmax=2.0e-9,
        n_layers=2,
        thin_axis=1,
        order=1,
    )

    realization = next(message for message in messages if "requested topology=" in message)
    assert "requested topology=prism6 axis=y layers=2 order=1" in realization
    assert "resolved topology=prism6 axis=y layers=2 order=1" in realization
    assert "fallbacks=[]" in realization


def test_generate_mesh_dispatch_preserves_native_prisms_for_explicit_box_strategy() -> None:
    pytest.importorskip("gmsh")
    mesh = gmsh_generators.generate_mesh(
        fm.Box(size=(8.0e-9, 5.0e-9, 3.0e-9), name="film"),
        hmax=2.0e-9,
        order=1,
        options=MeshOptions(
            mesh_strategy=SWEEP_STRATEGY_PRISM,
            through_thickness_elements=1,
            through_thickness_distribution="fixed",
            sweep_face_meshing="triangular",
        ),
    )

    assert set(mesh.cell_types.tolist()) == {"prism6"}
    with pytest.raises(ValueError, match="tet4-only compatibility view"):
        _ = mesh.elements
    mesh.validate_strict()


def test_explicit_swept_hex_never_silently_realizes_prism(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    swept_module = importlib.import_module("fullmag.meshing._gmsh_swept")
    gmsh_import = Mock(side_effect=AssertionError("Gmsh started before hex rejection"))
    monkeypatch.setattr(swept_module, "_import_gmsh", gmsh_import)

    with pytest.raises(ValueError, match="swept_hex.*not implemented"):
        generate_swept_mesh(
            fm.Box(size=(8.0e-9, 5.0e-9, 3.0e-9)),
            hmax=2.0e-9,
            n_layers=1,
            order=1,
            recombine=True,
            options=MeshOptions(mesh_strategy="swept_hex"),
        )
    gmsh_import.assert_not_called()


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"n_layers": True}, "n_layers must be an integer"),
        ({"n_layers": 1.5}, "n_layers must be an integer"),
        ({"n_layers": 1, "order": True}, "order must be an integer"),
        ({"n_layers": 1, "order": 1.0}, "order must be an integer"),
        ({"n_layers": 1, "thin_axis": True}, "thin_axis must be an integer"),
        ({"n_layers": 1, "thin_axis": 2.0}, "thin_axis must be an integer"),
    ],
)
def test_body_only_box_prism_rejects_non_integer_controls_before_gmsh(
    monkeypatch: pytest.MonkeyPatch,
    kwargs: dict[str, object],
    message: str,
) -> None:
    swept_module = importlib.import_module("fullmag.meshing._gmsh_swept")
    gmsh_import = Mock(side_effect=AssertionError("Gmsh started before validation"))
    monkeypatch.setattr(swept_module, "_import_gmsh", gmsh_import)

    with pytest.raises((TypeError, ValueError), match=message):
        generate_swept_box_mesh(
            (8.0e-9, 5.0e-9, 3.0e-9),
            hmax=2.0e-9,
            **kwargs,
        )
    gmsh_import.assert_not_called()


@pytest.mark.parametrize(
    ("size", "hmax", "hmin", "message"),
    [
        ((-8.0e-9, 5.0e-9, 3.0e-9), 2.0e-9, None, "size\\[0\\].*finite and positive"),
        ((8.0e-9, 0.0, 3.0e-9), 2.0e-9, None, "size\\[1\\].*finite and positive"),
        ((8.0e-9, 5.0e-9, float("nan")), 2.0e-9, None, "size\\[2\\].*finite and positive"),
        ((8.0e-9, 5.0e-9, 3.0e-9), 0.0, None, "hmax.*finite and positive"),
        ((8.0e-9, 5.0e-9, 3.0e-9), float("inf"), None, "hmax.*finite and positive"),
        ((8.0e-9, 5.0e-9, 3.0e-9), 2.0e-9, -1.0e-9, "hmin.*finite and positive"),
        ((8.0e-9, 5.0e-9, 3.0e-9), 2.0e-9, float("nan"), "hmin.*finite and positive"),
    ],
)
def test_body_only_box_prism_rejects_invalid_sizes_before_gmsh(
    monkeypatch: pytest.MonkeyPatch,
    size: tuple[float, float, float],
    hmax: float,
    hmin: float | None,
    message: str,
) -> None:
    swept_module = importlib.import_module("fullmag.meshing._gmsh_swept")
    gmsh_import = Mock(side_effect=AssertionError("Gmsh started before validation"))
    monkeypatch.setattr(swept_module, "_import_gmsh", gmsh_import)

    with pytest.raises(ValueError, match=message):
        generate_swept_box_mesh(
            size,
            hmax=hmax,
            n_layers=1,
            options=MeshOptions(hmin=hmin),
        )
    gmsh_import.assert_not_called()


def test_body_only_box_prism_provenance_is_typed_and_persistent(
    tmp_path: Path,
) -> None:
    pytest.importorskip("gmsh")
    mesh = generate_swept_box_mesh(
        (8.0e-9, 5.0e-9, 3.0e-9),
        hmax=2.0e-9,
        n_layers=2,
        thin_axis=1,
        order=1,
    )

    report_type = getattr(gmsh_types, "MeshRealizationReport", None)
    assert report_type is not None
    assert isinstance(mesh.realization_report, report_type)
    assert mesh.realization_report.requested_topology == "prism6"
    assert mesh.realization_report.resolved_topology == "prism6"
    assert mesh.realization_report.requested_layers == 2
    assert mesh.realization_report.resolved_layers == 2
    assert mesh.realization_report.requested_axis == "y"
    assert mesh.realization_report.resolved_axis == "y"
    assert mesh.realization_report.requested_order == 1
    assert mesh.realization_report.resolved_order == 1
    assert mesh.realization_report.fallbacks_triggered == ()

    for suffix in (".json", ".npz"):
        path = tmp_path / f"prism{suffix}"
        mesh.save(path)
        restored = MeshData.load(path)
        assert restored.realization_report == mesh.realization_report
    assert mesh.oriented_copy().realization_report == mesh.realization_report
    assert mesh.to_ir("film")["mesh_realization_report"] == (
        mesh.realization_report.to_dict()
    )


def test_existing_swept_cylinder_quality_path_remains_available() -> None:
    pytest.importorskip("gmsh")
    mesh = generate_swept_cylinder_mesh(
        radius=4.0e-9,
        height=2.0e-9,
        hmax=2.0e-9,
        n_layers=1,
        order=1,
        options=MeshOptions(compute_quality=True),
    )

    assert set(mesh.cell_types.tolist()) == {"tet4"}
    assert mesh.quality is not None
    assert mesh.quality.quality_source == "swept_topology_proxy"


def test_mesh_data_rejects_realization_report_that_misstates_topology() -> None:
    report = gmsh_types.MeshRealizationReport(
        requested_topology="prism6",
        resolved_topology="prism6",
        requested_layers=1,
        resolved_layers=1,
        requested_axis="z",
        resolved_axis="z",
        requested_order=1,
        resolved_order=1,
    )

    with pytest.raises(ValueError, match="resolved topology prism6.*actual.*tet4"):
        MeshData.from_legacy_tet4(
            nodes=_REFERENCE_CELLS["tet4"],
            elements=[[0, 1, 2, 3]],
            element_markers=[1],
            boundary_faces=[[0, 2, 1]],
            boundary_markers=[1],
            realization_report=report,
        )


def test_mesh_data_rejects_realization_report_that_misstates_layers() -> None:
    report = gmsh_types.MeshRealizationReport(
        requested_topology="prism6",
        resolved_topology="prism6",
        requested_layers=99,
        resolved_layers=99,
        requested_axis="z",
        resolved_axis="z",
        requested_order=1,
        resolved_order=1,
    )

    with pytest.raises(ValueError, match="resolved layers 99.*actual.*1"):
        MeshData(
            nodes=_REFERENCE_CELLS["prism6"],
            cell_types=["prism6"],
            cell_offsets=[0, 6],
            cell_nodes=list(range(6)),
            cell_global_ordinals=[0],
            element_markers=[1],
            facet_types=[],
            facet_roles=[],
            facet_offsets=[0],
            facet_nodes=[],
            facet_global_ordinals=[],
            boundary_markers=[],
            realization_report=report,
        )


def test_mesh_realization_report_rejects_empty_fallback_marker() -> None:
    with pytest.raises(ValueError, match="fallback markers must be non-empty"):
        gmsh_types.MeshRealizationReport(
            requested_topology="prism6",
            resolved_topology="prism6",
            requested_layers=1,
            resolved_layers=1,
            requested_axis="z",
            resolved_axis="z",
            requested_order=1,
            resolved_order=1,
            fallbacks_triggered=("",),
        )


def test_mesh_realization_report_rejects_hidden_degradation_without_fallback() -> None:
    with pytest.raises(ValueError, match="requested/resolved fields must match.*no fallback"):
        gmsh_types.MeshRealizationReport(
            requested_topology="tet4",
            resolved_topology="prism6",
            requested_layers=8,
            resolved_layers=1,
            requested_axis="x",
            resolved_axis="z",
            requested_order=2,
            resolved_order=1,
            fallbacks_triggered=(),
        )


@pytest.mark.parametrize("suffix", [".json", ".npz"])
def test_mesh_load_rejects_tampered_realization_report(
    tmp_path: Path,
    suffix: str,
) -> None:
    pytest.importorskip("gmsh")
    mesh = generate_swept_box_mesh(
        (8.0e-9, 5.0e-9, 3.0e-9),
        hmax=2.0e-9,
        n_layers=1,
        thin_axis=2,
        order=1,
    )
    path = tmp_path / f"tampered{suffix}"
    mesh.save(path)
    if suffix == ".json":
        payload = json.loads(path.read_text(encoding="utf-8"))
        payload["realization_report"]["requested_layers"] = 99
        payload["realization_report"]["resolved_layers"] = 99
        path.write_text(json.dumps(payload), encoding="utf-8")
    else:
        with np.load(path) as archive:
            payload = {name: archive[name] for name in archive.files}
        report = json.loads(str(payload["realization_report_json"]))
        report["requested_layers"] = 99
        report["resolved_layers"] = 99
        payload["realization_report_json"] = np.asarray(json.dumps(report))
        np.savez_compressed(path, **payload)

    with pytest.raises(ValueError, match="resolved layers 99.*actual layer count 1"):
        MeshData.load(path)


def test_mesh_load_rejects_hidden_degradation_in_tampered_report(
    tmp_path: Path,
) -> None:
    pytest.importorskip("gmsh")
    mesh = generate_swept_box_mesh(
        (8.0e-9, 5.0e-9, 3.0e-9),
        hmax=2.0e-9,
        n_layers=1,
        thin_axis=2,
        order=1,
    )
    path = tmp_path / "hidden-degradation.json"
    mesh.save(path)
    payload = json.loads(path.read_text(encoding="utf-8"))
    payload["realization_report"]["requested_topology"] = "tet4"
    path.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(ValueError, match="requested/resolved fields must match.*no fallback"):
        MeshData.load(path)


def _mixed_nodes() -> np.ndarray:
    return np.asarray(
        [
            # prism6
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 1.0],
            [0.0, 1.0, 1.0],
            # pyramid5
            [2.0, -1.0, 0.0],
            [4.0, -1.0, 0.0],
            [4.0, 1.0, 0.0],
            [2.0, 1.0, 0.0],
            [3.0, 0.0, 1.0],
            # tet4
            [5.0, 0.0, 0.0],
            [6.0, 0.0, 0.0],
            [5.0, 1.0, 0.0],
            [5.0, 0.0, 1.0],
            # hex8
            [7.0, 0.0, 0.0],
            [8.0, 0.0, 0.0],
            [8.0, 1.0, 0.0],
            [7.0, 1.0, 0.0],
            [7.0, 0.0, 1.0],
            [8.0, 0.0, 1.0],
            [8.0, 1.0, 1.0],
            [7.0, 1.0, 1.0],
        ],
        dtype=np.float64,
    )


def _mixed_mesh(*, include_hex: bool = False) -> MeshData:
    cell_types = ["prism6", "pyramid5", "tet4"]
    cell_offsets = [0, 6, 11, 15]
    cell_nodes = list(range(15))
    element_markers = [1, 0, 0]
    if include_hex:
        cell_types.append("hex8")
        cell_offsets.append(23)
        cell_nodes.extend(range(15, 23))
        element_markers.append(0)
    return MeshData(
        nodes=_mixed_nodes(),
        cell_types=cell_types,
        cell_offsets=cell_offsets,
        cell_nodes=cell_nodes,
        cell_global_ordinals=list(range(len(cell_types))),
        element_markers=element_markers,
        facet_types=["tri3", "quad4"],
        facet_roles=["exterior", "material_interface"],
        facet_offsets=[0, 3, 7],
        facet_nodes=[0, 2, 1, 0, 1, 4, 3],
        boundary_markers=[10, 20],
        facet_global_ordinals=[0, 1],
    )


def test_mesh_data_accepts_canonical_mixed_typed_csr() -> None:
    mesh = _mixed_mesh()

    assert mesh.n_elements == 3
    assert mesh.n_boundary_faces == 2
    assert mesh.cell_types.tolist() == ["prism6", "pyramid5", "tet4"]
    assert mesh.facet_types.tolist() == ["tri3", "quad4"]
    assert mesh.facet_roles.tolist() == ["exterior", "material_interface"]
    with pytest.raises(ValueError, match="tet4-only compatibility view"):
        _ = mesh.elements
    with pytest.raises(ValueError, match="tri3-only compatibility view"):
        _ = mesh.boundary_faces


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"cell_types": ["unknown", "pyramid5", "tet4"]}, "unknown cell type"),
        ({"cell_offsets": [1, 7, 12, 16]}, "start at zero"),
        ({"cell_offsets": [0, 6, 5, 15]}, "monotone"),
        ({"cell_offsets": [0, 6, 11]}, "cell count plus one"),
        ({"cell_offsets": [0, 5, 11, 15]}, "wrong arity"),
        ({"cell_nodes": list(range(14)) + [99]}, "invalid node index"),
        ({"cell_nodes": [0, 1, 2, 3, 4, 4] + list(range(6, 15))}, "duplicate"),
        ({"element_markers": [1, 0]}, "element_markers"),
        ({"cell_global_ordinals": [1, 1, 2]}, "cell_global_ordinals must be unique"),
        ({"facet_types": ["unknown", "quad4"]}, "unknown facet type"),
        ({"facet_offsets": [0, 3]}, "facet count plus one"),
        ({"facet_offsets": [0, 2, 7]}, "wrong arity"),
        ({"facet_nodes": [0, 2, 99, 0, 1, 4, 3]}, "invalid node index"),
        ({"facet_nodes": [0, 2, 2, 0, 1, 4, 3]}, "duplicate"),
        ({"facet_roles": ["exterior"]}, "facet_roles"),
        ({"facet_roles": ["not_a_role", "exterior"]}, "unknown facet role"),
        ({"boundary_markers": [10]}, "boundary_markers"),
        ({"facet_global_ordinals": [7, 7]}, "facet_global_ordinals must be unique"),
    ],
)
def test_mesh_data_rejects_invalid_canonical_csr(
    overrides: dict[str, object],
    message: str,
) -> None:
    kwargs: dict[str, object] = {
        "nodes": _mixed_nodes(),
        "cell_types": ["prism6", "pyramid5", "tet4"],
        "cell_offsets": [0, 6, 11, 15],
            "cell_nodes": list(range(15)),
            "cell_global_ordinals": [0, 1, 2],
        "element_markers": [1, 0, 0],
        "facet_types": ["tri3", "quad4"],
        "facet_roles": ["exterior", "material_interface"],
        "facet_offsets": [0, 3, 7],
        "facet_nodes": [0, 2, 1, 0, 1, 4, 3],
            "boundary_markers": [10, 20],
            "facet_global_ordinals": [0, 1],
    }
    kwargs.update(overrides)

    with pytest.raises(ValueError, match=message):
        MeshData(**kwargs)


_REFERENCE_CELLS = {
    "tet4": np.asarray(
        [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
    ),
    "prism6": np.asarray(
        [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 1.0],
            [0.0, 1.0, 1.0],
        ]
    ),
    "pyramid5": np.asarray(
        [
            [-1.0, -1.0, 0.0],
            [1.0, -1.0, 0.0],
            [1.0, 1.0, 0.0],
            [-1.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ]
    ),
    "hex8": np.asarray(
        [
            [-1.0, -1.0, -1.0],
            [1.0, -1.0, -1.0],
            [1.0, 1.0, -1.0],
            [-1.0, 1.0, -1.0],
            [-1.0, -1.0, 1.0],
            [1.0, -1.0, 1.0],
            [1.0, 1.0, 1.0],
            [-1.0, 1.0, 1.0],
        ]
    ),
}


@pytest.mark.parametrize(
    ("cell_type", "inverted_order"),
    [
        ("tet4", [0, 2, 1, 3]),
        ("prism6", [0, 2, 1, 3, 5, 4]),
        ("pyramid5", [0, 3, 2, 1, 4]),
        ("hex8", [1, 0, 3, 2, 5, 4, 7, 6]),
    ],
)
def test_strict_validation_is_family_aware_for_inverted_cells(
    cell_type: str,
    inverted_order: list[int],
) -> None:
    nodes = _REFERENCE_CELLS[cell_type]
    mesh = MeshData(
        nodes=nodes,
        cell_types=[cell_type],
        cell_offsets=[0, len(nodes)],
        cell_nodes=inverted_order,
        cell_global_ordinals=[0],
        element_markers=[1],
        facet_types=[],
        facet_roles=[],
        facet_offsets=[0],
        facet_nodes=[],
        boundary_markers=[],
        facet_global_ordinals=[],
    )

    with pytest.raises(ValueError, match=f"negative {cell_type} Jacobian"):
        mesh.validate_strict()


@pytest.mark.parametrize("cell_type", ["tet4", "prism6", "pyramid5", "hex8"])
def test_strict_validation_rejects_family_degenerate_cells(cell_type: str) -> None:
    nodes = np.array(_REFERENCE_CELLS[cell_type], copy=True)
    nodes[:, 2] = 0.0
    mesh = MeshData(
        nodes=nodes,
        cell_types=[cell_type],
        cell_offsets=[0, len(nodes)],
        cell_nodes=list(range(len(nodes))),
        cell_global_ordinals=[0],
        element_markers=[1],
        facet_types=[],
        facet_roles=[],
        facet_offsets=[0],
        facet_nodes=[],
        boundary_markers=[],
        facet_global_ordinals=[],
    )

    with pytest.raises(ValueError, match=f"degenerate {cell_type} Jacobian"):
        mesh.validate_strict()


@pytest.mark.parametrize(
    ("cell_type", "warped_node", "warped_coordinate", "sample_count"),
    [
        ("prism6", 0, [1.0, 1.0, -1.0], 6),
        ("pyramid5", 0, [-1.0, 0.0, 2.0], 8),
        ("hex8", 1, [-1.0, 0.0, 0.0], 8),
    ],
)
def test_order2_jacobian_rule_rejects_locally_inverted_mixed_cells(
    cell_type: str,
    warped_node: int,
    warped_coordinate: list[float],
    sample_count: int,
) -> None:
    nodes = np.array(_REFERENCE_CELLS[cell_type], copy=True)
    nodes[warped_node] = warped_coordinate
    determinants = _cell_jacobian_determinants(cell_type, nodes)
    assert determinants.shape == (sample_count,)
    assert float(np.min(determinants)) < 0.0
    mesh = MeshData(
        nodes=nodes,
        cell_types=[cell_type],
        cell_offsets=[0, len(nodes)],
        cell_nodes=list(range(len(nodes))),
        cell_global_ordinals=[73],
        element_markers=[1],
        facet_types=[],
        facet_roles=[],
        facet_offsets=[0],
        facet_nodes=[],
        facet_global_ordinals=[],
        boundary_markers=[],
    )

    with pytest.raises(
        ValueError,
        match=rf"cell 0 .*global ordinal 73.*negative {cell_type} Jacobian",
    ):
        mesh.validate_strict()


def test_legacy_json_and_npz_normalize_to_v2_and_dual_truth_rejects(
    tmp_path: Path,
) -> None:
    legacy = {
        "mesh_name": "legacy",
        "nodes": _REFERENCE_CELLS["tet4"].tolist(),
        "elements": [[0, 1, 2, 3]],
        "element_markers": [7],
        "boundary_faces": [[0, 2, 1]],
        "boundary_markers": [9],
    }
    json_path = tmp_path / "legacy.json"
    json_path.write_text(json.dumps(legacy), encoding="utf-8")
    json_mesh = MeshData.load(json_path)
    assert json_mesh.cell_types.tolist() == ["tet4"]
    assert json_mesh.facet_roles.tolist() == ["exterior"]

    npz_path = tmp_path / "legacy.npz"
    np.savez_compressed(
        npz_path,
        nodes=np.asarray(legacy["nodes"]),
        elements=np.asarray(legacy["elements"]),
        element_markers=np.asarray(legacy["element_markers"]),
        boundary_faces=np.asarray(legacy["boundary_faces"]),
        boundary_markers=np.asarray(legacy["boundary_markers"]),
    )
    npz_mesh = MeshData.load(npz_path)
    assert npz_mesh.cell_offsets.tolist() == [0, 4]
    assert npz_mesh.facet_offsets.tolist() == [0, 3]

    dual_path = tmp_path / "dual.json"
    dual_path.write_text(
        json.dumps(
            legacy
            | {
                "cell_types": ["tet4"],
                "cell_offsets": [0, 4],
                "cell_nodes": [0, 1, 2, 3],
                "facet_types": ["tri3"],
                "facet_roles": ["exterior"],
                "facet_offsets": [0, 3],
                "facet_nodes": [0, 2, 1],
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="both legacy and v2 topology"):
        MeshData.load(dual_path)


def test_save_load_emits_only_v2_topology(tmp_path: Path) -> None:
    base = _mixed_mesh()
    mesh = MeshData(
        **{
            field: getattr(base, field)
            for field in (
                "nodes",
                "cell_types",
                "cell_offsets",
                "cell_nodes",
                "element_markers",
                "facet_types",
                "facet_roles",
                "facet_offsets",
                "facet_nodes",
                "boundary_markers",
            )
        },
        cell_global_ordinals=[41, 7, 99],
        facet_global_ordinals=[88, 12],
    )
    json_path = tmp_path / "mixed.json"
    npz_path = tmp_path / "mixed.npz"

    mesh.save(json_path)
    mesh.save(npz_path)

    payload = json.loads(json_path.read_text(encoding="utf-8"))
    assert "elements" not in payload
    assert "boundary_faces" not in payload
    assert payload["cell_types"] == ["prism6", "pyramid5", "tet4"]
    assert payload["cell_global_ordinals"] == [41, 7, 99]
    assert payload["facet_global_ordinals"] == [88, 12]
    with np.load(npz_path) as data:
        assert "elements" not in data.files
        assert "boundary_faces" not in data.files
        assert data["facet_roles"].tolist() == ["exterior", "material_interface"]
        assert data["cell_global_ordinals"].tolist() == [41, 7, 99]
        assert data["facet_global_ordinals"].tolist() == [88, 12]

    loaded_json = MeshData.load(json_path)
    loaded_npz = MeshData.load(npz_path)
    np.testing.assert_array_equal(loaded_json.cell_nodes, mesh.cell_nodes)
    np.testing.assert_array_equal(loaded_npz.facet_nodes, mesh.facet_nodes)
    np.testing.assert_array_equal(loaded_json.cell_global_ordinals, [41, 7, 99])
    np.testing.assert_array_equal(loaded_npz.facet_global_ordinals, [88, 12])


def test_mixed_vtk_and_vtu_export_keep_native_cell_types(tmp_path: Path) -> None:
    mesh = _mixed_mesh(include_hex=True)
    vtk_path = mesh.export_vtk(tmp_path / "mixed.vtk")
    vtu_path = mesh.export_vtk(tmp_path / "mixed.vtu")

    vtk = vtk_path.read_text(encoding="utf-8")
    assert "CELL_TYPES 4\n13\n14\n10\n12\n" in vtk
    assert "CELLS 4 27" in vtk
    vtu = vtu_path.read_text(encoding="utf-8")
    assert 'Name="types"' in vtu
    assert "13 14 10 12" in vtu
    assert 'NumberOfCells="4"' in vtu


def test_typed_cell_blocks_preserve_global_ordinals_and_markers() -> None:
    mesh = MeshData(
        nodes=_mixed_nodes(),
        cell_types=["prism6", "tet4", "prism6"],
        cell_offsets=[0, 6, 10, 16],
        cell_nodes=list(range(6)) + list(range(11, 15)) + list(range(6)),
        cell_global_ordinals=[90, 12, 44],
        element_markers=[3, 4, 5],
        facet_types=[],
        facet_roles=[],
        facet_offsets=[0],
        facet_nodes=[],
        facet_global_ordinals=[],
        boundary_markers=[],
    )

    blocks = {block.cell_type: block for block in mesh.cell_blocks()}
    assert blocks["prism6"].global_ordinals.tolist() == [90, 44]
    assert blocks["prism6"].markers.tolist() == [3, 5]
    assert blocks["prism6"].nodes.shape == (2, 6)
    assert blocks["tet4"].global_ordinals.tolist() == [12]


def test_translate_imported_mixed_mesh_preserves_canonical_topology(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    quality = Mock(name="mixed_quality")
    per_domain_quality = {1: Mock(name="film_quality"), 0: Mock(name="air_quality")}
    source = MeshData(
        nodes=_mixed_nodes(),
        cell_types=["prism6", "pyramid5"],
        cell_offsets=[0, 6, 11],
        cell_nodes=list(range(11)),
        cell_global_ordinals=[101, 55],
        element_markers=[1, 0],
        facet_types=["quad4"],
        facet_roles=["material_interface"],
        facet_offsets=[0, 4],
        facet_nodes=[0, 1, 4, 3],
        facet_global_ordinals=[700],
        boundary_markers=[20],
        quality=quality,
        per_domain_quality=per_domain_quality,
    )
    monkeypatch.setattr(
        gmsh_generators,
        "generate_mesh_from_file",
        lambda *_args, **_kwargs: source,
    )

    translated = gmsh_generators.generate_mesh(
        fm.Translate(
            fm.ImportedGeometry(source="mixed.vtu", name="mixed"),
            (2.0, -3.0, 4.0),
        ),
        hmax=0.25,
    )

    np.testing.assert_allclose(translated.nodes, source.nodes + [2.0, -3.0, 4.0])
    for field in (
        "cell_types",
        "cell_offsets",
        "cell_nodes",
        "cell_global_ordinals",
        "element_markers",
        "facet_types",
        "facet_roles",
        "facet_offsets",
        "facet_nodes",
        "facet_global_ordinals",
        "boundary_markers",
    ):
        np.testing.assert_array_equal(getattr(translated, field), getattr(source, field))
    assert translated.periodic_boundary_pairs == source.periodic_boundary_pairs
    assert translated.periodic_node_pairs == source.periodic_node_pairs
    assert translated.periodic_mesh_certificate == source.periodic_mesh_certificate
    assert translated.quality is quality
    assert translated.per_domain_quality is per_domain_quality


def test_translate_imported_mixed_mesh_never_enters_tet_compatibility(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = _mixed_mesh()
    monkeypatch.setattr(
        gmsh_generators,
        "generate_mesh_from_file",
        lambda *_args, **_kwargs: source,
    )

    translated = gmsh_generators.generate_mesh(
        fm.Translate(
            fm.ImportedGeometry(source="mixed.vtu", name="mixed"),
            (1.0, 2.0, 3.0),
        ),
        hmax=0.25,
    )

    assert translated.cell_types.tolist() == ["prism6", "pyramid5", "tet4"]
    assert translated.facet_types.tolist() == ["tri3", "quad4"]
    assert translated.facet_roles.tolist() == ["exterior", "material_interface"]
