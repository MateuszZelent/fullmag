import unittest

import fullmag as fm
from fullmag.runtime.script_builder import _render_antenna_spectrum_request_expr


class AntennaSpectrumSamplingContractTests(unittest.TestCase):
    def plane(self, **overrides):
        parameters = dict(
            origin_m=(1e-7, -2e-7, 3e-7), axis_u=(0, 1, 0), axis_v=(0, 0, 1),
            extent_u_m=2e-6, extent_v_m=3e-6, sample_count_u=5, sample_count_v=7,
            interpolation="fdm_trilinear", outside_policy="zero",
        )
        return fm.AntennaSpectrumSamplingPlane(**(parameters | overrides))

    def test_sampling_counts_reject_values_outside_ir_u32(self):
        for axis in ("sample_count_u", "sample_count_v"):
            for count in (0, 1, 2**32, 2**64, 3.0, True):
                with self.subTest(axis=axis, count=count):
                    with self.assertRaisesRegex(ValueError, axis):
                        self.plane(**{axis: count})

    def test_sampling_count_boundary_serializes_without_allocation(self):
        for count in (2, 2**32 - 1):
            payload = self.plane(sample_count_u=count, sample_count_v=count).to_ir()
            self.assertEqual(payload["sample_count_u"], count)
            self.assertEqual(payload["sample_count_v"], count)

    def test_fft_and_explicit_k_grid_preserve_sampling_contract(self):
        for transform in ("spatial_fft", "nonuniform_spatial_fft"):
            for window in ("rectangular", "hann", "hamming", "blackman"):
                for normalization in ("integral_si", "unitary_discrete"):
                    with self.subTest(transform=transform, window=window, normalization=normalization):
                        grid = (fm.AntennaSpectrumKGrid(
                            k_u_rad_per_m=(-2e7, 0.0, 1e7),
                            k_v_rad_per_m=(-3e7, 4e7),
                        ) if transform == "nonuniform_spatial_fft" else None)
                        request = fm.AntennaSpectrumRequest(
                            id="spectrum", solution_ref=fm.AntennaStageOutputRef("solve", "basis"),
                            target=fm.FieldTarget.object("magnet"), transform=transform,
                            sampling_plane=self.plane(), window=window, normalization=normalization,
                            component="vector_power", output_id="spectrum_output",
                            port_mode_id="port", nonuniform_k_grid=grid,
                        )
                        payload = request.to_ir()
                        restored = eval(_render_antenna_spectrum_request_expr(payload), {"fm": fm})
                        self.assertEqual(restored.to_ir(), payload)
                        if grid is not None:
                            self.assertEqual(payload["nonuniform_k_grid"], grid.to_ir())


if __name__ == "__main__":
    unittest.main()
