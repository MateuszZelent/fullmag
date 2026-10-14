"""Lightweight real-Gmsh regression for the exact-layer periodic film mesh."""
import ast
import hashlib
import json
import math
import sys
from pathlib import Path
import numpy as np
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "packages/fullmag-py/src"))
from fullmag.model.geometry import Box
from fullmag.meshing._gmsh_types import MeshOptions, AirboxOptions
from fullmag.meshing._gmsh_swept import (
    _box_airbox_layer_levels, generate_swept_tetrahedral_box_airbox_mesh, should_use_swept,
)
from fullmag.meshing import _gmsh_swept as _gmsh_swept_module


# Public DE fixture: 10 nm film and 2 um authored air padding per side.
_PUBLIC_DE_AIRBOX_HALF_HEIGHT_M = 5e-9 + 2e-6
_MAX_GMSH_DIAGNOSTIC_ITEMS = 128
_MAX_BODY_XY_DIAGNOSTIC_BYTES = 64 * 1024
_MAX_GMSH_ELEMENT_TYPE_DIAGNOSTIC_ENTRIES = 16


def _diagnostic_value(value):
    """Keep real Gmsh API values JSON-safe and explicitly bounded."""
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else {"non_finite_value": repr(value)}
    if isinstance(value, str):
        if len(value) <= 512:
            return value
        return {"prefix": value[:512], "character_count": len(value), "truncated": True}
    if isinstance(value, (tuple, list)):
        limit = _MAX_GMSH_DIAGNOSTIC_ITEMS
        items = [_diagnostic_value(item) for item in value[:limit]]
        if len(value) > limit:
            return {"items": items, "item_count": len(value), "truncated": True}
        return items
    if hasattr(value, "tolist"):
        return _diagnostic_value(value.tolist())
    rendered = str(value)
    return {
        "type": type(value).__name__,
        "repr_prefix": rendered[:512],
        "truncated": len(rendered) > 512,
    }


def _gmsh_element_type_counts(gmsh):
    """Return bounded counts only; never include node or element inventories."""
    type_names = {
        2: "triangle3",
        3: "quadrangle4",
        4: "tetrahedron4",
        6: "prism6",
    }
    dimensions = []
    for dimension in (1, 2, 3):
        element_types, element_tags, _node_tags = gmsh.model.mesh.getElements(dimension)
        entries = [
            {
                "gmsh_element_type": int(element_type),
                "name": type_names.get(int(element_type), "other"),
                "count": len(tags),
            }
            for element_type, tags in zip(element_types, element_tags, strict=True)
        ]
        entries.sort(key=lambda item: item["gmsh_element_type"])
        dimensions.append({
            "dimension": dimension,
            "element_count": sum(item["count"] for item in entries),
            "type_count": len(entries),
            "types": entries[:_MAX_GMSH_ELEMENT_TYPE_DIAGNOSTIC_ENTRIES],
            "types_truncated": len(entries) > _MAX_GMSH_ELEMENT_TYPE_DIAGNOSTIC_ENTRIES,
        })
    return dimensions


def _observe_subdivision_types(gmsh, subdivide, destination):
    """Observe counts around the existing converter and preserve its behavior/errors."""
    snapshot = {
        "stage": "layered_prism_quad_subdivision",
        "interpretation": "Element type counts only; no element, node, or face inventory.",
    }
    try:
        snapshot["before"] = _gmsh_element_type_counts(gmsh)
    except Exception as error:
        snapshot["before_capture_error"] = f"{type(error).__name__}: {str(error)[:160]}"
    try:
        return subdivide(gmsh)
    finally:
        try:
            snapshot["after"] = _gmsh_element_type_counts(gmsh)
        except Exception as error:
            snapshot["after_capture_error"] = f"{type(error).__name__}: {str(error)[:160]}"
        try:
            if len(destination) < 8:
                destination.append(snapshot)
        except Exception:
            pass


def _gmsh_type_count(snapshot, phase, dimension, element_type):
    phase_data = snapshot.get(phase)
    if phase_data is None:
        return None
    for item in phase_data:
        if item["dimension"] == dimension:
            return sum(
                entry["count"]
                for entry in item["types"]
                if entry["gmsh_element_type"] == element_type
            )
    return None


def _assert_scoped_box_prisms_were_converted(diagnostics):
    conversions = [
        item for item in diagnostics
        if item.get("stage") == "layered_prism_quad_subdivision"
    ]
    assert len(conversions) == 1, diagnostics
    conversion = conversions[0]
    prism_count_before = _gmsh_type_count(conversion, "before", 3, 6)
    assert prism_count_before is not None and prism_count_before > 0, diagnostics
    prism_count_after = _gmsh_type_count(conversion, "after", 3, 6)
    assert prism_count_after == 0, diagnostics
    tetrahedron_count_after = _gmsh_type_count(conversion, "after", 3, 4)
    assert tetrahedron_count_after is not None and tetrahedron_count_after > 0, diagnostics


