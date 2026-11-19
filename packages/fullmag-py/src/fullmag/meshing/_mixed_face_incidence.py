"""Vectorized exact face incidence for mixed FEM cells and explicit facets.

A face is identified by its sorted node-id set, exactly like the historical
``tuple(sorted(...))`` dictionary keys: grouping is integer equality with no
geometric tolerance.  Cell faces and explicit boundary facets are grouped in
one pass so ownership and explicit coverage come from the same table.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Sequence

import numpy as np
from numpy.typing import NDArray


@dataclass(frozen=True)
class MixedFaceIncidence:
    """Faces grouped by exact node set.

    ``members[offsets[f]:offsets[f + 1]]`` lists the incidences of face ``f``:
    a value ``>= 0`` is an owning cell ordinal, a value ``< 0`` is ``~facet``
    for an explicit facet ordinal.  Members within a face are unordered.
    """

    arity: NDArray[np.int64]
    offsets: NDArray[np.int64]
    members: NDArray[np.int64]
    cell_owner_counts: NDArray[np.int64]
    explicit_counts: NDArray[np.int64]
    facet_face: NDArray[np.int64]

    def face_cell_owners(self, face: int) -> NDArray[np.int64]:
        group = self.members[self.offsets[face] : self.offsets[face + 1]]
        return group[group >= 0]


def _sorted_face_rows(
    nodes: NDArray[np.int64], arity: int
) -> NDArray[np.int64]:
    rows = np.full((nodes.shape[0], 4), -1, dtype=np.int64)
    rows[:, :arity] = np.sort(nodes, axis=1)
    return rows


def _dense_group_ids(rows: NDArray[np.int64], node_count: int) -> NDArray[np.int64]:
    """Return ids that are equal exactly when the padded rows are equal."""
    radix = int(node_count) + 1
    ids = np.zeros(rows.shape[0], dtype=np.int64)
    bound = 1
    for column in range(rows.shape[1]):
        if bound * radix >= 1 << 62:
            _, ids = np.unique(ids, return_inverse=True)
            ids = ids.astype(np.int64).reshape(-1)
            bound = int(ids.max()) + 1 if ids.size else 1
        ids = ids * radix + (rows[:, column] + 1)
        bound *= radix
    return ids


def build_mixed_face_incidence(
    *,
    node_count: int,
    cell_types: NDArray[np.str_],
    cell_offsets: NDArray[np.int64],
    cell_nodes: NDArray[np.int32],
    local_facets: Mapping[str, Sequence[Sequence[int]]],
    facet_offsets: NDArray[np.int64],
    facet_nodes: NDArray[np.int32],
) -> MixedFaceIncidence:
    families = np.asarray(cell_types)
    row_blocks: list[NDArray[np.int64]] = []
    member_blocks: list[NDArray[np.int64]] = []
    arity_blocks: list[NDArray[np.int64]] = []
    for family in dict.fromkeys(families.tolist()):
        ordinals = np.flatnonzero(families == family).astype(np.int64)
        starts = np.asarray(cell_offsets, dtype=np.int64)[ordinals][:, np.newaxis]
        for local_face in local_facets[str(family)]:
            nodes = np.asarray(cell_nodes[starts + np.asarray(local_face, dtype=np.int64)], dtype=np.int64)
            row_blocks.append(_sorted_face_rows(nodes, len(local_face)))
            member_blocks.append(ordinals)
            arity_blocks.append(np.full(ordinals.size, len(local_face), dtype=np.int64))
    facet_offsets = np.asarray(facet_offsets, dtype=np.int64)
    facet_arity = np.diff(facet_offsets)
    for arity in np.unique(facet_arity).tolist():
        facets = np.flatnonzero(facet_arity == arity).astype(np.int64)
        nodes = np.asarray(
            facet_nodes[facet_offsets[facets][:, np.newaxis] + np.arange(arity, dtype=np.int64)],
            dtype=np.int64,
        )
        row_blocks.append(_sorted_face_rows(nodes, int(arity)))
        member_blocks.append(~facets)
        arity_blocks.append(np.full(facets.size, arity, dtype=np.int64))
    if not row_blocks:
        empty = np.zeros(0, dtype=np.int64)
        return MixedFaceIncidence(empty, np.zeros(1, dtype=np.int64), empty, empty, empty, empty)
    rows = np.concatenate(row_blocks)
    members = np.concatenate(member_blocks)
    arities = np.concatenate(arity_blocks)
    ids = _dense_group_ids(rows, node_count)
    order = np.argsort(ids)
    sorted_ids = ids[order]
    starts = np.flatnonzero(np.concatenate(([True], sorted_ids[1:] != sorted_ids[:-1])))
    offsets = np.concatenate((starts, [ids.size])).astype(np.int64)
    members = members[order]
    is_cell = members >= 0
    cell_owner_counts = np.add.reduceat(is_cell.astype(np.int64), starts)
    explicit_counts = np.diff(offsets) - cell_owner_counts
    face_of_member = np.repeat(np.arange(starts.size, dtype=np.int64), np.diff(offsets))
    facet_face = np.full(facet_arity.size, -1, dtype=np.int64)
    facet_face[~members[~is_cell]] = face_of_member[~is_cell]
    return MixedFaceIncidence(
        arity=arities[order[starts]],
        offsets=offsets,
        members=members,
        cell_owner_counts=cell_owner_counts,
        explicit_counts=explicit_counts,
        facet_face=facet_face,
    )
