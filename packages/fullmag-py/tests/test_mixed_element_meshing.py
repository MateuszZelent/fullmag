from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

import pytest


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


def test_gmsh_feasibility_freezes_mixed_p1_topology() -> None:
    assert FIXTURE.is_file(), f"missing frozen Gmsh feasibility fixture: {FIXTURE}"

    gmsh = pytest.importorskip("gmsh")
    version = getattr(gmsh, "__version__", "unknown")
    assert version == "4.15.2", (
        f"mixed-P1 fixture requires Gmsh 4.15.2; detected {version}"
    )

    splitter_module = "fullmag.meshing._gmsh_swept"
    assert splitter_module not in sys.modules

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
        assert {face[0] for face in top_bottom} == {"Triangle 3"}, diagnostics
        assert {face[0] for face in lateral} == {"Quadrilateral 4"}, diagnostics
        film_boundary_faces = {tuple(sorted(face[2])) for face in top_bottom + lateral}
        film_lateral_faces = {tuple(sorted(face[2])) for face in lateral}

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
        assert all(
            face in explicit_faces
            for face, owners in face_owners.items()
            if len(owners) == 1
        ), f"{diagnostics}; orphan volume-boundary face detected"

        assert film_boundary_faces, f"{diagnostics}; missing film boundary facets"
        assert all(
            len(face_owners.get(face, ())) == 2
            and {domain for domain, _ in face_owners[face]} == {"film", "air"}
            for face in film_boundary_faces
        ), f"{diagnostics}; film is not fully enclosed by conforming air"
        assert splitter_module not in sys.modules
    finally:
        gmsh.finalize()
