"""Interpreted candidate recovery regressions using temporary package fixtures.

Run through the selected Compose group; no native compilation or user data.
"""

from contextlib import contextmanager
import argparse
import inspect
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch


SOURCE_ROOT = Path(__file__).resolve().parents[1]
RETIREMENT_MODULE_PATH = (
    SOURCE_ROOT / "docker" / "all-in-one" / "backend_candidate_retirement.py"
)


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {name} from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


fixture_module = _load_module(
    "fullmag_candidate_retirement_backend_fixtures",
    SOURCE_ROOT / "scripts" / "test_docker_backend_dev.py",
)
retirement = _load_module(
    "fullmag_candidate_retirement",
    RETIREMENT_MODULE_PATH,
)
backend = fixture_module.backend


class CandidateRetirementTests(unittest.TestCase):
    """Exercise the retirement boundary with real package and hash fixtures."""

    def test_toolchain_identity_preserves_optional_umpire_for_candidate_contract(self):
        image_id = "sha256:" + "e" * 64
        required_commits = {
            "mfem": "1" * 40,
            "libceed": "2" * 40,
            "hypre": "3" * 40,
            "petsc": "4" * 40,
            "slepc": "5" * 40,
        }
        dependency = {
            "schema": "fullmag.docker.fem-gpu-dependencies.v1",
            "declared": {},
            "actual": {
                "source_commits": {**required_commits, "umpire": None},
            },
            "latest": {},
        }
        raw = b'{"dependency":"complete-with-optional-umpire"}\n'

        with (
            patch.dict(os.environ, {"FULLMAG_TOOLCHAIN_IMAGE_ID": image_id}),
            patch.object(backend, "_read_json", return_value=(dependency, raw)),
        ):
            actual_image_id, toolchain = backend._toolchain_identity()

        self.assertEqual(actual_image_id, image_id)
        self.assertEqual(
            toolchain["actual_source_commits"],
            {**required_commits, "umpire": None},
        )
        self.assertEqual(
            toolchain["dependency_manifest_sha256"],
            backend._sha256_bytes(raw),
        )
        self.assertEqual(
            retirement._candidate_toolchain(backend, {"toolchain": toolchain}),
            toolchain,
        )

    def test_candidate_toolchain_rejects_missing_required_source_commit(self):
        required_commits = {
            "mfem": "1" * 40,
            "libceed": "2" * 40,
            "hypre": "3" * 40,
            "petsc": "4" * 40,
            "slepc": "5" * 40,
        }
        for missing in required_commits:
            with self.subTest(missing=missing):
                commits = {**required_commits, "umpire": None}
                commits.pop(missing)
                toolchain = {
                    "image_id": "sha256:" + "e" * 64,
                    "dependency_manifest_sha256": "f" * 64,
                    "dependency_schema": "fullmag.docker.fem-gpu-dependencies.v1",
                    "actual_source_commits": commits,
                }
                with self.assertRaises(backend.BackendBuildError):
                    retirement._candidate_toolchain(backend, {"toolchain": toolchain})

    @contextmanager
    def _fixture(self, kind: str = "stale"):
        """Create one verified current package and one ready candidate.

        ``stale`` uses a different source identity, ``fresh`` uses the same
        source/toolchain but different artifacts, and ``duplicate`` copies the
        current package payload and receipt exactly.  The latter is a useful
        regression fixture because provenance must still bind to the retained
        current package while allowing duplicate staging to be retired.
        """

        with tempfile.TemporaryDirectory(prefix="candidate-retirement-") as directory:
            root = Path(directory)
            package, records = fixture_module.BackendPackageTests()._published_package(root)
            current_manifest_path, current_manifest = fixture_module.BackendPackageTests._live_manifest(
                root, commit="a" * 40, capture_id="current-capture"
            )
            toolchain = fixture_module.BackendPackageTests._toolchain_fixture()
            current_receipt = fixture_module.BackendPackageTests._receipt_for_manifest(
                records, current_manifest, toolchain
            )
            current_receipt["source"] = dict(current_receipt["source"])
            current_receipt["source"]["manifest_sha256"] = backend._sha256_bytes(
                current_manifest_path.read_bytes()
            )
            backend._write_json(
                package / "backend-build-receipt.json",
                current_receipt,
                "candidate retirement current receipt",
            )

            build_root = root / "build"
            build_root.mkdir()
            control_root = backend._ensure_package_development_root(package)
            candidate = (
                control_root
                / backend.PACKAGE_CANDIDATES_DIRNAME
                / ".backend-package-candidate-retirement-test"
            )

            if kind == "duplicate":
                # A duplicate candidate is a byte-for-byte copy of the
                # retained package outside its development control tree.
                candidate.mkdir()
                backend._write_candidate_marker(
                    candidate, package, build_root, state="building"
                )
                for child in package.iterdir():
                    if child.name == backend.PACKAGE_DEVELOPMENT_DIRNAME:
                        continue
                    destination = candidate / child.name
                    if child.is_dir():
                        shutil.copytree(child, destination)
                    else:
                        shutil.copy2(child, destination)
                backend._discard_direct_make_launcher(candidate)
                candidate_manifest_path = current_manifest_path
                candidate_records = backend._hash_package(candidate)
                backend._write_candidate_marker(
                    candidate,
                    package,
                    build_root,
                    state="ready",
                    records=candidate_records,
                )
                candidate_receipt = current_receipt
            else:
                workspace = root / "workspace"
                workspace.mkdir()
                fixture_module.BackendPackageTests._populate_direct_candidate(
                    package, build_root, candidate
                )
                candidate_records = backend._copy_package(
                    workspace,
                    candidate,
                    direct_install=True,
                    package_root=package,
                    build_root=build_root,
                )
                candidate_commit = "a" * 40 if kind == "fresh" else "b" * 40
                candidate_manifest_path, candidate_manifest = fixture_module.BackendPackageTests._live_manifest(
                    root,
                    commit=candidate_commit,
                    capture_id=f"candidate-{kind}",
                )
                candidate_receipt = fixture_module.BackendPackageTests._receipt_for_manifest(
                    candidate_records, candidate_manifest, toolchain
                )

            candidate_receipt["source"] = dict(candidate_receipt["source"])
            candidate_receipt["source"]["manifest_sha256"] = backend._sha256_bytes(
                candidate_manifest_path.read_bytes()
            )

            backend._write_json(
                candidate / "backend-build-receipt.json",
                candidate_receipt,
                "candidate retirement candidate receipt",
            )
            live_manifest_path = (
                build_root
                / getattr(backend, "LIVE_MANIFEST_DIRNAME", ".fullmag-live-source")
                / getattr(backend, "LIVE_MANIFEST_FILENAME", "manifest.json")
            )
            live_manifest_path.parent.mkdir(parents=True)
            live_manifest_path.write_bytes(candidate_manifest_path.read_bytes())

            # The external Make witness and the candidate's published log must
            # have one exact digest.  This is the real helper path used by
            # backend_dev, not a mocked attempt record.
            attempt_log = backend._begin_failed_make_attempt(
                build_root, candidate, "install-cli-dev"
            )
            log_bytes = b"candidate retirement Make success\n"
            attempt_log.write_bytes(log_bytes)
            (candidate / backend.FAILED_MAKE_LOG_NAME).write_bytes(log_bytes)
            backend._finish_failed_make_attempt(build_root, candidate, 0)

            current = backend._validated_package(
                package,
                "candidate retirement current package",
                exclude_development_control=True,
            )
            provenance_root = root / "control" / "backend"
            provenance_path = provenance_root / "runtime-provenance.json"
            cache_sentinel = build_root / "cache-sentinel"
            cache_sentinel.write_bytes(b"retain this cache\n")

            provenance_root.mkdir(parents=True)
            with (
                patch.object(backend, "BACKEND_CONTROL_ROOT", provenance_root),
                patch.object(backend, "PROVENANCE_PATH", provenance_path),
                patch.dict(
                    os.environ,
                    {"FULLMAG_RUNTIME_IMAGE_ID": "sha256:" + "e" * 64},
                ),
            ):
                # Use the same complete provenance shape as the production
                # publisher.  Retirement must bind to the current package's
                # source, toolchain, artifact inventory, and package root.
                backend._publish_runtime_provenance(package)
                yield {
                    "root": root,
                    "package": package,
                    "build_root": build_root,
                    "control_root": control_root,
                    "candidate": candidate,
                    "current": current,
                    "current_manifest": current_manifest_path,
                    "candidate_manifest": candidate_manifest_path,
                    "toolchain": toolchain,
                    "provenance_path": provenance_path,
                    "cache_sentinel": cache_sentinel,
                }

    @contextmanager
    def _shared_candidate(self, fixture, *, third_consumer=False):
        """Publish a ready candidate through the real sealed shared store."""

        import backend_shared_store as shared

        store_root = fixture["root"] / "shared-store"
        store_root.mkdir()
        receipt_path = fixture["candidate"] / "backend-build-receipt.json"
        receipt, _ = backend._read_json(receipt_path, "shared candidate receipt")
        identity = backend._shared_package_identity(
            fixture["candidate_manifest"], fixture["toolchain"], None
        )
        receipt["source"]["runtime_source_digest"] = identity["runtime_source_digest"]
        receipt["build"].update(identity["build"])
        receipt["shared_package"] = {
            "schema": shared.SCHEMA,
            "key": shared.key_for(identity),
            "inputs": identity,
            "reuse": "publisher",
        }
        backend._write_json(receipt_path, receipt, "shared candidate receipt")

        with (
            patch.object(shared, "ROOT", store_root),
            patch.dict(os.environ, {"FULLMAG_SHARED_BACKEND_STORE": str(store_root)}),
        ):
            store = shared.Store(store_root)
            with store.claim(identity) as entry:
                entry.publish(fixture["candidate"], receipt)
                cached = entry.read()
                consumer = None
                if third_consumer:
                    consumer = (
                        store_root
                        / "groups"
                        / ("c" * 64)
                        / ".development"
                        / "candidates"
                        / "retained-consumer"
                    )
                    consumer.mkdir(parents=True)
                    entry.restore(consumer, cached)
            yield store, identity, consumer, shared

    @staticmethod
    def _rewrite_as_shared_consumer(fixture, store, identity, shared, *, producer_sha256=None):
        with store.claim(identity) as entry:
            cached = entry.read()
            producer = cached["receipt"]
        receipt_path = fixture["candidate"] / "backend-build-receipt.json"
        receipt, _ = backend._read_json(receipt_path, "shared consumer candidate receipt")
        receipt["operation"] = "direct-compose-cache-reuse"
        receipt["shared_package"] = {
            "schema": shared.SCHEMA,
            "key": shared.key_for(identity),
            "producer_receipt_sha256": producer_sha256
            or backend._sha256_bytes(shared.canonical(producer)),
            "inputs": identity,
            "reuse": "verified-hardlinks",
        }
        backend._write_json(receipt_path, receipt, "shared consumer candidate receipt")

    @staticmethod
    def _qualify(fixture):
        return retirement.qualify_ready_candidate(
            backend,
            fixture["candidate"],
            fixture["package"],
            fixture["control_root"],
            fixture["build_root"],
        )

    @staticmethod
    def _current_snapshot(fixture):
        current = backend._validated_package(
            fixture["package"],
            "candidate retirement current snapshot",
            exclude_development_control=True,
        )
        return current[1], dict(current[2])

    @staticmethod
    def _provenance_hash(fixture, spec):
        return backend._sha256_bytes(fixture["provenance_path"].read_bytes())

    @staticmethod
    def _action_prepared_archive(fixture, spec, classification="stale"):
        """Promote a sealed prepared record to deletion-pending state."""

        archive = retirement._archive_target(backend, spec)
        manifest, _ = retirement._read_archive_manifest(backend, archive)
        manifest.update(
            {
                "state": "deletion-pending",
                "classification": classification,
                "deletion_intent": [
                    str(record["path"]) for record in spec.candidate_files
                ],
                "current_receipt_sha256": backend._sha256_bytes(
                    fixture["current"][1]
                ),
                "current_provenance_sha256": CandidateRetirementTests._provenance_hash(
                    fixture, spec
                ),
                "action_at_ns": 1,
                "completed_at_ns": None,
                "payload_deleted": False,
                "marker_deleted": False,
            }
        )
        backend._write_json(
            archive / retirement.RETIREMENT_RECORD_NAME,
            manifest,
            "candidate retirement deletion intent fixture",
        )
        backend._fsync_directory(archive, "candidate retirement archive fixture")
        return archive, manifest

    @staticmethod
    def _live_manifest_path(fixture):
        return (
            fixture["build_root"]
            / getattr(backend, "LIVE_MANIFEST_DIRNAME", ".fullmag-live-source")
            / getattr(backend, "LIVE_MANIFEST_FILENAME", "manifest.json")
        )

    def _require_start_integration(self):
        if not hasattr(backend, "_qualify_ready_candidate_retirements"):
            self.skipTest("candidate-retirement start integration is not in this source snapshot")

    def test_malformed_live_manifest_does_not_use_prepared_fallback(self):
        with self._fixture("stale") as fixture:
            spec = self._qualify(fixture)
            self._live_manifest_path(fixture).write_bytes(b"{ malformed live manifest\n")

            with self.assertRaises(backend.BackendBuildError):
                self._qualify(fixture)
            self.assertTrue(fixture["candidate"].is_dir())
            prepared = retirement._archive_target(backend, spec)
            record, _ = retirement._read_archive_manifest(backend, prepared)
            self.assertEqual(record["state"], "prepared")

    def test_current_provenance_package_binding_is_required(self):
        with self._fixture("stale") as fixture:
            spec = self._qualify(fixture)
            provenance, _ = backend._read_json(
                fixture["provenance_path"], "current runtime provenance"
            )
            tampered_fields = {
                "package_root": str(fixture["root"] / "foreign-package"),
                "backend_build_receipt": str(fixture["root"] / "foreign-receipt.json"),
                "backend_build_receipt_schema": "foreign.receipt.v1",
                "build_receipt_sha256": "0" * 64,
                "artifacts": [],
                "binary_hashes": {},
            }
            for field, value in tampered_fields.items():
                with self.subTest(field=field):
                    changed = dict(provenance)
                    changed[field] = value
                    backend._write_json(
                        fixture["provenance_path"],
                        changed,
                        f"tampered current runtime provenance {field}",
                    )
                    with self.assertRaises(backend.BackendBuildError):
                        retirement.retire_candidate(
                            backend,
                            spec,
                            fixture["current_manifest"],
                            fixture["toolchain"],
                            backend.BACKEND_CARGO_PROFILE,
                            fixture["current"],
                        )
            self.assertTrue(fixture["candidate"].is_dir())
            prepared = retirement._archive_target(backend, spec)
            record, _ = retirement._read_archive_manifest(backend, prepared)
            self.assertEqual(record["state"], "prepared")

    def test_promoted_candidate_does_not_leave_prepared_history(self):
        with self._fixture("fresh") as fixture:
            spec = self._qualify(fixture)
            result = retirement.retire_candidate(
                backend,
                spec,
                fixture["candidate_manifest"],
                fixture["toolchain"],
                backend.BACKEND_CARGO_PROFILE,
                fixture["current"],
            )
            self.assertEqual(result.action, "promote")

            rotation = backend._rotate_package(
                fixture["package"],
                fixture["candidate"],
                fixture["control_root"],
                fixture["current"][2],
                fixture["current"][1],
                spec.receipt_bytes,
            )
            # Production publishes the new runtime provenance while the
            # common rotation journal is still durable, before finalizing the
            # candidate marker.  The historical hook must observe that exact
            # new current package only after both finalization and journal
            # clearing.
            backend._publish_runtime_provenance(fixture["package"])
            backend._finalize_published_candidate(fixture["candidate"], rotation)
            backend._clear_rotation_journal(rotation)
            promoted_current = backend._validated_package(
                fixture["package"],
                "promoted candidate current package",
                exclude_development_control=True,
            )
            historical = retirement.mark_promoted_archive_historical(
                backend,
                spec,
                promoted_current,
            )
            self.assertEqual(historical.action, "historical")

            archive_root = Path(backend.BACKEND_CONTROL_ROOT) / retirement.RETIREMENT_NAMESPACE_NAME
            if archive_root.exists():
                for archive in archive_root.iterdir():
                    record, _ = retirement._read_archive_manifest(backend, archive)
                    self.assertNotEqual(
                        record["state"],
                        "prepared",
                        "successful promotion must close or remove prepared evidence",
                    )

    def test_first_publication_without_current_promotes_fresh_and_rejects_stale(self):
        with self._fixture("fresh") as fixture:
            if hasattr(backend, "_qualify_ready_candidate_retirements"):
                ready = backend._qualify_ready_candidate_retirements(
                    fixture["package"],
                    fixture["control_root"],
                    fixture["build_root"],
                    None,
                )
                self.assertEqual(len(ready), 1)
                promotion = backend._classify_ready_candidate_retirements(
                    ready,
                    fixture["candidate_manifest"],
                    fixture["toolchain"],
                    backend.BACKEND_CARGO_PROFILE,
                    None,
                )
                self.assertEqual(promotion.candidate, fixture["candidate"])
            spec = self._qualify(fixture)
            result = retirement.retire_candidate(
                backend,
                spec,
                fixture["candidate_manifest"],
                fixture["toolchain"],
                backend.BACKEND_CARGO_PROFILE,
                None,
            )
            self.assertEqual(result.action, "promote")
            self.assertTrue(fixture["candidate"].is_dir())
            prepared = retirement._archive_target(backend, spec)
            record, _ = retirement._read_archive_manifest(backend, prepared)
            self.assertEqual(record["state"], "prepared")

        with self._fixture("stale") as fixture:
            spec = self._qualify(fixture)
            with self.assertRaises(backend.BackendBuildError):
                retirement.retire_candidate(
                    backend,
                    spec,
                    fixture["current_manifest"],
                    fixture["toolchain"],
                    backend.BACKEND_CARGO_PROFILE,
                    None,
                )
            self.assertTrue(fixture["candidate"].is_dir())
            prepared = retirement._archive_target(backend, spec)
            record, _ = retirement._read_archive_manifest(backend, prepared)
            self.assertEqual(record["state"], "prepared")

    def test_start_integration_preserves_malformed_guard_before_capture(self):
        self._require_start_integration()
        with self._fixture("stale") as fixture:
            with (
                patch.object(
                    backend,
                    "_reject_partial_package_candidates",
                    side_effect=backend.BackendBuildError(
                        "backend package candidate from an incomplete prior build is preserved: test"
                    ),
                ),
                patch.object(
                    backend,
                    "_candidate_retirement_entries",
                    side_effect=AssertionError("malformed guard was bypassed"),
                ),
            ):
                with self.assertRaises(backend.BackendBuildError):
                    backend._qualify_ready_candidate_retirements(
                        fixture["package"],
                        fixture["control_root"],
                        fixture["build_root"],
                        fixture["current"],
                    )
            self.assertTrue(fixture["candidate"].is_dir())

    def test_start_integration_orders_cache_recovery_guard_and_capture(self):
        self._require_start_integration()
        source = inspect.getsource(backend._start)
        self.assertLess(
            source.index("_backend_cache_receipt()"),
            source.index("candidate_retirement.recover_pending_retirements("),
        )
        self.assertLess(
            source.index("candidate_retirement.recover_pending_retirements("),
            source.index("_qualify_ready_candidate_retirements("),
        )
        self.assertLess(
            source.index("_qualify_ready_candidate_retirements("),
            source.index("_capture_start_manifest("),
        )

    def test_promotion_history_hook_is_postcommit_and_deferred_on_error(self):
        self._require_start_integration()
        source = inspect.getsource(backend._start)
        committed = source.index("publication_committed = True")
        historical = source.index(
            "candidate_retirement.mark_promoted_archive_historical("
        )
        deferred = source.index("if publication_committed:")
        rollback = source.index("rollback_errors: list[str] = []")
        self.assertLess(committed, historical)
        self.assertLess(historical, deferred)
        self.assertLess(deferred, rollback)

    def test_start_integration_candidate_scan_is_bounded_before_allocation(self):
        self._require_start_integration()
        source = inspect.getsource(backend._candidate_retirement_entries)
        self.assertIn("MAX_PACKAGE_CANDIDATES + 1", source)
        self.assertIn("StopIteration", source)
        self.assertNotIn("tuple(sorted(candidates.iterdir()", source)

    def test_stale_candidate_is_archived_before_exact_payload_removal(self):
        with self._fixture("stale") as fixture:
            spec = self._qualify(fixture)
            current_before = self._current_snapshot(fixture)
            provenance_before = fixture["provenance_path"].read_bytes()
            cache_before = fixture["cache_sentinel"].read_bytes()

            result = retirement.retire_candidate(
                backend,
                spec,
                fixture["current_manifest"],
                fixture["toolchain"],
                backend.BACKEND_CARGO_PROFILE,
                fixture["current"],
            )

            self.assertEqual(result.action, "retired")
            self.assertEqual(result.classification, "stale")
            self.assertIsNotNone(result.archive)
            self.assertFalse(fixture["candidate"].exists())
            self.assertTrue(
                result.archive.is_relative_to(
                    Path(backend.BACKEND_CONTROL_ROOT)
                    / retirement.RETIREMENT_NAMESPACE_NAME
                )
            )
            record, _ = retirement._read_archive_manifest(backend, result.archive)
            self.assertEqual(record["schema"], retirement.RETIREMENT_SCHEMA)
            self.assertEqual(record["state"], "succeeded")
            self.assertEqual(record["classification"], "stale")
            retirement._validate_archive_contents(
                backend, result.archive, record, require_pending=False
            )
            self.assertEqual(
                self._current_snapshot(fixture), current_before
            )
            self.assertEqual(fixture["provenance_path"].read_bytes(), provenance_before)
            self.assertEqual(fixture["cache_sentinel"].read_bytes(), cache_before)
            attempt = backend._read_failed_make_attempt(
                fixture["build_root"], fixture["candidate"]
            )
            self.assertIsNotNone(attempt)
            self.assertTrue(attempt[0]["log_retired"])

    def test_matching_fresh_candidate_is_returned_for_rotation_and_preserved(self):
        with self._fixture("fresh") as fixture:
            spec = self._qualify(fixture)
            candidate_files_before = {
                path.relative_to(fixture["candidate"]): path.read_bytes()
                for path in fixture["candidate"].rglob("*")
                if path.is_file()
            }
            result = retirement.retire_candidate(
                backend,
                spec,
                fixture["candidate_manifest"],
                fixture["toolchain"],
                backend.BACKEND_CARGO_PROFILE,
                fixture["current"],
            )
            self.assertEqual(result.action, "promote")
            self.assertIsNone(result.classification)
            self.assertIsNone(result.archive)
            self.assertTrue(fixture["candidate"].is_dir())
            candidate_files_after = {
                path.relative_to(fixture["candidate"]): path.read_bytes()
                for path in fixture["candidate"].rglob("*")
                if path.is_file()
            }
            self.assertEqual(candidate_files_after, candidate_files_before)
            prepared = retirement._archive_target(backend, spec)
            prepared_manifest, _ = retirement._read_archive_manifest(backend, prepared)
            self.assertEqual(prepared_manifest["state"], "prepared")

    def test_exact_duplicate_candidate_is_retired_without_touching_current(self):
        with self._fixture("duplicate") as fixture:
            spec = self._qualify(fixture)
            current_before = self._current_snapshot(fixture)
            result = retirement.retire_candidate(
                backend,
                spec,
                fixture["current_manifest"],
                fixture["toolchain"],
                backend.BACKEND_CARGO_PROFILE,
                fixture["current"],
            )
            self.assertEqual(result.action, "retired")
            self.assertEqual(result.classification, "duplicate")
            self.assertFalse(fixture["candidate"].exists())
            self.assertEqual(self._current_snapshot(fixture), current_before)

    def test_invalid_make_journal_marker_inventory_unknown_child_and_drift_preserve_candidate(self):
        cases = ("make", "journal", "marker", "inventory", "unknown-child", "drift")
        for case in cases:
            with self.subTest(case=case), self._fixture("stale") as fixture:
                if case == "make":
                    attempt_path = (
                        fixture["build_root"]
                        / backend.FAILED_MAKE_DIAGNOSTICS_DIRNAME
                        / fixture["candidate"].name
                        / backend.FAILED_MAKE_RECEIPT_NAME
                    )
                    attempt, _ = backend._read_json(
                        attempt_path, "candidate retirement Make attempt"
                    )
                    attempt["exit_code"] = 1
                    backend._write_json(
                        attempt_path, attempt, "tampered candidate Make attempt"
                    )
                elif case == "journal":
                    (fixture["control_root"] / backend.PACKAGE_ROTATION_JOURNAL_NAME).write_bytes(
                        b"{}\n"
                    )
                elif case == "marker":
                    marker_path = fixture["candidate"] / backend.PACKAGE_CANDIDATE_MARKER
                    marker, _ = backend._read_json(marker_path, "candidate marker")
                    marker["state"] = "building"
                    marker.pop("artifact_inventory_sha256", None)
                    backend._write_json(marker_path, marker, "tampered candidate marker")
                elif case == "inventory":
                    marker_path = fixture["candidate"] / backend.PACKAGE_CANDIDATE_MARKER
                    marker, _ = backend._read_json(marker_path, "candidate marker")
                    marker["artifact_inventory_sha256"] = "0" * 64
                    backend._write_json(marker_path, marker, "tampered candidate inventory")
                elif case == "unknown-child":
                    (fixture["candidate"] / "unknown-child").write_bytes(b"foreign\n")

                if case == "drift":
                    spec = self._qualify(fixture)
                    (fixture["candidate"] / "bin" / "fullmag-bin").write_bytes(
                        b"drifted payload\n"
                    )
                    invoke = lambda: retirement.retire_candidate(
                        backend,
                        spec,
                        fixture["current_manifest"],
                        fixture["toolchain"],
                        backend.BACKEND_CARGO_PROFILE,
                        fixture["current"],
                    )
                else:
                    invoke = lambda: retirement.retire_candidate(
                        backend,
                        self._qualify(fixture),
                        fixture["current_manifest"],
                        fixture["toolchain"],
                        backend.BACKEND_CARGO_PROFILE,
                        fixture["current"],
                    )
                with self.assertRaises(backend.BackendBuildError):
                    invoke()
                self.assertTrue(fixture["candidate"].is_dir())
                archive_root = (
                    Path(backend.BACKEND_CONTROL_ROOT)
                    / retirement.RETIREMENT_NAMESPACE_NAME
                )
                if case in {"journal", "drift"}:
                    self.assertTrue(archive_root.is_dir())
                    prepared = list(archive_root.iterdir())
                    self.assertEqual(len(prepared), 1)
                    record, _ = retirement._read_archive_manifest(backend, prepared[0])
                    self.assertEqual(record["state"], "prepared")
                else:
                    self.assertFalse(
                        archive_root.exists()
                        and any(archive_root.iterdir())
                    )

    def test_archive_write_and_fsync_failures_keep_candidate_payload(self):
        for failure in ("write", "fsync"):
            with self.subTest(failure=failure), self._fixture("stale") as fixture:
                if failure == "write":
                    fault = patch.object(
                        backend,
                        "_copy_regular_file_fsync",
                        side_effect=backend.BackendBuildError("archive write fault"),
                    )
                else:
                    original = backend._fsync_owned_tree

                    def fail_archive_sync(path, name):
                        if str(name).startswith("candidate retirement archive staging"):
                            raise backend.BackendBuildError("archive fsync fault")
                        return original(path, name)

                    fault = patch.object(
                        backend, "_fsync_owned_tree", side_effect=fail_archive_sync
                    )
                with fault, self.assertRaises(backend.BackendBuildError):
                    self._qualify(fixture)
                self.assertTrue(fixture["candidate"].is_dir())
                archive_root = (
                    Path(backend.BACKEND_CONTROL_ROOT)
                    / retirement.RETIREMENT_NAMESPACE_NAME
                )
                self.assertFalse(
                    archive_root.exists()
                    and any(archive_root.iterdir())
                )

    def test_partial_deletion_retry_removes_only_known_remaining_files(self):
        with self._fixture("stale") as fixture:
            spec = self._qualify(fixture)
            current_before = self._current_snapshot(fixture)
            archive, manifest = self._action_prepared_archive(fixture, spec)
            self.assertEqual(manifest["state"], "deletion-pending")
            # Simulate a crash after one known payload unlink.  Recovery must
            # resume from the sealed inventory and never broaden deletion.
            (fixture["candidate"] / "bin" / "fullmag-bin").unlink()
            result = retirement.recover_pending_retirements(
                backend,
                fixture["package"],
                fixture["control_root"],
                fixture["build_root"],
                fixture["current"],
            )
            self.assertEqual(len(result), 1)
            self.assertEqual(result[0].action, "retired")
            self.assertFalse(fixture["candidate"].exists())
            completed, _ = retirement._read_archive_manifest(backend, archive)
            self.assertEqual(completed["state"], "succeeded")
            self.assertEqual(self._current_snapshot(fixture), current_before)

    def test_pending_archive_alone_never_authorizes_deletion(self):
        with self._fixture("stale") as fixture:
            spec = self._qualify(fixture)
            archive = retirement._archive_target(backend, spec)
            prepared = retirement.recover_pending_retirements(
                backend,
                fixture["package"],
                fixture["control_root"],
                fixture["build_root"],
                None,
            )
            self.assertEqual(prepared[0].action, "prepared")
            self.assertTrue(fixture["candidate"].is_dir())

            self._action_prepared_archive(fixture, spec)
            with self.assertRaises(backend.BackendBuildError):
                retirement.recover_pending_retirements(
                    backend,
                    fixture["package"],
                    fixture["control_root"],
                    fixture["build_root"],
                    None,
                )
            self.assertTrue(fixture["candidate"].is_dir())

            backend._write_json(
                fixture["provenance_path"],
                {
                    "schema": "fullmag.docker-all-image.v1",
                    "state": "succeeded",
                    "build_receipt_sha256": "0" * 64,
                },
                "corrupt current runtime provenance",
            )
            with self.assertRaises(backend.BackendBuildError):
                retirement.recover_pending_retirements(
                    backend,
                    fixture["package"],
                    fixture["control_root"],
                    fixture["build_root"],
                    fixture["current"],
                )
            self.assertTrue(fixture["candidate"].is_dir())
            self.assertTrue(archive.is_dir())

    def test_missing_or_corrupt_fresh_manifest_digest_preserves_candidate(self):
        for corruption in ("missing", "corrupt"):
            with self.subTest(corruption=corruption), self._fixture("stale") as fixture:
                spec = self._qualify(fixture)
                document, _ = backend._read_json(
                    fixture["current_manifest"],
                    "fresh live source manifest",
                )
                if corruption == "missing":
                    document.pop("source_manifest_sha256")
                else:
                    document["source_manifest_sha256"] = "0" * 64
                backend._write_json(
                    fixture["current_manifest"],
                    document,
                    "corrupt fresh live source manifest",
                )
                with self.assertRaises(backend.BackendBuildError):
                    retirement.retire_candidate(
                        backend,
                        spec,
                        fixture["current_manifest"],
                        fixture["toolchain"],
                        backend.BACKEND_CARGO_PROFILE,
                        fixture["current"],
                    )
                self.assertTrue(fixture["candidate"].is_dir())

    def test_prepared_archive_recovers_original_manifest_after_capture_overwrite(self):
        with self._fixture("stale") as fixture:
            first = self._qualify(fixture)
            original_bytes = first.source_manifest_bytes
            overwritten_path, _ = fixture_module.BackendPackageTests._live_manifest(
                fixture["root"], commit="c" * 40, capture_id="new-capture"
            )
            live_manifest_path = (
                fixture["build_root"]
                / getattr(backend, "LIVE_MANIFEST_DIRNAME", ".fullmag-live-source")
                / getattr(backend, "LIVE_MANIFEST_FILENAME", "manifest.json")
            )
            live_manifest_path.write_bytes(overwritten_path.read_bytes())
            recovered = self._qualify(fixture)
            self.assertEqual(recovered.source_manifest_bytes, original_bytes)
            self.assertEqual(recovered.source_manifest_sha256, first.source_manifest_sha256)
            prepared = retirement._archive_target(backend, recovered)
            prepared_manifest, _ = retirement._read_archive_manifest(backend, prepared)
            self.assertEqual(prepared_manifest["state"], "prepared")
            self.assertTrue(fixture["candidate"].is_dir())

    def test_corrupt_archive_and_pending_current_drift_block_without_deletion(self):
        for corruption in ("archive", "current"):
            with self.subTest(corruption=corruption), self._fixture("stale") as fixture:
                spec = self._qualify(fixture)
                archive, _manifest = self._action_prepared_archive(fixture, spec)
                if corruption == "archive":
                    record, _ = retirement._read_archive_manifest(backend, archive)
                    record["candidate_receipt_sha256"] = "0" * 64
                    backend._write_json(
                        archive / retirement.RETIREMENT_RECORD_NAME,
                        record,
                        "corrupt candidate retirement record",
                    )
                else:
                    current_record, _ = backend._read_json(
                        fixture["package"] / "backend-build-receipt.json",
                        "current package receipt",
                    )
                    current_record["operator_drift"] = "changed after archive"
                    backend._write_json(
                        fixture["package"] / "backend-build-receipt.json",
                        current_record,
                        "drifted current package receipt",
                    )
                with self.assertRaises(backend.BackendBuildError):
                    retirement.recover_pending_retirements(
                        backend,
                        fixture["package"],
                        fixture["control_root"],
                        fixture["build_root"],
                        fixture["current"],
                    )
                self.assertTrue(fixture["candidate"].is_dir())

    def test_completed_archive_is_historical_after_current_changes(self):
        with self._fixture("stale") as fixture:
            spec = self._qualify(fixture)
            result = retirement.retire_candidate(
                backend,
                spec,
                fixture["current_manifest"],
                fixture["toolchain"],
                backend.BACKEND_CARGO_PROFILE,
                fixture["current"],
            )
            self.assertEqual(result.action, "retired")
            current_record, _ = backend._read_json(
                fixture["package"] / "backend-build-receipt.json",
                "current package receipt",
            )
            current_record["operator_drift"] = "changed after completion"
            backend._write_json(
                fixture["package"] / "backend-build-receipt.json",
                current_record,
                "changed current package after completion",
            )
            historical = retirement.recover_pending_retirements(
                backend,
                fixture["package"],
                fixture["control_root"],
                fixture["build_root"],
                None,
            )
            self.assertEqual(len(historical), 1)
            self.assertEqual(historical[0].action, "historical")
            self.assertFalse(fixture["candidate"].exists())

    def test_archive_count_bound_is_checked_before_temporary_allocation(self):
        with self._fixture("stale") as fixture:
            with (
                patch.object(retirement, "RETIREMENT_MAX_ARCHIVES", 0),
                patch.object(
                    retirement.tempfile,
                    "mkdtemp",
                    side_effect=AssertionError("temporary archive allocated before bound"),
                ) as mkdtemp,
                self.assertRaises(backend.BackendBuildError),
            ):
                self._qualify(fixture)
            mkdtemp.assert_not_called()
            self.assertTrue(fixture["candidate"].is_dir())


    def test_retire_candidate_fresh_current_none_is_promotion_api(self):
        with self._fixture("fresh") as fixture:
            spec = self._qualify(fixture)
            result = retirement.retire_candidate(
                backend,
                spec,
                fixture["candidate_manifest"],
                fixture["toolchain"],
                backend.BACKEND_CARGO_PROFILE,
                None,
            )
            self.assertEqual(result.action, "promote")
            self.assertIsNone(result.classification)
            self.assertIsNone(result.archive)
            self.assertTrue(fixture["candidate"].is_dir())
            prepared = retirement._archive_target(backend, spec)
            record, _ = retirement._read_archive_manifest(backend, prepared)
            self.assertEqual(record["state"], "prepared")

    def test_start_full_fresh_without_candidates_does_not_prepare_retirement_archive(self):
        self._require_start_integration()
        with self._fixture("fresh") as fixture:
            candidate_root = fixture["control_root"] / backend.PACKAGE_CANDIDATES_DIRNAME
            shutil.rmtree(fixture["candidate"])
            candidate_root.mkdir(exist_ok=True)
            archive_root = (
                Path(backend.BACKEND_CONTROL_ROOT)
                / retirement.RETIREMENT_NAMESPACE_NAME
            )
            args = argparse.Namespace(
                build_root=str(fixture["build_root"]),
                output=str(fixture["package"]),
                jobs=1,
            )
            prepared_calls = []
            served = []

            def fail_if_preparing(*_args, **_kwargs):
                prepared_calls.append(True)
                raise AssertionError("verified full-fresh package must not prepare Make")

            def serve(extra):
                served.append(list(extra))
                return 41

            with (
                patch.object(backend, "_validate_start_output"),
                patch.object(backend, "_backend_cache_receipt", return_value=None),
                patch.object(backend, "_prune_failed_make_logs"),
                patch.object(
                    backend,
                    "_toolchain_identity",
                    return_value=("toolchain", fixture["toolchain"]),
                ),
                patch.object(
                    backend,
                    "_capture_start_manifest",
                    return_value=fixture["candidate_manifest"],
                ),
                patch.object(
                    backend,
                    "_package_matches_fresh_live_manifest",
                    return_value=True,
                ),
                patch.object(backend, "_snapshot_bound_provenance", return_value=b"old"),
                patch.object(backend, "_publish_runtime_provenance"),
                patch.object(backend, "_prepare_locked", side_effect=fail_if_preparing),
                patch.object(backend, "_serve", side_effect=serve),
                patch.object(backend, "_log_phase"),
            ):
                result = backend._start(args)

            self.assertEqual(result, 41)
            self.assertEqual(served, [[]])
            self.assertEqual(prepared_calls, [])
            self.assertFalse(
                archive_root.exists() and any(archive_root.iterdir()),
                "normal full-fresh startup must not create retirement evidence",
            )

    def test_stale_retirement_revalidates_current_before_payload_delete(self):
        with self._fixture("stale") as fixture:
            spec = self._qualify(fixture)
            current_receipt_path = fixture["package"] / "backend-build-receipt.json"
            original_fsync = backend._fsync_directory
            mutated = False

            def mutate_after_intent(path, name):
                nonlocal mutated
                result = original_fsync(path, name)
                if name == "candidate retirement archive" and not mutated:
                    receipt, _ = backend._read_json(
                        current_receipt_path,
                        "current package receipt before retirement drift",
                    )
                    receipt["operator_drift"] = "changed after deletion intent"
                    backend._write_json(
                        current_receipt_path,
                        receipt,
                        "drifted current package during retirement",
                    )
                    mutated = True
                return result

            with (
                patch.object(backend, "_fsync_directory", side_effect=mutate_after_intent),
                self.assertRaises(backend.BackendBuildError),
            ):
                retirement.retire_candidate(
                    backend,
                    spec,
                    fixture["current_manifest"],
                    fixture["toolchain"],
                    backend.BACKEND_CARGO_PROFILE,
                    fixture["current"],
                )

            self.assertTrue(mutated)
            self.assertTrue(fixture["candidate"].is_dir())
            archive = retirement._archive_target(backend, spec)
            record, _ = retirement._read_archive_manifest(backend, archive)
            self.assertEqual(record["state"], "deletion-pending")
            self.assertFalse(record["payload_deleted"])
            self.assertFalse(record["marker_deleted"])


    def test_pending_normalization_retains_current_hash_bindings(self):
        with self._fixture("stale") as fixture:
            spec = self._qualify(fixture)
            archive, manifest = self._action_prepared_archive(fixture, spec)
            normalized = retirement._validate_manifest_shape(
                backend,
                archive,
                manifest,
                require_pending=True,
            )
            self.assertEqual(
                normalized["current_receipt_sha256"],
                manifest["current_receipt_sha256"],
            )
            self.assertEqual(
                normalized["current_provenance_sha256"],
                manifest["current_provenance_sha256"],
            )
            result = retirement.recover_pending_retirements(
                backend,
                fixture["package"],
                fixture["control_root"],
                fixture["build_root"],
                fixture["current"],
            )
            self.assertEqual(result[0].action, "retired")
            self.assertFalse(fixture["candidate"].exists())

    def test_malformed_candidate_receipt_source_native_and_build_bindings_preserve_candidate(self):
        mutations = {
            "source": lambda receipt: {
                **dict(receipt["source"]),
                "source_digest": "0" * 64,
            },
            "native_source_identity": lambda receipt: {
                **dict(receipt["native_source_identity"]),
                "source_snapshot_sha256": "0" * 64,
            },
            "build": lambda receipt: {
                **dict(receipt["build"]),
                "mode": "invalid-mode",
            },
        }
        for field, mutate in mutations.items():
            with self.subTest(field=field), self._fixture("stale") as fixture:
                receipt_path = fixture["candidate"] / "backend-build-receipt.json"
                receipt, _ = backend._read_json(
                    receipt_path,
                    "candidate receipt before provenance mutation",
                )
                receipt[field] = mutate(receipt)
                backend._write_json(
                    receipt_path,
                    receipt,
                    f"malformed candidate receipt {field}",
                )
                with self.assertRaises(backend.BackendBuildError):
                    self._qualify(fixture)
                self.assertTrue(fixture["candidate"].is_dir())
                archives = Path(backend.BACKEND_CONTROL_ROOT) / retirement.RETIREMENT_NAMESPACE_NAME
                staging = Path(backend.BACKEND_CONTROL_ROOT) / retirement.RETIREMENT_STAGING_NAMESPACE_NAME
                self.assertFalse(archives.exists() and any(archives.iterdir()))
                self.assertFalse(staging.exists() and any(staging.iterdir()))

    def test_candidate_mode_change_after_intent_blocks_payload_deletion(self):
        with self._fixture("stale") as fixture:
            spec = self._qualify(fixture)
            payload = fixture["candidate"] / "bin" / "fullmag-bin"
            original_fsync = backend._fsync_directory
            mutated = False

            def chmod_after_intent(path, name):
                nonlocal mutated
                result = original_fsync(path, name)
                if name == "candidate retirement archive" and not mutated:
                    payload.chmod(0o644)
                    mutated = True
                return result

            with (
                patch.object(backend, "_fsync_directory", side_effect=chmod_after_intent),
                self.assertRaises(backend.BackendBuildError),
            ):
                retirement.retire_candidate(
                    backend,
                    spec,
                    fixture["current_manifest"],
                    fixture["toolchain"],
                    backend.BACKEND_CARGO_PROFILE,
                    fixture["current"],
                )

            self.assertTrue(mutated)
            self.assertTrue(fixture["candidate"].is_dir())
            archive = retirement._archive_target(backend, spec)
            record, _ = retirement._read_archive_manifest(backend, archive)
            self.assertEqual(record["state"], "deletion-pending")
            self.assertFalse(record["payload_deleted"])

    def test_orphan_staging_within_budget_is_retained_while_new_archive_publishes(self):
        with self._fixture("stale") as fixture:
            staging_root = (
                Path(backend.BACKEND_CONTROL_ROOT)
                / retirement.RETIREMENT_STAGING_NAMESPACE_NAME
            )
            orphan = staging_root / ".backend-package-candidate-staging-orphan"
            orphan.mkdir(parents=True)
            evidence = orphan / "partial-record"
            evidence.write_bytes(b"crash-left staging evidence\n")
            evidence_before = evidence.read_bytes()

            spec = self._qualify(fixture)
            archive = retirement._archive_target(backend, spec)
            self.assertTrue(archive.is_dir())
            self.assertTrue(orphan.is_dir())
            self.assertEqual(evidence.read_bytes(), evidence_before)
            record, _ = retirement._read_archive_manifest(backend, archive)
            self.assertEqual(record["state"], "prepared")

    def test_prepared_promotion_crash_recovers_as_historical(self):
        with self._fixture("fresh") as fixture:
            spec = self._qualify(fixture)
            rotation = backend._rotate_package(
                fixture["package"],
                fixture["candidate"],
                fixture["control_root"],
                fixture["current"][2],
                fixture["current"][1],
                spec.receipt_bytes,
            )
            backend._publish_runtime_provenance(fixture["package"])
            backend._finalize_published_candidate(fixture["candidate"], rotation)
            backend._clear_rotation_journal(rotation)
            promoted_current = backend._validated_package(
                fixture["package"],
                "prepared promotion recovered current package",
                exclude_development_control=True,
            )

            recovered = retirement.recover_pending_retirements(
                backend,
                fixture["package"],
                fixture["control_root"],
                fixture["build_root"],
                promoted_current,
            )
            self.assertEqual(len(recovered), 1)
            self.assertEqual(recovered[0].action, "historical")
            self.assertFalse(fixture["candidate"].exists())
            archive = retirement._archive_target(backend, spec)
            record, _ = retirement._read_archive_manifest(backend, archive)
            self.assertEqual(record["state"], "historical")
            self.assertEqual(record["classification"], "promoted")


    def test_archive_byte_budget_rejects_before_payload_copy(self):
        for limit in ("RETIREMENT_MAX_BYTES", "RETIREMENT_MAX_STAGING_BYTES"):
            with self.subTest(limit=limit), self._fixture("stale") as fixture:
                current_before = self._current_snapshot(fixture)
                with (
                    patch.object(retirement, limit, 1),
                    patch.object(retirement, "_archive_copy", wraps=retirement._archive_copy) as copy,
                    self.assertRaises(backend.BackendBuildError),
                ):
                    self._qualify(fixture)
                copy.assert_not_called()
                self.assertTrue(fixture["candidate"].is_dir())
                self.assertEqual(self._current_snapshot(fixture), current_before)
                staging = Path(backend.BACKEND_CONTROL_ROOT) / retirement.RETIREMENT_STAGING_NAMESPACE_NAME
                self.assertFalse(staging.exists() and any(staging.iterdir()))

    def test_shared_artifact_hardlinks_retire_without_changing_store_or_other_consumers(self):
        with self._fixture("stale") as fixture:
            with self._shared_candidate(fixture, third_consumer=True) as (
                store,
                identity,
                consumer,
                shared,
            ):
                artifact_paths = {
                    item["path"]
                    for item in backend._read_json(
                        fixture["candidate"] / "backend-build-receipt.json",
                        "shared candidate receipt",
                    )[0]["artifacts"]
                }
                self.assertTrue(
                    {"launcher-build-mode", *backend.RUNTIME_MANIFEST_PATHS}.issubset(
                        artifact_paths
                    )
                )
                self.assertTrue(all(
                    (fixture["candidate"] / relative).stat().st_nlink >= 3
                    for relative in artifact_paths
                ))
                consumer_before = {
                    relative: (consumer / relative).read_bytes()
                    for relative in artifact_paths
                }
                current_before = self._current_snapshot(fixture)
                provenance_before = fixture["provenance_path"].read_bytes()

                spec = self._qualify(fixture)
                result = retirement.retire_candidate(
                    backend,
                    spec,
                    fixture["current_manifest"],
                    fixture["toolchain"],
                    backend.BACKEND_CARGO_PROFILE,
                    fixture["current"],
                )

                self.assertEqual((result.action, result.classification), ("retired", "stale"))
                self.assertFalse(fixture["candidate"].exists())
                self.assertEqual(self._current_snapshot(fixture), current_before)
                self.assertEqual(fixture["provenance_path"].read_bytes(), provenance_before)
                self.assertEqual(
                    {relative: (consumer / relative).read_bytes() for relative in artifact_paths},
                    consumer_before,
                )
                for relative in artifact_paths:
                    self.assertEqual((consumer / relative).stat().st_nlink, 2)
                with store.claim(identity) as entry:
                    self.assertEqual(entry.read()["receipt"]["artifacts"], spec.receipt["artifacts"])
                for path in result.archive.rglob("*"):
                    if path.is_file():
                        self.assertEqual(path.stat().st_nlink, 1)

    def test_shared_cache_consumer_receipt_proves_producer_and_allows_stale_retirement(self):
        with self._fixture("stale") as fixture:
            with self._shared_candidate(fixture, third_consumer=True) as (
                store,
                identity,
                consumer,
                shared,
            ):
                self._rewrite_as_shared_consumer(fixture, store, identity, shared)
                spec = self._qualify(fixture)
                result = retirement.retire_candidate(
                    backend,
                    spec,
                    fixture["current_manifest"],
                    fixture["toolchain"],
                    backend.BACKEND_CARGO_PROFILE,
                    fixture["current"],
                )

                self.assertEqual((result.action, result.classification), ("retired", "stale"))
                self.assertFalse(fixture["candidate"].exists())
                with store.claim(identity) as entry:
                    self.assertEqual(entry.read()["receipt"]["artifacts"], spec.receipt["artifacts"])
                self.assertEqual(
                    (consumer / "runtimes/fem-gpu/manifest.json").read_bytes(),
                    (result.archive / "candidate-metadata/runtimes/fem-gpu/manifest.json").read_bytes(),
                )

    def test_fresh_shared_candidate_is_qualified_for_existing_promotion_path(self):
        with self._fixture("fresh") as fixture:
            with self._shared_candidate(fixture) as (store, identity, _consumer, _shared):
                spec = self._qualify(fixture)
                result = retirement.retire_candidate(
                    backend,
                    spec,
                    fixture["candidate_manifest"],
                    fixture["toolchain"],
                    backend.BACKEND_CARGO_PROFILE,
                    fixture["current"],
                )

                self.assertEqual(result.action, "promote")
                self.assertTrue(fixture["candidate"].is_dir())
                with store.claim(identity) as entry:
                    self.assertEqual(entry.read()["receipt"]["artifacts"], spec.receipt["artifacts"])

    def test_shared_artifact_pending_deletion_resumes_and_preserves_other_consumer(self):
        with self._fixture("stale") as fixture:
            with self._shared_candidate(fixture, third_consumer=True) as (
                store,
                identity,
                consumer,
                _shared,
            ):
                spec = self._qualify(fixture)
                archive, manifest = self._action_prepared_archive(fixture, spec)
                self.assertEqual(manifest["state"], "deletion-pending")
                removed_before_crash = "bin/fullmag-bin"
                removed_bytes = (consumer / removed_before_crash).read_bytes()
                churned_alias = "_fullmag_core.so"
                churned_candidate = fixture["candidate"] / churned_alias
                churned_consumer = consumer / churned_alias
                before_churn = churned_candidate.stat()
                churned_consumer.unlink()
                after_churn = churned_candidate.stat()
                self.assertEqual(after_churn.st_nlink, before_churn.st_nlink - 1)
                self.assertEqual(
                    (after_churn.st_dev, after_churn.st_ino),
                    (before_churn.st_dev, before_churn.st_ino),
                )
                retirement._candidate_matches_spec(backend, spec)
                (fixture["candidate"] / removed_before_crash).unlink()

                result = retirement.recover_pending_retirements(
                    backend,
                    fixture["package"],
                    fixture["control_root"],
                    fixture["build_root"],
                    fixture["current"],
                )

                self.assertEqual(len(result), 1)
                self.assertEqual(result[0].action, "retired")
                self.assertFalse(fixture["candidate"].exists())
                self.assertEqual((consumer / removed_before_crash).read_bytes(), removed_bytes)
                with store.claim(identity) as entry:
                    self.assertEqual(entry.read()["receipt"]["artifacts"], spec.receipt["artifacts"])
                completed, _ = retirement._read_archive_manifest(backend, archive)
                self.assertEqual(completed["state"], "succeeded")

    def test_shared_artifact_hardlink_requires_exact_sealed_shared_proof(self):
        for mutation in (
            "missing-binding",
            "wrong-key",
            "wrong-inputs",
            "wrong-inode",
            "wrong-producer-sha",
            "writable",
            "wrong-shared-hash",
            "linked-marker",
            "linked-receipt",
            "linked-metadata",
            "linked-make-log",
        ):
            with self.subTest(mutation=mutation), self._fixture("stale") as fixture:
                with self._shared_candidate(fixture) as (store, _identity, _consumer, shared):
                    receipt_path = fixture["candidate"] / "backend-build-receipt.json"
                    receipt, _ = backend._read_json(receipt_path, "shared candidate receipt")
                    relative = "bin/fullmag-bin"
                    candidate_path = fixture["candidate"] / relative
                    if mutation == "missing-binding":
                        receipt.pop("shared_package")
                        backend._write_json(receipt_path, receipt, "unbound shared candidate receipt")
                    elif mutation == "wrong-key":
                        receipt["shared_package"]["key"] = "0" * 64
                        backend._write_json(receipt_path, receipt, "wrong-key candidate receipt")
                    elif mutation == "wrong-inputs":
                        receipt["shared_package"]["inputs"]["resolved_commit"] = "f" * 40
                        receipt["shared_package"]["key"] = shared.key_for(
                            receipt["shared_package"]["inputs"]
                        )
                        backend._write_json(receipt_path, receipt, "wrong-input candidate receipt")
                    elif mutation == "wrong-producer-sha":
                        self._rewrite_as_shared_consumer(
                            fixture,
                            store,
                            _identity,
                            shared,
                            producer_sha256="0" * 64,
                        )
                    elif mutation == "wrong-inode":
                        data = candidate_path.read_bytes()
                        mode = candidate_path.stat().st_mode & 0o777
                        candidate_path.unlink()
                        candidate_path.write_bytes(data)
                        candidate_path.chmod(mode)
                        os.link(candidate_path, fixture["root"] / "unbound-copy")
                    elif mutation == "writable":
                        mode = candidate_path.stat().st_mode & 0o777
                        candidate_path.chmod(mode | 0o200)
                    elif mutation == "wrong-shared-hash":
                        entry = next((store.root / "artifacts").iterdir())
                        self.assertIsNotNone(entry)
                        manifest_path = entry / "manifest.json"
                        manifest = json.loads(manifest_path.read_text())
                        manifest["receipt"]["artifacts"][0]["sha256"] = "0" * 64
                        manifest_path.write_bytes(shared.canonical(manifest))
                    elif mutation == "linked-marker":
                        os.link(
                            fixture["candidate"] / backend.PACKAGE_CANDIDATE_MARKER,
                            fixture["root"] / "unbound-marker",
                        )
                    elif mutation == "linked-receipt":
                        os.link(receipt_path, fixture["root"] / "unbound-receipt")
                    elif mutation == "linked-metadata":
                        metadata_path = fixture["candidate"] / "source-identity.json"
                        metadata_path.write_bytes(b"private metadata\n")
                        os.link(metadata_path, fixture["root"] / "unbound-metadata")
                    elif mutation == "linked-make-log":
                        os.link(
                            fixture["candidate"] / backend.FAILED_MAKE_LOG_NAME,
                            fixture["root"] / "unbound-make-log",
                        )

                    with self.assertRaises(backend.BackendBuildError):
                        self._qualify(fixture)
                    self.assertTrue(fixture["candidate"].is_dir())


if __name__ == "__main__":
    unittest.main()
