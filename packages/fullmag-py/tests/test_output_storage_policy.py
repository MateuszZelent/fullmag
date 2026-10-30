"""Output-storage collision policy checks; no native solver or build is executed."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from threading import Event, current_thread, main_thread
from types import SimpleNamespace
import unittest

import pytest

import fullmag as fm
from fullmag.model.output_storage import OutputStorage
from fullmag.runtime import cli
from fullmag.runtime.cli import build_parser, _reserve_stage_sequence_root


class ExistingOutputPolicyTests(unittest.TestCase):
    def test_model_accepts_every_supported_policy(self):
        for policy in ("timestamp", "error", "overwrite"):
            with self.subTest(policy=policy):
                storage = OutputStorage(existing_output=policy)
                self.assertEqual(storage.to_ir()["existing_output"], policy)
                self.assertEqual(OutputStorage.from_ir(storage.to_ir()), storage)

    def test_model_rejects_unknown_policies(self):
        for policy in ("Overwrite", "replace", "", "overwrite ", None, 1):
            with self.subTest(policy=policy), self.assertRaises(ValueError) as raised:
                OutputStorage(existing_output=policy)  # type: ignore[arg-type]
            self.assertIn("'overwrite'", str(raised.exception))

    def test_study_storage_records_overwrite(self):
        fm.reset()
        self.addCleanup(fm.reset)
        study = fm.study("overwrite_policy")
        study.storage(output_dir="results.zarr", existing_output="overwrite")
        from fullmag.world import _state

        self.assertEqual(
            _state._extra_runtime_metadata["output_storage"]["existing_output"],
            "overwrite",
        )

    def test_python_launcher_accepts_overwrite(self):
        args = build_parser().parse_args(["model.py", "--existing-output", "overwrite"])
        self.assertEqual(args.existing_output, "overwrite")


class SequenceRootOverwriteTests(unittest.TestCase):
    def test_overwrite_replaces_an_inactive_fullmag_result(self):
        with TemporaryDirectory() as directory:
            base = Path(directory) / "results.zarr"
            base.mkdir()
            (base / ".zattrs").write_text(
                json.dumps({"schema_version": "fullmag.project_results.v1"}),
                encoding="utf-8",
            )
            (base / "stale.bin").write_bytes(b"old")

            with _reserve_stage_sequence_root(base, existing_output="overwrite") as root:
                self.assertEqual(root, base.absolute())
                self.assertTrue(root.is_dir())
                self.assertEqual(
                    [path.name for path in root.iterdir()], [".fullmag-active.lock"],
                )
            self.assertEqual(list(base.iterdir()), [])

    def test_overwrite_refuses_a_foreign_directory(self):
        with TemporaryDirectory() as directory:
            base = Path(directory) / "results.zarr"
            base.mkdir()
            (base / "notes.txt").write_text("user data", encoding="utf-8")

            with self.assertRaises(FileExistsError) as raised:
                with _reserve_stage_sequence_root(base, existing_output="overwrite"):
                    self.fail("foreign directory was reserved")

            self.assertIn("refusing to overwrite", str(raised.exception))
            self.assertIn(str(base), str(raised.exception))
            self.assertEqual((base / "notes.txt").read_text(encoding="utf-8"), "user data")

    def test_overwrite_refuses_an_active_result(self):
        with TemporaryDirectory() as directory:
            base = Path(directory) / "results.zarr"
            stage = base / "stage_01_run.zarr"
            stage.mkdir(parents=True)
            (base / ".zattrs").write_text(
                json.dumps({"schema_version": "fullmag.project_results.v1"}),
                encoding="utf-8",
            )
            (stage / ".fullmag-active.lock").write_text("token", encoding="utf-8")

            with self.assertRaises(FileExistsError) as raised:
                with _reserve_stage_sequence_root(base, existing_output="overwrite"):
                    self.fail("active result was reserved")

            self.assertIn("active run reservation", str(raised.exception))
            self.assertTrue((stage / ".fullmag-active.lock").exists())


def _run_sequence(monkeypatch, base, run_stage, *, stage_count=2, existing_output="overwrite"):
    stage = SimpleNamespace(
        problem=SimpleNamespace(study=object()),
        default_until_seconds=1e-12,
        entrypoint_kind="flat_run",
        to_ir=lambda **kwargs: {},
    )
    loaded = SimpleNamespace(
        problem=SimpleNamespace(name="sequence", runtime_metadata={
            "output_storage": OutputStorage(existing_output=existing_output).to_ir(),
        }),
        source_path=base.parent / "model.py",
        script_source="",
        stages=(stage,) * stage_count,
        auto_execute_stages=True,
        study_pipeline_document=lambda: None,
    )
    monkeypatch.setattr(cli, "load_problem_from_script", lambda path: loaded)
    monkeypatch.setattr(cli, "Simulation", lambda *args, **kwargs: SimpleNamespace(
        backend="fdm", mode="strict", precision="double",
    ))
    monkeypatch.setattr(cli, "run_problem_json", run_stage)
    monkeypatch.setattr(cli, "extract_fem_mesh_ir", lambda ir: None)
    monkeypatch.setattr(cli, "result_from_run_payload", lambda *args, **kwargs:
                        SimpleNamespace(status="completed"))
    monkeypatch.setattr(cli, "build_summary", lambda **kwargs: {"status": "completed"})
    return cli.main([str(loaded.source_path), "--output-dir", str(base), "--json"])


def test_two_stage_overwrite_keeps_the_first_result_between_stages(tmp_path, monkeypatch):
    base = tmp_path / "results.zarr"
    first_result = base / "stage_01_flat_run.zarr" / "result.bin"
    stage_count = 0

    def run_stage(ir, until_seconds, output_dir, **kwargs):
        nonlocal stage_count
        stage_count += 1
        if stage_count == 2:
            try:
                cli._remove_inactive_result(base)
            except FileExistsError:
                pass
            assert first_result.read_bytes() == b"first stage"
        output = Path(output_dir)
        output.mkdir()
        (output / "result.bin").write_bytes(b"first stage")
        return {"status": "completed", "steps": []}

    assert _run_sequence(monkeypatch, base, run_stage) == 0
    assert stage_count == 2
    assert first_result.read_bytes() == b"first stage"


def test_sequence_holder_refuses_removal_while_a_stage_runs(tmp_path, monkeypatch):
    base = tmp_path / "results.zarr"

    def run_stage(ir, until_seconds, output_dir, **kwargs):
        with pytest.raises(FileExistsError, match="active run reservation"):
            cli._remove_inactive_result(base)
        Path(output_dir).mkdir()
        return {"status": "completed", "steps": []}

    assert _run_sequence(monkeypatch, base, run_stage) == 0


def test_reserved_sequence_refuses_another_holder(tmp_path):
    base = tmp_path / "results.zarr"
    with _reserve_stage_sequence_root(base, existing_output="overwrite") as root:
        (root / ".zattrs").write_text(
            json.dumps({"schema_version": "fullmag.project_results.v1"}), encoding="utf-8",
        )
        (root / "stage_01.bin").write_bytes(b"first stage")
        with pytest.raises(FileExistsError, match="active run reservation"):
            with _reserve_stage_sequence_root(base, existing_output="overwrite"):
                pytest.fail("another holder reserved the sequence")
        assert (root / "stage_01.bin").read_bytes() == b"first stage"
    assert not (base / ".fullmag-active.lock").exists()


def test_overwrite_check_and_remove_excludes_a_concurrent_process(tmp_path, monkeypatch):
    base = tmp_path / "results.zarr"
    base.mkdir()
    (base / ".zattrs").write_text(
        json.dumps({"schema_version": "fullmag.project_results.v1"}), encoding="utf-8",
    )
    (base / "stale.bin").write_bytes(b"old")
    remove = cli.shutil.rmtree
    attempts = []

    def remove_with_contender(path):
        contender = subprocess.run(
            [sys.executable, "-c", """
