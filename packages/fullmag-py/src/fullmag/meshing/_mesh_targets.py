"""Single source of truth for FEM mesh-target resolution.

PR 2 — Extracts all hmax/hmin/order resolution logic from
``asset_pipeline.py`` into pure-data functions with explicit precedence.

Resolution precedence (highest to lowest):
  1. ``PerObjectMeshRecipe.hmax`` — per-geometry DSL override
  2. ``mesh_workflow.per_geometry[hmax]`` — frontend / control-room override
  3. ``mesh_workflow.default_mesh[hmax]`` — frontend global object default
  4. ``FEM.hmax`` — study-level default
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Literal, Mapping

from fullmag.model.discretization import FEM, PerObjectMeshRecipe
from fullmag.model.geometry import Geometry


# ===================================================================
# Resolved-target dataclasses
# ===================================================================

@dataclass(frozen=True, slots=True)
class ResolvedObjectPreviewTarget:
    """Resolved targets for a single-object FEM preview mesh."""
    hmax: float
    order: int
    source: str  # "fem_default" | "recipe_override" | "workflow_override"


@dataclass(frozen=True, slots=True)
class ResolvedAirboxTarget:
    """Resolved airbox mesh-size targets."""
    hmax: float | None
    hmin: float | None = None
    growth_rate: float | None = None


@dataclass(frozen=True, slots=True)
class ResolvedSharedObjectTarget:
    """Resolved targets for one magnetic object within a shared domain."""
    geometry_name: str
    hmax: float | None
    interface_hmax: float | None = None
    interface_thickness: float | None = None
    transition_distance: float | str | None = None
    transition_distance_requested: float | str | None = None
    transition_distance_effective: float | None = None
    transition_realization: Literal["none", "auto", "explicit", "airbox_boundary", "degraded"] = "none"
    transition_growth: float | None = None
    edge_hmax: float | None = None
    edge_thickness: float | None = None
    edge_transition_distance: float | str | None = None
    corner_hmax: float | None = None
    corner_extent: float | None = None
    corner_transition_distance: float | str | None = None
    source: str = "study_default"
    marker: int | None = None


@dataclass(frozen=True, slots=True)
class ResolvedSharedDomainTargets:
    """Complete resolved targets for a shared-domain FEM mesh."""
    airbox: ResolvedAirboxTarget
    per_object: dict[str, ResolvedSharedObjectTarget]
    effective_hmax: float  # max(airbox_hmax, max object VIn, FEM.hmax)


# ===================================================================
# Utility helpers (moved from asset_pipeline)
# ===================================================================

def _coerce_positive_float(value: object) -> float | None:
    """Parse *value* as a strictly positive finite float, or ``None``."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        candidate = float(value)
    elif isinstance(value, str):
        stripped = value.strip()
        if not stripped or stripped == "auto":
            return None
        try:
            candidate = float(stripped)
        except ValueError:
            return None
    else:
        return None
    return candidate if math.isfinite(candidate) and candidate > 0.0 else None


def _coerce_transition_distance_intent(value: object) -> float | str | None:
    numeric = _coerce_positive_float(value)
    if numeric is not None:
        return numeric
    if isinstance(value, str) and value.strip().lower() in {
        "airbox_boundary",
        "airbox-boundary",
        "auto_boundary",
    }:
        return "airbox_boundary"
    return None


def _geometry_name_aliases(name: str) -> tuple[str, ...]:
    """Return canonical aliases for *name* (with and without ``_geom`` suffix)."""
    resolved = name.strip()
    if not resolved:
        return tuple()
    aliases = [resolved]
    if resolved.endswith("_geom") and len(resolved) > len("_geom"):
        aliases.append(resolved[: -len("_geom")])
    else:
        aliases.append(f"{resolved}_geom")
    return tuple(dict.fromkeys(aliases))


def _lookup_geometry_name_alias(
    mapping: Mapping[str, object] | None,
    geometry_name: str,
) -> object | None:
    """Look up *geometry_name* in *mapping*, trying canonical aliases."""
    if not mapping:
        return None
    for alias in _geometry_name_aliases(geometry_name):
        if alias in mapping:
            return mapping[alias]
    return None


