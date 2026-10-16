"""Strict incidence validation for frozen magnetic/air mesh merges."""

from __future__ import annotations

from collections import Counter
from typing import Iterable, Sequence

from ._gmsh_types import (
    MeshData,
    _mixed_face_adjacency,
    _mixed_same_side_two_owner_face_details,
)


def _face_key(nodes: Iterable[int]) -> tuple[int, ...]:
    return tuple(sorted(int(node) for node in nodes))


def _validate_frozen_magnetic_air_interface(
    mesh: MeshData,
    *,
    expected_interface_face_keys: Sequence[tuple[int, ...]],
    magnetic_cell_count: int,
) -> None:
    """Reject frozen merges without exact, opposite-side magnetic/air incidence."""
    if not 0 < magnetic_cell_count < mesh.n_elements:
        raise ValueError(
            "frozen magnetic interface incidence requires non-empty magnetic and air cell sets"
        )

    expected_counts = Counter(expected_interface_face_keys)
    duplicate_expected = sorted(
        face for face, count in expected_counts.items() if count != 1
    )
    if duplicate_expected:
        raise ValueError(
            "frozen magnetic interface incidence has duplicate frozen declarations "
            f"for face {duplicate_expected[0]}"
        )
    expected_faces = set(expected_counts)
    if not expected_faces:
        raise ValueError("frozen magnetic interface incidence has no declared faces")

    declared_counts: Counter[tuple[int, ...]] = Counter()
    for ordinal, role in enumerate(mesh.facet_roles.tolist()):
        if str(role) != "material_interface":
            continue
        face = _face_key(mesh.facet_node_ids(ordinal))
        marker = int(mesh.boundary_markers[ordinal])
        if marker != 10:
            raise ValueError(
                "frozen magnetic interface incidence requires boundary marker 10 "
                f"for face {face}, got {marker}"
            )
        declared_counts[face] += 1

    extra_declarations = sorted(set(declared_counts) - expected_faces)
    if extra_declarations:
        raise ValueError(
            "frozen magnetic interface incidence has an unexpected declared face "
            f"{extra_declarations[0]}"
        )
    for face in sorted(expected_faces):
        count = declared_counts[face]
        if count != 1:
            raise ValueError(
                "frozen magnetic interface incidence requires each expected face "
                f"to be declared exactly once: face {face} has {count} declarations"
            )

    face_owners = _mixed_face_adjacency(mesh)
    for face, owners in face_owners.items():
        magnetic_owners = [owner for owner in owners if owner < magnetic_cell_count]
        air_owners = [owner for owner in owners if owner >= magnetic_cell_count]
        if magnetic_owners and air_owners and face not in expected_faces:
            raise ValueError(
                "frozen magnetic interface incidence found an undeclared magnetic-air "
                f"face {face} with cell owners {owners}"
            )

    for face in sorted(expected_faces):
        owners = face_owners.get(face, [])
        magnetic_owners = [owner for owner in owners if owner < magnetic_cell_count]
        air_owners = [owner for owner in owners if owner >= magnetic_cell_count]
        if len(owners) != 2:
            raise ValueError(
                "frozen magnetic interface incidence requires exactly two cell owners "
                f"(one magnetic prefix and one air cell): face {face} has {len(owners)} "
                f"owners {owners}"
            )
        if len(magnetic_owners) != 1 or len(air_owners) != 1:
            raise ValueError(
                "frozen magnetic interface incidence requires one magnetic-prefix and "
                f"one air owner: face {face} has owners {owners}"
            )

    # The existing geometry check builds its own adjacency. Release the full map
    # above before calling it so large meshes never retain two full maps at once.
    del face_owners
    same_side_faces = _mixed_same_side_two_owner_face_details(mesh, tolerance=0.0)
    for face, owners, distances in same_side_faces:
        if face in expected_faces:
            raise ValueError(
                "frozen magnetic interface incidence has same-side owners for face "
                f"{face}: cells {owners}, relative signed distances {distances}"
            )
