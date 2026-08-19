from __future__ import annotations

from dataclasses import dataclass, field
import math
import re
from typing import Mapping, Sequence

from fullmag.model.dynamics import LLG
from fullmag.model.eigen import BiasFieldSweep, ModeTracking, coerce_k_sampling
from fullmag.model.outputs import (
    SaveDispersion,
    SaveEigenDiagnostics,
    SaveField,
    SaveMode,
    SaveResponse,
    SaveScalar,
    SaveSpectrum,
    Snapshot,
)
from fullmag._validation import (
    SamplingPeriod,
    auto_sinc_sampling_policy_ir,
    normalize_sampling_period,
    require_non_empty,
    require_positive,
)

_UNSET = object()

TimeOutputSpec = SaveField | SaveScalar | Snapshot
EigenOutputSpec = SaveSpectrum | SaveMode | SaveDispersion | SaveEigenDiagnostics
FrequencyOutputSpec = EigenOutputSpec | SaveResponse
OutputSpec = TimeOutputSpec | EigenOutputSpec
SUPPORTED_RELAXATION_ALGORITHMS = {
    "llg_overdamped",
    "projected_gradient_bb",
    "nonlinear_cg",
    "tangent_plane_implicit",
}
DEFAULT_RELAXATION_TORQUE_TOLERANCE_T = 1e-6
DEFAULT_RELAXATION_TORQUE_TOLERANCE_APM = (
    DEFAULT_RELAXATION_TORQUE_TOLERANCE_T / (4.0e-7 * math.pi)
)
DEFAULT_RELAXATION_MAX_STEPS = 50_000
DIRECT_MINIMIZER_RELAXATION_ALGORITHMS = {
    "projected_gradient_bb",
    "nonlinear_cg",
    "tangent_plane_implicit",
}
SUPPORTED_EIGEN_OPERATORS = {"linearized_llg", "full_2x2"}
SUPPORTED_EIGEN_TARGETS = {"lowest", "nearest", "frequency_window"}
SUPPORTED_EQUILIBRIUM_SOURCES = {"provided", "relax", "artifact"}
SUPPORTED_EIGEN_NORMALIZATIONS = {"unit_l2", "unit_max_amplitude"}
SUPPORTED_EIGEN_DAMPING_POLICIES = {"ignore", "include"}
SUPPORTED_SPIN_WAVE_BCS = {"free", "pinned", "periodic", "floquet", "surface_anisotropy"}
SUPPORTED_MAGNETOSTATIC_BCS = {"open", "periodic_airbox_k0", "floquet_airbox"}
SUPPORTED_FIELD_SEGMENT_ENDPOINT_POLICIES = {"include_stop", "skip_start", "include_both"}
SUPPORTED_SETTLE_NON_CONVERGENCE_POLICIES = {
    "continue_with_warning",
    "stop_stage",
    "run_next_algorithm",
    "retry_with_smaller_dt",
}
SUPPORTED_SETTLE_APPLIES_TO = {
    "all_points",
    "preparation",
    "saturation_probe",
    "major",
    "major_descending",
    "major_ascending",
    "minor",
    "recoil",
    "key_events",
}
SUPPORTED_SETTLE_APPLIES_TO_OBJECT_KINDS = SUPPORTED_SETTLE_APPLIES_TO | {
    "branch_id",
    "point_selector",
}
SUPPORTED_SETTLE_STOP_CRITERIA = {
    "torque_below",
    "energy_delta_below",
    "max_steps",
    "max_pseudotime_s",
    "max_physical_time_s",
    "m_delta_below",
}
SUPPORTED_SETTLE_STOP_CRITERIA_GROUPS = {"all_of", "any_of"}
SUPPORTED_SATURATION_FAILURE_POLICIES = {
    "continue_with_warning",
    "stop_stage",
}
SUPPORTED_FREQUENCY_RESPONSE_SOLVER_METHODS = {
    "auto",
    "dense_reference",
    "cpu_sparse_direct",
    "full_coupled_field_split",
    "schur_reduced",
    "modal_reduced",
    "gpu_operator_host_krylov",
    "gpu_device_krylov",
}

SUPPORTED_FREQUENCY_RESPONSE_PRECONDITIONERS = {
    "auto",
    "graph_demag_coarse",
    "demag_coarse",
    "block_jacobi",
    "none",
}


@dataclass(frozen=True, slots=True)
class FrequencyResponseSolverPolicy:
    method: str | None = None
    preconditioner: str | None = None
    rtol: float | None = None
    max_iterations: int | None = None
    restart_iterations: int | None = None

    def __post_init__(self) -> None:
        if self.method is not None:
            method = require_non_empty(self.method, "solver_method")
            if method not in SUPPORTED_FREQUENCY_RESPONSE_SOLVER_METHODS:
                supported = ", ".join(sorted(SUPPORTED_FREQUENCY_RESPONSE_SOLVER_METHODS))
                raise ValueError(f"solver_method must be one of: {supported}")
            object.__setattr__(self, "method", method)
        if self.preconditioner is not None:
            preconditioner = require_non_empty(
                self.preconditioner,
                "solver_preconditioner",
            )
            if preconditioner not in SUPPORTED_FREQUENCY_RESPONSE_PRECONDITIONERS:
                supported = ", ".join(
                    sorted(SUPPORTED_FREQUENCY_RESPONSE_PRECONDITIONERS)
                )
                raise ValueError(f"solver_preconditioner must be one of: {supported}")
            object.__setattr__(self, "preconditioner", preconditioner)
        if self.rtol is not None:
            rtol = float(self.rtol)
            if not math.isfinite(rtol) or rtol <= 0.0:
                raise ValueError("solver_rtol must be finite and positive")
            object.__setattr__(self, "rtol", rtol)
        if self.max_iterations is not None:
            object.__setattr__(
                self,
                "max_iterations",
                _positive_int(self.max_iterations, "solver_max_iterations"),
            )
        if self.restart_iterations is not None:
            restart_iterations = _positive_int(
                self.restart_iterations,
                "solver_restart_iterations",
            )
            if self.max_iterations is not None and restart_iterations > self.max_iterations:
                raise ValueError(
                    "solver_restart_iterations must be <= solver_max_iterations"
                )
            object.__setattr__(self, "restart_iterations", restart_iterations)

    def to_ir(self) -> dict[str, object]:
        policy: dict[str, object] = {}
        if self.method is not None:
            policy["method"] = self.method
        if self.preconditioner is not None:
            policy["preconditioner"] = self.preconditioner
        if self.rtol is not None:
            policy["rtol"] = self.rtol
        if self.max_iterations is not None:
            policy["max_iterations"] = self.max_iterations
        if self.restart_iterations is not None:
            policy["restart_iterations"] = self.restart_iterations
        return policy


def _positive_int(value: object, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{field_name} must be an integer")
    if value <= 0:
        raise ValueError(f"{field_name} must be positive")
    return value
SUPPORTED_FIELD_ORIENTATION_PRESETS = {
    "oop_positive",
    "oop_negative",
    "in_plane_x",
    "in_plane_y",
}
SUPPORTED_HYSTERESIS_MEASUREMENT_AXES = {
    "field_axis",
    "sample_normal",
    "easy_axis",
}
SUPPORTED_HYSTERESIS_INITIAL_PROTOCOLS = {
    "as_authored",
    "zero_field_relaxed",
    "positive_saturation",
    "negative_saturation",
    "checkpoint",
}
SUPPORTED_HYSTERESIS_BRANCH_MODES = {
    "major_loop",
    "major_with_minor_loops",
    "virgin_curve",
    "virgin_then_major_loop",
}
SUPPORTED_HYSTERESIS_MINOR_LOOP_CONTINUATION_POLICIES = {
    "branch_only",
    "replace_parent",
    "resume_parent",
}
SUPPORTED_HYSTERESIS_STORAGE_MAGNETIZATION = {
    "none",
    "selected",
    "every_n",
    "every_step",
    "key_events",
}
MU0_H_PER_M = 1.2566370614359172e-6
DEFAULT_HYSTERESIS_FIELD_UNIT_PROVENANCE = {
    "authored_quantity": "mu0_h",
    "authored_unit": "mT",
    "canonical_quantity": "h_ext",
    "canonical_unit": "A/m",
    "display_unit": "mT",
    "mu0_h_per_m": MU0_H_PER_M,
}
DEFAULT_TABLE_AUTOSAVE_QUANTITIES = (
    "step",
    "t",
    "mx",
    "my",
    "mz",
    "e_total",
    "max_torque",
)
SUPPORTED_TABLE_AUTOSAVE_QUANTITIES = frozenset(
    (
        "step",
        "t",
        "time",
        "dt",
        "solver_dt",
        "mx",
        "my",
        "mz",
        "e_ex",
        "e_demag",
        "e_ext",
        "e_drive",
        "e_ani",
        "e_dmi",
        "e_total",
        "max_dm_dt",
        "max_h_eff",
        "max_h_demag",
        "max_torque",
        "max_torque_Apm",
        "max_torque_T",
    )
)
TABLE_AUTOSAVE_QUANTITY_ALIASES = {
    "time": "t",
    "solver_dt": "dt",
    "E_total": "e_total",
    "E_drive": "e_drive",
    "max_torque_Apm": "max_torque",
}

SUPPORTED_AUTOSAVE_LAYOUTS = {"continuous", "separate"}
SUPPORTED_AUTOSAVE_FORMATS = {"zarr", "hdf5", "txt"}
_AUTOSAVE_TARGET_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


@dataclass(frozen=True, slots=True)
class TableAutosave:
    t_sampl: SamplingPeriod | None = None
    every_steps: int | None = None
    quantities: Sequence[str] | None = None
    extra_quantities: Sequence[str] = ()
    expressions: Sequence[str] = ()
    table_id: str = "default"

    def __post_init__(self) -> None:
        has_time_cadence = self.t_sampl is not None
        has_step_cadence = self.every_steps is not None
        if has_time_cadence == has_step_cadence:
            raise ValueError("exactly one of t_sampl or every_steps must be specified")
        if has_time_cadence:
            object.__setattr__(
                self,
                "t_sampl",
                normalize_sampling_period(self.t_sampl, "t_sampl"),
            )
        else:
            every_steps = self.every_steps
            if isinstance(every_steps, bool) or not isinstance(every_steps, int) or every_steps <= 0:
                raise ValueError("every_steps must be a positive integer")
        table_id = require_non_empty(self.table_id, "table_id")
        base_quantities = (
            DEFAULT_TABLE_AUTOSAVE_QUANTITIES
            if self.quantities is None
            else tuple(_require_supported_table_quantity(quantity) for quantity in self.quantities)
        )
        if not base_quantities:
            raise ValueError("quantities must not be empty")
        normalized_extra = tuple(
            _require_supported_table_quantity(quantity) for quantity in self.extra_quantities
        )
        expressions = tuple(
            _normalize_table_expression(expression) for expression in self.expressions
        )
        normalized_quantities = tuple(dict.fromkeys((*base_quantities, *normalized_extra)))
        object.__setattr__(self, "table_id", table_id)
        object.__setattr__(self, "quantities", normalized_quantities)
        object.__setattr__(self, "extra_quantities", normalized_extra)
        object.__setattr__(self, "expressions", expressions)

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "kind": "table_autosave",
            "table_id": self.table_id,
            "quantities": list(self.quantities or DEFAULT_TABLE_AUTOSAVE_QUANTITIES),
        }
        if self.expressions:
            payload["expressions"] = list(self.expressions)
        if self.every_steps is not None:
            payload["every_steps"] = self.every_steps
        elif self.t_sampl == "auto":
            payload["sample_period_policy"] = auto_sinc_sampling_policy_ir()
        else:
            payload["sample_period_s"] = self.t_sampl
        return payload

    def add_expression(self, expression: object) -> "TableAutosave":
        normalized = _normalize_table_expression(expression)
        if normalized in self.expressions:
            return self
        return TableAutosave(
            t_sampl=self.t_sampl,
            every_steps=self.every_steps,
            quantities=self.quantities,
            expressions=(*self.expressions, normalized),
            table_id=self.table_id,
        )


