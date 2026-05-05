# Shared Curved Waveguide Geometries

- Status: draft
- Owners: Fullmag core
- Last updated: 2026-05-05
- Related ADRs: none yet
- Related specs: `docs/physics/0050-shared-problem-semantics-and-embedded-python-api.md`, `docs/physics/0100-mesh-and-region-discretization.md`

## 1. Problem statement

Fullmag needs first-class curved strip geometries that preserve the public authoring semantics used
by AMUmax `SinWaveguide`, `SinWaveguide2`, and `ArchWaveguide`, while still lowering through the
canonical Python DSL and `ProblemIR`.

This note defines two new analytic geometry families:

1. `SinWaveguide`
2. `ArchWaveguide`

They represent physical magnetic bodies whose centerline bends in `z` as a function of `x`, while
the strip width remains aligned with `y`.

## 2. Physical model

### 2.1 Governing geometry equations

For both families:

- `x in [-L/2, +L/2]`
- `y in [-W/2, +W/2]`
- `H` is measured vertically along the global `z` axis
- occupancy in `z` is half-open:
  - `z >= z_center(x) - H/2`
  - `z < z_center(x) + H/2`

For `SinWaveguide`:

- `z_center(x) = z0 + A * sin(2*pi*x / P + phi)`

For `ArchWaveguide`:

- `t = (x + L/2) / L`
- `z_center(x) = z0 + H_arch * sin(pi * t)`

### 2.2 Symbols and SI units

- `L` : waveguide length, m
- `W` : waveguide width, m
- `H` : vertical thickness, m
- `P` : sinusoidal period, m
- `A` : sinusoidal centerline amplitude, m
- `phi` : sinusoidal phase, rad
- `z0` : vertical center offset, m
- `H_arch` : arch centerline height, m
- `x, y, z` : Cartesian position, m

### 2.3 Assumptions and approximations

- Thickness is measured vertically in `z`, not normal to the bent centerline.
- The half-open upper `z` bound is part of the canonical semantics and must not be replaced by a
  symmetric closed interval.
- `ArchWaveguide` allows negative `arch_height`; this inverts the arch downward.
- These shapes are purely geometric support definitions and do not introduce new field equations.

## 3. Numerical interpretation

### 3.1 FDM

- FDM lowers these shapes by evaluating the analytic occupancy predicate at cell centers.
- The local bounding box is:
  - `SinWaveguide`: `x=[-L/2,+L/2]`, `y=[-W/2,+W/2]`,
    `z=[z0-|A|-H/2, z0+|A|+H/2]`
  - `ArchWaveguide`:
    - if `H_arch >= 0`: `z=[z0-H/2, z0+H_arch+H/2]`
    - if `H_arch < 0`: `z=[z0+H_arch-H/2, z0+H/2]`
- FDM mask realization uses the same bounds and the same half-open `z` predicate in Python and
  Rust planner paths.

### 3.2 FEM

- `ProblemIR` must preserve these shapes as first-class semantic entries.
- This slice does not introduce native CAD/OCC construction for curved waveguides.
- FEM flows that reconstruct geometry from `ProblemIR` may recognize these kinds, but executable
  meshing support is deferred until a dedicated surface-generation path lands.

### 3.3 Hybrid

No hybrid-only semantics are introduced.

## 4. API, IR, and planner impact

### 4.1 Python API surface

Two new public DSL classes are introduced:

- `fm.SinWaveguide(length, width, height, period, amplitude, phase=0.0, z0=0.0, name=...)`
- `fm.ArchWaveguide(length, width, height, arch_height, z0=0.0, name=...)`

### 4.2 ProblemIR representation

`ProblemIR.geometry.entries[*]` gains:

- `kind="sin_waveguide"`
- `kind="arch_waveguide"`

with the parameters listed above.

### 4.3 Planner and capability-matrix impact

- Public FDM planner support expands to include both analytic waveguide geometries.
- Multilayer lowering may use them anywhere the existing analytic shape path is allowed.
- FEM capability remains partial until mesh/surface generation is implemented.

## 5. Validation strategy

### 5.1 Analytical checks

- `SinWaveguide(x=0, phase=0)` must yield `z_center=z0`
- `SinWaveguide(x=P/4, phase=0)` must yield `z_center=z0+A`
- `ArchWaveguide(x=-L/2)` and `ArchWaveguide(x=+L/2)` must yield `z_center=z0`
- `ArchWaveguide(x=0)` must yield `z_center=z0+H_arch`
- `z = z_center - H/2` must be inside
- `z = z_center + H/2` must be outside

### 5.2 Cross-layer checks

- Python DSL `to_ir()` and Rust serde round-trip must preserve all parameters.
- Python voxel preview and Rust FDM planner must agree on local bounds and occupancy semantics.

### 5.3 Regression tests

- Python constructor validation and bounds tests
- Python voxelization tests for half-open `z`
- Rust `ProblemIR` validation and serde tests
- Rust FDM planner tests for active-mask occupancy and translated origin

## 6. Completeness checklist

- [x] Python API
- [x] ProblemIR
- [x] Planner
- [ ] Capability matrix
- [x] FDM backend
- [ ] FEM backend
- [ ] Hybrid backend
- [ ] Outputs / observables
- [x] Tests / benchmarks
- [x] Documentation

## 7. Known limits and deferred work

- No native OCC/surface-generation path for FEM yet
- No dedicated control-room geometry authoring UI yet
- No canonical `ProblemIR -> Python` rewriter support for these kinds in this slice
- No rotation-specific waveguide helpers; existing transform coverage remains translation-only

## 8. References

- AMUmax `shape.go` curved waveguide predicates
- `docs/physics/0050-shared-problem-semantics-and-embedded-python-api.md`
- `docs/physics/0100-mesh-and-region-discretization.md`
