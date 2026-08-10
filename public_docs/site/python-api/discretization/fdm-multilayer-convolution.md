---
title: FDM multilayer convolution — Python, ProblemIR, and UI
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(python-api-fdm-multilayer-convolution)=
# FDM multilayer convolution: Python, ProblemIR, and UI

(python-api-fdm-multilayer-convolution-problem-statement)=
<!-- (problem-statement)= -->
## What this guide configures

This page is the authoring guide for Fullmag's FDM multilayer demagnetization path. It shows how
to give every named magnet its own Cartesian native grid, request a shared convolution layout,
preserve that request in `ProblemIR`, and inspect the planner/runtime result in the Control Room.
The magnetostatic equations and their derivation are owned by
{doc}`../../physics/interactions/demagnetization/multilayer-convolution`; this page owns the
Python, `ProblemIR`, UI, and failure contracts.

Three layouts must not be confused:

1. a **native layer grid** carries the layer's physical magnetization and field samples;
2. the **common convolution grid** is FFT scratch used for transfers and pair convolutions, not a
   physical mesh and not a visualization fallback;
3. an optional **target-only Airbox grid** carries only the published `H_demag` observation outside
   the magnetic support.

(python-api-fdm-multilayer-convolution-governing-equations)=
<!-- (governing-equations)= -->
## Authoring-to-grid relations

For layer $\ell$, Fullmag realizes the cell-center coordinates from the native origin and authored
cell size as

```{math}
:label: eq-python-fdm-multilayer-native-centers
\mathbf{x}_{\ell,\mathbf{i}}
= \mathbf{o}_{\ell}
+ \left(\mathbf{i}+\tfrac{1}{2}\mathbf{1}\right)\odot\mathbf{h}_{\ell}.
```

With an explicit two-dimensional stack request, the authored in-plane common-grid size fixes the
resolved transform-grid cell count to

```{math}
:label: eq-python-fdm-multilayer-common-2d
\mathbf{C}=\left(C_x,C_y,1\right)
=\left(N_x^{\mathrm{common}},N_y^{\mathrm{common}},1\right).
```

For $L$ layers the planner records $L^2$ ordered source-to-destination interactions, while the
number of stored shifted kernels may be smaller because equal signed layer separations can reuse a
kernel:

```{math}
:label: eq-python-fdm-multilayer-pair-count
K_{\mathrm{pair}}=L^2,
\qquad
K_{\mathrm{unique}}=\left|\left\{z_{\ell}-z_m:\ell,m\in\{1,\ldots,L\}\right\}\right|.
```

These relations define the numerical layout only. They do not replace the demagnetizing-field and
energy equations on the physics page.

