"""A fenced API may survive exactly two verified package publications."""
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import test_docker_dev_recovery_build as source


class PublicationLineageTests(unittest.TestCase):
    def test_same_live_api_survives_second_pending_and_finalized_publication(self):
        backend = source.package_tests.backend
        for finalized in (False, True):
            with self.subTest(finalized=finalized), source.DiagnosticBuildOnlyTests().observations() as f, tempfile.TemporaryDirectory() as directory:
                package, build, control, candidate, previous, raw = source.package_tests.BackendPackageTests()._ready_rotation_fixture(
                    Path(directory), '.backend-package-candidate-first')
                original = json.loads(previous[1])
                original['source'] = {'resolved_commit': 'd'*40, 'source_snapshot_sha256': 'e'*64}
                backend._write_json(package/'backend-build-receipt.json', original, 'original API identity')
                previous = backend._validated_package(package, 'original package', exclude_development_control=True)
                first = backend._rotate_package(package, candidate, control, previous[2], previous[1], raw)
                backend._finalize_published_candidate(candidate, first)
                backend._clear_rotation_journal(first)
                second_candidate = control/backend.PACKAGE_CANDIDATES_DIRNAME/'.backend-package-candidate-second'
                shutil.copytree(package, second_candidate, ignore=shutil.ignore_patterns('.development'))
                successor = json.loads((second_candidate/'backend-build-receipt.json').read_bytes())
                successor['source'] = {'resolved_commit': 'f'*40, 'source_snapshot_sha256': 'f'*64}
                backend._write_json(second_candidate/'backend-build-receipt.json', successor, 'second identity')
                backend._write_candidate_marker(second_candidate, package, build, state='ready')
                intermediate = backend._validated_package(package, 'intermediate', exclude_development_control=True)
                second = backend._rotate_package(package, second_candidate, control, intermediate[2], intermediate[1],
                                                 (second_candidate/'backend-build-receipt.json').read_bytes())
                if finalized:
                    backend._finalize_published_candidate(second_candidate, second)
                    backend._clear_rotation_journal(second)
                f.namespace['backend'] = backend
                f.namespace['claimed_build_evidence'] = lambda *_: {}
                f.api.joinpath('exe').unlink()
                f.api.joinpath('exe').symlink_to(Path(first['backup'])/'bin/fullmag-api')
                with patch.object(backend, 'PACKAGE_ROOT', package):
                    self.assertEqual(len(f.check({})), 2)
                    metadata_path = Path(second['backup'])/'rotation.json'
                    altered = json.loads(metadata_path.read_bytes())
                    altered['old_receipt_sha256'] = '0'*64
                    metadata_path.write_text(json.dumps(altered))
                    with self.assertRaises((ValueError, backend.BackendBuildError)):
                        f.check({})


if __name__ == '__main__':
    unittest.main()
