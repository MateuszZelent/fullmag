from __future__ import annotations

import ast
import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "packages" / "fullmag-py" / "src"))

from fullmag import OutputStorage
from fullmag.runtime.output_storage_lowering import (
    configure_scene_stage_autosaves,
    configure_study_pipeline_autosaves,
)
from fullmag.runtime.cli import _reserve_stage_sequence_root
from fullmag.runtime.loader import load_problem_from_script
from fullmag.runtime.scene_document import build_scene_document_from_builder
from fullmag.runtime.scene_document_ir import scene_document_to_problem_ir
from fullmag.runtime.script_builder import (
    _render_output_storage,
    export_builder_draft,
    render_scene_document_as_script,
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def check_literal_stage_times() -> None:
    default = OutputStorage()
    literal_stage = {"kind": "run", "until_seconds": "1e-12"}
    configured_literal = configure_scene_stage_autosaves(
        [literal_stage], default.to_ir()
    )[0]
    require(configured_literal["until_seconds"] == "1e-12", "canonical stage time was rewritten")
    require("autosave" not in literal_stage, "autosave mutated the input scene")
    require(
        configured_literal["autosave"]["fields"][0]["every_seconds"] == 1e-12,
        "canonical string time did not supply the storage cadence",
    )
    literal_pipeline = configure_study_pipeline_autosaves(
        {"nodes": [{"node_kind": "stage", "stage_kind": "run", "payload": literal_stage}]},
        default.to_ir(),
    )
    require(
        literal_pipeline["nodes"][0]["payload"]["autosave"] == configured_literal["autosave"],
        "pipeline string time differs from flat stage autosave",
    )
    explicit_cadence = configure_scene_stage_autosaves(
        [{**literal_stage, "output_every_seconds": "2e-13"}], default.to_ir()
    )[0]
    require(
        explicit_cadence["autosave"]["fields"][0]["every_seconds"] == 2e-13,
        "string output cadence did not take precedence over the run duration",
    )
    for invalid_time in (True, "", "0", "-1", "nan", "inf", "1e309", "1e-400", "1 * ps"):
        try:
            configure_scene_stage_autosaves(
                [{"kind": "run", "until_seconds": invalid_time}], default.to_ir()
            )
        except ValueError as error:
            require("positive output cadence" in str(error), "invalid time lost cadence validation")
        else:
            raise AssertionError(f"invalid stage time supplied a cadence: {invalid_time!r}")


def main() -> None:
    check_literal_stage_times()
    python_sources = (
        REPO / "packages/fullmag-py/src/fullmag/model/output_storage.py",
        REPO / "packages/fullmag-py/src/fullmag/runtime/output_storage_lowering.py",
        REPO / "packages/fullmag-py/src/fullmag/runtime/scene_document.py",
        REPO / "packages/fullmag-py/src/fullmag/runtime/scene_document_ir.py",
        REPO / "packages/fullmag-py/src/fullmag/runtime/script_builder.py",
        REPO / "packages/fullmag-py/src/fullmag/runtime/loader.py",
        REPO / "packages/fullmag-py/src/fullmag/runtime/cli.py",
        REPO / "packages/fullmag-py/src/fullmag/runtime/simulation.py",
        REPO / "packages/fullmag-py/src/fullmag/world.py",
    )
    for source in python_sources:
        ast.parse(source.read_text(encoding="utf-8"), filename=str(source))

    default = OutputStorage()
    require(
        default.to_ir()
        == {
            "output_dir": None,
            "temp_dir": None,
            "data_format": "zarr",
            "cleanup": "on_success",
            "existing_output": "timestamp",
        },
        "OutputStorage defaults drifted from the wire contract",
    )
    require(OutputStorage.from_ir({"data_format": "h5"}).data_format == "hdf5", "h5 alias was not normalized")
    require(
        OutputStorage(output_dir="run", temp_dir="scratch").to_ir()
        == OutputStorage.from_ir(
            {
                "output_dir": "run",
                "temp_dir": "scratch",
                "data_format": "zarr",
                "cleanup": "on_success",
                "existing_output": "timestamp",
            }
        ).to_ir(),
        "OutputStorage wire round trip failed",
    )
    try:
        OutputStorage(output_dir="../escape")
    except ValueError:
        pass
    else:
        raise AssertionError("OutputStorage accepted parent traversal")

    empty_stages = configure_scene_stage_autosaves([], default.to_ir())
    empty_pipeline = configure_study_pipeline_autosaves(
        {"version": "study_pipeline.v1", "nodes": []}, default.to_ir()
    )
    require(empty_stages == [], "empty authoring scene gained an executable stage")
    require(empty_pipeline == {"version": "study_pipeline.v1", "nodes": []}, "empty pipeline changed")
    require(_render_output_storage(default.to_ir(), surface="study") == ["study.storage()"], "default policy was not exported")

    with TemporaryDirectory(prefix="fullmag-storage-contract-") as temporary:
        scene_source = Path(temporary) / "empty_study.py"
        scene_source.write_text(
            """import fullmag as fm
study = fm.study('empty-storage-study')
study.engine('fdm')
body = study.geometry(fm.Box(100e-9, 20e-9, 5e-9), name='film')
body.Ms = 800e3
body.Aex = 13e-12
body.m = fm.texture.uniform(1, 0, 0)
study.storage()
""",
            encoding="utf-8",
        )
        loaded = load_problem_from_script(scene_source, lightweight_assets=True)
        scene = build_scene_document_from_builder(export_builder_draft(loaded))
        require(scene["study"]["stages"] == [], "empty SceneDocument gained stages")
        source = render_scene_document_as_script(scene)
        require("study.storage()" in source, "SceneDocument script omitted output storage")
        ir = scene_document_to_problem_ir(
            json.loads(json.dumps(scene)),
            requested_backend="auto",
            requested_device="auto",
            requested_precision="double",
            requested_mode="strict",
            source_root=temporary,
        )
    runtime_metadata = ir["problem_meta"]["runtime_metadata"]
    require(runtime_metadata["output_storage"] == default.to_ir(), "empty scene lost requested storage")
    require(
        "stage_autosave" not in ir["study"]["sampling"],
        "empty SceneDocument synthesized output cadence without a run stage",
    )

    relaxation = configure_scene_stage_autosaves(
        [{"kind": "relaxation"}], default.to_ir()
    )[0]["autosave"]
    require(relaxation["format"] == "zarr", "relaxation autosave format mismatch")
    require(relaxation["fields"][0]["every_steps"] == 100, "relaxation cadence mismatch")

    time_stage = configure_scene_stage_autosaves(
        [
            {
                "kind": "time_evolution",
                "until_seconds": 4.0,
                "sampling": {
                    "outputs": [
                        {
                            "kind": "field",
                            "name": "magnetization",
                            "every_seconds": 0.5,
                        }
                    ]
                },
            }
        ],
        OutputStorage(data_format="h5").to_ir(),
    )[0]["autosave"]
    require(time_stage["format"] == "hdf5", "hdf5 stage format mismatch")
    require(time_stage["fields"][0]["every_seconds"] == 0.5, "authored output cadence changed")

    explicit = {
        "kind": "stage_autosave",
        "target": "saved",
        "layout": "separate",
        "format": "zarr",
        "fields": [{"kind": "field_autosave", "quantity": "m", "every_steps": 7}],
    }
    try:
        configure_scene_stage_autosaves(
            [{"kind": "relaxation", "autosave": explicit}],
            OutputStorage(data_format="hdf5").to_ir(),
        )
    except ValueError as error:
        require("conflicts" in str(error), "format conflict error was not specific")
    else:
        raise AssertionError("explicit autosave format conflict was silently changed")

    with TemporaryDirectory(prefix="fullmag-sequence-contract-") as temporary:
        root = Path(temporary) / "script.zarr"
        first = _reserve_stage_sequence_root(root, existing_output="timestamp")
        sentinel = first / "earlier-results.txt"
        sentinel.write_text("keep earlier data", encoding="utf-8")
        second = _reserve_stage_sequence_root(root, existing_output="timestamp")
        require(second != first and second.suffix == ".zarr", "sequence collision did not create a fresh Zarr root")
        require(sentinel.read_text(encoding="utf-8") == "keep earlier data", "sequence collision changed earlier results")
        try:
            _reserve_stage_sequence_root(root, existing_output="error")
        except FileExistsError:
            pass
        else:
            raise AssertionError("sequence error policy accepted an occupied root")
        try:
            _reserve_stage_sequence_root(root / ".." / "escaped.zarr", existing_output="timestamp")
        except ValueError:
            pass
        else:
            raise AssertionError("sequence output accepted a parent traversal")
        require(not (root.parent / "escaped.zarr").exists(), "invalid sequence path wrote output")

    lease_source = (REPO / "crates/fullmag-runner/src/project_storage.rs").read_text(encoding="utf-8")
    require("fs::create_dir(&output_dir)" in lease_source, "result reservation is not exclusive")
    require("ExistingOutputIR::Error" in lease_source, "error-on-collision policy is missing")
    require("{stem}-{run_id}-{attempt}{suffix}" in lease_source, "timestamp collision naming is missing")
    require("fs::remove_dir_all(&canonical)" in lease_source, "private temporary cleanup is missing")
    require("pub fn finish(&mut self, success: bool)" in lease_source, "explicit lease finalization is missing")
    print("output-storage interpreted contract: ok")


if __name__ == "__main__":
    main()
