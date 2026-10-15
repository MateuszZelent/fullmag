from __future__ import annotations

from typing import Any

import pytest

import fullmag as fm


FINGERPRINT = "sha256:" + "a" * 64


def binding(node_count: int = 1) -> fm.MaterialNodalFieldBinding:
    return fm.MaterialNodalFieldBinding(FINGERPRINT, node_count)


def material(**kwargs: Any) -> fm.Material:
    return fm.Material(
        name="Py",
        Ms=8.0e5,
        A=1.3e-11,
        alpha=0.01,
        **kwargs,
    )


@pytest.mark.parametrize(
    "fingerprint",
    [
        "sha256:" + "A" * 64,
        "SHA256:" + "a" * 64,
        "sha256:" + "a" * 63,
        "sha256:" + "a" * 65,
        "sha256:" + "g" * 64,
        "sha256:" + "a" * 63 + " ",
    ],
)
def test_binding_requires_exact_lowercase_sha256_fingerprint(fingerprint: str) -> None:
    with pytest.raises(ValueError, match="sha256"):
        fm.MaterialNodalFieldBinding(fingerprint, 1)


@pytest.mark.parametrize("node_count", [0, -1])
def test_binding_requires_positive_node_count(node_count: int) -> None:
    with pytest.raises(ValueError, match="positive"):
        fm.MaterialNodalFieldBinding(FINGERPRINT, node_count)


@pytest.mark.parametrize("node_count", [True, 1.0, "1"])
def test_binding_rejects_boolean_and_non_integer_node_counts(node_count: Any) -> None:
    with pytest.raises(TypeError, match="integer"):
        fm.MaterialNodalFieldBinding(FINGERPRINT, node_count)


def test_all_ten_nodal_fields_map_to_existing_si_ir_fields_and_copy_snapshots() -> None:
    values = {
        "Ms_field": [8.0e5, 8.1e5],
        "A_field": [1.3e-11, 1.4e-11],
        "alpha_field": [0.01, 0.02],
        "Ku_field": [-2.0e4, 3.0e4],
        "Ku2_field": [-4.0e3, 2.0e3],
        "Kc1_field": [-1.0e3, 2.0e3],
        "Kc2_field": [3.0e3, -4.0e3],
        "Kc3_field": [-5.0e3, 6.0e3],
        "Dind_field": [-1.0e-3, 2.0e-3],
        "Dbulk_field": [3.0e-4, -4.0e-4],
    }
    instance = material(nodal_field_binding=binding(2), **values)

    ir = instance.to_ir()

    expected = {
        "ms_field": "Ms_field",
        "a_field": "A_field",
        "alpha_field": "alpha_field",
        "ku_field": "Ku_field",
        "ku2_field": "Ku2_field",
        "kc1_field": "Kc1_field",
        "kc2_field": "Kc2_field",
        "kc3_field": "Kc3_field",
        "dind_field": "Dind_field",
        "dbulk_field": "Dbulk_field",
    }
    for ir_name, python_name in expected.items():
        assert ir[ir_name] == values[python_name]
        assert ir[ir_name] is not values[python_name]
    assert ir["nodal_field_binding"] == {
        "canonical_mesh_fingerprint": FINGERPRINT,
        "node_count": 2,
    }


def test_material_nodal_fields_require_binding_and_binding_requires_fields() -> None:
    with pytest.raises(ValueError, match="require nodal_field_binding"):
        material(Ms_field=[8.0e5])

    with pytest.raises(ValueError, match="requires at least one"):
        material(nodal_field_binding=binding())


@pytest.mark.parametrize(
    ("field_name", "value", "message"),
    [
        ("Ms_field", [True], "boolean"),
        ("Ku_field", [float("nan")], "finite"),
        ("Kc2_field", [float("inf")], "finite"),
    ],
)
def test_nodal_fields_reject_boolean_and_non_finite_values(
    field_name: str,
    value: Any,
    message: str,
) -> None:
    with pytest.raises(ValueError, match=message):
        material(nodal_field_binding=binding(), **{field_name: value})


@pytest.mark.parametrize("field_name", [
    "Ms_field",
    "A_field",
    "alpha_field",
    "Ku_field",
    "Ku2_field",
    "Kc1_field",
    "Kc2_field",
    "Kc3_field",
    "Dind_field",
    "Dbulk_field",
])
def test_every_nodal_field_rejects_nan(field_name: str) -> None:
    with pytest.raises(ValueError, match="finite"):
        material(nodal_field_binding=binding(), **{field_name: [float("nan")]})


@pytest.mark.parametrize(
    ("field_name", "value", "message"),
    [
        ("Ms_field", [0.0], "positive"),
        ("Ms_field", [-1.0], "positive"),
        ("A_field", [-1.0], "non-negative"),
        ("alpha_field", [-0.01], "non-negative"),
    ],
)
def test_nodal_fields_enforce_physical_sign_rules(
    field_name: str,
    value: list[float],
    message: str,
) -> None:
    with pytest.raises(ValueError, match=message):
        material(nodal_field_binding=binding(), **{field_name: value})


def test_nodal_fields_reject_empty_and_mismatched_lengths() -> None:
    with pytest.raises(ValueError, match="not be empty"):
        material(nodal_field_binding=binding(), Ms_field=[])

    with pytest.raises(ValueError, match="declares 1 nodes"):
        material(nodal_field_binding=binding(), Ku_field=[1.0, 2.0])


def test_signed_anisotropy_and_dmi_values_are_preserved() -> None:
    instance = material(
        nodal_field_binding=binding(2),
        Ku_field=[-1.0, -2.0],
        Ku2_field=[-3.0, -4.0],
        Kc1_field=[-5.0, -6.0],
        Kc2_field=[-7.0, -8.0],
        Kc3_field=[-9.0, -10.0],
        Dind_field=[-0.1, -0.2],
        Dbulk_field=[-0.3, -0.4],
    )

    ir = instance.to_ir()

    assert ir["ku_field"] == [-1.0, -2.0]
    assert ir["ku2_field"] == [-3.0, -4.0]
    assert ir["kc1_field"] == [-5.0, -6.0]
    assert ir["kc2_field"] == [-7.0, -8.0]
    assert ir["kc3_field"] == [-9.0, -10.0]
    assert ir["dind_field"] == [-0.1, -0.2]
    assert ir["dbulk_field"] == [-0.3, -0.4]


def test_to_ir_revalidates_mutated_lists_before_serializing() -> None:
    values = [8.0e5]
    instance = material(nodal_field_binding=binding(), Ms_field=values)
    values[0] = float("nan")

    with pytest.raises(ValueError, match="finite"):
        instance.to_ir()

    values[0] = 8.0e5
    values.append(8.1e5)
    with pytest.raises(ValueError, match="declares 1 nodes"):
        instance.to_ir()


def test_scalar_material_omits_binding_for_legacy_wire_compatibility() -> None:
    assert "nodal_field_binding" not in material().to_ir()
