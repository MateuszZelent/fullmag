# T4 — same-tolerance equilibrium parity: direction-contract root cause

Status: **BLOCKED**

Date: 2026-08-02

## Scope and decision

The current coarse managed measurement is a real equilibrium-parity failure,
not a threshold or terminal-artifact defect.  The strict `1e-9` final-
magnetization envelope remains unchanged.  No native runtime rebuild or device
run was started in this investigation.

The smallest physical root cause is an unmatched direct-minimizer direction
operator:

- CPU PG-BB and NCG build `g = -P_m H_eff`, then apply the native MFEM
  exchange-plus-mass preconditioner `(M + alpha K)^{-1} M g`, re-projecting the
  result to the tangent plane before line search and (for NCG) PR+ update.
- GPU PG-BB and NCG build only the raw device `g = -P_m H_eff`.  The CUDA NCG
  source explicitly documents that it is unpreconditioned and lacks the CPU
  exchange-mass solve.  The GPU PG-BB path likewise feeds its raw tangent
  gradient directly into retraction and BB curvature.

This makes CPU and GPU different algorithms before the demag field is used for
the first search direction.  `exchange_only` passing does not disprove it: the
coarse fixture is already below the torque target in PG-BB and reaches it in a
near-trivial NCG path.  The exchange+demag cases activate the differing search
directions and fail the final-state comparator.

## Evidence

`docs/audits/2026-08-02-fem-t4-coarse-parity-measurement.json` is a clean
managed measurement with the same solver mesh signature
`4831e3b71f597ef03933e82c14e959b412872c92a3b9258363b1c0e3cb467ce6`, FP64,
CG/AMG demag at `rtol=1e-12`, and torque target `8000 A/m`.

| Case | CPU direction policy | GPU direction policy | max component difference |
|---|---|---|---:|
| exchange-only / PG-BB | exchange-plus-mass | raw device tangent | `1.1102230246251565e-16` |
| exchange-only / NCG | exchange-plus-mass | raw device tangent | `0.0` |
| exchange+demag / PG-BB | exchange-plus-mass | raw device tangent | `0.06503967931218391` |
| exchange+demag / NCG | exchange-plus-mass | raw device tangent | `0.005650088291763944` |

The failed differences exceed the required `1e-9` bound by approximately
`6.5e7` and `5.7e6` respectively.  Energy terms drift with the final state;
this investigation found no evidence that a demag residual tolerance change is
the first cause.

## Traced implementation boundary

CPU owner:

- `backends/fem/cpu/mfem/relaxation/relaxation_math.cpp` defines
  `exchange_mass_preconditioned_gradient`: it assembles/reuses `M + alpha K`,
  applies `M g`, solves each component, and projects the result tangent.
- `backends/fem/cpu/mfem/relaxation/projected_gradient_bb.cpp` uses that result
  before forming the PG-BB descent direction.
- `backends/fem/cpu/mfem/relaxation/nonlinear_cg.cpp` uses it for both current
  and accepted gradients, including the PR+ direction update.

GPU owner:

- `backends/fem/gpu/cuda/relaxation/pgbb_kernels.cu` constructs raw
  `-P_m H_eff` in `tangent_gradient_norm_kernel` and sends it to the PG-BB
  step and curvature kernels.
- `backends/fem/gpu/cuda/relaxation/pgbb.cpp` has no GPU exchange-mass solve
  between raw-gradient construction and the line search.
- `backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp` documents its
  unpreconditioned realization and directly uses the raw gradient for direction
  preparation and PR+ updates.
- `scripts/analysis/fem_gpu_benchmark.py` faithfully publishes the two
  different policies; it is not inventing the mismatch.

## RED → GREEN guard

I added a narrow qualification guard, not a claimed physics fix:

- `scripts/test_validate_fem_relaxation_equilibrium_parity.py` now constructs a
  converged same-mesh pair whose only difference is the direction policy and
  requires rejection.
- `scripts/validate_fem_relaxation_equilibrium_parity.py` now requires direct
  minimizer rows to declare the same direction policy; a missing or raw GPU
  policy paired with the CPU policy produces an explicit fail-closed failure.
  The guard does not hardcode one future shared implementation.

RED evidence before the guard:

```text
1 failed, 25 passed, 376 deselected
test_comparator_rejects_different_direction_contracts
comparison.passed was True for CPU exchange-plus-mass and GPU raw tangent
```

GREEN evidence after the guard:

```text
28 passed, 376 deselected
```

## Verification

The requested focused command initially hit an unrelated pytest capture-file
failure before collection (`FileNotFoundError` while pytest truncates its
capture temporary file).  Re-running the identical test selection with
`--capture=no` avoided that external capture issue and produced the RED and
GREEN evidence above:

```text
python3 -m pytest --capture=no -q \
  scripts/test_validate_fem_relaxation_equilibrium_parity.py \
  scripts/test_validate_fem_relaxation_runtime_log.py \
  -k 'equilibrium or time_to_tolerance'
```

