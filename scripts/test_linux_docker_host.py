"""Native host admission must reject transient roots even on ext4."""
import stat
import sys
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

import linux_docker_host as host


@unittest.skipUnless(sys.platform.startswith("linux"), "native Linux path admission")
class NativeVolumeTests(unittest.TestCase):
    def test_transient_roots_are_refused_even_on_a_supported_filesystem(self):
        for name in ("/tmp", "/tmp/project", "/var/tmp/project", "/run/fullmag", "/dev/shm/fullmag"):
            with self.subTest(path=name), \
                    mock.patch.object(host.storage, "absolute", return_value=Path(name)), \
                    mock.patch.object(Path, "stat", return_value=SimpleNamespace(st_mode=stat.S_IFDIR, st_dev=7)), \
                    mock.patch.object(host.storage, "filesystem_type", return_value="ext4"):
                with self.assertRaisesRegex(ValueError, "temporary"):
                    host.local_volume(name)

    def test_persistent_directory_and_similar_prefix_remain_admissible(self):
        for name in ("/home/operator/fullmag", "/tmp-data/fullmag"):
            with self.subTest(path=name), \
                    mock.patch.object(host.storage, "absolute", return_value=Path(name)), \
                    mock.patch.object(Path, "stat", return_value=SimpleNamespace(st_mode=stat.S_IFDIR, st_dev=7)), \
                    mock.patch.object(host.storage, "filesystem_type", return_value="ext4"):
                self.assertEqual(host.local_volume(name), {"filesystem": "ext4", "device": 7})


if __name__ == "__main__":
    unittest.main()
