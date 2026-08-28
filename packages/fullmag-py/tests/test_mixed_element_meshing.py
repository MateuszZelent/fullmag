from __future__ import annotations

import importlib
import inspect
import itertools
import json
import ast
from collections import Counter
from dataclasses import replace
from pathlib import Path
from unittest.mock import Mock

import numpy as np
import pytest

import fullmag as fm
import fullmag.meshing._gmsh_generators as gmsh_generators
import fullmag.meshing._gmsh_swept as gmsh_swept
import fullmag.meshing._gmsh_types as gmsh_types
from fullmag import world as flat_world
from fullmag.meshing._gmsh_extraction import (
    _GMSH_TO_FULLMAG_NODE_PERMUTATION,
    _derive_facet_roles,
    _extract_mesh_data,
)
from fullmag.meshing._gmsh_infra import _scale_mesh_nodes
from fullmag.meshing._gmsh_occ import generate_shared_domain_mesh_via_occ
from fullmag.meshing._gmsh_types import (
    MeshData,
    MeshOptions,
    MixedLayerTopologyCertificate,
    _cell_jacobian_determinants,
    _mixed_same_side_two_owner_face_count,
)
from fullmag.meshing._gmsh_swept import (
    SWEEP_STRATEGY_PRISM,
    _extract_swept_mesh_data,
    _mixed_apex_factor_preserves_face_sides,
    _mixed_apex_candidate_preserves_face_sides,
    _iter_mixed_apex_face_side_constraints,
    _mixed_shared_faces_by_apex,
    _prepare_mixed_apex_face_side_constraints,
    generate_swept_box_mesh,
    generate_swept_cylinder_mesh,
    generate_swept_mesh,
)
from fullmag.meshing.remesh_cli import _mesh_result_payload


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


def test_mixed_face_frequency_counting_is_linear_in_face_count() -> None:
    class CountingFace(tuple):
        comparisons = 0

        def __eq__(self, other: object) -> bool:
            type(self).comparisons += 1
            return super().__eq__(other)

        __hash__ = tuple.__hash__

    faces = [CountingFace((index, index + 1, index + 2)) for index in range(2_000)]

    frequencies = gmsh_types._mixed_face_frequencies(faces)

    assert len(frequencies) == len(faces)
    assert CountingFace.comparisons <= len(faces)


def test_mixed_tetrahedra_repair_uses_versioned_relocate3d_policy() -> None:
    gmsh = Mock()

    gmsh_swept._repair_mixed_tetrahedra(gmsh)

    gmsh.model.mesh.optimize.assert_called_once_with("Relocate3D", niter=1)
    policy = gmsh_swept._STRICT_MIXED_TET_REPAIR_POLICY
    assert policy.algorithm_id == "fullmag.mixed-tet-repair.v1"
    assert policy.method == "Relocate3D"


def test_mixed_tetrahedra_repair_uses_one_iteration() -> None:
    gmsh = Mock()

    gmsh_swept._repair_mixed_tetrahedra(gmsh)

    assert gmsh.model.mesh.optimize.call_args.kwargs == {"niter": 1}


def test_strict_mixed_generation_does_not_expose_public_optimizer_override() -> None:
    parameters = inspect.signature(generate_swept_box_mesh).parameters

    assert "optimizer" not in parameters
    assert "repair_method" not in parameters
    assert "repair_policy" not in parameters


def test_mixed_repair_policy_id_changes_when_method_or_iterations_change() -> None:
    production = gmsh_swept._qualification_mixed_tet_repair_algorithm_id(
        "Relocate3D", 1
    )

    assert production != gmsh_swept._qualification_mixed_tet_repair_algorithm_id(
        "Netgen", 1
    )
    assert production != gmsh_swept._qualification_mixed_tet_repair_algorithm_id(
        "Relocate3D", 2
    )


def test_qualification_repair_selector_delegates_through_validated_policy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gmsh = Mock()
    delegated: list[object] = []

    def capture(_gmsh: object, policy: object) -> None:
        assert _gmsh is gmsh
        delegated.append(policy)

    monkeypatch.setattr(gmsh_swept, "_execute_mixed_tet_repair_policy", capture)

    gmsh_swept._repair_mixed_tetrahedra_for_qualification("Netgen", gmsh)

    assert len(delegated) == 1
    policy = delegated[0]
    assert policy.method == "Netgen"
    assert policy.iterations == 1
    assert policy.algorithm_id == (
        gmsh_swept._qualification_mixed_tet_repair_algorithm_id("Netgen", 1)
    )


def test_qualification_relocate_selector_uses_immutable_production_policy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gmsh = Mock()
    delegated: list[object] = []

    def capture(_gmsh: object, policy: object) -> None:
        assert _gmsh is gmsh
        delegated.append(policy)

    monkeypatch.setattr(gmsh_swept, "_execute_mixed_tet_repair_policy", capture)

    gmsh_swept._repair_mixed_tetrahedra_for_qualification("Relocate3D", gmsh)

    assert delegated == [gmsh_swept._STRICT_MIXED_TET_REPAIR_POLICY]


@pytest.mark.parametrize(
    "policy",
    [
        ("", "Relocate3D", 1),
        ("qualification", "Laplace2D", 1),
        ("qualification", "Relocate3D", 0),
    ],
)
def test_mixed_tetrahedra_repair_rejects_invalid_private_policy(
    policy: tuple[str, str, int],
) -> None:
    gmsh = Mock()

    with pytest.raises(ValueError):
        gmsh_swept._repair_mixed_tetrahedra(
            gmsh,
            policy=gmsh_swept._MixedTetRepairPolicy(*policy),
        )

    gmsh.model.mesh.optimize.assert_not_called()


def _netgen_regression_topology() -> MeshData:
    nodes: list[list[float]] = []
    cells: list[list[int]] = []

    def add_same_side_pair(offset: float) -> None:
        start = len(nodes)
        nodes.extend(
            [
                [offset, 0.0, 0.0],
                [offset + 1.0, 0.0, 0.0],
                [offset, 1.0, 0.0],
                [offset, 0.0, 1.0],
                [offset + 0.2, 0.2, 2.0],
            ]
        )
        cells.extend(
            [
                [start, start + 1, start + 2, start + 3],
                [start, start + 1, start + 2, start + 4],
            ]
        )

    def add_non_manifold_triple(offset: float) -> None:
        start = len(nodes)
        nodes.extend(
            [
                [offset, 0.0, 0.0],
                [offset + 1.0, 0.0, 0.0],
                [offset, 1.0, 0.0],
                [offset, 0.0, 1.0],
                [offset, 0.0, -1.0],
                [offset + 0.2, 0.2, 2.0],
            ]
        )
        cells.extend(
            [
                [start, start + 1, start + 2, start + 3],
                [start, start + 1, start + 2, start + 4],
                [start, start + 1, start + 2, start + 5],
            ]
        )

    add_same_side_pair(0.0)
    add_same_side_pair(10.0)
    add_non_manifold_triple(20.0)
    add_non_manifold_triple(30.0)
    face_counts = Counter(
        tuple(sorted(cell[index] for index in face))
        for cell in cells
        for face in CELL_FACES["Tetrahedron 4"]
    )
    exterior_faces = sorted(face for face, count in face_counts.items() if count == 1)
    cell_nodes = np.asarray(cells, dtype=np.int32).reshape(-1)
    return MeshData(
        nodes=np.asarray(nodes, dtype=np.float64),
        cell_types=np.asarray(["tet4"] * len(cells)),
        cell_offsets=np.arange(0, 4 * len(cells) + 1, 4, dtype=np.int32),
        cell_nodes=cell_nodes,
        element_markers=np.zeros(len(cells), dtype=np.int32),
        facet_types=np.asarray(["tri3"] * len(exterior_faces), dtype=np.str_),
        facet_roles=np.asarray(["exterior"] * len(exterior_faces), dtype=np.str_),
        facet_offsets=np.arange(0, 3 * len(exterior_faces) + 1, 3, dtype=np.int32),
        facet_nodes=np.asarray(exterior_faces, dtype=np.int32).reshape(-1),
        boundary_markers=np.asarray([99] * len(exterior_faces), dtype=np.int32),
        cell_global_ordinals=np.arange(len(cells), dtype=np.int64),
        facet_global_ordinals=np.arange(len(exterior_faces), dtype=np.int64),
        cell_mesh_parts=np.asarray(["far_air"] * len(cells)),
    )


def test_netgen_regression_fixture_is_rejected_by_certificate_conformity_boundary() -> None:
    pytest.importorskip("gmsh")
    from fullmag.meshing._gmsh_airbox import _attach_mixed_layer_topology_certificate

    body_size, airbox, accepted = _mixed_shared_domain_case()
    defect = _netgen_regression_topology()
    node_offset = accepted.n_nodes
    cell_offset = accepted.n_elements
    facet_offset = accepted.n_boundary_faces
    corrupted = replace(
        accepted,
        nodes=np.concatenate([accepted.nodes, defect.nodes * 0.01e-6 + [3.0e-6, 1.5e-6, 0.0]]),
        cell_types=np.concatenate([accepted.cell_types, defect.cell_types]),
        cell_offsets=np.concatenate(
            [
                accepted.cell_offsets,
                accepted.cell_offsets[-1] + defect.cell_offsets[1:],
            ]
        ),
        cell_nodes=np.concatenate([accepted.cell_nodes, defect.cell_nodes + node_offset]),
        element_markers=np.concatenate(
            [accepted.element_markers, np.zeros(defect.n_elements, dtype=np.int32)]
        ),
        cell_global_ordinals=np.concatenate(
            [
                accepted.cell_global_ordinals,
                np.arange(cell_offset, cell_offset + defect.n_elements, dtype=np.int64),
            ]
        ),
        facet_types=np.concatenate([accepted.facet_types, defect.facet_types]),
        facet_roles=np.concatenate([accepted.facet_roles, defect.facet_roles]),
        facet_offsets=np.concatenate(
            [
                accepted.facet_offsets,
                accepted.facet_offsets[-1] + defect.facet_offsets[1:],
            ]
        ),
        facet_nodes=np.concatenate(
            [accepted.facet_nodes, defect.facet_nodes + node_offset]
        ),
        boundary_markers=np.concatenate(
            [accepted.boundary_markers, defect.boundary_markers]
        ),
        facet_global_ordinals=np.concatenate(
            [
                accepted.facet_global_ordinals,
                np.arange(
                    facet_offset,
                    facet_offset + defect.n_boundary_faces,
                    dtype=np.int64,
                ),
            ]
        ),
        cell_mesh_parts=np.concatenate(
            [accepted.cell_mesh_parts, defect.cell_mesh_parts]
        ),
        mixed_layer_topology_certificate=None,
    )
    assert airbox.size is not None

    with pytest.raises(RuntimeError, match="conformity validation failed") as caught:
        _attach_mixed_layer_topology_certificate(
            corrupted,
            body_size_m=body_size,
            airbox_bounds_min_m=tuple(-0.5 * value for value in airbox.size),
            airbox_bounds_max_m=tuple(0.5 * value for value in airbox.size),
            requested_axis=2,
            requested_layers=1,
            gmsh_version="4.15.2",
            cell_mesh_parts=corrupted.cell_mesh_parts,
            outer_boundary_marker=99,
            effective_gmsh_thread_count=1,
        )

    message = str(caught.value)
    conformity_text, diagnostics_text = message.split("; diagnostics=", maxsplit=1)
    conformity = ast.literal_eval(conformity_text.split(": ", maxsplit=1)[1])
    diagnostics = ast.literal_eval(diagnostics_text)
    issue_counts = Counter(row["issue"] for row in diagnostics)
    assert conformity["nonmanifold_face_count"] == 2
    assert issue_counts["same_side_two_owner_face"] == 2
    assert issue_counts["nonmanifold_face"] == 2
    assert all(
        owner["mesh_part"] == "far_air"
        for row in diagnostics
        if row["issue"] in {"same_side_two_owner_face", "nonmanifold_face"}
        for owner in row["owners"]
    )


