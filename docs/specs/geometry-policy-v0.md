# Geometry Primitive Policy v0

- Status: accepted
- Last updated: 2026-03-23
- Parent spec: `docs/specs/exchange-only-full-solver-architecture-v1.md`
- Related physics note: `docs/physics/0100-mesh-and-region-discretization.md`

---

## 1. Purpose

This document freezes the geometry primitives available in the exchange-only release.
All subsequent code (Python model, Rust IR, planner, backends) must conform to this policy.

## 2. Supported geometry kinds

### 2.1 Analytic primitives

Analytic primitives define geometry without external files.
They are deterministic, backend-comparable, and essential for validation and unit tests.

#### `Box`

Axis-aligned cuboid centered at the origin.

| Parameter | Type | Unit | Constraints |
|-----------|------|------|-------------|
| `size` | `(f64, f64, f64)` | m | all components > 0 |
| `name` | `str` | — | non-empty, unique within problem |

Physical bounding box: $[-s_x/2, s_x/2] \times [-s_y/2, s_y/2] \times [-s_z/2, s_z/2]$.

#### `Cylinder`

Axis-aligned cylinder with the height axis along $z$, centered at the origin.

| Parameter | Type | Unit | Constraints |
|-----------|------|------|-------------|
| `radius` | `f64` | m | > 0 |
| `height` | `f64` | m | > 0 |
| `name` | `str` | — | non-empty, unique within problem |

Physical bounding box: $[-r, r] \times [-r, r] \times [-h/2, h/2]$.

### 2.2 Imported geometry

External geometry files (STEP, STL, etc.) imported by reference.
Existing `ImportedGeometry` semantics are unchanged.

| Parameter | Type | Constraints |
|-----------|------|-------------|
| `source` | `str` | non-empty file path or URI |
| `format` | `str` | `"step"` or `"stl"` |
| `name` | `str` | non-empty, unique within problem |

### 2.3 Deferred

- Boolean composition (CSG unions, intersections, differences) — out of scope for exchange-only.
- Parametric surfaces, splines, or other analytic geometry families.
- `Sphere`, `Ellipsoid`, or other higher-order analytic shapes.

## 3. IR representation

`GeometryIR` must use a tagged enum that supports both analytic and imported kinds:

```rust
pub struct GeometryIR {
    pub entries: Vec<GeometryEntryIR>,
}

#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GeometryEntryIR {
    ImportedGeometry(ImportedGeometryIR),
    Box { name: String, size: [f64; 3] },
    Cylinder { name: String, radius: f64, height: f64 },
}
```

### 3.1 Breaking change from v0.1.0

The v0.1.0 field `GeometryIR.imports: Vec<ImportedGeometryIR>` is replaced by
`GeometryIR.entries: Vec<GeometryEntryIR>`.

This is a deliberate breaking change. The IR version must be bumped to `0.2.0` when this
change lands.

## 4. Python API

```python
import fullmag as fm

# Analytic
strip = fm.Box(size=(200e-9, 20e-9, 5e-9), name="strip")
dot = fm.Cylinder(radius=50e-9, height=5e-9, name="dot")

# Imported
mesh = fm.ImportedGeometry(source="sample.step", format="step", name="sample")

# Union type
Geometry = ImportedGeometry | Box | Cylinder
```

- `Ferromagnet.geometry` accepts any `Geometry` value.
- `Problem` collects all geometries via `_collect_geometries()` (replaces `_collect_geometry_imports()`).

## 5. Validation rules

- All geometry names must be non-empty and unique within the problem.
- `Box.size` components must all be positive.
- `Cylinder.radius` and `Cylinder.height` must be positive.
- `ImportedGeometry.source` and `ImportedGeometry.format` must be non-empty.
- At least one geometry entry is required per problem.

## 6. Backend lowering

### 6.1 FDM

- `Box`: grid dimensions computed as $n_i = \mathrm{round}(s_i / \Delta x_i)$, clamped to $\geq 1$.
- `Cylinder`: voxelized into the FDM grid; cells whose center lies inside the cylinder are active.
- `ImportedGeometry`: voxelized from the imported mesh/surface.

### 6.2 FEM

- `Box`: meshed with a structured or unstructured tetrahedral mesh.
- `Cylinder`: meshed with an unstructured tetrahedral mesh.
- `ImportedGeometry`: meshed from the imported surface.

### 6.3 Position and orientation

For the exchange-only release, all analytic primitives are placed at the origin with axis-aligned
orientation. Translation, rotation, and composition are deferred.
