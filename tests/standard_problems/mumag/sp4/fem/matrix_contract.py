"""Immutable run identities for the staged FEM SP4 mixed-mesh matrix."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from tests.standard_problems.mumag.sp4.common.contract import (
    CONTRACT,
    AirboxVariant,
    LEGACY_ALL_TET_RELAXATION_TORQUE_TOLERANCE_APM,
    LEGACY_ALL_TET_RELAXATION_TORQUE_TOLERANCE_T,
    MeshLevel,
    PRODUCTION_RELAXATION_ALGORITHMS,
    MIXED_P1_RELAXATION_TORQUE_TOLERANCE_APM,
    MIXED_P1_RELAXATION_TORQUE_TOLERANCE_T,
    validate_device,
)


TopologyVariant = Literal["all_tet", "mixed_p1"]
LayerCount = Literal[1, 2, 3]

STAGE1_LAYERS = "stage1-layers"
STAGE2_AIRBOX = "stage2-airbox"
STAGE3_DEVICE = "stage3-device"


def validate_topology_layers(
    topology_variant: str,
    layers: int | None,
) -> None:
    if topology_variant not in {"all_tet", "mixed_p1"}:
        raise ValueError(f"unsupported SP4 topology variant: {topology_variant}")
    if topology_variant == "all_tet":
        if layers is not None:
            raise ValueError("all_tet SP4 topology requires layers=None")
        return
    if isinstance(layers, bool) or layers not in {1, 2, 3}:
        raise ValueError("mixed_p1 SP4 topology requires layers in {1, 2, 3}")


@dataclass(frozen=True)
class SP4MeshVariant:
    topology_variant: TopologyVariant
    layers: LayerCount | None
    mesh: MeshLevel
    airbox: AirboxVariant

    def __post_init__(self) -> None:
        validate_topology_layers(self.topology_variant, self.layers)
        if self.mesh not in CONTRACT.meshes:
            raise ValueError(f"unsupported SP4 mesh: {self.mesh.id}")
        if self.airbox not in CONTRACT.airboxes:
            raise ValueError(f"unsupported SP4 airbox: {self.airbox.id}")

    @property
    def layer_key(self) -> str:
        return "layers-none" if self.layers is None else f"layers-{self.layers}"


@dataclass(frozen=True)
class SP4MatrixRunSpec:
    stage_id: str
    phase: Literal["relax"]
    topology_variant: TopologyVariant
    layers: LayerCount | None
    mesh: MeshLevel
    airbox: AirboxVariant
    device: Literal["cpu", "gpu"]
    relaxation_algorithm: str
    torque_tolerance_t: float | None = None
    torque_tolerance_apm: float | None = None

    def __post_init__(self) -> None:
        if not self.stage_id:
            raise ValueError("SP4 matrix stage_id must not be empty")
        if self.phase != "relax":
            raise ValueError(f"unsupported SP4 matrix phase: {self.phase}")
        SP4MeshVariant(
            self.topology_variant,
            self.layers,
            self.mesh,
            self.airbox,
        )
        validate_device(self.device)
        if self.relaxation_algorithm not in PRODUCTION_RELAXATION_ALGORITHMS:
            raise ValueError(
                "unsupported SP4 relaxation algorithm: "
                f"{self.relaxation_algorithm}"
            )
        expected_t, expected_apm = (
            (
                MIXED_P1_RELAXATION_TORQUE_TOLERANCE_T,
                MIXED_P1_RELAXATION_TORQUE_TOLERANCE_APM,
            )
            if self.topology_variant == "mixed_p1"
            else (
                LEGACY_ALL_TET_RELAXATION_TORQUE_TOLERANCE_T,
                LEGACY_ALL_TET_RELAXATION_TORQUE_TOLERANCE_APM,
            )
        )
        if self.torque_tolerance_t is None:
            object.__setattr__(self, "torque_tolerance_t", expected_t)
        elif self.torque_tolerance_t != expected_t:
            raise ValueError("SP4 torque tolerance in T does not match topology policy")
        if self.torque_tolerance_apm is None:
            object.__setattr__(self, "torque_tolerance_apm", expected_apm)
        elif self.torque_tolerance_apm != expected_apm:
            raise ValueError("SP4 torque tolerance in A/m does not match topology policy")

    @property
    def layer_key(self) -> str:
        return "layers-none" if self.layers is None else f"layers-{self.layers}"

    @property
    def run_id(self) -> str:
        return "__".join(
            (
                self.phase,
                self.topology_variant,
                self.layer_key,
                self.device,
                self.mesh.id,
                self.airbox.id,
                self.relaxation_algorithm,
            )
        )

    @property
    def artifact_path(self) -> Path:
        return Path(
            "relaxations",
            self.topology_variant,
            self.layer_key,
            self.device,
            self.mesh.id,
            self.airbox.id,
            self.relaxation_algorithm,
            "artifacts",
        )


def _relaxation_specs(
    *,
    stage_id: str,
    layers: tuple[LayerCount, ...],
    airbox: AirboxVariant,
    device: Literal["cpu", "gpu"],
) -> tuple[SP4MatrixRunSpec, ...]:
    medium = next(mesh for mesh in CONTRACT.meshes if mesh.id == "medium")
    return tuple(
        SP4MatrixRunSpec(
            stage_id=stage_id,
            phase="relax",
            topology_variant="mixed_p1",
            layers=layer_count,
            mesh=medium,
            airbox=airbox,
            device=device,
            relaxation_algorithm=algorithm,
        )
        for layer_count in layers
        for algorithm in PRODUCTION_RELAXATION_ALGORITHMS
    )


def matrix_specs(stage_id: str) -> tuple[SP4MatrixRunSpec, ...]:
    """Return the deterministic required-run set for one staged matrix gate."""

    baseline = next(
        airbox for airbox in CONTRACT.airboxes if airbox.id == "baseline"
    )
    if stage_id == STAGE1_LAYERS:
        return _relaxation_specs(
            stage_id=STAGE1_LAYERS,
            layers=(1, 2, 3),
            airbox=baseline,
            device="cpu",
        )

    stage1_layer1 = _relaxation_specs(
        stage_id=STAGE1_LAYERS,
        layers=(1,),
        airbox=baseline,
        device="cpu",
    )
    if stage_id == STAGE2_AIRBOX:
        expanded = next(
            airbox for airbox in CONTRACT.airboxes if airbox.id == "expanded"
        )
        return stage1_layer1 + _relaxation_specs(
            stage_id=STAGE2_AIRBOX,
            layers=(1,),
            airbox=expanded,
            device="cpu",
        )
    if stage_id == STAGE3_DEVICE:
        return stage1_layer1 + _relaxation_specs(
            stage_id=STAGE3_DEVICE,
            layers=(1,),
            airbox=baseline,
            device="gpu",
        )
    raise ValueError(f"unsupported SP4 matrix stage: {stage_id}")