def test_qualified_boundary_markers_bypass_volume_face_adjacency() -> None:
    roles = _derive_facet_roles(
        ["tet4"],
        np.asarray([0, 4]),
        np.asarray([0, 1, 2, 3]),
        np.asarray([1]),
        np.asarray([0, 3, 6]),
        np.asarray([0, 1, 2, 0, 1, 3]),
        np.asarray([10, 7]),
        boundary_role_markers=(10, 7),
    )

    assert roles == ["material_interface", "exterior"]


def test_gmsh_prism6_node_order_has_an_explicit_canonical_permutation() -> None:
    assert _GMSH_TO_FULLMAG_NODE_PERMUTATION[6] == (0, 1, 2, 3, 4, 5)


def test_mixed_overlap_gate_detects_two_tetrahedra_on_the_same_face_side() -> None:
    mesh = MeshData(
        nodes=np.asarray(
            [
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [0.2, 0.2, 2.0],
            ]
        ),
        cell_types=np.asarray(["tet4", "tet4"]),
        cell_offsets=np.asarray([0, 4, 8]),
        cell_nodes=np.asarray([0, 1, 2, 3, 0, 1, 2, 4]),
        element_markers=np.asarray([0, 0]),
        facet_types=np.asarray([], dtype=np.str_),
        facet_roles=np.asarray([], dtype=np.str_),
        facet_offsets=np.asarray([0]),
        facet_nodes=np.asarray([], dtype=np.int32),
        boundary_markers=np.asarray([], dtype=np.int32),
        cell_global_ordinals=np.asarray([0, 1]),
        facet_global_ordinals=np.asarray([], dtype=np.int64),
    )

    assert _mixed_same_side_two_owner_face_count(mesh, tolerance=1.0e-12) == 1
    diagnostics = gmsh_types._mixed_mesh_conformity_diagnostics(
        mesh,
        tolerance=1.0e-12,
        limit=1,
    )
    assert diagnostics == [
        {
            "issue": "same_side_two_owner_face",
            "interface": "tet4_tet4",
            "node_ids": [0, 1, 2],
            "coordinates_m": [
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
            ],
            "owners": [
                {
                    "cell": 0,
                    "global_ordinal": 0,
                    "family": "tet4",
                    "marker": 0,
                    "mesh_part": "",
                },
                {
                    "cell": 1,
                    "global_ordinal": 1,
                    "family": "tet4",
                    "marker": 0,
                    "mesh_part": "",
                },
            ],
            "explicit_facets": [],
            "owner_signed_distances_m": [1.0, 2.0],
        }
    ]


@pytest.mark.parametrize(
    ("candidate", "expected"),
    [
        (np.asarray([0.0, 0.0, 0.25]), True),
        (np.asarray([0.0, 0.0, 2.0]), False),
        (np.asarray([0.0, 0.0, 1.0 - 1.0e-15]), False),
    ],
    ids=["legal", "same-side-crossing", "near-zero-fail-closed"],
)
def test_mixed_apex_candidate_preserves_signed_shared_face_sides(
    candidate: np.ndarray,
    expected: bool,
) -> None:
    coordinates = {
        0: np.asarray([0.0, 0.0, 0.0]),
        1: np.asarray([1.0, 0.0, 0.0]),
        2: np.asarray([0.0, 1.0, 0.0]),
        3: np.asarray([0.0, 0.0, 1.0]),
        4: np.asarray([0.0, 0.0, -1.0]),
    }
    shared_faces = [
        (
            (0, 1, 2),
            (
                np.asarray([0, 1, 2, 3], dtype=np.int64),
                np.asarray([0, 1, 2, 4], dtype=np.int64),
            ),
        )
    ]

    assert _mixed_apex_candidate_preserves_face_sides(
        coordinates,
        apex=0,
        candidate=candidate,
        shared_faces=shared_faces,
    ) is expected


def test_mixed_apex_local_star_includes_owner_opposite_face() -> None:
    first = np.asarray([0, 1, 2, 3], dtype=np.int64)
    second = np.asarray([0, 1, 2, 4], dtype=np.int64)
    shared_faces = _mixed_shared_faces_by_apex(
        {"tet4": [first, second]},
        apex_tags=[3],
    )
    coordinates = {
        0: np.asarray([0.0, 0.0, 0.0]),
        1: np.asarray([1.0, 0.0, 0.0]),
        2: np.asarray([0.0, 1.0, 0.0]),
        3: np.asarray([0.0, 0.0, 1.0]),
        4: np.asarray([0.0, 0.0, -1.0]),
    }

    assert shared_faces[3] == [((0, 1, 2), (first, second))]
    assert not _mixed_apex_candidate_preserves_face_sides(
        coordinates,
        apex=3,
        candidate=np.asarray([0.0, 0.0, -2.0]),
        shared_faces=shared_faces[3],
    )


@pytest.mark.parametrize(
    ("alpha", "expected"),
    [(0.25, True), (2.0, False), (1.0 - 1.0e-15, False)],
)
def test_precomputed_apex_face_constraints_match_geometric_guard(
    alpha: float,
    expected: bool,
) -> None:
    coordinates = {
        0: np.asarray([0.0, 0.0, 0.0]),
        1: np.asarray([1.0, 0.0, 0.0]),
        2: np.asarray([0.0, 1.0, 0.0]),
        3: np.asarray([0.0, 0.0, 1.0]),
        4: np.asarray([0.0, 0.0, -1.0]),
    }
    shared_faces = _mixed_shared_faces_by_apex(
        {
            "tet4": [
                np.asarray([0, 1, 2, 3], dtype=np.int64),
                np.asarray([0, 1, 2, 4], dtype=np.int64),
            ]
        },
        apex_tags=[0],
    )
    constraints = _prepare_mixed_apex_face_side_constraints(
        coordinates,
        directions={0: np.asarray([0.0, 0.0, 1.0])},
        shared_faces_by_apex=shared_faces,
    )

    assert len(constraints[0]) == len(shared_faces[0]) == 1
    assert _mixed_apex_factor_preserves_face_sides(
        constraints[0], alpha=alpha
    ) is expected


@pytest.mark.parametrize("face", [(0, 1, 2), (0, 1, 2, 3)], ids=["tri", "quad"])
@pytest.mark.parametrize("apex_role", ["face", "opposite"])
def test_affine_face_guard_exactly_matches_direct_oracle(
    face: tuple[int, ...],
    apex_role: str,
) -> None:
    coordinates = {
        0: np.asarray([0.0, 0.0, 0.0]),
        1: np.asarray([1.0, 0.0, 0.0]),
        2: np.asarray([0.0, 1.0, 0.0]),
        3: np.asarray([1.0, 1.0, 0.0]),
        4: np.asarray([0.25, 0.25, 1.0]),
        5: np.asarray([0.25, 0.25, -1.0]),
    }
    owners = (
        np.asarray([*face, 4], dtype=np.int64),
        np.asarray([*face, 5], dtype=np.int64),
    )
    apex = face[0] if apex_role == "face" else 4
    direction = (
        np.asarray([0.0, 0.0, 1.0])
        if apex_role == "face"
        else np.asarray([0.0, 0.0, -2.0])
    )
    shared_faces = {apex: [(face, owners)]}
    constraints = _prepare_mixed_apex_face_side_constraints(
        coordinates,
        directions={apex: direction},
        shared_faces_by_apex=shared_faces,
    )[apex]

    for alpha in (0.0, 0.25, 0.5, 1.0 - 1.0e-15, 1.0, 2.0):
        candidate = coordinates[apex] + alpha * direction
        direct = _mixed_apex_candidate_preserves_face_sides(
            coordinates,
            apex=apex,
            candidate=candidate,
            shared_faces=shared_faces[apex],
        )
        assert _mixed_apex_factor_preserves_face_sides(
            constraints, alpha=alpha
        ) is direct


def test_incremental_apex_constraint_iterator_observes_first_apex_move() -> None:
    coordinates = {
        0: np.asarray([0.0, 0.0, 0.0]),
        1: np.asarray([1.0, 0.0, 0.0]),
        2: np.asarray([0.0, 1.0, 0.0]),
        3: np.asarray([0.0, 0.0, 1.0]),
        4: np.asarray([0.0, 0.0, -1.0]),
    }
    owners = (
        np.asarray([0, 1, 2, 3], dtype=np.int64),
        np.asarray([0, 1, 2, 4], dtype=np.int64),
    )
    shared_faces = {
        0: [((0, 1, 2), owners)],
        3: [((0, 1, 2), owners)],
    }
    directions = {
        0: np.asarray([0.0, 0.0, 0.25]),
        3: np.asarray([0.0, 0.0, -2.0]),
    }
    stale = _prepare_mixed_apex_face_side_constraints(
        coordinates,
        directions={3: directions[3]},
        shared_faces_by_apex={3: shared_faces[3]},
    )[3]
    iterator = _iter_mixed_apex_face_side_constraints(
        coordinates,
        directions=directions,
        shared_faces_by_apex=shared_faces,
    )
    first_apex, _first_constraints = next(iterator)
    assert first_apex == 0
    coordinates[0] = coordinates[0] + directions[0]
    second_apex, fresh = next(iterator)
    assert second_apex == 3

    alpha = 0.4
    candidate = coordinates[3] + alpha * directions[3]
    direct = _mixed_apex_candidate_preserves_face_sides(
        coordinates,
        apex=3,
        candidate=candidate,
        shared_faces=shared_faces[3],
    )

    assert _mixed_apex_factor_preserves_face_sides(fresh, alpha=alpha) is direct
    assert _mixed_apex_factor_preserves_face_sides(stale, alpha=alpha) is not direct


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


def _mixed_shared_domain_case(
    *,
    axis: int = 2,
    layers: int = 1,
) -> tuple[tuple[float, float, float], fm.meshing.AirboxOptions, MeshData]:
    body_size = [4.0e-6, 2.0e-6, 0.2e-6]
    body_size[axis], body_size[2] = body_size[2], body_size[axis]
    airbox_size = tuple(value + 4.0e-6 for value in body_size)
    airbox = fm.meshing.AirboxOptions(
        shape="bbox",
        size=airbox_size,
        center=(0.0, 0.0, 0.0),
        boundary_marker=99,
        minimum_element_size=0.4e-6,
        maximum_element_size=1.2e-6,
        grading_ratio=1.3,
        grading_mode="geometric",
    )
    mesh = generate_swept_box_mesh(
        tuple(body_size),
        hmax=0.8e-6,
        n_layers=layers,
        thin_axis=axis,
        order=1,
        distribution="fixed",
        airbox=airbox,
        options=MeshOptions(mesh_strategy=SWEEP_STRATEGY_PRISM),
    )
    return tuple(body_size), airbox, mesh