import sys
from pathlib import Path
from fullmag.runtime.cli import _reserve_stage_sequence_root
try:
    with _reserve_stage_sequence_root(Path(sys.argv[1]), existing_output="overwrite"):
        pass
except FileExistsError as error:
    print(error)
    sys.exit(17)
""", str(path)],
            capture_output=True, text=True, timeout=10,
        )
        attempts.append(contender)
        assert contender.returncode == 17, contender.stderr
        assert "active run reservation" in contender.stdout
        assert (base / "stale.bin").read_bytes() == b"old"
        remove(path)

    monkeypatch.setattr(cli.shutil, "rmtree", remove_with_contender)
    with _reserve_stage_sequence_root(base, existing_output="overwrite"):
        assert not (base / "stale.bin").exists()
    assert len(attempts) == 1
    assert not cli._result_gate_path(base).exists()


def test_parent_gate_refuses_a_stage_even_after_metadata_is_removed(tmp_path):
    base = tmp_path / "results.zarr"
    base.mkdir()
    with cli._result_reservation_gate(base):
        with pytest.raises(FileExistsError, match="active run reservation"):
            with _reserve_stage_sequence_root(base / "stage.zarr", existing_output="overwrite"):
                pytest.fail("stage entered a result while it was being removed")
    assert not (base / "stage.zarr").exists()


def test_reservation_releases_after_a_stage_error(tmp_path, monkeypatch):
    base = tmp_path / "results.zarr"

    def fail_stage(*args, **kwargs):
        raise RuntimeError("stage failed")

    assert _run_sequence(monkeypatch, base, fail_stage) == 1
    assert not (base / ".fullmag-active.lock").exists()
    with _reserve_stage_sequence_root(base, existing_output="overwrite"):
        pass


def test_single_stage_runner_without_files_writes_manifest(tmp_path, monkeypatch):
    base = tmp_path / "nested" / "results.zarr"

    def run_stage(ir, until_seconds, output_dir, **kwargs):
        assert Path(output_dir) == base
        assert not base.exists()
        return {"status": "completed", "steps": []}

    assert _run_sequence(monkeypatch, base, run_stage, stage_count=1) == 0
    manifest = json.loads((base / "sequence_manifest.json").read_text(encoding="utf-8"))
    assert manifest == {
        "kind": "flat_sequence",
        "stages": [{
            "index": 1,
            "entrypoint_kind": "flat_run",
            "until_seconds": 1e-12,
            "output_dir": str(base),
        }],
    }


def test_single_stage_timestamp_writes_manifest_to_the_resolved_directory(tmp_path, monkeypatch):
    base = tmp_path / "results.zarr"
    base.mkdir()
    (base / "notes.txt").write_text("user data", encoding="utf-8")
    resolved_paths = []

    def run_stage(ir, until_seconds, output_dir, **kwargs):
        assert Path(output_dir) == base
        with _reserve_stage_sequence_root(base, existing_output="timestamp") as resolved:
            resolved_paths.append(resolved)
            return {
                "status": "completed", "steps": [], "output_dir": str(resolved),
                "resolved_output_storage": {"output_dir": str(resolved)},
            }

    assert _run_sequence(
        monkeypatch, base, run_stage, stage_count=1, existing_output="timestamp",
    ) == 0
    assert [path.name for path in base.iterdir()] == ["notes.txt"]
    resolved, = resolved_paths
    manifest = json.loads((resolved / "sequence_manifest.json").read_text(encoding="utf-8"))
    assert manifest["stages"][0]["output_dir"] == str(resolved)


def test_sequence_marker_is_held_through_manifest_publication(tmp_path, monkeypatch):
    base = tmp_path / "results.zarr"
    publish_manifest = cli._write_stage_sequence_manifest

    def write_manifest(root, stages):
        assert (root / ".fullmag-active.lock").is_file()
        with pytest.raises(FileExistsError, match="active run reservation"):
            with _reserve_stage_sequence_root(root, existing_output="overwrite"):
                pytest.fail("sequence was replaced during manifest publication")
        publish_manifest(root, stages)

    monkeypatch.setattr(cli, "_write_stage_sequence_manifest", write_manifest)
    assert _run_sequence(
        monkeypatch, base, lambda *args, **kwargs: {"status": "completed", "steps": []},
    ) == 0
    assert (base / "sequence_manifest.json").is_file()
    assert not (base / ".fullmag-active.lock").exists()


def test_timestamp_selects_a_fresh_path_when_the_target_gate_is_busy(tmp_path):
    base = tmp_path / "results.zarr"
    with cli._result_reservation_gate(base):
        with _reserve_stage_sequence_root(base, existing_output="timestamp") as resolved:
            assert resolved != base
            assert resolved.is_dir()
            assert not base.exists()
        assert cli._result_gate_path(base).is_file()
    assert not cli._result_gate_path(base).exists()


@pytest.mark.parametrize("stage_parent", ["", "stages"])
def test_active_sequence_refuses_completed_stage_overwrite_from_another_process(
    tmp_path, stage_parent,
):
    base = tmp_path / "results.zarr"
    stage = base / stage_parent / "stage_01_run.zarr"

    def contend():
        return subprocess.run(
            [sys.executable, "-c", """