class _GmshApiConfigurationCapture:
    """Observe actual Gmsh setters and topology without changing their calls."""

    def __init__(self, destination):
        self.destination = destination
        self.fields = {}
        self.field_registration_call_count = 0
        self.field_registration_truncated = False
        self.field_setter_count = 0
        self.field_options_truncated = False
        self.background_field_tags = []
        self.background_field_tags_truncated = False
        self.mesh_option_set_calls = []
        self.mesh_option_set_count = 0
        self.mesh_option_number_names = set()

    def field_added(self, field_tag, field_type):
        self.field_registration_call_count += 1
        field_tag = int(field_tag)
        if field_tag not in self.fields and len(self.fields) >= _MAX_GMSH_DIAGNOSTIC_ITEMS:
            self.field_registration_truncated = True
            return
        self.fields[field_tag] = {
            "field_tag": field_tag,
            "field_type": _diagnostic_value(field_type),
            "configured_options": {},
        }

    def field_option_set(self, method, args):
        self.field_setter_count += 1
        if len(args) < 2:
            return
        field_tag, option_name = int(args[0]), str(args[1])
        field = self.fields.get(field_tag)
        if field is None:
            if len(self.fields) >= _MAX_GMSH_DIAGNOSTIC_ITEMS:
                self.field_options_truncated = True
                return
            field = {"field_tag": field_tag, "field_type": None, "configured_options": {}}
            self.fields[field_tag] = field
        if option_name not in field["configured_options"] and len(field["configured_options"]) >= 32:
            self.field_options_truncated = True
            return
        raw_value = args[2] if len(args) > 2 else None
        field["configured_options"][option_name] = {
            "setter": method,
            "value": _diagnostic_value(raw_value),
        }

    def mesh_option_set(self, method, args):
        if len(args) < 2 or not str(args[0]).startswith("Mesh."):
            return
        self.mesh_option_set_count += 1
        if method == "setNumber":
            self.mesh_option_number_names.add(str(args[0]))
        if len(self.mesh_option_set_calls) < _MAX_GMSH_DIAGNOSTIC_ITEMS:
            self.mesh_option_set_calls.append({
                "setter": method,
                "name": str(args[0]),
                "value": _diagnostic_value(args[1]),
            })

    @staticmethod
    def _surface_tags(boundary):
        return sorted({abs(int(tag)) for dim, tag in boundary if int(dim) == 2})

    def before_generate_3(self, gmsh):
        snapshot = {
            "stage": "immediately_before_gmsh_model_mesh_generate_3",
            "pointwise_field_values_evaluated": False,
            "interpretation": (
                "Configured values recorded after successful real Gmsh API calls; this is not "
                "a pointwise evaluation of any size field."
            ),
            "field_registration_call_count": self.field_registration_call_count,
            "field_setter_call_count": self.field_setter_count,
            "registered_field_count": 0,
            "registered_fields": [],
            "field_registrations_truncated": False,
            "field_options_truncated": self.field_options_truncated,
            "background_field_tags": list(self.background_field_tags),
            "background_field_tags_truncated": self.background_field_tags_truncated,
            "mesh_option_set_call_count": self.mesh_option_set_count,
            "mesh_option_set_calls": list(self.mesh_option_set_calls),
            "mesh_option_set_calls_truncated": (
                self.mesh_option_set_count > len(self.mesh_option_set_calls)
            ),
            "effective_mesh_options": {},
            "volumes": [],
            "volume_count": 0,
            "volume_bbox_coordinates": "Gmsh model units; this route scales SI lengths by 1e6",
            "gmsh_model_units_per_meter": 1.0e6,
            "volumes_truncated": False,
            "physical_groups": [],
            "body_volume_tags": [],
            "air_volume_tags": [],
            "body_air_shared_surface_tags": [],
            "body_air_connectivity_error": None,
        }
        try:
            field_api = gmsh.model.mesh.field
            field_ids = sorted(int(tag) for tag in field_api.list())
            snapshot["registered_field_count"] = len(field_ids)
            for field_tag in field_ids[:_MAX_GMSH_DIAGNOSTIC_ITEMS]:
                tracked = self.fields.get(field_tag, {
                    "field_tag": field_tag,
                    "field_type": None,
                    "configured_options": {},
                })
                snapshot["registered_fields"].append(tracked)
            snapshot["field_registrations_truncated"] = (
                self.field_registration_truncated
                or len(field_ids) > len(snapshot["registered_fields"])
            )

            option_api = gmsh.option
            for name in sorted(self.mesh_option_number_names):
                try:
                    snapshot["effective_mesh_options"][name] = _diagnostic_value(
                        option_api.getNumber(name)
                    )
                except Exception as error:
                    snapshot["effective_mesh_options"][name] = {
                        "unavailable": f"{type(error).__name__}: {str(error)[:160]}"
                    }

            model = gmsh.model
            volume_tags = sorted(
                int(tag) for dim, tag in model.getEntities(3) if int(dim) == 3
            )
            snapshot["volume_count"] = len(volume_tags)
            group_entities = {}
            for dim, group_tag in model.getPhysicalGroups():
                dim, group_tag = int(dim), int(group_tag)
                if dim not in (2, 3):
                    continue
                name = str(model.getPhysicalName(dim, group_tag))
                entity_tags = sorted(
                    int(tag) for tag in model.getEntitiesForPhysicalGroup(dim, group_tag)
                )
                group = {
                    "dimension": dim,
                    "physical_tag": group_tag,
                    "name": name,
                    "entity_tags": entity_tags[:_MAX_GMSH_DIAGNOSTIC_ITEMS],
                    "entities_truncated": len(entity_tags) > _MAX_GMSH_DIAGNOSTIC_ITEMS,
                }
                if len(snapshot["physical_groups"]) < _MAX_GMSH_DIAGNOSTIC_ITEMS:
                    snapshot["physical_groups"].append(group)
                if dim == 3:
                    group_entities[name] = entity_tags

            body_tags = group_entities.get("magnetic", [])
            air_tags = group_entities.get("air", [])
            snapshot["body_volume_tags"] = body_tags[:_MAX_GMSH_DIAGNOSTIC_ITEMS]
            snapshot["air_volume_tags"] = air_tags[:_MAX_GMSH_DIAGNOSTIC_ITEMS]
            snapshot["body_volume_tags_truncated"] = len(body_tags) > _MAX_GMSH_DIAGNOSTIC_ITEMS
            snapshot["air_volume_tags_truncated"] = len(air_tags) > _MAX_GMSH_DIAGNOSTIC_ITEMS
            body_and_air = set(body_tags) | set(air_tags)

            volumes = []
            for volume_tag in volume_tags[:_MAX_GMSH_DIAGNOSTIC_ITEMS]:
                bbox = [float(value) for value in model.getBoundingBox(3, volume_tag)]
                role = (
                    "magnetic" if volume_tag in body_tags
                    else "air" if volume_tag in air_tags
                    else "unclassified"
                )
                volumes.append({
                    "volume_tag": volume_tag,
                    "role": role,
                    "bbox_gmsh_model_units": bbox,
                    "bbox_m": [value * 1.0e-6 for value in bbox],
                })
            snapshot["volumes"] = volumes
            snapshot["volumes_truncated"] = len(volume_tags) > len(volumes)
            snapshot["unclassified_volume_tags"] = sorted(set(volume_tags) - body_and_air)[
                :_MAX_GMSH_DIAGNOSTIC_ITEMS
            ]

            if body_tags and air_tags:
                body_boundary = self._surface_tags(model.getBoundary(
                    [(3, tag) for tag in body_tags], combined=True, oriented=False,
                ))
                air_boundary = self._surface_tags(model.getBoundary(
                    [(3, tag) for tag in air_tags], combined=True, oriented=False,
                ))
                shared = sorted(set(body_boundary) & set(air_boundary))
                snapshot["body_air_shared_surface_tags"] = shared[:_MAX_GMSH_DIAGNOSTIC_ITEMS]
                snapshot["body_air_shared_surface_count"] = len(shared)
                snapshot["body_air_shared_surfaces_truncated"] = (
                    len(shared) > _MAX_GMSH_DIAGNOSTIC_ITEMS
                )
            else:
                snapshot["body_air_connectivity_error"] = (
                    "physical groups named 'magnetic' and 'air' were not both found"
                )
        except Exception as error:
            snapshot["capture_error"] = f"{type(error).__name__}: {str(error)[:240]}"
        self.destination.append(snapshot)


class _GmshFieldApiDiagnosticProxy:
    def __init__(self, actual, capture):
        self._actual = actual
        self._capture = capture

    def __getattr__(self, name):
        method = getattr(self._actual, name)
        if name == "add":
            def add(*args, **kwargs):
                field_tag = method(*args, **kwargs)
                field_type = args[0] if args else kwargs.get("field_type")
                self._capture.field_added(field_tag, field_type)
                return field_tag
            return add
        if name in ("setNumber", "setNumbers", "setString"):
            def set_option(*args, **kwargs):
                result = method(*args, **kwargs)
                self._capture.field_option_set(name, args)
                return result
            return set_option
        if name == "setAsBackgroundMesh":
            def set_background(*args, **kwargs):
                result = method(*args, **kwargs)
                if args:
                    if len(self._capture.background_field_tags) < _MAX_GMSH_DIAGNOSTIC_ITEMS:
                        self._capture.background_field_tags.append(int(args[0]))
                    else:
                        self._capture.background_field_tags_truncated = True
                return result
            return set_background
        return method


class _GmshMeshApiDiagnosticProxy:
    def __init__(self, actual, gmsh, capture):
        self._actual = actual
        self._gmsh = gmsh
        self._capture = capture

    def __getattr__(self, name):
        if name == "field":
            return _GmshFieldApiDiagnosticProxy(self._actual.field, self._capture)
        if name == "generate":
            def generate(*args, **kwargs):
                dimension = args[0] if args else kwargs.get("dim")
                if dimension == 3:
                    try:
                        self._capture.before_generate_3(self._gmsh)
                    except Exception as error:
                        self._capture.destination.append({
                            "stage": "immediately_before_gmsh_model_mesh_generate_3",
                            "pointwise_field_values_evaluated": False,
                            "capture_error": f"{type(error).__name__}: {str(error)[:240]}",
                        })
                return getattr(self._actual, name)(*args, **kwargs)
            return generate
        return getattr(self._actual, name)


class _GmshModelApiDiagnosticProxy:
    def __init__(self, actual, gmsh, capture):
        self._actual = actual
        self._gmsh = gmsh
        self._capture = capture

    def __getattr__(self, name):
        if name == "mesh":
            return _GmshMeshApiDiagnosticProxy(self._actual.mesh, self._gmsh, self._capture)
        return getattr(self._actual, name)


class _GmshOptionApiDiagnosticProxy:
    def __init__(self, actual, capture):
        self._actual = actual
        self._capture = capture

    def __getattr__(self, name):
        method = getattr(self._actual, name)
        if name in ("setNumber", "setString"):
            def set_option(*args, **kwargs):
                result = method(*args, **kwargs)
                self._capture.mesh_option_set(name, args)
                return result
            return set_option
        return method


