"""Regression checks for the Python/native mixed-v2 volume contract."""

from __future__ import annotations

import numpy as np

from fullmag.meshing import _gmsh_swept
from fullmag.model.discretization import FEM
from fullmag.model.geometry import Box, Cylinder, Difference, Translate
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

_TET4_JACOBIAN_ORDER_FIXTURE = np.asarray(
    [
        [9.120685437784989, 8.956549741186986, -8.868972645463826],
        [-8.302560096821567, 6.709977562588993, 4.719399781370466],
        [3.3946080288044183, -3.8372708482171163, 2.118883313569249],
        [2.1360346728167574, 1.6240803422400614, -6.8323425949038885],
    ],
    dtype=np.float64,
)


def _mixed_v2_cache_geometries() -> list[object]:
    return [
        Box(size=(4.0e-6, 2.0e-6, 0.2e-6), name="box"),
        Translate(
            Difference(
                base=Cylinder(radius=0.15e-6, height=0.2e-6, name="outer"),
                tool=Cylinder(radius=0.05e-6, height=0.2e-6, name="inner"),
                name="ring_difference",
            ),
            offset=(3.0e-6, 0.0, 0.0),
            name="ring",
        ),
    ]


def test_tet_volume_uses_native_explicit_det3_order() -> None:
    assert _gmsh_swept._mixed_v2_cell_volume(
        "tet4", _TET4_DETERMINANT_FIXTURE
    ) == (
        0.21158882017815975
    )


def test_tet_jacobian_evidence_keeps_native_physical_row_order() -> None:
    edge_column_determinant = _gmsh_swept._mixed_v2_tet4_volume_determinant(
        _TET4_JACOBIAN_ORDER_FIXTURE
    )
    physical_row_determinant = _gmsh_swept._mixed_v2_tet4_jacobian_determinant(
        _TET4_JACOBIAN_ORDER_FIXTURE
    )

    assert edge_column_determinant == -1447.2929197618416
    assert physical_row_determinant == -1447.2929197618419
    assert edge_column_determinant != physical_row_determinant
    assert _gmsh_swept._mixed_v2_cell_jacobian_determinants(
        "tet4", _TET4_JACOBIAN_ORDER_FIXTURE
    ).tolist() == [physical_row_determinant]
    assert _gmsh_swept._mixed_v2_cell_volume(
        "tet4", _TET4_JACOBIAN_ORDER_FIXTURE
    ) == abs(edge_column_determinant) / 6.0


def test_prism_volume_uses_native_neumaier_reduction() -> None:
    # The old NumPy determinant/mean path differs from the native fixed-loop
    # det3 plus Neumaier result by 2.8e-17 on this valid prism.
    assert _gmsh_swept._mixed_v2_cell_volume("prism6", _PRISM6_REDUCTION_FIXTURE) == (
        0.0035288203577889393
    )


def test_mixed_v2_cache_contract_tracks_only_the_direct_producer_route() -> None:
    geometries = _mixed_v2_cache_geometries()
    hints = FEM(order=1, maximum_element_size=0.25)
    kwargs = dict(
        geometries=geometries,
        hints=hints,
        study_universe={
            "mode": "manual",
            "size": [10.0e-6, 10.0e-6, 10.0e-6],
            "center": [0.0, 0.0, 0.0],
        },
        mesh_workflow={
            "mesh_options": {
                "mesh_strategy": "swept_prism",
                "through_thickness_elements": 1,
                "through_thickness_distribution": "fixed",
            }
        },
        per_object_recipes={},
        object_regions=[],
        cache_identity=None,
    )
    direct_contract = problem._mixed_v2_volume_reduction_contract_for_request(
        geometries,
        hints,
        study_universe=kwargs["study_universe"],
        mesh_workflow=kwargs["mesh_workflow"],
        object_regions=kwargs["object_regions"],
    )
    assert direct_contract == problem._FEM_MIXED_V2_VOLUME_REDUCTION_CONTRACT
    base_key, base_document = problem._fem_shared_domain_cache_document(**kwargs)
    direct_key, direct_document = problem._fem_shared_domain_cache_document(
        **kwargs, mixed_v2_volume_reduction_contract=direct_contract
    )
    assert base_key != direct_key
    assert "mixed_v2_volume_reduction_contract" not in base_document
    assert (
        direct_document["mixed_v2_volume_reduction_contract"]
        == problem._FEM_MIXED_V2_VOLUME_REDUCTION_CONTRACT
    )

    nondirect_workflow = {
        "mesh_options": {
            "mesh_strategy": "free_tetrahedral",
        }
    }
    nondirect_contract = problem._mixed_v2_volume_reduction_contract_for_request(
        geometries,
        hints,
        study_universe=kwargs["study_universe"],
        mesh_workflow=nondirect_workflow,
        object_regions=kwargs["object_regions"],
    )
    assert nondirect_contract is None
    nondirect_key, nondirect_document = problem._fem_shared_domain_cache_document(
        **{**kwargs, "mesh_workflow": nondirect_workflow},
        mixed_v2_volume_reduction_contract=nondirect_contract,
    )
    assert nondirect_key != direct_key
    assert "mixed_v2_volume_reduction_contract" not in nondirect_document

    per_geometry_override_workflow = {
        "mesh_options": {
            "mesh_strategy": "free_tetrahedral",
        },
        "per_geometry": [
            {"geometry": "box", "mesh_strategy": "swept_prism"},
            {"geometry": "ring", "mesh_strategy": "free_tetrahedral"},
        ],
    }
    assert (
        problem._mixed_v2_volume_reduction_contract_for_request(
            geometries,
            hints,
            study_universe=kwargs["study_universe"],
            mesh_workflow=per_geometry_override_workflow,
            object_regions=kwargs["object_regions"],
        )
        == problem._FEM_MIXED_V2_VOLUME_REDUCTION_CONTRACT
    )

    order2_contract = problem._mixed_v2_volume_reduction_contract_for_request(
        geometries,
        FEM(order=2, maximum_element_size=0.25),
        study_universe=kwargs["study_universe"],
        mesh_workflow=kwargs["mesh_workflow"],
        object_regions=kwargs["object_regions"],
    )
    assert order2_contract is None


def test_compensated_sum_preserves_small_volume_contributions() -> None:
    # Cell/facet reductions must not lose small terms across large cancellation.
    values = [1.0e16, 1.0, -1.0e16, 2.0]
    assert sum(values) != 3.0
    assert _gmsh_swept._mixed_v2_compensated_sum(iter(values)) == 3.0
