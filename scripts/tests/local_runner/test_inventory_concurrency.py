"""Regression checks for shared storage inventory work, without real cleanup."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from local_runner.observability import ObservabilityHub


class InventoryConcurrencyTests(unittest.TestCase):
    def make_hub(self, directory):
        root = Path(directory)
        (root / "cache" / "cargo").mkdir(parents=True)
        return ObservabilityHub(root)

    def test_slow_scan_cache_age_starts_on_completion(self):
        with tempfile.TemporaryDirectory() as directory:
            hub = self.make_hub(directory)
            clock = [100.0]
            def scan(_):
                clock[0] = 200.0
                return (123, 1, False)
            with patch("local_runner.observability.time.time", side_effect=lambda: clock[0]), \
                 patch("local_runner.observability.time.monotonic", side_effect=lambda: clock[0]), \
                 patch("local_runner.observability._fast_dir_size", side_effect=scan) as scanner:
                first = hub.get_storage_resources()
                scans = scanner.call_count
                clock[0] = 201.0
                second = hub.get_storage_resources()
                self.assertIs(first, second)
                self.assertEqual(scans, scanner.call_count)

    def test_concurrent_refreshes_share_one_scan_and_keep_telemetry_available(self):
        with tempfile.TemporaryDirectory() as directory:
            hub = self.make_hub(directory)
            entered = threading.Event()
            duplicate = threading.Event()
            release = threading.Event()
            second_started = threading.Event()
            counter_lock = threading.Lock()
            count = [0]
            def scan(_):
                with counter_lock:
                    count[0] += 1
                    number = count[0]
                if number == 1:
                    entered.set()
                    if not release.wait(3):
                        raise TimeoutError("test scan was not released")
                else:
                    duplicate.set()
                return (123, 1, False)
            def second_call():
                second_started.set()
                return hub.get_storage_resources()
            with patch("local_runner.observability._fast_dir_size", side_effect=scan), \
                 ThreadPoolExecutor(max_workers=3) as pool:
                first = pool.submit(hub.get_storage_resources)
                try:
                    self.assertTrue(entered.wait(2))
                    second = pool.submit(second_call)
                    self.assertTrue(second_started.wait(2))
                    # A blocked inventory must not hold the hub telemetry lock.
                    event = pool.submit(hub.record_event, "INFO", "test", "test").result(timeout=2)
                    self.assertEqual("test", event["event"])
                    self.assertFalse(duplicate.wait(0.3), "parallel full inventory scan")
                finally:
                    release.set()
                self.assertIs(first.result(timeout=2), second.result(timeout=2))
                self.assertEqual(1, count[0])

    def test_pin_change_during_scan_is_reflected_before_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            hub = self.make_hub(directory)
            entered, release = threading.Event(), threading.Event()
            calls = [0]
            def scan(_):
                calls[0] += 1
                if calls[0] == 1:
                    entered.set()
                    if not release.wait(3):
                        raise TimeoutError("test scan was not released")
                return (123, 1, False)
            with patch("local_runner.observability._fast_dir_size", side_effect=scan), \
                 patch.object(hub, "_scan_storage_resources", wraps=hub._scan_storage_resources) as inventory, \
                 ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(hub.get_storage_resources)
                try:
                    self.assertTrue(entered.wait(2))
                    hub.set_pinned("cache-cargo", True, "test pin")
                finally:
                    release.set()
                result = future.result(timeout=2)
            item = next(r for r in result["resources"] if r["resource_id"] == "cache-cargo")
            self.assertTrue(item["pinned"])
            self.assertEqual("test pin", item["why_retained"])
            self.assertEqual(2, inventory.call_count)

    def test_failure_releases_scan_lock_and_does_not_cache_error(self):
        with tempfile.TemporaryDirectory() as directory:
            hub = self.make_hub(directory)
            result = {"test": "inventory fixture"}
            with patch.object(hub, "_scan_storage_resources", side_effect=[OSError("scan failed"), result]) as scan:
                with self.assertRaisesRegex(OSError, "scan failed"):
                    hub.get_storage_resources()
                self.assertIs(result, hub.get_storage_resources())
                self.assertIs(result, hub.get_storage_resources())
                self.assertEqual(2, scan.call_count)

    def test_different_queue_does_not_reuse_previous_queue_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            hub = self.make_hub(directory)
            first, second = {"test": "first"}, {"test": "second"}
            queue_a, queue_b = object(), object()
            with patch.object(hub, "_scan_storage_resources", side_effect=[first, second]) as scan:
                self.assertIs(first, hub.get_storage_resources(queue_a))
                self.assertIs(second, hub.get_storage_resources(queue_b))
                self.assertIs(second, hub.get_storage_resources(queue_b))
                self.assertEqual(2, scan.call_count)


if __name__ == "__main__":
    unittest.main()
