"""Typed authoring projections derived from the immutable Python problem.

The classes in this module are a deliberately small P2-A bridge.  They are
read-only views over :class:`fullmag.model.problem.Problem`; they do not own a
second mutable scene, do not run a mesher, and do not select a solver.  The
browser and Rust authoring layers can use the versioned payload as a stable
intermediate contract while the existing ``Problem`` remains the execution
boundary.
"""

from __future__ import annotations

from dataclasses import dataclass
from types import MappingProxyType
from typing import TYPE_CHECKING, Any, Mapping, Sequence

from fullmag._validation import require_non_empty
from fullmag.model.canonical import (
    canonical_authoring_json_sha256,
    canonical_json_sha256,
)
from fullmag.model.physics_scope import build_physics_graph

if TYPE_CHECKING:
    from fullmag.model.problem import Problem


_AUTHORING_SCHEMA = "authoring_model.v1"
_COMPONENT_SCHEMA = "component_definition.v1"
_PHYSICS_SCHEMA = "physics_configuration.v1"


def _freeze(value: object) -> object:
    """Recursively freeze a JSON-like payload for a read-only projection."""

    if isinstance(value, Mapping):
        return MappingProxyType(
            {str(key): _freeze(item) for key, item in value.items()}
        )
    if isinstance(value, (list, tuple)):
        return tuple(_freeze(item) for item in value)
    return value


def _thaw(value: object) -> object:
    """Return ordinary JSON containers without leaking mutable projection state."""

    if isinstance(value, Mapping):
        return {str(key): _thaw(item) for key, item in value.items()}
    if isinstance(value, tuple):
        return [_thaw(item) for item in value]
    return value


def _mapping(value: Mapping[str, object] | None, field_name: str) -> Mapping[str, object] | None:
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise TypeError(f"{field_name} must be a mapping or None")
    frozen = _freeze(value)
    if not isinstance(frozen, Mapping):  # pragma: no cover - guarded by _freeze
        raise TypeError(f"{field_name} must be a mapping")
    return frozen


