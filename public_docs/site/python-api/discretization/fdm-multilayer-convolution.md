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

This is an FDM multimesh configuration, not a FEM meshing workflow. Each `per_magnet` entry
defines that magnet's native Cartesian grid. The common XY grid is the shared FFT supercell/kernel
layout selected by `common_cells_xy` (or its three-dimensional analogue), not an extra material
body. Layer separation is set by the geometry transforms, hence by the resulting native-grid
origins along $z$; it is not encoded by a `universe.mesh(...)` call. Do not add a FEM universe-mesh
request to make this FDM method executable.

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

For $L$ layers the planner records $L^2$ ordered source-to-destination interactions. Kernel reuse
is not determined by a physical separation alone. The reusable implementation key quantizes the
signed $z$ displacement in units of the resolved convolution-cell thickness and also contains the
source and destination cell sizes and the common convolution-grid shape:

```{math}
:label: eq-python-fdm-multilayer-pair-count
K_{\mathrm{pair}}=L^2,
\qquad
K_{\mathrm{unique}}
=\left|\left\{
\left(
\operatorname{round}\!\left(\frac{o_{d,z}-o_{s,z}}{h_{c,z}}\right),
Q(\mathbf h_s),Q(\mathbf h_d),\mathbf C
\right):d,s\in\{1,\ldots,L\}\right\}\right|,
\qquad Q(h)=\operatorname{round}(10^{12}h).
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
| $o_{d,z},o_{s,z}$ | destination and source native-grid origins along $z$ | $\mathrm{m}$ |
| $h_{c,z}$ | resolved convolution-cell thickness | $\mathrm{m}$ |
| $Q$ | picometre quantizer used in the reuse key | $\mathrm{m^{-1}}$ |
| $K_{\mathrm{pair}}$ | number of ordered layer pairs | $1$ |
| $K_{\mathrm{unique}}$ | number of distinct reuse keys, not merely distinct physical separations | $1$ |

(python-api-fdm-multilayer-convolution-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity

The planner forms a computational common-scratch envelope from the union of every native XY
rectangle. Therefore multilayer bodies may have different XY extents and centers; their native
origins, masks, and physical meshes remain separate, and a non-coincident layer is marked
`push_pull`. An explicit `common_cells` or `common_cells_xy` must contain that union with a
compatible pitch. A runtime lane that cannot consume the resulting insertion/crop or transfer
descriptor fails closed. This transfer path is not a claim that Appendix-A irregular Newell
supports arbitrary different XY cells: the irregular kernel itself requires common XY cell
sizes. Bodies may be separated along $z$, but they may not overlap there. `two_d_stack` requires
one native Z cell per layer. A multi-cell-Z request fails closed: no public moment-preserving Z
reduction exists, so the planner never copies one arbitrary native slice. Select `three_d` for
through-thickness cells. Open boundaries are executable; periodic multilayer axes fail closed.
Per-object regions, thermal noise, spin torque, Oersted terms, regional field drives, spatial
material fields, and bulk DMI are currently rejected for this path. CPU execution accepts FP64
only. CUDA FP32/FP64 has separate runtime and qualification requirements; representability in
Python or `ProblemIR` is not proof that a requested GPU lane executed.

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
planner; it does not turn the common grid into a physical layer mesh. This Fullmag planner-auto
policy is not BORIS `ncommonstatus=false`: the authored `ProblemIR` has no `common_cells*` fields,
and the resolved union-scratch layout is recorded in the plan/provenance rather than reproducing
BORIS's largest-mesh default. The common grid is a supercell for kernel/FFT work, while each layer
retains its own FDM grid and z origin.
Likewise, `two_d_stack` is not BORIS `2dmulticonvolution=1` or `=2`; it requires one native Z cell
per layer.

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
canonical `ProblemIR` wrapper produced by the first example's FDM objects; `explain` is absent by
design because it is an authoring/display preference. The surrounding `backend_policy` path is
part of the canonical contract, not an illustrative shorthand:

```json
{
  "backend_policy": {
    "requested_backend": "fdm",
    "execution_precision": "double",
    "discretization_hints": {
      "fdm": {
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
    }
  }
}
```

The physical interaction remains a separate global `Demag` energy term. `study.demag(enabled=True)`
controls whether that term is enabled; `study.fdm(..., demag=FDMDemag(...))` is a distinct FDM
discretization policy which selects how that enabled term is realized. They are not normalized by
one shared Python resolver. The planner lowers the authored FDM subtree to
`BackendPlanIR::FdmMultilayer`, whose resolved payload contains:

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

### UI → generated Python → ProblemIR

The authoring path is one chain, including the per-magnet identity:

| Layer | Source symbol | Contract |
|---|---|---|
| Control Room draft | `apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.ts::buildStudyGlobalMergePatch` | Global fields (`study.fdm.default_cell`, `study.fdm.per_magnet`, `study.fdm.demag`, and `study.demag_enabled`) are written to one canonical scene merge patch. |
| Generated script | `packages/fullmag-py/src/fullmag/runtime/script_builder.py::render_loaded_problem_as_script` | The scene patch renders as independent `study.demag(enabled=True)` and `study.fdm(default_cell=..., per_magnet={...}, demag=fm.FDMDemag(...))` calls. |
| Per-magnet lookup | `study.geometry(..., name="layer_bottom")` and `per_magnet["layer_bottom"]` | The geometry name is the canonical key. It is not a generated mesh alias and it must not be silently renamed. |
| Python lowering | `packages/fullmag-py/src/fullmag/model/discretization.py::FDM.to_ir` | Native cells and demag policy lower under `backend_policy.discretization_hints.fdm`. |
| Planner resolution | `crates/fullmag-plan/src/fdm.rs::plan_fdm_multilayer` | Geometry, mode, common transform, transfer, pair keys, and eligibility become resolved execution; authored values remain requested intent. |

`CommonTransformLayout` is computational scratch, not a physical mesh. The resource schema
(`crates/fullmag-api/src/schemas/domain.rs::FdmCommonTransformLayoutResource`) reports
`is_physical_mesh=false` and provenance. The resource-first route is
`GET /v2/sessions/current/data/domain/fdm-multilayer-layout`; an unavailable layout has an
explicit reason and is not synthesized by Explorer. Native-layer fields use `layer`/`object`
scopes. The target-only Airbox uses `airbox` scope and publishes `H_demag` only; no request
projects a field from the common transform layout.

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

The Control Room's global Demag toggle is exported as `study.demag(...)`; the FDM policy is
exported independently as `study.fdm(..., demag=fm.FDMDemag(...))`. A saved `explain` checkbox may
round-trip through authoring state and generated Python even though it does not enter physical
`ProblemIR`.

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

The global Demagnetization control enables the physical `Demag` term. The study's FDM demag
strategy is a separate discretization-policy request; the current code does not normalize the two
fields through one resolver. The policy is meaningful only for an FDM lane, and capability-disabled
ribbon actions remain disabled with an explanation.

### BORIS comparison and implementation gap

The detailed English BORIS/Fullmag matrix is canonical on
{doc}`../../physics/interactions/demagnetization/multilayer-convolution` under **BORIS
comparison and gap matrix**. It is linked here because Python authoring must not imply BORIS
compatibility. The matrix covers:

| Axis | Fullmag authoring consequence |
|---|---|
| BORIS multilayer versus supermesh | `strategy="multilayer_convolution"` is explicit; Fullmag does not silently turn a multi-body request into a supermesh or single-grid fallback. |
| BORIS `Rect_collection`/scratch and `n_common` | `common_cells` and `common_cells_xy` describe FFT scratch only; native grids, origins, and masks remain per magnet. |
| BORIS common-cell pitch | Fullmag keeps native cell size, resolved common-cell size, and transform layout separate; equal common counts do not imply equal cell volumes. |
| BORIS arbitrary XY rectangles and XYZ offsets | Fullmag planner forms a union scratch envelope for different native XY extents/centers and marks the affected layers `push_pull`; an explicit common grid must contain that union. Complete transfer/runtime/CUDA qualification is still open. |
| BORIS `2dmulticonvolution=0/1/2` | Fullmag `mode="two_d_stack"` is **not** `=1` or `=2`; it requires one native Z cell and rejects multi-cell Z because no public moment-preserving reduction exists. |
| Pair kernels, unequal thickness, weighted transfer | Fullmag keeps oriented source/destination cell sizes, signed offsets, six components, and explicit `push_pull` transfer; each scope needs field/energy/reciprocity evidence. |
| Catalog/reuse, spectral storage, FFT, padding, CPU/CUDA | Fullmag records six-component tensor storage, exact transform/crop reuse keys, and a CPU catalog/workspace that reuses unique kernels across refreshes; $L$ forward/$L^2$ pair/$L$ inverse work and separate CPU/CUDA qualification gates remain explicit. Source presence is not device proof. |
| BORIS PBC and reconfiguration | BORIS applies shared PBC images and rebuilds modules after mesh/count/mode changes; Fullmag currently accepts only open boundaries and replans from topology fingerprints. |
| BORIS AFM/atomistic participation | Fullmag's public contract is named ferromagnetic FDM objects only; antiferromagnetic and atomistic transfer semantics remain a separate scope gap. |
| Airbox and UI | Target-only Airbox is not the common transform grid; Explorer/viewport expose only scoped native-layer or Airbox resources and fail closed when unavailable. |

### Inspect the realized meshes

When the versioned multilayer-layout resource is available, its current Explorer integration may
expose the following diagnostics under **Mesh**:

- **Common Convolution Grid** can show shape, cell size, origin, FFT shape, and provenance. Its
  Inspector identifies it as diagnostic FFT scratch, not a physical mesh.
- **Native Layers** can contain one node per named magnet. Where published, layer diagnostics expose
  the realized carrier, active/inactive counts, `identity`/`push_pull`, layout fingerprint, and
  revisions.
- The current Explorer omits layout-specific nodes when their layout resource has
  `available=false`; it does not synthesize a common/native grid or a single-grid fallback. A
  caller must inspect the resource's `reason` or `degraded` payload rather than infer a mesh from
  missing nodes.

### Inspect and display target-only Airbox `H_demag`

When a validated runtime carrier exists *and the Airbox target resource is published*, Explorer may
add **Multilayer H_demag target**. Its available Inspector data can include target cells, origin,
cell size, sample/value counts, carrier fingerprint, layout/observation revisions, source-grid
fingerprints, and runtime identity. A missing resource is not a UI failure and does not authorize a
synthetic target; where published, `H_demag` is available and `H_eff` retains its unavailable reason.

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

The layout resource may publish availability from the resolved plan and/or an artifact and may
report missing parts through `reason` and `degraded` payloads. This availability contract is
separate from the target-only Airbox carrier. Native-layer and Airbox field vectors remain scoped
binary data-plane resources. The strong fail-closed contract applies to the target-only Airbox:
invalid target metadata, a mismatched fingerprint, an unsupported quantity, or non-CPU-FP64
provenance must not produce a substitute carrier.

(python-api-fdm-multilayer-convolution-validation)=
<!-- (validation)= -->
## Validation checklist

Before treating a configuration as executable, verify:

- every `per_magnet` name matches an authored magnet;
- the planner's common scratch envelope contains every native XY rectangle; layers do not overlap along Z;
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
| Global physical Demag term | `packages/fullmag-py/src/fullmag/model/energy.py` | `class Demag` | physical energy-term configuration, separate from FDM policy | Python authoring tests |
| Study authoring split | `packages/fullmag-py/src/fullmag/world.py` | `class StudyBuilder` (`fdm`, `demag`) | independently accepts the global interaction and FDM discretization policy | Python authoring tests |
| Complete FDM hint container | `packages/fullmag-py/src/fullmag/model/discretization.py` | `class FDM` | default/native grids and boundary policy | Python/UI round-trip tests |
| Generated stage-first Python | `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | `render_loaded_problem_as_script` | emits independent `study.demag(...)` and `study.fdm(...)` calls from canonical state | script-builder tests |
| Kernel reuse identity | `crates/fullmag-fdm-demag/src/descriptors.rs` | `from_pair_with_layout` | builds `KernelReuseKey` from oriented shifts, source/destination cell sizes, exact transform shape, padding, and crop | unit tests |
| Per-magnet local validation | `packages/fullmag-py/src/fullmag/model/discretization.py` | `FDM.__init__` | rejects empty names and non-`FDMGrid` values; matching names to authored geometry is planner validation | Python/planner tests |
| Resolved multilayer plan | `crates/fullmag-plan/src/fdm.rs` | `plan_fdm_multilayer` | geometry eligibility, mode/grid resolution, transfer, certificate, provenance | planner tests |
| Topology-bound identity | `crates/fullmag-ir/src/mesh_hints.rs` | `fdm_multilayer_topology_tokens` | hashes mode, layer/object identity, native layout, mask, convolution layout, and transfer | IR migration/validation tests |
| Optional Airbox carrier | `crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs` | `execute_reference_fdm_multilayer` | CPU FP64 multilayer runner; optional target-only `H_demag` is a scoped post-run extension | runner unit tests and local numerical evidence |
| UI scene lowering and validation | `apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.ts` | `buildStudyGlobalMergePatch` | maps Inspector fields to the canonical scene merge patch | frontend model tests |
| Explorer node omission boundary | `apps/control-room/src/modules/explorer/builders/buildModelTree.ts` | `buildModelTree` | the committed tree has no fabricated multilayer layout node when no available layout is supplied | Explorer tests |
| Layer/common/Airbox Inspector | `apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.ts` | `createStudyGlobalDraft` | reads committed study values into the Inspector draft; detailed layout facts are scoped extensions | Inspector tests |
| Dedicated target-only Airbox Inspector | `apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.ts` | `adaptFdmDomainPresentation` | adapts the committed FDM presentation carrier; target capability and provenance remain scoped | Inspector tests |
| Versioned layout resource | `crates/fullmag-api/src/router_v2/handlers/data/domain.rs` | `fdm_grid_descriptor` | provides the committed FDM domain metadata base for native/common/Airbox exposure | API v2 tests |
| Native layer viewport domains | `apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.ts` | `adaptFdmDomainMeta` | creates the committed FDM render carrier used for separate native-layer targets | viewport adapter tests |
| Scoped Airbox field request | `apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.ts` | `adaptFdmDomainPresentation` | adapts the committed FDM presentation carrier used for target-scoped `H_demag` | viewport field tests |
| Multilayer layout resource | `crates/fullmag-api/src/router_v2/handlers/data/domain.rs` | `fdm_multilayer_layout_resource` | publishes availability, explicit reason, native layers, and computational common-transform metadata | API v2 tests |
| Native multilayer viewport domains | `apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.ts` | `adaptFdmMultilayerNativeLayerDomains` | adapts physical native-layer carriers and never projects the common scratch grid | viewport adapter tests |
| Target-only multilayer Airbox domain | `apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.ts` | `adaptFdmMultilayerAirboxDomain` | validates target-only metadata, `H_demag` availability, and unavailable `H_eff` | viewport field tests; no fresh browser proof |
