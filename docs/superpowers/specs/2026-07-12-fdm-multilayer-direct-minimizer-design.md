# FDM Multilayer Direct Minimizers Design

- Status: approved for implementation
- Owners: Fullmag core
- Last updated: 2026-07-12
- Canonical contract: `docs/physics/0580-canonical-relaxation-equilibrium-contract.md`

## Goal

Make `projected_gradient_bb` and `nonlinear_cg` executable for every public FDM
multilayer realization: CPU reference, CUDA-assisted double, CUDA-assisted
single, and compatible native-stacked CUDA.  The public Python, ProblemIR, and
Control Room algorithm vocabulary remains unchanged.

## Physical and numerical contract

The minimizer state is a layer-major concatenation of every active magnetic
cell.  A trial vector is split back into its owning layers before evaluation.
Every Armijo trial recomputes the global multilayer demagnetization field,
local conservative fields, total energy, and effective field.  The metric is

`<a,b>_E = mu0 sum_i Ms_i V_i a_i dot b_i`.

The reported convergence residual is the fresh accepted-state
`max_i |m_i x H_eff,i|` in A/m.  Direct-minimizer iterations do not advance
physical time; accepted line-search steps remain in m/A.  Rejected trials do
not emit scalar rows, field artifacts, live updates, or completion events.

For the single-precision CUDA lane, retraction is quantized to the resident
FP32 magnetization before its energy is evaluated.  A trial that rounds to the
current state is numerical stagnation, not an Armijo failure.  CPU/double and
single use their own documented validation tolerances; no precision fallback
is permitted.

## Architecture

One new backend-neutral multilayer direct-minimizer driver owns BB, PR+,
Armijo, metric products, step accounting, and completion semantics.  It takes
a small evaluator adapter that can upload a concatenated trial, return its
realized concatenated magnetization, fresh H_eff, total energy, per-object
scalars, and physical weights.

The CPU adapter uses `observe_multilayer`.  CUDA-assisted adapters use the
existing layer upload/refresh/copy/observe boundaries.  The native-stacked
adapter uses its combined native FDM backend but preserves layer ownership for
per-object scalar output.  These adapters must not call a single-grid
minimizer, because doing so would lose multilayer field assembly and object
provenance.

## Legality and provenance

The planner accepts PG-BB and NCG for public multilayer FDM only after every
adapter is wired.  Existing conservative-interaction validation remains
authoritative.  Unsupported nonconservative/stochastic terms fail before
execution.  Requested and resolved minimizer names are identical; execution
provenance names the actual realization, including whether CUDA-assisted
demag remained host-resident.  There is no CUDA-to-CPU fallback.

## Validation

Each algorithm and realization needs tests for: aligned uniform equilibrium;
two-layer exchange/demag energy descent; fresh demag on every Armijo trial;
max-step terminal completion distinct from convergence; zero physical time;
accepted-step-only artifacts; and provenance.  CPU is the double oracle.
CUDA double must match CPU within a problem-specific numerical tolerance;
CUDA single must pass monotonic accepted-energy and convergence checks with a
separate FP32 tolerance.  A managed CUDA runtime recipe must execute both
algorithms in an eligible native-stacked case and an assisted case.

## Scope boundaries

This work does not add TPI, hybrid relaxation, new minimizer parameters,
nonconservative steady-state solving, or a new public API.  It only makes the
already-public PG-BB and NCG contract truthful for FDM multilayer.
