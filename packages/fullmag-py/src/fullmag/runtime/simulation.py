from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Sequence

from fullmag._core import run_problem_json
from fullmag.init import save_magnetization
from fullmag.model import BackendTarget, ExecutionMode, ExecutionPrecision, Problem


@dataclass(frozen=True, slots=True)
class StepStats:
    """Stats for a single time step from the runner."""

    step: int
    time: float
    dt: float
    e_ex: float
    e_demag: float
    e_ext: float
    e_total: float
    max_dm_dt: float
    max_h_eff: float
    wall_time_ns: int
    mx: float = 0.0
    my: float = 0.0
    mz: float = 0.0
    e_ani: float = 0.0
    e_dmi: float = 0.0
    max_h_demag: float = 0.0
    max_torque_Apm: float = 0.0
    max_torque_T: float = 0.0
    exchange_wall_time_ns: int = 0
    demag_wall_time_ns: int = 0
    demag_assemble_wall_time_ns: int = 0
    demag_solve_wall_time_ns: int = 0
    demag_solver_setup_wall_time_ns: int = 0
    demag_solver_apply_wall_time_ns: int = 0
    demag_solver_setup_reused: bool = False
    demag_recover_wall_time_ns: int = 0
    demag_energy_wall_time_ns: int = 0
    rhs_wall_time_ns: int = 0
    extra_energy_wall_time_ns: int = 0
    snapshot_wall_time_ns: int = 0
    error_estimate: float | None = None
    dt_suggested: float | None = None
    rejected_attempts: int = 0
    rhs_evals: int = 0
    demag_solves: int = 0
    fsal_reused: bool = False
    poisson_iterations: int = 0
    poisson_final_residual: float = 0.0
    demag_solver: str | None = None
    demag_refreshed: bool = False
    per_object_scalars: dict[str, dict[str, float]] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ScalarQuantityDescriptor:
    quantity_id: str
    label: str
    unit: str
    scalar_key: str
    kind: str = "global_scalar"


@dataclass(frozen=True, slots=True)
class Result:
    status: str
    backend: BackendTarget
    mode: ExecutionMode
    precision: ExecutionPrecision
    notes: Sequence[str] = ()
    steps: Sequence[StepStats] = ()
    final_magnetization: list[list[float]] | None = None
    output_dir: str | None = None

    def save_state(
        self,
        path: str | Path,
        *,
        format: str = "auto",
        dataset: str = "values",
    ) -> Path:
        if self.final_magnetization is None:
            raise ValueError("result does not contain final_magnetization")
        return save_magnetization(
            path,
            self.final_magnetization,
            format=format,
            dataset=dataset,
        )

    def series(self, quantity: str, region: str | int | None = None) -> list[float]:
        canonical = _normalize_scalar_quantity_name(quantity)
        return [_step_scalar(step, canonical, region=region) for step in self.steps]

    def last(self, quantity: str, region: str | int | None = None) -> float:
        if not self.steps:
            raise ValueError("result does not contain any step statistics")
        canonical = _normalize_scalar_quantity_name(quantity)
        return _step_scalar(self.steps[-1], canonical, region=region)

    def scalar_descriptor(self, quantity: str) -> ScalarQuantityDescriptor:
        canonical = _normalize_scalar_quantity_name(quantity)
        return _SCALAR_QUANTITY_DESCRIPTORS[canonical]

    def scalar_descriptors(self) -> tuple[ScalarQuantityDescriptor, ...]:
        return tuple(_SCALAR_QUANTITY_DESCRIPTORS[key] for key in _SCALAR_QUANTITY_ORDER)


