"""Interpreted checks for the Docker DEV fast-loop behavior; no Cargo/Docker build."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parents[1] / "docker" / "all-in-one"))
import backend_dev as backend
import backend_source as source
from test_docker_live_source import _capsule, _live_document


def _write_manifest(build_root: Path, capsule: dict[str, object]) -> Path:
    directory = build_root / source.LIVE_MANIFEST_DIRNAME
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / source.LIVE_MANIFEST_FILENAME
    path.write_bytes(backend._canonical(_live_document(capsule)))
    return path


class RuntimeSourceDigestTests(unittest.TestCase):
    def test_docs_and_frontend_edits_keep_the_runtime_digest(self):
        base = {"crates/a/src/lib.rs": b"fn a() {}\n", "docs/guide.md": b"old\n"}
        edited = {
            **base,
            "docs/guide.md": b"new\n",
            "apps/control-room/src/page.tsx": b"export {}\n",
        }
        self.assertEqual(
            backend._runtime_source_digest(_capsule(base)),
            backend._runtime_source_digest(_capsule(edited)),
        )
        changed = {**base, "crates/a/src/lib.rs": b"fn a() { 1; }\n"}
        self.assertNotEqual(
            backend._runtime_source_digest(_capsule(base)),
            backend._runtime_source_digest(_capsule(changed)),
        )

    def test_cache_hit_ignores_docs_only_edit_but_not_runtime_edit(self):
        toolchain = {"image_id": "sha256:" + "1" * 64}
        built = _capsule({"crates/a/src/lib.rs": b"a\n", "docs/x.md": b"old\n"})
        native = _live_document(built)["native_source_identity"]
        receipt = {
            "source": {
                "source_mode": backend.LIVE_SOURCE_MODE,
                "source_digest": built["source_digest"],
                "runtime_source_digest": backend._runtime_source_digest(built),
                "resolved_commit": built["resolved_commit"],
                "source_snapshot_sha256": native["source_snapshot_sha256"],
            },
            "native_source_identity": native,
            "native_source_identity_sha256": backend._sha256_bytes(backend._canonical(native)),
            "toolchain": toolchain,
            "build": backend._expected_backend_build_identity(backend.BACKEND_CARGO_PROFILE),
        }
        with tempfile.TemporaryDirectory() as directory:
            build_root = Path(directory)
            docs_only = _write_manifest(
                build_root, _capsule({"crates/a/src/lib.rs": b"a\n", "docs/x.md": b"new\n"})
            )
            self.assertTrue(backend._package_matches_fresh_live_manifest(
                receipt, docs_only, toolchain, backend.BACKEND_CARGO_PROFILE
            ))
            runtime_edit = _write_manifest(
                build_root, _capsule({"crates/a/src/lib.rs": b"b\n", "docs/x.md": b"old\n"})
            )
            self.assertFalse(backend._package_matches_fresh_live_manifest(
                receipt, runtime_edit, toolchain, backend.BACKEND_CARGO_PROFILE
            ))
            # A package built before the runtime digest existed keeps the
            # exact whole-checkout comparison.
            legacy = {**receipt, "source": dict(receipt["source"])}
            del legacy["source"]["runtime_source_digest"]
            self.assertFalse(backend._package_matches_fresh_live_manifest(
                legacy, docs_only, toolchain, backend.BACKEND_CARGO_PROFILE
            ))


class LiveCaptureRetryTests(unittest.TestCase):
    def _pass_result(self):
        capsule = _capsule({"crates/a/src/lib.rs": b"a\n"})
        native = _live_document(capsule)["native_source_identity"]
        return capsule, native, {}

    @unittest.skipIf(os.name == "nt", "manifest publication fsyncs a Linux directory")
    def test_capture_retries_a_concurrent_edit_once_per_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            build_root = Path(directory).resolve()
            with mock.patch.object(
                source,
                "_capture_live_source_pass",
                side_effect=[source.LiveSourceChanged("edited"), self._pass_result()],
            ) as capture, mock.patch.object(source.time, "sleep"):
                manifest = source.capture_live_source_manifest(
                    build_root / "src", build_root / "git", build_root
                )
            self.assertEqual(capture.call_count, 2)
            self.assertTrue(manifest.is_file())

    def test_capture_gives_up_after_bounded_attempts(self):
        with tempfile.TemporaryDirectory() as directory:
            build_root = Path(directory).resolve()
            with mock.patch.object(
                source,
                "_capture_live_source_pass",
                side_effect=source.LiveSourceChanged("edited"),
            ) as capture, mock.patch.object(source.time, "sleep"):
                with self.assertRaises(source.LiveSourceChanged):
                    source.capture_live_source_manifest(
                        build_root / "src", build_root / "git", build_root
                    )
            self.assertEqual(capture.call_count, source.LIVE_CAPTURE_ATTEMPTS)

    def test_sync_change_recaptures_instead_of_failing(self):
        with tempfile.TemporaryDirectory() as directory:
            build_root = Path(directory).resolve()
            manifest = _write_manifest(build_root, _capsule({"crates/a/src/lib.rs": b"a\n"}))
            workspace = build_root / "workspace"
            with mock.patch.object(backend, "_prepare_workspace", return_value=workspace), \
                    mock.patch.object(
                        backend,
                        "_sync_live_source_tree",
                        side_effect=[backend.LiveSourceSyncChanged("edited"), None],
                    ) as sync, \
                    mock.patch.object(
                        backend, "capture_live_source_manifest", return_value=manifest
                    ) as recapture:
                result = backend._materialize_live_source(
                    manifest, build_root / "src", build_root / "git", build_root
                )
            self.assertEqual(sync.call_count, 2)
            recapture.assert_called_once()
            self.assertEqual(result[0], workspace)


class LiveHashCacheTests(unittest.TestCase):
    def test_unchanged_metadata_reuses_the_digest_without_reading(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / "src").mkdir()
            path = root / "src/lib.rs"
            path.write_bytes(b"fn a() {}\n")
            first = source._LiveHashCache()
            expected = first.hash(root, "src/lib.rs")
            self.assertEqual(first.hits, 0)

            second = source._LiveHashCache(first.observed)
            with mock.patch.object(source, "_live_hash_regular") as reader:
                self.assertEqual(second.hash(root, "src/lib.rs"), expected)
            reader.assert_not_called()
            self.assertEqual(second.hits, 1)

            path.write_bytes(b"fn b() {}\n")
            stat = path.stat()
            os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
            third = source._LiveHashCache(first.observed)
            changed = third.hash(root, "src/lib.rs")
            self.assertNotEqual(changed[2], expected[2])
            self.assertEqual(third.hits, 0)

    def test_cache_round_trip_ignores_foreign_or_malformed_documents(self):
        with tempfile.TemporaryDirectory() as directory:
            build_root = Path(directory).resolve()
            (build_root / source.LIVE_MANIFEST_DIRNAME).mkdir()
            sources = build_root / "src"
            cache = source._LiveHashCache()
            cache.observed = {"a.rs": [3, 7, "100644", "f" * 64], "gone.rs": [1, 1, "100644", "e" * 64]}
            source._save_live_hash_cache(build_root, sources, cache, {"a.rs"})
            self.assertEqual(
                source._load_live_hash_cache(build_root, sources).known,
                {"a.rs": [3, 7, "100644", "f" * 64]},
            )
            self.assertEqual(source._load_live_hash_cache(build_root, build_root / "other").known, {})
            source._live_hash_cache_path(build_root).write_bytes(b"{not json")
            self.assertEqual(source._load_live_hash_cache(build_root, sources).known, {})


class AutoUntrackedTests(unittest.TestCase):
    def test_new_runtime_files_are_selected_and_others_left_out(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            files = {
                "crates/a/src/new_module.rs": b"pub fn x() {}\n",
                "docs/notes.md": b"notes\n",
                ".env": b"SECRET=1\n",
                ".agents/scratch.py": b"x = 1\n",
                "native/huge.bin": b"",
            }
            for relative, content in files.items():
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
            with (root / "native/huge.bin").open("r+b") as stream:
                stream.truncate(source.LIVE_AUTO_UNTRACKED_MAX_BYTES + 1)
            selected = {
                relative for relative in files if source._live_auto_untracked(root, relative)
            }
            self.assertEqual(selected, {"crates/a/src/new_module.rs"})


class DevCudaArchitectureTests(unittest.TestCase):
    def test_explicit_all_and_invalid_values(self):
        with mock.patch.dict(os.environ, {backend.DEV_CUDA_ARCHITECTURES_ENV: "80-real;89-real"}):
            self.assertEqual(backend._dev_cuda_architectures(), "80-real;89-real")
        with mock.patch.dict(os.environ, {backend.DEV_CUDA_ARCHITECTURES_ENV: "all"}):
            self.assertIsNone(backend._dev_cuda_architectures())
        with mock.patch.dict(os.environ, {backend.DEV_CUDA_ARCHITECTURES_ENV: "89;rm -rf"}):
            with self.assertRaises(backend.BackendBuildError):
                backend._dev_cuda_architectures()

    def test_auto_uses_visible_devices_and_falls_back_to_the_image_matrix(self):
        found = subprocess.CompletedProcess([], 0, stdout=b"[86, 89]\n", stderr=b"")
        missing = subprocess.CompletedProcess([], 3, stdout=b"", stderr=b"")
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(backend.DEV_CUDA_ARCHITECTURES_ENV, None)
            with mock.patch.object(backend.subprocess, "run", return_value=found):
                self.assertEqual(backend._dev_cuda_architectures(), "86-real;89-real")
            with mock.patch.object(backend.subprocess, "run", return_value=missing):
                self.assertIsNone(backend._dev_cuda_architectures())
            with mock.patch.object(
                backend.subprocess, "run", side_effect=subprocess.TimeoutExpired("probe", 30)
            ):
                self.assertIsNone(backend._dev_cuda_architectures())


@unittest.skipIf(os.name == "nt", "Linux container package-volume contract")
class InterruptedCandidateTests(unittest.TestCase):
    def _candidate(self, output: Path, build_root: Path) -> Path:
        control_root = backend._ensure_package_development_root(output)
        candidates = control_root / backend.PACKAGE_CANDIDATES_DIRNAME
        candidates.mkdir(parents=True, exist_ok=True)
        candidate = Path(tempfile.mkdtemp(prefix=".backend-package-candidate-", dir=candidates))
        backend._write_candidate_marker(candidate, output, build_root, state="building")
        partial = candidate / backend.REQUIRED_PACKAGE_PATHS[0]
        partial.parent.mkdir(parents=True, exist_ok=True)
        partial.write_bytes(b"partial")
        return candidate

    def test_interrupted_build_candidate_is_discarded_on_next_start(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            output, build_root = root / "package", root / "build"
            output.mkdir()
            build_root.mkdir()
            candidate = self._candidate(output, build_root)
            backend._reject_partial_package_candidates(
                output, output / backend.PACKAGE_DEVELOPMENT_DIRNAME, build_root
            )
            self.assertFalse(candidate.exists())

    def test_unknown_candidate_content_still_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            output, build_root = root / "package", root / "build"
            output.mkdir()
            build_root.mkdir()
            candidate = self._candidate(output, build_root)
            (candidate / "unexpected-user-file.txt").write_bytes(b"keep")
            with self.assertRaises(backend.BackendBuildError):
                backend._reject_partial_package_candidates(
                    output, output / backend.PACKAGE_DEVELOPMENT_DIRNAME, build_root
                )
            self.assertTrue(candidate.exists())


if __name__ == "__main__":
    unittest.main()
