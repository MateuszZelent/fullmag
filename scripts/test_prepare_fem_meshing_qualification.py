from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "prepare_fem_meshing_qualification.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("fem_meshing_preflight", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _git(repo: Path, *arguments: str, input: bytes | None = None) -> bytes:
    return subprocess.run(
        ("git", *arguments), cwd=repo, input=input, capture_output=True, check=True
    ).stdout


def _repository(root: Path) -> Path:
    repo = root / "repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.name", "FEM Meshing Preflight Test")
    _git(repo, "config", "user.email", "fem-meshing-preflight@example.invalid")
    (repo / "tracked.txt").write_text("committed\n", encoding="utf-8")
    _git(repo, "add", "tracked.txt")
    _git(repo, "commit", "-qm", "initial")
    return repo


def _fixture(repo: Path, content: str = '{"case":"S13"}\n') -> Path:
    path = repo / "qualification-fixture.json"
    path.write_text(content, encoding="utf-8")
    return path


class FemMeshingQualificationPreflightTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _assert_empty_or_absent(self, path: Path) -> None:
        self.assertFalse(path.exists() and any(path.iterdir()))

    def test_rejects_active_integration_states_before_writing(self) -> None:
        module = _load_module()
        for state in ("MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"):
            with self.subTest(state=state):
                root = self.root / state
                root.mkdir()
                repo = _repository(root)
                fixture = _fixture(repo)
                evidence = root / "evidence"
                (repo / ".git" / state).write_text("active\n", encoding="utf-8")
                with self.assertRaisesRegex(module.PreflightError, "active Git operation"):
                    module.prepare(repo, evidence, (fixture.name,))
                self._assert_empty_or_absent(evidence)

    def test_rejects_unmerged_entries_and_index_lock_before_writing(self) -> None:
        module = _load_module()
        repo = _repository(self.root)
        fixture = _fixture(repo)
        evidence = self.root / "evidence-unmerged"
        ours = _git(repo, "hash-object", "-w", "--stdin", input=b"ours\n").decode().strip()
        theirs = _git(repo, "hash-object", "-w", "--stdin", input=b"theirs\n").decode().strip()
        _git(repo, "update-index", "--index-info", input=(f"100644 {ours} 2\tconflict.txt\n" f"100644 {theirs} 3\tconflict.txt\n").encode())
        with self.assertRaisesRegex(module.PreflightError, "unmerged Git index entries"):
            module.prepare(repo, evidence, (fixture.name,))
        self._assert_empty_or_absent(evidence)
        _git(repo, "read-tree", "HEAD")
        (repo / ".git" / "index.lock").write_text("locked\n", encoding="utf-8")
        with self.assertRaisesRegex(module.PreflightError, "Git index lock"):
            module.prepare(repo, evidence, (fixture.name,))
        self._assert_empty_or_absent(evidence)

    def test_rejects_noncanonical_repository_root_before_writing(self) -> None:
        module = _load_module()
        repo = _repository(self.root)
        fixture = _fixture(repo)
        nested = repo / "nested"
        nested.mkdir()
        evidence = self.root / "evidence"
        with self.assertRaisesRegex(module.PreflightError, "repository root is not the Git top-level"):
            module.prepare(nested, evidence, (fixture.name,))
        self._assert_empty_or_absent(evidence)

    def test_rejects_unsafe_evidence_roots_before_writing(self) -> None:
        module = _load_module()
        repo = _repository(self.root)
        fixture = _fixture(repo)
        inside = repo / "evidence"
        cache = self.root / ".fullmag-cache"
        runtime = self.root / "fem-gpu-host"
        nonempty = self.root / "nonempty"
        nonempty.mkdir()
        (nonempty / "prior-artifact").write_text("x\n", encoding="utf-8")
        with self.assertRaisesRegex(module.PreflightError, "evidence root is inside repository"):
            module.prepare(repo, inside, (fixture.name,))
        with self.assertRaisesRegex(module.PreflightError, "known build/cache/runtime root"):
            module.prepare(repo, cache, (fixture.name,))
        with self.assertRaisesRegex(module.PreflightError, "known build/cache/runtime root"):
            module.prepare(repo, runtime, (fixture.name,))
        with self.assertRaisesRegex(module.PreflightError, "evidence root is not empty"):
            module.prepare(repo, nonempty, (fixture.name,))
        self._assert_empty_or_absent(inside)
        self._assert_empty_or_absent(cache)
        self._assert_empty_or_absent(runtime)
        self.assertEqual((nonempty / "prior-artifact").read_text(encoding="utf-8"), "x\n")

    def test_rejects_evidence_nested_under_known_root_and_resolved_parent_link(self) -> None:
        module = _load_module()
        repo = _repository(self.root)
        fixture = _fixture(repo)
        cache = self.root / ".fullmag-cache"
        cache.mkdir()
        nested = cache / "nested" / "evidence"
        with self.assertRaisesRegex(module.PreflightError, "known build/cache/runtime root"):
            module.prepare(repo, nested, (fixture.name,))
        link_parent = self.root / "linked-parent"
        try:
            link_parent.symlink_to(cache, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"parent symlink unavailable: {error}")
        with self.assertRaisesRegex(module.PreflightError, "known build/cache/runtime root"):
            module.prepare(repo, link_parent / "nested" / "evidence", (fixture.name,))

    def test_rejects_lexical_and_resolved_evidence_ancestry_and_final_link(self) -> None:
        module = _load_module()
        repo = _repository(self.root)
        fixture = _fixture(repo)
        external = self.root / "external"
        external.mkdir()
        direct_cache = self.root / ".fullmag-cache"
        direct_cache.mkdir()
        with self.assertRaisesRegex(module.PreflightError, "evidence root is inside repository"):
            module._validate_evidence_root(repo, repo / "evidence")
        with self.assertRaisesRegex(module.PreflightError, "known build/cache/runtime root"):
            module._validate_evidence_root(repo, direct_cache / "evidence")
        lexical_repo_link = repo / "lexical-link"
        lexical_cache_parent = self.root / "lexical-cache-parent"
        lexical_cache_parent.mkdir()
        lexical_cache_link = lexical_cache_parent / ".fullmag-cache"
        resolved_repo_link = self.root / "resolved-repo-link"
        resolved_cache_link = self.root / "resolved-cache-link"
        final_link = self.root / "final-evidence-link"
        try:
            lexical_repo_link.symlink_to(external, target_is_directory=True)
            lexical_cache_link.symlink_to(external, target_is_directory=True)
            resolved_repo_link.symlink_to(repo, target_is_directory=True)
            resolved_cache_link.symlink_to(direct_cache, target_is_directory=True)
            final_link.symlink_to(external, target_is_directory=True)
        except OSError:
            with self.assertRaises(module.PreflightError):
                module._validate_evidence_root(repo, repo / "lexical-contract")
            return
        with self.assertRaisesRegex(module.PreflightError, "evidence root is inside repository"):
            module.prepare(repo, lexical_repo_link / "evidence", (fixture.name,))
        lexical_repo_link.unlink()
        with self.assertRaisesRegex(module.PreflightError, "known build/cache/runtime root"):
            module.prepare(repo, lexical_cache_link / "evidence", (fixture.name,))
        with self.assertRaisesRegex(module.PreflightError, "evidence root is inside repository"):
            module.prepare(repo, resolved_repo_link / "evidence", (fixture.name,))
        with self.assertRaisesRegex(module.PreflightError, "known build/cache/runtime root"):
            module.prepare(repo, resolved_cache_link / "evidence", (fixture.name,))
        with self.assertRaisesRegex(module.PreflightError, "evidence root must not be a link"):
            module.prepare(repo, final_link, (fixture.name,))

    def test_parent_retarget_during_capture_cannot_redirect_publication(self) -> None:
        module = _load_module()
        repo = _repository(self.root)
        fixture = _fixture(repo)
        first_parent = self.root / "first-parent"
        second_parent = self.root / "second-parent"
        first_parent.mkdir()
        second_parent.mkdir()
        link_parent = self.root / "evidence-parent"
        try:
            link_parent.symlink_to(first_parent, target_is_directory=True)
        except OSError:
            with self.assertRaises(module.source_identity.SourceIdentityError):
                module.source_identity._resolve_contained_path(repo, self.root / "outside", "qualification input")
            return
        original = module.source_identity.capture

        def retarget(*args, **kwargs):
            link_parent.unlink()
            link_parent.symlink_to(second_parent, target_is_directory=True)
            return original(*args, **kwargs)

        with mock.patch.object(module.source_identity, "capture", side_effect=retarget):
            with self.assertRaisesRegex(module.PreflightError, "evidence root target changed"):
                module.prepare(repo, link_parent / "evidence", (fixture.name,))
        self.assertFalse((first_parent / "evidence").exists())
        self.assertFalse((second_parent / "evidence").exists())

    def test_rejects_windows_rooted_drive_and_device_inputs_before_writing(self) -> None:
        module = _load_module()
        repo = _repository(self.root)
        evidence = self.root / "evidence"
        for value in (r"\foo", "/foo", "C:foo", r"C:\foo", r"\\server\share\file", r"\\?\C:\file", r"\\.\PhysicalDrive0"):
            with self.subTest(value=value):
                with self.assertRaisesRegex(module.PreflightError, "unsafe qualification input"):
                    module.prepare(repo, evidence, (value,))
                self._assert_empty_or_absent(evidence)

    def test_rejects_qualification_input_parent_link_escape_and_physical_duplicates(self) -> None:
        module = _load_module()
        repo = _repository(self.root)
        fixture = _fixture(repo)
        outside = self.root / "outside"
        outside.mkdir()
        external = outside / fixture.name
        external.write_text("external\n", encoding="utf-8")
        with self.assertRaises(module.source_identity.SourceIdentityError):
            module.source_identity._resolve_contained_path(repo, external, "qualification input")
        parent_link = repo / "external-parent"
        try:
            parent_link.symlink_to(outside, target_is_directory=True)
        except OSError:
            parent_link = None
        if parent_link is not None:
            with self.assertRaisesRegex(module.PreflightError, "qualification input escapes repository"):
                module.prepare(repo, self.root / "evidence-escape", (f"external-parent/{fixture.name}",))
        hardlink = repo / "fixture-hardlink.json"
        hardlink.hardlink_to(fixture)
        with self.assertRaisesRegex(module.PreflightError, "duplicate qualification input"):
            module.prepare(repo, self.root / "evidence-hardlink", (fixture.name, hardlink.name))
        with self.assertRaisesRegex(module.PreflightError, "duplicate qualification input"):
            module.prepare(repo, self.root / "evidence-alias", (fixture.name, f"./{fixture.name}"))
        case_variant = fixture.name.upper()
        if os.name == "nt":
            with self.assertRaisesRegex(module.PreflightError, "duplicate qualification input"):
                module.prepare(repo, self.root / "evidence-case", (fixture.name, case_variant))
        else:
            with self.assertRaisesRegex(module.PreflightError, "qualification input is missing"):
                module.prepare(repo, self.root / "evidence-case", (fixture.name, case_variant))

    def test_canonical_unstable_capture_fails_before_writing(self) -> None:
        module = _load_module()
        repo = _repository(self.root)
        fixture = _fixture(repo)
        evidence = self.root / "evidence"
        captures = iter(({"source_snapshot_sha256": "a" * 64}, {"source_snapshot_sha256": "b" * 64}))
        with mock.patch.object(module.source_identity, "_capture_once", side_effect=lambda *args, **kwargs: next(captures)):
            with self.assertRaisesRegex(module.PreflightError, "source identity capture failed"):
                module.prepare(repo, evidence, (fixture.name,))
        self._assert_empty_or_absent(evidence)

    def test_uses_one_canonical_double_capture(self) -> None:
        module = _load_module()
        repo = _repository(self.root)
        fixture = _fixture(repo)
        evidence = self.root / "evidence"
        original = module.source_identity.capture
        with mock.patch.object(module.source_identity, "capture", wraps=original) as captured:
            module.prepare(repo, evidence, (fixture.name,))
        self.assertEqual(captured.call_count, 1)

    def test_revalidates_git_state_introduced_during_capture(self) -> None:
        module = _load_module()
        repo = _repository(self.root)
        fixture = _fixture(repo)
        evidence = self.root / "evidence"
        original = module.source_identity.capture

        def introduce_merge_state(*args, **kwargs):
            (repo / ".git" / "MERGE_HEAD").write_text("active\n", encoding="utf-8")
            return original(*args, **kwargs)

        with mock.patch.object(module.source_identity, "capture", side_effect=introduce_merge_state):
            with self.assertRaisesRegex(module.PreflightError, "active Git operation"):
                module.prepare(repo, evidence, (fixture.name,))
        self._assert_empty_or_absent(evidence)

    def test_rejects_input_bytes_or_mode_changed_after_capture(self) -> None:
        module = _load_module()
        repo = _repository(self.root)
        fixture = _fixture(repo)
        original_capture = module.source_identity.capture
        before = fixture.stat()

        def mutate_bytes(*args, **kwargs):
            identity = original_capture(*args, **kwargs)
            fixture.write_text('{"case":"T13"}\n', encoding="utf-8")
            self.assertEqual(fixture.stat().st_ino, before.st_ino)
            return identity

        with mock.patch.object(module.source_identity, "capture", side_effect=mutate_bytes):
            with self.assertRaisesRegex(module.PreflightError, "qualification inputs changed during capture"):
                module.prepare(repo, self.root / "bytes-evidence", (fixture.name,))
        self._assert_empty_or_absent(self.root / "bytes-evidence")

        fixture = _fixture(repo)
        mode_before = stat.S_IMODE(fixture.stat().st_mode)
        changed_mode = mode_before ^ stat.S_IXUSR

        def mutate_mode(*args, **kwargs):
            identity = original_capture(*args, **kwargs)
            fixture.chmod(changed_mode)
            return identity

        with mock.patch.object(module.source_identity, "capture", side_effect=mutate_mode):
            if stat.S_IMODE(fixture.stat().st_mode) == changed_mode:
                with self.assertRaisesRegex(module.PreflightError, "qualification inputs changed during capture"):
                    module.prepare(repo, self.root / "mode-evidence", (fixture.name,))
            else:
                self.skipTest("platform does not preserve executable mode changes")
        self._assert_empty_or_absent(self.root / "mode-evidence")

    def test_qualification_capture_reads_from_resolved_parent(self) -> None:
        module = _load_module()
        repo = _repository(self.root)
        fixture = _fixture(repo)
        resolved = repo / "canonical" / fixture.name
        resolved.parent.mkdir()
        resolved.write_bytes(fixture.read_bytes())
        original_resolve = module.source_identity._resolve_contained_path
        original_read = module.source_identity._read_regular_file_stable

        def resolve(path_root: Path, path: Path, label: str) -> Path:
            if path.name == fixture.name and path.parent.name == "alias":
                return resolved
            if path.name == "alias":
                return resolved.parent
            return original_resolve(path_root, path, label)

        with mock.patch.object(
            module.source_identity,
            "_resolve_contained_path",
            side_effect=resolve,
        ) as resolve:
            with mock.patch.object(
                module.source_identity,
                "_read_regular_file_stable",
                wraps=original_read,
            ) as read:
                module.source_identity._qualification_input_content(
                    repo, (f"alias/{fixture.name}",)
                )
        self.assertGreaterEqual(resolve.call_count, 1)
        self.assertEqual(read.call_args.args[0], resolved)

    def test_lease_ownership_registration_failure_rolls_back(self) -> None:
        module = _load_module()
        repo = _repository(self.root)
        fixture = _fixture(repo)
        evidence = self.root / "lease-ownership-failure"
        original_owned = module.OwnedPath

        def fail_lease(path: Path, identity: tuple[int, int]):
            if path.name == module.EVIDENCE_LEASE_NAME:
                raise RuntimeError("ownership failure")
            return original_owned(path, identity)

        with mock.patch.object(module, "OwnedPath", side_effect=fail_lease):
            with self.assertRaisesRegex(
                module.PreflightError, "cannot acquire evidence root lease"
            ):
                module.prepare(repo, evidence, (fixture.name,))
        self._assert_empty_or_absent(evidence)

    def test_exclusive_file_fstat_failure_discards_open_handle(self) -> None:
        module = _load_module()
        path = self.root / "fstat-failure.staging"
        owned: list[object] = []
        with mock.patch.object(module.os, "fstat", side_effect=OSError("fstat failure")):
            with self.assertRaises(OSError):
                module._write_exclusive_json(path, {"x": 1}, owned)
        self.assertFalse(path.exists())

    def test_final_ownership_registration_failure_rolls_back_final(self) -> None:
        module = _load_module()
        repo = _repository(self.root)
        fixture = _fixture(repo)
        evidence = self.root / "final-ownership-failure"
        original_link = module.os.link

        def link_then_fail(source: object, destination: object) -> None:
            original_link(source, destination)
            raise RuntimeError("final ownership failure")

        with mock.patch.object(module.os, "link", side_effect=link_then_fail):
            with self.assertRaisesRegex(module.PreflightError, "publication"):
                module.prepare(repo, evidence, (fixture.name,))
        self._assert_empty_or_absent(evidence)

    def test_final_artifact_replacement_before_commit_is_rejected(self) -> None:
        module = _load_module()
        repo = _repository(self.root)
        fixture = _fixture(repo)
        evidence = self.root / "final-replacement"
        original_verify = module._verify_owned_json
        replaced = False

        def replace_source_before_verify(owned: object, payload: object) -> None:
            nonlocal replaced
            if not replaced and owned.path.name == module.SOURCE_SNAPSHOT_NAME:
                owned.path.unlink()
                owned.path.write_text("foreign\n", encoding="utf-8")
                replaced = True
            original_verify(owned, payload)

        with mock.patch.object(
            module, "_verify_owned_json", side_effect=replace_source_before_verify
        ):
            with self.assertRaisesRegex(
                module.PreflightError, "publication rollback blocked by concurrent mutation"
            ):
                module.prepare(repo, evidence, (fixture.name,))
        self.assertEqual(
            (evidence / module.SOURCE_SNAPSHOT_NAME).read_text(encoding="utf-8"),
            "foreign\n",
        )
        self.assertFalse((evidence / module.SCOPE_NAME).exists())
        self.assertFalse((evidence / module.EVIDENCE_LEASE_NAME).exists())

    def test_rollback_never_removes_replaced_evidence_root(self) -> None:
        module = _load_module()
        evidence = self.root / "evidence"
        evidence.mkdir()
        retired = self.root / "retired-evidence"
        evidence.rename(retired)
        evidence.mkdir()
        module._rollback_publication(evidence, (), True)
        self.assertTrue(evidence.is_dir())
        self.assertTrue(retired.is_dir())

    def test_post_capture_mode_identity_contract_is_not_platform_skipped(self) -> None:
        module = _load_module()
        repo = _repository(self.root)
        fixture = _fixture(repo)
        initial = module._validate_qualification_inputs(repo, (fixture.name,))
        expected = module.source_identity._qualification_input_content(repo, (fixture.name,))
        changed = [{**expected[0], "mode": "100755"}]
        with mock.patch.object(module.source_identity, "_qualification_input_content", return_value=changed):
            with self.assertRaisesRegex(module.PreflightError, "qualification inputs changed during capture"):
                module._validate_captured_qualification_inputs(repo, (fixture.name,), initial, expected)

    def test_rejects_canonical_evidence_ancestor_identity_drift_after_capture(self) -> None:
        module = _load_module()
        repo = _repository(self.root)
        fixture = _fixture(repo)
        parent = self.root / "stable-parent"
        parent.mkdir()
        evidence = parent / "evidence"
        original_capture = module.source_identity.capture

        def replace_parent(*args, **kwargs):
            identity = original_capture(*args, **kwargs)
            retired = self.root / "retired-parent"
            parent.rename(retired)
            parent.mkdir()
            return identity

        with mock.patch.object(module.source_identity, "capture", side_effect=replace_parent):
            with self.assertRaisesRegex(module.PreflightError, "evidence root ancestry changed"):
                module.prepare(repo, evidence, (fixture.name,))
        self._assert_empty_or_absent(evidence)

    def test_git_failures_and_decode_errors_are_invariant_specific(self) -> None:
        module = _load_module()
        with mock.patch.object(module.subprocess, "check_output", side_effect=OSError("host detail")):
            with self.assertRaisesRegex(module.PreflightError, "cannot inspect Git status"):
                module._git(self.root, "status", "status", "--short")
        with mock.patch.object(module, "_git", return_value=b"\xff"):
            with self.assertRaisesRegex(module.PreflightError, "cannot decode Git marker index.lock"):
                module._git_path(self.root, "index.lock")

    def test_cli_normalizes_repository_resolve_failure(self) -> None:
        module = _load_module()
        stderr = io.StringIO()
        with mock.patch.object(module.Path, "resolve", side_effect=OSError("C:\\host-secret")):
            with mock.patch("sys.stderr", stderr):
                self.assertEqual(
                    module.main(("--repo-root", "repo", "--evidence-root", "evidence", "--qualification-input", "fixture.json")),
                    2,
                )
        self.assertEqual(stderr.getvalue(), "FEM_MESHING_PREFLIGHT_ERROR=cannot resolve repository root\n")

    def test_rejects_unsafe_missing_duplicate_and_nonregular_inputs_before_writing(self) -> None:
        module = _load_module()
        repo = _repository(self.root)
        _fixture(repo)
        (repo / "input-directory").mkdir()
        cases = (
            (("/absolute.json",), "unsafe qualification input"),
            (("../escape.json",), "unsafe qualification input"),
            (("qualification-fixture.json", "qualification-fixture.json"), "duplicate qualification input"),
            (("missing.json",), "qualification input is missing"),
            (("input-directory",), "qualification input is not a regular file"),
        )
        for index, (inputs, error) in enumerate(cases):
            with self.subTest(inputs=inputs):
                evidence = self.root / f"evidence-{index}"
                with self.assertRaisesRegex(module.PreflightError, error):
                    module.prepare(repo, evidence, inputs)
                self._assert_empty_or_absent(evidence)

    def test_controlled_publication_failure_leaves_no_partial_output(self) -> None:
        module = _load_module()
        repo = _repository(self.root)
        fixture = _fixture(repo)
        evidence = self.root / "evidence"
        original = module._write_exclusive_json
        def fail_scope(path: Path, payload: object, owned: list[object]) -> None:
            if "qualification-scope.v1.json" in path.name:
                raise OSError("controlled publication failure")
            original(path, payload, owned)
        with mock.patch.object(module, "_write_exclusive_json", side_effect=fail_scope):
            with self.assertRaisesRegex(module.PreflightError, "publication failed"):
                module.prepare(repo, evidence, (fixture.name,))
        self._assert_empty_or_absent(evidence)

    def test_non_os_publication_failure_leaves_no_partial_output(self) -> None:
        module = _load_module()
        repo = _repository(self.root)
        fixture = _fixture(repo)
        evidence = self.root / "evidence"
        original = module._write_exclusive_json

        def fail_scope(path: Path, payload: object, owned: list[object]) -> None:
            if "qualification-scope.v1.json" in path.name:
                raise TypeError("serializer host detail")
            original(path, payload, owned)

        with mock.patch.object(module, "_write_exclusive_json", side_effect=fail_scope):
            with self.assertRaisesRegex(module.PreflightError, "publication failed"):
                module.prepare(repo, evidence, (fixture.name,))
        self._assert_empty_or_absent(evidence)

    def test_rollback_preserves_concurrent_foreign_entry(self) -> None:
        module = _load_module()
        evidence = self.root / "evidence"
        original = module._write_exclusive_json

        def create_foreign_then_fail(path: Path, payload: object, owned: list[object]) -> None:
            if "qualification-scope.v1.json" in path.name:
                (evidence / "foreign.txt").write_text("foreign\n", encoding="utf-8")
                raise OSError("controlled publication failure")
            original(path, payload, owned)

        with mock.patch.object(module, "_write_exclusive_json", side_effect=create_foreign_then_fail):
            with self.assertRaisesRegex(module.PreflightError, "publication rollback blocked by concurrent mutation"):
                module._publish(module._validate_evidence_root(self.root / "not-repo", evidence), {"source": "x"}, {"scope": "x"})
        self.assertEqual((evidence / "foreign.txt").read_text(encoding="utf-8"), "foreign\n")

    def test_publication_lease_and_owned_path_races_preserve_foreign_entries(self) -> None:
        module = _load_module()
        evidence = self.root / "evidence"
        evidence.mkdir()
        context = module._validate_evidence_root(self.root / "not-repo", evidence)
        lease = module._acquire_evidence_lease(context)
        try:
            with self.assertRaisesRegex(module.PreflightError, "evidence root is busy"):
                module._acquire_evidence_lease(context)
        finally:
            module._rollback_publication(lease.evidence.canonical, (lease.owned,), False)
        self.assertFalse((evidence / module.EVIDENCE_LEASE_NAME).exists())

        token = "fixed-token"
        staging = evidence / f".{module.SOURCE_SNAPSHOT_NAME}.{token}.staging"
        original = module._write_exclusive_json

        def create_staging_collision(path: Path, payload: object, owned: list[object]) -> None:
            if path == staging:
                staging.write_text("foreign\n", encoding="utf-8")
            original(path, payload, owned)

        with mock.patch.object(module.uuid, "uuid4", return_value=type("Uuid", (), {"hex": token})()):
            with mock.patch.object(module, "_write_exclusive_json", side_effect=create_staging_collision):
                with self.assertRaisesRegex(module.PreflightError, "publication rollback blocked by concurrent mutation"):
                    module._publish(module._validate_evidence_root(self.root / "not-repo", evidence), {"source": "x"}, {"scope": "x"})
        self.assertEqual(staging.read_text(encoding="utf-8"), "foreign\n")

    def test_root_mkdir_race_and_final_collision_preserve_foreign_entries(self) -> None:
        module = _load_module()
        evidence = self.root / "evidence"
        context = module._validate_evidence_root(self.root / "not-repo", evidence)
        original_mkdir = Path.mkdir

        def foreign_mkdir(path: Path, *args: object, **kwargs: object) -> None:
            if path != evidence:
                return original_mkdir(path, *args, **kwargs)
            original_mkdir(path, *args, **kwargs)
            raise FileExistsError("raced")

        with mock.patch.object(module.Path, "mkdir", autospec=True, side_effect=foreign_mkdir):
            with self.assertRaisesRegex(module.PreflightError, "evidence root changed before publication"):
                module._acquire_evidence_lease(context)
        self.assertTrue(evidence.is_dir())
        self.assertEqual(list(evidence.iterdir()), [])

        original_link = module.os.link

        def create_final_then_link(source: object, destination: object) -> None:
            Path(destination).write_text("foreign\n", encoding="utf-8")
            original_link(source, destination)

        with mock.patch.object(module.os, "link", side_effect=create_final_then_link):
            with self.assertRaisesRegex(module.PreflightError, "publication rollback blocked by concurrent mutation"):
                module._publish(
                    module._validate_evidence_root(self.root / "not-repo", evidence),
                    {"source": "x"},
                    {"scope": "x"},
                )
        foreign_final = evidence / module.SOURCE_SNAPSHOT_NAME
        self.assertEqual(foreign_final.read_text(encoding="utf-8"), "foreign\n")
        self.assertFalse((evidence / module.EVIDENCE_LEASE_NAME).exists())
        self.assertEqual(
            sorted(path.name for path in evidence.iterdir()),
            [module.SOURCE_SNAPSHOT_NAME],
        )

    def test_rollback_does_not_delete_replaced_owned_path(self) -> None:
        module = _load_module()
        evidence = self.root / "evidence"
        evidence.mkdir()
        path = evidence / "owned.staging"
        path.write_text("owned\n", encoding="utf-8")
        owned = module._owned_path(path)
        path.unlink()
        path.write_text("foreign\n", encoding="utf-8")
        with self.assertRaisesRegex(module.PreflightError, "publication rollback blocked by concurrent mutation"):
            module._rollback_publication(evidence, (owned,), False)
        self.assertEqual(path.read_text(encoding="utf-8"), "foreign\n")

    def test_transient_and_final_publication_paths_stay_inside_evidence_root(self) -> None:
        module = _load_module()
        repo = _repository(self.root)
        fixture = _fixture(repo)
        _git(repo, "add", fixture.name)
        _git(repo, "commit", "-qm", "add fixture")
        evidence = self.root / "evidence"
        linked: list[Path] = []
        original_link = os.link

        def record_link(source: str | bytes | os.PathLike[str], destination: str | bytes | os.PathLike[str]) -> None:
            linked.extend((Path(source), Path(destination)))
            original_link(source, destination)

        with mock.patch.object(module.os, "link", side_effect=record_link):
            module.prepare(repo, evidence, (fixture.name,))

        self.assertTrue(linked)
        self.assertTrue(all(path.is_relative_to(evidence) for path in linked))
        self.assertEqual({path.name for path in evidence.iterdir()}, {"source-snapshot-before.v1.json", "qualification-scope.v1.json"})

    def test_clean_repository_publishes_exact_phase_zero_artifacts(self) -> None:
        module = _load_module()
        repo = _repository(self.root)
        fixture = _fixture(repo)
        _git(repo, "add", fixture.name)
        _git(repo, "commit", "-qm", "add fixture")
        evidence = self.root / "evidence"
        module.prepare(repo, evidence, (fixture.name,))
        self.assertEqual({path.name for path in evidence.iterdir()}, {"source-snapshot-before.v1.json", "qualification-scope.v1.json"})
        snapshot = json.loads((evidence / "source-snapshot-before.v1.json").read_text(encoding="utf-8"))
        scope = json.loads((evidence / "qualification-scope.v1.json").read_text(encoding="utf-8"))
        self.assertFalse(snapshot["source_snapshot_dirty"])
        self.assertEqual(scope["status"], "prepared")
        self.assertEqual(scope["scenario"], "S13")
        self.assertEqual(scope["geometry"], "box")
        self.assertEqual(scope["airbox"], "bbox")
        self.assertEqual(scope["strategy"], "mixed_p1")
        self.assertEqual(scope["precision"], "double")
        self.assertEqual(scope["lanes"], ["fem_cpu", "fem_gpu_forced"])
        self.assertEqual(scope["source_snapshot"], "source-snapshot-before.v1.json")
        self.assertEqual(scope["qualification_inputs"], [{"path": fixture.name, "mode": "100644", "sha256": hashlib.sha256(fixture.read_bytes()).hexdigest()}])

    def test_dirty_repository_is_explicit_prequalification_never_release_qualified(self) -> None:
        module = _load_module()
        repo = _repository(self.root)
        fixture = _fixture(repo)
        evidence = self.root / "evidence"
        module.prepare(repo, evidence, (fixture.name,))
        snapshot_bytes = (evidence / "source-snapshot-before.v1.json").read_bytes()
        scope_bytes = (evidence / "qualification-scope.v1.json").read_bytes()
        self.assertTrue(json.loads(snapshot_bytes)["source_snapshot_dirty"])
        self.assertEqual(json.loads(scope_bytes)["status"], "prepared")
        self.assertNotIn(b"release-qualified", snapshot_bytes + scope_bytes)

    def test_changed_declared_fixture_changes_bound_source_and_scope_identity(self) -> None:
        module = _load_module()
        repo = _repository(self.root)
        fixture = _fixture(repo)
        first_evidence = self.root / "first"
        second_evidence = self.root / "second"
        module.prepare(repo, first_evidence, (fixture.name,))
        fixture.write_text('{"case":"S13","revision":2}\n', encoding="utf-8")
        module.prepare(repo, second_evidence, (fixture.name,))
        first_snapshot = json.loads((first_evidence / "source-snapshot-before.v1.json").read_text(encoding="utf-8"))
        second_snapshot = json.loads((second_evidence / "source-snapshot-before.v1.json").read_text(encoding="utf-8"))
        first_scope = json.loads((first_evidence / "qualification-scope.v1.json").read_text(encoding="utf-8"))
        second_scope = json.loads((second_evidence / "qualification-scope.v1.json").read_text(encoding="utf-8"))
        self.assertNotEqual(first_snapshot["source_snapshot_sha256"], second_snapshot["source_snapshot_sha256"])
        self.assertNotEqual(first_scope["qualification_scope_sha256"], second_scope["qualification_scope_sha256"])

    def test_artifacts_are_relative_deterministic_and_contained(self) -> None:
        module = _load_module()
        repo = _repository(self.root)
        fixture = _fixture(repo)
        _git(repo, "add", fixture.name)
        _git(repo, "commit", "-qm", "add fixture")
        first = self.root / "first"
        second = self.root / "second"
        before = {path.relative_to(self.root) for path in self.root.rglob("*")}
        module.prepare(repo, first, (fixture.name,))
        module.prepare(repo, second, (fixture.name,))
        for name in ("source-snapshot-before.v1.json", "qualification-scope.v1.json"):
            self.assertEqual((first / name).read_bytes(), (second / name).read_bytes())
        scope = json.loads((first / "qualification-scope.v1.json").read_text(encoding="utf-8"))
        self.assertTrue(all(not Path(value).is_absolute() for value in scope.values() if isinstance(value, str)))
        after = {path.relative_to(self.root) for path in self.root.rglob("*")}
        self.assertEqual(after - before, {
            Path("first"), Path("first/source-snapshot-before.v1.json"), Path("first/qualification-scope.v1.json"),
            Path("second"), Path("second/source-snapshot-before.v1.json"), Path("second/qualification-scope.v1.json"),
        })


if __name__ == "__main__":
    unittest.main()
