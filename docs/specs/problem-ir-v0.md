# ProblemIR v0

## Goal

`ProblemIR` is the canonical, typed representation of a Fullmag problem after Python-side serialization and before backend-specific lowering.

The source of truth is the serialized object graph, not Python source text.

## Top-level sections

- `ir_version`
- `ProblemMeta`
- `GeometryIR`
- `RegionIR`
- `MaterialIR`
- `MagnetIR`
- `EnergyTermsIR`
- `DynamicsIR`
- `SamplingIR`
- `BackendPolicyIR`
- `ValidationProfileIR`

## Design constraints

1. Python authors the problem; Rust validates and normalizes it.
2. The shared IR carries no grid indices, GPU storage layout, or FEM-only internals.
3. The IR is planner-ready: capability checks operate on canonical IR, not user syntax.
4. Reproducibility metadata is first-class for Python-authored runs.
5. `strict`, `extended`, and `hybrid` remain explicit in canonical validation state.

## ProblemMeta

`ProblemMeta` carries:

- problem name and description
- `script_language = "python"`
- original script source when available
- `script_api_version`
- `serializer_version`
- `entrypoint_kind`
- `source_hash`
- runtime metadata
- backend revision
- seeds

## Current MVP surface

Current bootstrap coverage includes:

- imported geometry references
- named regions
- material constants
- ferromagnets with uniform initial magnetization
- `Exchange`, `Demag`, `InterfacialDMI`, `Zeeman`
- `LLG` with gyromagnetic ratio, integrator, and optional fixed timestep
- field/scalar sampling
- FDM/FEM/Hybrid discretization hints
- backend target and execution mode

## Validation policy

Rust-side validation currently guarantees:

- required sections exist,
- names are unique where required,
- magnets reference known regions and materials,
- discretization hints are structurally valid,
- `LLG` parameters are structurally valid,
- hybrid backend and hybrid mode stay coupled,
- only Python-authored IR is accepted by the bootstrap CLI and PyO3 helper.