def test_mixed_certificate_recompute_reuses_topology_workspace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("gmsh")
    body_size, airbox, certified = _mixed_shared_domain_case()
    mesh = replace(certified, mixed_layer_topology_certificate=None)
    certificate = certified.mixed_layer_topology_certificate
    assert certificate is not None
    assert airbox.size is not None
    original = MeshData.cell_node_ids
    cell_node_reads = 0

    def counted_cell_node_ids(self: MeshData, ordinal: int) -> np.ndarray:
        nonlocal cell_node_reads
        cell_node_reads += 1
        return original(self, ordinal)

    monkeypatch.setattr(MeshData, "cell_node_ids", counted_cell_node_ids)

    evidence = gmsh_types._recompute_mixed_certificate_evidence(
        mesh,
        sweep_axis=2,
        interface_marker=certificate.interface_marker,
        outer_boundary_marker=certificate.outer_boundary_marker,
        magnetic_bounds_min_m=tuple(-0.5 * value for value in body_size),
        magnetic_bounds_max_m=tuple(0.5 * value for value in body_size),
        airbox_bounds_min_m=tuple(-0.5 * value for value in airbox.size),
        airbox_bounds_max_m=tuple(0.5 * value for value in airbox.size),
    )

    assert evidence["nonconforming_face_count"] == 0
    assert cell_node_reads <= 2 * mesh.n_elements


@pytest.mark.parametrize("layers", [1, 2, 3])
def test_shared_domain_box_prism_mesh_has_exact_requested_layer(layers: int) -> None:
    pytest.importorskip("gmsh")
    body_size, _airbox, mesh = _mixed_shared_domain_case(layers=layers)

    magnetic_nodes = np.unique(
        np.concatenate(
            [
                mesh.cell_node_ids(index)
                for index, marker in enumerate(mesh.element_markers)
                if int(marker) == 1
            ]
        )
    )
    tolerance = max(1.0e-15, 1.0e-8 * body_size[2])
    planes: list[float] = []
    for coordinate in sorted(float(value) for value in mesh.nodes[magnetic_nodes, 2]):
        if not planes or abs(coordinate - planes[-1]) > tolerance:
            planes.append(coordinate)

    assert len(planes) == layers + 1
    assert mesh.mixed_layer_topology_certificate is not None
    certificate = mesh.mixed_layer_topology_certificate
    assert certificate.requested_layer_count == layers
    assert certificate.realized_layer_count == layers
    assert mesh.mixed_layer_topology_certificate.magnetic_plane_coordinates_m == pytest.approx(
        planes
    )
    assert set(mesh.cell_types[mesh.element_markers == 1].tolist()) == {"prism6"}
    assert set(mesh.cell_types[mesh.element_markers == 0].tolist()) == {
        "pyramid5",
        "tet4",
    }
    assert certificate.topology_fingerprint == mesh.topology_fingerprint_v3()
    assert certificate.fallbacks_triggered == ()


@pytest.mark.parametrize("layers", [0, 4])
def test_shared_domain_box_prism_rejects_layer_count_outside_bounded_set(
    monkeypatch: pytest.MonkeyPatch,
    layers: int,
) -> None:
    swept_module = importlib.import_module("fullmag.meshing._gmsh_swept")
    gmsh_import = Mock(side_effect=AssertionError("Gmsh started before validation"))
    monkeypatch.setattr(swept_module, "_import_gmsh", gmsh_import)

    with pytest.raises(ValueError, match="exactly 1, 2, or 3 layers"):
        _mixed_shared_domain_case(layers=layers)
    gmsh_import.assert_not_called()


@pytest.mark.parametrize("axis", [0, 1, 2])
def test_shared_domain_box_prism_mesh_supports_each_axis(axis: int) -> None:
    pytest.importorskip("gmsh")
    body_size, _airbox, mesh = _mixed_shared_domain_case(axis=axis)

    certificate = mesh.mixed_layer_topology_certificate
    assert certificate is not None
    assert certificate.requested_sweep_direction == "xyz"[axis]
    assert certificate.resolved_sweep_direction == "xyz"[axis]
    assert certificate.requested_layer_count == 1
    assert certificate.realized_layer_count == 1
    assert len(certificate.magnetic_plane_coordinates_m) == 2
    assert certificate.magnetic_plane_coordinates_m == pytest.approx(
        (-body_size[axis] / 2.0, body_size[axis] / 2.0)
    )


_CANONICAL_CELL_FACES = {
    "tet4": ((0, 1, 2), (0, 1, 3), (0, 2, 3), (1, 2, 3)),
    "prism6": (
        (0, 1, 2),
        (3, 5, 4),
        (0, 3, 4, 1),
        (1, 4, 5, 2),
        (2, 5, 3, 0),
    ),
    "pyramid5": (
        (0, 3, 2, 1),
        (0, 1, 4),
        (1, 2, 4),
        (2, 3, 4),
        (3, 0, 4),
    ),
}


def _shared_domain_face_owners(
    mesh: MeshData,
) -> dict[tuple[int, ...], list[tuple[int, str]]]:
    owners: dict[tuple[int, ...], list[tuple[int, str]]] = {}
    for cell_index, cell_type in enumerate(mesh.cell_types.tolist()):
        cell = mesh.cell_node_ids(cell_index)
        for local_face in _CANONICAL_CELL_FACES[cell_type]:
            key = tuple(sorted(int(cell[index]) for index in local_face))
            owners.setdefault(key, []).append(
                (int(mesh.element_markers[cell_index]), str(cell_type))
            )
    return owners


def test_occ_tet_shared_domain_preserves_facet_roles_after_si_scaling() -> None:
    pytest.importorskip("gmsh")
    airbox = fm.meshing.AirboxOptions(
        size=(8.0e-6, 6.0e-6, 4.0e-6),
        center=(0.0, 0.0, 0.0),
        minimum_element_size=0.8e-6,
        maximum_element_size=1.6e-6,
    )
    mesh = generate_shared_domain_mesh_via_occ(
        [fm.Box((4.0e-6, 2.0e-6, 1.0e-6), name="film")],
        hmax=0.8e-6,
        airbox=airbox,
        options=MeshOptions(compute_quality=False, per_element_quality=False),
    ).mesh
    owners = _shared_domain_face_owners(mesh)
    interfaces = {
        tuple(sorted(int(node) for node in mesh.facet_node_ids(index)))
        for index, role in enumerate(mesh.facet_roles.tolist())
        if role == "material_interface"
    }
    exterior = {
        tuple(sorted(int(node) for node in mesh.facet_node_ids(index)))
        for index, role in enumerate(mesh.facet_roles.tolist())
        if role == "exterior"
    }

    assert interfaces
    assert all(
        len(owners[face]) == 2
        and {marker for marker, _family in owners[face]} == {0, 1}
        for face in interfaces
    )
    assert all(len(owners[face]) == 1 for face in exterior)


def test_shared_domain_box_preserves_family_marker_and_facet_partition() -> None:
    pytest.importorskip("gmsh")
    _body_size, airbox, mesh = _mixed_shared_domain_case()
    owners = _shared_domain_face_owners(mesh)

    assert set(mesh.cell_types.tolist()) == {"prism6", "pyramid5", "tet4"}
    assert all(
        (cell_type == "prism6" and int(marker) == 1)
        or (cell_type in {"pyramid5", "tet4"} and int(marker) == 0)
        for cell_type, marker in zip(
            mesh.cell_types.tolist(), mesh.element_markers.tolist(), strict=True
        )
    )

    interface_faces = {
        tuple(sorted(int(node) for node in mesh.facet_node_ids(index)))
        for index, (role, marker) in enumerate(
            zip(mesh.facet_roles.tolist(), mesh.boundary_markers.tolist(), strict=True)
        )
        if role == "material_interface" and int(marker) == 10
    }
    outer_faces = {
        tuple(sorted(int(node) for node in mesh.facet_node_ids(index)))
        for index, (role, marker) in enumerate(
            zip(mesh.facet_roles.tolist(), mesh.boundary_markers.tolist(), strict=True)
        )
        if role == "exterior" and int(marker) == airbox.boundary_marker
    }
    quad_interface_faces = {
        tuple(sorted(int(node) for node in mesh.facet_node_ids(index)))
        for index, (kind, role) in enumerate(
            zip(mesh.facet_types.tolist(), mesh.facet_roles.tolist(), strict=True)
        )
        if kind == "quad4" and role == "material_interface"
    }
    pyramid_quad_faces = {
        tuple(sorted(int(cell[index]) for index in _CANONICAL_CELL_FACES["pyramid5"][0]))
        for cell_index, cell_type in enumerate(mesh.cell_types.tolist())
        if cell_type == "pyramid5"
        for cell in [mesh.cell_node_ids(cell_index)]
    }

    assert interface_faces
    assert outer_faces
    assert pyramid_quad_faces
    assert pyramid_quad_faces.issubset(quad_interface_faces)
    assert all(
        len(owners[face]) == 2
        and {marker for marker, _family in owners[face]} == {0, 1}
        for face in interface_faces
    )
    assert all(len(owners[face]) == 1 for face in outer_faces)
    assert {face for face, adjacency in owners.items() if len(adjacency) == 1} == outer_faces
    assert len(interface_faces) == len(set(interface_faces))

    certificate = mesh.mixed_layer_topology_certificate
    assert certificate is not None
    assert certificate.certificate_status == "accepted"
    assert certificate.cell_family_counts_by_marker["1"] == {
        "prism6": int(np.count_nonzero(mesh.cell_types == "prism6"))
    }
    assert certificate.cell_family_counts_by_marker["0"] == {
        "pyramid5": int(np.count_nonzero(mesh.cell_types == "pyramid5")),
        "tet4": int(np.count_nonzero(mesh.cell_types == "tet4")),
    }
    transition_counts = certificate.cell_family_counts_by_part["transition_air"]
    far_counts = certificate.cell_family_counts_by_part["far_air"]
    assert transition_counts["pyramid5"] == int(
        np.count_nonzero(mesh.cell_types == "pyramid5")
    )
    assert transition_counts.get("tet4", 0) > 0
    assert set(far_counts) == {"tet4"}
    assert transition_counts["tet4"] + far_counts["tet4"] == int(
        np.count_nonzero(mesh.cell_types == "tet4")
    )
    assert certificate.transition_shell_interface_tri3_count > 0
    assert certificate.transition_shell_thickness_m == pytest.approx(0.8e-6)
    assert certificate.nonconforming_face_count == 0
    assert certificate.orphan_face_count == 0
    assert certificate.nonmanifold_face_count == 0
    assert certificate.coincident_interface_face_count == 0
    assert certificate.marker_coverage_complete is True
    assert certificate.fallbacks_triggered == ()


@pytest.mark.parametrize(
    ("airbox", "options", "message"),
    [
        (fm.meshing.AirboxOptions(shape="sphere"), MeshOptions(), "bbox"),
        (
            fm.meshing.AirboxOptions(size=(8.0e-6, 6.0e-6, 4.0e-6)),
            MeshOptions(periodic_pair_ids=["x"]),
            "periodic",
        ),
    ],
)
def test_shared_domain_box_rejects_unsupported_request_before_gmsh(
    monkeypatch: pytest.MonkeyPatch,
    airbox: fm.meshing.AirboxOptions,
    options: MeshOptions,
    message: str,
) -> None:
    swept_module = importlib.import_module("fullmag.meshing._gmsh_swept")
    gmsh_import = Mock(side_effect=AssertionError("Gmsh started before validation"))
    monkeypatch.setattr(swept_module, "_import_gmsh", gmsh_import)

    with pytest.raises(ValueError, match=message):
        generate_swept_box_mesh(
            (4.0e-6, 2.0e-6, 0.2e-6),
            hmax=0.8e-6,
            n_layers=1,
            airbox=airbox,
            options=options,
        )
    gmsh_import.assert_not_called()