def _required_mapping(value: object, field_name: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise TypeError(f"{field_name} must be a mapping")
    return value


def _required_text(value: object, field_name: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    return require_non_empty(value, field_name)


def _sequence(value: object, field_name: str) -> Sequence[object]:
    if isinstance(value, (str, bytes)) or not isinstance(value, Sequence):
        raise TypeError(f"{field_name} must be a sequence")
    return value


def _schema_version(
    value: Mapping[str, object], expected: str, field_name: str
) -> str:
    actual = value.get("schema_version")
    if actual != expected:
        raise ValueError(
            f"{field_name}.schema_version must be {expected!r}, got {actual!r}"
        )
    return expected


def _reject_unknown_fields(
    value: Mapping[str, object], allowed: set[str], field_name: str
) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ValueError(f"{field_name} contains unknown fields: {', '.join(unknown)}")


def _mapping_sequence(
    values: Sequence[Mapping[str, object]], field_name: str
) -> tuple[Mapping[str, object], ...]:
    normalized: list[Mapping[str, object]] = []
    for index, value in enumerate(values):
        if not isinstance(value, Mapping):
            raise TypeError(f"{field_name}[{index}] must be a mapping")
        frozen = _mapping(value, f"{field_name}[{index}]")
        assert frozen is not None
        normalized.append(frozen)
    return tuple(normalized)


def _string_tuple(values: Sequence[str], field_name: str) -> tuple[str, ...]:
    normalized = tuple(require_non_empty(str(value), f"{field_name}[{index}]") for index, value in enumerate(values))
    if len(set(normalized)) != len(normalized):
        raise ValueError(f"{field_name} must contain unique identifiers")
    return normalized


@dataclass(frozen=True, slots=True)
class ComponentDefinition:
    """Immutable component projection of one authored magnetic object."""

    component_id: str
    name: str
    geometry: Mapping[str, object]
    material_ref: str
    region_ids: tuple[str, ...] = ()
    material_parameter_assignment_ids: tuple[str, ...] = ()
    physics_assignment_ids: tuple[str, ...] = ()
    initial_state: Mapping[str, object] | None = None
    mesh_recipe: Mapping[str, object] | None = None
    schema_version: str = _COMPONENT_SCHEMA

    def __post_init__(self) -> None:
        object.__setattr__(self, "component_id", require_non_empty(self.component_id, "component_id"))
        object.__setattr__(self, "name", require_non_empty(self.name, "name"))
        object.__setattr__(self, "material_ref", require_non_empty(self.material_ref, "material_ref"))
        geometry = _mapping(self.geometry, "geometry")
        if geometry is None:
            raise TypeError("geometry must be a mapping")
        object.__setattr__(self, "geometry", geometry)
        object.__setattr__(self, "region_ids", _string_tuple(self.region_ids, "region_ids"))
        object.__setattr__(
            self,
            "material_parameter_assignment_ids",
            _string_tuple(
                self.material_parameter_assignment_ids,
                "material_parameter_assignment_ids",
            ),
        )
        object.__setattr__(
            self,
            "physics_assignment_ids",
            _string_tuple(self.physics_assignment_ids, "physics_assignment_ids"),
        )
        object.__setattr__(self, "initial_state", _mapping(self.initial_state, "initial_state"))
        object.__setattr__(self, "mesh_recipe", _mapping(self.mesh_recipe, "mesh_recipe"))
        object.__setattr__(self, "schema_version", require_non_empty(self.schema_version, "schema_version"))

    @classmethod
    def from_ir(cls, value: object) -> "ComponentDefinition":
        """Parse one versioned component payload without making it mutable."""

        payload = _required_mapping(value, "component")
        _schema_version(payload, _COMPONENT_SCHEMA, "component")
        _reject_unknown_fields(
            payload,
            {
                "schema_version",
                "component_id",
                "name",
                "geometry",
                "material_ref",
                "region_ids",
                "material_parameter_assignment_ids",
                "physics_assignment_ids",
                "initial_state",
                "mesh_recipe",
            },
            "component",
        )
        return cls(
            component_id=_required_text(payload.get("component_id"), "component_id"),
            name=_required_text(payload.get("name"), "name"),
            geometry=_required_mapping(payload.get("geometry"), "geometry"),
            material_ref=_required_text(payload.get("material_ref"), "material_ref"),
            region_ids=tuple(
                _required_text(item, f"region_ids[{index}]")
                for index, item in enumerate(_sequence(payload.get("region_ids", ()), "region_ids"))
            ),
            material_parameter_assignment_ids=tuple(
                _required_text(item, f"material_parameter_assignment_ids[{index}]")
                for index, item in enumerate(
                    _sequence(
                        payload.get("material_parameter_assignment_ids", ()),
                        "material_parameter_assignment_ids",
                    )
                )
            ),
            physics_assignment_ids=tuple(
                _required_text(item, f"physics_assignment_ids[{index}]")
                for index, item in enumerate(
                    _sequence(payload.get("physics_assignment_ids", ()), "physics_assignment_ids")
                )
            ),
            initial_state=_mapping(payload.get("initial_state"), "initial_state"),
            mesh_recipe=_mapping(payload.get("mesh_recipe"), "mesh_recipe"),
            schema_version=_COMPONENT_SCHEMA,
        )

    def to_ir(self) -> dict[str, object]:
        """Serialize the projection using ordinary JSON-compatible containers."""

        payload: dict[str, object] = {
            "schema_version": self.schema_version,
            "component_id": self.component_id,
            "name": self.name,
            "geometry": _thaw(self.geometry),
            "material_ref": self.material_ref,
            "region_ids": list(self.region_ids),
            "material_parameter_assignment_ids": list(
                self.material_parameter_assignment_ids
            ),
            "physics_assignment_ids": list(self.physics_assignment_ids),
            "initial_state": _thaw(self.initial_state),
            "mesh_recipe": _thaw(self.mesh_recipe),
        }
        return payload


@dataclass(frozen=True, slots=True)
class PhysicsConfiguration:
    """Immutable physical assignment shared by model components."""

    configuration_id: str
    active_interaction_kinds: tuple[str, ...] = ()
    energy_terms: tuple[Mapping[str, object], ...] = ()
    source_ids: tuple[str, ...] = ()
    constraint_ids: tuple[str, ...] = ()
    module_ids: tuple[str, ...] = ()
    schema_version: str = _PHYSICS_SCHEMA

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "configuration_id",
            require_non_empty(self.configuration_id, "configuration_id"),
        )
        object.__setattr__(
            self,
            "active_interaction_kinds",
            _string_tuple(self.active_interaction_kinds, "active_interaction_kinds"),
        )
        object.__setattr__(self, "energy_terms", _mapping_sequence(self.energy_terms, "energy_terms"))
        object.__setattr__(self, "source_ids", _string_tuple(self.source_ids, "source_ids"))
        object.__setattr__(self, "constraint_ids", _string_tuple(self.constraint_ids, "constraint_ids"))
        object.__setattr__(self, "module_ids", _string_tuple(self.module_ids, "module_ids"))
        object.__setattr__(self, "schema_version", require_non_empty(self.schema_version, "schema_version"))

    @classmethod
    def from_ir(cls, value: object) -> "PhysicsConfiguration":
        """Parse one versioned physics configuration payload."""

        payload = _required_mapping(value, "physics_configuration")
        _schema_version(payload, _PHYSICS_SCHEMA, "physics_configuration")
        _reject_unknown_fields(
            payload,
            {
                "schema_version",
                "configuration_id",
                "active_interaction_kinds",
                "energy_terms",
                "source_ids",
                "constraint_ids",
                "module_ids",
            },
            "physics_configuration",
        )
        return cls(
            configuration_id=_required_text(
                payload.get("configuration_id"), "configuration_id"
            ),
            active_interaction_kinds=tuple(
                _required_text(item, f"active_interaction_kinds[{index}]")
                for index, item in enumerate(
                    _sequence(
                        payload.get("active_interaction_kinds", ()),
                        "active_interaction_kinds",
                    )
                )
            ),
            energy_terms=tuple(
                _required_mapping(item, f"energy_terms[{index}]")
                for index, item in enumerate(_sequence(payload.get("energy_terms", ()), "energy_terms"))
            ),
            source_ids=tuple(
                _required_text(item, f"source_ids[{index}]")
                for index, item in enumerate(_sequence(payload.get("source_ids", ()), "source_ids"))
            ),
            constraint_ids=tuple(
                _required_text(item, f"constraint_ids[{index}]")
                for index, item in enumerate(
                    _sequence(payload.get("constraint_ids", ()), "constraint_ids")
                )
            ),
            module_ids=tuple(
                _required_text(item, f"module_ids[{index}]")
                for index, item in enumerate(_sequence(payload.get("module_ids", ()), "module_ids"))
            ),
            schema_version=_PHYSICS_SCHEMA,
        )

    def to_ir(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "configuration_id": self.configuration_id,
            "active_interaction_kinds": list(self.active_interaction_kinds),
            "energy_terms": [_thaw(term) for term in self.energy_terms],
            "source_ids": list(self.source_ids),
            "constraint_ids": list(self.constraint_ids),
            "module_ids": list(self.module_ids),
        }


@dataclass(frozen=True, slots=True)
class ModelDefinition:
    """Immutable authoring projection derived from a :class:`Problem`.

    ``from_problem`` is the only constructor used by the public bridge in this
    slice.  The explicit constructor remains useful for Rust/browser fixtures,
    but it validates stable IDs and keeps every nested payload read-only.
    """

    model_id: str
    name: str
    components: tuple[ComponentDefinition, ...]
    physics_configurations: tuple[PhysicsConfiguration, ...]
    couplings: tuple[Mapping[str, object], ...] = ()
    discretization: Mapping[str, object] | None = None
    parameters: Mapping[str, object] | None = None
    parameter_numerical_sha256: str | None = None
    schema_version: str = _AUTHORING_SCHEMA

    def __post_init__(self) -> None:
        object.__setattr__(self, "model_id", require_non_empty(self.model_id, "model_id"))
        object.__setattr__(self, "name", require_non_empty(self.name, "name"))
        components = tuple(self.components)
        if any(not isinstance(component, ComponentDefinition) for component in components):
            raise TypeError("components must contain ComponentDefinition objects")
        component_ids = [component.component_id for component in components]
        if len(set(component_ids)) != len(component_ids):
            raise ValueError("components must contain unique component_id values")
        object.__setattr__(self, "components", components)
        configurations = tuple(self.physics_configurations)
        if any(not isinstance(configuration, PhysicsConfiguration) for configuration in configurations):
            raise TypeError(
                "physics_configurations must contain PhysicsConfiguration objects"
            )
        configuration_ids = [configuration.configuration_id for configuration in configurations]
        if len(set(configuration_ids)) != len(configuration_ids):
            raise ValueError(
                "physics_configurations must contain unique configuration_id values"
            )
        object.__setattr__(self, "physics_configurations", configurations)
        object.__setattr__(self, "couplings", _mapping_sequence(self.couplings, "couplings"))
        object.__setattr__(self, "discretization", _mapping(self.discretization, "discretization"))
        object.__setattr__(self, "parameters", _mapping(self.parameters, "parameters"))
        if self.parameter_numerical_sha256 is not None:
            object.__setattr__(
                self,
                "parameter_numerical_sha256",
                require_non_empty(self.parameter_numerical_sha256, "parameter_numerical_sha256"),
            )
        object.__setattr__(self, "schema_version", require_non_empty(self.schema_version, "schema_version"))

    @classmethod
    def from_ir(cls, value: object) -> "ModelDefinition":
        """Parse a complete authoring wire payload and validate its versions."""

        payload = _required_mapping(value, "model")
        _schema_version(payload, _AUTHORING_SCHEMA, "model")
        _reject_unknown_fields(
            payload,
            {
                "schema_version",
                "model_id",
                "name",
                "components",
                "physics_configurations",
                "couplings",
                "discretization",
                "parameters",
                "parameter_numerical_sha256",
            },
            "model",
        )
        components = tuple(
            ComponentDefinition.from_ir(item)
            for item in _sequence(payload.get("components", ()), "components")
        )
        configurations = tuple(
            PhysicsConfiguration.from_ir(item)
            for item in _sequence(
                payload.get("physics_configurations", ()), "physics_configurations"
            )
        )
        return cls(
            model_id=_required_text(payload.get("model_id"), "model_id"),
            name=_required_text(payload.get("name"), "name"),
            components=components,
            physics_configurations=configurations,
            couplings=tuple(
                _required_mapping(item, f"couplings[{index}]")
                for index, item in enumerate(_sequence(payload.get("couplings", ()), "couplings"))
            ),
            discretization=_mapping(payload.get("discretization"), "discretization"),
            parameters=_mapping(payload.get("parameters"), "parameters"),
            parameter_numerical_sha256=(
                None
                if payload.get("parameter_numerical_sha256") is None
                else _required_text(
                    payload.get("parameter_numerical_sha256"),
                    "parameter_numerical_sha256",
                )
            ),
            schema_version=_AUTHORING_SCHEMA,
        )

    @classmethod
    def from_problem(cls, problem: "Problem", *, model_id: str | None = None) -> "ModelDefinition":
        """Project an immutable ``Problem`` without meshing or solver selection."""

        if not hasattr(problem, "magnets") or not hasattr(problem, "energy"):
            raise TypeError("problem must be a fullmag.model.problem.Problem")

        object_regions = tuple(problem._collect_object_regions())
        graph = build_physics_graph(problem)
        graph_modules = tuple(graph.modules)
        components: list[ComponentDefinition] = []
        component_ids: set[str] = set()
        for magnet in problem.magnets:
            component_id = magnet.object_id or f"component:{magnet.name}"
            if component_id in component_ids:
                raise ValueError(f"duplicate component_id: {component_id!r}")
            component_ids.add(component_id)
            owned_regions = tuple(
                region for region in object_regions if region.owner_object == magnet.name
            )
            region_payloads = [region.to_ir() for region in owned_regions]
            region_ids = tuple(str(payload["region_id"]) for payload in region_payloads)
            assignment_ids = tuple(
                str(assignment.assignment_id)
                for assignment in magnet.material_parameter_fields
            )
            assigned_modules: set[str] = set()
            for module in graph_modules:
                scopes = module.applies_to
                if any(
                    scope.object_id in {magnet.name, component_id}
                    or magnet.name in scope.object_ids
                    or component_id in scope.object_ids
                    for scope in scopes
                ):
                    assigned_modules.add(module.id)
            components.append(
                ComponentDefinition(
                    component_id=component_id,
                    name=magnet.name,
                    geometry=magnet.geometry.to_ir(),
                    material_ref=magnet.material.name,
                    region_ids=region_ids,
                    material_parameter_assignment_ids=assignment_ids,
                    physics_assignment_ids=tuple(sorted(assigned_modules)),
                    initial_state=magnet.m0.to_ir() if magnet.m0 is not None else None,
                    mesh_recipe=magnet.mesh.to_ir() if magnet.mesh is not None else None,
                )
            )

        energy_terms = tuple(term.to_ir() for term in problem.energy)
        active_interactions = tuple(
            sorted({str(payload.get("kind")) for payload in energy_terms if payload.get("kind")})
        )
        raw_source_ids: set[str] = {
            str(module.name)
            for module in problem.current_modules
            if getattr(module, "name", None)
        }
        raw_source_ids.update(str(drive.id) for drive in problem.field_drives)
        raw_source_ids.update(str(module.id) for module in problem.spin_transports)
        for module in problem.spin_torques:
            module_id = getattr(module, "id", None) or getattr(module, "name", None)
            if module_id:
                raw_source_ids.add(str(module_id))
        source_ids = tuple(sorted(raw_source_ids))
        constraint_ids = tuple(
            sorted(str(constraint.id) for constraint in problem._collect_magnetization_constraints())
        )
        physics_configuration = PhysicsConfiguration(
            configuration_id="physics:default",
            active_interaction_kinds=active_interactions,
            energy_terms=energy_terms,
            source_ids=source_ids,
            constraint_ids=constraint_ids,
            module_ids=tuple(sorted(module.id for module in graph_modules)),
        )
        parameters = problem.parameters.to_ir() if problem.parameters is not None else None
        parameter_hash = (
            problem.parameters.numerical_sha256() if problem.parameters is not None else None
        )
        discretization = (
            problem.discretization.to_ir() if problem.discretization is not None else None
        )
        return cls(
            model_id=model_id or f"model:{problem.name}",
            name=problem.name,
            components=tuple(components),
            physics_configurations=(physics_configuration,),
            couplings=tuple(coupling.to_ir() for coupling in problem.couplings),
            discretization=discretization,
            parameters=parameters,
            parameter_numerical_sha256=parameter_hash,
        )

    def numerical_sha256(self) -> str:
        """Hash model semantics while excluding display-only names and units."""

        payload = self.to_ir()
        payload.pop("name", None)
        components = payload.get("components")
        if isinstance(components, list):
            for component in components:
                if not isinstance(component, dict):
                    continue
                component.pop("name", None)
                if "geometry" in component:
                    component["geometry"] = _without_geometry_display_names(
                        component["geometry"]
                    )
        parameters = payload.get("parameters")
        if isinstance(parameters, Mapping):
            entries = parameters.get("parameters")
            if isinstance(entries, list):
                numerical_entries: list[dict[str, object]] = []
                for entry in entries:
                    if not isinstance(entry, Mapping):
                        continue
                    expression = entry.get("expression")
                    numerical_expression = _without_display(expression)
                    numerical_entries.append(
                        {
                            "id": entry.get("id"),
                            "expression": numerical_expression,
                        }
                    )
                payload["parameters"] = {
                    "schema_version": parameters.get("schema_version"),
                    "version": parameters.get("version"),
                    "parameters": numerical_entries,
                }
        payload.pop("parameter_numerical_sha256", None)
        return canonical_json_sha256(payload)

    def canonical_sha256(self) -> str:
        """Hash the complete versioned wire payload, including display fields."""

        return canonical_authoring_json_sha256(self.to_ir())

    def to_ir(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "model_id": self.model_id,
            "name": self.name,
            "components": [component.to_ir() for component in self.components],
            "physics_configurations": [
                configuration.to_ir()
                for configuration in self.physics_configurations
            ],
            "couplings": [_thaw(coupling) for coupling in self.couplings],
            "discretization": _thaw(self.discretization),
            "parameters": _thaw(self.parameters),
            "parameter_numerical_sha256": self.parameter_numerical_sha256,
        }


def _without_display(value: object) -> object:
    if isinstance(value, Mapping):
        return {
            key: _without_display(item)
            for key, item in value.items()
            if key not in {"authored_unit", "display_unit", "description"}
        }
    if isinstance(value, list):
        return [_without_display(item) for item in value]
    return value


def _without_geometry_display_names(value: object) -> object:
    """Remove labels from geometry trees without dropping geometric inputs."""

    if isinstance(value, Mapping):
        return {
            key: _without_geometry_display_names(item)
            for key, item in value.items()
            if key != "name"
        }
    if isinstance(value, list):
        return [_without_geometry_display_names(item) for item in value]
    return value


__all__ = ["ComponentDefinition", "ModelDefinition", "PhysicsConfiguration"]
