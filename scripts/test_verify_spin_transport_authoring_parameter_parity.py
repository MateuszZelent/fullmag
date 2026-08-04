from __future__ import annotations

import unittest

from scripts.verify_spin_transport_authoring_parameter_parity import validate_report


def _valid_report() -> dict[str, object]:
    return {
        "schema_version": "fullmag.spin_transport_authoring_parameter_parity.v1",
        "status": "pass",
        "manifest_path": "docs/specs/spin-transport-authoring-parameter-parity-v1.json",
        "manifest_sha256": "a" * 64,
        "source_commit": "b" * 40,
        "layers": {
            "manifest": {"status": "pass"},
            "python": {"status": "pass"},
            "rust": {"status": "pass"},
            "ui": {"status": "pass"},
        },
        "unsupported_cases": [
            {"id": "execution.fem_gpu_rt0", "fallback_forbidden": True}
        ],
        "qualification_boundary": {
            "authoring_parity": "pass",
            "physics": "not_qualified",
            "backend_capability_promotion": "forbidden",
        },
    }


class SpinTransportAuthoringParityReportTests(unittest.TestCase):
    def test_report_shape_requires_all_layers_and_qualification_boundary(self) -> None:
        validate_report(_valid_report())

    def test_report_rejects_validated_status_or_hidden_fallback(self) -> None:
        validated = _valid_report()
        validated["status"] = "validated"
        with self.assertRaisesRegex(ValueError, "validated"):
            validate_report(validated)

        fallback = _valid_report()
        fallback["unsupported_cases"] = [
            {"id": "execution.fem_gpu_rt0", "fallback_forbidden": False}
        ]
        with self.assertRaisesRegex(ValueError, "fallback"):
            validate_report(fallback)


if __name__ == "__main__":
    unittest.main()
