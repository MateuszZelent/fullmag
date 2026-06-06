from __future__ import annotations

from dataclasses import dataclass

from fullmag._validation import require_finite, require_non_empty
from fullmag.model.structure import ObjectRegion

_COUPLING_KINDS = {"exchange", "rkky", "interlayer_exchange"}
_EXCHANGE_MODES = {"harmonic_mean", "explicit", "disabled"}
_CAPABILITY_POLICIES = {"require_runtime", "authored_only"}


@dataclass(frozen=True, slots=True)
class CouplingEndpoint:
    payload: dict[str, str]

    @staticmethod
    def object(object_name: str) -> "CouplingEndpoint":
        return CouplingEndpoint(
            {"kind": "object", "object": require_non_empty(object_name, "object")}
        )

    @staticmethod
    def region(object_name: str, region_id: str) -> "CouplingEndpoint":
        return CouplingEndpoint(
            {
                "kind": "region",
                "object": require_non_empty(object_name, "object"),
                "region_id": require_non_empty(region_id, "region_id"),
            }
        )

    @staticmethod
    def surface(object_name: str, selector: str) -> "CouplingEndpoint":
        return CouplingEndpoint(
            {
                "kind": "surface",
                "object": require_non_empty(object_name, "object"),
                "selector": _normalize_surface_selector(selector),
            }
        )

    def to_ir(self) -> dict[str, object]:
        return dict(self.payload)


@dataclass(frozen=True, slots=True)
class Coupling:
    coupling_id: str
    kind: str
    source: CouplingEndpoint
    target: CouplingEndpoint
    parameters: dict[str, object]
    enabled: bool = True
    capability_policy: str = "require_runtime"

    def __post_init__(self) -> None:
        _normalize_choice(self.kind, _COUPLING_KINDS, "kind")
        _normalize_choice(
            self.capability_policy,
            _CAPABILITY_POLICIES,
            "capability_policy",
        )

    def to_ir(self) -> dict[str, object]:
        kind = _normalize_choice(self.kind, _COUPLING_KINDS, "kind")
        parameters = dict(self.parameters)
        if parameters.get("kind") != kind:
            raise ValueError("coupling parameters kind must match coupling kind")
        return {
            "coupling_id": require_non_empty(self.coupling_id, "coupling_id"),
            "kind": kind,
            "source": self.source.to_ir(),
            "target": self.target.to_ir(),
            "enabled": bool(self.enabled),
            "parameters": parameters,
            "capability_policy": _normalize_choice(
                self.capability_policy,
                _CAPABILITY_POLICIES,
                "capability_policy",
            ),
        }