(python-api-fdm-multilayer-convolution-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\ell,m$ | destination and source layer indices | $1$ |
| $\mathbf{x}_{\ell,\mathbf{i}}$ | center of native cell $\mathbf{i}$ in layer $\ell$ | $\mathrm{m}$ |
| $\mathbf{i}$ | three-dimensional integer cell index | $1$ |
| $\mathbf{o}_{\ell}$ | world-space origin of the native grid for layer $\ell$ | $\mathrm{m}$ |
| $\mathbf{h}_{\ell}$ | authored native cell-edge lengths of layer $\ell$ | $\mathrm{m}$ |
| $\mathbf{1}$ | three-component vector of ones | $1$ |
| $\odot$ | component-wise multiplication | $1$ |
| $\mathbf{C}$ | resolved common convolution-grid cell counts | $1$ |
| $C_x,C_y$ | resolved common in-plane cell counts | $1$ |
| $N_x^{\mathrm{common}},N_y^{\mathrm{common}}$ | authored `common_cells_xy` components | $1$ |
| $L$ | number of magnetic layers | $1$ |
| $z_{\ell},z_m$ | reference origins of the destination and source layer along $z$ | $\mathrm{m}$ |
| $K_{\mathrm{pair}}$ | number of ordered layer pairs | $1$ |
| $K_{\mathrm{unique}}$ | number of unique signed layer-separation kernels | $1$ |

(python-api-fdm-multilayer-convolution-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity

The current planner requires all multilayer bodies to have identical XY extents and the same XY
center. Bodies may be separated along $z$, but they may not overlap there. `two_d_stack` requires
one native Z cell per layer until a separately qualified moment-preserving Z reduction exists.
Open boundaries are executable; periodic multilayer axes fail closed. Per-object regions, thermal
noise, spin torque, Oersted terms, regional field drives, spatial material fields, and bulk DMI are
currently rejected for this path. CPU execution accepts FP64 only. CUDA FP32/FP64 has separate
runtime and qualification requirements; representability in Python or `ProblemIR` is not proof that
a requested GPU lane executed.

(python-api-fdm-multilayer-convolution-python-api)=
<!-- (python-api)= -->
## Python API

### Complete parameter reference

The `per_magnet` keys must be the canonical magnet names passed to `study.geometry(..., name=...)`.
`cell=` is retained as a legacy alias of `default_cell=`; new multilayer scripts should use
`default_cell=` explicitly.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FDMGrid.cell` | `Sequence[float] of length 3` | required | $\mathrm{m}$ per component | Exactly three finite, strictly positive components. | Native Cartesian cell size for one named magnet. | FDM CPU/GPU multilayer authoring; planner and runtime still capability-gate the resolved lane. | `backend_policy.discretization_hints.fdm.per_magnet[magnet_name].cell` |
| `FDMDemag.strategy` | `Literal["auto", "single_grid", "multilayer_convolution"]` | `"auto"` | $1$ | Must be one of the three literal values. | Requested demagnetization topology; use `"multilayer_convolution"` to force this path. | FDM CPU/GPU; multi-body `single_grid` is currently rejected by the planner. | `backend_policy.discretization_hints.fdm.demag.strategy` |
| `FDMDemag.mode` | `Literal["auto", "two_d_stack", "three_d"]` | `"auto"` | $1$ | Must be one of the three literal values. | Requested thin-film stack or full 3-D convolution mode. | FDM CPU/GPU subject to geometry and native-Z constraints. | `backend_policy.discretization_hints.fdm.demag.mode` |
| `FDMDemag.common_cells` | `tuple[int, int, int] \| None` | `None` | $1$ | Exactly three positive non-Boolean integers; mutually exclusive with `common_cells_xy`; invalid with `mode="two_d_stack"`. | Explicit 3-D common convolution-grid cell counts. | FDM CPU/GPU subject to planner memory and runtime capability. | `backend_policy.discretization_hints.fdm.demag.common_cells` |
| `FDMDemag.common_cells_xy` | `tuple[int, int] \| None` | `None` | $1$ | Exactly two positive non-Boolean integers; mutually exclusive with `common_cells`; valid only with `mode="auto"` or `mode="two_d_stack"`. | Explicit in-plane common-grid counts; planner resolves the Z count to one for a 2-D stack. | FDM CPU/GPU two-dimensional stack path. | `backend_policy.discretization_hints.fdm.demag.common_cells_xy` |
| `FDMDemag.allow_single_grid_fallback` | `bool \| None` | `None` | $1$ | Every non-`None` value raises `ValueError`. | Removed compatibility input; silent fallback is forbidden. | Unsupported on every lane. | Not serialized |
| `FDMDemag.explain` | `bool` | `True` | $1$ | Boolean authoring value. | Requests a human-readable plan explanation; it is not physical intent. | Python/UI authoring helper only. | Not serialized |
| `FDM.cell` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ per component | Legacy alias; cannot be supplied together with `default_cell`; when present, exactly three finite positive components. | Backward-compatible default Cartesian cell size. | FDM CPU/GPU; prefer `default_cell`. | Both `backend_policy.discretization_hints.fdm.cell` and `.default_cell` |
| `FDM.default_cell` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ per component | Exactly three finite positive components when supplied; either this or a non-empty `per_magnet` mapping is required. | Default grid for magnets without an explicit native-grid override and basis for an inferred common grid. | FDM CPU/GPU. | Both `backend_policy.discretization_hints.fdm.cell` and `.default_cell` |
| `FDM.per_magnet` | `dict[str, FDMGrid] \| None` | `None` | $1$ | Keys are non-empty strings and values are `FDMGrid`; without `default_cell`, every authored magnet must have a matching key. | Native grid overrides keyed by canonical magnet name. | FDM multilayer paths. | `backend_policy.discretization_hints.fdm.per_magnet` |
| `FDM.demag` | `FDMDemag \| None` | `None` | $1$ | Nested `FDMDemag` validation applies. | Attaches requested demagnetization topology and common-grid policy. | FDM CPU/GPU. | `backend_policy.discretization_hints.fdm.demag` |
| `FDM.boundary_correction` | `Literal["none", "volume", "full"] \| None` | `None` | $1$ | When supplied, must be `"none"`, `"volume"`, or `"full"`. | Selects binary, T0 volume-fraction, or T1 full sub-cell boundary policy. | Lane and precision dependent; this page does not qualify all combinations. | `backend_policy.discretization_hints.fdm.boundary_correction` |
| `FDM.boundary_phi_floor` | `float \| None` | `None` | $1$ | Strictly $0<\varphi_{\mathrm{floor}}<1$ when supplied. | Lower volume-fraction bound used by boundary-correction stability logic. | Boundary-correction lanes only. | `backend_policy.discretization_hints.fdm.boundary_phi_floor` |
| `FDM.boundary_delta_min` | `float \| None` | `None` | $\mathrm{m}$ | Values less than zero raise `ValueError`; the Python constructor currently performs no separate finiteness check. | Lower intersection-distance bound used by the T1 stencil. | Boundary-correction lanes only. | `backend_policy.discretization_hints.fdm.boundary_delta_min` |

### Complete stage-first example

This small three-layer stack is directly copyable. It explicitly enables demagnetization, requests
the CPU FP64 reference lane, saves `H_demag`, and ends in a fixed-step stage.

```python
# %% Imports and study execution intent
import fullmag as fm

nm = 1.0e-9
study = fm.study("fdm_multilayer_python_guide")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.interactive(False)

# %% Native layer grids and common FFT scratch grid
native_cell = (4.0 * nm, 4.0 * nm, 3.0 * nm)
study.fdm(
    default_cell=native_cell,
    per_magnet={
        "layer_bottom": fm.FDMGrid(cell=native_cell),
        "layer_middle": fm.FDMGrid(cell=native_cell),
        "layer_top": fm.FDMGrid(cell=native_cell),
    },
    demag=fm.FDMDemag(
        strategy="multilayer_convolution",
        mode="two_d_stack",
        common_cells_xy=(8, 4),
        explain=True,
    ),
)

# %% Universe and three non-overlapping, XY-aligned layers
study.universe(
    mode="manual",
    size=(40.0 * nm, 20.0 * nm, 30.0 * nm),
    center=(0.0, 0.0, 9.0 * nm),
    padding=(0.0, 0.0, 0.0),
)
layer_size = (32.0 * nm, 16.0 * nm, 3.0 * nm)
bottom = study.geometry(fm.Box(size=layer_size), name="layer_bottom")
middle = study.geometry(
    fm.Box(size=layer_size).translate((0.0, 0.0, 9.0 * nm)),
    name="layer_middle",
)
top = study.geometry(
    fm.Box(size=layer_size).translate((0.0, 0.0, 18.0 * nm)),
    name="layer_top",
)

# %% Material state and interactions
for layer in (bottom, middle, top):
    layer.Ms = 800.0e3
    layer.Aex = 13.0e-12
    layer.alpha = 0.02
    layer.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))

