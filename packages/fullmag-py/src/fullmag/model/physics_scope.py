"""Canonical authored physics presence, scope and activation graph.

The graph is deliberately small: constitutive parameters stay in each family
payload, while this layer owns identity, scope, dependency and activation
semantics shared by the Python authoring surface and the Rust ProblemIR.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Mapping, Sequence


class PhysicsActivation(str, Enum):
    CONFIGURED = "configured"
    ACTIVE = "active"
    INACTIVE = "inactive"
    BLOCKED = "blocked"
    UNSUPPORTED = "unsupported"
    UNRESOLVED = "unresolved"


@dataclass(frozen=True, slots=True)
class PhysicsScope:
    kind: str
    object_id: str | None = None
    region_id: str | None = None
    object_ids: tuple[str, ...] = ()
    side_a: Mapping[str, object] | None = None
    side_b: Mapping[str, object] | None = None
    reason: str | None = None
    source_path: str | None = None

    def to_ir(self) -> dict[str, object]:
        value: dict[str, object] = {"kind": self.kind}
        if self.object_id is not None:
            value["object_id"] = self.object_id
        if self.region_id is not None:
            value["region_id"] = self.region_id
        if self.object_ids:
            value["object_ids"] = list(self.object_ids)
        if self.side_a is not None:
            value["side_a"] = dict(self.side_a)
        if self.side_b is not None:
            value["side_b"] = dict(self.side_b)
        if self.reason is not None:
            value["reason"] = self.reason
        if self.source_path is not None:
            value["source_path"] = self.source_path
        return value


@dataclass(frozen=True, slots=True)
class PhysicsModule:
    id: str
    kind: str
    applies_to: tuple[PhysicsScope, ...]
    solve_domain: tuple[Mapping[str, object], ...]
    depends_on: tuple[str, ...]
    activation: PhysicsActivation
    authored_state: str
    capability: str
    source_path: str
    family_payload: Mapping[str, object]

    def to_ir(self) -> dict[str, object]:
        return {
            "id": self.id,
            "kind": self.kind,
            "applies_to": [scope.to_ir() for scope in self.applies_to],
            "solve_domain": [dict(region) for region in self.solve_domain],
            "depends_on": list(self.depends_on),
            "activation": self.activation.value,
            "authored_state": self.authored_state,
            "capability": self.capability,
            "source_path": self.source_path,
            "family_payload": dict(self.family_payload),
        }


@dataclass(frozen=True, slots=True)
class PhysicsEdge:
    kind: str
    source_id: str
    target_id: str
    status: PhysicsActivation

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": self.kind,
            "source_id": self.source_id,
            "target_id": self.target_id,
            "status": self.status.value,
        }


@dataclass(frozen=True, slots=True)
class PhysicsGraph:
    modules: tuple[PhysicsModule, ...] = ()
    edges: tuple[PhysicsEdge, ...] = ()
    objects: tuple[Mapping[str, object], ...] = ()
    schema_version: str = "physics_graph.v1"
    scene_revision: int = 0

    def to_ir(self) -> dict[str, object]:
        result: dict[str, object] = {
            "schema_version": self.schema_version,
            "scene_revision": self.scene_revision,
            "modules": [module.to_ir() for module in self.modules],
            "edges": [edge.to_ir() for edge in self.edges],
        }
        if self.objects:
            result["objects"] = [dict(obj) for obj in self.objects]
        return result


def build_physics_graph(problem: Any) -> PhysicsGraph:
    """Normalize authored family records without inferring module presence."""

    modules: list[PhysicsModule] = []
    edges: list[PhysicsEdge] = []
    inactive_spin_transport_ids = _stage_inactive_spin_transport_ids(problem)
    inactive_current_source_ids = _stage_inactive_current_source_ids(
        problem,
        inactive_spin_transport_ids,
    )

    def add(module: PhysicsModule) -> None:
        if any(existing.id == module.id for existing in modules):
            raise ValueError(f"duplicate physics module id {module.id!r}")
        modules.append(module)

    for index, source in enumerate(getattr(problem, "current_modules", ())):
        payload = _payload(source)
        kind = str(payload.get("kind") or "unsupported")
        module_id = str(payload.get("name") or payload.get("id") or f"current:{index}")
        domain = _regions(payload.get("domain"))
        activation = _current_activation(payload)
        if module_id in inactive_current_source_ids:
            activation = PhysicsActivation.INACTIVE
        add(_module(module_id, kind, domain, (), activation, f"/current_modules/{index}", payload))

    statuses = {module.id: module.activation for module in modules}
    for index, source in enumerate(getattr(problem, "spin_transports", ())):
        payload = _payload(source)
        module_id = str(payload.get("id") or f"spin:{index}")
        domain = _regions(payload.get("domain"))
        dependency = _optional_string(payload.get("current_source_id"))
        activation = _dependency_activation(PhysicsActivation.ACTIVE, dependency, statuses)
        if (
            module_id in inactive_spin_transport_ids
            and activation is not PhysicsActivation.BLOCKED
        ):
            activation = PhysicsActivation.INACTIVE
        add(_module(module_id, "spin_transport", domain, (dependency,) if dependency else (), activation, f"/spin_transports/{index}", payload))
        if dependency:
            edges.append(_edge("current_to_spin_transport", dependency, module_id, activation))
        statuses[module_id] = activation
        for interface_index, interface in enumerate(payload.get("interfaces") or ()):
            if not isinstance(interface, Mapping):
                continue
            interface_id = _optional_string(interface.get("id")) or f"interface:{module_id}:{interface_index}"
            side_a = _region_dict(interface.get("side_a") or interface.get("normal_side"))
            side_b = _region_dict(interface.get("side_b") or interface.get("ferromagnet_side"))
            object_ids = tuple(sorted({str(side_a.get("object_id")), str(side_b.get("object_id"))}))
            interface_activation = _dependency_activation(PhysicsActivation.ACTIVE, module_id, statuses)
            scope = PhysicsScope("cross_object", object_ids=object_ids)
            add(_module(interface_id, "spin_interface", (side_a, side_b), (module_id,), interface_activation, f"/spin_transports/{index}/interfaces/{interface_index}", dict(interface), scopes=(scope,)))

    statuses = {module.id: module.activation for module in modules}
    for index, source in enumerate(getattr(problem, "spin_torques", ())):
        payload = _payload(source, module=True)
        module_id = str(payload.get("id") or f"torque:{index}")
        dependency = _first_string(payload, "current_source", "current_source_id", "solve_id")
        drive = payload.get("drive")
        if dependency is None and isinstance(drive, Mapping):
            dependency = _optional_string(drive.get("current_source_id"))
        target = payload.get("target")
        domain = _regions((target,) if isinstance(target, Mapping) else ())
        activation = _dependency_activation(PhysicsActivation.ACTIVE, dependency, statuses) if dependency else PhysicsActivation.ACTIVE
        authored_activation = getattr(problem, "spin_torque_activation", {}).get(module_id)
        if authored_activation is False:
            activation = PhysicsActivation.INACTIVE
        add(_module(module_id, "spin_torque", domain, (dependency,) if dependency else (), activation, f"/spin_torques/{index}", payload))
        if dependency:
            edge_kind = (
                "spin_transport_to_torque"
                if payload.get("kind") == "drift_diffusion_spin_torque"
                else "current_to_torque"
            )
            edges.append(_edge(edge_kind, dependency, module_id, activation))

    statuses = {module.id: module.activation for module in modules}
    for index, source in enumerate(getattr(problem, "energy", ())):
        payload = _payload(source)
        if payload.get("kind") not in {"oersted_field", "oersted_cylinder"}:
            continue
        module_id = str(payload.get("id") or (f"oersted:{payload.get('source')}" if payload.get("source") else f"oersted:{index}"))
        dependency = _optional_string(payload.get("source"))
        activation = _dependency_activation(PhysicsActivation.ACTIVE, dependency, statuses) if dependency else PhysicsActivation.ACTIVE
        add(_module(module_id, "oersted_field", (), (dependency,) if dependency else (), activation, f"/energy/{index}", payload))
        if dependency:
            edges.append(_edge("current_to_oersted", dependency, module_id, activation))

    for index, source in enumerate(getattr(problem, "field_drives", ())):
        payload = _payload(source)
        module_id = str(payload.get("id") or f"field:{index}")
        target = payload.get("target")
        scope = _scope_from_target(target)
        enabled = bool(payload.get("enabled", True))
        activation = PhysicsActivation.ACTIVE if enabled else PhysicsActivation.INACTIVE
        add(_module(module_id, "regional_field_drive", (), (), activation, f"/field_drives/{index}", payload, scopes=(scope,)))

    modules.sort(key=lambda module: (_module_rank(module.kind), module.id))
    edges.sort(key=lambda edge: (edge.kind, edge.source_id, edge.target_id))
    objects = tuple(
        {
            "schema_version": "physics_object.v1",
            "object_id": name,
            "name": name,
            "type": role,
            "geometry_id": name,
            "material_assignment_ids": [],
        }
        for name, role in sorted(
            getattr(problem, "auxiliary_geometry_roles", {}).items()
        )
        if role != "antenna"
    )
    return PhysicsGraph(tuple(modules), tuple(edges), objects=objects)


def _module(
    module_id: str,
    kind: str,
    domain: Sequence[Mapping[str, object]],
    dependencies: Sequence[str],
    activation: PhysicsActivation,
    source_path: str,
    payload: Mapping[str, object],
    *,
    scopes: Sequence[PhysicsScope] | None = None,
) -> PhysicsModule:
    resolved_domain = tuple(dict(region) for region in domain)
    return PhysicsModule(
        id=module_id,
        kind=kind,
        applies_to=tuple(scopes) if scopes is not None else _scopes_from_regions(resolved_domain),
        solve_domain=resolved_domain,
        depends_on=tuple(dependencies),
        activation=activation,
        authored_state="authored",
        capability="semantic_only",
        source_path=source_path,
        family_payload=dict(payload),
    )


def _payload(value: Any, *, module: bool = False) -> dict[str, object]:
    method = getattr(value, "to_ir_module", None) if module else getattr(value, "to_ir", None)
    if not callable(method):
        method = getattr(value, "to_ir_module", None) or getattr(value, "to_ir", None)
    if not callable(method):
        return {"kind": "unsupported", "repr": type(value).__name__}
    result = method()
    if not isinstance(result, Mapping):
        return {"kind": "unsupported", "repr": type(value).__name__}
    return dict(result)


def _regions(value: object) -> tuple[Mapping[str, object], ...]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return ()
    result: list[Mapping[str, object]] = []
    for item in value:
        if isinstance(item, Mapping):
            result.append(dict(item))
        elif hasattr(item, "to_ir"):
            encoded = item.to_ir()
            if isinstance(encoded, Mapping):
                result.append(dict(encoded))
    return tuple(result)


def _region_dict(value: object) -> dict[str, object]:
    if isinstance(value, Mapping):
        return dict(value)
    if hasattr(value, "to_ir"):
        encoded = value.to_ir()
        if isinstance(encoded, Mapping):
            return dict(encoded)
    return {"object_id": "unresolved"}


def _scopes_from_regions(regions: Sequence[Mapping[str, object]]) -> tuple[PhysicsScope, ...]:
    if not regions:
        return (PhysicsScope("global"),)
    object_ids = tuple(sorted({str(region.get("object_id")) for region in regions}))
    if len(object_ids) > 1:
        return (PhysicsScope("cross_object", object_ids=object_ids),)
    return tuple(
        PhysicsScope(
            "region" if region.get("region_id") else "object",
            object_id=str(region.get("object_id")),
            region_id=(str(region["region_id"]) if region.get("region_id") else None),
        )
        for region in regions
    )


def _scope_from_target(value: object) -> PhysicsScope:
    target = value if isinstance(value, Mapping) else {}
    kind = str(target.get("kind") or "global").lower()
    if kind == "global":
        return PhysicsScope("global")
    if kind == "object":
        return PhysicsScope("object", object_id=str(target.get("object_id")))
    if kind == "region":
        return PhysicsScope("region", object_id=str(target.get("object_id")), region_id=str(target.get("region_id")))
    return PhysicsScope("unresolved", reason="unknown field target")


def _current_activation(payload: Mapping[str, object]) -> PhysicsActivation:
    model = str(payload.get("model") or "")
    if model in {"ohmic_poisson", "magnetoresistive_poisson"}:
        return PhysicsActivation.ACTIVE
    density = payload.get("current_density")
    if isinstance(density, Sequence) and not isinstance(density, (str, bytes)):
        return PhysicsActivation.INACTIVE if all(float(value) == 0.0 for value in density) else PhysicsActivation.ACTIVE
    return PhysicsActivation.CONFIGURED


def _dependency_activation(own: PhysicsActivation, dependency: str | None, statuses: Mapping[str, PhysicsActivation]) -> PhysicsActivation:
    if dependency is None:
        return own
    status = statuses.get(dependency)
    if status is None:
        return PhysicsActivation.BLOCKED
    if status is PhysicsActivation.INACTIVE:
        return PhysicsActivation.INACTIVE
    if status in {PhysicsActivation.BLOCKED, PhysicsActivation.UNSUPPORTED, PhysicsActivation.UNRESOLVED}:
        return PhysicsActivation.BLOCKED
    return own


def _stage_inactive_spin_transport_ids(problem: Any) -> set[str]:
    """Disable solved transport when every explicitly controlled consumer is off.

    A transport module remains present in the canonical IR even while it is
    inactive.  This preserves authoring/provenance, but prevents a zero-current
    preparation stage from materializing a charge/spin solve merely because a
    downstream transport torque was authored for a later stage.
    """

    activation = getattr(problem, "spin_torque_activation", {})
    consumers: dict[str, list[bool]] = {}
    for source in getattr(problem, "spin_torques", ()):
        payload = _payload(source, module=True)
        solve_id = _optional_string(payload.get("solve_id"))
        if solve_id is None:
            continue
        module_id = _optional_string(payload.get("id"))
        if module_id is None:
            continue
        consumers.setdefault(solve_id, []).append(activation.get(module_id, True))
    return {
        solve_id
        for solve_id, states in consumers.items()
        if states and not any(states)
    }


def _stage_inactive_current_source_ids(
    problem: Any,
    inactive_spin_transport_ids: set[str],
) -> set[str]:
    """Propagate an explicit disabled transport pipeline to its sole source.

    The source is kept active when another active spin transport, direct torque,
    or Oersted field still consumes it.  An authored current module is therefore
    never hidden just because its density happens to be zero.
    """

    if not inactive_spin_transport_ids:
        return set()
    transport_by_source: dict[str, list[tuple[str, bool]]] = {}
    for source in getattr(problem, "spin_transports", ()):
        payload = _payload(source)
        transport_id = _optional_string(payload.get("id"))
        current_source_id = _optional_string(payload.get("current_source_id"))
        if transport_id is None or current_source_id is None:
            continue
        transport_by_source.setdefault(current_source_id, []).append(
            (transport_id, transport_id not in inactive_spin_transport_ids)
        )

    activation = getattr(problem, "spin_torque_activation", {})
    direct_torque_by_source: dict[str, bool] = {}
    for source in getattr(problem, "spin_torques", ()):
        payload = _payload(source, module=True)
        current_source_id = _optional_string(
            payload.get("current_source") or payload.get("current_source_id")
        )
        module_id = _optional_string(payload.get("id"))
        if current_source_id is None or module_id is None:
            continue
        direct_torque_by_source[current_source_id] = (
            direct_torque_by_source.get(current_source_id, False)
            or activation.get(module_id, True)
        )

    oersted_sources = {
        _optional_string(_payload(source).get("source"))
        for source in getattr(problem, "energy", ())
        if _payload(source).get("kind") in {"oersted_field", "oersted_cylinder"}
    }
    inactive: set[str] = set()
    for source_id, transports in transport_by_source.items():
        if not any(not active for _, active in transports):
            continue
        if any(active for _, active in transports):
            continue
        if direct_torque_by_source.get(source_id, False) or source_id in oersted_sources:
            continue
        inactive.add(source_id)
    return inactive


def _first_string(payload: Mapping[str, object], *keys: str) -> str | None:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return None


def _optional_string(value: object) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def _module_rank(kind: str) -> int:
    return {"current_transport": 0, "spin_transport": 1, "spin_interface": 2, "spin_torque": 3, "oersted_field": 4, "regional_field_drive": 5}.get(kind, 9)


def _edge(kind: str, source_id: str, target_id: str, status: PhysicsActivation) -> PhysicsEdge:
    return PhysicsEdge(kind, source_id, target_id, status)


__all__ = ["PhysicsActivation", "PhysicsEdge", "PhysicsGraph", "PhysicsModule", "PhysicsScope", "build_physics_graph"]