@dataclass(slots=True)
class Simulation:
    problem: Problem
    backend: BackendTarget | str | None = None
    mode: ExecutionMode | str | None = None
    precision: ExecutionPrecision | str | None = None

    def __post_init__(self) -> None:
        runtime = self.problem.runtime
        self.backend = runtime.backend_target if self.backend is None else BackendTarget(self.backend)
        self.mode = runtime.execution_mode if self.mode is None else ExecutionMode(self.mode)
        self.precision = (
            runtime.execution_precision
            if self.precision is None
            else ExecutionPrecision(self.precision)
        )
        if self.backend is BackendTarget.HYBRID and self.mode is not ExecutionMode.HYBRID:
            raise ValueError("backend='hybrid' requires mode='hybrid'")
        if self.mode is ExecutionMode.HYBRID and self.backend is not BackendTarget.HYBRID:
            raise ValueError("mode='hybrid' requires backend='hybrid'")

    def to_ir(self, *, script_source: str | None = None, entrypoint_kind: str = "direct") -> dict[str, object]:
        return self.problem.to_ir(
            requested_backend=self.backend,
            execution_mode=self.mode,
            execution_precision=self.precision,
            script_source=script_source,
            entrypoint_kind=entrypoint_kind,
        )

    def plan(self) -> Result:
        return Result(
            status="planned",
            backend=self.backend,
            mode=self.mode,
            precision=self.precision,
            notes=[
                "Public script lowering is still planning-only.",
                "Use Simulation.run(until=...) to execute on the reference FDM engine.",
            ],
        )

    def run(self, *, until: float | None = None, output_dir: str | None = None) -> Result:
        """Run the simulation through the reference engine.

        For Phase 1, the executable FDM subset supports Box + LLG with
        Exchange / Demag / Zeeman combinations on the CPU reference path.
        Everything else returns an honest error message.

        Args:
            until: Simulation stop time in seconds. Required for execution.
            output_dir: Directory for artifact output. Defaults to 'run_output'.
        """
        if until is None:
            return Result(
                status="planned",
                backend=self.backend,
                mode=self.mode,
                precision=self.precision,
                notes=["No stop time provided. Call .run(until=<seconds>) to execute."],
            )

        ir = self.to_ir()

        # Try the native runner
        run_result = run_problem_json(ir, until, output_dir)

        if run_result is None:
            # Native core not available — fall back to planning-only
            return Result(
                status="not-executable",
                backend=self.backend,
                mode=self.mode,
                precision=self.precision,
                notes=[
                    "Native runner (fullmag-py-core) is not installed.",
                    "Install it via 'maturin develop' in crates/fullmag-py-core/ to enable execution.",
                ],
            )

        return result_from_run_payload(
            run_result,
            backend=self.backend,
            mode=self.mode,
            precision=self.precision,
            output_dir=output_dir or "run_output",
        )


def result_from_run_payload(
    run_result: dict[str, Any],
    *,
    backend: BackendTarget,
    mode: ExecutionMode,
    precision: ExecutionPrecision,
    output_dir: str | None,
) -> Result:
    """Convert a native runner payload into a public runtime Result."""
    step_stats = []
    for s in run_result.get("steps", []):
        per_object_raw = s.get("per_object_scalars", s.get("per_object", {}))
        step_stats.append(
            StepStats(
                step=s["step"],
                time=s["time"],
                dt=s["dt"],
                e_ex=s["e_ex"],
                e_demag=s.get("e_demag", 0.0),
                e_ext=s.get("e_ext", 0.0),
                e_total=s.get("e_total", s["e_ex"]),
                max_dm_dt=s["max_dm_dt"],
                max_h_eff=s["max_h_eff"],
                wall_time_ns=s["wall_time_ns"],
                mx=s.get("mx", 0.0),
                my=s.get("my", 0.0),
                mz=s.get("mz", 0.0),
                e_ani=s.get("e_ani", 0.0),
                e_dmi=s.get("e_dmi", 0.0),
                max_h_demag=s.get("max_h_demag", 0.0),
                max_torque_Apm=s.get("max_torque_Apm", 0.0),
                max_torque_T=s.get("max_torque_T", 0.0),
                exchange_wall_time_ns=s.get("exchange_wall_time_ns", 0),
                demag_wall_time_ns=s.get("demag_wall_time_ns", 0),
                demag_assemble_wall_time_ns=s.get("demag_assemble_wall_time_ns", 0),
                demag_solve_wall_time_ns=s.get("demag_solve_wall_time_ns", 0),
                demag_solver_setup_wall_time_ns=s.get("demag_solver_setup_wall_time_ns", 0),
                demag_solver_apply_wall_time_ns=s.get("demag_solver_apply_wall_time_ns", 0),
                demag_solver_setup_reused=s.get("demag_solver_setup_reused", False),
                demag_recover_wall_time_ns=s.get("demag_recover_wall_time_ns", 0),
                demag_energy_wall_time_ns=s.get("demag_energy_wall_time_ns", 0),
                rhs_wall_time_ns=s.get("rhs_wall_time_ns", 0),
                extra_energy_wall_time_ns=s.get("extra_energy_wall_time_ns", 0),
                snapshot_wall_time_ns=s.get("snapshot_wall_time_ns", 0),
                error_estimate=s.get("error_estimate"),
                dt_suggested=s.get("dt_suggested"),
                rejected_attempts=s.get("rejected_attempts", 0),
                rhs_evals=s.get("rhs_evals", 0),
                demag_solves=s.get("demag_solves", 0),
                fsal_reused=s.get("fsal_reused", False),
                poisson_iterations=s.get("poisson_iterations", 0),
                poisson_final_residual=s.get("poisson_final_residual", 0.0),
                demag_solver=s.get("demag_solver"),
                demag_refreshed=s.get("demag_refreshed", False),
                per_object_scalars=_coerce_per_object_scalars(per_object_raw),
            )
        )

    return Result(
        status=run_result.get("status", "completed"),
        backend=backend,
        mode=mode,
        precision=precision,
        steps=step_stats,
        final_magnetization=run_result.get("final_magnetization"),
        output_dir=output_dir,
    )


