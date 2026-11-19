import unittest

from fullmag.model.structure import (
    MaterialParameterAssignment,
    MaterialParameterField,
    RegionMaterialOverride,
)


PARAMETER_UNITS = {
    "Ms": "A/m",
    "Aex": "J/m",
    "Alpha": "1",
    "AnisotropyAxis": "1",
    "Ku1": "J/m^3",
    "Ku2": "J/m^3",
    "Kc1": "J/m^3",
    "Kc2": "J/m^3",
    "Kc3": "J/m^3",
    "Dind": "J/m^2",
    "Dbulk": "J/m^2",
}
FIELD_KINDS = ("constant", "linear", "radial", "sampled")
OWNER_KINDS = ("override", "assignment")


def _field(kind: str, parameter: str, unit: str | None) -> MaterialParameterField:
    if parameter == "Ms":
        value = 800e3
    elif parameter == "Aex":
        value = 13e-12
    elif parameter == "Alpha":
        value = 0.02
    elif parameter == "AnisotropyAxis":
        value = (0.0, 0.0, 1.0)
    else:
        value = 1.0

    if kind == "constant":
        return MaterialParameterField.constant(value, unit=unit)
    if kind == "linear":
        return MaterialParameterField.linear(
            base=float(value) if not isinstance(value, tuple) else 1.0,
            gradient=(0.0, 0.0, 0.0),
            unit=unit,
        )
    if kind == "radial":
        scalar = float(value) if not isinstance(value, tuple) else 1.0
        return MaterialParameterField.radial(
            center=(0.0, 0.0, 0.0),
            radius=1.0,
            inside=scalar,
            outside=scalar,
            unit=unit,
        )
    if kind == "sampled":
        return MaterialParameterField.sampled(
            asset_id="field:unit-test",
            component_count=3 if parameter == "AnisotropyAxis" else 1,
            location="node",
            unit=unit,
        )
    raise AssertionError(f"unexpected field kind {kind!r}")


def _owned_field(owner_kind: str, parameter: str, value: MaterialParameterField):
    if owner_kind == "override":
        return RegionMaterialOverride(parameter=parameter, value=value)
    if owner_kind == "assignment":
        return MaterialParameterAssignment(
            assignment_id="field:unit-test",
            owner_object="body",
            parameter=parameter,
            value=value,
        )
    raise AssertionError(f"unexpected owner kind {owner_kind!r}")