@dataclass(frozen=True, slots=True)
class FieldAutosave:
    quantity: str
    every: SamplingPeriod | None = None
    every_steps: int | None = None

    def __post_init__(self) -> None:
        quantity = require_non_empty(self.quantity, "quantity")
        SaveField(quantity, every=1.0)
        has_time_cadence = self.every is not None
        has_step_cadence = self.every_steps is not None
        if has_time_cadence == has_step_cadence:
            raise ValueError("exactly one of every or every_steps must be specified")
        if has_time_cadence:
            object.__setattr__(
                self,
                "every",
                normalize_sampling_period(self.every, "every"),
            )
        else:
            every_steps = self.every_steps
            if (
                isinstance(every_steps, bool)
                or not isinstance(every_steps, int)
                or every_steps <= 0
            ):
                raise ValueError("every_steps must be a positive integer")
        object.__setattr__(self, "quantity", quantity)

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "kind": "field_autosave",
            "quantity": self.quantity,
        }
        if self.every_steps is not None:
            payload["every_steps"] = self.every_steps
        elif self.every == "auto":
            payload["sample_period_policy"] = auto_sinc_sampling_policy_ir()
        else:
            payload["every_seconds"] = self.every
        return payload


@dataclass(frozen=True, slots=True)
class StageAutosave:
    target: str = "main"
    layout: str = "continuous"
    format: str = "zarr"
    table: TableAutosave | None = None
    fields: Sequence[FieldAutosave] = ()

    def __post_init__(self) -> None:
        target = require_non_empty(self.target, "target")
        if _AUTOSAVE_TARGET_PATTERN.fullmatch(target) is None:
            raise ValueError(
                "target must start with an alphanumeric character and contain only "
                "letters, digits, '.', '_', or '-'"
            )
        if self.layout not in SUPPORTED_AUTOSAVE_LAYOUTS:
            supported = ", ".join(sorted(SUPPORTED_AUTOSAVE_LAYOUTS))
            raise ValueError(f"layout must be one of: {supported}")
        if self.format not in SUPPORTED_AUTOSAVE_FORMATS:
            supported = ", ".join(sorted(SUPPORTED_AUTOSAVE_FORMATS))
            raise ValueError(f"format must be one of: {supported}")
        if self.table is not None and not isinstance(self.table, TableAutosave):
            raise TypeError("table must be TableAutosave or None")
        fields = tuple(self.fields)
        if any(not isinstance(field, FieldAutosave) for field in fields):
            raise TypeError("fields must contain only FieldAutosave values")
        seen: set[str] = set()
        for field_policy in fields:
            if field_policy.quantity in seen:
                raise ValueError(
                    f"duplicate field autosave quantity {field_policy.quantity!r}"
                )
            seen.add(field_policy.quantity)
        if self.table is None and not fields:
            raise ValueError("stage autosave requires at least one table or field policy")
        if self.format == "txt" and fields:
            raise ValueError("txt supports scalar tables only")
        object.__setattr__(self, "target", target)
        object.__setattr__(self, "fields", fields)

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "stage_autosave",
            "target": self.target,
            "layout": self.layout,
            "format": self.format,
            "table": self.table.to_ir() if self.table is not None else None,
            "fields": [field_policy.to_ir() for field_policy in self.fields],
        }


@dataclass(frozen=True, slots=True)
class GammaResponseAnalysis:
    response_component: str = "my"
    weighting: str = "Ms_times_lumped_volume"
    detrend: str = "linear"
    window: str = "hann"
    susceptibility_floor_fraction: float = 1e-6

    def __post_init__(self) -> None:
        if self.response_component not in {"my", "mz"}:
            raise ValueError("response_component must be 'my' or 'mz'")
        if self.weighting != "Ms_times_lumped_volume":
            raise ValueError("weighting must be 'Ms_times_lumped_volume'")
        if self.detrend not in {"none", "mean", "linear"}:
            raise ValueError("detrend must be 'none', 'mean', or 'linear'")
        if self.window != "hann":
            raise ValueError("window must be 'hann'")
        floor = float(self.susceptibility_floor_fraction)
        if not math.isfinite(floor) or not 0.0 <= floor < 1.0:
            raise ValueError("susceptibility_floor_fraction must be finite in [0, 1)")
        object.__setattr__(self, "susceptibility_floor_fraction", floor)

    def to_runtime_metadata(self) -> dict[str, object]:
        return {
            "schema_version": "spin_wave_response.request.v1",
            "analysis": "gamma",
            "response_component": self.response_component,
            "weighting": self.weighting,
            "detrend": self.detrend,
            "window": self.window,
            "susceptibility_floor_fraction": self.susceptibility_floor_fraction,
        }


def _require_supported_table_quantity(quantity: str) -> str:
    normalized = require_non_empty(quantity, "quantity")
    normalized = TABLE_AUTOSAVE_QUANTITY_ALIASES.get(normalized, normalized)
    if normalized not in SUPPORTED_TABLE_AUTOSAVE_QUANTITIES:
        raise ValueError(f"unsupported table_autosave quantity '{normalized}'")
    return normalized


def _normalize_table_expression(expression: object) -> str:
    if isinstance(expression, str):
        normalized = expression.strip()
    else:
        normalized = getattr(expression, "table_expression", None)
        if not isinstance(normalized, str):
            raise TypeError(
                "tableadd() expects a quantity string or a quantity handle with "
                "a table_expression"
            )
        normalized = normalized.strip()
    if not normalized:
        raise ValueError("table expression must not be empty")
    if any(character.isspace() for character in normalized):
        raise ValueError("table expression must not contain whitespace")
    return normalized


def _require_supported_eigen_options(
    *,
    damping_policy: str,
    equilibrium_artifact: str | None,
    equilibrium_source: str,
    normalization: str,
    operator: str,
) -> str | None:
    if operator not in SUPPORTED_EIGEN_OPERATORS:
        supported = ", ".join(sorted(SUPPORTED_EIGEN_OPERATORS))
        raise ValueError(f"operator must be one of: {supported}")
    if equilibrium_source not in SUPPORTED_EQUILIBRIUM_SOURCES:
        supported = ", ".join(sorted(SUPPORTED_EQUILIBRIUM_SOURCES))
        raise ValueError(f"equilibrium_source must be one of: {supported}")
    normalized_equilibrium_artifact = equilibrium_artifact
    if equilibrium_source == "artifact":
        if equilibrium_artifact is None:
            raise ValueError("equilibrium_artifact is required when equilibrium_source='artifact'")
        normalized_equilibrium_artifact = require_non_empty(
            equilibrium_artifact,
            "equilibrium_artifact",
        )
    elif equilibrium_artifact is not None:
        normalized_equilibrium_artifact = require_non_empty(
            equilibrium_artifact,
            "equilibrium_artifact",
        )
    if normalization not in SUPPORTED_EIGEN_NORMALIZATIONS:
        supported = ", ".join(sorted(SUPPORTED_EIGEN_NORMALIZATIONS))
        raise ValueError(f"normalization must be one of: {supported}")
    if damping_policy not in SUPPORTED_EIGEN_DAMPING_POLICIES:
        supported = ", ".join(sorted(SUPPORTED_EIGEN_DAMPING_POLICIES))
        raise ValueError(f"damping_policy must be one of: {supported}")
    return normalized_equilibrium_artifact


def _normalize_finite_vec3(
    value: Sequence[float],
    field_name: str,
) -> tuple[float, float, float]:
    if len(value) != 3:
        raise ValueError(f"{field_name} must contain exactly 3 values")
    normalized = (float(value[0]), float(value[1]), float(value[2]))
    if not all(math.isfinite(component) for component in normalized):
        raise ValueError(f"{field_name} must contain finite values")
    return normalized


@dataclass(frozen=True, slots=True)
class PeriodicBC:
    pair_ids: Sequence[str]

    def __post_init__(self) -> None:
        normalized = tuple(require_non_empty(pair_id, "pair_id") for pair_id in self.pair_ids)
        if not normalized:
            raise ValueError("PeriodicBC requires at least one pair_id")
        object.__setattr__(self, "pair_ids", normalized)

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "periodic",
            "pair_ids": list(self.pair_ids),
        }


@dataclass(frozen=True, slots=True)
class FloquetBC:
    pair_ids: Sequence[str]
    phase_convention: str = "exp_minus_i_k_dot_delta_r"

    def __post_init__(self) -> None:
        normalized = tuple(require_non_empty(pair_id, "pair_id") for pair_id in self.pair_ids)
        if not normalized:
            raise ValueError("FloquetBC requires at least one pair_id")
        object.__setattr__(self, "pair_ids", normalized)
        object.__setattr__(
            self,
            "phase_convention",
            require_non_empty(self.phase_convention, "phase_convention"),
        )

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "floquet",
            "pair_ids": list(self.pair_ids),
            "phase_convention": self.phase_convention,
        }


SpinWaveBoundarySpec = str | dict[str, object] | PeriodicBC | FloquetBC


def _spin_wave_bc_kind(value: SpinWaveBoundarySpec) -> str:
    serialized = _serialize_spin_wave_bc(value)
    return serialized if isinstance(serialized, str) else str(serialized["kind"])


def _serialize_spin_wave_bc(value: SpinWaveBoundarySpec) -> str | dict[str, object]:
    if hasattr(value, "to_ir"):
        serialized = value.to_ir()
    else:
        serialized = value
    if isinstance(serialized, str):
        if serialized not in SUPPORTED_SPIN_WAVE_BCS:
            supported = ", ".join(sorted(SUPPORTED_SPIN_WAVE_BCS))
            raise ValueError(f"spin_wave_bc must be one of: {supported}")
        return serialized
    if isinstance(serialized, dict):
        kind = serialized.get("kind")
        if kind not in SUPPORTED_SPIN_WAVE_BCS:
            supported = ", ".join(sorted(SUPPORTED_SPIN_WAVE_BCS))
            raise ValueError(f"spin_wave_bc.kind must be one of: {supported}")
        return serialized
    raise ValueError("spin_wave_bc must be a string, mapping, PeriodicBC, or FloquetBC")


