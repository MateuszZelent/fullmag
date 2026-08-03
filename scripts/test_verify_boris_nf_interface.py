from __future__ import annotations

import json
from pathlib import Path

import pytest

from verify_boris_nf_interface import (
    InterfaceSlice,
    MeshFields,
    OvfField,
    ScenarioParameters,
    compute_field_residuals,
    compute_interface_balance,
    compute_interface_slice,
    map_boris_spin_to_fullmag_mu_s,
    read_text_ovf,
    validate_boris_artifact,
)


def _write_text_ovf(path: Path, values: list[tuple[float, ...]], valuedim: int) -> None:
    rows = "\n".join(" ".join(str(value) for value in row) for row in values)
    path.write_text(
        f"""# OOMMF OVF 2.0
# Begin: Segment
# Begin: Header
# meshtype: rectangular
# xnodes: 2
# ynodes: 1
# znodes: 1
# xmin: 0
# ymin: 0
# zmin: 0
# xstepsize: 1e-9
# ystepsize: 1e-9
# zstepsize: 1e-9
# valuedim: {valuedim}
# End: Header
# Begin: Data Text
{rows}
# End: Data Text
# End: Segment
""",
        encoding="utf-8",
    )


def test_text_ovf_reader_preserves_grid_and_vector_order(tmp_path: Path) -> None:
    path = tmp_path / "field.ovf"
    _write_text_ovf(path, [(1.0, 2.0, 3.0), (4.0, 5.0, 6.0)], valuedim=3)

    field = read_text_ovf(path)

    assert field.shape == (2, 1, 1)
    assert field.values == ((1.0, 2.0, 3.0), (4.0, 5.0, 6.0))


def test_spin_adapter_declares_full_splitting() -> None:
    mapped = map_boris_spin_to_fullmag_mu_s([(1.0, 0.0, 0.0)], 0.01, 5.8e7)

    assert mapped[0][0] == pytest.approx(2.0 * 0.01 / (5.8e7 * 5.788381608e-5))


def test_field_residuals_are_finite_for_constant_flux(tmp_path: Path) -> None:
    charge = tmp_path / "charge.ovf"
    spin_x = tmp_path / "spin_x.ovf"
    spin_y = tmp_path / "spin_y.ovf"
    spin_z = tmp_path / "spin_z.ovf"
    accumulation = tmp_path / "accumulation.ovf"
    rows = [(1.0, 0.0, 0.0), (1.0, 0.0, 0.0)]
    zero = [(0.0, 0.0, 0.0), (0.0, 0.0, 0.0)]
    for path, values in (
        (charge, rows),
        (spin_x, zero),
        (spin_y, zero),
        (spin_z, zero),
        (accumulation, zero),
    ):
        _write_text_ovf(path, values, valuedim=3)
    fields = MeshFields(
        charge_current=read_text_ovf(charge),
        spin_current_x=read_text_ovf(spin_x),
        spin_current_y=read_text_ovf(spin_y),
        spin_current_z=read_text_ovf(spin_z),
        spin_accumulation=read_text_ovf(accumulation),
    )

    result = compute_field_residuals(
        fields,
        ScenarioParameters(conductivity_spm=5.8e7, de_m2_per_s=0.01, lambda_sf_m=5e-9),
    )

    assert result["charge_scaled_l2"] == pytest.approx(0.0)
    assert result["spin_scaled_l2"] == pytest.approx(0.0)


def test_charge_residual_uses_matching_flux_component_for_each_axis() -> None:
    shape = (3, 3, 3)
    values = tuple(
        (float(i), float(j), float(k))
        for k in range(shape[2])
        for j in range(shape[1])
        for i in range(shape[0])
    )
    charge = OvfField(Path("charge.ovf"), shape, (0.0, 0.0, 0.0), (1.0, 1.0, 1.0), 3, values, "charge")
    zero = OvfField(Path("zero.ovf"), shape, (0.0, 0.0, 0.0), (1.0, 1.0, 1.0), 3, tuple((0.0, 0.0, 0.0) for _ in values), "zero")

    result = compute_field_residuals(
        MeshFields(charge, zero, zero, zero, zero),
        ScenarioParameters(conductivity_spm=5.8e7, de_m2_per_s=0.01, lambda_sf_m=5e-9),
    )

    assert result["charge_scaled_l2"] == pytest.approx(1.5)


