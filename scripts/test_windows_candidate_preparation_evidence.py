"""Interpreted refusal checks for native fault-process evidence."""
import copy
import io
import json
import unittest

from windows import verify_candidate_preparation as probe


class CandidateEvidenceChecks(unittest.TestCase):
    def evidence(self):
        frames = [{"schema": probe.PROGRESS_SCHEMA, "event": "started",
                   "case": case, "pid": 100 + index}
                  for index, case in enumerate(sorted(probe.CASES))]
        records = probe.progress_records(frames)
        result = {"schema": probe.RESULT_SCHEMA, "status": "passed", "poll_elapsed_ms": 7,
                  "checks": {check: True for check in probe.CHECKS},
                  "processes": [{"case": case, "pid": record["pid"], "waited": True,
                                 "exit_code": 0 if case == "success" else 1,
                                 "outcome": "completed" if case == "success" else "failed"}
                                for case, record in records.items()]}
        return frames, records, result

    def test_early_record_retains_unknown_custody(self):
        _, records, _ = self.evidence()
        self.assertEqual(set(records), probe.CASES)
        self.assertTrue(all(r["waited"] is False and r["outcome"] == "unknown"
                            for r in records.values()))

    def test_complete_matching_terminal_evidence(self):
        _, records, result = self.evidence()
        terminal = probe.validate_result(result, records)
        self.assertTrue(all(r["waited"] is True for r in terminal.values()))
        self.assertTrue(all(r["waited"] is False for r in records.values()))

    def test_unknown_unwaited_or_foreign_process_refused(self):
        _, records, result = self.evidence()
        for key, value in (("waited", False), ("waited", 1), ("exit_code", None),
                           ("exit_code", True), ("pid", 999), ("pid", True),
                           ("outcome", "unknown"), ("case", "foreign")):
            with self.subTest(key=key, value=value):
                changed = copy.deepcopy(result)
                changed["processes"][0][key] = value
                with self.assertRaises(probe.storage.StorageError):
                    probe.validate_result(changed, records)

    def test_missing_duplicate_or_failed_gate_refused(self):
        _, records, result = self.evidence()
        changes = [lambda r: r["processes"].pop(),
                   lambda r: r["processes"].__setitem__(0, r["processes"][1]),
                   lambda r: r["checks"].__setitem__("poll_nonblocking", False),
                   lambda r: r.__setitem__("poll_elapsed_ms", 1000),
                   lambda r: r.__setitem__("poll_elapsed_ms", True)]
        for change in changes:
            changed = copy.deepcopy(result)
            change(changed)
            with self.assertRaises(probe.storage.StorageError):
                probe.validate_result(changed, records)

    def test_duplicate_pid_or_case_and_invalid_early_frames_refused(self):
        frames, _, _ = self.evidence()
        changed = copy.deepcopy(frames)
        changed[1]["pid"] = changed[0]["pid"]
        with self.assertRaises(probe.storage.StorageError):
            probe.progress_records(changed)
        with self.assertRaises(probe.storage.StorageError):
            probe.progress_records([frames[0], frames[0]])
        for key, value in (("pid", True), ("pid", 0), ("event", "finished"),
                           ("case", []), ("extra", "untrusted")):
            with self.subTest(key=key, value=value):
                changed = dict(frames[0])
                changed[key] = value
                with self.assertRaises(probe.storage.StorageError):
                    probe.progress_records([changed])

    def test_partial_timeout_frame_preserves_prior_helper_pid(self):
        frames, _, _ = self.evidence()
        raw = json.dumps(frames[0]).encode() + b'\n{"schema":"partial'
        receipt = {"processes": []}
        parsed, records = probe.frames_with_custody(raw, receipt, False)
        self.assertEqual(len(parsed), 1)
        self.assertEqual(receipt["processes"], list(records.values()))
        self.assertFalse(receipt["processes"][0]["waited"])

    def test_bad_complete_frame_does_not_erase_prior_helper_pid(self):
        frames, _, _ = self.evidence()
        receipt = {"processes": []}
        raw = json.dumps(frames[0]).encode() + b'\n{invalid}\n'
        with self.assertRaises(json.JSONDecodeError):
            probe.frames_with_custody(raw, receipt, True)
        self.assertEqual(receipt["processes"][0]["pid"], frames[0]["pid"])
        self.assertEqual(receipt["processes"][0]["outcome"], "unknown")

    def test_collector_enforces_live_log_limit(self):
        capture = probe.BoundedCapture(io.BytesIO(b"x" * (probe.MAX_LOG_BYTES + 1)))
        self.assertTrue(capture.done.wait(2))
        capture.thread.join(timeout=1)
        self.assertFalse(capture.thread.is_alive())
        self.assertTrue(capture.overflow)
        self.assertEqual(len(capture.snapshot()), probe.MAX_LOG_BYTES)

    def test_failed_gate_still_has_separate_terminal_custody(self):
        _, records, result = self.evidence()
        result["status"] = "failed"
        result["checks"]["poll_nonblocking"] = False
        terminal = probe.terminal_records(result, records)
        self.assertTrue(all(item["waited"] is True for item in terminal.values()))
        with self.assertRaises(probe.storage.StorageError):
            probe.validate_result(result, records)


if __name__ == "__main__":
    unittest.main()
