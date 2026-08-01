from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from fullmag._validation import (
    SamplingPeriod,
    auto_sinc_sampling_policy_ir,
    normalize_sampling_period,
    require_non_empty,
    require_positive,
)

_SUPPORTED_RESPONSE_OBSERVABLES = {
    "m_complex",
    "u_complex",
    "strain_complex",
    "stress_complex",
    "susceptibility_tensor",
    "absorbed_power_density",
    "response_amplitude",
    "response_phase",
    "mode_hybridization_index",
}

_KNOWN_SCALARS = {
    "E_ex",
    "E_demag",
    "E_ext",
    "E_drive",
    "E_ani",
    "E_dmi",
    "E_total",
    "time",
    "step",
    "solver_dt",
    "mx",
    "my",
    "mz",
    "max_h_eff",
    "max_dm_dt",
    "max_h_demag",
    # Per-object scalar aliases
    "e_ex",
    "e_demag",
    "e_ext",
    "e_ani",
    "e_dmi",
    "e_total",
}


@dataclass(frozen=True, slots=True)
class SaveField:
    field: str
    every: SamplingPeriod

    def __post_init__(self) -> None:
        object.__setattr__(self, "field", require_non_empty(self.field, "field"))
        if self.field not in _KNOWN_FIELDS:
            raise ValueError(f"unsupported field quantity '{self.field}'")
        object.__setattr__(self, "every", normalize_sampling_period(self.every, "every"))

    def to_ir(self) -> dict[str, object]:
        if self.every == "auto":
            return {
                "kind": "field_auto",
                "name": self.field,
                "sample_period_policy": auto_sinc_sampling_policy_ir(),
            }
        return {"kind": "field", "name": self.field, "every_seconds": self.every}


@dataclass(frozen=True, slots=True)
class SaveScalar:
    scalar: str
    every: SamplingPeriod

    def __post_init__(self) -> None:
        object.__setattr__(self, "scalar", require_non_empty(self.scalar, "scalar"))
        if self.scalar not in _KNOWN_SCALARS:
            raise ValueError(f"unsupported scalar quantity '{self.scalar}'")
        object.__setattr__(self, "every", normalize_sampling_period(self.every, "every"))

    def to_ir(self) -> dict[str, object]:
        if self.every == "auto":
            return {
                "kind": "scalar_auto",
                "name": self.scalar,
                "sample_period_policy": auto_sinc_sampling_policy_ir(),
            }
        return {"kind": "scalar", "name": self.scalar, "every_seconds": self.every}


_KNOWN_FIELDS = {
    "m",
    "H_ex", "H_demag", "H_ext", "H_drive", "B_drive", "H_ant", "H_eff",
    "H_ani", "H_dmi", "H_mel", "H_ani_cubic", "H_dmi_bulk",
    "H_oe", "H_therm",
    "demag_phi",
    # Second wave (QB-17)
    "dm_dt", "torque_stt", "torque_sot",
    "eden_ex", "eden_demag", "eden_ext", "eden_drive", "eden_ani", "eden_dmi", "eden_total",
}
_COMPONENTS = {"x", "y", "z"}

# Short aliases: "mz" → ("m", "z"), "mx" → ("m", "x"), etc.
_SHORT_ALIASES: dict[str, tuple[str, str]] = {}
for _f in ("m",):
    for _c in _COMPONENTS:
        _SHORT_ALIASES[f"{_f}{_c}"] = (_f, _c)


def parse_snapshot_quantity(raw: str) -> tuple[str, str]:
    """Parse a snapshot quantity string into (field, component).

    Accepted formats:
        "mz"         → ("m", "z")       — short alias
        "m"          → ("m", "3D")      — full vector
        "H_demag_x"  → ("H_demag", "x") — underscore-separated component
        "H_eff"      → ("H_eff", "3D")  — full vector
    """
    # 1. Short aliases
    if raw in _SHORT_ALIASES:
        return _SHORT_ALIASES[raw]

    # 2. Known field + _component  (e.g. "H_demag_x")
    for suffix in _COMPONENTS:
        if raw.endswith(f"_{suffix}"):
            candidate = raw[: -(len(suffix) + 1)]
            if candidate in _KNOWN_FIELDS:
                return (candidate, suffix)

    # 3. Exact known field → full 3D vector
    if raw in _KNOWN_FIELDS:
        return (raw, "3D")

    raise ValueError(f"unsupported snapshot quantity '{raw}'")