def test_spin_residual_uses_native_boris_units() -> None:
    """The independent check must evaluate div(Js)+De*S/lambda^2 in BORIS units."""

    shape = (3, 3, 3)
    zero_vectors = tuple((0.0, 0.0, 0.0) for _ in range(27))
    accumulation_values = list(zero_vectors)
    accumulation_values[13] = (1.0, 0.0, 0.0)
    spin_z_values = list(zero_vectors)
    spin_z_values[22] = (-1.0, 0.0, 0.0)  # k=2 at the interior x/y index
    spin_z_values[4] = (1.0, 0.0, 0.0)   # k=0 at the interior x/y index
    fields = MeshFields(
        charge_current=OvfField(
            Path("charge.ovf"), shape, (0.0, 0.0, 0.0), (1.0, 1.0, 1.0), 3,
            zero_vectors, "charge",
        ),
        spin_current_x=OvfField(
            Path("spin_x.ovf"), shape, (0.0, 0.0, 0.0), (1.0, 1.0, 1.0), 3,
            zero_vectors, "spin_x",
        ),
        spin_current_y=OvfField(
            Path("spin_y.ovf"), shape, (0.0, 0.0, 0.0), (1.0, 1.0, 1.0), 3,
            zero_vectors, "spin_y",
        ),
        spin_current_z=OvfField(
            Path("spin_z.ovf"), shape, (0.0, 0.0, 0.0), (1.0, 1.0, 1.0), 3,
            tuple(spin_z_values), "spin_z",
        ),
        spin_accumulation=OvfField(
            Path("accumulation.ovf"), shape, (0.0, 0.0, 0.0), (1.0, 1.0, 1.0), 3,
            tuple(accumulation_values), "accumulation",
        ),
    )

    result = compute_field_residuals(
        fields,
        ScenarioParameters(conductivity_spm=2.0, de_m2_per_s=1.0, lambda_sf_m=1.0),
    )

    assert result["spin_scaled_l2"] == pytest.approx(0.0)


def test_ferromagnet_residual_includes_exchange_and_dephasing() -> None:
    shape = (3, 3, 3)
    zero_vectors = tuple((0.0, 0.0, 0.0) for _ in range(27))
    accumulation_values = list(zero_vectors)
    accumulation_values[13] = (0.0, 1.0, 0.0)
    spin_z_values = list(zero_vectors)
    spin_z_values[22] = (0.0, -2.0, 1.0)
    spin_z_values[4] = (0.0, 2.0, -1.0)
    fields = MeshFields(
        OvfField(Path("charge.ovf"), shape, (0.0, 0.0, 0.0), (1.0, 1.0, 1.0), 3, zero_vectors, "charge"),
        OvfField(Path("spin_x.ovf"), shape, (0.0, 0.0, 0.0), (1.0, 1.0, 1.0), 3, zero_vectors, "spin_x"),
        OvfField(Path("spin_y.ovf"), shape, (0.0, 0.0, 0.0), (1.0, 1.0, 1.0), 3, zero_vectors, "spin_y"),
        OvfField(Path("spin_z.ovf"), shape, (0.0, 0.0, 0.0), (1.0, 1.0, 1.0), 3, tuple(spin_z_values), "spin_z"),
        OvfField(Path("accumulation.ovf"), shape, (0.0, 0.0, 0.0), (1.0, 1.0, 1.0), 3, tuple(accumulation_values), "accumulation"),
    )

    result = compute_field_residuals(
        fields,
        ScenarioParameters(
            conductivity_spm=2.0,
            de_m2_per_s=1.0,
            lambda_sf_m=1.0,
            l_ex_m=1.0,
            l_ph_m=1.0,
            magnetization=(1.0, 0.0, 0.0),
        ),
        material="ferromagnet",
    )

    assert result["spin_scaled_l2"] == pytest.approx(0.0)
    assert "exchange" in str(result["spin_reaction_model"])