def _parse_per_geometry_overrides(
    per_geometry: object,
) -> dict[str, Mapping[str, object]]:
    """Parse per_geometry list into a name-keyed dict (alias-expanded)."""
    if not isinstance(per_geometry, list):
        return {}
    result: dict[str, Mapping[str, object]] = {}
    for entry in per_geometry:
        if not isinstance(entry, Mapping):
            continue
        raw_name = entry.get("geometry") or entry.get("geometry_name")
        if not isinstance(raw_name, str) or not raw_name.strip():
            continue
        for alias in _geometry_name_aliases(raw_name):
            result.setdefault(alias, entry)
    return result


# ===================================================================
# Single-object preview resolution
# ===================================================================

def resolve_object_preview_target(
    geometry: Geometry,
    hints: FEM,
    *,
    mesh_workflow: Mapping[str, object] | None = None,
    per_object_recipes: dict[str, PerObjectMeshRecipe] | None = None,
) -> ResolvedObjectPreviewTarget:
    """Resolve the effective hmax/order for a single-object preview mesh.

    Precedence (highest wins):
      1. ``PerObjectMeshRecipe.hmax``
      2. ``mesh_workflow.per_geometry[hmax]``
      3. ``mesh_workflow.default_mesh[hmax]``
      4. ``FEM.hmax``
    """
    hmax = float(hints.hmax)
    order = int(hints.order)
    source = "fem_default"

    # Level 3: mesh_workflow.default_mesh[hmax]
    if isinstance(mesh_workflow, Mapping):
        default_mesh = mesh_workflow.get("default_mesh")
        if isinstance(default_mesh, Mapping):
            v = _coerce_positive_float(default_mesh.get("hmax"))
            if v is not None:
                hmax = v
                source = "workflow_default"

    # Level 2: mesh_workflow.per_geometry[hmax]
    if isinstance(mesh_workflow, Mapping):
        per_geometry = mesh_workflow.get("per_geometry")
        if isinstance(per_geometry, list):
            override_by_name: dict[str, float] = {}
            for entry in per_geometry:
                if not isinstance(entry, Mapping):
                    continue
                raw_name = entry.get("geometry") or entry.get("geometry_name")
                if not isinstance(raw_name, str) or not raw_name.strip():
                    continue
                override_hmax = _coerce_positive_float(entry.get("hmax"))
                if override_hmax is not None:
                    for alias in _geometry_name_aliases(raw_name):
                        override_by_name.setdefault(alias, override_hmax)
            resolved = _lookup_geometry_name_alias(override_by_name, geometry.geometry_name)
            if isinstance(resolved, (int, float)):
                hmax = float(resolved)
                source = "workflow_override"

    # Level 1: PerObjectMeshRecipe.hmax (highest priority)
    if per_object_recipes:
        recipe = _lookup_geometry_name_alias(per_object_recipes, geometry.geometry_name)
        if isinstance(recipe, PerObjectMeshRecipe) and recipe.hmax is not None and float(recipe.hmax) > 0:
            hmax = float(recipe.hmax)
            source = "recipe_override"
        if isinstance(recipe, PerObjectMeshRecipe) and recipe.order is not None:
            order = int(recipe.order)

    return ResolvedObjectPreviewTarget(hmax=hmax, order=order, source=source)


# ===================================================================
# Shared-domain resolution (previously _resolve_requested_partition_hmaxs)
# ===================================================================

