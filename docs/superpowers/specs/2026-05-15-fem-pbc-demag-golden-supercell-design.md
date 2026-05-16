# FEM PBC Demag Golden Supercell Design

- Status: approved for implementation
- Date: 2026-05-15
- Scope: Rust FEM CPU reference benchmark/validation fixture only
- Out of scope: native MFEM, hypre, libCEED, CUDA, Python API, ProblemIR, OpenAPI, UI

## Goal

Close the missing physics oracle for static x-periodic FEM demag by comparing the reduced PBC solve against a non-periodic repeated supercell reference. This is a validation gate before further PBC demag optimization, not a production native/GPU implementation.

## Physical Contract

The PBC path solves the scalar demag potential in periodic equivalence classes:

```text
A_red q = P^T b(m)
phi = P q
H_demag = -grad(phi)
```

For a thin structured box with periodic x faces and open y/z faces, the golden check builds:

- one primitive x-periodic cell,
- one 15x repeated non-PBC supercell with the same local discretization,
- the same deterministic magnetization function evaluated in each physical unit-cell coordinate,
- a comparison between primitive PBC `H_demag` and the central unit-cell `H_demag` extracted from the supercell.

The central cell avoids the strongest outer-boundary artifact of the finite supercell and is a pragmatic CPU oracle for the reduced PBC implementation.

RED/GREEN showed that a raw repeated supercell is not a valid same-contract
comparison unless the Robin coefficient is held fixed to the primitive-cell
open-boundary model. The fixture therefore rescales the repeated problem's
Robin beta to the primitive beta. The test magnetization also uses zero mean
in the periodic x-component to avoid comparing a periodic scalar-potential
gauge against a finite-cell macroscopic linear-potential mode.

## Implementation

Extend `crates/fullmag-engine/src/fem_pbc_benchmark.rs` with:

- a `ReferencePbcDemagGoldenSupercellMetrics` struct,
- helper builders for primitive and repeated boxes,
- a nearest-coordinate mapper from primitive nodes to central-supercell nodes,
- `run_reference_pbc_demag_golden_supercell(divisions)`.

The golden fixture uses `divisions = 3` and a 15x repeated supercell. This
keeps the test cheap locally while avoiding the coarse P1 discretization error
seen with `divisions = 2`.

## Validation

Add `fem_pbc_demag_golden_supercell_matches_central_repeated_cell` to `crates/fullmag-engine/tests/fem_pbc_demag_benchmark.rs`.

Acceptance:

- relative L2 error is finite and `<= 5e-3`,
- max relative error is finite and bounded,
- mapped node count equals the primitive node count,
- no elapsed-time assertion is used as a physics oracle.

If RED/GREEN shows the simple structured tetra fixture cannot meet `5e-3`, the implementation must either fix the fixture mapping/physics or document the weaker tolerance in `docs/physics/0800-fem-static-pbc-demag.md`; it must not silently loosen the test.