@dataclass(frozen=True, slots=True)
class Snapshot:
    """A periodic field-component snapshot request.

    Parameters
    ----------
    field : str
        Base field name (e.g. ``"m"``, ``"H_demag"``).
    component : str
        ``"x"``, ``"y"``, ``"z"``, or ``"3D"`` for the full vector.
    every : float
        Save interval in seconds.
    layer : str | None
        Layer/region name.  ``None`` means all layers.
    """
    field: str
    component: str
    every: float
    layer: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "field", require_non_empty(self.field, "field"))
        if self.field not in _KNOWN_FIELDS:
            raise ValueError(f"unsupported snapshot field '{self.field}'")
        require_positive(self.every, "every")
        if self.component not in ("x", "y", "z", "3D"):
            raise ValueError(
                f"snapshot component must be 'x', 'y', 'z', or '3D', got '{self.component}'"
            )

    def to_ir(self) -> dict[str, object]:
        d: dict[str, object] = {
            "kind": "snapshot",
            "field": self.field,
            "component": self.component,
            "every_seconds": self.every,
        }
        if self.layer is not None:
            d["layer"] = self.layer
        return d


@dataclass(frozen=True, slots=True)
class SaveResponse:
    observable: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "observable", require_non_empty(self.observable, "observable"))
        if self.observable not in _SUPPORTED_RESPONSE_OBSERVABLES:
            supported = ", ".join(sorted(_SUPPORTED_RESPONSE_OBSERVABLES))
            raise ValueError(f"observable must be one of: {supported}")

    def to_ir(self) -> dict[str, object]:
        return {"kind": "frequency_response_output", "observable": self.observable}


@dataclass(frozen=True, slots=True)
class SaveSpectrum:
    quantity: str = "eigenfrequency"
    scope: str = "per_sample"

    def __post_init__(self) -> None:
        object.__setattr__(self, "quantity", require_non_empty(self.quantity, "quantity"))
        _SUPPORTED_SCOPES = {"global", "per_sample"}
        if self.scope not in _SUPPORTED_SCOPES:
            supported = ", ".join(sorted(_SUPPORTED_SCOPES))
            raise ValueError(f"scope must be one of: {supported}")

    def to_ir(self) -> dict[str, object]:
        return {"kind": "eigen_spectrum", "quantity": self.quantity, "scope": self.scope}


@dataclass(frozen=True, slots=True)
class SaveMode:
    field: str = "mode"
    indices: Sequence[int] = ()
    branches: Sequence[int] = ()
    sample_indices: Sequence[int] = ()
    sample_labels: Sequence[str] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "field", require_non_empty(self.field, "field"))
        normalized = tuple(int(index) for index in self.indices)
        if any(index < 0 for index in normalized):
            raise ValueError("mode indices must be >= 0")
        if len(set(normalized)) != len(normalized):
            raise ValueError("mode indices must be unique")
        object.__setattr__(self, "indices", normalized)
        normalized_branches = tuple(int(b) for b in self.branches)
        if any(b < 0 for b in normalized_branches):
            raise ValueError("branch indices must be >= 0")
        if len(set(normalized_branches)) != len(normalized_branches):
            raise ValueError("branch indices must be unique")
        object.__setattr__(self, "branches", normalized_branches)
        if not normalized and not normalized_branches:
            raise ValueError(
                "SaveMode requires at least one raw mode index or tracked branch index"
            )
        normalized_si = tuple(int(i) for i in self.sample_indices)
        if any(i < 0 for i in normalized_si):
            raise ValueError("sample_indices must be >= 0")
        object.__setattr__(self, "sample_indices", normalized_si)
        object.__setattr__(
            self,
            "sample_labels",
            tuple(
                require_non_empty(label, "sample_labels entry")
                for label in self.sample_labels
            ),
        )

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "kind": "eigen_mode",
            "field": self.field,
            "indices": list(self.indices),
        }
        if self.branches:
            payload["branches"] = list(self.branches)
        if self.sample_indices or self.sample_labels:
            payload["sample_selector"] = {
                "sample_indices": list(self.sample_indices),
                "sample_labels": list(self.sample_labels),
            }
        return payload