def _resolve_requested_partition_hmaxs(
    geometries: list[Geometry],
    hints: FEM,
    *,
    airbox_hmax: float | None,
    mesh_workflow: Mapping[str, object] | None,
    per_object_recipes: dict[str, PerObjectMeshRecipe] | None,
) -> tuple[float | None, dict[str, float | None]]:
    """Resolve requested hmax for airbox and each geometry partition.

    Returns ``(airbox_hmax, {geometry_name: hmax | None})``.
    """
    requested_airbox_hmax = (
        float(airbox_hmax)
        if airbox_hmax is not None and float(airbox_hmax) > 0.0
        else (float(hints.hmax) if hints.hmax is not None else None)
    )

    default_object_hmax: float | None = None
    if isinstance(mesh_workflow, Mapping):
        default_mesh = mesh_workflow.get("default_mesh")
        if isinstance(default_mesh, Mapping):
            default_object_hmax = _coerce_positive_float(default_mesh.get("hmax"))

    override_by_name: dict[str, float] = {}
    if isinstance(mesh_workflow, Mapping):
        per_geometry = mesh_workflow.get("per_geometry")
        if isinstance(per_geometry, list):
            for entry in per_geometry:
                if not isinstance(entry, Mapping):
                    continue
                raw_name = entry.get("geometry") or entry.get("geometry_name")
                if not isinstance(raw_name, str) or not raw_name.strip():
                    continue
                override_hmax = _coerce_positive_float(entry.get("hmax"))
                if override_hmax is not None:
                    for alias in _geometry_name_aliases(raw_name):
                        override_by_name.setdefault(alias, override_hmax)

    if per_object_recipes:
        for geometry_name, recipe in per_object_recipes.items():
            if recipe.hmax is not None and float(recipe.hmax) > 0.0:
                for alias in _geometry_name_aliases(geometry_name):
                    override_by_name[alias] = float(recipe.hmax)

    object_hmax_by_geometry: dict[str, float | None] = {}
    for geometry in geometries:
        requested = _lookup_geometry_name_alias(override_by_name, geometry.geometry_name)
        if requested is None:
            requested = default_object_hmax
        if requested is None and (airbox_hmax is None):
            requested = float(hints.hmax) if hints.hmax is not None else None
        object_hmax_by_geometry[geometry.geometry_name] = requested
    return requested_airbox_hmax, object_hmax_by_geometry


