"""Readback-contract regressions only; no Docker, native program, or solver."""
from copy import deepcopy
import unittest
import boris_nf_common_case_v3 as common


class CommonMaterialReadbacks(unittest.TestCase):
    def readbacks(self):
        return dict(dataprecision=17,
            normal=deepcopy(common.PARAMETERS["boris_normal"]),
            ferromagnet=deepcopy(common.PARAMETERS["boris_ferromagnet"]))

    def test_native_supported_members_and_explicit_applicability(self):
        descriptor=common.case_descriptor("r0")
        common.validate_material_readbacks(self.readbacks(),descriptor)
        self.assertNotIn("iSHA",descriptor["parameters"]["boris_ferromagnet"])
        self.assertEqual(descriptor["parameters"]["boris_normal"]["iSHA"],0.1)
        contract=descriptor["conventions"]["material_readback_contract"]
        self.assertEqual(contract["upstream_commit"],"048503d2ca6475e91b073eb1762ecf9d3634c3e1")
        self.assertFalse(contract["ferromagnet_iSHA"]["numeric_substitution"])
        for actual in ("",0.0,float("nan")):
            readbacks=self.readbacks();readbacks["ferromagnet"]["iSHA"]=actual
            with self.assertRaises(ValueError):common.validate_material_readbacks(readbacks,descriptor)
        with self.assertRaises(ValueError):common.close_vector("",0.0)

    def test_supported_nonfinite_empty_and_wrong_zero_still_refused(self):
        for actual in ("",float("nan"),float("inf"),0.0):
            readbacks=self.readbacks();readbacks["normal"]["iSHA"]=actual
            with self.assertRaises(ValueError):common.validate_material_readbacks(readbacks,common.case_descriptor("r0"))
        readbacks=self.readbacks();readbacks["ferromagnet"]["SHA"]=1e-20
        with self.assertRaises(ValueError):common.validate_material_readbacks(readbacks,common.case_descriptor("r0"))

    def test_retained_six_digit_voltage_is_not_accepted_by_raw_gate(self):
        with self.assertRaises(ValueError):common.close_vector(0.00172414,common.VOLTAGE_V)
        common.close_vector(common.VOLTAGE_V,common.VOLTAGE_V)
        self.assertEqual(common.OBSERVATION_RELATIVE_TOLERANCE,1e-6)

    def test_serialization_precision_is_exact_observed_binding(self):
        for precision in (6,True,"17",float("nan"),17.0000001):
            readbacks=self.readbacks();readbacks["dataprecision"]=precision
            with self.assertRaises(ValueError):common.validate_material_readbacks(readbacks,common.case_descriptor("r0"))
        for key in common.CASE_KEYS:
            descriptor,script,scenario=common.fixed_inputs(key)
            text=script.decode()
            self.assertLess(text.index('ns.configure('),text.index('ns.dataprecision(17)'))
            self.assertLess(text.index('observed_dataprecision = ns.dataprecision()'),text.index('conductor = ns.Conductor('))
            self.assertIn('readbacks = {"dataprecision":observed_dataprecision}',text)
            self.assertEqual(descriptor["conventions"]["serialization"]["dataprecision"],17)
            self.assertIn('unaffected by dataprecision',descriptor["conventions"]["serialization"]["ovf_text_payload"])
            compile(text,"scenario.py","exec")


if __name__ == "__main__":unittest.main()