def test_shared_domain_topology_fingerprint_is_deterministic() -> None:
    pytest.importorskip("gmsh")
    first = _mixed_shared_domain_case()[2]
    second = _mixed_shared_domain_case()[2]

    first_certificate = first.mixed_layer_topology_certificate
    second_certificate = second.mixed_layer_topology_certificate
    assert first_certificate is not None
    assert second_certificate is not None
    assert first_certificate.topology_fingerprint_version == "v3"
    assert first_certificate.topology_fingerprint.startswith("sha256:")
    assert first_certificate.topology_fingerprint == second_certificate.topology_fingerprint


@pytest.mark.parametrize("layers", [1, 2, 3])
def test_shared_domain_box_asset_pipeline_routes_to_strict_mixed_geo_path(
    layers: int,
) -> None:
    pytest.importorskip("gmsh")
    from fullmag.meshing.asset_pipeline import (
        _realize_fem_domain_mesh_asset_from_components_impl,
    )

    mesh, region_markers, report = (
        _realize_fem_domain_mesh_asset_from_components_impl(
            [fm.Box(size=(4.0e-6, 2.0e-6, 0.2e-6), name="magnet")],
            fm.FEM(order=1, hmax=0.8e-6),
            study_universe={
                "mode": "manual",
                "size": [8.0e-6, 6.0e-6, 4.2e-6],
                "center": [0.0, 0.0, 0.0],
                "airbox_hmin": 0.4e-6,
                "airbox_hmax": 1.2e-6,
                "airbox_growth_rate": 1.3,
                "airbox_grading": "geometric",
            },
            mesh_workflow={
                "mesh_options": {
                    "mesh_strategy": "swept_prism",
                    "through_thickness_elements": layers,
                    "through_thickness_distribution": "fixed",
                }
            },
        )
    )

    assert report.build_mode == "single_geometry_geo_mixed"
    assert report.fallbacks_triggered == []
    assert region_markers == [{"geometry_name": "magnet", "marker": 1}]
    assert mesh.mixed_layer_topology_certificate is not None
    certificate = mesh.mixed_layer_topology_certificate
    assert certificate.requested_layer_count == layers
    assert certificate.realized_layer_count == layers
    assert len(certificate.magnetic_plane_coordinates_m) == layers + 1
    assert certificate.topology_fingerprint == mesh.topology_fingerprint_v3()
    assert certificate.fallbacks_triggered == ()
    assert report.degraded is False
    assert set(mesh.cell_types.tolist()) == {"prism6", "pyramid5", "tet4"}


def test_public_prismatic_thin_film_materializes_qualified_mixed_asset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("gmsh")
    conformity_calls = 0
    original_conformity_counts = gmsh_types._mixed_mesh_conformity_counts

    def counted_conformity(*args, **kwargs):
        nonlocal conformity_calls
        conformity_calls += 1
        return original_conformity_counts(*args, **kwargs)

    monkeypatch.setattr(
        gmsh_types, "_mixed_mesh_conformity_counts", counted_conformity
    )
    monkeypatch.setenv("FULLMAG_FEM_MESH_CACHE_DIR", "")
    fm.reset()
    study = fm.study("public-prismatic-asset")
    study.engine("fem")
    study.mode("strict")
    study.universe(
        mode="manual",
        size=(100e-9, 80e-9, 65e-9),
        center=(0.0, 0.0, 0.0),
    )
    study.universe.mesh(
        maximum_element_size=40e-9,
        minimum_element_size=15e-9,
        growth_rate=1.3,
        grading="geometric",
    )
    film = study.geometry(
        fm.Box(size=(24e-9, 12e-9, 1e-9), name="magnet"),
        name="magnet",
    )
    film.Ms = 800e3
    film.Aex = 13e-12
    film.alpha = 0.1
    film.mesh.thin_film(
        maximum_element_size=3e-9,
        minimum_element_size=1e-9,
        interface_maximum_element_size=2e-9,
        interface_thickness=2e-9,
        transition_distance=3e-9,
        edge_maximum_element_size=1.5e-9,
        edge_thickness=2e-9,
        edge_transition_distance=3e-9,
        corner_maximum_element_size=1e-9,
        corner_extent=2e-9,
        corner_transition_distance=3e-9,
        layers=1,
        topology="prismatic",
        exact_layers=True,
        transition="pyramid_to_tetrahedra",
        order=1,
    )

    problem = flat_world._build_problem()
    workflow = problem.runtime_metadata["mesh_workflow"]
    assert workflow["per_geometry"] == [
        {
            "geometry": "magnet",
            "mode": "custom",
            "hmax": 3e-9,
            "maximum_element_size": 3e-9,
            "hmin": 1e-9,
            "minimum_element_size": 1e-9,
            "order": 1,
            "interface_hmax": 2e-9,
            "interface_thickness": 2e-9,
            "transition_distance": 3e-9,
            "edge_hmax": 1.5e-9,
            "edge_thickness": 2e-9,
            "edge_transition_distance": 3e-9,
            "corner_hmax": 1e-9,
            "corner_extent": 2e-9,
            "corner_transition_distance": 3e-9,
            "mesh_strategy": "swept_prism",
            "through_thickness_elements": 1,
            "through_thickness_distribution": "fixed",
            "sweep_face_meshing": "triangular",
            "topology": "prismatic",
            "sweep_direction": "auto",
            "element_family": "prism",
            "transition_policy": "pyramid_to_tetrahedra",
            "exact_layer_count": True,
        }
    ]

    ir = problem.to_ir(requested_backend=fm.BackendTarget.FEM)
    domain_asset = ir["geometry_assets"]["fem_domain_mesh_asset"]
    mesh = domain_asset["mesh"]
    assert set(mesh["cells"]["types"]) == {"prism6", "pyramid5", "tet4"}
    build_report = domain_asset["build_report"]
    assert build_report["build_mode"] == "single_geometry_geo_mixed"
    assert build_report["fallbacks_triggered"] == []
    realized_fields = build_report["size_fields_realized"]
    assert realized_fields
    assert all(field["status"] == "applied" for field in realized_fields)
    assert {
        "ComponentVolumeConstant",
        "InterfaceShellThreshold",
        "TransitionShellThreshold",
        "EdgeDistanceThreshold",
        "CornerDistanceThreshold",
    }.issubset({field["kind"] for field in realized_fields})
    certificate = mesh["mixed_layer_topology_certificate"]
    assert certificate["realized_layer_count"] == 1
    assert certificate["fallbacks_triggered"] == []
    assert len(certificate["magnetic_plane_coordinates_m"]) == 2
    assert certificate["shared_domain_relative_volume_error"] <= 1.0e-8
    assert certificate["nonconforming_face_count"] == 0
    assert certificate["strategy"] == (
        "shared_geo_extrusion_partitioned_pyramid_tet.v2"
    )
    assert certificate["deterministic_inputs"]["transition_volume_count"] == 26
    assert conformity_calls <= 3

    nodes = np.asarray(mesh["nodes"], dtype=np.float64)
    cell_types = mesh["cells"]["types"]
    cell_offsets = mesh["cells"]["offsets"]
    cell_nodes = mesh["cells"]["nodes"]
    mesh_parts = mesh["cells"]["mesh_parts"]
    assert all(
        cell_type == "prism6"
        for cell_type, mesh_part in zip(cell_types, mesh_parts)
        if mesh_part == "magnetic"
    )
    assert all(
        cell_type in {"pyramid5", "tet4"}
        for cell_type, mesh_part in zip(cell_types, mesh_parts)
        if mesh_part == "transition_air"
    )
    assert all(
        cell_type == "tet4"
        for cell_type, mesh_part in zip(cell_types, mesh_parts)
        if mesh_part == "far_air"
    )
    bottom_z = min(certificate["magnetic_plane_coordinates_m"])
    in_plane_edges: set[tuple[int, int]] = set()
    magnetic_node_ids: set[int] = set()
    far_air_edges: set[tuple[int, int]] = set()
    for index, (cell_type, mesh_part) in enumerate(zip(cell_types, mesh_parts)):
        cell = cell_nodes[cell_offsets[index] : cell_offsets[index + 1]]
        if mesh_part == "far_air":
            far_air_edges.update(
                tuple(sorted((node_a, node_b)))
                for node_a, node_b in itertools.combinations(cell, 2)
            )
        if cell_type != "prism6" or mesh_part != "magnetic":
            continue
        prism = cell
        magnetic_node_ids.update(prism)
        bottom = [node for node in prism if np.isclose(nodes[node, 2], bottom_z, atol=1e-15)]
        assert len(bottom) == 3
        for offset, node_a in enumerate(bottom):
            node_b = bottom[(offset + 1) % 3]
            in_plane_edges.add(tuple(sorted((node_a, node_b))))
    edge_lengths = np.asarray(
        [np.linalg.norm(nodes[a, :2] - nodes[b, :2]) for a, b in in_plane_edges]
    )
    assert edge_lengths.min() < 2.5e-9
    assert edge_lengths.max() > edge_lengths.min() * 1.2
    assert set(
        np.round(nodes[sorted(magnetic_node_ids), 2], decimals=15).tolist()
    ) == set(
        np.round(certificate["magnetic_plane_coordinates_m"], decimals=15).tolist()
    )
    far_air_edge_lengths = np.asarray(
        [np.linalg.norm(nodes[a] - nodes[b]) for a, b in far_air_edges]
    )
    assert np.percentile(far_air_edge_lengths, 50.0) > edge_lengths.max() * 2.0


def _public_prismatic_refinement_asset(
    *,
    refined: bool,
    transition_distance: float = 3e-9,
    interface_thickness: float = 2e-9,
) -> dict[str, object]:
    fm.reset()
    study = fm.study("public-prismatic-refinement-pair")
    study.engine("fem")
    study.mode("strict")
    study.universe(
        mode="manual",
        size=(100e-9, 80e-9, 65e-9),
        center=(0.0, 0.0, 0.0),
    )
    study.universe.mesh(
        maximum_element_size=40e-9,
        minimum_element_size=15e-9,
        growth_rate=1.3,
        grading="geometric",
    )
    film = study.geometry(
        fm.Box(size=(24e-9, 12e-9, 1e-9), name="magnet"),
        name="magnet",
    )
    film.Ms = 800e3
    film.Aex = 13e-12
    film.alpha = 0.1
    film.mesh.thin_film(
        maximum_element_size=3e-9,
        minimum_element_size=1e-9,
        interface_maximum_element_size=2e-9 if refined else 3e-9,
        interface_thickness=interface_thickness,
        transition_distance=transition_distance,
        edge_maximum_element_size=1.5e-9 if refined else 3e-9,
        edge_thickness=2e-9,
        edge_transition_distance=3e-9,
        corner_maximum_element_size=1e-9 if refined else 3e-9,
        corner_extent=2e-9,
        corner_transition_distance=3e-9,
        layers=1,
        topology="prismatic",
        exact_layers=True,
        transition="pyramid_to_tetrahedra",
        order=1,
    )
    problem = flat_world._build_problem()
    return problem.to_ir(requested_backend=fm.BackendTarget.FEM)["geometry_assets"][
        "fem_domain_mesh_asset"
    ]