Before deciding whether to run runtime proof, process inspection found an
unrelated active `just verify-fdm-oersted-native-contract` build.  No active
T4 FEM runtime export, rebuild, benchmark, or parity recipe was found.  I did
not start a competing managed build/run.

## Required follow-up to unblock T4

The physics fix is not safe as a one-file change.  CUDA needs a device-resident
counterpart to the CPU operator, applied with the same clamped per-step
`alpha`:

```text
p = P_m (M + alpha K)^-1 M (-P_m H_eff)
```

For NCG, the accepted preconditioned gradient must also feed the same PR+
formula as the CPU path.  The implementation needs dedicated GPU sparse-CG
ownership, allocation/preflight, convergence diagnostics, active-node/periodic
semantics, and first-divergence telemetry.  It must be accompanied by a
per-accepted-step CPU/GPU direction comparison on exchange+demag before a
managed runtime rebuild.  Only after confirming no shared-cache user is active
should the container-backed T4 recipe be run; neither tolerance nor comparator
threshold may be relaxed.

## Changes and commits

The guard and its tests were committed as:

```text
ade84361132869d62825902b63d2b007849068d9
```

Modified files in that commit:

- `scripts/test_validate_fem_relaxation_equilibrium_parity.py`
- `scripts/validate_fem_relaxation_equilibrium_parity.py`

This report is recorded separately as documentation and does not change the
T4 runtime qualification decision.

---

## Preserved earlier report (unrelated body-only prism mesh slice)

The content below was already present at this path before the T4 investigation.
It is preserved verbatim for its original mesh slice; it is not T4 evidence.

# Slice 4 report — body-only exact prism mesh

## Scope

- Production GEO meshing for one axis-aligned `Box` without an airbox.
- Linear `prism6` volume cells from a triangular source face and exact uniform
  extrusion along explicit x, y, or z.
- No shared-domain airbox, pyramid transition, public DSL topology controls,
  or native FEM operators in this slice.

## TDD RED evidence

The focused test matrix was added before changing production extraction:

```bash
PYTHONFAULTHANDLER=1 PYTHONPATH=packages/fullmag-py/src \
  python3 -m pytest packages/fullmag-py/tests/test_mixed_element_meshing.py \
  -k 'body_only_box_prism or explicit_prism_strategy' -vv
```

Initial result: exit `1`, `10 failed, 1 passed`. Real Gmsh 4.15.2 returned
`tet4` for layers 1/2/3 and axes x/y/z because the production extractor called
`_split_prism_to_tets`. `order=2` did not reject, an invalid axis leaked an
`IndexError`, and explicit prism on a Cylinder did not fail closed.

An additional RED froze the first supported distribution boundary: a linear
distribution was accepted instead of rejecting outside the exact-uniform
scope. The explicit Gmsh-to-Fullmag permutation test first failed at import
because no canonical ingress table existed.

## Implementation

- The Box source face stays triangular. GEO extrusion uses one exact uniform
  group: `numElements=[layers]`, `heights=[1.0]`, `recombine=True`.
- `layers=1/2/3` therefore produces exactly 2/3/4 unique node planes along the
  requested x/y/z axis.
- `_extract_swept_mesh_data` now consumes canonical typed extraction directly,
  requires a non-empty `prism6`-only volume and `tri3 | quad4` facets, normalizes
  entity orientation, and runs positive order-two Jacobian validation before
  returning SI coordinates.
- `_split_prism_to_tets` is disconnected from the Box path. It remains only for
  older non-Box compatibility paths outside this slice.
- Gmsh linear element IDs now pass through an explicit local-node permutation
  table in both grouped and ungrouped extraction. Gmsh 4.15 Prism 6 maps
  `(0,1,2,3,4,5)` to canonical Fullmag `prism6`.
- Body-only prism requests reject layers below one, order other than one,
  invalid axes, graded/symmetric distribution, periodic pairs, airbox, explicit
  non-Box geometry, empty output, and any realized non-prism family. No fallback
  is taken.
- The progress realization record states requested and resolved topology,
  axis, layers, order, cell/facet counts, and `fallbacks=[]`.

## Debugging note

The first multi-layer attempt incorrectly paired `numElements=[layers]` with a
multi-entry cumulative `heights` vector. A fresh isolated layers=2 reproducer
failed immediately in facet adjacency; this was not a Gmsh lifecycle deadlock.
The implementation now uses the documented one-group uniform contract. Repeated
real-Gmsh tests run in one process without sleeps or subprocess workarounds.

## Verification

Focused Slice-4 matrix:

```text
17 passed, 37 deselected in 0.65s
```

This includes real Gmsh 4.15.2 layer/axis generation, exact extrusion arguments,
reversed element-block collection order, splitter prohibition, realized-family
rejection, explicit ingress permutation, positive Jacobians, and requested /
resolved reporting.

