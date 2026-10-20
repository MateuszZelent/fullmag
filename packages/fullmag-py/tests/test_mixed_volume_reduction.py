"""Regression checks for the Python/native mixed-v2 volume contract."""

from __future__ import annotations

import numpy as np

from fullmag.meshing import _gmsh_swept
from fullmag.model.discretization import FEM
from fullmag.model.geometry import Box
from fullmag.model import problem


_TET4_DETERMINANT_FIXTURE = np.asarray(
    [
        [-2.199300553545441, -0.3508965272238476, -0.6054882968097831],
        [-2.220130657485795, -0.7544610370936566, -0.8843158923435804],
        [-1.021030729508697, 0.7282892991966965, -1.9496461830600578],
        [-3.5904522456848866, -0.8420661264698979, -1.2045849679058216],
    ],
    dtype=np.float64,
)

_PRISM6_REDUCTION_FIXTURE = np.asarray(
    [
        [0.31588122890540293, -1.4150224849105377, 0.4284014289782496],
        [-2.3146395355279856, 0.9074333392911117, 1.9856308444073718],
        [-0.1985949897559545, -0.11846745670212888, 1.1226756421677924],
        [-0.4269949893121825, 0.08529340769624538, 0.5309084257109905],
        [-0.20199605694609282, -1.6844207987886886, 1.2964230436109985],
        [0.027629795394481918, -0.3469853294651086, 0.23427927249950597],
    ],
    dtype=np.float64,
)


def test_tet_volume_uses_native_explicit_det3_order() -> None:
    assert _gmsh_swept._mixed_v2_cell_volume(
        "tet4", _TET4_DETERMINANT_FIXTURE
    ) == (
        0.21158882017815975
    )


def test_prism_volume_uses_native_neumaier_reduction() -> None:
    # The old NumPy determinant/mean path differs from the native fixed-loop
    # det3 plus Neumaier result by 2.8e-17 on this valid prism.
    assert _gmsh_swept._mixed_v2_cell_volume("prism6", _PRISM6_REDUCTION_FIXTURE) == (
        0.0035288203577889393
    )


def test_mixed_v2_cache_contract_changes_only_selected_document() -> None:
    geometry = Box(size=(1.0, 1.0, 1.0), name="mixed_fixture")
    hints = FEM(order=1, maximum_element_size=0.25)
    kwargs = dict(
        geometries=[geometry],
        hints=hints,
        study_universe={"mode": "auto"},
        mesh_workflow={"domain_mesh_mode": "generated_shared_domain_mesh"},
        per_object_recipes={},
        object_regions=[],
        cache_identity=None,
    )
    old_key, old_document = problem._fem_shared_domain_cache_document(**kwargs)
    new_key, new_document = problem._fem_shared_domain_cache_document(
        **kwargs,
        mixed_v2_volume_reduction_contract=(
            problem._FEM_MIXED_V2_VOLUME_REDUCTION_CONTRACT
        ),
    )
    assert old_key != new_key
    assert "mixed_v2_volume_reduction_contract" not in old_document
    assert (
        new_document["mixed_v2_volume_reduction_contract"]
        == problem._FEM_MIXED_V2_VOLUME_REDUCTION_CONTRACT
    )


def test_compensated_sum_preserves_small_volume_contributions() -> None:
    # Cell/facet reductions must not lose small terms across large cancellation.
    values = [1.0e16, 1.0, -1.0e16, 2.0]
    assert sum(values) != 3.0
    assert _gmsh_swept._mixed_v2_compensated_sum(iter(values)) == 3.0
