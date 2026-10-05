from __future__ import annotations

import json
from pathlib import Path

import fullmag as fm
import fullmag.world as flat_world
import pytest
from fullmag.runtime.loader import load_problem_from_script


@pytest.fixture(autouse=True)
def _reset_world() -> None:
    fm.reset()
    yield
    fm.reset()


def _resources_ir_from_study_source(tmp_path: Path, body: str) -> dict[str, object]:
    source = tmp_path / "compute_resources_study.py"
    source.write_text(
        "import fullmag as fm\n"
        "study = fm.study('compute-resources-contract')\n"
        + body
        + "\nbody = study.geometry(fm.Box(size=(20e-9, 10e-9, 5e-9)), name='film')\n"
        + "body.Ms = 800e3\n"
        + "body.Aex = 13e-12\n"
        + "body.m = fm.texture.uniform(1, 0, 0)\n",
        encoding="utf-8",
    )
    loaded = load_problem_from_script(source, lightweight_assets=True)
    ir = loaded.problem.to_ir(include_geometry_assets=False)
    metadata = ir["problem_meta"]["runtime_metadata"]
    return metadata["compute_resources"]


def test_compute_resources_default_payload_matches_canonical_wire_shape() -> None:
    assert fm.ComputeResources().to_ir() == {
        "schema_version": "compute_resources.v1",
        "target": {"kind": "local"},
        "cpu": {
            "threads": "auto",
            "affinity": "auto",
            "native_threads": "auto",
            "blas_threads": "auto",
        },
        "ram": {},
        "scratch": {},
        "parallelism": {"kind": "single_process"},
        "placement": "balanced",
    }


def test_study_resources_lowers_full_request_to_problem_ir(tmp_path: Path) -> None:
    fixture = Path(__file__).parent / "fixtures" / "compute_resources.v1.json"
    expected = json.loads(fixture.read_text(encoding="utf-8"))
    actual = _resources_ir_from_study_source(
        tmp_path,
        """study.resources(fm.ComputeResources(
    target=fm.ComputeTarget(kind="pool", id="gpu-pool"),
    cpu=fm.CpuResources(
        threads=8,
        core_policy="physical_first",
        affinity="numa",
        numa_node=0,
        native_threads=4,
        blas_threads=2,
    ),
    gpu=fm.GpuResources(
        selector="allow_list",
        device_uuids=("GPU-1", "GPU-2"),
        devices_per_task=2,
        vram_per_device_bytes=2_147_483_648,
    ),
    ram=fm.MemoryReservation(reservation_bytes=8_589_934_592),
    parallelism=fm.DistributedResources(
        ranks=2, threads_per_rank=8, ranks_per_node=2, gpus_per_rank=1
    ),
    placement="throughput",
))""",
    )

    assert actual == expected


def test_study_resources_preserves_matching_legacy_thread_selection(
    tmp_path: Path,
) -> None:
    source = tmp_path / "compute_resources_legacy_threads.py"
    source.write_text(
        "import fullmag as fm\n"
        "study = fm.study('legacy-thread-compatibility')\n"
        "study.device('cpu')\n"
        "study.threads(4)\n"
        "study.resources(fm.ComputeResources(cpu=fm.CpuResources(threads=4)))\n"
        "body = study.geometry(fm.Box(size=(20e-9, 10e-9, 5e-9)), name='film')\n"
        "body.Ms = 800e3\n"
        "body.Aex = 13e-12\n"
        "body.m = fm.texture.uniform(1, 0, 0)\n",
        encoding="utf-8",
    )
    loaded = load_problem_from_script(source, lightweight_assets=True)
    ir = loaded.problem.to_ir(include_geometry_assets=False)
    metadata = ir["problem_meta"]["runtime_metadata"]

    assert metadata["compute_resources"]["cpu"]["threads"] == 4
    assert metadata["runtime_selection"]["device"] == "cpu"
    assert metadata["runtime_selection"]["cpu_threads"] == 4


