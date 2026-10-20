import unittest
from dataclasses import replace

import fullmag as fm
from fullmag.runtime.script_builder import _render_antenna_spectrum_request_expr


class AntennaEquilibriumReferenceTests(unittest.TestCase):
    def request(self, reference):
        return fm.AntennaSpectrumRequest(
            id="transverse", solution_ref=fm.AntennaStageOutputRef("solve", "basis"),
            target=fm.FieldTarget.object("magnet"), transform="spatial_fft",
            sampling_plane=fm.AntennaSpectrumSamplingPlane(
                origin_m=(0, 0, 0), axis_u=(1, 0, 0), axis_v=(0, 1, 0),
                extent_u_m=1e-6, extent_v_m=1e-6, sample_count_u=3, sample_count_v=3,
                interpolation="fem_element", outside_policy="error"),
            window="rectangular", normalization="integral_si", component="transverse",
            output_id="transverse", equilibrium_ref=reference,
        )

    def test_exact_typed_and_legacy_export_round_trip(self):
        digest = "a" * 64
        for reference in (
            fm.EquilibriumStageOutputRef("relax"),
            fm.EquilibriumArtifactRef(digest, "antenna_accepted_equilibrium.v1:" + digest, "sha256:" + digest),
            "antenna_accepted_equilibrium.v1:" + digest,
        ):
            with self.subTest(reference=reference):
                request = self.request(reference)
                payload = request.to_ir()
                restored = eval(_render_antenna_spectrum_request_expr(payload), {"fm": fm})
                self.assertEqual(restored.to_ir(), payload)
                with self.assertRaisesRegex(ValueError, "only valid"):
                    replace(request, component="x")

    def test_identity_pins_reject_paths_malformed_hash_and_empty_stage(self):
        valid = "b" * 64
        with self.assertRaises(ValueError):
            fm.EquilibriumStageOutputRef(" ")
        for asset, identity, digest in (
            ("C:/tmp/equilibrium.json", "antenna_accepted_equilibrium.v1:" + valid, "sha256:" + valid),
            (valid, "accepted:" + valid, "sha256:" + valid),
            (valid, "antenna_accepted_equilibrium.v1:" + valid, "sha256:" + "B" * 64),
        ):
            with self.subTest(asset=asset, identity=identity, digest=digest):
                with self.assertRaises(ValueError):
                    fm.EquilibriumArtifactRef(asset, identity, digest)
        with self.assertRaisesRegex(ValueError, "immutable equilibrium identity"):
            self.request("equilibrium.json")
        with self.assertRaisesRegex(ValueError, "requires equilibrium_ref"):
            self.request(None)

    def test_export_rejects_unknown_reference_members(self):
        payload = self.request(fm.EquilibriumStageOutputRef("relax")).to_ir()
        payload["equilibrium_ref"]["hidden_ref"] = "objects/" + "c" * 64
        with self.assertRaises(ValueError):
            _render_antenna_spectrum_request_expr(payload)


if __name__ == "__main__":
    unittest.main()
