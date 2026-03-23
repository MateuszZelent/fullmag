# Mesh and region discretization

- Status: draft
- Last updated: 2026-03-23
- Related specs: `docs/specs/geometry-policy-v0.md`, `docs/specs/exchange-bc-policy-v0.md`, `docs/specs/material-assignment-and-spatial-fields-v0.md`

## 1. Problem statement

Geometry imports, region tagging, and material assignment are the first point where backend-neutral physics semantics meet backend-specific numerical representation.
This layer must remain neutral in the shared Python API while still supporting voxelization, meshing, and mesh-grid projection later in the pipeline.

## 2. Physical model

Geometry and regions define the spatial domain on which fields, materials, and energies are meaningful.
They are not energy terms by themselves, but errors here invalidate material assignment, interface semantics, and backend comparisons.

## 3. Numerical interpretation

### 3.1 FDM

Imported geometry is voxelized onto a regular grid, and regions become masks over cells.

However, regions are not sufficient as the sole representation of spatially varying material
coefficients.

The intended Fullmag model is:

- regions for topology,
- material assignment for piecewise-constant domain ownership,
- parameter fields for smooth or sampled spatial variation.

This avoids an architecture where gradients of `Ms`, `A`, or `alpha` require artificial
fragmentation into many regions.

### 3.2 FEM

Imported geometry is meshed, and regions become domain markers over elements or mesh attributes.

The same semantic split must hold:

- topology by region/domain markers,
- coefficient variability by piecewise constants or coefficient fields.

### 3.3 Hybrid

Hybrid execution needs explicit projection semantics between FEM mesh representation and auxiliary Cartesian grids used by selected operators.

## 4. API, IR, and planner impact

- The Python API must keep `ImportedGeometry`, `Region`, `Material`, and `Ferromagnet` distinct.
- `ProblemIR` stores geometry references and named region bindings without forcing a grid or element layout.
- The planner owns voxelization, meshing, and projection decisions.
- The long-term architecture must keep region topology separate from continuous coefficient
  variation; this is now specified explicitly in
  `docs/specs/material-assignment-and-spatial-fields-v0.md`.

## 5. Validation strategy

- analytical geometry sanity checks,
- region-volume consistency checks,
- geometry-import fidelity checks,
- cross-backend region assignment comparisons.

## 6. Completeness checklist

- [x] Python API
- [x] ProblemIR
- [x] Planner-facing structure
- [x] Capability matrix
- [ ] FDM backend
- [ ] FEM backend
- [ ] Hybrid backend
- [ ] Outputs / observables
- [ ] Tests / benchmarks
- [x] Documentation

## 7. Known limits and deferred work

- No production geometry import or mesh repair pipeline exists yet.
- Curved-geometry fidelity and tolerance policy are still deferred.
- This note documents semantic intent only; numerical implementation remains future work.
- The current bootstrap implementation still lowers only a single realized FDM material payload and
  does not yet implement the full region/material/parameter-field architecture described in the
  related material-assignment spec.
