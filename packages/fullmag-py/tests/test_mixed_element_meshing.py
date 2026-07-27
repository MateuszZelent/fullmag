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
from fullmag.meshing._gmsh_extraction import _extract_mesh_data
from fullmag.meshing._gmsh_types import MeshData, _cell_jacobian_determinants


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