class CouplingRegistry:
    def __init__(self) -> None:
        self._items: list[Coupling] = []

    def exchange(
        self,
        source: object,
        target: object,
        *,
        mode: str = "harmonic_mean",
        scale: float | None = None,
        inter_exchange: float | None = None,
        coupling_id: str | None = None,
        enabled: bool = True,
        capability_policy: str = "require_runtime",
    ) -> Coupling:
        normalized_mode = _normalize_choice(mode, _EXCHANGE_MODES, "mode")
        if normalized_mode == "harmonic_mean" and inter_exchange is not None:
            raise ValueError("harmonic_mean exchange must not define inter_exchange")
        if normalized_mode == "explicit" and inter_exchange is None:
            raise ValueError("explicit exchange requires inter_exchange")
        if normalized_mode == "disabled" and scale not in (None, 0.0):
            raise ValueError("disabled exchange requires scale=0 or omitted scale")
        if scale is not None:
            scale = require_finite(float(scale), "scale")
            if scale < 0.0:
                raise ValueError("scale must be >= 0")
        if inter_exchange is not None:
            inter_exchange = require_finite(float(inter_exchange), "inter_exchange")
        resolved_source = resolve_coupling_endpoint(source)
        resolved_target = resolve_coupling_endpoint(target)
        coupling = Coupling(
            coupling_id=coupling_id
            or _default_coupling_id("exchange", resolved_source, resolved_target),
            kind="exchange",
            source=resolved_source,
            target=resolved_target,
            enabled=enabled,
            parameters={
                "kind": "exchange",
                "mode": normalized_mode,
                **({"scale": scale} if scale is not None else {}),
                **({"inter_exchange": inter_exchange} if inter_exchange is not None else {}),
            },
            capability_policy=capability_policy,
        )
        self._items.append(coupling)
        return coupling

    def rkky(
        self,
        source: object,
        target: object,
        *,
        J1: float,
        coupling_id: str | None = None,
        enabled: bool = True,
        capability_policy: str = "require_runtime",
    ) -> Coupling:
        return self._surface_coupling(
            "rkky",
            source,
            target,
            J1=J1,
            coupling_id=coupling_id,
            enabled=enabled,
            capability_policy=capability_policy,
        )

    def interlayer_exchange(
        self,
        source: object,
        target: object,
        *,
        J1: float,
        J2: float | None = None,
        coupling_id: str | None = None,
        enabled: bool = True,
        capability_policy: str = "require_runtime",
    ) -> Coupling:
        parameters: dict[str, object] = {
            "kind": "interlayer_exchange",
            "j1": require_finite(float(J1), "J1"),
        }
        if J2 is not None:
            parameters["j2"] = require_finite(float(J2), "J2")
        return self._surface_coupling(
            "interlayer_exchange",
            source,
            target,
            parameters=parameters,
            coupling_id=coupling_id,
            enabled=enabled,
            capability_policy=capability_policy,
        )

    def _surface_coupling(
        self,
        kind: str,
        source: object,
        target: object,
        *,
        J1: float,
        parameters: dict[str, object] | None = None,
        coupling_id: str | None,
        enabled: bool,
        capability_policy: str,
    ) -> Coupling:
        normalized_kind = _normalize_choice(kind, _COUPLING_KINDS, "kind")
        resolved_source = resolve_coupling_endpoint(source)
        resolved_target = resolve_coupling_endpoint(target)
        if resolved_source.payload.get("kind") != "surface" or resolved_target.payload.get("kind") != "surface":
            raise ValueError(f"{normalized_kind} coupling endpoints must be surfaces")
        coupling = Coupling(
            coupling_id=coupling_id
            or _default_coupling_id(normalized_kind, resolved_source, resolved_target),
            kind=normalized_kind,
            source=resolved_source,
            target=resolved_target,
            enabled=enabled,
            parameters=parameters
            or {
                "kind": normalized_kind,
                "j1": require_finite(float(J1), "J1"),
            },
            capability_policy=capability_policy,
        )
        self._items.append(coupling)
        return coupling

    def to_ir(self) -> list[dict[str, object]]:
        return [item.to_ir() for item in self._items]

    def items(self) -> tuple[Coupling, ...]:
        return tuple(self._items)

    def remove_region_references(self, object_name: str, region_id: str) -> None:
        object_name = require_non_empty(object_name, "object_name")
        region_id = require_non_empty(region_id, "region_id")

        def references_region(coupling: Coupling) -> bool:
            return any(
                endpoint.payload.get("kind") == "region"
                and endpoint.payload.get("object") == object_name
                and endpoint.payload.get("region_id") == region_id
                for endpoint in (coupling.source, coupling.target)
            )

        self._items = [
            coupling for coupling in self._items if not references_region(coupling)
        ]


def resolve_coupling_endpoint(value: object) -> CouplingEndpoint:
    if isinstance(value, CouplingEndpoint):
        return value
    if isinstance(value, ObjectRegion):
        return CouplingEndpoint.region(value.owner_object, value.region_id)
    object_name = getattr(value, "_name", None)
    if isinstance(object_name, str):
        return CouplingEndpoint.object(object_name)
    name = getattr(value, "name", None)
    if isinstance(name, str):
        return CouplingEndpoint.object(name)
    if isinstance(value, str):
        return CouplingEndpoint.object(value)
    raise TypeError("coupling endpoint must be an object, object region, surface, or name")


def _normalize_choice(value: str, allowed: set[str], name: str) -> str:
    normalized = require_non_empty(str(value), name).strip().lower()
    if normalized not in allowed:
        raise ValueError(f"{name} must be one of {sorted(allowed)!r}, got {value!r}")
    return normalized


def _normalize_surface_selector(value: str) -> str:
    selector = require_non_empty(value, "selector").strip().lower()
    allowed = {"top", "bottom", "left", "right", "front", "back"}
    if selector not in allowed:
        raise ValueError(f"surface selector must be one of {sorted(allowed)!r}, got {value!r}")
    return selector


def _default_coupling_id(
    kind: str,
    source: CouplingEndpoint,
    target: CouplingEndpoint,
) -> str:
    return f"{kind}:{_endpoint_label(source)}:{_endpoint_label(target)}"


def _endpoint_label(endpoint: CouplingEndpoint) -> str:
    payload = endpoint.payload
    kind = payload["kind"]
    if kind == "surface":
        return f"{payload['object']}_{payload['selector']}"
    if kind == "region":
        return str(payload["region_id"]).replace(":", "_")
    return str(payload["object"])


__all__ = ["Coupling", "CouplingEndpoint", "CouplingRegistry", "resolve_coupling_endpoint"]