@dataclass(frozen=True, slots=True)
class TimeEvolution:
    dynamics: LLG
    outputs: Sequence[TimeOutputSpec]
    _table_autosave: TableAutosave | None = field(default=None, repr=False)

    def __init__(
        self,
        dynamics: LLG,
        outputs: Sequence[TimeOutputSpec],
        table_autosave: TableAutosave | None = None,
    ) -> None:
        object.__setattr__(self, "dynamics", dynamics)
        object.__setattr__(self, "outputs", outputs)
        object.__setattr__(self, "_table_autosave", table_autosave)
        self.__post_init__()

    def __post_init__(self) -> None:
        # An empty output list is a valid unsampled integration interval. The
        # final solver state remains available for continuation/checkpointing.
        pass

    def to_ir(self) -> dict[str, object]:
        sampling: dict[str, object] = {
            "outputs": [output.to_ir() for output in self.outputs],
        }
        if self._table_autosave is not None:
            sampling["table_autosave"] = self._table_autosave.to_ir()
        return {
            "kind": "time_evolution",
            "dynamics": self.dynamics.to_ir(),
            "sampling": sampling,
        }

    def table_autosave(
        self,
        *,
        t_sampl: SamplingPeriod,
        quantities: Sequence[str] | None = None,
        extra_quantities: Sequence[str] = (),
        table_id: str = "default",
    ) -> "TimeEvolution":
        return TimeEvolution(
            dynamics=self.dynamics,
            outputs=self.outputs,
            table_autosave=TableAutosave(
                t_sampl=t_sampl,
                quantities=quantities,
                extra_quantities=extra_quantities,
                table_id=table_id,
            ),
        )

    def tableadd(self, expression: object) -> "TimeEvolution":
        if self._table_autosave is None:
            raise ValueError("tableadd() requires table_autosave() to be configured first")
        return TimeEvolution(
            dynamics=self.dynamics,
            outputs=self.outputs,
            table_autosave=self._table_autosave.add_expression(expression),
        )

    table_add = tableadd


@dataclass(frozen=True, slots=True, init=False)
class RelaxStop:
    torque_tolerance_apm: float | None = DEFAULT_RELAXATION_TORQUE_TOLERANCE_APM
    energy_tolerance_j: float | None = None
    max_steps: int | None = DEFAULT_RELAXATION_MAX_STEPS
    max_relaxation_time_s: float | None = None

    def __init__(
        self,
        torque_tolerance_apm: float | None = DEFAULT_RELAXATION_TORQUE_TOLERANCE_APM,
        energy_tolerance_j: float | None = None,
        max_steps: int | None = DEFAULT_RELAXATION_MAX_STEPS,
        max_relaxation_time_s: object = _UNSET,
        *,
        max_pseudotime_s: object = _UNSET,
        max_physical_time_s: object = _UNSET,
    ) -> None:
        time_values = [
            ("max_relaxation_time_s", max_relaxation_time_s),
            ("max_pseudotime_s", max_pseudotime_s),
            ("max_physical_time_s", max_physical_time_s),
        ]
        supplied = [(name, value) for name, value in time_values if value is not _UNSET]
        if supplied:
            resolved_time = None if supplied[0][1] is None else float(supplied[0][1])
            for name, value in supplied[1:]:
                candidate = None if value is None else float(value)
                if candidate != resolved_time:
                    raise ValueError(
                        f"{name} conflicts with {supplied[0][0]}"
                    )
        else:
            resolved_time = None

        object.__setattr__(self, "torque_tolerance_apm", torque_tolerance_apm)
        object.__setattr__(self, "energy_tolerance_j", energy_tolerance_j)
        object.__setattr__(self, "max_steps", max_steps)
        object.__setattr__(self, "max_relaxation_time_s", resolved_time)
        self.__post_init__()

    def __post_init__(self) -> None:
        if self.torque_tolerance_apm is not None:
            require_positive(self.torque_tolerance_apm, "torque_tolerance_apm")
        if self.energy_tolerance_j is not None:
            require_positive(self.energy_tolerance_j, "energy_tolerance_j")
        if self.max_steps is not None:
            object.__setattr__(self, "max_steps", _positive_int(self.max_steps, "max_steps"))
        if self.max_relaxation_time_s is not None:
            require_positive(self.max_relaxation_time_s, "max_relaxation_time_s")
        if (
            self.torque_tolerance_apm is None
            and self.energy_tolerance_j is None
            and self.max_steps is None
            and self.max_relaxation_time_s is None
        ):
            raise ValueError("RelaxStop requires at least one stop criterion")

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {}
        if self.torque_tolerance_apm is not None:
            payload["torque_tolerance_apm"] = self.torque_tolerance_apm
        if self.energy_tolerance_j is not None:
            payload["energy_tolerance_j"] = self.energy_tolerance_j
        if self.max_steps is not None:
            payload["max_steps"] = self.max_steps
        if self.max_relaxation_time_s is not None:
            payload["max_relaxation_time_s"] = self.max_relaxation_time_s
        return payload


@dataclass(frozen=True, slots=True)
class Relaxation:
    """Energy minimization study that drives the system toward a (meta)stable
    equilibrium satisfying m × H_eff ≈ 0 under the constraint |m| = 1.

    Three algorithms are implemented (see ``docs/physics/0500-fdm-relaxation-algorithms.md``):

    * ``"llg_overdamped"`` — damping-only Landau–Lifshitz–Gilbert relaxation.
      Reuses the LLG pipeline but disables precession during relax(), matching
      the expected mumax-style semantics. Convergence speed still depends on
      damping and time step, but a large ``alpha`` is not required just to
      suppress orbiting.

    * ``"projected_gradient_bb"`` — projected steepest descent with
      Barzilai–Borwein step selection on the sphere product manifold.  Uses
      alternating BB1/BB2 step sizes with Armijo backtracking line search.
      Typically faster than overdamped LLG for smooth energy landscapes.

    * ``"nonlinear_cg"`` — nonlinear conjugate gradient (Polak–Ribière+) with
      tangent-space vector transport, periodic restarts every 50 iterations,
      and Armijo backtracking.  Generally the fastest for large-scale problems.

    * ``"tangent_plane_implicit"`` — FEM-only linearly implicit tangent-plane
      relaxation.  Not yet executable; reserved for future FEM production use.

    Parameters
    ----------
    outputs : Sequence[OutputSpec]
        Optional output specifications (fields and/or scalars) to record.
        An empty sequence performs relaxation without periodic output.
    algorithm : str, default ``"llg_overdamped"``
        Relaxation algorithm identifier.  Must be one of the strings listed
        above.
    stop : RelaxStop, optional
        Canonical stop contract for relaxation. Legacy scalar arguments
        (``torque_tolerance``, ``energy_tolerance``, ``max_steps``) remain
        supported as compatibility aliases and lower into ``RelaxStop``.
    dynamics : LLG, optional
        LLG parameters used only by ``"llg_overdamped"``. When omitted for
        that algorithm, canonical ``LLG(integrator="auto")`` dynamics are
        supplied. Direct minimizers reject this field.
    """

    outputs: Sequence[TimeOutputSpec]
    algorithm: str = "llg_overdamped"
    stop: RelaxStop = field(default_factory=RelaxStop)
    dynamics: LLG | None = None
    _table_autosave: TableAutosave | None = field(default=None, repr=False)
    torque_tolerance: float | None = field(init=False)
    torque_tolerance_unit: str = field(init=False)
    energy_tolerance: float | None = field(init=False)
    max_steps: int | None = field(init=False)

    def __init__(
        self,
        outputs: Sequence[TimeOutputSpec],
        algorithm: str = "llg_overdamped",
        stop: RelaxStop | None = None,
        torque_tolerance: object = _UNSET,
        energy_tolerance: object = _UNSET,
        max_steps: object = _UNSET,
        max_relaxation_time_s: object = _UNSET,
        max_pseudotime_s: object = _UNSET,
        max_physical_time_s: object = _UNSET,
        dynamics: LLG | None = None,
        table_autosave: TableAutosave | None = None,
        torque_tolerance_unit: str = "T",
    ) -> None:
        object.__setattr__(self, "outputs", outputs)
        object.__setattr__(self, "algorithm", algorithm)
        object.__setattr__(
            self,
            "stop",
            _resolve_relax_stop(
                stop=stop,
                torque_tolerance=torque_tolerance,
                energy_tolerance=energy_tolerance,
                max_steps=max_steps,
                max_relaxation_time_s=max_relaxation_time_s,
                max_pseudotime_s=max_pseudotime_s,
                max_physical_time_s=max_physical_time_s,
            ),
        )
        object.__setattr__(self, "dynamics", dynamics)
        object.__setattr__(self, "_table_autosave", table_autosave)
        object.__setattr__(self, "torque_tolerance", self.stop.torque_tolerance_apm)
        if torque_tolerance_unit not in {"T", "A/m"}:
            raise ValueError("torque_tolerance_unit must be 'T' or 'A/m'")
        object.__setattr__(self, "torque_tolerance_unit", torque_tolerance_unit)
        object.__setattr__(self, "energy_tolerance", self.stop.energy_tolerance_j)
        object.__setattr__(self, "max_steps", self.stop.max_steps)
        self.__post_init__()

    def __post_init__(self) -> None:
        if self.algorithm not in SUPPORTED_RELAXATION_ALGORITHMS:
            supported = ", ".join(sorted(SUPPORTED_RELAXATION_ALGORITHMS))
            raise ValueError(f"algorithm must be one of: {supported}")
        is_llg = self.algorithm == "llg_overdamped"
        if is_llg and self.dynamics is None:
            object.__setattr__(self, "dynamics", LLG(integrator="auto"))
        if not is_llg and self.dynamics is not None:
            raise ValueError(
                f"relaxation algorithm {self.algorithm!r} does not accept dynamics"
            )
        if not is_llg and self.stop.max_relaxation_time_s is not None:
            raise ValueError(
                "max_relaxation_time_s is valid only for algorithm='llg_overdamped'"
            )

    @property
    def max_pseudotime_s(self) -> float | None:
        return self.stop.max_relaxation_time_s

    @property
    def max_physical_time_s(self) -> float | None:
        return self.stop.max_relaxation_time_s

    def to_ir(self) -> dict[str, object]:
        """Serialize to ProblemIR-compatible dictionary."""
        sampling: dict[str, object] = {
            "outputs": [output.to_ir() for output in self.outputs],
        }
        if self._table_autosave is not None:
            sampling["table_autosave"] = self._table_autosave.to_ir()
        payload: dict[str, object] = {
            "kind": "relaxation",
            "algorithm": self.algorithm,
            "stop": self.stop.to_ir(),
            "sampling": sampling,
        }
        if self.dynamics is not None:
            payload["dynamics"] = self.dynamics.to_ir()
        return payload

    def table_autosave(
        self,
        *,
        every_steps: int,
        quantities: Sequence[str] | None = None,
        extra_quantities: Sequence[str] = (),
        table_id: str = "default",
    ) -> "Relaxation":
        return Relaxation(
            algorithm=self.algorithm,
            dynamics=self.dynamics,
            outputs=self.outputs,
            stop=self.stop,
            torque_tolerance_unit=self.torque_tolerance_unit,
            table_autosave=TableAutosave(
                every_steps=every_steps,
                quantities=quantities,
                extra_quantities=extra_quantities,
                table_id=table_id,
            ),
        )

    def tableadd(self, expression: object) -> "Relaxation":
        if self._table_autosave is None:
            raise ValueError("tableadd() requires table_autosave() to be configured first")
        return Relaxation(
            algorithm=self.algorithm,
            dynamics=self.dynamics,
            outputs=self.outputs,
            stop=self.stop,
            torque_tolerance_unit=self.torque_tolerance_unit,
            table_autosave=self._table_autosave.add_expression(expression),
        )

    table_add = tableadd


