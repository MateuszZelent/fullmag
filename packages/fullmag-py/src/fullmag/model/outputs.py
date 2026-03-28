from __future__ import annotations

from dataclasses import dataclass

from fullmag._validation import require_non_empty, require_positive


@dataclass(frozen=True, slots=True)
class SaveField:
    field: str
    every: float

    def __post_init__(self) -> None:
        object.__setattr__(self, "field", require_non_empty(self.field, "field"))
        require_positive(self.every, "every")

    def to_ir(self) -> dict[str, object]:
        return {"kind": "field", "name": self.field, "every_seconds": self.every}


@dataclass(frozen=True, slots=True)
class SaveScalar:
    scalar: str
    every: float

    def __post_init__(self) -> None:
        object.__setattr__(self, "scalar", require_non_empty(self.scalar, "scalar"))
        require_positive(self.every, "every")

    def to_ir(self) -> dict[str, object]:
        return {"kind": "scalar", "name": self.scalar, "every_seconds": self.every}


_KNOWN_FIELDS = {"m", "H_demag", "H_eff", "H_ex", "H_ext"}
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

    # 4. Fallback — treat the whole string as a field name
    return (raw, "3D")


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