_SCALAR_QUANTITY_ALIASES: Mapping[str, str] = {
    "e_ex": "e_ex",
    "e_demag": "e_demag",
    "e_ext": "e_ext",
    "e_ani": "e_ani",
    "e_dmi": "e_dmi",
    "e_total": "e_total",
    "mx": "mx",
    "my": "my",
    "mz": "mz",
    "max_dm_dt": "max_dm_dt",
    "max_h_eff": "max_h_eff",
    "max_h_demag": "max_h_demag",
    "max_torque_Apm": "max_torque_Apm",
    "max_torque_T": "max_torque_T",
}

_SCALAR_QUANTITY_DESCRIPTORS: Mapping[str, ScalarQuantityDescriptor] = {
    "e_ex": ScalarQuantityDescriptor("e_ex", "Exchange Energy", "J", "e_ex"),
    "e_demag": ScalarQuantityDescriptor("e_demag", "Demagnetization Energy", "J", "e_demag"),
    "e_ext": ScalarQuantityDescriptor("e_ext", "External Energy", "J", "e_ext"),
    "e_ani": ScalarQuantityDescriptor("e_ani", "Anisotropy Energy", "J", "e_ani"),
    "e_dmi": ScalarQuantityDescriptor("e_dmi", "DMI Energy", "J", "e_dmi"),
    "e_total": ScalarQuantityDescriptor("e_total", "Total Energy", "J", "e_total"),
    "mx": ScalarQuantityDescriptor("m", "m_x avg", "dimensionless", "mx", kind="derived"),
    "my": ScalarQuantityDescriptor("m", "m_y avg", "dimensionless", "my", kind="derived"),
    "mz": ScalarQuantityDescriptor("m", "m_z avg", "dimensionless", "mz", kind="derived"),
    "max_dm_dt": ScalarQuantityDescriptor("dm_dt", "max |dm/dt|", "1/s", "max_dm_dt", kind="derived"),
    "max_h_eff": ScalarQuantityDescriptor("H_eff", "max |H_eff|", "A/m", "max_h_eff", kind="derived"),
    "max_h_demag": ScalarQuantityDescriptor("H_demag", "max |H_demag|", "A/m", "max_h_demag", kind="derived"),
    "max_torque_Apm": ScalarQuantityDescriptor("torque", "max |m×H_eff|", "A/m", "max_torque_Apm", kind="derived"),
    "max_torque_T": ScalarQuantityDescriptor("torque", "max |m×B_eff|", "T", "max_torque_T", kind="derived"),
}

_SCALAR_QUANTITY_ORDER: tuple[str, ...] = (
    "e_ex",
    "e_demag",
    "e_ext",
    "e_ani",
    "e_dmi",
    "e_total",
    "mx",
    "my",
    "mz",
    "max_dm_dt",
    "max_h_eff",
    "max_h_demag",
    "max_torque_Apm",
    "max_torque_T",
)


def _normalize_scalar_quantity_name(quantity: str) -> str:
    key = quantity.strip().lower()
    if key not in _SCALAR_QUANTITY_ALIASES:
        known = ", ".join(_SCALAR_QUANTITY_ORDER)
        raise ValueError(f"unsupported scalar quantity {quantity!r}. Known scalars: {known}")
    return _SCALAR_QUANTITY_ALIASES[key]


def _step_scalar(step: StepStats, quantity: str, *, region: str | int | None = None) -> float:
    if region is None:
        return float(getattr(step, quantity))
    region_key = str(region)
    region_map = step.per_object_scalars.get(region_key)
    if region_map is None:
        available = ", ".join(sorted(step.per_object_scalars))
        hint = f" Available regions: {available}." if available else ""
        raise ValueError(f"region {region!r} is not available in this result.{hint}")
    if quantity not in region_map:
        raise ValueError(f"quantity {quantity!r} is not available for region {region!r}")
    return float(region_map[quantity])


def _coerce_per_object_scalars(raw: object) -> dict[str, dict[str, float]]:
    if not isinstance(raw, Mapping):
        return {}
    normalized: dict[str, dict[str, float]] = {}
    for region, values in raw.items():
        if not isinstance(values, Mapping):
            continue
        region_key = str(region)
        normalized[region_key] = {}
        for quantity, value in values.items():
            try:
                normalized[region_key][str(quantity)] = float(value)
            except (TypeError, ValueError):
                continue
    return normalized