def test_interface_balance_rejects_wrong_normal_sign() -> None:
    with pytest.raises(ValueError, match="normal"):
        compute_interface_balance(
            InterfaceSlice(
                normal_axis="q",
                normal_sign=0,
                normal_flux=(0.0, 0.0, 0.0),
                ferromagnet_flux=(0.0, 0.0, 0.0),
                torque=(0.0, 0.0, 0.0),
            )
        )


def test_interface_slice_uses_normal_flux_and_tsi_thickness() -> None:
    shape = (2, 1, 2)
    grid = (0.0, 0.0, 0.0)
    step = (1.0, 1.0, 0.5)

    def vector(path: str, values: tuple[tuple[float, float, float], ...]) -> OvfField:
        return OvfField(Path(path), shape, grid, step, 3, values, path)

    zeros = tuple((0.0, 0.0, 0.0) for _ in range(4))
    normal = MeshFields(
        vector("n_jc", ((0.0, 0.0, 10.0),) * 4),
        vector("n_jsx", ((0.0, 0.0, 1.0),) * 4),
        vector("n_jsy", ((0.0, 0.0, 2.0),) * 4),
        vector("n_jsz", ((0.0, 0.0, 3.0),) * 4),
        vector("n_s", zeros),
    )
    ferromagnet = MeshFields(
        vector("f_jc", ((0.0, 0.0, 8.0),) * 4),
        vector("f_jsx", ((0.0, 0.0, 0.5),) * 4),
        vector("f_jsy", ((0.0, 0.0, 1.0),) * 4),
        vector("f_jsz", ((0.0, 0.0, 1.5),) * 4),
        vector("f_s", zeros),
    )
    torque = vector(
        "f_tsi",
        ((4.0, 5.0, 6.0), (4.0, 5.0, 6.0), (0.0, 0.0, 0.0), (0.0, 0.0, 0.0)),
    )

    interface = compute_interface_slice(normal, ferromagnet, torque)

    assert interface.normal_flux == (1.0, 2.0, 3.0)
    assert interface.ferromagnet_flux == (0.5, 1.0, 1.5)
    assert interface.torque == (2.0, 2.5, 3.0)
    assert interface.charge_flux == 10.0
    assert interface.ferromagnet_charge_flux == 8.0


def test_artifact_validation_is_fail_closed(tmp_path: Path) -> None:
    payload = {
        "schema_version": "fullmag.boris_she_nf.v1",
        "runtime": {"identity_complete": True},
        "scenario": {
            "workload": "N/F",
            "parameters": {
                "SHA": 0.1,
                "iSHA": 0.1,
                "Gi_Spm2": 5.0e14,
                "Gmix_Spm2": [1.5e15, 0.0],
            },
        },
        "fields": {
            "normal": {name: "n_field.ovf" for name in ("V", "S", "Jc", "Jsx", "Jsy", "Jsz")},
            "ferromagnet": {
                name: "f_field.ovf"
                for name in ("V", "S", "Jc", "Jsx", "Jsy", "Jsz", "Ts", "Tsi")
            },
        },
        "residuals": {"charge_scaled_l2": 0.0, "spin_scaled_l2": 0.0},
        "interface_balances": {"charge_closure": 0.0, "spin_torque_closure": 0.0},
        "qualification": {"status": "diagnostic"},
    }
    (tmp_path / "n_field.ovf").write_text("# OOMMF OVF 2.0\n", encoding="utf-8")
    (tmp_path / "f_field.ovf").write_text("# OOMMF OVF 2.0\n", encoding="utf-8")
    (tmp_path / "summary.json").write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(ValueError, match="OVF"):
        validate_boris_artifact(tmp_path)
