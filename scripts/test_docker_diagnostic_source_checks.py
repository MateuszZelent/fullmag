import unittest
from docker_build_control import BuildControlError
from docker_diagnostic_source_checks import validate_diagnostic_evidence

class DiagnosticSourceCheckAdmissionTests(unittest.TestCase):
    def evidence(self):
        return {"schema": "fullmag.pre-owner-diagnostic-source-check.v1",
                "api_instance_id": "8ed45339-7f48-4c4f-9cee-8ce14642c581",
                "fence_sha256": "a" * 64, "owner_absent": True,
                "process_receipt_absent": True, "native_processes": 0,
                "active_reservations": 0, "active_local_leases": 0,
                "api_health": "degraded", "active_session": False}

    def test_accepts_only_fenced_empty_pre_owner_diagnostic(self):
        self.assertEqual(validate_diagnostic_evidence(self.evidence()), self.evidence())

    def test_rejects_native_owner_processes_and_leases(self):
        for key, value in (("owner_absent", False), ("process_receipt_absent", False),
                           ("native_processes", 1), ("active_reservations", 1),
                           ("active_local_leases", 1), ("active_session", True),
                           ("api_health", "ok"), ("schema", "unknown")):
            with self.subTest(key=key):
                evidence = self.evidence()
                evidence[key] = value
                with self.assertRaises(BuildControlError):
                    validate_diagnostic_evidence(evidence)

    def test_rejects_missing_or_unpinned_evidence(self):
        for key in self.evidence():
            evidence = self.evidence()
            del evidence[key]
            with self.assertRaises(BuildControlError):
                validate_diagnostic_evidence(evidence)
        evidence = self.evidence()
        evidence["api_instance_id"] = "not-an-instance"
        with self.assertRaises(BuildControlError):
            validate_diagnostic_evidence(evidence)

if __name__ == "__main__":
    unittest.main()
