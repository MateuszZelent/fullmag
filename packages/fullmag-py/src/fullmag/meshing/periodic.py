from __future__ import annotations

from dataclasses import dataclass

from fullmag._validation import require_non_empty, require_positive


@dataclass(frozen=True, slots=True)
class PeriodicBoundaryPair:
    pair_id: str
    source_marker: str
    destination_marker: str
    translation: tuple[float, float, float]
    tolerance_m: float = 1e-12
    axis_hint: str | None = None
    pairing_policy: str = "node_nearest_within_tolerance"

    def __post_init__(self) -> None:
        object.__setattr__(self, "pair_id", require_non_empty(self.pair_id, "pair_id"))
        object.__setattr__(
            self,
            "source_marker",
            require_non_empty(self.source_marker, "source_marker"),
        )
        object.__setattr__(
            self,
            "destination_marker",
            require_non_empty(self.destination_marker, "destination_marker"),
        )
        if len(self.translation) != 3:
            raise ValueError("translation must have exactly three components")
        object.__setattr__(
            self,
            "translation",
            tuple(float(component) for component in self.translation),
        )
        require_positive(self.tolerance_m, "tolerance_m")
        if self.axis_hint is not None:
            object.__setattr__(self, "axis_hint", require_non_empty(self.axis_hint, "axis_hint"))
        object.__setattr__(
            self,
            "pairing_policy",
            require_non_empty(self.pairing_policy, "pairing_policy"),
        )

    def to_ir(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "pair_id": self.pair_id,
            "source_marker": self.source_marker,
            "destination_marker": self.destination_marker,
            "translation": list(self.translation),
            "tolerance_m": self.tolerance_m,
            "orientation": "source_to_destination",
            "pairing_policy": self.pairing_policy,
        }
        if self.axis_hint is not None:
            payload["axis_hint"] = self.axis_hint
        return payload


def periodic_x(
    pair_id: str,
    source: str = "x_min",
    destination: str = "x_max",
    length_m: float = 0.0,
    tolerance_m: float = 1e-12,
) -> PeriodicBoundaryPair:
    return PeriodicBoundaryPair(
        pair_id=pair_id,
        source_marker=source,
        destination_marker=destination,
        translation=(float(length_m), 0.0, 0.0),
        tolerance_m=tolerance_m,
        axis_hint="x",
    )


def periodic_y(
    pair_id: str,
    source: str = "y_min",
    destination: str = "y_max",
    length_m: float = 0.0,
    tolerance_m: float = 1e-12,
) -> PeriodicBoundaryPair:
    return PeriodicBoundaryPair(
        pair_id=pair_id,
        source_marker=source,
        destination_marker=destination,
        translation=(0.0, float(length_m), 0.0),
        tolerance_m=tolerance_m,
        axis_hint="y",
    )


def periodic_z(
    pair_id: str,
    source: str = "z_min",
    destination: str = "z_max",
    length_m: float = 0.0,
    tolerance_m: float = 1e-12,
) -> PeriodicBoundaryPair:
    return PeriodicBoundaryPair(
        pair_id=pair_id,
        source_marker=source,
        destination_marker=destination,
        translation=(0.0, 0.0, float(length_m)),
        tolerance_m=tolerance_m,
        axis_hint="z",
    )