The complete mixed-element file passed with `55 passed`. The paired fallback
file initially exposed ten stale post-Slice-2 fixtures that still constructed
canonical `MeshData` with removed legacy `elements=` / `boundary_faces=`
constructor keywords. Those five fixture sites now use the explicit
`MeshData.from_legacy_tet4(...)` normalization boundary; no product behavior
changed. A fresh fallback-only run passed `25/25`.

No native FEM source changed, so this slice has no MFEM/CUDA container build or
runtime claim. `just verify-fem-meshing-production` remains the broader Slice-5
shared-domain acceptance gate after conforming airbox implementation.

## Review status

- Initial independent review: Needs fixes; one Critical and three Important
  findings reproduced.
- Final independent re-review: Approved; no Critical, Important, or Minor
  findings.
- No commit or staging performed by the implementer.

## Review remediation

The review found that explicit `swept_hex` was entering the prism-only Box
implementation, the realization record existed only as progress text, numeric
controls admitted bool/float values, and invalid sizes reached Gmsh.

### Remediation RED

```bash
PYTHONFAULTHANDLER=1 PYTHONPATH=packages/fullmag-py/src \
  python3 -m pytest packages/fullmag-py/tests/test_mixed_element_meshing.py \
  -k 'swept_hex_never or non_integer_controls or invalid_sizes_before or provenance_is_typed' -vv
```

Result: exit `1`, `15 failed`. The hex request reached `_import_gmsh`; every
invalid integer/size case either reached `_import_gmsh` or leaked a Python/Gmsh
error; `MeshRealizationReport` did not exist. A separate exact-layer RED showed
that a one-layer prism mesh could be reported as requested two layers instead
of rejecting.

### Remediation implementation

- Explicit `swept_hex` now rejects before Gmsh with no relabel or prism
  realization. The existing cylinder compatibility implementation remains
  separate and has a real-Gmsh quality regression.
- `n_layers`, `order`, and `thin_axis` require non-boolean integral values and
  reject floats before Gmsh. `size[0:3]`, `hmax`, and optional `hmin` require
  finite positive values before Gmsh initialization.
- Realized node planes are counted from the returned SI coordinates with the
  contract tolerance. A count different from `requested_layers + 1` fails
  closed; provenance records the measured resolved layer count.
- `MeshRealizationReport` is a frozen typed `mesh_realization_report.v1`
  record containing requested/resolved topology, layers, axis, order, and an
  immutable fallback list. `MeshData.realization_report` preserves it through
  orientation normalization, node scaling, JSON/NPZ save-load, and `to_ir()`.
  It is not a shared-domain conformance certificate.
- The native prism reconstruction preserves any honest family-aware quality
  already supplied by extraction. It does not reuse the tetrahedral proxy for
  prism quality. The unchanged cylinder compatibility path still returns its
  existing `swept_topology_proxy` quality report.

### Remediation verification

Focused remediation result: `15 passed, 55 deselected`; exact-layer mismatch
result: `1 passed`. The combined mixed/fallback gate and broader swept/full
meshing results are recorded from the final fresh runs below.

Final fresh Slice-4 gates:

```text
test_mixed_element_meshing.py + test_meshing_fallbacks.py:
  104 passed in 1.99s
test_meshing.py -k 'swept and not shared_domain':
  3 passed, 248 deselected in 0.59s
compileall: exit 0
git diff --check: exit 0
```

The complete `test_meshing.py` run reached `249 passed, 1 skipped, 1 failed` in
159.07 seconds. Its only failure is the pre-existing periodic-antidot frozen
airbox fixture: `_derive_facet_roles` sees an explicit same-marker internal
facet with adjacency `[0, 0]`. That path does not invoke the body-only swept
Box generator, typed realization report, or new ingress validation. It is
reported as an unrelated branch baseline defect, not claimed green here.

### Final provenance-binding remediation

The first re-review found one remaining Important issue: a typed report could
still lie about a mesh. RED reproducers showed a `tet4` mesh accepting
`resolved_topology="prism6"`, a one-layer prism accepting
`resolved_layers=99`, and an empty fallback marker being accepted.

`MeshData` now binds `mesh_realization_report.v1` to its actual data during
construction and load:

- the actual unique cell family must equal `resolved_topology`;
- the linear CSR family fixes actual order to one;
- actual coordinate-plane count on `resolved_axis`, computed by one shared
  `_count_exact_layer_planes` helper and the canonical absolute/relative
  tolerance, must equal `resolved_layers`;
- fallback markers must be non-empty strings.

The generator uses the same plane-count helper, eliminating duplicate
clustering implementations. Tampered JSON and NPZ reports are rejected on
load, before they can reach `to_ir`. Focused binding/tamper result: `7 passed`.

The final re-review then reproduced a hidden-degradation variant: requested
and resolved fields could differ while `fallbacks_triggered=()`. A RED report
constructor and tampered-JSON load test now require topology, layers, axis, and
order to match whenever the fallback list is empty. Any future intentional
degradation must therefore name a non-empty fallback marker. Final focused
hidden-degradation result: `2 passed`; the complete gate is the `104 passed`
run above.