def _resolve_relax_stop(
    *,
    stop: RelaxStop | None,
    torque_tolerance: object,
    energy_tolerance: object,
    max_steps: object,
    max_relaxation_time_s: object,
    max_pseudotime_s: object,
    max_physical_time_s: object,
) -> RelaxStop:
    def maybe_float(value: object) -> float | None:
        if value is _UNSET or value is None:
            return None
        return float(value)

    def maybe_int(value: object) -> int | None:
        if value is _UNSET or value is None:
            return None
        return int(value)

    alias_torque = maybe_float(torque_tolerance)
    alias_energy = maybe_float(energy_tolerance)
    alias_max_steps = maybe_int(max_steps)
    time_kwargs = {
        "max_relaxation_time_s": max_relaxation_time_s,
        "max_pseudotime_s": max_pseudotime_s,
        "max_physical_time_s": max_physical_time_s,
    }

    if stop is None:
        return RelaxStop(
            torque_tolerance_apm=(
                DEFAULT_RELAXATION_TORQUE_TOLERANCE_APM
                if torque_tolerance is _UNSET
                else alias_torque
            ),
            energy_tolerance_j=alias_energy,
            max_steps=(
                DEFAULT_RELAXATION_MAX_STEPS if max_steps is _UNSET else alias_max_steps
            ),
            **{name: value for name, value in time_kwargs.items() if value is not _UNSET},
        )

    resolved_torque = stop.torque_tolerance_apm
    resolved_energy = stop.energy_tolerance_j
    resolved_max_steps = stop.max_steps

    if torque_tolerance is not _UNSET:
        if resolved_torque is not None and resolved_torque != alias_torque:
            raise ValueError("torque_tolerance conflicts with stop.torque_tolerance_apm")
        resolved_torque = alias_torque
    if energy_tolerance is not _UNSET:
        if resolved_energy is not None and resolved_energy != alias_energy:
            raise ValueError("energy_tolerance conflicts with stop.energy_tolerance_j")
        resolved_energy = alias_energy
    if max_steps is not _UNSET:
        if resolved_max_steps is not None and resolved_max_steps != alias_max_steps:
            raise ValueError("max_steps conflicts with stop.max_steps")
        resolved_max_steps = alias_max_steps
    supplied_times = [
        (name, value)
        for name, value in time_kwargs.items()
        if value is not _UNSET
    ]
    resolved_time = stop.max_relaxation_time_s
    for name, value in supplied_times:
        candidate = None if value is None else float(value)
        if candidate != resolved_time:
            raise ValueError(f"{name} conflicts with stop.max_relaxation_time_s")

    return RelaxStop(
        torque_tolerance_apm=resolved_torque,
        energy_tolerance_j=resolved_energy,
        max_steps=resolved_max_steps,
        max_relaxation_time_s=resolved_time,
    )


@dataclass(frozen=True, slots=True)
class Eigenmodes:
    outputs: Sequence[EigenOutputSpec]
    count: int = 20
    target: str = "lowest"
    target_frequency: float | None = None
    frequency_min: float | None = None
    frequency_max: float | None = None
    operator: str = "linearized_llg"
    equilibrium_source: str = "provided"
    equilibrium_artifact: str | None = None
    include_demag: bool = True
    k_sampling: object | None = None
    k_vector: tuple[float, float, float] | None = None
    bias_field_sweep: BiasFieldSweep | None = None
    mode_tracking: ModeTracking | None = None
    normalization: str = "unit_l2"
    damping_policy: str = "ignore"
    spin_wave_bc: SpinWaveBoundarySpec = "free"
    magnetostatic_bc: str = "open"
    dynamics: LLG = field(default_factory=LLG)

    def __post_init__(self) -> None:
        if not self.outputs:
            raise ValueError("Eigenmodes requires at least one output")
        if any(isinstance(output, SaveResponse) for output in self.outputs):
            raise ValueError("Eigenmodes outputs do not support frequency response observables")
        if self.count <= 0:
            raise ValueError("count must be positive")
        if self.operator not in SUPPORTED_EIGEN_OPERATORS:
            supported = ", ".join(sorted(SUPPORTED_EIGEN_OPERATORS))
            raise ValueError(f"operator must be one of: {supported}")
        if self.target not in SUPPORTED_EIGEN_TARGETS:
            supported = ", ".join(sorted(SUPPORTED_EIGEN_TARGETS))
            raise ValueError(f"target must be one of: {supported}")
        if self.target == "nearest":
            require_positive(self.target_frequency, "target_frequency")
            if self.frequency_min is not None or self.frequency_max is not None:
                raise ValueError(
                    "frequency_min/frequency_max require target='frequency_window'"
                )
        elif self.target == "frequency_window":
            require_positive(self.frequency_min, "frequency_min")
            require_positive(self.frequency_max, "frequency_max")
            if self.frequency_min is not None and self.frequency_max is not None:
                if self.frequency_min >= self.frequency_max:
                    raise ValueError("frequency_min must be less than frequency_max")
            if self.target_frequency is not None:
                require_positive(self.target_frequency, "target_frequency")
        elif self.target_frequency is not None:
            require_positive(self.target_frequency, "target_frequency")
        elif self.frequency_min is not None or self.frequency_max is not None:
            raise ValueError(
                "frequency_min/frequency_max require target='frequency_window'"
            )
        object.__setattr__(
            self,
            "equilibrium_artifact",
            _require_supported_eigen_options(
                damping_policy=self.damping_policy,
                equilibrium_artifact=self.equilibrium_artifact,
                equilibrium_source=self.equilibrium_source,
                normalization=self.normalization,
                operator=self.operator,
            ),
        )
        _serialize_spin_wave_bc(self.spin_wave_bc)
        magnetostatic_bc = require_non_empty(self.magnetostatic_bc, "magnetostatic_bc")
        if magnetostatic_bc not in SUPPORTED_MAGNETOSTATIC_BCS:
            supported = ", ".join(sorted(SUPPORTED_MAGNETOSTATIC_BCS))
            raise ValueError(f"magnetostatic_bc must be one of: {supported}")
        object.__setattr__(self, "magnetostatic_bc", magnetostatic_bc)
        if magnetostatic_bc == "periodic_airbox_k0":
            if not self.include_demag:
                raise ValueError("periodic_airbox_k0 requires include_demag=True")
            if _spin_wave_bc_kind(self.spin_wave_bc) != "periodic":
                raise ValueError("periodic_airbox_k0 requires spin_wave_bc='periodic'")
            sampling = coerce_k_sampling(k_sampling=self.k_sampling, legacy_k_vector=self.k_vector)
            if sampling != {"kind": "single", "k_vector": [0.0, 0.0, 0.0]}:
                raise ValueError("periodic_airbox_k0 requires k_vector=(0.0, 0.0, 0.0)")
            if self.damping_policy != "ignore":
                raise ValueError("periodic_airbox_k0 requires damping_policy='ignore'")
        # Validate alias / primary representation early to fail loudly.
        sampling = coerce_k_sampling(k_sampling=self.k_sampling, legacy_k_vector=self.k_vector)
        if self.bias_field_sweep is not None:
            if not isinstance(self.bias_field_sweep, BiasFieldSweep):
                raise TypeError("bias_field_sweep must be a BiasFieldSweep")
            if sampling != {"kind": "single", "k_vector": [0.0, 0.0, 0.0]}:
                raise ValueError("bias_field_sweep requires k_sampling at single Gamma")
            if not self.include_demag:
                raise ValueError("bias_field_sweep requires include_demag=True")
            if magnetostatic_bc != "periodic_airbox_k0":
                raise ValueError("bias_field_sweep requires magnetostatic_bc='periodic_airbox_k0'")
            if _spin_wave_bc_kind(self.spin_wave_bc) != "periodic":
                raise ValueError("bias_field_sweep requires spin_wave_bc='periodic'")
            if self.damping_policy != "ignore":
                raise ValueError("bias_field_sweep requires damping_policy='ignore'")

    def to_ir(self) -> dict[str, object]:
        target: dict[str, object]
        if self.target == "nearest":
            target = {"kind": "nearest", "frequency_hz": self.target_frequency}
        elif self.target == "frequency_window":
            target = {
                "kind": "frequency_window",
                "frequency_min_hz": self.frequency_min,
                "frequency_max_hz": self.frequency_max,
            }
        else:
            target = {"kind": "lowest"}

        equilibrium: dict[str, object]
        if self.equilibrium_source == "artifact":
            equilibrium = {
                "kind": "artifact",
                "path": self.equilibrium_artifact,
            }
        elif self.equilibrium_source == "relax":
            equilibrium = {"kind": "relaxed_initial_state"}
        else:
            equilibrium = {"kind": "provided"}

        payload: dict[str, object] = {
            "kind": "eigenmodes",
            "dynamics": self.dynamics.to_ir(),
            "operator": {
                "kind": self.operator,
                "include_demag": self.include_demag,
            },
            "count": self.count,
            "target": target,
            "equilibrium": equilibrium,
            "k_sampling": coerce_k_sampling(
                k_sampling=self.k_sampling,
                legacy_k_vector=self.k_vector,
            ),
            "normalization": self.normalization,
            "damping_policy": self.damping_policy,
            "spin_wave_bc": _serialize_spin_wave_bc(self.spin_wave_bc),
            "magnetostatic_bc": self.magnetostatic_bc,
            "sampling": {"outputs": [output.to_ir() for output in self.outputs]},
        }
        if self.mode_tracking is not None:
            payload["mode_tracking"] = self.mode_tracking.to_ir()
        if self.bias_field_sweep is not None:
            payload["bias_field_sweep"] = self.bias_field_sweep.to_ir()
        return payload