class MaterialParameterUnitTests(unittest.TestCase):
    def test_export_revalidates_unit_after_payload_mutation(self) -> None:
        for owner_kind in OWNER_KINDS:
            for field_kind in FIELD_KINDS:
                with self.subTest(owner_kind=owner_kind, field_kind=field_kind):
                    value = _field(field_kind, "Aex", "J/m")
                    owned = _owned_field(owner_kind, "Aex", value)
                    value.payload["unit"] = "pJ/m"
                    with self.assertRaisesRegex(ValueError, "unit"):
                        owned.to_ir()

    def test_each_parameter_accepts_its_canonical_unit_across_field_owners_and_kinds(
        self,
    ) -> None:
        for parameter, unit in PARAMETER_UNITS.items():
            for field_kind in FIELD_KINDS:
                for owner_kind in OWNER_KINDS:
                    with self.subTest(
                        parameter=parameter,
                        field_kind=field_kind,
                        owner_kind=owner_kind,
                    ):
                        value = _field(field_kind, parameter, f" {unit} ")
                        owned = _owned_field(owner_kind, parameter, value)
                        self.assertEqual(owned.to_ir()["value"]["unit"], unit)

    def test_analytic_fields_may_omit_unit_for_every_parameter(self) -> None:
        for parameter in PARAMETER_UNITS:
            for field_kind in ("constant", "linear", "radial"):
                for owner_kind in OWNER_KINDS:
                    with self.subTest(
                        parameter=parameter,
                        field_kind=field_kind,
                        owner_kind=owner_kind,
                    ):
                        value = _field(field_kind, parameter, None)
                        owned = _owned_field(owner_kind, parameter, value)
                        self.assertNotIn("unit", owned.to_ir()["value"])

    def test_dimensionless_alias_is_accepted_without_rewriting(self) -> None:
        for parameter in ("Alpha", "AnisotropyAxis"):
            for field_kind in FIELD_KINDS:
                for owner_kind in OWNER_KINDS:
                    with self.subTest(
                        parameter=parameter,
                        field_kind=field_kind,
                        owner_kind=owner_kind,
                    ):
                        value = _field(field_kind, parameter, " dimensionless ")
                        owned = _owned_field(owner_kind, parameter, value)
                        self.assertEqual(
                            owned.to_ir()["value"]["unit"], "dimensionless"
                        )

    def test_unit_validation_preserves_negative_anisotropy_and_zero_values(
        self,
    ) -> None:
        for owner_kind in OWNER_KINDS:
            with self.subTest(owner_kind=owner_kind, parameter="Ku1"):
                negative_ku1 = _field("constant", "Ku1", "J/m^3")
                negative_ku1.payload["value"] = -1.0
                self.assertIsNotNone(_owned_field(owner_kind, "Ku1", negative_ku1))
            for parameter, unit in (("Aex", "J/m"), ("Alpha", "1")):
                with self.subTest(owner_kind=owner_kind, parameter=parameter):
                    zero_value = _field("constant", parameter, unit)
                    zero_value.payload["value"] = 0.0
                    self.assertIsNotNone(
                        _owned_field(owner_kind, parameter, zero_value)
                    )

    def test_wrong_units_are_rejected_for_every_field_kind_and_owner(self) -> None:
        wrong_units = {
            "Ms": ("kA/m",),
            "Aex": ("pJ/m", "A/m"),
            "Alpha": ("mT",),
            "AnisotropyAxis": ("A/m",),
            "Ku1": ("J/m",),
            "Ku2": ("A/m",),
            "Kc1": ("J/m^2",),
            "Kc2": ("J/m",),
            "Kc3": ("mT",),
            "Dind": ("J/m^3",),
            "Dbulk": ("pJ/m",),
        }
        for parameter, units in wrong_units.items():
            for unit in units:
                for field_kind in FIELD_KINDS:
                    for owner_kind in OWNER_KINDS:
                        with self.subTest(
                            parameter=parameter,
                            unit=unit,
                            field_kind=field_kind,
                            owner_kind=owner_kind,
                        ):
                            value = _field(field_kind, parameter, unit)
                            with self.assertRaisesRegex(ValueError, "unit"):
                                _owned_field(owner_kind, parameter, value)

    def test_blank_and_missing_sampled_units_are_rejected_at_owner_validation(
        self,
    ) -> None:
        for owner_kind in OWNER_KINDS:
            for parameter, unit in PARAMETER_UNITS.items():
                with self.subTest(
                    owner_kind=owner_kind, parameter=parameter, case="blank"
                ):
                    blank_unit_field = _field("constant", parameter, unit)
                    blank_unit_field.payload["unit"] = "   "
                    with self.assertRaisesRegex(ValueError, "unit"):
                        _owned_field(owner_kind, parameter, blank_unit_field)

                with self.subTest(
                    owner_kind=owner_kind,
                    parameter=parameter,
                    case="missing_sampled",
                ):
                    sampled = MaterialParameterField(
                        {
                            "kind": "sampled",
                            "asset_id": "field:unit-test",
                            "component_count": (
                                3 if parameter == "AnisotropyAxis" else 1
                            ),
                            "location": "node",
                        }
                    )
                    with self.assertRaisesRegex(ValueError, "unit"):
                        _owned_field(owner_kind, parameter, sampled)

    def test_explicit_null_analytic_units_are_treated_as_omitted(self) -> None:
        for owner_kind in OWNER_KINDS:
            for parameter in PARAMETER_UNITS:
                for field_kind in ("constant", "linear", "radial"):
                    with self.subTest(
                        owner_kind=owner_kind,
                        parameter=parameter,
                        field_kind=field_kind,
                    ):
                        value = _field(field_kind, parameter, None)
                        value.payload["unit"] = None
                        owned = _owned_field(owner_kind, parameter, value)
                        self.assertIsNone(owned.to_ir()["value"]["unit"])


if __name__ == "__main__":
    unittest.main()