def _mixed_asset_edge_lengths(
    asset: dict[str, object], *, mesh_part: str
) -> np.ndarray:
    mesh = asset["mesh"]
    nodes = np.asarray(mesh["nodes"], dtype=np.float64)
    cells = mesh["cells"]
    edges: set[tuple[int, int]] = set()
    for index, part in enumerate(cells["mesh_parts"]):
        if part != mesh_part:
            continue
        cell = cells["nodes"][cells["offsets"][index] : cells["offsets"][index + 1]]
        if mesh_part == "magnetic":
            bottom_z = min(mesh["mixed_layer_topology_certificate"]["magnetic_plane_coordinates_m"])
            cell = [node for node in cell if np.isclose(nodes[node, 2], bottom_z, atol=1e-15)]
        edges.update(
            tuple(sorted((node_a, node_b)))
            for node_a, node_b in itertools.combinations(cell, 2)
        )
    return np.asarray([np.linalg.norm(nodes[a] - nodes[b]) for a, b in edges])


def _magnetic_source_edge_regions(
    asset: dict[str, object],
) -> dict[str, np.ndarray]:
    mesh = asset["mesh"]
    nodes = np.asarray(mesh["nodes"], dtype=np.float64)
    cells = mesh["cells"]
    bottom_z = min(
        mesh["mixed_layer_topology_certificate"]["magnetic_plane_coordinates_m"]
    )
    edges: set[tuple[int, int]] = set()
    for index, part in enumerate(cells["mesh_parts"]):
        if part != "magnetic":
            continue
        prism = cells["nodes"][
            cells["offsets"][index] : cells["offsets"][index + 1]
        ]
        bottom = [
            node
            for node in prism
            if np.isclose(nodes[node, 2], bottom_z, atol=1e-15)
        ]
        edges.update(
            tuple(sorted((node_a, node_b)))
            for node_a, node_b in itertools.combinations(bottom, 2)
        )

    regions: dict[str, list[float]] = {"corner": [], "edge": [], "center": []}
    for node_a, node_b in edges:
        midpoint = 0.5 * (nodes[node_a] + nodes[node_b])
        distance_x = 12e-9 - abs(float(midpoint[0]))
        distance_y = 6e-9 - abs(float(midpoint[1]))
        if distance_x <= 2e-9 and distance_y <= 2e-9:
            region = "corner"
        elif min(distance_x, distance_y) <= 2e-9:
            region = "edge"
        elif distance_x >= 5e-9 and distance_y >= 3e-9:
            region = "center"
        else:
            continue
        regions[region].append(float(np.linalg.norm(nodes[node_a] - nodes[node_b])))
    return {
        region: np.asarray(lengths, dtype=np.float64)
        for region, lengths in regions.items()
    }


def test_public_local_refinement_changes_source_mesh_without_collapsing_air_grading(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("gmsh")
    monkeypatch.setenv("FULLMAG_FEM_MESH_CACHE_DIR", "")
    neutral = _public_prismatic_refinement_asset(refined=False)
    refined = _public_prismatic_refinement_asset(refined=True)

    neutral_certificate = neutral["mesh"]["mixed_layer_topology_certificate"]
    refined_certificate = refined["mesh"]["mixed_layer_topology_certificate"]
    neutral_prisms = neutral_certificate["cell_family_counts_by_part"]["magnetic"]["prism6"]
    refined_prisms = refined_certificate["cell_family_counts_by_part"]["magnetic"]["prism6"]
    neutral_magnetic_edges = _mixed_asset_edge_lengths(neutral, mesh_part="magnetic")
    refined_magnetic_edges = _mixed_asset_edge_lengths(refined, mesh_part="magnetic")
    neutral_far_edges = _mixed_asset_edge_lengths(neutral, mesh_part="far_air")
    refined_far_edges = _mixed_asset_edge_lengths(refined, mesh_part="far_air")
    neutral_regions = _magnetic_source_edge_regions(neutral)
    refined_regions = _magnetic_source_edge_regions(refined)

    assert refined_prisms > neutral_prisms
    assert np.percentile(refined_magnetic_edges, 25.0) < np.percentile(
        neutral_magnetic_edges, 25.0
    )
    for region in ("corner", "edge", "center"):
        assert len(neutral_regions[region]) > 0
        assert len(refined_regions[region]) > 0
        assert np.percentile(refined_regions[region], 50.0) < np.percentile(
            neutral_regions[region], 50.0
        )
    assert np.percentile(refined_regions["corner"], 50.0) < np.percentile(
        refined_regions["edge"], 50.0
    ) < np.percentile(refined_regions["center"], 50.0)
    assert neutral["build_report"]["effective_airbox_target"] == refined[
        "build_report"
    ]["effective_airbox_target"] == {
        "hmax": 40e-9,
        "hmin": 15e-9,
        "growth_rate": 1.3,
    }
    assert np.percentile(neutral_far_edges, 50.0) > neutral_magnetic_edges.max() * 2.0
    assert np.percentile(refined_far_edges, 50.0) > refined_magnetic_edges.max() * 2.0


@pytest.mark.parametrize(
    ("control", "short_value", "long_value"),
    (
        ("transition_distance", 5e-9, 22e-9),
        ("interface_thickness", 1e-9, 8e-9),
    ),
)
def test_public_interface_ramp_controls_change_transition_air_realization(
    monkeypatch: pytest.MonkeyPatch,
    control: str,
    short_value: float,
    long_value: float,
) -> None:
    pytest.importorskip("gmsh")
    monkeypatch.setenv("FULLMAG_FEM_MESH_CACHE_DIR", "")
    short = _public_prismatic_refinement_asset(refined=True, **{control: short_value})
    long = _public_prismatic_refinement_asset(refined=True, **{control: long_value})

    short_certificate = short["mesh"]["mixed_layer_topology_certificate"]
    long_certificate = long["mesh"]["mixed_layer_topology_certificate"]
    short_transition_count = sum(
        short_certificate["cell_family_counts_by_part"]["transition_air"].values()
    )
    long_transition_count = sum(
        long_certificate["cell_family_counts_by_part"]["transition_air"].values()
    )
    assert long_certificate["topology_fingerprint"] != short_certificate[
        "topology_fingerprint"
    ]
    assert long_transition_count > short_transition_count


@pytest.mark.parametrize(
    "case",
    [
        "multiple",
        "non_box",
        "object_regions",
        "per_object",
        "per_geometry",
        "size_fields",
        "boundary_layer",
        "optimizer",
        "algorithm",
        "order",
        "layers",
        "distribution",
        "sweep_face",
        "recombine",
        "periodic",
    ],
)
def test_asset_mixed_route_rejects_unqualified_requests_before_generator(
    monkeypatch: pytest.MonkeyPatch,
    case: str,
) -> None:
    asset_pipeline = importlib.import_module("fullmag.meshing.asset_pipeline")
    generate_mesh = Mock(side_effect=AssertionError("mesh generator must not run"))
    monkeypatch.setattr(asset_pipeline, "generate_mesh", generate_mesh)

    geometries = [fm.Box(size=(4e-6, 2e-6, 0.2e-6), name="magnet")]
    hints = fm.FEM(order=1, hmax=0.8e-6)
    mesh_options: dict[str, object] = {
        "mesh_strategy": "swept_prism",
        "through_thickness_elements": 1,
        "through_thickness_distribution": "fixed",
    }
    workflow: dict[str, object] = {"mesh_options": mesh_options}
    kwargs: dict[str, object] = {}
    if case == "multiple":
        geometries.append(fm.Box(size=(1e-6, 1e-6, 0.2e-6), name="other"))
    elif case == "non_box":
        geometries = [fm.Cylinder(radius=2e-6, height=0.2e-6, name="magnet")]
    elif case == "object_regions":
        kwargs["object_regions"] = [{"enabled": False}]
    elif case == "per_object":
        kwargs["per_object_recipes"] = {"magnet": object()}
    elif case == "per_geometry":
        workflow["per_geometry"] = [{"geometry": "magnet", "hmax": 0.4e-6}]
    elif case == "size_fields":
        mesh_options["size_fields"] = [{"kind": "Box", "params": {}}]
    elif case == "boundary_layer":
        mesh_options["boundary_layer_count"] = 2
    elif case == "optimizer":
        mesh_options["optimize"] = "Netgen"
    elif case == "algorithm":
        mesh_options["algorithm_3d"] = 10
    elif case == "order":
        hints = fm.FEM(order=2, hmax=0.8e-6)
    elif case == "layers":
        mesh_options["through_thickness_elements"] = 4
    elif case == "distribution":
        mesh_options["through_thickness_distribution"] = "linear"
    elif case == "sweep_face":
        mesh_options["sweep_face_meshing"] = "quadrilateral"
    elif case == "recombine":
        mesh_options["recombine"] = True
    elif case == "periodic":
        mesh_options["periodic_pair_ids"] = ["x"]

    with pytest.raises(ValueError, match="qualified mixed shared-domain route rejects"):
        asset_pipeline._realize_fem_domain_mesh_asset_from_components_impl(
            geometries,
            hints,
            study_universe={
                "mode": "manual",
                "size": [8e-6, 6e-6, 4.2e-6],
                "center": [0.0, 0.0, 0.0],
            },
            mesh_workflow=workflow,
            **kwargs,
        )
    generate_mesh.assert_not_called()


def test_mixed_route_forces_one_effective_gmsh_thread_despite_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("gmsh")
    monkeypatch.setenv("FULLMAG_GMSH_THREADS", "8")
    monkeypatch.setenv("FULLMAG_CPU_THREADS", "8")
    certificate = _mixed_shared_domain_case()[2].mixed_layer_topology_certificate
    assert certificate is not None
    assert certificate.effective_gmsh_thread_count == 1
    assert certificate.deterministic_inputs == {
        "algorithm_2d": 6,
        "algorithm_3d": 1,
        "element_order": 1,
        "gmsh_version": "4.15.2",
        "random_factor": 0.0,
        "thread_count": 1,
        "transition_partition": "cartesian_3x3x3_minus_magnetic_center",
        "transition_volume_count": 26,
        "pyramid_apex_optimizer": "bounded_per_apex_outward_scale_line_search",
        "pyramid_apex_scale_step": 0.001,
        "pyramid_apex_scale_max": 1.25,
        "scaled_jacobian_p05_min": 0.1,
    }


@pytest.mark.parametrize("suffix", [".json", ".npz"])
def test_mesh_load_rejects_stale_mixed_layer_topology_certificate(
    tmp_path: Path,
    suffix: str,
) -> None:
    pytest.importorskip("gmsh")
    mesh = _mixed_shared_domain_case()[2]
    path = tmp_path / f"stale-certificate{suffix}"
    mesh.save(path)
    if suffix == ".json":
        payload = json.loads(path.read_text(encoding="utf-8"))
        payload["mixed_layer_topology_certificate"]["topology_fingerprint"] = (
            "sha256:" + "0" * 64
        )
        path.write_text(json.dumps(payload), encoding="utf-8")
    else:
        with np.load(path) as archive:
            payload = {name: archive[name] for name in archive.files}
        certificate = json.loads(str(payload["mixed_layer_topology_certificate_json"]))
        certificate["topology_fingerprint"] = "sha256:" + "0" * 64
        payload["mixed_layer_topology_certificate_json"] = np.asarray(
            json.dumps(certificate)
        )
        np.savez_compressed(path, **payload)

    with pytest.raises(ValueError, match="topology fingerprint.*stale"):
        MeshData.load(path)


def test_mixed_layer_topology_certificate_survives_owned_mesh_paths(
    tmp_path: Path,
) -> None:
    pytest.importorskip("gmsh")
    mesh = _mixed_shared_domain_case()[2]
    certificate = mesh.mixed_layer_topology_certificate
    assert certificate is not None

    for suffix in (".json", ".npz"):
        path = tmp_path / f"mixed-shared{suffix}"
        mesh.save(path)
        assert MeshData.load(path).mixed_layer_topology_certificate == certificate
    assert mesh.oriented_copy().mixed_layer_topology_certificate == certificate
    assert mesh.to_ir("shared_domain")["mixed_layer_topology_certificate"] == (
        certificate.to_dict()
    )


def _mixed_remesh_transport_mesh() -> Mock:
    mesh = Mock()
    mesh.nodes = np.asarray(
        [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 1.0],
            [0.0, 1.0, 1.0],
            [3.0, -1.0, 0.0],
            [5.0, -1.0, 0.0],
            [5.0, 1.0, 0.0],
            [3.0, 1.0, 0.0],
            [4.0, 0.0, 1.0],
            [7.0, 0.0, 0.0],
            [8.0, 0.0, 0.0],
            [7.0, 1.0, 0.0],
            [7.0, 0.0, 1.0],
        ]
    )
    mesh.cell_types = np.asarray(["prism6", "pyramid5", "tet4"])
    mesh.cell_offsets = np.asarray([0, 6, 11, 15])
    mesh.cell_nodes = np.arange(15)
    mesh.cell_global_ordinals = np.asarray([0, 1, 2])
    mesh.cell_mesh_parts = np.asarray(["magnetic", "transition_air", "far_air"])
    mesh.element_markers = np.asarray([1, 0, 0])
    mesh.facet_types = np.asarray(["tri3", "quad4", "quad4", "tri3"])
    mesh.facet_roles = np.asarray(
        ["material_interface", "exterior", "exterior", "exterior"]
    )
    mesh.facet_offsets = np.asarray([0, 3, 7, 11, 14])
    mesh.facet_nodes = np.asarray(
        [0, 1, 2, 0, 1, 4, 3, 6, 7, 8, 9, 11, 12, 13]
    )
    mesh.facet_global_ordinals = np.asarray([0, 1, 2, 3])
    mesh.boundary_markers = np.asarray([2, 3, 3, 3])
    mesh.periodic_boundary_pairs = []
    mesh.periodic_node_pairs = []
    mesh.periodic_mesh_certificate = None
    mesh.quality = None
    mesh.mixed_layer_topology_certificate.to_dict.return_value = {
        "schema_version": "mixed_layer_topology_certificate.v1",
        "certificate_status": "accepted",
        "topology_fingerprint_version": "v2",
        "topology_fingerprint": "sha256:" + "1" * 64,
    }
    mesh.oriented_copy.return_value = mesh
    return mesh


