from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Sequence

from .selection import Selection, SelectionDefinition


FROZEN_SPINS_SCHEMA_VERSION = "frozen_spins.v1"
_REFERENCE_KINDS = {
    "capture_current_at_activation",
    "initial_state",
    "explicit_field_asset",
}
_MEMBERSHIP_KINDS = {"static", "snapshot_at_activation"}
_EMPTY_POLICIES = {"error", "allow_noop"}
_INACTIVE_POLICIES = {"warn_and_intersect", "error"}


def _non_empty(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TypeError(f"{field} must be a non-empty string")
    return value.strip()


def _strict_fields(
    value: Mapping[str, object],
    required: set[str],
    optional: set[str],
    field: str,
) -> None:
    unknown = set(value) - required - optional
    missing = required - set(value)
    if unknown:
        raise ValueError(f"{field} has unknown fields: {', '.join(sorted(unknown))}")
    if missing:
        raise ValueError(f"{field} is missing fields: {', '.join(sorted(missing))}")


def _reference_ir(value: object) -> dict[str, object]:
    if isinstance(value, str):
        value = {"kind": value}
    if not isinstance(value, Mapping):
        raise TypeError("reference must be a policy string or mapping")
    kind = value.get("kind")
    if kind not in _REFERENCE_KINDS:
        raise ValueError(f"reference.kind must be one of {sorted(_REFERENCE_KINDS)!r}")
    required = {"kind", "asset_id"} if kind == "explicit_field_asset" else {"kind"}
    _strict_fields(value, required, set(), "reference")
    payload: dict[str, object] = {"kind": kind}
    if kind == "explicit_field_asset":
        payload["asset_id"] = _non_empty(value.get("asset_id"), "reference.asset_id")
    return payload


def _activation_ir(value: object, stage_ids: Sequence[str] | None) -> dict[str, object]:
    if value is not None and stage_ids is not None:
        raise ValueError("activation conflicts with stage_ids")
    if stage_ids is not None:
        value = {"kind": "stage_ids", "stage_ids": list(stage_ids)}
    if value is None or value == "all_stages":
        return {"kind": "all_stages"}
    if not isinstance(value, Mapping):
        raise TypeError("activation must be 'all_stages' or a mapping")
    kind = value.get("kind")
    if kind == "all_stages":
        _strict_fields(value, {"kind"}, set(), "activation")
        return {"kind": "all_stages"}
    if kind != "stage_ids":
        raise ValueError("activation.kind must be 'all_stages' or 'stage_ids'")
    _strict_fields(value, {"kind", "stage_ids"}, set(), "activation")
    raw_ids = value.get("stage_ids")
    if isinstance(raw_ids, (str, bytes)) or not isinstance(raw_ids, Sequence):
        raise TypeError("activation.stage_ids must be a sequence")
    normalized = tuple(_non_empty(item, "activation.stage_ids[]") for item in raw_ids)
    if not normalized:
        raise ValueError("activation.stage_ids must not be empty")
    if len(set(normalized)) != len(normalized):
        raise ValueError("activation.stage_ids must be unique")
    return {"kind": "stage_ids", "stage_ids": list(normalized)}


def _scalar_state_dependent(value: Mapping[str, object]) -> bool:
    kind = value.get("kind")
    if kind in {"magnetization_component", "magnetization_norm", "magnetization_dot"}:
        return True
    if kind == "abs":
        nested = value.get("value")
        return isinstance(nested, Mapping) and _scalar_state_dependent(nested)
    return False


def _selection_state_dependent(
    value: Mapping[str, object], definitions: Mapping[str, Mapping[str, object]]
) -> bool:
    kind = value.get("kind")
    if kind == "compare":
        return any(
            isinstance(value.get(key), Mapping) and _scalar_state_dependent(value[key])  # type: ignore[arg-type]
            for key in ("lhs", "rhs")
        )
    if kind == "approx":
        return any(
            isinstance(value.get(key), Mapping) and _scalar_state_dependent(value[key])  # type: ignore[arg-type]
            for key in ("value", "target")
        )
    if kind == "between":
        scalar = value.get("value")
        return isinstance(scalar, Mapping) and _scalar_state_dependent(scalar)
    if kind in {"and", "or", "xor"}:
        expressions = value.get("expressions")
        return isinstance(expressions, Sequence) and any(
            isinstance(child, Mapping)
            and _selection_state_dependent(child, definitions)
            for child in expressions
        )
    if kind == "not":
        child = value.get("expression")
        return isinstance(child, Mapping) and _selection_state_dependent(
            child, definitions
        )
    if kind == "ref":
        selection_id = value.get("selection_id")
        target = (
            definitions.get(selection_id) if isinstance(selection_id, str) else None
        )
        if target is None:
            raise ValueError(f"selection_unknown_reference: {selection_id!r}")
        expression = target.get("expression")
        return isinstance(expression, Mapping) and _selection_state_dependent(
            expression, definitions
        )
    return False


@dataclass(frozen=True, slots=True, init=False)
class FrozenSpins:
    id: str
    selector: Selection
    name: str
    enabled: bool
    reference: dict[str, object]
    membership: str | None
    activation: dict[str, object]
    empty_selection: str
    inactive_selection: str

    def __init__(
        self,
        *,
        id: str,
        selector: Selection,
        name: str | None = None,
        enabled: bool = True,
        reference: object = "capture_current_at_activation",
        membership: str | None = None,
        activation: object = None,
        stage_ids: Sequence[str] | None = None,
        empty_selection: str = "error",
        inactive_selection: str = "warn_and_intersect",
    ) -> None:
        constraint_id = _non_empty(id, "id")
        if not isinstance(selector, Selection):
            raise TypeError("selector must be a typed Selection")
        if not isinstance(enabled, bool):
            raise TypeError("enabled must be bool")
        if membership is not None and membership not in _MEMBERSHIP_KINDS:
            raise ValueError(f"membership must be one of {sorted(_MEMBERSHIP_KINDS)!r}")
        if empty_selection not in _EMPTY_POLICIES:
            raise ValueError(
                f"empty_selection must be one of {sorted(_EMPTY_POLICIES)!r}"
            )
        if inactive_selection not in _INACTIVE_POLICIES:
            raise ValueError(
                f"inactive_selection must be one of {sorted(_INACTIVE_POLICIES)!r}"
            )
        selector_ir = selector.to_ir()
        if (
            membership == "static"
            and selector_ir.get("kind") != "ref"
            and _selection_state_dependent(selector_ir, {})
        ):
            raise ValueError("frozen_membership_static_state_dependent")
        object.__setattr__(self, "id", constraint_id)
        object.__setattr__(self, "selector", selector)
        object.__setattr__(
            self, "name", constraint_id if name is None else _non_empty(name, "name")
        )
        object.__setattr__(self, "enabled", enabled)
        object.__setattr__(self, "reference", _reference_ir(reference))
        object.__setattr__(self, "membership", membership)
        object.__setattr__(self, "activation", _activation_ir(activation, stage_ids))
        object.__setattr__(self, "empty_selection", empty_selection)
        object.__setattr__(self, "inactive_selection", inactive_selection)

    @classmethod
    def from_ir(cls, value: object) -> "FrozenSpins":
        if not isinstance(value, Mapping):
            raise TypeError("frozen spins payload must be a mapping")
        required = {"kind", "schema_version", "id", "name", "selector"}
        optional = {
            "enabled",
            "reference",
            "membership",
            "activation",
            "empty_selection",
            "inactive_selection",
        }
        _strict_fields(value, required, optional, "frozen spins")
        if value["kind"] != "frozen_spins":
            raise ValueError("frozen spins kind must be 'frozen_spins'")
        if value["schema_version"] != FROZEN_SPINS_SCHEMA_VERSION:
            raise ValueError(f"schema_version must be {FROZEN_SPINS_SCHEMA_VERSION!r}")
        membership = value.get("membership")
        if isinstance(membership, Mapping):
            _strict_fields(membership, {"kind"}, set(), "membership")
            membership = membership["kind"]
        return cls(
            id=value["id"],  # type: ignore[arg-type]
            name=value["name"],  # type: ignore[arg-type]
            enabled=value.get("enabled", True),  # type: ignore[arg-type]
            selector=Selection.from_ir(value["selector"]),
            reference=value.get("reference", "capture_current_at_activation"),
            membership=membership,  # type: ignore[arg-type]
            activation=value.get("activation"),
            empty_selection=value.get("empty_selection", "error"),  # type: ignore[arg-type]
            inactive_selection=value.get("inactive_selection", "warn_and_intersect"),  # type: ignore[arg-type]
        )

    def with_stage_ids(self, stage_ids: Sequence[str]) -> "FrozenSpins":
        return FrozenSpins(
            id=self.id,
            name=self.name,
            enabled=self.enabled,
            selector=self.selector,
            reference=self.reference,
            membership=self.membership,
            stage_ids=stage_ids,
            empty_selection=self.empty_selection,
            inactive_selection=self.inactive_selection,
        )

    def to_ir(
        self, *, selections: Sequence[SelectionDefinition] = ()
    ) -> dict[str, object]:
        definitions = {
            definition.selection_id: definition.to_ir() for definition in selections
        }
        dependent = _selection_state_dependent(self.selector.to_ir(), definitions)
        membership = self.membership or (
            "snapshot_at_activation" if dependent else "static"
        )
        if membership == "static" and dependent:
            raise ValueError("frozen_membership_static_state_dependent")
        return {
            "kind": "frozen_spins",
            "schema_version": FROZEN_SPINS_SCHEMA_VERSION,
            "id": self.id,
            "name": self.name,
            "enabled": self.enabled,
            "selector": self.selector.to_ir(),
            "reference": dict(self.reference),
            "membership": {"kind": membership},
            "activation": {
                key: list(value) if isinstance(value, list) else value
                for key, value in self.activation.items()
            },
            "empty_selection": self.empty_selection,
            "inactive_selection": self.inactive_selection,
        }


def merge_constraint_stage_ids(
    existing: FrozenSpins | None, constraint: FrozenSpins, stage_id: str
) -> FrozenSpins:
    if existing is not None:
        comparable_fields = (
            "id",
            "name",
            "enabled",
            "selector",
            "reference",
            "membership",
            "empty_selection",
            "inactive_selection",
        )
        if any(
            getattr(existing, field) != getattr(constraint, field)
            for field in comparable_fields
        ):
            raise ValueError(
                f"magnetization constraint id {constraint.id!r} has conflicting definitions"
            )
        active = existing.activation
    else:
        active = constraint.activation
    if active["kind"] == "all_stages":
        stage_ids = []
    else:
        stage_ids = list(active["stage_ids"])  # type: ignore[arg-type]
    if stage_id not in stage_ids:
        stage_ids.append(stage_id)
    return constraint.with_stage_ids(stage_ids)


__all__ = ["FrozenSpins"]