@dataclass(frozen=True, slots=True)
class FrequencyResponse:
    outputs: Sequence[FrequencyOutputSpec]
    frequencies_hz: Sequence[float]
    excitation_field_au_per_m: tuple[float, float, float] = (0.0, 0.0, 1.0)
    excitation_phase_rad: float = 0.0
    operator: str = "linearized_llg"
    equilibrium_source: str = "provided"
    equilibrium_artifact: str | None = None
    include_demag: bool = True
    k_sampling: object | None = None
    k_vector: tuple[float, float, float] | None = None
    normalization: str = "unit_l2"
    damping_policy: str = "ignore"
    spin_wave_bc: SpinWaveBoundarySpec = "free"
    magnetostatic_bc: str = "open"
    solver_policy: FrequencyResponseSolverPolicy | None = None
    dynamics: LLG = field(default_factory=LLG)

    def __post_init__(self) -> None:
        if not self.outputs:
            raise ValueError("FrequencyResponse requires at least one output")
        normalized_freqs = tuple(float(freq) for freq in self.frequencies_hz)
        if not normalized_freqs:
            raise ValueError("frequencies_hz must not be empty")
        if any(not math.isfinite(freq) or freq <= 0.0 for freq in normalized_freqs):
            raise ValueError("frequencies_hz must contain finite positive values only")
        object.__setattr__(self, "frequencies_hz", normalized_freqs)
        object.__setattr__(
            self,
            "excitation_field_au_per_m",
            _normalize_finite_vec3(
                self.excitation_field_au_per_m,
                "excitation_field_au_per_m",
            ),
        )
        phase_rad = float(self.excitation_phase_rad)
        if not math.isfinite(phase_rad):
            raise ValueError("excitation_phase_rad must be finite")
        object.__setattr__(self, "excitation_phase_rad", phase_rad)
        object.__setattr__(
            self,
            "equilibrium_artifact",
            _require_supported_eigen_options(
                damping_policy=self.damping_policy,
                equilibrium_artifact=self.equilibrium_artifact,
                equilibrium_source=self.equilibrium_source,
                normalization=self.normalization,
                operator=self.operator,
            ),
        )
        coerce_k_sampling(k_sampling=self.k_sampling, legacy_k_vector=self.k_vector)
        _serialize_spin_wave_bc(self.spin_wave_bc)
        magnetostatic_bc = require_non_empty(self.magnetostatic_bc, "magnetostatic_bc")
        if magnetostatic_bc not in SUPPORTED_MAGNETOSTATIC_BCS:
            supported = ", ".join(sorted(SUPPORTED_MAGNETOSTATIC_BCS))
            raise ValueError(f"magnetostatic_bc must be one of: {supported}")
        object.__setattr__(self, "magnetostatic_bc", magnetostatic_bc)
        if self.solver_policy is not None and not isinstance(
            self.solver_policy,
            FrequencyResponseSolverPolicy,
        ):
            raise TypeError("solver_policy must be FrequencyResponseSolverPolicy")

    def to_ir(self) -> dict[str, object]:
        equilibrium: dict[str, object]
        if self.equilibrium_source == "artifact":
            equilibrium = {"kind": "artifact", "path": self.equilibrium_artifact}
        elif self.equilibrium_source == "relax":
            equilibrium = {"kind": "relaxed_initial_state"}
        else:
            equilibrium = {"kind": "provided"}
        ir = {
            "kind": "frequency_response",
            "dynamics": self.dynamics.to_ir(),
            "operator": {
                "kind": self.operator,
                "include_demag": self.include_demag,
            },
            "equilibrium": equilibrium,
            "k_sampling": coerce_k_sampling(
                k_sampling=self.k_sampling,
                legacy_k_vector=self.k_vector,
            ),
            "normalization": self.normalization,
            "damping_policy": self.damping_policy,
            "spin_wave_bc": _serialize_spin_wave_bc(self.spin_wave_bc),
            "magnetostatic_bc": self.magnetostatic_bc,
            "excitation": {
                "field_au_per_m": list(self.excitation_field_au_per_m),
                "phase_rad": self.excitation_phase_rad,
            },
            "frequencies_hz": {"values_hz": list(self.frequencies_hz)},
            "sampling": {"outputs": [output.to_ir() for output in self.outputs]},
        }
        if self.solver_policy is not None:
            ir["solver_policy"] = self.solver_policy.to_ir()
        return ir


@dataclass(frozen=True, slots=True)
class FieldOrientation:
    kind: str
    preset_name: str | None = None
    theta_deg: float | None = None
    phi_deg: float | None = None
    vector: tuple[float, float, float] | None = None

    @classmethod
    def preset(cls, name: str) -> FieldOrientation:
        return cls(kind="preset", preset_name=name)

    @classmethod
    def sample(cls, theta_deg: float, phi_deg: float) -> FieldOrientation:
        return cls(kind="sample", theta_deg=theta_deg, phi_deg=phi_deg)

    @classmethod
    def global_vector(cls, vector: Sequence[float]) -> FieldOrientation:
        return cls(kind="global", vector=tuple(vector))

    def __post_init__(self) -> None:
        if self.kind == "preset":
            preset_name = require_non_empty(self.preset_name, "FieldOrientation.preset_name")
            if preset_name not in SUPPORTED_FIELD_ORIENTATION_PRESETS:
                supported = ", ".join(sorted(SUPPORTED_FIELD_ORIENTATION_PRESETS))
                raise ValueError(f"FieldOrientation preset must be one of: {supported}")
            object.__setattr__(self, "preset_name", preset_name)
            return
        if self.kind == "sample":
            if self.theta_deg is None or self.phi_deg is None:
                raise ValueError("FieldOrientation.sample requires theta_deg and phi_deg")
            theta = float(self.theta_deg)
            phi = float(self.phi_deg)
            if not math.isfinite(theta) or not math.isfinite(phi):
                raise ValueError("FieldOrientation.sample theta_deg and phi_deg must be finite")
            object.__setattr__(self, "theta_deg", theta)
            object.__setattr__(self, "phi_deg", phi)
            return
        if self.kind == "global":
            if self.vector is None:
                raise ValueError("FieldOrientation.global requires vector")
            vector = _normalize_finite_vec3(self.vector, "FieldOrientation.vector")
            if sum(component * component for component in vector) <= 1e-30:
                raise ValueError("FieldOrientation.vector must not be the zero vector")
            object.__setattr__(self, "vector", vector)
            return
        raise ValueError("FieldOrientation.kind must be preset, sample, or global")

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {"kind": self.kind}
        if self.kind == "preset":
            payload["preset_name"] = self.preset_name
        elif self.kind == "sample":
            payload["theta"] = self.theta_deg
            payload["phi"] = self.phi_deg
        elif self.kind == "global":
            payload["vector"] = list(self.vector)
        return payload


@dataclass(frozen=True, slots=True)
class MeasurementAxis:
    kind: str
    vector: tuple[float, float, float] | None = None

    @classmethod
    def field_axis(cls) -> MeasurementAxis:
        return cls(kind="field_axis")

    @classmethod
    def sample_normal(cls) -> MeasurementAxis:
        return cls(kind="sample_normal")

    @classmethod
    def easy_axis(cls) -> MeasurementAxis:
        return cls(kind="easy_axis")

    @classmethod
    def custom(cls, vector: Sequence[float]) -> MeasurementAxis:
        return cls(kind="custom", vector=tuple(vector))

    def __post_init__(self) -> None:
        kind = require_non_empty(self.kind, "MeasurementAxis.kind")
        if kind in SUPPORTED_HYSTERESIS_MEASUREMENT_AXES:
            if self.vector is not None:
                raise ValueError(f"MeasurementAxis.{kind} must not define vector")
            object.__setattr__(self, "kind", kind)
            return
        if kind == "custom":
            if self.vector is None:
                raise ValueError("MeasurementAxis.custom requires vector")
            vector = _normalize_finite_vec3(self.vector, "MeasurementAxis.vector")
            if sum(component * component for component in vector) <= 1e-30:
                raise ValueError("MeasurementAxis.vector must not be the zero vector")
            object.__setattr__(self, "vector", vector)
            return
        supported = ", ".join(sorted((*SUPPORTED_HYSTERESIS_MEASUREMENT_AXES, "custom")))
        raise ValueError(f"MeasurementAxis kind must be one of: {supported}")

    def to_ir(self) -> str | dict[str, object]:
        if self.kind == "custom":
            return {"kind": "custom", "vector": list(self.vector)}
        return self.kind


@dataclass(frozen=True, slots=True)
class HysteresisAngularVariant:
    variant_id: str
    orientation: FieldOrientation
    label: str = ""
    measurement_axis: str | MeasurementAxis | None = None

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "variant_id",
            require_non_empty(self.variant_id, "HysteresisAngularVariant.variant_id"),
        )
        if not isinstance(self.orientation, FieldOrientation):
            raise ValueError("HysteresisAngularVariant.orientation must be a FieldOrientation")
        if self.label:
            object.__setattr__(
                self,
                "label",
                require_non_empty(self.label, "HysteresisAngularVariant.label"),
            )
        if self.measurement_axis is None:
            return
        if isinstance(self.measurement_axis, MeasurementAxis):
            return
        measurement_axis = require_non_empty(
            str(self.measurement_axis),
            "HysteresisAngularVariant.measurement_axis",
        )
        if measurement_axis not in SUPPORTED_HYSTERESIS_MEASUREMENT_AXES:
            supported = ", ".join(sorted((*SUPPORTED_HYSTERESIS_MEASUREMENT_AXES, "custom")))
            raise ValueError(
                "HysteresisAngularVariant.measurement_axis must be one of "
                f"{supported} or fm.MeasurementAxis.custom(vector)"
            )
        object.__setattr__(self, "measurement_axis", measurement_axis)

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "variant_id": self.variant_id,
            "orientation": self.orientation.to_ir(),
        }
        if self.label:
            payload["label"] = self.label
        if self.measurement_axis is not None:
            payload["measurement_axis"] = (
                self.measurement_axis.to_ir()
                if isinstance(self.measurement_axis, MeasurementAxis)
                else self.measurement_axis
            )
        return payload


@dataclass(frozen=True, slots=True)
class HysteresisAngularFamily:
    variants: Sequence[HysteresisAngularVariant]
    family_id: str = "angular_family"
    label: str = ""

    @classmethod
    def sample_angles(
        cls,
        theta_deg: Sequence[float],
        phi_deg: float = 0.0,
        *,
        family_id: str = "angular_family",
        label: str = "",
        measurement_axis: str | MeasurementAxis | None = None,
    ) -> HysteresisAngularFamily:
        variants = tuple(
            HysteresisAngularVariant(
                variant_id=f"theta_{idx:03}",
                orientation=FieldOrientation.sample(theta_deg=value, phi_deg=phi_deg),
                label=f"theta={float(value):.6g} deg",
                measurement_axis=measurement_axis,
            )
            for idx, value in enumerate(theta_deg)
        )
        return cls(variants=variants, family_id=family_id, label=label)

    def __post_init__(self) -> None:
        family_id = require_non_empty(self.family_id, "HysteresisAngularFamily.family_id")
        variants = tuple(self.variants)
        if not variants:
            raise ValueError("HysteresisAngularFamily.variants must not be empty")
        seen: set[str] = set()
        for variant in variants:
            if not isinstance(variant, HysteresisAngularVariant):
                raise ValueError(
                    "HysteresisAngularFamily.variants must contain HysteresisAngularVariant"
                )
            if variant.variant_id in seen:
                raise ValueError("HysteresisAngularFamily variant_id values must be unique")
            seen.add(variant.variant_id)
        object.__setattr__(self, "family_id", family_id)
        object.__setattr__(self, "variants", variants)
        if self.label:
            object.__setattr__(
                self,
                "label",
                require_non_empty(self.label, "HysteresisAngularFamily.label"),
            )

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "kind": "angular_family",
            "family_id": self.family_id,
            "variants": [variant.to_ir() for variant in self.variants],
        }
        if self.label:
            payload["label"] = self.label
        return payload


