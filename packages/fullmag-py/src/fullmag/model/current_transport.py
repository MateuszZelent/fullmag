from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from fullmag._validation import as_vector3, require_non_empty, require_positive

CURRENT_TRANSPORT_MODELS = {"prescribed_density", "ohmic_poisson"}
CURRENT_TRANSPORT_COUPLINGS = {"one_way", "bidirectional"}


@dataclass(frozen=True, slots=True)
class CurrentTransport:
    """Charge-current transport module for torque and device-level workflows.

    Current executable subset:
    - ``model="prescribed_density"`` on the public FDM path

    Semantic-only placeholder:
    - ``model="ohmic_poisson"``
    """

    name: str
    model: str = "prescribed_density"
    current_density: tuple[float, float, float] | None = None
    solve_region: str | None = None
    conductivity_s_per_m: float | None = None
    coupling: str = "one_way"

    def __init__(
        self,
        *,
        name: str,
        model: str = "prescribed_density",
        current_density: Sequence[float] | None = None,
        solve_region: str | None = None,
        conductivity_s_per_m: float | None = None,
        coupling: str = "one_way",
    ) -> None:
        normalized_model = require_non_empty(model, "model").lower()
        if normalized_model not in CURRENT_TRANSPORT_MODELS:
            raise ValueError(
                f"model must be one of {sorted(CURRENT_TRANSPORT_MODELS)}, got {model!r}"
            )

        object.__setattr__(self, "name", require_non_empty(name, "name"))
        object.__setattr__(self, "model", normalized_model)
        object.__setattr__(
            self,
            "current_density",
            as_vector3(current_density, "current_density") if current_density is not None else None,
        )
        normalized_coupling = require_non_empty(coupling, "coupling").lower()
        if normalized_coupling not in CURRENT_TRANSPORT_COUPLINGS:
            raise ValueError(f"coupling must be one of {sorted(CURRENT_TRANSPORT_COUPLINGS)}")
        if normalized_coupling != "one_way":
            raise ValueError("M1 CurrentTransport supports coupling='one_way' only")
        object.__setattr__(self, "coupling", normalized_coupling)
        object.__setattr__(
            self,
            "solve_region",
            require_non_empty(solve_region, "solve_region") if solve_region is not None else None,
        )
        if conductivity_s_per_m is not None:
            require_positive(conductivity_s_per_m, "conductivity_s_per_m")
        object.__setattr__(
            self,
            "conductivity_s_per_m",
            float(conductivity_s_per_m) if conductivity_s_per_m is not None else None,
        )

        if normalized_model == "prescribed_density":
            if current_density is None:
                raise ValueError(
                    "current_density is required for CurrentTransport(model='prescribed_density')"
                )
        elif current_density is not None:
            raise ValueError(
                "current_density is not valid for CurrentTransport(model='ohmic_poisson')"
            )

    def to_ir(self) -> dict[str, object]:
        ir: dict[str, object] = {
            "kind": "current_transport",
            "name": self.name,
            "model": self.model,
        }
        if self.current_density is not None:
            ir["current_density"] = list(self.current_density)
        if self.solve_region is not None:
            ir["solve_region"] = self.solve_region
        if self.conductivity_s_per_m is not None:
            ir["conductivity_s_per_m"] = self.conductivity_s_per_m
        ir["coupling"] = self.coupling
        return ir


__all__ = ["CURRENT_TRANSPORT_COUPLINGS", "CURRENT_TRANSPORT_MODELS", "CurrentTransport"]