def test_topology_fingerprint_v2_matches_the_frozen_cross_language_fixture() -> None:
    mesh = MeshData(
        nodes=np.asarray(
            [
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ]
        ),
        cell_types=np.asarray(["tet4"]),
        cell_offsets=np.asarray([0, 4]),
        cell_nodes=np.asarray([0, 1, 2, 3]),
        cell_global_ordinals=np.asarray([0]),
        cell_mesh_parts=np.asarray(["magnetic"]),
        element_markers=np.asarray([1]),
        facet_types=np.asarray([], dtype=np.str_),
        facet_roles=np.asarray([], dtype=np.str_),
        facet_offsets=np.asarray([0]),
        facet_nodes=np.asarray([], dtype=np.int64),
        facet_global_ordinals=np.asarray([], dtype=np.int64),
        boundary_markers=np.asarray([], dtype=np.int64),
    )

    assert mesh.topology_fingerprint_v2() == (
        "sha256:2071f6b9a2bf468fc82296f34744b07475315a5f0d26c5b06e52b54064f474e2"
    )


def _topology_fingerprint_v3_cross_language_fixture() -> MeshData:
    mesh = MeshData(
        nodes=np.asarray(
            [
                [0.0, -0.0, 1.0e-7],
                [1.0e-5, 3.0e-9, 1.0e20],
                [float.fromhex("0x1.5555555555555p-2"), 1.0, 2.0],
                *[[float(index), 0.0, 0.0] for index in range(3, 23)],
            ]
        ),
        cell_types=np.asarray(["tet4"]),
        cell_offsets=np.asarray([0, 4]),
        cell_nodes=np.asarray([0, 1, 2, 3]),
        cell_global_ordinals=np.asarray([0]),
        cell_mesh_parts=np.asarray(["magnetic"]),
        element_markers=np.asarray([1]),
        facet_types=np.asarray([], dtype=np.str_),
        facet_roles=np.asarray([], dtype=np.str_),
        facet_offsets=np.asarray([0]),
        facet_nodes=np.asarray([], dtype=np.int64),
        facet_global_ordinals=np.asarray([], dtype=np.int64),
        boundary_markers=np.asarray([], dtype=np.int64),
    )
    object.__setattr__(mesh, "cell_types", np.asarray(["tet4", "prism6", "pyramid5", "hex8"]))
    object.__setattr__(mesh, "cell_offsets", np.asarray([0, 4, 10, 15, 23]))
    object.__setattr__(mesh, "cell_nodes", np.arange(23, dtype=np.int32))
    object.__setattr__(mesh, "cell_global_ordinals", np.asarray([9, 8, 7, 6]))
    object.__setattr__(
        mesh,
        "cell_mesh_parts",
        np.asarray(["magnetic", "transition_air", "far_air", "magnetic"]),
    )
    object.__setattr__(mesh, "element_markers", np.asarray([1, 0, 0, 4]))
    object.__setattr__(mesh, "facet_types", np.asarray(["tri3", "quad4", "tri3"]))
    object.__setattr__(
        mesh,
        "facet_roles",
        np.asarray(["exterior", "material_interface", "periodic_seam"]),
    )
    object.__setattr__(mesh, "facet_offsets", np.asarray([0, 3, 7, 10]))
    object.__setattr__(mesh, "facet_nodes", np.arange(10, dtype=np.int32))
    object.__setattr__(mesh, "facet_global_ordinals", np.asarray([3, 2, 1]))
    object.__setattr__(mesh, "boundary_markers", np.asarray([2, 3, 4]))
    object.__setattr__(
        mesh,
        "periodic_boundary_pairs",
        [
            {
                "pair_id": "",
                "source_marker": None,
                "destination_marker": "",
                "marker_a": 2,
                "marker_b": 3,
                "translation": [1.0e-7, -0.0, 1.0e20],
                "tolerance_m": 3.0e-9,
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
    )
    object.__setattr__(
        mesh,
        "periodic_node_pairs",
        [{"pair_id": "", "node_a": 0, "node_b": 1}, {"pair_id": "é", "node_a": 2, "node_b": 3}],
    )
    return mesh


def test_topology_fingerprint_v3_matches_the_frozen_cross_language_fixture() -> None:
    mesh = _topology_fingerprint_v3_cross_language_fixture()

    assert mesh.topology_fingerprint_v3() == (
        "sha256:5728d7f6f11efc6f3d4ce4c5b098e3ea76866fd49a31088cf6692652d22c0ff6"
    )


def test_topology_fingerprint_v3_distinguishes_order_presence_and_signed_zero() -> None:
    mesh = _topology_fingerprint_v3_cross_language_fixture()
    baseline = mesh.topology_fingerprint_v3()

    object.__setattr__(mesh, "periodic_boundary_pairs", list(reversed(mesh.periodic_boundary_pairs)))
    assert mesh.topology_fingerprint_v3() != baseline
    object.__setattr__(mesh, "periodic_boundary_pairs", [])
    absent = mesh.topology_fingerprint_v3()
    object.__setattr__(mesh, "periodic_boundary_pairs", [{"pair_id": "", "marker_a": 0, "marker_b": 0, "axis_hint": ""}])
    assert mesh.topology_fingerprint_v3() != absent
    object.__setattr__(mesh, "nodes", np.asarray([[0.0, 0.0, 0.0]]))
    positive_zero = mesh.topology_fingerprint_v3()
    object.__setattr__(mesh, "nodes", np.asarray([[-0.0, 0.0, 0.0]]))
    assert mesh.topology_fingerprint_v3() != positive_zero


def test_topology_fingerprint_v3_rejects_nonfinite_and_excludes_diagnostics() -> None:
    mesh = _topology_fingerprint_v3_cross_language_fixture()
    baseline = mesh.topology_fingerprint_v3()
    object.__setattr__(mesh, "quality", Mock())
    object.__setattr__(mesh, "per_domain_quality", {7: Mock()})
    object.__setattr__(mesh, "realization_report", Mock())
    assert mesh.topology_fingerprint_v3() == baseline
    object.__setattr__(mesh, "nodes", np.asarray([[float("inf"), 0.0, 0.0]]))
    with pytest.raises(ValueError, match="finite"):
        mesh.topology_fingerprint_v3()


def test_topology_fingerprint_v3_normalizes_tolerance_alias_and_rejects_nonfinite_periodic_data() -> None:
    alias = _topology_fingerprint_v3_cross_language_fixture()
    normalized = _topology_fingerprint_v3_cross_language_fixture()
    normalized.periodic_boundary_pairs[0]["tolerance"] = normalized.periodic_boundary_pairs[0].pop(
        "tolerance_m"
    )
    assert alias.topology_fingerprint_v3() == normalized.topology_fingerprint_v3()

    alias.periodic_boundary_pairs[0]["translation"] = [float("nan"), 0.0, 0.0]
    with pytest.raises(ValueError, match="finite"):
        alias.topology_fingerprint_v3()
    normalized.periodic_boundary_pairs[0]["tolerance"] = float("inf")
    with pytest.raises(ValueError, match="finite"):
        normalized.topology_fingerprint_v3()


def test_mixed_layer_topology_certificate_rejects_unknown_v4_fingerprint() -> None:
    golden_path = (
        Path(__file__).resolve().parents[3]
        / "crates/fullmag-ir/tests/fixtures/mixed_layer_topology_certificate_v1_python_golden.json"
    )
    payload = json.loads(golden_path.read_text(encoding="utf-8"))["certificate"]
    for name in (
        "magnetic_plane_coordinates_m",
        "magnetic_bounds_min_m",
        "magnetic_bounds_max_m",
        "airbox_bounds_min_m",
        "airbox_bounds_max_m",
    ):
        payload[name] = [float(value) for value in payload[name]]
    for name in (
        "plane_tolerance_m",
        "transition_shell_thickness_m",
        "magnetic_bounds_relative_error",
        "airbox_bounds_relative_error",
        "magnetic_volume_m3",
        "expected_magnetic_volume_m3",
        "magnetic_relative_volume_error",
        "air_volume_m3",
        "shared_domain_volume_m3",
        "expected_shared_domain_volume_m3",
        "shared_domain_relative_volume_error",
    ):
        payload[name] = float(payload[name])
    for name in (
        "jacobian_minima_m3_by_family",
        "scaled_jacobian_minima_by_family",
        "scaled_jacobian_p05_by_family",
    ):
        payload[name] = {key: float(value) for key, value in payload[name].items()}
    MixedLayerTopologyCertificate.from_dict(payload)
    payload["topology_fingerprint_version"] = "v4"
    with pytest.raises(ValueError, match="v2 or v3"):
        MixedLayerTopologyCertificate.from_dict(payload)


@pytest.mark.parametrize(
    ("field", "replacement"),
    [
        ("nodes", np.asarray([[9.0, 8.0, 7.0]])),
        ("cell_types", np.asarray(["hex8"])),
        ("cell_offsets", np.asarray([0, 8])),
        ("cell_nodes", np.asarray([22, 21, 20], dtype=np.int32)),
        ("cell_global_ordinals", np.asarray([99])),
        ("cell_mesh_parts", np.asarray(["far_air"])),
        ("element_markers", np.asarray([99])),
        ("facet_types", np.asarray(["quad4"])),
        ("facet_roles", np.asarray(["periodic_seam"])),
        ("facet_offsets", np.asarray([0, 4])),
        ("facet_nodes", np.asarray([9, 8, 7, 6], dtype=np.int32)),
        ("facet_global_ordinals", np.asarray([99])),
        ("boundary_markers", np.asarray([99])),
        ("periodic_boundary_pairs", []),
        ("periodic_node_pairs", []),
    ],
)
def test_topology_fingerprint_v3_tamper_matrix_is_fail_closed(
    field: str, replacement: object
) -> None:
    mesh = _topology_fingerprint_v3_cross_language_fixture()
    baseline = mesh.topology_fingerprint_v3()
    object.__setattr__(mesh, field, replacement)
    assert mesh.topology_fingerprint_v3() != baseline


def test_mixed_remesh_inline_payload_preserves_parts_and_certificate() -> None:
    mesh = _mixed_remesh_transport_mesh()
    certificate = mesh.mixed_layer_topology_certificate

    payload = _mesh_result_payload(
        mesh,
        mesh_name="shared_domain",
        generation_mode="generated",
        mesh_provenance={},
    )

    assert payload["cell_mesh_parts"] == mesh.cell_mesh_parts.tolist()
    assert payload["mixed_layer_topology_certificate"] == certificate.to_dict()


def test_mixed_remesh_artifact_preserves_parts_and_certificate(tmp_path: Path) -> None:
    mesh = _mixed_remesh_transport_mesh()
    certificate = mesh.mixed_layer_topology_certificate

    payload = _mesh_result_payload(
        mesh,
        mesh_name="shared_domain",
        generation_mode="generated",
        mesh_provenance={},
        topology_artifact_dir=tmp_path,
        inline_topology_max_bytes=1,
    )
    artifact = json.loads(
        Path(payload["topology_artifact"]["path"]).read_text(encoding="utf-8")
    )

    assert artifact["cell_mesh_parts"] == mesh.cell_mesh_parts.tolist()
    assert artifact["mixed_layer_topology_certificate"] == certificate.to_dict()


def _rewrite_persisted_mixed_certificate(
    path: Path,
    suffix: str,
    mutate,
) -> None:
    if suffix == ".json":
        payload = json.loads(path.read_text(encoding="utf-8"))
        mutate(payload, payload["mixed_layer_topology_certificate"])
        path.write_text(json.dumps(payload), encoding="utf-8")
        return
    with np.load(path) as archive:
        payload = {name: archive[name] for name in archive.files}
    certificate = json.loads(str(payload["mixed_layer_topology_certificate_json"]))
    mutate(payload, certificate)
    payload["mixed_layer_topology_certificate_json"] = np.asarray(
        json.dumps(certificate)
    )
    np.savez_compressed(path, **payload)


def test_mixed_cell_mesh_parts_are_canonical_and_persistent(tmp_path: Path) -> None:
    pytest.importorskip("gmsh")
    mesh = _mixed_shared_domain_case()[2]

    assert hasattr(mesh, "cell_mesh_parts")
    assert len(mesh.cell_mesh_parts) == mesh.n_elements
    assert set(mesh.cell_mesh_parts.tolist()) == {
        "magnetic",
        "transition_air",
        "far_air",
    }
    assert np.all(mesh.cell_mesh_parts[mesh.element_markers == 1] == "magnetic")
    assert np.all(mesh.cell_mesh_parts[mesh.cell_types == "pyramid5"] == "transition_air")

    for suffix in (".json", ".npz"):
        path = tmp_path / f"mixed-parts{suffix}"
        mesh.save(path)
        loaded = MeshData.load(path)
        np.testing.assert_array_equal(loaded.cell_mesh_parts, mesh.cell_mesh_parts)
        assert loaded.to_ir("mixed")["cells"]["mesh_parts"] == (
            mesh.cell_mesh_parts.tolist()
        )


@pytest.mark.parametrize("suffix", [".json", ".npz"])
@pytest.mark.parametrize(
    ("field", "replacement"),
    [
        ("magnetic_volume_m3", lambda value: value * 0.9),
        (
            "jacobian_minima_m3_by_family",
            lambda value: {**value, "prism6": value["prism6"] * 0.5},
        ),
        (
            "quality",
            lambda value: {**value, "prism6": value["prism6"] * 0.5},
        ),
        ("transition_shell_interface_tri3_count", lambda value: value + 1),
        ("gmsh_version", lambda _value: "4.15.1"),
        ("strategy", lambda _value: "self_signed.fake"),
    ],
)
def test_mesh_load_recomputes_mixed_certificate_evidence(
    tmp_path: Path,
    suffix: str,
    field: str,
    replacement,
) -> None:
    pytest.importorskip("gmsh")
    mesh = _mixed_shared_domain_case()[2]
    path = tmp_path / f"tampered-evidence-{field}{suffix}"
    mesh.save(path)

    def mutate(_payload, certificate) -> None:
        resolved_field = field
        if field == "quality":
            resolved_field = (
                "scaled_jacobian_p05_by_family"
                if "scaled_jacobian_p05_by_family" in certificate
                else "sicn_p05_by_family"
            )
        certificate[resolved_field] = replacement(certificate[resolved_field])

    _rewrite_persisted_mixed_certificate(path, suffix, mutate)
    with pytest.raises(
        (TypeError, ValueError), match="mixed layer topology certificate"
    ):
        MeshData.load(path)


@pytest.mark.parametrize(
    "field",
    [
        "nonconforming_face_count",
        "orphan_face_count",
        "nonmanifold_face_count",
        "coincident_interface_face_count",
    ],
)
def test_mixed_certificate_recomputes_each_conformity_claim(field: str) -> None:
    pytest.importorskip("gmsh")
    mesh = _mixed_shared_domain_case()[2]
    original = mesh.mixed_layer_topology_certificate
    assert original is not None
    certificate = replace(original)
    object.__setattr__(certificate, field, 1)
    unsigned = replace(mesh, mixed_layer_topology_certificate=None)
    object.__setattr__(unsigned, "mixed_layer_topology_certificate", certificate)

    with pytest.raises(
        ValueError,
        match=rf"mixed layer topology certificate {field} is stale",
    ):
        unsigned._validate_mixed_layer_topology_certificate()


@pytest.mark.parametrize("suffix", [".json", ".npz"])
def test_mesh_load_rejects_mixed_part_reassignment_even_with_resigned_fingerprint(
    tmp_path: Path,
    suffix: str,
) -> None:
    pytest.importorskip("gmsh")
    mesh = _mixed_shared_domain_case()[2]
    assert hasattr(mesh, "cell_mesh_parts")
    path = tmp_path / f"tampered-parts{suffix}"
    mesh.save(path)

    def mutate(payload, certificate) -> None:
        if suffix == ".json":
            parts = payload["cell_mesh_parts"]
            index = parts.index("transition_air")
            parts[index] = "far_air"
        else:
            parts = np.asarray(payload["cell_mesh_parts"]).astype(np.str_)
            index = int(np.flatnonzero(parts == "transition_air")[0])
            parts[index] = "far_air"
            payload["cell_mesh_parts"] = parts
        certificate["topology_fingerprint"] = "sha256:" + "0" * 64

    _rewrite_persisted_mixed_certificate(path, suffix, mutate)
    with pytest.raises(ValueError, match="mesh part|topology fingerprint"):
        MeshData.load(path)


def test_mixed_certificate_rejects_semantically_resigned_part_reassignment() -> None:
    pytest.importorskip("gmsh")
    mesh = _mixed_shared_domain_case()[2]
    certificate = mesh.mixed_layer_topology_certificate
    assert certificate is not None
    parts = np.array(mesh.cell_mesh_parts, copy=True)
    index = int(np.flatnonzero(parts == "transition_air")[0])
    parts[index] = "far_air"
    unsigned = replace(
        mesh,
        cell_mesh_parts=parts,
        mixed_layer_topology_certificate=None,
    )
    resigned = replace(
        certificate,
        topology_fingerprint=unsigned.topology_fingerprint_v3(),
    )
    with pytest.raises(ValueError, match="mixed layer topology certificate.*stale"):
        replace(unsigned, mixed_layer_topology_certificate=resigned)


def test_mixed_certificate_uses_recomputable_scaled_jacobian_not_gmsh_sicn() -> None:
    pytest.importorskip("gmsh")
    certificate = _mixed_shared_domain_case()[2].mixed_layer_topology_certificate
    assert certificate is not None
    payload = certificate.to_dict()
    assert payload["quality_metric"] == "tetra_decomposition_scaled_jacobian.v1"
    assert "scaled_jacobian_minima_by_family" in payload
    assert "scaled_jacobian_p05_by_family" in payload
    assert all(
        value >= 0.1
        for value in payload["scaled_jacobian_p05_by_family"].values()
    )
    assert payload["scaled_jacobian_minima_by_family"]["tet4"] >= 0.058
    assert "sicn_minima_by_family" not in payload
    assert "sicn_p05_by_family" not in payload


@pytest.mark.parametrize(
    ("field", "bad_value"),
    [
        ("requested_layer_count", "1"),
        ("transition_shell_interface_tri3_count", True),
        ("magnetic_volume_m3", "1.0"),
    ],
)
def test_mixed_certificate_wire_types_reject_coercion(
    field: str,
    bad_value: object,
) -> None:
    pytest.importorskip("gmsh")
    payload = _mixed_shared_domain_case()[2].mixed_layer_topology_certificate.to_dict()
    payload[field] = bad_value
    with pytest.raises(TypeError, match=field):
        gmsh_types.MixedLayerTopologyCertificate.from_dict(payload)


def test_uniform_scale_rebuilds_mixed_certificate() -> None:
    pytest.importorskip("gmsh")
    mesh = _mixed_shared_domain_case()[2]
    original = mesh.mixed_layer_topology_certificate
    assert original is not None
    scaled = _scale_mesh_nodes(mesh, np.asarray([2.0, 2.0, 2.0]))
    certificate = scaled.mixed_layer_topology_certificate
    assert certificate is not None
    np.testing.assert_array_equal(scaled.cell_mesh_parts, mesh.cell_mesh_parts)
    assert certificate.topology_fingerprint != original.topology_fingerprint
    assert certificate.magnetic_volume_m3 == pytest.approx(
        original.magnetic_volume_m3 * 8.0
    )
    assert certificate.transition_shell_thickness_m == pytest.approx(
        original.transition_shell_thickness_m * 2.0
    )
    assert certificate.magnetic_plane_coordinates_m == pytest.approx(
        np.asarray(original.magnetic_plane_coordinates_m) * 2.0
    )


def test_anisotropic_scale_rejects_certified_mixed_mesh() -> None:
    pytest.importorskip("gmsh")
    mesh = _mixed_shared_domain_case()[2]
    with pytest.raises(ValueError, match="anisotropic.*certified mixed"):
        _scale_mesh_nodes(mesh, np.asarray([2.0, 1.0, 1.0]))


def _mixed_evidence(
    mesh: MeshData,
    certificate: gmsh_types.MixedLayerTopologyCertificate | None = None,
) -> dict[str, object]:
    certificate = certificate or mesh.mixed_layer_topology_certificate
    assert certificate is not None
    return gmsh_types._recompute_mixed_certificate_evidence(
        replace(mesh, mixed_layer_topology_certificate=None),
        sweep_axis={"x": 0, "y": 1, "z": 2}[certificate.resolved_sweep_direction],
        interface_marker=certificate.interface_marker,
        outer_boundary_marker=certificate.outer_boundary_marker,
        magnetic_bounds_min_m=certificate.magnetic_bounds_min_m,
        magnetic_bounds_max_m=certificate.magnetic_bounds_max_m,
        airbox_bounds_min_m=certificate.airbox_bounds_min_m,
        airbox_bounds_max_m=certificate.airbox_bounds_max_m,
    )


@pytest.mark.parametrize("role", ["material_interface", "exterior"])
def test_mixed_evidence_rejects_wrong_explicit_facet_marker(role: str) -> None:
    pytest.importorskip("gmsh")
    mesh = _mixed_shared_domain_case()[2]
    certificate = mesh.mixed_layer_topology_certificate
    assert certificate is not None
    ordinal = int(np.flatnonzero(mesh.facet_roles == role)[0])
    markers = np.array(mesh.boundary_markers, copy=True)
    markers[ordinal] += 1
    tampered = replace(
        mesh,
        boundary_markers=markers,
        mixed_layer_topology_certificate=None,
    )
    evidence = _mixed_evidence(tampered, certificate)
    assert evidence["nonconforming_face_count"] > 0


def test_mixed_evidence_rejects_missing_material_interface_facet() -> None:
    pytest.importorskip("gmsh")
    mesh = _mixed_shared_domain_case()[2]
    certificate = mesh.mixed_layer_topology_certificate
    assert certificate is not None
    removed = int(np.flatnonzero(mesh.facet_roles == "material_interface")[0])
    kept = [index for index in range(mesh.n_boundary_faces) if index != removed]
    blocks = [mesh.facet_node_ids(index) for index in kept]
    offsets = np.zeros(len(blocks) + 1, dtype=np.int64)
    offsets[1:] = np.cumsum([len(block) for block in blocks])
    tampered = replace(
        mesh,
        facet_types=mesh.facet_types[kept],
        facet_roles=mesh.facet_roles[kept],
        facet_offsets=offsets,
        facet_nodes=np.concatenate(blocks).astype(np.int32),
        boundary_markers=mesh.boundary_markers[kept],
        facet_global_ordinals=np.arange(len(kept), dtype=np.int64),
        mixed_layer_topology_certificate=None,
    )
    evidence = _mixed_evidence(tampered, certificate)
    assert evidence["nonconforming_face_count"] > 0


def test_mixed_marker_collision_fails_before_gmsh_import(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    swept = importlib.import_module("fullmag.meshing._gmsh_swept")
    import_gmsh = Mock(side_effect=AssertionError("Gmsh import must not run"))
    monkeypatch.setattr(swept, "_import_gmsh", import_gmsh)
    with pytest.raises(ValueError, match="markers must be distinct"):
        generate_swept_box_mesh(
            (4e-6, 2e-6, 0.2e-6),
            hmax=0.3e-6,
            n_layers=1,
            airbox=fm.meshing.AirboxOptions(boundary_marker=10),
        )
    import_gmsh.assert_not_called()


def test_mixed_certificate_persists_authored_cad_bounds() -> None:
    pytest.importorskip("gmsh")
    body_size, airbox, mesh = _mixed_shared_domain_case()
    certificate = mesh.mixed_layer_topology_certificate
    assert certificate is not None
    assert certificate.magnetic_bounds_min_m == pytest.approx(
        tuple(-0.5 * value for value in body_size)
    )
    assert certificate.magnetic_bounds_max_m == pytest.approx(
        tuple(0.5 * value for value in body_size)
    )
    assert airbox.size is not None
    assert certificate.airbox_bounds_min_m == pytest.approx(
        tuple(-0.5 * value for value in airbox.size)
    )
    assert certificate.airbox_bounds_max_m == pytest.approx(
        tuple(0.5 * value for value in airbox.size)
    )


def test_mixed_attach_rejects_fake_authored_cad_dimensions() -> None:
    pytest.importorskip("gmsh")
    from fullmag.meshing._gmsh_airbox import _attach_mixed_layer_topology_certificate

    mesh = _mixed_shared_domain_case()[2]
    unsigned = replace(mesh, mixed_layer_topology_certificate=None)
    with pytest.raises(RuntimeError, match="authored.*bounds|volume balance"):
        _attach_mixed_layer_topology_certificate(
            unsigned,
            body_size_m=(40e-6, 20e-6, 2e-6),
            airbox_bounds_min_m=(-40e-6, -30e-6, -21e-6),
            airbox_bounds_max_m=(40e-6, 30e-6, 21e-6),
            requested_axis=2,
            requested_layers=1,
            gmsh_version="4.15.2",
            cell_mesh_parts=unsigned.cell_mesh_parts,
            outer_boundary_marker=99,
            effective_gmsh_thread_count=1,
        )


@pytest.mark.parametrize("suffix", [".json", ".npz"])
def test_mesh_load_rejects_tampered_authored_cad_bounds(
    tmp_path: Path,
    suffix: str,
) -> None:
    pytest.importorskip("gmsh")
    mesh = _mixed_shared_domain_case()[2]
    path = tmp_path / f"tampered-authored-bounds{suffix}"
    mesh.save(path)

    def mutate(_payload, certificate) -> None:
        certificate["magnetic_bounds_min_m"] = [-20e-6, -10e-6, -1e-6]
        certificate["magnetic_bounds_max_m"] = [20e-6, 10e-6, 1e-6]
        certificate["airbox_bounds_min_m"] = [-40e-6, -30e-6, -21e-6]
        certificate["airbox_bounds_max_m"] = [40e-6, 30e-6, 21e-6]

    _rewrite_persisted_mixed_certificate(path, suffix, mutate)
    with pytest.raises(ValueError, match="mixed layer topology certificate.*authored|volume"):
        MeshData.load(path)


def test_near_identity_anisotropic_scale_rejects_certified_mixed_mesh() -> None:
    pytest.importorskip("gmsh")
    mesh = _mixed_shared_domain_case()[2]
    with pytest.raises(ValueError, match="anisotropic.*certified mixed"):
        _scale_mesh_nodes(mesh, np.asarray([1.0, 1.000001, 1.0]))


def test_uniform_scale_scales_authored_cad_bounds() -> None:
    pytest.importorskip("gmsh")
    mesh = _mixed_shared_domain_case()[2]
    original = mesh.mixed_layer_topology_certificate
    assert original is not None
    scaled = _scale_mesh_nodes(mesh, np.asarray([2.0, 2.0, 2.0]))
    certificate = scaled.mixed_layer_topology_certificate
    assert certificate is not None
    assert certificate.magnetic_bounds_min_m == pytest.approx(
        np.asarray(original.magnetic_bounds_min_m) * 2.0
    )
    assert certificate.magnetic_bounds_max_m == pytest.approx(
        np.asarray(original.magnetic_bounds_max_m) * 2.0
    )
    assert certificate.airbox_bounds_min_m == pytest.approx(
        np.asarray(original.airbox_bounds_min_m) * 2.0
    )
    assert certificate.airbox_bounds_max_m == pytest.approx(
        np.asarray(original.airbox_bounds_max_m) * 2.0
    )


def test_resigned_mesh_with_pyramid_base_off_quad_interface_is_rejected() -> None:
    pytest.importorskip("gmsh")
    mesh = _mixed_shared_domain_case()[2]
    certificate = mesh.mixed_layer_topology_certificate
    assert certificate is not None
    ordinal = int(np.flatnonzero(mesh.cell_types == "pyramid5")[0])
    nodes = np.array(mesh.cell_nodes, copy=True)
    start = int(mesh.cell_offsets[ordinal])
    nodes[start], nodes[start + 4] = nodes[start + 4], nodes[start]
    unsigned = replace(
        mesh,
        cell_nodes=nodes,
        mixed_layer_topology_certificate=None,
    )
    resigned = replace(
        certificate,
        topology_fingerprint=unsigned.topology_fingerprint_v3(),
    )
    with pytest.raises(ValueError, match="pyramid bases.*quad.*marker 10"):
        replace(unsigned, mixed_layer_topology_certificate=resigned)


@pytest.mark.parametrize(
    ("field", "bad_value"),
    [
        ("cell_family_counts_by_marker", [("0", {"tet4": 1})]),
        ("cell_family_counts_by_marker", {0: {"tet4": 1}}),
        ("cell_family_counts_by_marker", {"0": {4: 1}}),
        ("cell_family_counts_by_marker", {"0": {"tet4": True}}),
        ("scaled_jacobian_minima_by_family", [("tet4", 0.5)]),
    ],
)
def test_mixed_certificate_nested_wire_types_fail_before_normalization(
    field: str,
    bad_value: object,
) -> None:
    pytest.importorskip("gmsh")
    payload = _mixed_shared_domain_case()[2].mixed_layer_topology_certificate.to_dict()
    payload[field] = bad_value
    with pytest.raises(TypeError, match=field):
        gmsh_types.MixedLayerTopologyCertificate.from_dict(payload)


def test_mixed_certificate_uses_versioned_tetra_decomposition_quality_name() -> None:
    pytest.importorskip("gmsh")
    certificate = _mixed_shared_domain_case()[2].mixed_layer_topology_certificate
    assert certificate is not None
    assert certificate.quality_metric == "tetra_decomposition_scaled_jacobian.v1"
    payload = certificate.to_dict()
    payload["quality_metric"] = "scaled_jacobian"
    with pytest.raises(ValueError, match="quality_metric"):
        gmsh_types.MixedLayerTopologyCertificate.from_dict(payload)


def test_npz_load_rejects_top_level_certificate_list_of_pairs(
    tmp_path: Path,
) -> None:
    pytest.importorskip("gmsh")
    mesh = _mixed_shared_domain_case()[2]
    path = tmp_path / "certificate-list-of-pairs.npz"
    mesh.save(path)
    with np.load(path) as archive:
        payload = {name: archive[name] for name in archive.files}
    certificate = json.loads(str(payload["mixed_layer_topology_certificate_json"]))
    payload["mixed_layer_topology_certificate_json"] = np.asarray(
        json.dumps(list(certificate.items()))
    )
    np.savez_compressed(path, **payload)

    with pytest.raises(
        TypeError,
        match="mixed_layer_topology_certificate.*object",
    ):
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


@pytest.mark.parametrize("cell_type", ["tet4", "prism6", "pyramid5", "hex8"])
def test_strict_validation_is_invariant_under_uniform_si_scaling(
    cell_type: str,
) -> None:
    nodes = _REFERENCE_CELLS[cell_type] * 1.0e-12
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

    mesh.validate_strict()


@pytest.mark.parametrize("length_scale", [1.0, 1.0e-12])
def test_strict_validation_rejects_relatively_degenerate_cells_at_any_scale(
    length_scale: float,
) -> None:
    nodes = np.array(_REFERENCE_CELLS["tet4"], copy=True) * length_scale
    nodes[3, 2] = length_scale * np.finfo(np.float64).eps
    mesh = MeshData(
        nodes=nodes,
        cell_types=["tet4"],
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

    with pytest.raises(ValueError, match="degenerate tet4 Jacobian"):
        mesh.validate_strict()


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