@dataclass(frozen=True, slots=True)
class SaturationProbe:
    mode: str = "auto"
    max_field_mT: float = 300.0
    susceptibility_threshold: float = 1e-3
    transverse_threshold: float = 1e-2
    on_failure: str = "continue_with_warning"

    def __post_init__(self) -> None:
        object.__setattr__(self, "mode", require_non_empty(self.mode, "SaturationProbe.mode"))
        on_failure = require_non_empty(self.on_failure, "SaturationProbe.on_failure")
        if on_failure not in SUPPORTED_SATURATION_FAILURE_POLICIES:
            supported = ", ".join(sorted(SUPPORTED_SATURATION_FAILURE_POLICIES))
            raise ValueError(f"SaturationProbe.on_failure must be one of: {supported}")
        max_field = float(self.max_field_mT)
        susceptibility = float(self.susceptibility_threshold)
        transverse = float(self.transverse_threshold)
        if not math.isfinite(max_field) or max_field <= 0.0:
            raise ValueError("SaturationProbe.max_field_mT must be finite and positive")
        if not math.isfinite(susceptibility) or susceptibility <= 0.0:
            raise ValueError("SaturationProbe.susceptibility_threshold must be finite and positive")
        if not math.isfinite(transverse) or transverse <= 0.0:
            raise ValueError("SaturationProbe.transverse_threshold must be finite and positive")
        object.__setattr__(self, "max_field_mT", max_field)
        object.__setattr__(self, "susceptibility_threshold", susceptibility)
        object.__setattr__(self, "transverse_threshold", transverse)
        object.__setattr__(self, "on_failure", on_failure)

    def to_ir(self) -> dict[str, object]:
        return {
            "mode": self.mode,
            "max_field_mT": self.max_field_mT,
            "susceptibility_threshold": self.susceptibility_threshold,
            "transverse_threshold": self.transverse_threshold,
            "on_failure": self.on_failure,
        }


@dataclass(frozen=True, slots=True)
class HysteresisStorage:
    scalar_history: bool = True
    magnetization: str = "selected"
    every_n: int = 5
    key_events: bool = True
    key_event_threshold_dm: float = 0.02

    def __post_init__(self) -> None:
        magnetization = require_non_empty(self.magnetization, "HysteresisStorage.magnetization")
        if magnetization not in SUPPORTED_HYSTERESIS_STORAGE_MAGNETIZATION:
            supported = ", ".join(sorted(SUPPORTED_HYSTERESIS_STORAGE_MAGNETIZATION))
            raise ValueError(f"HysteresisStorage.magnetization must be one of: {supported}")
        if self.every_n < 0:
            raise ValueError("HysteresisStorage.every_n must be non-negative")
        if magnetization in {"selected", "every_n"} and self.every_n <= 0:
            raise ValueError(
                "HysteresisStorage.every_n must be positive when magnetization is selected or every_n"
            )
        threshold = float(self.key_event_threshold_dm)
        if not math.isfinite(threshold) or threshold <= 0.0:
            raise ValueError("HysteresisStorage.key_event_threshold_dm must be finite and positive")
        object.__setattr__(self, "magnetization", magnetization)
        object.__setattr__(self, "every_n", int(self.every_n))
        object.__setattr__(self, "key_event_threshold_dm", threshold)

    def to_ir(self) -> dict[str, object]:
        return {
            "scalar_history": self.scalar_history,
            "magnetization": self.magnetization,
            "every_n": self.every_n,
            "key_events": self.key_events,
            "key_event_threshold_dm": self.key_event_threshold_dm,
        }


@dataclass(frozen=True, slots=True)
class MinorLoop:
    reversal_mT: float
    return_mT: float
    intermediate_fields_mT: Sequence[float] | None = None
    continuation_policy: str = "branch_only"

    def __post_init__(self) -> None:
        reversal = float(self.reversal_mT)
        return_field = float(self.return_mT)
        intermediate_fields = tuple(
            float(field_value) for field_value in (self.intermediate_fields_mT or ())
        )
        if not math.isfinite(reversal) or not math.isfinite(return_field):
            raise ValueError("MinorLoop reversal_mT and return_mT must be finite")
        if not all(math.isfinite(field_value) for field_value in intermediate_fields):
            raise ValueError("MinorLoop.intermediate_fields_mT values must be finite")
        if reversal == return_field:
            raise ValueError("MinorLoop reversal_mT and return_mT must differ")
        scheduled_fields = (reversal, *intermediate_fields, return_field)
        if any(
            left == right
            for left, right in zip(scheduled_fields, scheduled_fields[1:])
        ):
            raise ValueError("MinorLoop.intermediate_fields_mT must not repeat adjacent fields")
        if self.continuation_policy not in SUPPORTED_HYSTERESIS_MINOR_LOOP_CONTINUATION_POLICIES:
            supported = ", ".join(sorted(SUPPORTED_HYSTERESIS_MINOR_LOOP_CONTINUATION_POLICIES))
            raise ValueError(f"MinorLoop.continuation_policy must be one of: {supported}")
        object.__setattr__(self, "reversal_mT", reversal)
        object.__setattr__(self, "return_mT", return_field)
        object.__setattr__(self, "intermediate_fields_mT", intermediate_fields)

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "reversal_mT": self.reversal_mT,
            "return_mT": self.return_mT,
            "continuation_policy": self.continuation_policy,
        }
        if self.intermediate_fields_mT:
            payload["intermediate_fields_mT"] = list(self.intermediate_fields_mT)
        return payload


@dataclass(frozen=True, slots=True)
class FieldSegment:
    start: float
    stop: float
    step: float
    segment_id: str = ""
    label: str = ""
    endpoint_policy: str = "include_stop"
    reason: str = ""

    def __post_init__(self) -> None:
        start = float(self.start)
        stop = float(self.stop)
        step = float(self.step)
        if not all(math.isfinite(value) for value in (start, stop, step)):
            raise ValueError("FieldSegment start, stop, and step must be finite")
        if step == 0.0:
            raise ValueError("FieldSegment.step must not be zero")
        if start == stop:
            raise ValueError("FieldSegment.start and stop must differ")
        label = require_non_empty(self.label, "FieldSegment.label") if self.label else ""
        segment_id = (
            require_non_empty(self.segment_id, "FieldSegment.segment_id")
            if self.segment_id
            else label
        )
        if not segment_id:
            raise ValueError("FieldSegment.segment_id is required")
        if self.endpoint_policy not in SUPPORTED_FIELD_SEGMENT_ENDPOINT_POLICIES:
            supported = ", ".join(sorted(SUPPORTED_FIELD_SEGMENT_ENDPOINT_POLICIES))
            raise ValueError(f"FieldSegment.endpoint_policy must be one of: {supported}")
        object.__setattr__(self, "start", start)
        object.__setattr__(self, "stop", stop)
        object.__setattr__(self, "step", abs(step))
        object.__setattr__(self, "segment_id", segment_id)
        object.__setattr__(self, "label", label)
        object.__setattr__(
            self,
            "reason",
            require_non_empty(self.reason, "FieldSegment.reason") if self.reason else "",
        )

    def to_ir(self) -> dict[str, object]:
        return {
            "start": self.start,
            "stop": self.stop,
            "step": self.step,
            "segment_id": self.segment_id,
            "label": self.label,
            "endpoint_policy": self.endpoint_policy,
            "reason": self.reason,
        }


@dataclass(frozen=True, slots=True)
class PiecewiseFieldSchedule:
    segments: Sequence[FieldSegment]

    def __post_init__(self) -> None:
        segments = tuple(self.segments)
        if not segments:
            raise ValueError("PiecewiseFieldSchedule requires at least one segment")
        object.__setattr__(self, "segments", segments)

    @classmethod
    def mT(cls, segments: Sequence[FieldSegment]) -> PiecewiseFieldSchedule:
        return cls(segments=tuple(segments))

    @classmethod
    def dense_windows(cls, windows: Sequence[FieldWindow]) -> tuple[FieldWindow, ...]:
        return _normalize_dense_windows(windows)

    def to_ir(self) -> dict[str, object]:
        return {
            "segments": [seg.to_ir() for seg in self.segments],
        }


@dataclass(frozen=True, slots=True)
class FieldWindow:
    center_mT: float
    half_width_mT: float
    step_mT: float
    reason: str = ""
    priority: int | None = None

    def __post_init__(self) -> None:
        center = float(self.center_mT)
        half_width = float(self.half_width_mT)
        step = float(self.step_mT)
        if not all(math.isfinite(value) for value in (center, half_width, step)):
            raise ValueError("FieldWindow center_mT, half_width_mT, and step_mT must be finite")
        require_positive(half_width, "FieldWindow.half_width_mT")
        require_positive(step, "FieldWindow.step_mT")
        if self.priority is not None and self.priority < 0:
            raise ValueError("FieldWindow.priority must be non-negative")
        object.__setattr__(self, "center_mT", center)
        object.__setattr__(self, "half_width_mT", half_width)
        object.__setattr__(self, "step_mT", step)
        object.__setattr__(
            self,
            "reason",
            require_non_empty(self.reason, "FieldWindow.reason") if self.reason else "",
        )

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "center_mT": self.center_mT,
            "half_width_mT": self.half_width_mT,
            "step_mT": self.step_mT,
            "reason": self.reason,
        }
        if self.priority is not None:
            payload["priority"] = self.priority
        return payload


@dataclass(frozen=True, slots=True)
class AdaptiveRefinement:
    enabled: bool = True
    max_passes: int = 1
    max_insertions_per_pass: int = 16
    dm_dh_threshold_per_mT: float = 0.02
    max_step_mT: float = 5.0
    min_step_mT: float = 0.1
    include_zero_crossings: bool = True
    include_high_susceptibility: bool = True
    include_in_metrics: bool = False

    def __post_init__(self) -> None:
        if self.max_passes <= 0:
            raise ValueError("AdaptiveRefinement.max_passes must be positive")
        if self.max_insertions_per_pass <= 0:
            raise ValueError("AdaptiveRefinement.max_insertions_per_pass must be positive")
        require_positive(self.dm_dh_threshold_per_mT, "AdaptiveRefinement.dm_dh_threshold_per_mT")
        require_positive(self.max_step_mT, "AdaptiveRefinement.max_step_mT")
        require_positive(self.min_step_mT, "AdaptiveRefinement.min_step_mT")
        if self.min_step_mT > self.max_step_mT:
            raise ValueError("AdaptiveRefinement.min_step_mT must not exceed max_step_mT")

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "adaptive_refinement",
            "enabled": bool(self.enabled),
            "max_passes": int(self.max_passes),
            "max_insertions_per_pass": int(self.max_insertions_per_pass),
            "dm_dh_threshold_per_mT": float(self.dm_dh_threshold_per_mT),
            "max_step_mT": float(self.max_step_mT),
            "min_step_mT": float(self.min_step_mT),
            "include_zero_crossings": bool(self.include_zero_crossings),
            "include_high_susceptibility": bool(self.include_high_susceptibility),
            "include_in_metrics": bool(self.include_in_metrics),
        }