study.exchange(enabled=True)
study.demag(enabled=True)
study.b_ext(-24.6e-3, 4.3e-3, 0.0)

# %% Output and stage
study.save("H_demag", every=1.0e-13)
study.solver(integrator="rk4", fix_dt=1.0e-14, gamma=2.211e5)
study.tableautosave(
    1.0e-13,
    quantities=["step", "t", "mx", "my", "mz", "e_demag", "e_total"],
)
study.stages.add_run(until=1.0e-13, stage_id="multilayer_run")
```

Use `mode="three_d"` with `common_cells=(N_x,N_y,N_z)` when any native layer has more than one
Z cell. Do not set both common-grid fields. Omitting both delegates common-grid sizing to the
planner; it does not turn the common grid into a physical layer mesh.

### Optional CPU FP64 target-only Airbox observation

The current target-only carrier is an explicit post-run observation contract, not part of
`FDMDemag` and not a CUDA promise. Add this before the stage when a CPU FP64 run must publish
`H_demag` on a separate Airbox grid:

```python
# %% Complete study with a target-only Airbox observation
import fullmag as fm

nm = 1.0e-9
study = fm.study("fdm_multilayer_airbox_guide")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.fdm(
    default_cell=(4.0 * nm, 4.0 * nm, 3.0 * nm),
    per_magnet={
        "bottom": fm.FDMGrid(cell=(4.0 * nm, 4.0 * nm, 3.0 * nm)),
        "top": fm.FDMGrid(cell=(4.0 * nm, 4.0 * nm, 3.0 * nm)),
    },
    demag=fm.FDMDemag(
        strategy="multilayer_convolution",
        mode="two_d_stack",
        common_cells_xy=(8, 4),
    ),
)
study.universe(mode="manual", size=(40.0 * nm, 20.0 * nm, 30.0 * nm), center=(0.0, 0.0, 4.5 * nm))
bottom = study.geometry(fm.Box(size=(32.0 * nm, 16.0 * nm, 3.0 * nm)), name="bottom")
top = study.geometry(
    fm.Box(size=(32.0 * nm, 16.0 * nm, 3.0 * nm)).translate((0.0, 0.0, 9.0 * nm)),
    name="top",
)
for layer in (bottom, top):
    layer.Ms = 800.0e3
    layer.Aex = 13.0e-12
    layer.alpha = 0.02
    layer.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange(enabled=True)