class _GmshApiDiagnosticProxy:
    def __init__(self, actual, capture):
        self._actual = actual
        self._capture = capture

    def __getattr__(self, name):
        if name == "model":
            return _GmshModelApiDiagnosticProxy(self._actual.model, self._actual, self._capture)
        if name == "option":
            return _GmshOptionApiDiagnosticProxy(self._actual.option, self._capture)
        return getattr(self._actual, name)


def _gmsh_realization_failure_diagnostic_line(snapshots, fixture_name, error):
    prefix = "GMSH_REALIZATION_DIAGNOSTICS: "
    payload = {
        "evidence_kind": "configured Gmsh API values and bounded mesh realization observations",
        "pointwise_field_values_evaluated": False,
        "fixture_name": str(fixture_name)[:128],
        "exception_type": type(error).__name__[:128],
        "exception_message": str(error)[:512],
        "snapshot_count": len(snapshots),
        "snapshots": snapshots,
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False)
    if len((prefix + encoded + "\n").encode("utf-8")) <= _MAX_BODY_XY_DIAGNOSTIC_BYTES:
        return prefix + encoded

    summary = {
        "evidence_kind": payload["evidence_kind"],
        "pointwise_field_values_evaluated": False,
        "fixture_name": payload["fixture_name"],
        "exception_type": payload["exception_type"],
        "exception_message": payload["exception_message"],
        "snapshot_count": len(snapshots),
        "truncated": True,
        "serialized_bytes_before_truncation": len(encoded.encode("utf-8")),
        "capture_summaries": [
            {
                "stage": str(snapshot.get("stage", ""))[:128],
                "capture_error": str(snapshot.get("capture_error", ""))[:256] or None,
                "field_registration_call_count": snapshot.get("field_registration_call_count"),
                "registered_field_count": snapshot.get("registered_field_count"),
                "field_setter_call_count": snapshot.get("field_setter_call_count"),
                "mesh_option_set_call_count": snapshot.get("mesh_option_set_call_count"),
                "volume_count": snapshot.get("volume_count"),
            }
            for snapshot in snapshots[:8]
            if isinstance(snapshot, dict)
        ],
    }
    encoded = json.dumps(summary, sort_keys=True, separators=(",", ":"), allow_nan=False)
    if len((prefix + encoded + "\n").encode("utf-8")) > _MAX_BODY_XY_DIAGNOSTIC_BYTES:
        encoded = json.dumps({
            "evidence_kind": payload["evidence_kind"],
            "pointwise_field_values_evaluated": False,
            "fixture_name": payload["fixture_name"],
            "exception_type": payload["exception_type"],
            "snapshot_count": len(snapshots),
            "truncated": True,
        }, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return prefix + encoded


def _realize_public_de_smoke_box(
    monkeypatch, tmp_path, *, universe_mesh_call, fixture_name, gmsh_diagnostics=None,
):
    source_path = Path(__file__).resolve().parents[1] / "examples/fem_de_smoke_numeric.py"
    source = source_path.read_text(encoding="utf-8")
    authored_mesh_call = (
        'study.universe.mesh(maximum_element_size=100e-9,\n'
        '                    maximum_element_growth_rate=AIR_GROWTH_RATE, grading="geometric")'
    )
    assert source.count(authored_mesh_call) == 1
    call_start = source.index(authored_mesh_call)
    line_start = source.rfind("\n", 0, call_start) + 1
    call_indentation = source[line_start:call_start]
    if call_indentation.strip():
        raise AssertionError("authored universe mesh call must be the only statement on its line")
    fixture_mesh_calls = (
        'study.objects.mesh.defaults(maximum_element_size=10e-9, '
        'periodic_pair_ids=["x_faces", "y_faces"])\n'
        + call_indentation
        + universe_mesh_call
    )
    fixture_source = source.replace(authored_mesh_call, fixture_mesh_calls, 1)
    fixture_path = tmp_path / fixture_name
    ast.parse(fixture_source, filename=str(fixture_path))

    import fullmag as fm
    from fullmag.meshing.asset_pipeline import realize_fem_domain_mesh_asset_from_components_with_report

    monkeypatch.setenv("FULLMAG_DE_SMOKE_THICKNESS_LAYERS", "6")
    fm.reset()
    try:
        fixture_path.write_text(fixture_source, encoding="utf-8")
        problem = fm.load_problem_from_script(
            fixture_path, lightweight_assets=True,
        ).stages[-1].problem
        ir = problem.to_ir(
            requested_backend="fem", execution_mode="strict",
            execution_precision="double", include_geometry_assets=False,
        )
        meta = ir["problem_meta"]["runtime_metadata"]
        realize = lambda: realize_fem_domain_mesh_asset_from_components_with_report(
            geometries=[Box(size=(40e-9, 40e-9, 10e-9), name="film")],
            hints=fm.FEM(order=1, hmax=10e-9),
            study_universe=meta["study_universe"],
            mesh_workflow=meta["mesh_workflow"],
        )
        capture_snapshots = gmsh_diagnostics if gmsh_diagnostics is not None else []
        capture = _GmshApiConfigurationCapture(capture_snapshots)
        actual_import_gmsh = _gmsh_swept_module._import_gmsh
        from fullmag.meshing import _gmsh_layered_tetrahedra

        actual_subdivide = _gmsh_layered_tetrahedra.subdivide_layered_prisms
        with monkeypatch.context() as gmsh_patch:
            gmsh_patch.setattr(
                _gmsh_layered_tetrahedra,
                "subdivide_layered_prisms",
                lambda gmsh: _observe_subdivision_types(
                    gmsh, actual_subdivide, capture_snapshots,
                ),
            )
            gmsh_patch.setattr(
                _gmsh_swept_module,
                "_import_gmsh",
                lambda: _GmshApiDiagnosticProxy(actual_import_gmsh(), capture),
            )
            try:
                return realize()
            except Exception as error:
                try:
                    print(
                        _gmsh_realization_failure_diagnostic_line(
                            capture_snapshots, fixture_name, error,
                        ),
                        file=sys.stderr,
                        flush=True,
                    )
                except Exception:
                    try:
                        print(
                            "GMSH_REALIZATION_DIAGNOSTICS: " + json.dumps({
                                "evidence_kind": "configured Gmsh API capture unavailable",
                                "pointwise_field_values_evaluated": False,
                                "snapshot_count": len(capture_snapshots),
                                "truncated": True,
                            }, sort_keys=True, separators=(",", ":")),
                            file=sys.stderr,
                            flush=True,
                        )
                    except Exception:
                        pass
                raise
    finally:
        fm.reset()


def _assert_public_box_planes(mesh, *, layers, expected, maximum_air_step):
    nodes = np.asarray(mesh.nodes)
    cells = np.asarray(mesh.elements)
    markers = np.asarray(mesh.element_markers)
    actual = np.unique(np.round(nodes[:, 2], decimals=17))
    np.testing.assert_allclose(actual, expected, atol=1e-16, rtol=0)
    assert actual[0] == pytest.approx(-_PUBLIC_DE_AIRBOX_HALF_HEIGHT_M, abs=1e-16)
    assert actual[-1] == pytest.approx(_PUBLIC_DE_AIRBOX_HALF_HEIGHT_M, abs=1e-16)
    assert np.all(np.diff(actual) > 0)

    body = cells[markers == 1]
    body_z = nodes[body, 2]
    assert len(np.unique(np.round(body_z.reshape(-1), 17))) == layers + 1
    assert np.max(np.ptp(body_z, axis=1)) <= 10e-9 / layers + 1e-15

    xyz = nodes[cells]
    volumes = np.linalg.det(xyz[:, 1:] - xyz[:, :1]) / 6
    assert np.all(volumes > 0)
    air = markers == 0
    air_z_spans = np.ptp(xyz[air, :, 2], axis=1)
    assert np.max(air_z_spans) <= maximum_air_step * (1 + 1e-12)


def test_graded_planes_keep_film_and_outer_bounds():
    levels = _box_airbox_layer_levels(-5e-9, 5e-9, -2.005e-6, 2.005e-6,
                                    6, h_inner=10e-9/6, h_outer=100e-9, growth=1.3)
    assert levels[0] == -2.005e-6 and levels[-1] == 2.005e-6
    assert np.all(np.diff(levels) > 0)
    film = [z for z in levels if -5e-9 <= z <= 5e-9]
    assert len(film) == 7
    assert np.max(np.diff(levels)) <= 100e-9 * (1 + 1e-12)


def test_box_airbox_layer_plan_closes_roundoff_sized_final_slab():
    levels = _box_airbox_layer_levels(
        -5e-9, 5e-9, -205e-9, 205e-9, 3,
        h_inner=5e-9, h_outer=5e-9, growth=1.3,
    )
    split = levels.index(-5e-9)
    lower_intervals = np.diff([*levels[:split], -5e-9])
    upper_intervals = np.diff([5e-9, *levels[split + 4:]])

    assert len(lower_intervals) == 40
    assert len(upper_intervals) == 40
    assert levels[0] == -205e-9
    assert levels[-1] == 205e-9
    assert np.all(lower_intervals > 0.9 * 5e-9)
    assert np.all(upper_intervals > 0.9 * 5e-9)
    np.testing.assert_allclose(lower_intervals, 5e-9, rtol=0, atol=1e-20)
    np.testing.assert_allclose(upper_intervals, 5e-9, rtol=0, atol=1e-20)


def test_box_airbox_layer_plan_allows_resolvable_offset_coordinates():
    body_bottom = 1000.0
    body_top = 1000.0 + 1e-9
    zmax = body_top + 1e-7 + 5e-12
    h_inner = 1e-10
    levels = _box_airbox_layer_levels(
        body_bottom, body_top, body_bottom - 1e-7, zmax, 3,
        h_inner=h_inner, h_outer=h_inner, growth=1.3,
    )
    split = levels.index(body_top)
    upper_intervals = np.diff([body_top, *levels[split + 1:]])
    coordinate_scale = max(abs(body_top), abs(zmax), abs(zmax - body_top))
    local_ulp = math.ulp(coordinate_scale)
    relative_scale = max(abs(zmax - body_top), h_inner)
    relative_ulp = math.ulp(relative_scale)
    roundoff_bound = (
        2 * local_ulp + 4 * (len(upper_intervals) + 2) * relative_ulp
    )
    old_origin_scaled_bound = (len(upper_intervals) + 2) * local_ulp
    authored_remainder = math.fsum(
        [zmax - body_top, *([-h_inner] * (len(upper_intervals) - 1))]
    )

    assert 900 < len(upper_intervals) < 1100
    assert levels[-1] == zmax
    assert local_ulp < h_inner <= old_origin_scaled_bound
    assert np.all(upper_intervals > 0)
    assert roundoff_bound < upper_intervals[-1] < h_inner
    assert abs(upper_intervals[-1] - authored_remainder) <= roundoff_bound
    assert np.max(upper_intervals) <= h_inner + roundoff_bound


@pytest.mark.parametrize("layers", [3, 6, 9])
def test_real_mesh_keeps_requested_film_planes_and_periodic_air(layers):
    pytest.importorskip("gmsh")
    box = Box(size=(40e-9, 40e-9, 10e-9))
    opts = MeshOptions(mesh_strategy="thin_film_tetrahedral",
                       through_thickness_elements=layers, periodic_pair_ids=["x_faces", "y_faces"])
    air = AirboxOptions(size=(40e-9, 40e-9, 410e-9),
                        maximum_element_size=50e-9, grading_ratio=1.3)
    assert should_use_swept(box, opts)
    mesh = generate_swept_tetrahedral_box_airbox_mesh(
        box, 10e-9, layers, order=1, distribution="fixed", recombine=False,
        airbox=air, options=opts)
    assert set(mesh.cell_types.tolist()) == {"tet4"}
    assert set(mesh.facet_types.tolist()) == {"tri3"}
    nodes = np.asarray(mesh.nodes)
    cells = np.asarray(mesh.elements)
    body = cells[np.asarray(mesh.element_markers) == 1]
    xyz = nodes[body]
    assert np.max(np.ptp(xyz[:, :, 2], axis=1)) <= 10e-9/layers + 1e-15
    assert len(np.unique(np.round(xyz[:, :, 2].reshape(-1), decimals=17))) == layers + 1
    matrices = xyz[:, 1:] - xyz[:, :1]
    assert np.all(np.abs(np.linalg.det(matrices)) > 0)
    assert mesh.periodic_boundary_pairs
    assert mesh.periodic_node_pairs
    # Every side-plane vertex, including both exterior air slabs, participates.
    for pair_id, axis in (("x_faces", 0), ("y_faces", 1)):
        required = set(np.flatnonzero(np.isclose(np.abs(nodes[:, axis]), 20e-9, rtol=0, atol=1e-16)))
        mapped = {int(pair[key]) for pair in mesh.periodic_node_pairs
                  if pair["pair_id"] == pair_id for key in ("node_a", "node_b")}
        assert required <= mapped


@pytest.mark.parametrize("kwargs", [dict(n_layers=0), dict(growth=.5), dict(h_inner=0), dict(zmin=-5e-9)])
def test_invalid_plane_plan_fails(kwargs):
    args = dict(body_bottom=-5e-9, body_top=5e-9, zmin=-205e-9, zmax=205e-9,
                n_layers=3, h_inner=3e-9, h_outer=50e-9, growth=1.3)
    args.update(kwargs)
    with pytest.raises(ValueError):
        _box_airbox_layer_levels(**args)



def test_public_de_model_shared_domain_realizes_six_layers(monkeypatch):
    import fullmag as fm
    from fullmag.meshing.asset_pipeline import realize_fem_domain_mesh_asset_from_components_with_report
    monkeypatch.setenv("FULLMAG_DE_SMOKE_THICKNESS_LAYERS", "6")
    fm.reset()
    try:
        problem = fm.load_problem_from_script(Path(__file__).resolve().parents[1] / "examples/fem_de_smoke_numeric.py", lightweight_assets=True).stages[-1].problem
        ir = problem.to_ir(requested_backend="fem", execution_mode="strict", execution_precision="double", include_geometry_assets=False)
        meta = ir["problem_meta"]["runtime_metadata"]
        from fullmag.meshing import _gmsh_layered_tetrahedra
        actual_subdivide = _gmsh_layered_tetrahedra.subdivide_layered_prisms
        gmsh_diagnostics = []
        monkeypatch.setattr(
            _gmsh_layered_tetrahedra,
            "subdivide_layered_prisms",
            lambda gmsh: _observe_subdivision_types(
                gmsh, actual_subdivide, gmsh_diagnostics,
            ),
        )
        mesh, markers, report = realize_fem_domain_mesh_asset_from_components_with_report(
            geometries=[Box(size=(40e-9, 40e-9, 10e-9), name="film")],
            hints=fm.FEM(order=1, hmax=10e-9), study_universe=meta["study_universe"],
            mesh_workflow=meta["mesh_workflow"])
        _assert_scoped_box_prisms_were_converted(gmsh_diagnostics)
        assert report.build_mode == "single_geometry_geo_layered_box"
        status = next(s for s in report.operation_statuses if s.kind == "thin_film")
        assert status.actual_method == "geo_layer_partitioned_tetrahedral"
        assert status.details["resolved_sweep_direction"] == "z"
        diagnostic = report.to_dict()["thin_film_diagnostics"][0]
        assert diagnostic["actual_method"] == "geo_layer_partitioned_tetrahedral"
        assert not any("maximum element size" in w for w in diagnostic["warnings"])
        assert markers == [{"geometry_name": "film", "marker": 1}]
        body = np.asarray(mesh.elements)[np.asarray(mesh.element_markers) == 1]
        z = np.asarray(mesh.nodes)[body, 2]
        assert np.max(np.ptp(z, axis=1)) <= 10e-9/6 + 1e-15
        assert len(np.unique(np.round(z.reshape(-1), 17))) == 7
    finally:
        fm.reset()


def _body_xy_failure_diagnostics(mesh, report, reference, reference_report,
                                 body_xy, reference_body_xy, gmsh_diagnostics=None):
    # Diagnostics must never replace the original strict comparison failure.
    try:
        return _body_xy_failure_diagnostics_impl(
            mesh, report, reference, reference_report, body_xy, reference_body_xy,
            gmsh_diagnostics,
        )
    except Exception as error:
        return f"BODY_XY_DIAGNOSTICS unavailable: {type(error).__name__}: {str(error)[:300]}"


def _body_xy_failure_diagnostics_impl(mesh, report, reference, reference_report,
                                      body_xy, reference_body_xy, gmsh_diagnostics=None):
    """Describe existing meshes only; hashes are diagnostics, not provenance."""
    def metrics(candidate, candidate_report, xy):
        nodes = np.asarray(candidate.nodes)
        body = np.asarray(candidate.elements)[np.asarray(candidate.element_markers) == 1]
        body_ids = np.unique(body)
        edge_indices = np.asarray(((0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3)))
        edges = np.unique(np.sort(body[:, edge_indices].reshape(-1, 2), axis=1), axis=0)
        projected_lengths = np.linalg.norm(nodes[edges[:, 1], :2] - nodes[edges[:, 0], :2], axis=1)
        nonzero_lengths = projected_lengths[projected_lengths > 0.0]
        rounded_xy = [list(map(float, point)) for point in sorted(xy)]
        xy_bytes = json.dumps(rounded_xy, separators=(",", ":"), allow_nan=False).encode("utf-8")
        report_data = candidate_report.to_dict()
        targets = report_data.get("effective_per_object_targets", {})
        return {
            "body_tet_count": int(len(body)),
            "body_node_count": int(len(body_ids)),
            "body_xy_count": int(len(xy)),
            "rounded_body_xy_sha256": hashlib.sha256(xy_bytes).hexdigest(),
            "projected_tet_edge_p50_p95_max_m": (
                [float(np.percentile(nonzero_lengths, 50)),
                 float(np.percentile(nonzero_lengths, 95)), float(np.max(nonzero_lengths))]
                if len(nonzero_lengths) else None
            ),
            "owner_targets": targets.get("film") if isinstance(targets, dict) else targets,
            "build_mode": report_data.get("build_mode"),
            "used_size_field_kinds": report_data.get("used_size_field_kinds"),
            "effective_airbox_target": report_data.get("effective_airbox_target"),
            "size_fields_realized": [
                {key: field[key] for key in ("role", "kind", "target", "status", "source", "reason")
                 if key in field}
                for field in report_data.get("size_fields_realized", [])
            ],
        }

    extra = sorted(body_xy - reference_body_xy)
    missing = sorted(reference_body_xy - body_xy)
    diagnostic = {
        "candidate": metrics(mesh, report, body_xy),
        "reference": metrics(reference, reference_report, reference_body_xy),
        "extra_xy_count": len(extra), "missing_xy_count": len(missing),
        "extra_xy_first_12_m": [list(map(float, point)) for point in extra[:12]],
        "missing_xy_first_12_m": [list(map(float, point)) for point in missing[:12]],
    }
    if gmsh_diagnostics is not None:
        configuration = {
            "evidence_kind": "configured Gmsh API values immediately before mesh.generate(3)",
            "pointwise_field_values_evaluated": False,
            "snapshots": gmsh_diagnostics,
        }
        encoded_configuration = json.dumps(
            configuration, sort_keys=True, separators=(",", ":"), allow_nan=False,
        )
        if len(encoded_configuration.encode("utf-8")) <= 48 * 1024:
            diagnostic["gmsh_api_configuration"] = configuration
        else:
            diagnostic["gmsh_api_configuration"] = {
                "evidence_kind": configuration["evidence_kind"],
                "pointwise_field_values_evaluated": False,
                "truncated": True,
                "serialized_bytes_before_truncation": len(encoded_configuration.encode("utf-8")),
                "capture_summaries": [
                    {
                        "fixture_role": role,
                        "snapshot_count": len(snapshots),
                        "snapshot_counts": [
                            {
                                "stage": snapshot.get("stage"),
                                "registered_field_count": snapshot.get("registered_field_count"),
                                "mesh_option_set_call_count": snapshot.get("mesh_option_set_call_count"),
                                "volume_count": snapshot.get("volume_count"),
                                "body_air_shared_surface_count": snapshot.get(
                                    "body_air_shared_surface_count"
                                ),
                                "capture_error": snapshot.get("capture_error"),
                            }
                            for snapshot in snapshots[:8]
                        ],
                    }
                    for role, snapshots in gmsh_diagnostics.items()
                ],
            }
    encoded_diagnostic = json.dumps(diagnostic, sort_keys=True, allow_nan=False)
    if len(encoded_diagnostic.encode("utf-8")) > _MAX_BODY_XY_DIAGNOSTIC_BYTES:
        diagnostic = {
            "diagnostic_truncated": True,
            "serialized_bytes_before_truncation": len(encoded_diagnostic.encode("utf-8")),
            "candidate": {
                key: diagnostic["candidate"].get(key)
                for key in ("body_tet_count", "body_node_count", "body_xy_count", "rounded_body_xy_sha256")
            },
            "reference": {
                key: diagnostic["reference"].get(key)
                for key in ("body_tet_count", "body_node_count", "body_xy_count", "rounded_body_xy_sha256")
            },
            "extra_xy_count": diagnostic["extra_xy_count"],
            "missing_xy_count": diagnostic["missing_xy_count"],
            "gmsh_api_configuration": diagnostic.get("gmsh_api_configuration", {
                "unavailable": "configuration was not supplied"
            }),
        }
        encoded_diagnostic = json.dumps(diagnostic, sort_keys=True, allow_nan=False)
    return "BODY_XY_DIAGNOSTICS: " + encoded_diagnostic


def test_public_box_default_airbox_cap_realizes_geometric_vertical_growth(monkeypatch, tmp_path):
    pytest.importorskip("gmsh")
    h_inner = 10e-9
    growth = 1.3
    h_outer = h_inner * growth**4
    expected = _box_airbox_layer_levels(
        -5e-9, 5e-9,
        -_PUBLIC_DE_AIRBOX_HALF_HEIGHT_M, _PUBLIC_DE_AIRBOX_HALF_HEIGHT_M, 6,
        h_inner=h_inner, h_outer=h_outer, growth=growth,
    )
    candidate_gmsh_diagnostics = []
    mesh, markers, report = _realize_public_de_smoke_box(
        monkeypatch, tmp_path, universe_mesh_call="study.universe.mesh()",
        fixture_name="implicit_airbox_cap.py",
        gmsh_diagnostics=candidate_gmsh_diagnostics,
    )
    _assert_scoped_box_prisms_were_converted(candidate_gmsh_diagnostics)
    assert report.build_mode == "single_geometry_geo_layered_box"
    assert markers == [{"geometry_name": "film", "marker": 1}]
    _assert_public_box_planes(
        mesh, layers=6, expected=expected, maximum_air_step=h_outer,
    )
    positive_steps = np.diff(np.asarray(expected)[np.asarray(expected) >= 5e-9])
    assert positive_steps[0] == pytest.approx(h_inner, rel=1e-12)
    assert positive_steps[1] == pytest.approx(h_inner * growth, rel=1e-12)
    assert np.max(positive_steps) > h_inner

    # Raising only the implicit airbox cap must not coarsen the body source face.
    reference_gmsh_diagnostics = []
    reference, _, reference_report = _realize_public_de_smoke_box(
        monkeypatch, tmp_path,
        universe_mesh_call="study.universe.mesh(maximum_element_size=10e-9)",
        fixture_name="body_hmax_airbox_cap.py",
        gmsh_diagnostics=reference_gmsh_diagnostics,
    )
    _assert_scoped_box_prisms_were_converted(reference_gmsh_diagnostics)
    body_ids = np.unique(np.asarray(mesh.elements)[np.asarray(mesh.element_markers) == 1])
    reference_body_ids = np.unique(
        np.asarray(reference.elements)[np.asarray(reference.element_markers) == 1]
    )
    body_xy = set(map(tuple, np.round(np.asarray(mesh.nodes)[body_ids, :2], 17)))
    reference_body_xy = set(
        map(tuple, np.round(np.asarray(reference.nodes)[reference_body_ids, :2], 17))
    )
    assert body_xy == reference_body_xy, _body_xy_failure_diagnostics(
        mesh, report, reference, reference_report, body_xy, reference_body_xy,
        gmsh_diagnostics={
            "candidate": candidate_gmsh_diagnostics,
            "reference": reference_gmsh_diagnostics,
        },
    )


def test_public_box_explicit_airbox_cap_below_body_hmax_is_preserved(monkeypatch, tmp_path):
    pytest.importorskip("gmsh")
    cap = 5e-9
    expected = _box_airbox_layer_levels(
        -5e-9, 5e-9,
        -_PUBLIC_DE_AIRBOX_HALF_HEIGHT_M, _PUBLIC_DE_AIRBOX_HALF_HEIGHT_M, 6,
        h_inner=cap, h_outer=cap, growth=1.3,
    )
    gmsh_diagnostics = []
    mesh, _, report = _realize_public_de_smoke_box(
        monkeypatch, tmp_path,
        universe_mesh_call=f"study.universe.mesh(maximum_element_size={cap!r})",
        fixture_name="small_explicit_airbox_cap.py",
        gmsh_diagnostics=gmsh_diagnostics,
    )
    _assert_scoped_box_prisms_were_converted(gmsh_diagnostics)
    assert report.build_mode == "single_geometry_geo_layered_box"
    _assert_public_box_planes(
        mesh, layers=6, expected=expected, maximum_air_step=cap,
    )


def test_public_box_explicit_airbox_minimum_above_body_hmax_is_preserved(monkeypatch, tmp_path):
    pytest.importorskip("gmsh")
    h_inner = 15e-9
    growth = 1.3
    h_outer = h_inner * growth**4
    expected = _box_airbox_layer_levels(
        -5e-9, 5e-9,
        -_PUBLIC_DE_AIRBOX_HALF_HEIGHT_M, _PUBLIC_DE_AIRBOX_HALF_HEIGHT_M, 6,
        h_inner=h_inner, h_outer=h_outer, growth=growth,
    )
    candidate_gmsh_diagnostics = []
    mesh, _, report = _realize_public_de_smoke_box(
        monkeypatch, tmp_path,
        universe_mesh_call="study.universe.mesh(minimum_element_size=15e-9)",
        fixture_name="explicit_airbox_minimum.py",
        gmsh_diagnostics=candidate_gmsh_diagnostics,
    )
    _assert_scoped_box_prisms_were_converted(candidate_gmsh_diagnostics)
    assert report.build_mode == "single_geometry_geo_layered_box"
    _assert_public_box_planes(
        mesh, layers=6, expected=expected, maximum_air_step=h_outer,
    )
    reference_gmsh_diagnostics = []
    reference, _, reference_report = _realize_public_de_smoke_box(
        monkeypatch, tmp_path,
        universe_mesh_call="study.universe.mesh(maximum_element_size=10e-9)",
        fixture_name="body_hmax_reference.py",
        gmsh_diagnostics=reference_gmsh_diagnostics,
    )
    _assert_scoped_box_prisms_were_converted(reference_gmsh_diagnostics)
    body_ids = np.unique(np.asarray(mesh.elements)[np.asarray(mesh.element_markers) == 1])
    reference_body_ids = np.unique(
        np.asarray(reference.elements)[np.asarray(reference.element_markers) == 1]
    )
    body_xy = set(map(tuple, np.round(np.asarray(mesh.nodes)[body_ids, :2], 17)))
    reference_body_xy = set(
        map(tuple, np.round(np.asarray(reference.nodes)[reference_body_ids, :2], 17))
    )
    assert body_xy == reference_body_xy, _body_xy_failure_diagnostics(
        mesh, report, reference, reference_report, body_xy, reference_body_xy,
        gmsh_diagnostics={
            "candidate": candidate_gmsh_diagnostics,
            "reference": reference_gmsh_diagnostics,
        },
    )


def test_box_airbox_invalid_targets_fail_before_gmsh(monkeypatch):
    import fullmag.meshing._gmsh_swept as swept

    def forbidden_gmsh_import():
        pytest.fail("invalid airbox size controls must fail before Gmsh initialization")

    monkeypatch.setattr(swept, "_import_gmsh", forbidden_gmsh_import)
    with pytest.raises(ValueError, match="minimum_element_size.*maximum_element_size"):
        generate_swept_tetrahedral_box_airbox_mesh(
            Box(size=(40e-9, 40e-9, 10e-9)), 10e-9, 6, order=1,
            distribution="fixed", recombine=False,
            airbox=AirboxOptions(
                size=(40e-9, 40e-9, 410e-9),
                minimum_element_size=10e-9,
                maximum_element_size=5e-9,
            ),
            options=MeshOptions(mesh_strategy="thin_film_tetrahedral"),
        )
    with pytest.raises(ValueError, match="implicit airbox outer element size.*finite"):
        generate_swept_tetrahedral_box_airbox_mesh(
            Box(size=(40e-9, 40e-9, 10e-9)), 10e-9, 6, order=1,
            distribution="fixed", recombine=False,
            airbox=AirboxOptions(
                size=(40e-9, 40e-9, 410e-9), grading_ratio=1e100,
            ),
            options=MeshOptions(mesh_strategy="thin_film_tetrahedral"),
        )
    with pytest.raises(ValueError, match="scaled Box body maximum element size.*finite"):
        generate_swept_tetrahedral_box_airbox_mesh(
            Box(size=(40e-9, 40e-9, 10e-9)), 1e303, 6, order=1,
            distribution="fixed", recombine=False,
            airbox=AirboxOptions(
                size=(40e-9, 40e-9, 410e-9), grading_ratio=1.01,
            ),
            options=MeshOptions(mesh_strategy="thin_film_tetrahedral"),
        )
    with pytest.raises(ValueError, match="scaled Box airbox element sizes.*finite"):
        generate_swept_tetrahedral_box_airbox_mesh(
            Box(size=(40e-9, 40e-9, 10e-9)), 10e-9, 6, order=1,
            distribution="fixed", recombine=False,
            airbox=AirboxOptions(
                size=(40e-9, 40e-9, 410e-9),
                maximum_element_size=1e303,
            ),
            options=MeshOptions(mesh_strategy="thin_film_tetrahedral"),
        )
    with pytest.raises(ValueError, match="scaled Box body maximum element size.*finite"):
        generate_swept_tetrahedral_box_airbox_mesh(
            Box(size=(40e-9, 40e-9, 10e-9)), 1e303, 6, order=1,
            distribution="fixed", recombine=False,
            airbox=AirboxOptions(
                size=(40e-9, 40e-9, 410e-9),
                maximum_element_size=5e-9,
            ),
            options=MeshOptions(mesh_strategy="thin_film_tetrahedral"),
        )


def test_public_study_rejects_airbox_minimum_above_maximum():
    import fullmag as fm

    fm.reset()
    try:
        study = fm.study("invalid-airbox-size-targets")
        study.universe(mode="manual", size=(40e-9, 40e-9, 410e-9))
        with pytest.raises(
            ValueError, match="minimum_element_size must be <= maximum_element_size"
        ):
            study.universe.mesh(
                minimum_element_size=10e-9,
                maximum_element_size=5e-9,
            )
    finally:
        fm.reset()


def test_existing_ring_route_keeps_tetra_layers_and_full_periodic_sides():
    from fullmag.model.geometry import Cylinder
    from fullmag.meshing._gmsh_swept import generate_swept_box_cylinder_ring_mesh
    geometry = Box(size=(40e-9, 40e-9, 10e-9)) - Cylinder(radius=8e-9, height=10e-9)
    opts = MeshOptions(mesh_strategy="thin_film_tetrahedral", through_thickness_elements=3,
                       periodic_pair_ids=["x_faces", "y_faces"])
    mesh = generate_swept_box_cylinder_ring_mesh(
        geometry, 10e-9, 3, order=1, distribution="fixed", recombine=False,
        airbox=AirboxOptions(size=(40e-9, 40e-9, 410e-9)), options=opts)
    assert set(mesh.cell_types.tolist()) == {"tet4"}
    nodes = np.asarray(mesh.nodes)
    body = np.asarray(mesh.elements)[np.asarray(mesh.element_markers) == 1]
    assert len(np.unique(np.round(nodes[body, 2].reshape(-1), 17))) == 4
    for pair_id, axis in (("x_faces", 0), ("y_faces", 1)):
        required = set(np.flatnonzero(np.isclose(np.abs(nodes[:, axis]), 20e-9, rtol=0, atol=1e-16)))
        mapped = {int(pair[key]) for pair in mesh.periodic_node_pairs
                  if pair["pair_id"] == pair_id for key in ("node_a", "node_b")}
        assert required <= mapped


def test_film_refinement_keeps_exterior_plane_plan():
    def exterior(n):
        planes = _box_airbox_layer_levels(-5e-9, 5e-9, -205e-9, 205e-9, n,
                                          h_inner=10e-9, h_outer=50e-9, growth=1.3)
        return [z for z in planes if abs(z) > 5e-9]
    assert exterior(3) == exterior(6) == exterior(9)


@pytest.mark.parametrize("layers,hmax,mode,reason", [
    (0, 10e-9, "geometric", "positive integer"),
    (True, 10e-9, "geometric", "positive integer"),
    (3, float("nan"), "geometric", "finite and positive"),
    (3, 10e-9, "linear", "only geometric"),
])
def test_box_unsupported_controls_fail_before_gmsh(monkeypatch, layers, hmax, mode, reason):
    import fullmag.meshing._gmsh_swept as swept
    def forbidden():
        pytest.fail("invalid controls must fail before Gmsh initialization")
    monkeypatch.setattr(swept, "_import_gmsh", forbidden)
    with pytest.raises(ValueError, match=reason):
        generate_swept_tetrahedral_box_airbox_mesh(
            Box(size=(40e-9, 40e-9, 10e-9)), hmax, layers, order=1,
            distribution="fixed", recombine=False,
            airbox=AirboxOptions(size=(40e-9, 40e-9, 410e-9), grading_mode=mode),
            options=MeshOptions(mesh_strategy="thin_film_tetrahedral"))


def test_box_lateral_resolution_survives_final_air_fields():
    def mesh_at(hmax, layers):
        mesh = generate_swept_tetrahedral_box_airbox_mesh(
            Box(size=(40e-9, 40e-9, 10e-9)), hmax, layers, order=1,
            distribution="fixed", recombine=False,
            airbox=AirboxOptions(size=(40e-9,40e-9,410e-9),maximum_element_size=50e-9),
            options=MeshOptions(mesh_strategy="thin_film_tetrahedral",periodic_pair_ids=["x_faces","y_faces"]))
        xyz=np.asarray(mesh.nodes)[np.asarray(mesh.elements)]
        determinant=np.linalg.det(xyz[:,1:] - xyz[:,:1])
        assert np.all(determinant > 0)
        volumes=determinant/6
        assert volumes.sum() == pytest.approx(40e-9*40e-9*410e-9,rel=1e-12)
        body=np.asarray(mesh.element_markers)==1
        assert volumes[body].sum() == pytest.approx(40e-9*40e-9*10e-9,rel=1e-12)
        magnetic_nodes=np.unique(np.asarray(mesh.elements)[body])
        xy=np.asarray(mesh.nodes)[magnetic_nodes,:2]
        return mesh, set(map(tuple,np.round(xy,17)))
    coarse, coarse_xy=mesh_at(10e-9,3)
    fine, fine_xy=mesh_at(5e-9,3)
    thicker, thicker_xy=mesh_at(5e-9,6)
    assert len(coarse_xy)>4
    assert len(fine_xy)>len(coarse_xy)
    assert fine_xy == thicker_xy
    for mesh in (coarse, fine, thicker):
        for pair in mesh.periodic_node_pairs:
            axis=0 if pair["pair_id"]=="x_faces" else 1
            delta=np.asarray(mesh.nodes[pair["node_b"]])-np.asarray(mesh.nodes[pair["node_a"]])
            translation=np.zeros(3);translation[axis]=40e-9
            assert np.linalg.norm(delta-translation)<1e-18
            for k in (25e6,-25e6):
                phase=np.exp(-1j*k*translation[axis])
                a=np.exp(-1j*k*mesh.nodes[pair["node_a"]][axis])
                b=np.exp(-1j*k*mesh.nodes[pair["node_b"]][axis])
                assert abs(b-phase*a)<1e-14


@pytest.mark.parametrize("layers", [1, 3])
def test_ring_air_realizes_graded_vertical_resolution(layers):
    from fullmag.model.geometry import Cylinder
    from fullmag.meshing._gmsh_swept import generate_swept_box_cylinder_ring_mesh
    geometry = Box(size=(40e-9, 40e-9, 10e-9)) - Cylinder(radius=8e-9, height=10e-9)
    mesh = generate_swept_box_cylinder_ring_mesh(
        geometry, 10e-9, layers, order=1, distribution="fixed", recombine=False,
        airbox=AirboxOptions(size=(40e-9, 40e-9, 410e-9),
                            maximum_element_size=50e-9, grading_ratio=1.3),
        options=MeshOptions(mesh_strategy="thin_film_tetrahedral",
                            periodic_pair_ids=["x_faces", "y_faces"]))
    nodes = np.asarray(mesh.nodes)
    xyz = nodes[np.asarray(mesh.elements)]
    volumes = np.linalg.det(xyz[:, 1:] - xyz[:, :1]) / 6
    assert np.all(volumes > 0)
    assert volumes.sum() == pytest.approx(40e-9*40e-9*410e-9, rel=1e-12)
    air = np.asarray(mesh.element_markers) == 0
    assert np.max(np.ptp(xyz[air, :, 2], axis=1)) <= 50e-9*(1+1e-12)
    actual = np.unique(np.round(nodes[:, 2], 17))
    expected = _box_airbox_layer_levels(-5e-9, 5e-9, -205e-9, 205e-9, layers,
                                       h_inner=10e-9, h_outer=50e-9, growth=1.3)
    np.testing.assert_allclose(actual, expected, atol=1e-16, rtol=0)
    for pair_id, axis in (("x_faces", 0), ("y_faces", 1)):
        required = set(np.flatnonzero(np.isclose(np.abs(nodes[:, axis]), 20e-9,
                                                rtol=0, atol=1e-16)))
        mapped = {int(pair[key]) for pair in mesh.periodic_node_pairs
                  if pair["pair_id"] == pair_id for key in ("node_a", "node_b")}
        assert required <= mapped


def test_ring_air_default_cap_realizes_geometric_vertical_resolution():
    pytest.importorskip("gmsh")
    from fullmag.model.geometry import Cylinder
    from fullmag.meshing._gmsh_swept import generate_swept_box_cylinder_ring_mesh

    layers = 3
    h_inner = 10e-9
    growth = 1.3
    h_outer = h_inner * growth**4
    geometry = Box(size=(40e-9, 40e-9, 10e-9)) - Cylinder(
        radius=8e-9, height=10e-9,
    )
    mesh = generate_swept_box_cylinder_ring_mesh(
        geometry, h_inner, layers, order=1, distribution="fixed", recombine=False,
        airbox=AirboxOptions(
            size=(40e-9, 40e-9, 410e-9), grading_ratio=growth,
        ),
        options=MeshOptions(
            mesh_strategy="thin_film_tetrahedral",
            periodic_pair_ids=["x_faces", "y_faces"],
        ),
    )
    assert set(mesh.cell_types.tolist()) == {"tet4"}
    nodes = np.asarray(mesh.nodes)
    cells = np.asarray(mesh.elements)
    xyz = nodes[cells]
    volumes = np.linalg.det(xyz[:, 1:] - xyz[:, :1]) / 6
    assert np.all(volumes > 0)

    expected = _box_airbox_layer_levels(
        -5e-9, 5e-9, -205e-9, 205e-9, layers,
        h_inner=h_inner, h_outer=h_outer, growth=growth,
    )
    actual = np.unique(np.round(nodes[:, 2], decimals=17))
    np.testing.assert_allclose(actual, expected, atol=1e-16, rtol=0)
    assert actual[0] == pytest.approx(-205e-9, abs=1e-16)
    assert actual[-1] == pytest.approx(205e-9, abs=1e-16)
    assert np.all(np.diff(actual) > 0)
    film_planes = actual[(actual >= -5e-9) & (actual <= 5e-9)]
    np.testing.assert_allclose(
        film_planes, np.linspace(-5e-9, 5e-9, layers + 1), atol=1e-16, rtol=0,
    )

    positive_steps = np.diff(actual[actual >= 5e-9])
    assert positive_steps[0] == pytest.approx(h_inner, rel=1e-12)
    assert positive_steps[1] == pytest.approx(h_inner * growth, rel=1e-12)
    assert np.max(positive_steps) <= h_outer * (1 + 1e-12)
    assert np.max(positive_steps) > h_inner
    air = np.asarray(mesh.element_markers) == 0
    assert np.max(np.ptp(xyz[air, :, 2], axis=1)) <= h_outer * (1 + 1e-12)


def test_ring_linear_air_grading_is_rejected_before_gmsh(monkeypatch):
    import fullmag.meshing._gmsh_swept as swept
    from fullmag.model.geometry import Cylinder
    def forbidden():
        pytest.fail("unsupported grading must fail before Gmsh initialization")
    monkeypatch.setattr(swept, "_import_gmsh", forbidden)
    geometry = Box(size=(40e-9, 40e-9, 10e-9)) - Cylinder(radius=8e-9, height=10e-9)
    with pytest.raises(ValueError, match="only geometric"):
        swept.generate_swept_box_cylinder_ring_mesh(
            geometry, 10e-9, 3, order=1, distribution="fixed", recombine=False,
            airbox=AirboxOptions(size=(40e-9, 40e-9, 410e-9), grading_mode="linear"),
            options=MeshOptions(mesh_strategy="thin_film_tetrahedral"))


def test_ring_lateral_resolution_is_independent_of_film_layers():
    from fullmag.model.geometry import Cylinder
    from fullmag.meshing._gmsh_swept import generate_swept_box_cylinder_ring_mesh
    geometry = Box(size=(40e-9, 40e-9, 10e-9)) - Cylinder(radius=8e-9, height=10e-9)
    def positions(hmax, layers):
        mesh = generate_swept_box_cylinder_ring_mesh(
            geometry, hmax, layers, order=1, distribution="fixed", recombine=False,
            airbox=AirboxOptions(size=(40e-9, 40e-9, 410e-9), maximum_element_size=50e-9),
            options=MeshOptions(mesh_strategy="thin_film_tetrahedral"))
        body = np.asarray(mesh.elements)[np.asarray(mesh.element_markers)==1]
        ids = np.unique(body)
        return set(map(tuple, np.round(np.asarray(mesh.nodes)[ids,:2],17)))
    coarse = positions(10e-9, 1)
    refined_z = positions(10e-9, 3)
    refined_xy = positions(5e-9, 3)
    assert coarse == refined_z
    assert len(refined_xy) > len(refined_z)


@pytest.mark.parametrize("antidot,layers", [(False, 3), (False, 6), (False, 9),
                                               (True, 1), (True, 2), (True, 3)])
def test_layered_periodic_triangles_are_conforming(layers, antidot):
    from collections import Counter
    from itertools import combinations
    from fullmag.model.geometry import Cylinder
    from fullmag.meshing._gmsh_swept import generate_swept_box_cylinder_ring_mesh
    from fullmag.meshing._gmsh_extraction import certify_extracted_periodic_mesh
    box = Box(size=(40e-9, 40e-9, 10e-9))
    geometry = box - Cylinder(radius=8e-9, height=10e-9) if antidot else box
    generate = generate_swept_box_cylinder_ring_mesh if antidot else generate_swept_tetrahedral_box_airbox_mesh
    mesh = generate(
        geometry, 10e-9, layers, order=1, distribution="fixed", recombine=False,
        airbox=AirboxOptions(size=(40e-9, 40e-9, 410e-9), maximum_element_size=50e-9),
        options=MeshOptions(mesh_strategy="thin_film_tetrahedral", through_thickness_elements=layers,
                            periodic_pair_ids=["x_faces", "y_faces"]))
    certificate = certify_extracted_periodic_mesh(
        mesh.nodes, mesh.boundary_faces, mesh.boundary_markers,
        mesh.periodic_boundary_pairs, mesh.periodic_node_pairs)
    assert certificate["certificate_status"] == "accepted"
    nodes = np.asarray(mesh.nodes)
    cells = np.asarray(mesh.elements)
    incidence = Counter(tuple(sorted(face)) for cell in cells for face in combinations(cell, 3))
    assert max(incidence.values()) == 2
    facet_keys = [tuple(sorted(face)) for face in mesh.boundary_faces]
    assert len(set(facet_keys)) == len(facet_keys)
    assert {face for face, count in incidence.items() if count == 1} == {
        key for key, role in zip(facet_keys, mesh.facet_roles) if role != "material_interface"}
    for face, role in zip(mesh.boundary_faces, mesh.facet_roles):
        count = incidence[tuple(sorted(face))]
        assert count == (2 if role == "material_interface" else 1)
    xyz = nodes[cells]
    volumes = np.linalg.det(xyz[:, 1:] - xyz[:, :1]) / 6
    assert np.all(volumes > 0)
    assert np.isclose(np.sum(volumes), 40e-9 * 40e-9 * 410e-9, rtol=1e-12, atol=0)
    body = cells[np.asarray(mesh.element_markers) == 1]
    assert len(np.unique(np.round(nodes[body, 2], 17))) == layers + 1


@pytest.mark.parametrize("permutation", [(0, 1, 2, 3, 4, 5), (2, 0, 1, 5, 3, 4)])
@pytest.mark.parametrize("scale,translation", [(1e-9, (0., 0., 0.)),
                                              (1., (11., -17., 5.))])
def test_prism_subdivision_ignores_local_order_and_translation(permutation, scale, translation):
    gmsh = pytest.importorskip("gmsh")
    from fullmag.meshing._gmsh_layered_tetrahedra import subdivide_layered_prisms
    xyz = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0],
                    [0, 0, .2], [1, 0, .2], [0, 1, .2]]) * scale + translation
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        gmsh.model.addDiscreteEntity(3, 1)
        gmsh.model.mesh.addNodes(3, 1, list(range(1, 7)), xyz.reshape(-1))
        gmsh.model.mesh.addElementsByType(1, 6, [1], [i + 1 for i in permutation])
        subdivide_layered_prisms(gmsh)
        kinds, _, raw = gmsh.model.mesh.getElements(3, 1)
        assert list(kinds) == [4]
        children = np.asarray(raw[0]).reshape(-1, 4)
        # One common, conforming split independent of Gmsh element numbering.
        assert {tuple(sorted(cell)) for cell in children} == {
            (1, 2, 3, 5), (1, 3, 5, 6), (1, 4, 5, 6)}
        points = xyz[children - 1]
        volumes = np.linalg.det(points[:, 1:] - points[:, :1]) / 6
        assert np.all(volumes > 0)
        assert np.isclose(sum(volumes), .1 * scale ** 3, rtol=1e-12, atol=0)
    finally:
        gmsh.finalize()


def test_prism_subdivision_rejects_skew_before_mutation():
    gmsh = pytest.importorskip("gmsh")
    from fullmag.meshing._gmsh_layered_tetrahedra import subdivide_layered_prisms
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        gmsh.model.addDiscreteEntity(3, 1)
        gmsh.model.mesh.addNodes(3, 1, list(range(1, 7)),
                                 [0,0,0, 1,0,0, 0,1,0, .1,0,1, 1.1,0,1, .1,1,1])
        gmsh.model.mesh.addElementsByType(1, 6, [1], list(range(1, 7)))
        with pytest.raises(ValueError, match="matching vertical columns"):
            subdivide_layered_prisms(gmsh)
        assert list(gmsh.model.mesh.getElements(3, 1)[0]) == [6]
    finally:
        gmsh.finalize()