@pytest.mark.parametrize(
    ("factory", "message"),
    [
        (lambda: fm.CpuResources(threads=True), "threads must be an integer"),
        (lambda: fm.CpuResources(threads=1.5), "threads must be an integer"),
        (lambda: fm.CpuResources(threads=0), "threads must be positive"),
        (lambda: fm.CpuResources(threads=1 << 32), "threads exceeds"),
        (lambda: fm.CpuResources(threads=4, native_threads=5), "native_threads exceeds"),
        (lambda: fm.CpuResources(threads=4, blas_threads=5), "blas_threads exceeds"),
        (lambda: fm.CpuResources(affinity="numa"), "numa_node is required"),
        (lambda: fm.CpuResources(affinity="compact", numa_node=0), "numa_node is required"),
        (lambda: fm.CpuResources(numa_node=True), "numa_node must be an integer"),
        (lambda: fm.GpuResources(devices_per_task=True), "devices_per_task must be an integer"),
        (lambda: fm.GpuResources(devices_per_task=1.5), "devices_per_task must be an integer"),
        (lambda: fm.GpuResources(device_uuids=("GPU-1", "GPU-1")), "must not contain duplicates"),
        (lambda: fm.GpuResources(device_uuids=(" ",)), "device_uuids entry must be a nonempty identifier"),
        (lambda: fm.GpuResources(device_uuids=("GPU-1",)), "selector conflicts"),
        (lambda: fm.GpuResources(selector="required", device_uuids=("GPU-1", "GPU-2")), "selector conflicts"),
        (lambda: fm.GpuResources(selector="required", device_uuids=("GPU-1",), devices_per_task=2), "selector conflicts"),
        (lambda: fm.GpuResources(selector="allow_list", device_uuids=("GPU-1",), devices_per_task=2), "selector conflicts"),
        (lambda: fm.GpuResources(vram_per_device_bytes=0), "vram_per_device_bytes must be positive"),
        (lambda: fm.MemoryReservation(reservation_bytes=False), "reservation_bytes must be an integer"),
        (lambda: fm.MemoryReservation(reservation_bytes=1 << 64), "reservation_bytes exceeds"),
        (lambda: fm.DistributedResources(ranks=0, threads_per_rank=1, ranks_per_node=1), "ranks must be positive"),
        (lambda: fm.DistributedResources(ranks=2, threads_per_rank=1, ranks_per_node=3), "ranks_per_node must not exceed"),
        (lambda: fm.ComputeTarget(kind="node", id=" "), "target.id must be a nonempty identifier"),
        (lambda: fm.ComputeTarget(kind="pool"), "target.id must be a string"),
        (lambda: fm.ComputeTarget(kind="local", id="node-a"), "only valid for node or pool"),
    ],
)
def test_compute_resources_rejects_invalid_values(factory, message: str) -> None:
    with pytest.raises((TypeError, ValueError), match=message):
        factory()


def test_compute_resources_rejects_distributed_shape_conflicts() -> None:
    with pytest.raises(ValueError, match="threads must equal distributed.threads_per_rank"):
        fm.ComputeResources(
            cpu=fm.CpuResources(threads=4),
            parallelism=fm.DistributedResources(
                ranks=2, threads_per_rank=8, ranks_per_node=2
            ),
        )

    with pytest.raises(ValueError, match="GPU rank budget conflicts"):
        fm.ComputeResources(
            gpu=fm.GpuResources(
                selector="allow_list", device_uuids=("GPU-1",), devices_per_task=1
            ),
            parallelism=fm.DistributedResources(
                ranks=2, threads_per_rank=8, ranks_per_node=2, gpus_per_rank=1
            ),
        )

    with pytest.raises(ValueError, match="multiple GPUs per task requires distributed"):
        fm.ComputeResources(
            gpu=fm.GpuResources(
                selector="allow_list", device_uuids=("GPU-1", "GPU-2"), devices_per_task=2
            )
        )


def test_study_resources_rejects_legacy_thread_conflicts_in_either_order() -> None:
    study = fm.study("thread-conflict")
    study.threads(4)
    with pytest.raises(ValueError, match="execution_intent_conflict.*cpu_threads"):
        study.resources(fm.ComputeResources())

    fm.reset()
    study = fm.study("reverse-thread-conflict")
    study.resources(fm.ComputeResources(cpu=fm.CpuResources(threads=4)))
    with pytest.raises(ValueError, match="execution_intent_conflict.*cpu_threads"):
        study.threads(8)


def test_study_resources_rejects_gpu_cpu_and_ordinal_uuid_conflicts() -> None:
    gpu_request = fm.ComputeResources(gpu=fm.GpuResources())
    study = fm.study("gpu-vs-cpu")
    study.device("cpu")
    with pytest.raises(ValueError, match="GPU resources contradict runtime_selection.device=cpu"):
        study.resources(gpu_request)

    fm.reset()
    study = fm.study("cpu-after-gpu")
    study.resources(gpu_request)
    with pytest.raises(ValueError, match="GPU resources contradict runtime_selection.device=cpu"):
        study.device("cpu")

    fm.reset()
    study = fm.study("uuid-and-ordinal")
    study.device("cuda:0")
    with pytest.raises(ValueError, match="GPU UUID selector and legacy ordinal"):
        study.resources(
            fm.ComputeResources(
                gpu=fm.GpuResources(selector="required", device_uuids=("GPU-1",))
            )
        )


def test_study_resources_rejects_explicit_legacy_gpu_count_mismatch() -> None:
    resources = fm.ComputeResources(
        gpu=fm.GpuResources(
            selector="allow_list", device_uuids=("GPU-1", "GPU-2"), devices_per_task=2
        ),
        parallelism=fm.DistributedResources(
            ranks=2, threads_per_rank=4, ranks_per_node=2, gpus_per_rank=1
        ),
    )
    study = fm.study("legacy-gpu-count")
    study.resources(resources)
    with pytest.raises(ValueError, match="runtime_selection.gpu_count"):
        study.device("gpu")


def test_flat_runtime_mutation_cannot_leave_compute_resource_conflict_unchecked() -> None:
    study = fm.study("flat-thread-conflict")
    study.resources(fm.ComputeResources())
    fm.threads(8)
    with pytest.raises(ValueError, match="execution_intent_conflict.*cpu_threads"):
        flat_world._build_problem()