def resolve_shared_domain_targets(
    geometries: list[Geometry],
    hints: FEM,
    *,
    airbox_hmax: float | None,
    airbox_hmin: float | None = None,
    airbox_growth_rate: float | None = None,
    mesh_workflow: Mapping[str, object] | None,
    per_object_recipes: dict[str, PerObjectMeshRecipe] | None,
) -> ResolvedSharedDomainTargets:
    """Resolve all shared-domain targets in one shot.

    This replaces the former ``_resolve_effective_shared_domain_targets`` which
    returned raw dicts.  The new API returns typed dataclasses that downstream
    code can rely on without dict-key guessing.
    """
    requested_airbox_hmax, requested_hmax_by_geometry = _resolve_requested_partition_hmaxs(
        geometries, hints,
        airbox_hmax=airbox_hmax,
        mesh_workflow=mesh_workflow,
        per_object_recipes=per_object_recipes,
    )

    airbox = ResolvedAirboxTarget(
        hmax=requested_airbox_hmax,
        hmin=airbox_hmin,
        growth_rate=airbox_growth_rate,
    )

    default_hmax = float(hints.hmax) if hints.hmax is not None else None

    workflow_by_name: dict[str, Mapping[str, object]] = {}
    if isinstance(mesh_workflow, Mapping):
        per_geometry = mesh_workflow.get("per_geometry")
        if isinstance(per_geometry, list):
            for entry in per_geometry:
                if not isinstance(entry, Mapping):
                    continue
                raw_name = entry.get("geometry") or entry.get("geometry_name")
                if isinstance(raw_name, str) and raw_name.strip():
                    for alias in _geometry_name_aliases(raw_name):
                        workflow_by_name.setdefault(alias, entry)

    per_object: dict[str, ResolvedSharedObjectTarget] = {}
    for geometry in geometries:
        workflow_entry = _lookup_geometry_name_alias(workflow_by_name, geometry.geometry_name)
        recipe = (
            _lookup_geometry_name_alias(per_object_recipes, geometry.geometry_name)
            if per_object_recipes
            else None
        )
        bulk_hmax = requested_hmax_by_geometry.get(geometry.geometry_name)

        interface_hmax = (
            _coerce_positive_float(workflow_entry.get("interface_hmax"))
            if isinstance(workflow_entry, Mapping)
            else None
        )
        # interface_hmax is only set when the user explicitly requests it.
        # The previous auto-default (0.6×bulk) created elements finer than
        # the body interior, throttling SmoothRatio growth in the airbox.
        interface_thickness = (
            _coerce_positive_float(workflow_entry.get("interface_thickness"))
            if isinstance(workflow_entry, Mapping)
            else None
        )

        transition_distance_requested = (
            _coerce_transition_distance_intent(workflow_entry.get("transition_distance"))
            if isinstance(workflow_entry, Mapping)
            else None
        )
        transition_distance = (
            transition_distance_requested
            if isinstance(transition_distance_requested, float)
            else transition_distance_requested
        )
        transition_realization: Literal["none", "auto", "explicit", "airbox_boundary", "degraded"] = (
            "airbox_boundary"
            if transition_distance_requested == "airbox_boundary"
            else "explicit" if transition_distance_requested is not None else "none"
        )
        transition_growth = (
            _coerce_positive_float(workflow_entry.get("transition_growth"))
            if isinstance(workflow_entry, Mapping)
            else None
        )
        edge_hmax = (
            _coerce_positive_float(workflow_entry.get("edge_hmax"))
            if isinstance(workflow_entry, Mapping)
            else None
        )
        edge_thickness = (
            _coerce_positive_float(workflow_entry.get("edge_thickness"))
            if isinstance(workflow_entry, Mapping)
            else None
        )
        edge_transition_distance = (
            _coerce_transition_distance_intent(workflow_entry.get("edge_transition_distance"))
            if isinstance(workflow_entry, Mapping)
            else None
        )
        corner_hmax = (
            _coerce_positive_float(workflow_entry.get("corner_hmax"))
            if isinstance(workflow_entry, Mapping)
            else None
        )
        corner_extent = (
            _coerce_positive_float(workflow_entry.get("corner_extent"))
            if isinstance(workflow_entry, Mapping)
            else None
        )
        corner_transition_distance = (
            _coerce_transition_distance_intent(workflow_entry.get("corner_transition_distance"))
            if isinstance(workflow_entry, Mapping)
            else None
        )
        source = "study_default"
        if isinstance(recipe, PerObjectMeshRecipe):
            source = "recipe_override"
        elif isinstance(workflow_entry, Mapping):
            mode = workflow_entry.get("mode")
            source = "local_override" if mode == "custom" else "study_default"

        per_object[geometry.geometry_name] = ResolvedSharedObjectTarget(
            geometry_name=geometry.geometry_name,
            hmax=bulk_hmax,
            interface_hmax=interface_hmax,
            interface_thickness=interface_thickness,
            transition_distance=transition_distance,
            transition_distance_requested=transition_distance_requested,
            transition_distance_effective=(
                transition_distance if isinstance(transition_distance, float) else None
            ),
            transition_realization=transition_realization,
            transition_growth=transition_growth,
            edge_hmax=edge_hmax,
            edge_thickness=edge_thickness,
            edge_transition_distance=edge_transition_distance,
            corner_hmax=corner_hmax,
            corner_extent=corner_extent,
            corner_transition_distance=corner_transition_distance,
            source=source,
        )

    # effective_hmax is the maximum across all targets — used as the Gmsh
    # CharacteristicLengthMax so the mesh generator doesn't clip size fields.
    all_hmaxs = [float(hints.hmax)]
    if requested_airbox_hmax is not None:
        all_hmaxs.append(float(requested_airbox_hmax))
    for value in requested_hmax_by_geometry.values():
        if value is not None:
            all_hmaxs.append(float(value))
    effective_hmax = max(all_hmaxs)

    return ResolvedSharedDomainTargets(
        airbox=airbox,
        per_object=per_object,
        effective_hmax=effective_hmax,
    )


# ===================================================================
# Build report (promoted from asset_pipeline — PR 5)
# ===================================================================