@dataclass(frozen=True, slots=True)
class SaveDispersion:
    name: str = "dispersion"
    include_branch_table: bool = True

    def __post_init__(self) -> None:
        object.__setattr__(self, "name", require_non_empty(self.name, "name"))

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "dispersion_curve",
            "name": self.name,
            "include_branch_table": self.include_branch_table,
        }


@dataclass(frozen=True, slots=True)
class SaveEigenDiagnostics:
    include_tracking: bool = True
    include_residuals: bool = True
    include_overlaps: bool = True
    include_tangent_leakage: bool = True
    include_orthogonality: bool = True

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "eigen_diagnostics",
            "include_tracking": self.include_tracking,
            "include_residuals": self.include_residuals,
            "include_overlaps": self.include_overlaps,
            "include_tangent_leakage": self.include_tangent_leakage,
            "include_orthogonality": self.include_orthogonality,
        }


# Canonical quantity IDs — must match fullmag-quantities Rust crate (id.rs).
# Use lowercase "m" to match the backend canonical wire format.
_KNOWN_QUANTITY_IDS = {
    "m", "H_ex", "H_demag", "H_ext", "H_ant", "H_eff",
    "H_ani", "H_dmi", "H_mel", "H_ani_cubic", "H_dmi_bulk", "H_oe", "H_therm",
    "demag_phi",
    "E_ex", "E_demag", "E_ext", "E_ani", "E_dmi", "E_total",
    "mode_amplitude", "mode_real", "mode_imag", "mode_phase",
    # Second wave (QB-17)
    "eden_ex", "eden_demag", "eden_ext", "eden_ani", "eden_dmi", "eden_total",
    "dm_dt", "torque_stt", "torque_sot",
}


# Backward-compatible aliases (e.g. "M" → "m").
_QUANTITY_ID_ALIASES: dict[str, str] = {"M": "m"}


@dataclass(frozen=True, slots=True)
class SaveQuantity:
    """Generic quantity-ID-driven output.

    Parameters
    ----------
    quantity_id : str
        Canonical quantity ID (e.g. ``"m"``, ``"H_ex"``, ``"E_ex"``).
        Legacy uppercase ``"M"`` is accepted and normalized to ``"m"``.
    every : float
        Save interval in seconds.
    reduction : str | None
        Optional reduction: ``"average"``, ``"sum"``, ``"min"``, ``"max"``, ``"magnitude"``.
    component : str | None
        Optional component: ``"x"``, ``"y"``, ``"z"``, ``"magnitude"``, ``"3D"``.
    """
    quantity_id: str
    every: float
    reduction: str | None = None
    component: str | None = None

    def __post_init__(self) -> None:
        raw = require_non_empty(self.quantity_id, "quantity_id")
        normalized = _QUANTITY_ID_ALIASES.get(raw, raw)
        object.__setattr__(self, "quantity_id", normalized)
        if self.quantity_id not in _KNOWN_QUANTITY_IDS:
            raise ValueError(f"unsupported quantity_id '{self.quantity_id}'")
        require_positive(self.every, "every")
        if self.reduction is not None:
            valid = {"average", "sum", "min", "max", "magnitude"}
            if self.reduction not in valid:
                raise ValueError(
                    f"reduction must be one of {sorted(valid)}, got '{self.reduction}'"
                )
        if self.component is not None:
            valid_comp = {"x", "y", "z", "magnitude", "3D"}
            if self.component not in valid_comp:
                raise ValueError(
                    f"component must be one of {sorted(valid_comp)}, got '{self.component}'"
                )

    def to_ir(self) -> dict[str, object]:
        d: dict[str, object] = {
            "kind": "save_quantity",
            "quantity_id": self.quantity_id,
            "every_seconds": self.every,
        }
        if self.reduction is not None:
            d["reduction"] = self.reduction
        if self.component is not None:
            d["component"] = self.component
        return d