def _normalize_dense_windows(windows: Sequence[FieldWindow]) -> tuple[FieldWindow, ...]:
    normalized = tuple(windows)
    by_start = sorted(
        (
            (window.center_mT - window.half_width_mT, window.center_mT + window.half_width_mT, window)
            for window in normalized
        ),
        key=lambda item: (item[0], item[1]),
    )
    previous_end: float | None = None
    previous_window: FieldWindow | None = None
    for start, end, window in by_start:
        if previous_end is not None and start < previous_end and previous_window is not None:
            if window.priority is None or previous_window.priority is None:
                raise ValueError("overlapping FieldWindow ranges require explicit priority")
            if window.priority == previous_window.priority:
                raise ValueError("overlapping FieldWindow ranges require distinct priority values")
        previous_end = max(previous_end, end) if previous_end is not None else end
        previous_window = window
    return normalized


def _require_supported_settle_non_convergence(policy: str) -> str:
    normalized = require_non_empty(policy, "on_non_convergence")
    if normalized not in SUPPORTED_SETTLE_NON_CONVERGENCE_POLICIES:
        supported = ", ".join(sorted(SUPPORTED_SETTLE_NON_CONVERGENCE_POLICIES))
        raise ValueError(f"on_non_convergence must be one of: {supported}")
    return normalized


def _settle_step_non_convergence(step: SettleStep) -> str:
    if isinstance(step, (RelaxStep, MinimizeStep, DynamicsSettleStep)):
        return step.on_non_convergence
    raise ValueError("settle pipeline steps must be RelaxStep, MinimizeStep, or DynamicsSettleStep")


def _validate_settle_retry_policy(
    on_non_convergence: str,
    retry_timestep_scale: float | None,
    retry_max_attempts: int | None,
) -> None:
    if retry_timestep_scale is not None:
        require_positive(retry_timestep_scale, "retry_timestep_scale")
        if retry_timestep_scale >= 1.0:
            raise ValueError("retry_timestep_scale must be smaller than 1.0")
    if retry_max_attempts is not None and retry_max_attempts <= 0:
        raise ValueError("retry_max_attempts must be positive")
    if on_non_convergence == "retry_with_smaller_dt" and retry_timestep_scale is None:
        raise ValueError("retry_with_smaller_dt requires retry_timestep_scale")


def _require_supported_settle_applies_to(value: object | None) -> object | None:
    if value is None:
        return None
    if isinstance(value, str):
        normalized = require_non_empty(value, "applies_to")
        if normalized not in SUPPORTED_SETTLE_APPLIES_TO:
            supported = ", ".join(sorted(SUPPORTED_SETTLE_APPLIES_TO))
            raise ValueError(f"applies_to must be one of: {supported}")
        return normalized
    if isinstance(value, Sequence):
        normalized = [
            _require_supported_settle_applies_to(item)
            for item in value
            if item is not None
        ]
        if not normalized:
            raise ValueError("applies_to list must not be empty")
        return normalized
    if isinstance(value, Mapping):
        kind = require_non_empty(str(value.get("kind", "")), "applies_to.kind")
        if kind not in SUPPORTED_SETTLE_APPLIES_TO_OBJECT_KINDS:
            supported = ", ".join(sorted(SUPPORTED_SETTLE_APPLIES_TO_OBJECT_KINDS))
            raise ValueError(f"applies_to.kind must be one of: {supported}")
        if kind == "branch_id":
            require_non_empty(str(value.get("branch_id", "")), "applies_to.branch_id")
        if kind == "point_selector":
            point_ids = value.get("point_ids")
            if (
                not isinstance(point_ids, Sequence)
                or isinstance(point_ids, (str, bytes))
                or not point_ids
                or any(not isinstance(point_id, int) or point_id < 0 for point_id in point_ids)
            ):
                raise ValueError("applies_to.point_ids must be a non-empty list of point ids")
        return dict(value)
    raise TypeError("applies_to must be a string, list, mapping, or None")


def _require_supported_settle_stop_criteria(value: object | None) -> object | None:
    if value is None:
        return None
    if isinstance(value, str):
        normalized = require_non_empty(value, "stop_criteria")
        if normalized not in SUPPORTED_SETTLE_STOP_CRITERIA:
            supported = ", ".join(sorted(SUPPORTED_SETTLE_STOP_CRITERIA))
            raise ValueError(f"stop_criteria must be one of: {supported}")
        return normalized
    if isinstance(value, Sequence):
        normalized = [
            _require_supported_settle_stop_criteria(item)
            for item in value
            if item is not None
        ]
        if not normalized:
            raise ValueError("stop_criteria list must not be empty")
        return normalized
    if isinstance(value, Mapping):
        kind = require_non_empty(str(value.get("kind", "")), "stop_criteria.kind")
        if kind not in SUPPORTED_SETTLE_STOP_CRITERIA_GROUPS:
            supported = ", ".join(sorted(SUPPORTED_SETTLE_STOP_CRITERIA_GROUPS))
            raise ValueError(f"stop_criteria.kind must be one of: {supported}")
        criteria = value.get("criteria")
        if not isinstance(criteria, Sequence) or isinstance(criteria, str):
            raise ValueError("stop_criteria.criteria must be a non-empty list")
        normalized_criteria = [
            _require_supported_settle_stop_criteria(item)
            for item in criteria
            if item is not None
        ]
        if not normalized_criteria:
            raise ValueError("stop_criteria.criteria must not be empty")
        return {"kind": kind, "criteria": normalized_criteria}
    raise TypeError("stop_criteria must be a string, list, mapping, or None")


def _validate_settle_physical_time(method: str, max_physical_time_s: float | None) -> None:
    if max_physical_time_s is None:
        return
    if method in DIRECT_MINIMIZER_RELAXATION_ALGORITHMS:
        raise ValueError(
            f"{method} is a direct minimizer and does not advance physical time; "
            "max_physical_time_s is unsupported. Use max_pseudotime_s or "
            'method="llg_overdamped" for physical-time relaxation.'
        )


class SettleStep:
    pass


@dataclass(frozen=True, slots=True)
class RelaxStep(SettleStep):
    method: str = "llg_overdamped"
    alpha: float = 1.0
    torque_tolerance: float = 1e-5
    max_steps: int = 10000
    applies_to: object | None = None
    stop_criteria: object | None = None
    timestep_s: float | None = None
    max_pseudotime_s: float | None = None
    max_physical_time_s: float | None = None
    on_non_convergence: str = "continue_with_warning"
    retry_timestep_scale: float | None = None
    retry_max_attempts: int | None = None

    def __post_init__(self) -> None:
        require_positive(self.alpha, "alpha")
        require_positive(self.torque_tolerance, "torque_tolerance")
        if self.max_steps <= 0:
            raise ValueError("max_steps must be positive")
        if self.timestep_s is not None:
            require_positive(self.timestep_s, "timestep_s")
        if self.max_pseudotime_s is not None:
            require_positive(self.max_pseudotime_s, "max_pseudotime_s")
        if self.max_physical_time_s is not None:
            require_positive(self.max_physical_time_s, "max_physical_time_s")
        _validate_settle_physical_time(self.method, self.max_physical_time_s)
        policy = _require_supported_settle_non_convergence(self.on_non_convergence)
        _validate_settle_retry_policy(policy, self.retry_timestep_scale, self.retry_max_attempts)
        object.__setattr__(
            self, "applies_to", _require_supported_settle_applies_to(self.applies_to)
        )
        object.__setattr__(
            self,
            "stop_criteria",
            _require_supported_settle_stop_criteria(self.stop_criteria),
        )

    def to_ir(self) -> dict[str, object]:
        payload = {
            "kind": "relax",
            "method": self.method,
            "alpha": self.alpha,
            "torque_tolerance": self.torque_tolerance,
            "max_steps": self.max_steps,
            "on_non_convergence": self.on_non_convergence,
        }
        if self.applies_to is not None:
            payload["applies_to"] = self.applies_to
        if self.stop_criteria is not None:
            payload["stop_criteria"] = self.stop_criteria
        if self.timestep_s is not None:
            payload["timestep_s"] = self.timestep_s
        if self.max_pseudotime_s is not None:
            payload["max_pseudotime_s"] = self.max_pseudotime_s
        if self.max_physical_time_s is not None:
            payload["max_physical_time_s"] = self.max_physical_time_s
        if self.retry_timestep_scale is not None:
            payload["retry_timestep_scale"] = self.retry_timestep_scale
        if self.retry_max_attempts is not None:
            payload["retry_max_attempts"] = self.retry_max_attempts
        return payload


@dataclass(frozen=True, slots=True)
class MinimizeStep(SettleStep):
    method: str = "projected_gradient_bb"
    torque_tolerance: float = 5e-5
    energy_tolerance: float = 1e-20
    max_steps: int = 2000
    applies_to: object | None = None
    stop_criteria: object | None = None
    timestep_s: float | None = None
    max_pseudotime_s: float | None = None
    max_physical_time_s: float | None = None
    on_non_convergence: str = "run_next_algorithm"
    retry_timestep_scale: float | None = None
    retry_max_attempts: int | None = None

    def __post_init__(self) -> None:
        require_positive(self.torque_tolerance, "torque_tolerance")
        require_positive(self.energy_tolerance, "energy_tolerance")
        if self.max_steps <= 0:
            raise ValueError("max_steps must be positive")
        if self.timestep_s is not None:
            require_positive(self.timestep_s, "timestep_s")
        if self.max_pseudotime_s is not None:
            require_positive(self.max_pseudotime_s, "max_pseudotime_s")
        if self.max_physical_time_s is not None:
            require_positive(self.max_physical_time_s, "max_physical_time_s")
        _validate_settle_physical_time(self.method, self.max_physical_time_s)
        policy = _require_supported_settle_non_convergence(self.on_non_convergence)
        _validate_settle_retry_policy(policy, self.retry_timestep_scale, self.retry_max_attempts)
        object.__setattr__(
            self, "applies_to", _require_supported_settle_applies_to(self.applies_to)
        )
        object.__setattr__(
            self,
            "stop_criteria",
            _require_supported_settle_stop_criteria(self.stop_criteria),
        )

    def to_ir(self) -> dict[str, object]:
        payload = {
            "kind": "minimize",
            "method": self.method,
            "torque_tolerance": self.torque_tolerance,
            "energy_tolerance": self.energy_tolerance,
            "max_steps": self.max_steps,
            "on_non_convergence": self.on_non_convergence,
        }
        if self.applies_to is not None:
            payload["applies_to"] = self.applies_to
        if self.stop_criteria is not None:
            payload["stop_criteria"] = self.stop_criteria
        if self.timestep_s is not None:
            payload["timestep_s"] = self.timestep_s
        if self.max_pseudotime_s is not None:
            payload["max_pseudotime_s"] = self.max_pseudotime_s
        if self.max_physical_time_s is not None:
            payload["max_physical_time_s"] = self.max_physical_time_s
        if self.retry_timestep_scale is not None:
            payload["retry_timestep_scale"] = self.retry_timestep_scale
        if self.retry_max_attempts is not None:
            payload["retry_max_attempts"] = self.retry_max_attempts
        return payload