import sys
from pathlib import Path
from fullmag.runtime.cli import _reserve_stage_sequence_root
try:
    with _reserve_stage_sequence_root(Path(sys.argv[1]), existing_output="overwrite"):
        pass
except FileExistsError as error:
    print(error)
    sys.exit(17)
""", str(stage)],
            capture_output=True, text=True, timeout=10,
        )

    with _reserve_stage_sequence_root(base, existing_output="overwrite") as root:
        with _reserve_stage_sequence_root(stage, existing_output="overwrite"):
            (stage / ".zattrs").write_text(
                json.dumps({"schema_version": "fullmag.project_results.v1"}),
                encoding="utf-8",
            )
            (stage / "result.bin").write_bytes(b"first stage")
        assert not (stage / ".fullmag-active.lock").exists()
        assert (root / ".fullmag-active.lock").is_file()

        contender = contend()
        assert contender.returncode == 17, contender.stdout + contender.stderr
        assert "active run reservation" in contender.stdout
        assert (stage / "result.bin").read_bytes() == b"first stage"
        assert (root / ".fullmag-active.lock").is_file()

        with _reserve_stage_sequence_root(
            stage.parent / "stage_02_run.zarr", existing_output="overwrite",
        ):
            assert (stage / "result.bin").read_bytes() == b"first stage"

    contender = contend()
    assert contender.returncode == 0, contender.stdout + contender.stderr
    assert not (stage / "result.bin").exists()


@pytest.mark.parametrize("removal_finishes_first", [False, True])
def test_parent_replacement_cannot_admit_a_child_without_ancestor_exclusion(
    tmp_path, monkeypatch, removal_finishes_first,
):
    root = tmp_path / "results.zarr"
    stage = root / "stage.zarr"
    root.mkdir()
    metadata = json.dumps({"schema_version": "fullmag.project_results.v1"})
    (root / ".zattrs").write_text(metadata, encoding="utf-8")
    start_first, root_removed, metadata_read, first_finished = (Event() for _ in range(4))
    start_second, second_checked, allow_removal, second_finished = (Event() for _ in range(4))
    read_metadata = cli._is_fullmag_result_directory
    remove_tree = cli.shutil.rmtree
    open_path = Path.open
    inspected = False

    def wait(event):
        assert event.wait(10), "parent replacement schedule timed out"

    def inspect_metadata(path):
        nonlocal inspected
        if path == root and current_thread() is main_thread() and not inspected:
            inspected = True
            start_first.set()
            wait(root_removed)
            observed = read_metadata(path)
            assert observed is False
            metadata_read.set()
            wait(first_finished)
            return observed
        return read_metadata(path)

    def remove_result(path, *args, **kwargs):
        if Path(path) == root:
            if not first_finished.is_set():
                remove_tree(path, *args, **kwargs)
                root_removed.set()
                wait(metadata_read)
                return
            second_checked.set()
            wait(allow_removal)
        return remove_tree(path, *args, **kwargs)

    def open_gate(path, *args, **kwargs):
        if path == cli._result_gate_path(stage) and args and args[0] == "x":
            start_second.set()
            wait(second_checked)
            gate = open_path(path, *args, **kwargs)
            if removal_finishes_first:
                allow_removal.set()
                wait(second_finished)
            return gate
        return open_path(path, *args, **kwargs)

    def replace_parent(start, finished):
        wait(start)
        with _reserve_stage_sequence_root(root, existing_output="overwrite"):
            (root / ".zattrs").write_text(metadata, encoding="utf-8")
        finished.set()

    monkeypatch.setattr(cli, "_is_fullmag_result_directory", inspect_metadata)
    monkeypatch.setattr(cli.shutil, "rmtree", remove_result)
    monkeypatch.setattr(Path, "open", open_gate)
    admitted = False
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(replace_parent, start_first, first_finished)
        second = pool.submit(replace_parent, start_second, second_finished)
        try:
            with _reserve_stage_sequence_root(stage, existing_output="overwrite"):
                admitted = True
                (stage / "result.bin").write_bytes(b"live child result")
                allow_removal.set()
                wait(second_finished)
        except (FileExistsError, FileNotFoundError):
            pass
        finally:
            allow_removal.set()
            first.result(timeout=10)
            second.result(timeout=10)
    assert inspected
    assert not admitted, "child lease was exposed without ancestor exclusion"


def test_ancestor_removal_cannot_discard_a_pending_descendant_remover(tmp_path, monkeypatch):
    grand = tmp_path / "grand.zarr"
    parent = grand / "parent.zarr"
    parent.mkdir(parents=True)
    metadata = json.dumps({"schema_version": "fullmag.project_results.v1"})
    for directory in (grand, parent):
        (directory / ".zattrs").write_text(metadata, encoding="utf-8")
    begin_first, grand_removed, metadata_read, first_finished = (Event() for _ in range(4))
    parent_checked, resume_parent = Event(), Event()
    read_metadata = cli._is_fullmag_result_directory
    remove_tree = cli.shutil.rmtree
    inspected = False

    def wait(event):
        assert event.wait(10), "nested remover schedule timed out"

    def inspect_metadata(path):
        nonlocal inspected
        if path == grand and current_thread() is not main_thread() and not inspected:
            inspected = True
            begin_first.set()
            wait(grand_removed)
            observed = read_metadata(path)
            assert observed is False
            metadata_read.set()
            wait(first_finished)
            return observed
        return read_metadata(path)

    def remove_result(path, *args, **kwargs):
        if Path(path) == grand and not first_finished.is_set():
            remove_tree(path, *args, **kwargs)
            grand_removed.set()
            wait(metadata_read)
            return
        if Path(path) == parent and current_thread() is not main_thread():
            parent_checked.set()
            wait(resume_parent)
        return remove_tree(path, *args, **kwargs)

    def replace_parent():
        with _reserve_stage_sequence_root(parent, existing_output="overwrite"):
            (parent / ".zattrs").write_text(metadata, encoding="utf-8")

    monkeypatch.setattr(cli, "_is_fullmag_result_directory", inspect_metadata)
    monkeypatch.setattr(cli.shutil, "rmtree", remove_result)
    with ThreadPoolExecutor(max_workers=1) as pool:
        worker = pool.submit(replace_parent)
        try:
            wait(begin_first)
            with _reserve_stage_sequence_root(grand, existing_output="overwrite"):
                (grand / ".zattrs").write_text(metadata, encoding="utf-8")
                parent.mkdir()
                (parent / ".zattrs").write_text(metadata, encoding="utf-8")
            first_finished.set()
            wait(parent_checked)
            with pytest.raises(FileExistsError, match="active run reservation"):
                with _reserve_stage_sequence_root(grand, existing_output="overwrite"):
                    (grand / ".zattrs").write_text(metadata, encoding="utf-8")
                    parent.mkdir()
                    (parent / ".zattrs").write_text(metadata, encoding="utf-8")
        finally:
            first_finished.set()
            resume_parent.set()
            worker.result(timeout=10)
    with _reserve_stage_sequence_root(parent / "stage.zarr", existing_output="overwrite") as stage:
        (stage / "result.bin").write_bytes(b"live child result")
        assert (stage / "result.bin").read_bytes() == b"live child result"


def test_uncertain_gate_cleanup_retains_the_gate(tmp_path):
    root = tmp_path / "results.zarr"
    root.mkdir()
    stage = root / "stage.zarr"
    with cli._result_reservation_gate(root):
        with pytest.raises(FileExistsError, match="active run reservation"):
            with cli._result_reservation_gate(stage):
                pytest.fail("gate entered without ancestor exclusion")
        assert cli._result_gate_path(stage).is_file()
    assert cli._result_gate_path(stage).is_file()


@pytest.mark.skipif(sys.platform == "win32", reason="Windows cannot replace this open gate file")
def test_gate_cleanup_preserves_a_replaced_gate(tmp_path):
    output = tmp_path / "results.zarr"
    gate = cli._result_gate_path(output)
    with cli._result_reservation_gate(output):
        gate.rename(tmp_path / "original-gate")
        gate.write_text("another owner", encoding="utf-8")
    assert gate.read_text(encoding="utf-8") == "another owner"


if __name__ == "__main__":
    unittest.main()