study.demag(enabled=True)
study.save("H_demag", every=1.0e-13)
study.runtime_metadata(
    "airbox_observation",
    {
        "cells": (10, 6, 12),
        "spacing_m": (4.0 * nm, 4.0 * nm, 3.0 * nm),
        "origin_m": (-20.0 * nm, -12.0 * nm, -15.0 * nm),
        "padding_cells_above_below": (4, 6),
        "target_only": True,
        "scope_kind": "airbox",
        "published_quantities": ("H_demag",),
        "unavailable_quantities": {
            "H_eff": "fdm_multilayer_airbox_h_eff_unavailable.v1",
        },
    },
)
study.solver(integrator="rk4", fix_dt=1.0e-14, gamma=2.211e5)
study.stages.add_run(until=1.0e-13, stage_id="airbox_run")
```

The Airbox metadata is validated fail-closed: `target_only` must be true, `scope_kind` must be
`"airbox"`, the only published quantity must be `H_demag`, and `H_eff` must carry the exact
unavailable-reason identifier shown above. The current materializer ignores this request on a
non-CPU-reference execution engine and rejects non-FP64 provenance.

(python-api-fdm-multilayer-convolution-problem-ir)=
<!-- (problem-ir)= -->
## Canonical ProblemIR

`study.fdm(...)` produces `backend_policy.discretization_hints.fdm`. The following JSON is the
canonical serialized subtree produced by the first example's FDM objects; `explain` is absent by
design because it is an authoring/display preference:

```json
{
  "cell": [4e-09, 4e-09, 3e-09],
  "default_cell": [4e-09, 4e-09, 3e-09],
  "per_magnet": {
    "layer_bottom": {"cell": [4e-09, 4e-09, 3e-09]},
    "layer_middle": {"cell": [4e-09, 4e-09, 3e-09]},
    "layer_top": {"cell": [4e-09, 4e-09, 3e-09]}
  },
  "demag": {
    "strategy": "multilayer_convolution",
    "mode": "two_d_stack",
    "common_cells_xy": [8, 4]
  }
}
```

The physical interaction remains a separate `Demag` energy term. The planner lowers the authored
subtree to `BackendPlanIR::FdmMultilayer`, whose resolved payload contains:

- `mode`, `common_cells`, and a topology-bound `grid_certificate`;
- one `FdmLayerPlanIR` per named magnet with `layer_id`, `object_id`, native grid, native origin,
  active mask, convolution layout, and `transfer_kind` (`identity` or `push_pull`);
- `planner_summary.requested_strategy`, `selected_strategy`, `requested_mode`, `resolved_mode`,
  eligibility, pair/unique-kernel counts, memory estimate, and warnings;
- resolved precision, integrator, fixed timestep, enabled interactions, periodicity, and output plan.

This resolved plan is runtime input and provenance. It is not written back over the authored
Python request.

### Python-to-ProblemIR mapping

| Python object | Canonical destination | Normalization |
|---|---|---|
| `FDMGrid(cell=h)` | `backend_policy.discretization_hints.fdm.per_magnet[name].cell` | sequence becomes a three-element JSON array |
| `FDM(cell=h)` | `.fdm.cell` and `.fdm.default_cell` | legacy alias is duplicated for compatibility |
| `FDM(default_cell=h)` | `.fdm.cell` and `.fdm.default_cell` | canonical default also populates the legacy mirror |
| `FDM(per_magnet=...)` | `.fdm.per_magnet` | mapping keys remain canonical magnet names |
| `FDM(demag=policy)` | `.fdm.demag` | nested `FDMDemag.to_ir()` output |
| `FDMDemag(strategy=...)` | `.fdm.demag.strategy` | requested value is preserved, including `"auto"` |
| `FDMDemag(mode=...)` | `.fdm.demag.mode` | requested value is preserved; planner owns `resolved_mode` |
| `FDMDemag(common_cells=...)` | `.fdm.demag.common_cells` | tuple becomes a three-element integer array |
| `FDMDemag(common_cells_xy=...)` | `.fdm.demag.common_cells_xy` | tuple becomes a two-element integer array |
| `FDMDemag(explain=...)` | not serialized | retained only by authoring/UI round-trip |
| `FDM(boundary_correction=...)` | `.fdm.boundary_correction` | literal is preserved |
| `FDM(boundary_phi_floor=...)` | `.fdm.boundary_phi_floor` | scalar is preserved |
| `FDM(boundary_delta_min=...)` | `.fdm.boundary_delta_min` | SI metres are preserved |

(python-api-fdm-multilayer-convolution-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip, requested intent, and failure semantics

**Requested intent** is the Python/UI strategy, mode, native cell sizes, optional common-grid counts,
precision, device, and execution mode. `auto` remains `auto` in authored `ProblemIR`.
**Resolved execution** is recorded separately in the execution plan and artifacts: actual mode,
common-grid shape, native origins and masks, transfer kinds, grid fingerprints, pair-kernel counts,
selected runtime engine, precision, FFT backend, and runtime/device identity.

Python constructor validation errors reject malformed vectors, non-positive sizes, Boolean cell
counts, incompatible common-grid fields, invalid modes/strategies, empty magnet names, wrong grid
objects, and the removed fallback switch. Rust deserialization repeats the demag-policy checks for
non-Python producers. Planner validation errors reject geometry and capability violations before
allocation. Unsupported combinations fail without silently changing multilayer to single-grid,
CUDA to CPU, or `three_d` to `two_d_stack`.

The UI scene document uses the same field names and exports them back as `study.fdm(...)`,
`fm.FDMGrid(...)`, and `fm.FDMDemag(...)`. A saved `explain` checkbox may round-trip through the
authoring document and generated Python even though it does not enter physical `ProblemIR`.

(python-api-fdm-multilayer-convolution-discrete-realization)=
<!-- (discrete-realization)= -->
## Backend support and qualification

| Solver | Device | Authoring/IR | Runtime state | Qualification boundary |
|---|---|---|---|---|
| FDM | CPU | documented | FP64 reference multilayer execution and optional post-run target-only Airbox materialization | Local numerical artifacts exist; production qualification still requires the repository's managed gates for the claimed matrix. |
| FDM | GPU | documented | CUDA multilayer paths and telemetry contracts exist | Source, compilation, and ABI tests are not executed-device parity. Do not claim production GPU support without a fresh managed CUDA receipt, device identity, field/energy parity, and residency telemetry. |
| FEM | CPU | not applicable | FEM demagnetization uses scalar-potential/BEM families, not FDM multilayer convolution | Select a documented FEM demag realization instead. |
| FEM | GPU | not applicable | FEM demagnetization uses MFEM/hypre/libCEED realizations, not FDM multilayer convolution | Select a documented FEM GPU demag realization instead. |

(python-api-fdm-multilayer-convolution-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Control Room workflow

### Enable and configure the method

1. Set the study lane to **Backend: FDM**. In the **Physics** ribbon choose **Global Physics →
   Demagnetization** and enable the interaction.
2. Select the study in Explorer and use its Inspector global settings. Set **FDM demag** to
   **FDM multilayer convolution**.
3. Enter **FDM default cell** as `dx, dy, dz` in metres. In **FDM per-magnet grids**, enter a JSON
   object keyed by canonical magnet names, for example
   `{"free":{"cell":[2e-9,2e-9,1e-9]}}`.
4. Set **FDM demag mode** to **2-D stack** or **3-D**. For 2-D enter `Nx, Ny` in **Common
   convolution cells XY**. For 3-D enter `Nx, Ny, Nz` in **Common convolution cells**. The two
   fields are mutually exclusive.
5. Optionally enable **Explain FDM demag plan** and configure boundary correction. Press **Save
   globals** only after the Inspector has no validation errors.

The global Demagnetization method and the study's FDM demag strategy represent the same requested
realization and are normalized together. The method is unavailable until the active discretization
is FDM, and capability-disabled ribbon actions remain disabled with an explanation.

### Inspect the realized meshes

After planning/materialization, open **Mesh** in Explorer:

- **Common Convolution Grid** shows shape, cell size, origin, FFT shape, and provenance. Its
  Inspector states **Physical mesh: no** and identifies it as diagnostic FFT scratch.
- **Native Layers** contains one node per named magnet. Each layer exposes **Native Grid**,
  **Active Mask**, **Transfer**, and **Provenance** children. Inspect them to verify the realized
  carrier, active/inactive counts, `identity`/`push_pull`, layout fingerprint, and revisions.
- A missing or unavailable layout is shown as unavailable/degraded. The UI does not synthesize a
  common single-grid mesh for a multilayer result.

### Inspect and display target-only Airbox `H_demag`

When a validated runtime carrier exists, Explorer → **Airbox** adds **Multilayer H_demag target**.
Select it to inspect target cells, origin, cell size, sample/value counts, carrier fingerprint,
layout/observation revisions, source-grid fingerprints, and runtime identity. The Inspector must
report `H_demag` available and `H_eff` unavailable with its reason.

The viewport requests `quantity_id=H_demag` with `scope_kind=airbox` and `scope_id=airbox`. It
accepts only FMVP v3 data with the target carrier fingerprint, matching domain generation, exact
grid shape, three components, complete explicit cell indices, and exact sample/value counts.
Mismatched data is discarded; it is never replaced with the common FFT scratch field.

Use the Visualization controls to enable the target, bounds, wireframe, points, vectors, or shader
as available. Airbox bounds/wireframe prove the target extent; points/vectors prove field samples.
A valid source contract or React test is not visual qualification. Fresh qualification requires a
post-integration `compute_fields`, visible canvas, `gl.isContextLost() == false`, non-zero drawing
buffer, verified field requests/responses, and separate screenshots for each claimed display mode.

### Runtime resource boundary

The Control Room reads the versioned resource
`GET /v2/sessions/current/data/domain/fdm-multilayer-layout`. Native-layer and Airbox field vectors
remain scoped binary data-plane resources. The layout resource is fail-closed when artifacts,
fingerprints, counts, or revisions are missing or inconsistent.

(python-api-fdm-multilayer-convolution-validation)=
<!-- (validation)= -->
## Validation checklist

Before treating a configuration as executable, verify:

- every `per_magnet` name matches an authored magnet;
- all layers have equal XY extent and center and do not overlap along Z;
- `two_d_stack` layers each have one native Z cell;
- the common-grid field matches the mode and is within the planner memory budget;
- Demag is enabled and requested/resolved strategies are visible in provenance;
- every native layer has the expected fingerprint, mask, transfer kind, and sample coverage;
- any Airbox carrier reports CPU FP64 runtime origin, `target_only=true`, `H_demag` only, and
  matching field/layout fingerprints;
- GPU claims include a fresh managed device execution receipt; UI claims include a fresh WebGL
  receipt as described above.

(python-api-fdm-multilayer-convolution-limitations)=
<!-- (limitations)= -->
## Limitations

The public constructors describe more combinations than are production-qualified. The common grid
is not a mesh authoring surface. The target-only Airbox is currently CPU FP64 post-processing, not
a hot-loop field carrier, and publishes no `H_eff`. Its runtime-metadata request is deliberately
strict and is not a general arbitrary-observation-grid API. Periodic multilayer execution and the
capability-gated physics listed under assumptions remain unavailable. Fresh browser/WebGL evidence
for every Airbox display mode and fresh managed CUDA parity are separate release gates.

(python-api-fdm-multilayer-convolution-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography

The physical derivation and primary literature are collected on
{doc}`../../physics/interactions/demagnetization/multilayer-convolution`. This guide uses the
repository implementation and tests as the source of truth for public API, `ProblemIR`, planner,
runtime-resource, and UI behavior.

(python-api-fdm-multilayer-convolution-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index

| Claim | Path | Stable symbol | Responsibility | Lane and evidence |
|---|---|---|---|---|
| Native cell constructor and lowering | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMGrid` | validates one layer's cell size and serializes it | Python/IR tests |
| Demag policy and removed fallback | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDMDemag` | strategy, mode, common grid, validation, lowering | Python/IR tests |
| Complete FDM hint container | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDM` | default/native grids and boundary policy | Python/UI round-trip tests |
| Resolved multilayer plan | `crates/fullmag-plan/src/fdm.rs` | `plan_fdm_multilayer` | geometry eligibility, mode/grid resolution, transfer, certificate, provenance | planner tests |
| Topology-bound identity | `crates/fullmag-ir/src/mesh_hints.rs` | `fdm_multilayer_topology_tokens` | hashes mode, layer/object identity, native layout, mask, convolution layout, and transfer | IR migration/validation tests |
| Optional Airbox carrier | `crates/fullmag-runner/src/fdm/cpu/airbox_observation.rs` | `materialize_airbox_observation` | CPU FP64 post-run target-only `H_demag` artifacts | runner unit tests and local numerical evidence |
| UI scene lowering and validation | `apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.ts` | `fdmDraftToScene` | maps Inspector fields to canonical scene keys | frontend model tests |
| Explorer native/common nodes | `apps/control-room/src/modules/explorer/builders/buildModelTree.ts` | `fdmMultilayerLayoutNodes` | exposes FFT scratch and native-layer semantic nodes | Explorer tests |
| Layer/common/Airbox Inspector | `apps/control-room/src/modules/inspector/panels/fdm-grid/fdmMultilayerInspectorModel.ts` | `resolveFdmMultilayerInspectorModel` | renders layout facts without mesh substitution | Inspector tests |
| Dedicated target-only Airbox Inspector | `apps/control-room/src/modules/inspector/panels/airbox/fdmMultilayerAirboxTargetInspectorModel.ts` | `resolveFdmMultilayerAirboxTargetInspectorModel` | exposes target capability and provenance | Inspector tests |
| Versioned layout resource | `crates/fullmag-api/src/router_v2/handlers/data/domain.rs` | `fdm_multilayer_layout_resource` | validates and publishes native/common/Airbox domain metadata | API v2 tests |
| Native layer viewport domains | `apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.ts` | `adaptFdmMultilayerNativeLayerDomains` | creates separate render carriers per native layer | viewport adapter tests |
| Scoped Airbox field request | `apps/control-room/src/modules/viewport-3d/model/viewport3DFdmMultilayerAirbox.ts` | `buildFdmMultilayerAirboxFieldRequest` | requests only target-scoped `H_demag` | viewport field tests |