@dataclass(frozen=True, slots=True)
class DynamicsSettleStep(SettleStep):
    method: str = "heun_dynamics_settle"
    damping: float = 1.0
    max_steps: int = 10000
    applies_to: object | None = None
    stop_criteria: object | None = None
    timestep_s: float | None = None
    max_pseudotime_s: float | None = None
    max_physical_time_s: float | None = None
    on_non_convergence: str = "continue_with_warning"
    retry_timestep_scale: float | None = None
    retry_max_attempts: int | None = None

    def __post_init__(self) -> None:
        require_positive(self.damping, "damping")
        if self.max_steps <= 0:
            raise ValueError("max_steps must be positive")
        if self.timestep_s is not None:
            require_positive(self.timestep_s, "timestep_s")
        if self.max_pseudotime_s is not None:
            require_positive(self.max_pseudotime_s, "max_pseudotime_s")
        if self.max_physical_time_s is not None:
            require_positive(self.max_physical_time_s, "max_physical_time_s")
        if self.stop_criteria is not None:
            raise ValueError(
                "DynamicsSettleStep stop_criteria is unsupported because dynamics-settle "
                "is duration-based; use RelaxStep or MinimizeStep for convergence criteria."
            )
        policy = _require_supported_settle_non_convergence(self.on_non_convergence)
        _validate_settle_retry_policy(policy, self.retry_timestep_scale, self.retry_max_attempts)
        object.__setattr__(
            self, "applies_to", _require_supported_settle_applies_to(self.applies_to)
        )

    def to_ir(self) -> dict[str, object]:
        payload = {
            "kind": "dynamics_settle",
            "method": self.method,
            "damping": self.damping,
            "max_steps": self.max_steps,
            "on_non_convergence": self.on_non_convergence,
        }
        if self.applies_to is not None:
            payload["applies_to"] = self.applies_to
        if self.stop_criteria is not None:
            payload["stop_criteria"] = self.stop_criteria
        if self.timestep_s is not None:
            payload["timestep_s"] = self.timestep_s
        if self.max_pseudotime_s is not None:
            payload["max_pseudotime_s"] = self.max_pseudotime_s
        if self.max_physical_time_s is not None:
            payload["max_physical_time_s"] = self.max_physical_time_s
        if self.retry_timestep_scale is not None:
            payload["retry_timestep_scale"] = self.retry_timestep_scale
        if self.retry_max_attempts is not None:
            payload["retry_max_attempts"] = self.retry_max_attempts
        return payload


@dataclass(frozen=True, slots=True)
class SettleBranch:
    when: str
    run: SettleStep

    def __post_init__(self) -> None:
        object.__setattr__(self, "when", require_non_empty(self.when, "SettleBranch.when"))

    def to_ir(self) -> dict[str, object]:
        return {
            "when": self.when,
            "run": self.run.to_ir(),
        }


@dataclass(frozen=True, slots=True)
class SettlePipeline:
    steps: Sequence[SettleStep]

    def __post_init__(self) -> None:
        steps = tuple(self.steps)
        if not steps:
            raise ValueError("SettlePipeline requires at least one step")
        for idx, step in enumerate(steps):
            if _settle_step_non_convergence(step) == "run_next_algorithm" and idx == len(steps) - 1:
                raise ValueError("run_next_algorithm requires a following step")
        object.__setattr__(self, "steps", steps)

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "sequence",
            "steps": [step.to_ir() for step in self.steps],
        }


@dataclass(frozen=True, slots=True)
class SettleTree:
    default: SettleStep
    branches: Sequence[SettleBranch]

    def __post_init__(self) -> None:
        branches = tuple(self.branches)
        if _settle_step_non_convergence(self.default) == "run_next_algorithm" and not any(
            branch.when in {"non_converged", "fallback", "run_next_algorithm"} for branch in branches
        ):
            raise ValueError("run_next_algorithm requires a non_converged fallback branch")
        object.__setattr__(self, "branches", branches)

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "tree",
            "default": self.default.to_ir(),
            "branches": [b.to_ir() for b in self.branches],
        }


@dataclass(frozen=True, slots=True)
class Hysteresis:
    outputs: Sequence[TimeOutputSpec]
    field_min_mT: float | None = None
    field_max_mT: float | None = None
    field_step_mT: float | None = None
    field_values_mT: Sequence[float] | None = None
    direction: tuple[float, float, float] | None = None
    orientation: FieldOrientation | None = None
    measurement_axis: str | MeasurementAxis = "field_axis"
    angular_family: HysteresisAngularFamily | None = None
    initial_protocol: str = "positive_saturation"
    initial_state_ref: str | None = None
    saturation: SaturationProbe | None = None
    branch_mode: str = "major_loop"
    settle_pipeline: SettlePipeline | SettleTree | None = None
    storage: HysteresisStorage | None = None
    field_schedule: PiecewiseFieldSchedule | None = None
    schedule_refinements: Sequence[FieldWindow] | None = None
    adaptive_refinement: AdaptiveRefinement | None = None
    minor_loops: Sequence[MinorLoop] | None = None
    _table_autosave: TableAutosave | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if self.field_min_mT is not None:
            field_min = float(self.field_min_mT)
            if not math.isfinite(field_min):
                raise ValueError("field_min_mT must be finite")
            object.__setattr__(self, "field_min_mT", field_min)
        if self.field_max_mT is not None:
            field_max = float(self.field_max_mT)
            if not math.isfinite(field_max):
                raise ValueError("field_max_mT must be finite")
            object.__setattr__(self, "field_max_mT", field_max)
        if self.field_step_mT is not None:
            field_step = float(self.field_step_mT)
            if not math.isfinite(field_step):
                raise ValueError("field_step_mT must be finite")
            if field_step == 0.0:
                raise ValueError("field_step_mT must not be zero")
            object.__setattr__(self, "field_step_mT", field_step)
        if self.field_values_mT is not None and not self.field_values_mT:
            raise ValueError("field_values_mT must not be empty")
        if self.field_values_mT is not None:
            values = tuple(float(value) for value in self.field_values_mT)
            if not all(math.isfinite(value) for value in values):
                raise ValueError("field_values_mT must contain finite values")
            object.__setattr__(self, "field_values_mT", values)
        if self.direction is not None:
            direction = _normalize_finite_vec3(self.direction, "direction")
            norm_sq = sum(component * component for component in direction)
            if norm_sq <= 1e-30:
                raise ValueError("direction must not be the zero vector")
            object.__setattr__(self, "direction", direction)
        if isinstance(self.measurement_axis, MeasurementAxis):
            measurement_axis: str | MeasurementAxis = self.measurement_axis
        else:
            measurement_axis_name = require_non_empty(
                str(self.measurement_axis),
                "measurement_axis",
            )
            if measurement_axis_name not in SUPPORTED_HYSTERESIS_MEASUREMENT_AXES:
                supported = ", ".join(sorted((*SUPPORTED_HYSTERESIS_MEASUREMENT_AXES, "custom")))
                raise ValueError(
                    "measurement_axis must be one of field_axis, sample_normal, easy_axis, "
                    f"or fm.MeasurementAxis.custom(vector); supported names: {supported}"
                )
            measurement_axis = measurement_axis_name
        object.__setattr__(self, "measurement_axis", measurement_axis)
        if self.angular_family is not None and not isinstance(
            self.angular_family, HysteresisAngularFamily
        ):
            raise ValueError("angular_family must be a HysteresisAngularFamily")
        if self.initial_protocol not in SUPPORTED_HYSTERESIS_INITIAL_PROTOCOLS:
            supported = ", ".join(sorted(SUPPORTED_HYSTERESIS_INITIAL_PROTOCOLS))
            raise ValueError(f"initial_protocol must be one of: {supported}")
        if self.initial_protocol == "checkpoint":
            initial_state_ref = require_non_empty(
                self.initial_state_ref,
                "initial_state_ref",
            )
            object.__setattr__(self, "initial_state_ref", initial_state_ref)
        if self.branch_mode not in SUPPORTED_HYSTERESIS_BRANCH_MODES:
            supported = ", ".join(sorted(SUPPORTED_HYSTERESIS_BRANCH_MODES))
            raise ValueError(f"branch_mode must be one of: {supported}")
        if self.schedule_refinements is not None:
            object.__setattr__(
                self,
                "schedule_refinements",
                _normalize_dense_windows(self.schedule_refinements),
            )
        if self.minor_loops is not None:
            object.__setattr__(self, "minor_loops", tuple(self.minor_loops))

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "kind": "hysteresis",
            "field_unit_provenance": dict(DEFAULT_HYSTERESIS_FIELD_UNIT_PROVENANCE),
            "measurement_axis": (
                self.measurement_axis.to_ir()
                if isinstance(self.measurement_axis, MeasurementAxis)
                else self.measurement_axis
            ),
            "initial_protocol": self.initial_protocol,
            "branch_mode": self.branch_mode,
            "sampling": {"outputs": [output.to_ir() for output in self.outputs]},
        }
        if self.initial_state_ref is not None:
            payload["initial_state_ref"] = self.initial_state_ref
        if self.field_min_mT is not None:
            payload["field_min_mT"] = self.field_min_mT
        if self.field_max_mT is not None:
            payload["field_max_mT"] = self.field_max_mT
        if self.field_step_mT is not None:
            payload["field_step_mT"] = self.field_step_mT
        if self.field_values_mT is not None:
            payload["field_values_mT"] = list(self.field_values_mT)
        if self.direction is not None:
            payload["direction"] = list(self.direction)
        if self.orientation is not None:
            payload["orientation"] = self.orientation.to_ir()
        if self.angular_family is not None:
            payload["angular_family"] = self.angular_family.to_ir()
        if self.saturation is not None:
            payload["saturation"] = self.saturation.to_ir()
        if self.settle_pipeline is not None:
            payload["settle_pipeline"] = self.settle_pipeline.to_ir()
        if self.storage is not None:
            payload["storage"] = self.storage.to_ir()
        if self.field_schedule is not None:
            payload["field_schedule"] = self.field_schedule.to_ir()
        if self.schedule_refinements is not None:
            payload["schedule_refinements"] = [w.to_ir() for w in self.schedule_refinements]
        if self.adaptive_refinement is not None:
            payload["adaptive_refinement"] = self.adaptive_refinement.to_ir()
        if self.minor_loops is not None:
            payload["minor_loops"] = [l.to_ir() for l in self.minor_loops]
        if self._table_autosave is not None:
            payload["sampling"]["table_autosave"] = self._table_autosave.to_ir()
        return payload