@dataclass(frozen=True, slots=True)
class SharedDomainBuildReport:
    """Typed report for a shared-domain FEM mesh build.

    Uses typed ``Resolved*Target`` fields instead of loose dicts.
    Call :meth:`to_dict` for IR-compatible serialization.
    """
    build_mode: str
    fallbacks_triggered: list[str]
    effective_airbox_target: ResolvedAirboxTarget
    effective_per_object_targets: dict[str, ResolvedSharedObjectTarget]
    used_size_field_kinds: list[str]
    region_markers: list[dict[str, object]] = field(default_factory=list)
    object_region_markers: list[dict[str, object]] = field(default_factory=list)
    size_fields_realized: list[dict[str, object]] = field(default_factory=list)
    operation_statuses: list["MeshOperationStatus"] = field(default_factory=list)
    thin_film_diagnostics: list["ThinFilmDiagnostic"] = field(default_factory=list)
    selector_resolution: list[dict[str, object]] = field(default_factory=list)
    orphan_entities: list[dict[str, object]] = field(default_factory=list)
    degraded: bool = False
    authored_regions_count: int = 0
    realized_regions_count: int = 0

    def to_dict(self) -> dict[str, object]:
        """Serialize to a plain-dict form suitable for JSON / IR embedding."""
        return {
            "build_mode": self.build_mode,
            "fallbacks_triggered": list(self.fallbacks_triggered),
            "effective_airbox_target": {
                "hmax": self.effective_airbox_target.hmax,
                "hmin": self.effective_airbox_target.hmin,
                "growth_rate": self.effective_airbox_target.growth_rate,
            },
            "effective_per_object_targets": {
                name: {
                    "marker": target.marker,
                    "hmax": target.hmax,
                    "interface_hmax": target.interface_hmax,
                    "interface_thickness": target.interface_thickness,
                    "transition_distance": target.transition_distance,
                    "transition_distance_requested": target.transition_distance_requested,
                    "transition_distance_effective": target.transition_distance_effective,
                    "transition_realization": target.transition_realization,
                    "transition_growth": target.transition_growth,
                    "edge_hmax": target.edge_hmax,
                    "edge_thickness": target.edge_thickness,
                    "edge_transition_distance": target.edge_transition_distance,
                    "corner_hmax": target.corner_hmax,
                    "corner_extent": target.corner_extent,
                    "corner_transition_distance": target.corner_transition_distance,
                    "source": target.source,
                }
                for name, target in self.effective_per_object_targets.items()
            },
            "region_markers": [dict(marker) for marker in self.region_markers],
            "object_region_markers": [
                dict(marker) for marker in self.object_region_markers
            ],
            "used_size_field_kinds": list(self.used_size_field_kinds),
            "size_fields_realized": [dict(field) for field in self.size_fields_realized],
            "operation_statuses": [status.to_dict() for status in self.operation_statuses],
            "thin_film_diagnostics": [
                diagnostic.to_dict() for diagnostic in self.thin_film_diagnostics
            ],
            "selector_resolution": [
                dict(resolution) for resolution in self.selector_resolution
            ],
            "orphan_entities": [dict(entity) for entity in self.orphan_entities],
            "degraded": self.degraded,
            "authored_regions_count": self.authored_regions_count,
            "realized_regions_count": self.realized_regions_count,
        }


@dataclass(frozen=True, slots=True)
class MeshOperationStatus:
    """Truth report for an operation requested during mesh build."""

    kind: str
    scope: str
    requested: bool
    status: str
    requested_method: str | None = None
    actual_method: str | None = None
    reason: str | None = None
    details: dict[str, object] = field(default_factory=dict)

    def to_dict(self) -> dict[str, object]:
        return {
            "kind": self.kind,
            "scope": self.scope,
            "requested": self.requested,
            "status": self.status,
            "requested_method": self.requested_method,
            "actual_method": self.actual_method,
            "reason": self.reason,
            "details": dict(self.details),
        }


@dataclass(frozen=True, slots=True)
class ThinFilmDiagnostic:
    """Per-object thin-film meshing diagnostic for shared-domain builds."""

    geometry_name: str
    scope: str
    is_thin_film: bool
    thickness: float | None
    lateral_size: float | None
    aspect_ratio: float | None
    requested_layers: int | None
    estimated_layers_from_hmax: int | None
    hmax_to_thickness_ratio: float | None
    requested_method: str | None
    actual_method: str
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return {
            "geometry_name": self.geometry_name,
            "scope": self.scope,
            "is_thin_film": self.is_thin_film,
            "thickness": self.thickness,
            "lateral_size": self.lateral_size,
            "aspect_ratio": self.aspect_ratio,
            "requested_layers": self.requested_layers,
            "estimated_layers_from_maximum_element_size": self.estimated_layers_from_hmax,
            "maximum_element_size_to_thickness_ratio": self.hmax_to_thickness_ratio,
            "requested_method": self.requested_method,
            "actual_method": self.actual_method,
            "warnings": list(self.warnings),
        }


def _unique_size_field_kinds(size_fields: list[dict[str, object]]) -> list[str]:
    """Return unique field kinds from a list of field descriptors, preserving order."""
    kinds: list[str] = []
    for field_desc in size_fields:
        kind = field_desc.get("kind")
        if isinstance(kind, str) and kind not in kinds:
            kinds.append(kind)
    return kinds
