---
title: "Periodic FEM airbox mesh"
description: "Axis-derived periodic airbox mesh pairs and static k=0 request semantics."
summary: "PBC axes derive mesh IDs; the periodic-airbox demag request is separate from open airbox and Floquet physics."
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: 969efa0941905825ac569d525f4bdaefc059e2af
source_of_truth: "pbc, PeriodicBoundaryPair, OCC pairing, FEM planner"
---

(public-docs-numerical-methods-meshing-fem-airbox-periodic-airbox)=
# Periodic FEM airbox mesh

(airbox-periodic-airbox-problem-statement)=
## Physical problem

`study.pbc` records axes and derives `x_faces`, `y_faces`, `z_faces` mesh IDs. The OCC path pairs matching outer min/max faces. `demag="periodic_airbox_k0"` is a static FEM request, not FDM image summation or nonzero-$k$ Floquet demag.

(airbox-periodic-airbox-governing-equations)=
## Governing equations

```{math}
:label: eq-airbox-periodic-translation
\mathbf{x}_{\mathrm{slave}}=\mathbf{x}_{\mathrm{master}}+\mathbf{t}.
```

```{math}
:label: eq-airbox-periodic-k0
\mathbf{k}=\mathbf{0}.
```

(airbox-periodic-airbox-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $\mathbf{x}_{\mathrm{slave}}$ | destination-surface coordinate | $\mathrm{m}$ |
| $\mathbf{x}_{\mathrm{master}}$ | source-surface coordinate | $\mathrm{m}$ |
| $\mathbf{t}$ | axis translation | $\mathrm{m}$ |
| $\mathbf{k}$ | wave vector | $\mathrm{m^{-1}}$ |

(airbox-periodic-airbox-assumptions-and-validity)=
## Assumptions and validity

The generator accepts axis-derived IDs only and rejects unknown IDs, zero span, and unmatched
min/max faces. `PeriodicBoundaryPair` is a validated object descriptor, but it is not the direct
input to this generator route. OCC owns translation, tolerance and Gmsh pairing realization;
the descriptor owns authored validation and `to_ir()`. Planner acceptance is not runtime parity
or convergence evidence.

| Solver lane | Status | Limit |
| --- | --- | --- |
| FEM CPU | partial source-backed | No completed runtime qualification. |
| FEM GPU | capability-gated | No GPU periodic-airbox receipt. |
| FDM CPU | authoring-only | `truncated_images` authoring/lowering is documented; execution is not qualified here. |
| FDM GPU | authoring-only | `truncated_images` authoring/lowering is documented; execution is not qualified here. |

(airbox-periodic-airbox-python-api)=
## Python API

```python
# %%
import fullmag as fm
nm = 1e-9
study = fm.study("periodic_airbox_k0")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(200 * nm, 100 * nm, 120 * nm))

# %%
study.universe.mesh(maximum_element_size=30 * nm, minimum_element_size=5 * nm)
study.pbc(x=True, y=True, z=False, demag="periodic_airbox_k0")
body = study.geometry(fm.Box(size=(200 * nm, 100 * nm, 5 * nm), name="cell"), name="cell")
body.mesh(maximum_element_size=6 * nm, minimum_element_size=3 * nm, order=1)
body.Ms = 800e3
body.Aex = 13e-12
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

# %%
study.exchange()
study.demag(model="airbox")
study.build_domain_mesh()
study.stages.add_relax(stage_id="equilibrium", algorithm="llg_overdamped", max_steps=1000)
```

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `study.pbc.x` | `bool` | `False` | $1$ | Coerced with `bool(value)`; a non-open demag policy or `images` requires at least one true axis | x periodic axis | FEM and FDM authoring contract; runtime lanes require separate qualification | `periodic axes and `x_faces`` |
| `study.pbc.y` | `bool` | `False` | $1$ | Coerced with `bool(value)`; a non-open demag policy or `images` requires at least one true axis | y periodic axis | FEM and FDM authoring contract; runtime lanes require separate qualification | `periodic axes and `y_faces`` |
| `study.pbc.z` | `bool` | `False` | $1$ | Coerced with `bool(value)`; a non-open demag policy or `images` requires at least one true axis | z periodic axis | FEM and FDM authoring contract; runtime lanes require separate qualification | `periodic axes and `z_faces`` |
| `study.pbc.demag` | `Literal[open, truncated_images, periodic_airbox_k0]` | `open` | $1$ | With any true axis, `FdmPbc` applies `strip().lower()` and accepts `open`, `truncated_images`, or `periodic_airbox_k0`; with no true axis, `world.pbc` compares raw `demag` to exact `"open"` before `FdmPbc`; unknown values are rejected | periodic demag request | FEM and FDM authoring contract; runtime lanes require separate qualification | `periodic demag request` |
| `study.pbc.images` | `tuple[int, int, int] \| None` | `None` | $1$ | Only with `truncated_images` and at least one true axis; integer-coerced length-3 tuple with every count >= 0 | FDM image counts | FDM authoring contract only; runtime requires separate qualification | `problem.pbc.image_counts` |
| `PeriodicBoundaryPair.pair_id` | `str` | `required` | $1$ | non-empty after validation | stable pair identity | FEM periodic-pair metadata is source-backed; runtime lane requires separate qualification | `PeriodicBoundaryPair.to_ir().pair_id` |
| `PeriodicBoundaryPair.source_marker` | `str` | `required` | $1$ | non-empty | authored source marker | FEM periodic-pair metadata is source-backed; runtime lane requires separate qualification | `PeriodicBoundaryPair.to_ir().source_marker` |
| `PeriodicBoundaryPair.destination_marker` | `str` | `required` | $1$ | non-empty | authored destination marker | FEM periodic-pair metadata is source-backed; runtime lane requires separate qualification | `PeriodicBoundaryPair.to_ir().destination_marker` |
| `PeriodicBoundaryPair.translation` | `tuple[float, float, float]` | `required` | $\mathrm{m}$ | exactly 3 components; each coerced with `float` | source-to-destination translation | FEM periodic-pair metadata is source-backed; runtime lane requires separate qualification | `PeriodicBoundaryPair.to_ir().translation` |
| `PeriodicBoundaryPair.tolerance_m` | `float` | `1e-12` | $\mathrm{m}$ | strictly positive through `require_positive` | authored matching tolerance | FEM periodic-pair metadata is source-backed; runtime lane requires separate qualification | `PeriodicBoundaryPair.to_ir().tolerance_m` |
| `PeriodicBoundaryPair.axis_hint` | `str \| None` | `None` | $1$ | when present, non-empty; no x/y/z enum restriction | optional diagnostic axis hint | FEM periodic-pair metadata is source-backed; runtime lane requires separate qualification | `PeriodicBoundaryPair.to_ir().axis_hint` |
| `PeriodicBoundaryPair.pairing_policy` | `str` | `node_nearest_within_tolerance` | $1$ | non-empty; no enumerated-policy validation in dataclass | authored pairing-policy name | FEM periodic-pair metadata is source-backed; runtime lane requires separate qualification | `PeriodicBoundaryPair.to_ir().pairing_policy` |

### PBC normalization and coercion

For at least one true axis, `world.pbc` constructs `FdmPbc`, which applies the normalization below before Problem IR serialization. A separate raw guard runs first when all axes are false:

| Public input | Coercion or normalization | Validation condition | Problem IR form |
| --- | --- | --- | --- |
| `x`, `y`, `z` | Each value is converted with `bool(value)`. | If all three results are false, `world.pbc` does not construct `FdmPbc`; it accepts only raw `demag == "open"` with no `images`. | Three strings, each `periodic` or `open`, when `FdmPbc` is constructed. |
| `demag` | When any axis is true, `FdmPbc` applies `demag.strip().lower()`. | With an active axis, only `open`, `truncated_images`, and `periodic_airbox_k0` are accepted after normalization. With no active axis, the earlier raw comparison means `" OPEN "` and `"OPEN"` are rejected. | The normalized vocabulary value when active; no PBC object for the raw open/no-axis branch. |
| `images` | Each entry is converted with `int(value)` and retained as a length-3 tuple when `FdmPbc` is constructed. | With an active axis, allowed only for `demag="truncated_images"`; with no active axis, any non-`None` value is rejected by the raw guard. Length must be three and every count must be nonnegative. | `image_counts` as a three-element integer list; omitted when `images is None`. |

The zero-axis branch is therefore intentionally not equivalent to passing the raw value through
`FdmPbc`: raw `"open"` is accepted, while case or whitespace variants are rejected before
normalization. This table is an authoring and IR contract; it does not establish execution support
for an FEM or FDM runtime lane.

### Scope of the periodic production gate

`fem_frequency_response_production_slice_rejection_reason` is a frequency-response-only planner gate. The `PeriodicAirboxK0` branch accepts a plan only when all of the following are present: shared-domain air, enabled demagnetization, `spin_wave_bc=periodic`, `k=0`, a periodic `delta_m` constraint on the magnetic domain, and a periodic `delta_phi` constraint on the magnetostatic domain that includes air.

The relaxation example on this page demonstrates authored PBC and airbox intent only. It does not call the frequency-response planner path, exercise this gate, or prove a periodic runtime solve.

(airbox-periodic-airbox-problem-ir)=
## ProblemIR

`pbc` coerces axes to booleans and synchronizes mesh IDs. With any true axis it constructs
`FdmPbc`; `FdmPbc.to_ir()` serializes axes as `periodic`/`open`, normalized demag text, and
optional integer `image_counts`. With no true axis, raw `demag != "open"` or non-`None` images
raises before `FdmPbc` is constructed.
`PeriodicBoundaryPair.to_ir()` independently serializes all required fields, fixed orientation
`source_to_destination`, pairing policy, and optional axis hint. These are distinct lowerings.

(airbox-periodic-airbox-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

**Requested intent** is axes, policy, images, and an optional independent descriptor. **Resolved
execution** is normalized `FdmPbc`, derived IDs, OCC surface pairs/markers/tolerance, and planner
acceptance/rejection. **Validation errors** include the raw no-axis `demag != "open"` or non-`None` `images` guard, non-open policy without an axis, `images` with
any demag except `truncated_images`, image length other than three, negative image counts, empty
descriptor strings, translation length other than three, non-positive tolerance, unknown OCC ID,
zero span, and unmatched faces. **Unsupported combinations** include silent open fallback, using
FDM image semantics as FEM periodic airbox, and nonzero-$\mathbf{k}$ use of this policy.

The resolved execution is always reported separately from the authored descriptor.

(airbox-periodic-airbox-discrete-realization)=
## Discrete realization

OCC selects candidate boundary surfaces, orders matching min/max faces, derives translation and a
span-scaled tolerance, calls `setPeriodic`, creates dedicated periodic physical markers, and
excludes exactly those paired tags from `Gamma_out`. `asset_pipeline` preserves extracted
`periodic_boundary_pairs` and node pairs when assembling supported shared-domain assets. Planner
periodic-airbox conditions include shared-domain air, demag, periodic constraints, and $k=0$.

(airbox-periodic-airbox-implementation-mapping)=
## Implementation mapping

| Responsibility | Repository path | Stable symbol |
| --- | --- | --- |
| PBC authoring | `packages/fullmag-py/src/fullmag/world.py` | `def pbc` |
| PBC validation and IR | `packages/fullmag-py/src/fullmag/model/problem.py` | `class FdmPbc` |
| axis ID derivation | `packages/fullmag-py/src/fullmag/world.py` | `def _sync_default_mesh_periodic_pair_ids_from_pbc` |
| descriptor | `packages/fullmag-py/src/fullmag/meshing/periodic.py` | `class PeriodicBoundaryPair` |
| surface pairing | `packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py` | `def _configure_axis_periodic_surfaces` |
| periodic marker ownership | `packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py` | `def _add_periodic_boundary_physical_groups` |
| shared-asset pair preservation | `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py` | `def _periodic_pair_counts_by_id` |
| frequency-response-only planner gate | `crates/fullmag-plan/src/fem.rs` | `fn fem_frequency_response_production_slice_rejection_reason` |

(airbox-periodic-airbox-validation)=
## Validation

Inspect one-to-one pairs, translations, markers, extraction, and `Gamma_out` exclusion; test planner rejection for missing air, constraints, and nonzero $\mathbf{k}$. Runtime was not run.

(airbox-periodic-airbox-limitations)=
## Limitations

The direct generator input is axis IDs, not descriptors. This is static k=0 semantics, not Floquet/Bloch or GPU parity evidence.

(airbox-periodic-airbox-scientific-bibliography)=
## Scientific bibliography

- C. Geuzaine and J.-F. Remacle, *International Journal for Numerical Methods in Engineering* **79** (2009), [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).

(airbox-periodic-airbox-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Evidence |
| --- | --- | --- | --- |
| PBC request | `packages/fullmag-py/src/fullmag/world.py` | `def pbc` | source-backed |
| PBC/images validation and IR | `packages/fullmag-py/src/fullmag/model/problem.py` | `class FdmPbc` | source-backed |
| IDs | `packages/fullmag-py/src/fullmag/world.py` | `def _sync_default_mesh_periodic_pair_ids_from_pbc` | source-backed |
| descriptor | `packages/fullmag-py/src/fullmag/meshing/periodic.py` | `class PeriodicBoundaryPair` | source-backed |
| pairs | `packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py` | `def _configure_axis_periodic_surfaces` | source-backed |
| dedicated periodic physical groups | `packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py` | `def _add_periodic_boundary_physical_groups` | source-backed |
| pair-count provenance in assets | `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py` | `def _periodic_pair_counts_by_id` | source-backed |
| `crates/fullmag-plan/src/fem.rs` | `fem_frequency_response_production_slice_rejection_reason` | Frequency-response-only planner gate requiring shared-domain air, demag, `spin_wave_bc=periodic`, `k=0`, magnetic `delta_m` periodic constraints, and magnetostatic-with-air `delta_phi` periodic constraints. |
| `packages/fullmag-py/src/fullmag/world.py` | `class StudyBuilder` | Public `StudyBuilder.pbc` delegates to `world.pbc`; `world.pbc` owns axis bool coercion and `FdmPbc` creation. |
