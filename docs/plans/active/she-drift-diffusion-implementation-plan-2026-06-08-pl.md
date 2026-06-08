# SHE Drift-Diffusion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wdrozyc pelny solver Spin Hall Effect jako fizyke dryftu-dyfuzji ladunku i spinu na natywnej sciezce FEM, zgodnie z raportem `docs/plans/active/SHE.md`, bez redefiniowania publicznego modelu Fullmag jako backendowego szczegolu.

**Architecture:** Publiczny kontrakt pozostaje physics-first: Python DSL i UI obnizaja do `ProblemIR`, planner rozstrzyga wykonalnosc, runner przekazuje plan przez C ABI, a `backends/fem` wykonuje solve transportu i dodaje `tau_she` jako direct torque do RHS LLG. Pierwszy wykonywalny slice moze uzyc `prescribed_density` tylko jako bootstrap i regresje analityczne; status produkcyjny wymaga pelnego charge solve dla `ohmic_poisson` z kontaktami, interfejsem HM|FM i projekcja momentu na FM w FEM CPU. FEM GPU jest osobnym realizatorem tego samego kontraktu po przejsciu CPU gates. FDM dostaje tylko jawny status fallback/limit efektywny, nie pelny solve dryftu-dyfuzji.

**Tech Stack:** `packages/fullmag-py`, `crates/fullmag-ir`, `crates/fullmag-plan`, `crates/fullmag-runner`, `crates/fullmag-fem-sys`, native `backends/fem` C++/MFEM/hypre/libCEED/CUDA, OpenAPI v2 and `apps/control-room` capability/resource surfaces.

---

## Source Report Requirements

This plan implements the concrete direction from `docs/plans/active/SHE.md`:

- full SHE first lands in native FEM, not FDM,
- physical model is quasi-static charge plus spin drift-diffusion in a heavy metal,
- HM|FM coupling uses spin-mixing conductance with backflow through the interface condition,
- full-production numerical core is one charge solve plus coupled spin-accumulation solve per RK/Heun stage,
- absorbed spin current becomes a direct LLG RHS torque, next to existing STT direct torques,
- public API activates drift-diffusion torque semantics instead of treating SHE as only an effective DL/FL shortcut,
- validation includes 1D analytic drift-diffusion, effective SOT limit, sign tests, Liu/Ta-like amplitude trends, Thiaville DW+DMI+SHE trends, mesh/order convergence, and CPU/GPU parity once GPU is implemented.

Gemini audit correction to carry into the physics note before any code:

- use one explicit unit convention, preferably `mu_s` in Volts, `J_c` and `J_s` in A/m^2, and `gmix_*` in S/m^2,
- do not mix the Voltage convention with angular-momentum-flux prefactors in the elliptic transport equations,
- the HM|FM absorption boundary condition must have the sign that removes transverse spin from HM for the documented interface normal orientation,
- the interface term couples `mu_s.x/y/z`; independent scalar solves require Picard/relaxation iteration, while a block/vector solve can handle the coupling implicitly,
- the weak-form source should state whether the SHE term is assembled as a volume gradient term or an equivalent boundary injection term.

Current-state correction from repo inspection:

- `CurrentTransport(model="prescribed_density")` is already executable/provenance-bearing on FDM and native FEM CPU/GPU lanes in `docs/specs/capability-matrix-v0.md`.
- `CurrentTransport(model="ohmic_poisson")`, `DriftDiffusionSpinTorque`, and FEM `SpinOrbitTorque` are still semantic-only.
- Existing native FEM patterns to follow are `backends/fem/cpu/mfem/interactions/stt.*`, `backends/fem/cpu/mfem/interactions/oersted.*`, `backends/fem/cpu/mfem/integrators/rk_stage_rhs.*`, `backends/fem/gpu/cuda/integrators/rk/rk_direct_torques.*`, and `backends/fem/tests/stt_contract.cpp`.

Second-pass production-readiness correction:

- the prescribed-current path is only a bootstrap and analytic-regression lane; it is not the full production SHE solver promised by `SHE.md`,
- full production status requires an Ohmic Poisson charge solve with voltage/current contacts, gauge handling, current-conservation diagnostics, and UI authoring for contact/electrode intent,
- HM|FM interface selection must use Fullmag's explicit surface/coupling contract, not an opaque string that can bypass runtime face resolution,
- mesh policy must explicitly resolve HM thickness, `lambda_sf`, and HM|FM interface faces; metadata-only markers or projected sharp contacts cannot qualify as validation-grade production behavior,
- UI completion means Python DSL and Control Room authoring round-trip to the same `ProblemIR`, not merely exposing output quantities after a headless run.

## File Map

Create:

- `docs/physics/0870-fem-she-drift-diffusion.md` - canonical physics note for SHE equations, units, weak form, capability status, observables, validation, and deferred work.
- `docs/specs/she-drift-diffusion-fem.md` - implementation spec for IR fields, planner behavior, ABI, native FEM module boundaries, runtime resources, and UI exposure.
- `packages/fullmag-py/tests/test_she_drift_diffusion.py` - Python DSL and script export tests.
- `crates/fullmag-ir/tests/she_drift_diffusion_ir_tests.rs` or new tests inside `crates/fullmag-ir/tests/ir_tests.rs` following the current test layout.
- `crates/fullmag-plan/src/she.rs` - focused planner owner for SHE legality, interface/contact resolution, and plan lowering if `spin_torque.rs` would become mixed-responsibility.
- `backends/fem/tests/she_contract.cpp` - native FEM contract tests for import, units, signs, zero-current behavior, and analytic 1D fixtures.
- `backends/fem/tests/she_charge_transport_contract.cpp` - native charge-contact tests for full `ohmic_poisson` production behavior.
- `examples/she_hm_fm_drift_diffusion_1d.py` - minimal headless validation script for HM|FM planar stack.
- `examples/she_hm_fm_contact_crowding_3d.py` - 3D contact-crowding validation script for the full production solve.
- `scripts/analysis/validate_she_drift_diffusion.py` - regression helper for analytic profiles and effective torque limit.
- `backends/fem/cpu/mfem/interactions/she.hpp`
- `backends/fem/cpu/mfem/interactions/she.cpp`
- `backends/fem/cpu/mfem/interactions/she_charge.hpp`
- `backends/fem/cpu/mfem/interactions/she_charge.cpp`
- `backends/fem/cpu/mfem/interactions/she_spin_diffusion.hpp`
- `backends/fem/cpu/mfem/interactions/she_spin_diffusion.cpp`
- `backends/fem/cpu/mfem/interactions/she_interface.hpp`
- `backends/fem/cpu/mfem/interactions/she_interface.cpp`
- `backends/fem/cpu/mfem/interactions/she_projection.hpp`
- `backends/fem/cpu/mfem/interactions/she_projection.cpp`
- Later GPU slice only: `backends/fem/gpu/cuda/interactions/she/she_kernels.hpp`, `backends/fem/gpu/cuda/interactions/she/she_kernels.cu`, and RK adapter files if the CPU contract has passed.

Modify:

- `docs/physics/README.md` - add the SHE physics note.
- `docs/specs/capability-matrix-v0.md` and `docs/specs/capability-matrix-v0.json` - add truthful lane statuses.
- `docs/architecture/backend-golden-masterplan.md` - add SHE direct-torque ownership only if the new module changes backend ownership/source layout or production validation policy.
- `packages/fullmag-py/src/fullmag/model/current_transport.py` - add `spin_hall_drift_diffusion` only if the source model owns HM transport parameters; otherwise keep current transport as `prescribed_density`/future `ohmic_poisson` and put SHE parameters on `DriftDiffusionSpinTorque`.
- `packages/fullmag-py/src/fullmag/model/spin_torque.py` - activate `DriftDiffusionSpinTorque` with HM/FM/interface parameters and current-source binding.
- `packages/fullmag-py/src/fullmag/model/structure.py` or the current coupling-authoring owner - expose explicit HM|FM surface coupling authoring if no public helper exists.
- `packages/fullmag-py/src/fullmag/model/__init__.py` and `packages/fullmag-py/src/fullmag/__init__.py` if exported constructors change.
- `packages/fullmag-py/src/fullmag/runtime/script_builder.py` - canonical Python round-trip.
- `crates/fullmag-ir/src/lib.rs` or `crates/fullmag-ir/src/model.rs` if the current monolith is split before implementation - add typed IR fields and, if selected in the spec, extend `CouplingKindIR`/`CouplingParametersIR` with a SHE interface coupling while keeping semantics backend-neutral.
- `crates/fullmag-plan/src/current_transport.rs` - keep executable current-source resolution honest for SHE sources.
- `crates/fullmag-plan/src/spin_torque.rs` and optional `crates/fullmag-plan/src/she.rs` - resolve `DriftDiffusionSpinTorque` on FEM lane, resolve HM|FM surface coupling/contact intent, and reject unsupported lanes explicitly.
- `crates/fullmag-plan/src/lib.rs`, `crates/fullmag-plan/src/quantities.rs`, and planner tests - carry plan fields, observables, and diagnostics.
- `crates/fullmag-runner/src/capabilities.rs`, `crates/fullmag-runner/src/fem/`, `crates/fullmag-runner/src/native_fem/`, and any plan-to-ABI bridge owners - pass SHE plan fields without adding solver logic to `dispatch.rs`.
- `crates/fullmag-fem-sys` generated/bindgen inputs and wrapper code - expose C ABI fields and observable ids.
- `backends/fem/include/context.hpp` - add a narrowly owned `SheTransportRuntimeState` field or include a dedicated state type owned by `interactions/she.*`.
- `backends/fem/core/fem_context_builder.cpp` - import SHE plan fields and initialize runtime after MFEM context creation.
- `backends/fem/src/api.cpp` and public FEM header inputs - read plan fields and expose observables/errors.
- `backends/fem/CMakeLists.txt` - compile new SHE source files and native tests.
- `backends/fem/cpu/mfem/integrators/rk_stage_rhs.cpp` - call SHE solve and `add_she_rhs_aos` per RK/Heun stage after `m_stage` is known.
- `backends/fem/cpu/mfem/runtime/backend_step.cpp` only if stage scheduling needs a new timing phase or diagnostic hook.
- `apps/control-room/src/kernel/api/quantityIds.ts`, `apps/control-room/src/kernel/api/ControlRoomApi.ts`, `apps/control-room/src/kernel/api/apiTypes.ts`, and generated OpenAPI files only from source generation when backend API fields or capability resources become visible to the browser.
- `apps/control-room/src/modules/inspector/panels/CouplingInspectorPanelModel.ts` and `CouplingInspectorPanel.tsx` for HM|FM SHE interface authoring/readout.
- `apps/control-room/src/modules/inspector/panels/PhysicsInteractionPanelModel.ts` and `PhysicsInteractionPanel.tsx` only if the selected authoring shape uses object interaction panels.
- `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts`, `ObjectMeshPolicyPanel.tsx`, `ObjectRegionsPanelModel.ts`, and `ObjectRegionsPanel.tsx` for mesh/interface/contact diagnostics.
- `apps/control-room/src/modules/ribbon/ribbonCommands.ts` and `apps/control-room/src/modules/ribbon/ribbonContributions.tsx` for discoverable SHE commands.
- `apps/control-room/src/modules/viewport-3d/viewport3dFieldMapping.ts`, `viewport3dDomainAdapter.ts`, and `layers/VectorFieldLayer.tsx` only when rendering SHE vector/scalar quantities.

Do not modify:

- `apps/legacy_web` for this feature.
- FDM native code for the first full drift-diffusion solve.
- generic runner `dispatch.rs` beyond named compatibility routing; SHE solver ownership belongs under FEM interaction modules.
- `mfem_bridge.cpp` or generic `Context` as a physics dumping ground.

## Production Definition

Do not call this feature production-ready until both levels below are explicitly separated in capability, provenance, and UI:

1. Bootstrap executable slice:
   - FEM CPU executes `DriftDiffusionSpinTorque` with a resolved `CurrentTransport(model="prescribed_density")`,
   - no charge potential is solved; provenance records `charge_solve="prescribed_density"` and exposes `J_c` as prescribed input,
   - validation is limited to analytic slab, sign matrix, effective SOT limit, and RK-stage coupling,
   - capability may use `production_executable` only for a named `prescribed_current_bootstrap` subset, not for full SHE.
2. Full production SHE:
   - FEM CPU executes `CurrentTransport(model="ohmic_poisson")` from explicit voltage/current contacts with gauge handling,
   - charge current conservation, contact current balance, and `phi`/`J_c` observables pass runtime diagnostics,
   - HM|FM coupling is resolved from explicit surface endpoints through `CouplingIR` or an equivalent documented coupling owner,
   - mesh policy resolves HM thickness, `lambda_sf`, FM thickness, and HM|FM shared faces or boundary markers,
   - Python DSL, `ProblemIR`, planner, OpenAPI resources, Control Room UI, provenance, and canonical script export all express the same current/contact/interface semantics.

## Milestone 0: Canonical Physics And Implementation Spec

### Task 0.1: Write the Physics Note

**Files:**

- Create: `docs/physics/0870-fem-she-drift-diffusion.md`
- Modify: `docs/physics/README.md`

- [ ] **Step 1: Create the note from `docs/physics/TEMPLATE.md`**

The note must include these exact sections:

```md
# FEM SHE Drift-Diffusion

- Status: draft
- Owners: Fullmag core
- Last updated: 2026-06-08
- Related ADRs: `docs/adr/0014-native-fem-backend-modularization.md`
- Related specs: `docs/specs/capability-matrix-v0.md`, `docs/specs/she-drift-diffusion-fem.md`

## 1. Problem statement
## 2. Physical model
### 2.1 Governing equations
### 2.2 Symbols and SI units
### 2.3 Assumptions, contacts, and mesh validity limits
## 3. Numerical interpretation
### 3.1 FDM
### 3.2 FEM
### 3.3 Hybrid
## 4. API, IR, and planner impact
### 4.1 Python API surface
### 4.2 ProblemIR representation
### 4.3 Planner and capability-matrix impact
## 5. Runtime, artifacts, and provenance impact
## 6. OpenAPI and unified workspace impact
## 7. Validation strategy
### 7.1 Analytical checks
### 7.2 Cross-backend and effective-limit checks
### 7.3 Regression tests
## 8. Completeness checklist
## 9. Known limits and deferred work
## 10. References
```

- [ ] **Step 2: Record the governing equations**

Include charge transport:

```text
div(J_c) = 0
J_c = -sigma grad(phi)
```

The note must distinguish:

- bootstrap path: `J_c` comes from `CurrentTransport(model="prescribed_density")`, `phi` is absent, and the run is not a full charge-transport solve,
- production path: `phi` is solved from voltage/current contacts on the HM conducting region, with one documented gauge choice and current-conservation diagnostics.

Include spin transport in HM using the chosen Voltage convention:

```text
mu_s,a [V]
J_s,a [A/m^2]
J_s,a = -(sigma / 2) grad(mu_s,a) + theta_SH (J_c x u_a)
div(J_s,a) = -(sigma / (2 lambda_sf^2)) mu_s,a
```

Include HM|FM interface condition:

```text
with n oriented from HM toward FM:
n . J_s = -[ gmix_real m x (m x mu_s) + gmix_imag m x mu_s ]
```

Include direct torque:

```text
tau_SHE = gamma_mu0 * hbar / (2 e Ms t_F)
          [ gmix_real m x (m x mu_s) + gmix_imag m x mu_s ]
```

- [ ] **Step 3: Define SI units and sign conventions**

The units table must include `phi`, `J_c`, `J_s`, `mu_s`, `sigma`, `theta_SH`, `lambda_sf`, `gmix_real`, `gmix_imag`, `Ms`, `t_F`, `gamma_mu0`, `e`, `hbar`, interface normal direction, and `tau_SHE`.

The note must explicitly reject mixed conventions such as `mu_s` in Volts with `hbar/(2e)` inside `J_s`, or `J_s` in A/m^2 with `hbar/(2e^2)` inside the interface flux. If the physics note chooses a different convention from the Voltage convention above, it must rewrite all four equations and the validation prefactors consistently before any implementation task starts.

- [ ] **Step 4: Derive the weak form and coupling strategy**

The weak form section must include the SHE source as:

```text
integral_OmegaHM (sigma / 2) grad(mu_s,a) . grad(v) dOmega
+ integral_OmegaHM (sigma / (2 lambda_sf^2)) mu_s,a v dOmega
+ integral_GammaHF [ gmix_real (mu_s,a - m_a (m . mu_s))
                    - gmix_imag (m x mu_s)_a ] v dGamma
- integral_OmegaHM theta_SH (J_c x u_a) . grad(v) dOmega
= 0
```

Then record one implementation choice:

- scalar H1 solves plus Picard/relaxation until the coupled interface residual converges, or
- a vector/block solve for `mu_s` that treats the interface coupling implicitly.

If scalar solves are selected for the first slice, the physics note and spec must define the Picard convergence tolerance, residual norm, relaxation factor ownership, and maximum iteration failure behavior.

- [ ] **Step 5: Record interface and mesh requirements**

The note must state:

- HM is a conducting nonmagnetic region, not a fake magnetic material with `Ms=0`,
- FM is the magnetic target region that receives the projected torque,
- strict production FEM requires conformal shared-domain interface faces or explicit boundary/domain markers for the HM|FM interface,
- projected sharp contacts/interfaces are `extended` mode approximations, not validation-grade defaults,
- mesh policy must target at least 3-5 elements across `min(lambda_sf, t_HM)` unless the validation note justifies a weaker rule,
- contact and electrode surfaces must resolve to nonempty runtime face sets with diagnostics.

- [ ] **Step 6: Declare the truthful implementation scope**

Write these constraints explicitly:

```text
First executable target: native FEM CPU with MFEM/hypre prescribed-current bootstrap.
Full production target: native FEM CPU with Ohmic Poisson contact solve plus SHE spin solve.
FEM GPU target: same physics contract after CPU validation and device-residency audit.
FDM target: no full drift-diffusion solve in this phase; FDM effective SOT remains only a regression limit/fallback capability.
Hybrid target: semantic-only.
```

- [ ] **Step 7: Update physics README**

Add `0870-fem-she-drift-diffusion.md` to `docs/physics/README.md`.

- [ ] **Step 8: Self-check the note**

Run:

```bash
rg -n 'T''BD|TO''DO|place''holder|fi''ll in|lat''er' docs/physics/0870-fem-she-drift-diffusion.md
```

Expected: no matches except deliberate wording in "Known limits and deferred work" that names a concrete deferred feature.

### Task 0.2: Write the Implementation Spec

**Files:**

- Create: `docs/specs/she-drift-diffusion-fem.md`
- Modify: `docs/specs/capability-matrix-v0.md`
- Modify: `docs/specs/capability-matrix-v0.json`
- Optional modify: `docs/architecture/backend-golden-masterplan.md`

- [ ] **Step 1: Write the implementation spec**

The spec must define:

- public Python authoring shape,
- canonical `ProblemIR` variants and validation rules,
- coupling representation for HM|FM surface endpoints, preferably by extending `CouplingIR` instead of storing an opaque interface string on the torque,
- charge-contact representation for full `ohmic_poisson` production solves,
- planner legality for FDM CPU/GPU, FEM CPU/GPU, `auto`, `strict`, `extended`, and future `hybrid`,
- chosen spin-transport unit convention and weak-form assembly,
- scalar Picard/relaxation versus block/vector solve decision,
- FEM plan fields,
- native FEM module boundaries,
- C ABI additions,
- output quantity ids and artifacts,
- runtime/provenance diagnostics,
- OpenAPI/resource impact,
- UI command and inspector gating,
- validation gates for `production_executable` vs `validated`.

- [ ] **Step 2: Add initial capability rows**

Use these initial statuses:

| Feature | FDM CPU | FDM GPU | FEM CPU | FEM GPU | Hybrid |
|---|---|---|---|---|---|
| `DriftDiffusionSpinTorque` prescribed-current bootstrap | `semantic_only` | `semantic_only` | `source_visible` until implemented, then `production_executable` for the named bootstrap subset | `semantic_only` until separate GPU slice passes | `semantic_only` |
| `DriftDiffusionSpinTorque` full SHE with charge contacts | `semantic_only` | `semantic_only` | `source_visible` until `ohmic_poisson` and contact solve pass, then `production_executable` | `semantic_only` until separate GPU slice passes | `semantic_only` |
| `CurrentTransport(model="ohmic_poisson")` with contacts | `semantic_only` | `semantic_only` | `source_visible` until contact solve passes, then `production_executable` | `semantic_only` until GPU slice | `semantic_only` |
| `CurrentTransport(model="spin_hall_drift_diffusion")` if introduced | `semantic_only` | `semantic_only` | `source_visible` only until the spec proves it is not duplicating `DriftDiffusionSpinTorque` ownership | `semantic_only` until GPU slice | `semantic_only` |
| SHE observables `mu_s`, `J_s`, `tau_she` | `unsupported` | `unsupported` | `source_visible` then `production_executable` | `semantic_only` until GPU slice | `unsupported` |

Do not mark any lane `validated` until analytic and runtime gates below pass.

- [ ] **Step 3: Decide where SHE parameters live**

Pick one of these shapes and record the decision in the spec:

```python
# Recommended first shape: current source remains charge-current source;
# a separate coupling object owns the explicit HM|FM surface endpoints;
# DriftDiffusionSpinTorque references both.
hm_fm = fm.SpinHallInterface(
    name="hm_fm",
    source=hm.surface("top"),
    target=free_layer.surface("bottom"),
)
fm.current_transport(
    name="drive",
    model="prescribed_density",
    current_density=(1.0e11, 0.0, 0.0),
    solve_region="hm",
    conductivity_s_per_m=4.0e6,
)
fm.DriftDiffusionSpinTorque(
    current_source="drive",
    heavy_metal_region="hm",
    ferromagnet_region="fm",
    interface_coupling="hm_fm",
    theta_sh=0.08,
    spin_diffusion_length_m=1.5e-9,
    spin_mixing_conductance_real_per_ohm_m2=5.0e14,
    spin_mixing_conductance_imag_per_ohm_m2=2.5e13,
    ferromagnet_thickness_m=1.0e-9,
)
```

The full production shape must additionally define charge contacts, for example a voltage/contact-current pair on the HM conducting region, and it must lower to the same `CurrentTransport(model="ohmic_poisson")` semantics used by the planner:

```python
fm.current_transport(
    name="drive",
    model="ohmic_poisson",
    solve_region="hm",
    conductivity_s_per_m=4.0e6,
    contacts=[
        fm.VoltageContact(name="left", surface=hm.surface("left"), voltage=0.0),
        fm.CurrentContact(name="right", surface=hm.surface("right"), current_a=1.0e-3),
    ],
    gauge="grounded_contact:left",
)
```

If current DSL names differ, the spec must still lower to explicit surface endpoints in `ProblemIR`, a resolved coupling id, and explicit contact ids. Do not use `interface="hm_fm"` as the final contract unless the spec proves it is an alias for a typed `CouplingIR` object with endpoint validation.

If the implementation introduces `CurrentTransport(model="spin_hall_drift_diffusion")`, justify why transport owns spin parameters instead of torque owning them. Do not silently split the same parameter across both objects.

- [ ] **Step 4: Capability self-check**

Run:

```bash
rg -n "DriftDiffusionSpinTorque|spin_hall|SHE|spin_accumulation|tau_she" docs/specs/capability-matrix-v0.md docs/specs/capability-matrix-v0.json docs/specs/she-drift-diffusion-fem.md
```

Expected: every new status appears in the spec and capability matrix with no hidden fallback language.

## Milestone 1: Python DSL And Canonical IR

### Task 1.1: Add Python Authoring Tests First

**Files:**

- Create: `packages/fullmag-py/tests/test_she_drift_diffusion.py`
- Modify: `packages/fullmag-py/src/fullmag/model/spin_torque.py`
- Modify: `packages/fullmag-py/src/fullmag/model/current_transport.py` only if Task 0.2 selected a new current model.
- Modify: `packages/fullmag-py/src/fullmag/runtime/script_builder.py`

- [ ] **Step 1: Add a failing DSL serialization test**

Test exact authoring shape selected in Task 0.2. It must assert:

- `kind == "drift_diffusion"`,
- `current_source == "drive"`,
- `heavy_metal_region == "hm"`,
- `ferromagnet_region == "fm"`,
- `interface_coupling == "hm_fm"` is serialized and references a typed HM|FM coupling object,
- `theta_sh`, `spin_diffusion_length_m`, `gmix_real`, `gmix_imag`, and `ferromagnet_thickness_m` are preserved as floats,
- invalid non-positive `spin_diffusion_length_m`, `gmix_real`, and `ferromagnet_thickness_m` raise `ValueError`,
- `current_density` and `current_source` remain mutually exclusive.
- full production authoring with `CurrentTransport(model="ohmic_poisson")` preserves explicit contact ids, surface selectors, and gauge selection.

- [ ] **Step 2: Run the failing Python test**

Run:

```bash
python3 -m pytest packages/fullmag-py/tests/test_she_drift_diffusion.py -q
```

Expected before implementation: failures naming missing constructor arguments or missing IR keys.

- [ ] **Step 3: Implement minimal Python DSL fields**

Change `DriftDiffusionSpinTorque` only enough to satisfy Task 1.1. Preserve existing `SlonczewskiSTT`, `ZhangLiSTT`, `InterfaceCppSTT`, and `SpinOrbitTorque` semantics.

- [ ] **Step 4: Add script round-trip test**

Extend the test file so script export renders the selected authoring shape with explicit keyword arguments. The rewritten script must not collapse full drift-diffusion SHE into `SpinOrbitTorque`.

The round-trip must preserve:

- the `SpinHallInterface` or equivalent typed coupling object,
- current contacts for the full production `ohmic_poisson` shape,
- requested bootstrap-vs-full-production intent in provenance fields.

- [ ] **Step 5: Run Python tests**

Run:

```bash
python3 -m pytest \
  packages/fullmag-py/tests/test_she_drift_diffusion.py \
  packages/fullmag-py/tests/test_current_transport.py \
  packages/fullmag-py/tests/test_stno_spin_torque.py \
  -q
```

Expected: pass.

### Task 1.2: Add ProblemIR Shape And Validation

**Files:**

- Modify: `crates/fullmag-ir/src/lib.rs` or split-owned IR file if `SpinTorqueModuleIR` has moved.
- Modify: `crates/fullmag-ir/tests/ir_tests.rs` or create `crates/fullmag-ir/tests/she_drift_diffusion_ir_tests.rs`.

- [ ] **Step 1: Write failing IR validation tests**

Tests must cover:

- valid `DriftDiffusion` module references an existing `CurrentTransport`,
- missing current source is rejected,
- unknown current source is rejected,
- missing HM/FM/interface coupling is rejected,
- interface coupling endpoints must resolve to one HM-side surface and one FM-side surface,
- unresolved, duplicate, or non-contacting surface endpoints are planner/runtime blockers in `strict` mode,
- `ohmic_poisson` current transport requires at least one gauge-defining voltage contact or an equivalent documented gauge rule,
- current contacts must reference the same conducting HM solve region as the SHE source,
- non-positive `lambda_sf`, `gmix_real`, and `ferromagnet_thickness_m` are rejected,
- `theta_sh == 0` is legal but produces zero torque in backend contract tests,
- deserializing older IR without SHE still works without migration churn.

- [ ] **Step 2: Run failing IR tests**

Run:

```bash
cargo test -p fullmag-ir she_drift_diffusion --test ir_tests
```

If the tests live in a new integration-test file, use:

```bash
cargo test -p fullmag-ir --test she_drift_diffusion_ir_tests
```

Expected before implementation: compile or validation failures around missing fields.

- [ ] **Step 3: Implement typed IR fields**

Keep the IR backend-neutral. Do not encode MFEM finite element spaces, hypre solver choices, GPU buffers, or C ABI structs in `ProblemIR`.

If the spec selects `CouplingIR`, extend `CouplingKindIR` and `CouplingParametersIR` with only physics-level SHE interface semantics:

```text
kind = spin_hall_interface
endpoints = Surface(HM), Surface(FM)
parameters = gmix_real, gmix_imag, normal_orientation_policy
```

Backend mesh face ids, MFEM boundary attributes, and projected face sets belong in planner/runtime resolved data, not in authored IR.

- [ ] **Step 4: Run IR regression tests**

Run:

```bash
cargo test -p fullmag-ir
```

Expected: pass.

## Milestone 2: Planner, Capability, Quantities, And Provenance

### Task 2.1: Resolve SHE Legality In Planner

**Files:**

- Modify: `crates/fullmag-plan/src/spin_torque.rs`
- Modify: `crates/fullmag-plan/src/current_transport.rs`
- Modify: `crates/fullmag-plan/src/lib.rs`
- Modify: `crates/fullmag-plan/src/tests.rs`

- [ ] **Step 1: Add failing planner tests**

Tests must assert:

- FDM CPU/GPU reject full `DriftDiffusionSpinTorque` as `semantic_only` with a support-matrix note.
- FEM CPU accepts exactly one SHE module after the required current source and HM|FM interface coupling are resolved.
- FEM CPU distinguishes `prescribed_current_bootstrap` from full `ohmic_poisson` production capability.
- FEM GPU initially rejects or marks `semantic_only` until the GPU implementation slice exists; forced GPU must not silently fall back.
- Missing HM/FM/interface coupling or unresolved contact surfaces produce direct planner errors.
- `strict` mode rejects projected sharp contacts or interface guesses; `extended` mode may allow them only with provenance.
- Multiple executable torque modules remain rejected unless this plan is explicitly expanded to multi-torque composition.
- `CurrentTransport(model="ohmic_poisson")` remains semantic-only unless a separate charge-contact solve lands.

- [ ] **Step 2: Run failing planner tests**

Run:

```bash
cargo test -p fullmag-plan she_drift_diffusion
```

Expected before implementation: missing planner resolution or wrong rejection text.

- [ ] **Step 3: Implement planner resolution**

Add a `ResolvedSheDriftDiffusion` structure owned by `spin_torque.rs` or a new focused planner module. It must carry physical parameters, source binding, resolved coupling id, authored endpoint selectors, contact intent, bootstrap-vs-full-production status, and selected lane status. It must not carry native solver allocation details.

- [ ] **Step 4: Preserve current transport behavior**

Ensure existing `CurrentTransport(model="prescribed_density")` tests still pass for FDM and FEM. Do not regress Oersted-from-current binding.

For `CurrentTransport(model="ohmic_poisson")`, keep the planner status semantic-only until Milestone 3.2b lands. After that task, require contact/gauge resolution before FEM CPU can report `production_executable`.

- [ ] **Step 5: Run planner regression**

Run:

```bash
cargo test -p fullmag-plan current_transport spin_torque oersted
```

If Cargo rejects multiple filters, run:

```bash
cargo test -p fullmag-plan current_transport
cargo test -p fullmag-plan spin_torque
cargo test -p fullmag-plan oersted
```

Expected: pass.

### Task 2.2: Add Quantity And Artifact Contracts

**Files:**

- Modify: `crates/fullmag-quantities/src/catalog.rs`
- Modify: `crates/fullmag-quantities/src/id.rs`
- Modify: `crates/fullmag-quantities/src/transport.rs`
- Modify: `crates/fullmag-plan/src/quantities.rs`
- Modify: `crates/fullmag-runner/src/quantities.rs`
- Modify: `crates/fullmag-api/src/artifacts.rs` if new artifacts are exposed through API.

- [ ] **Step 1: Add quantity ids**

Use stable ids:

```text
spin_accumulation
spin_accumulation.x
spin_accumulation.y
spin_accumulation.z
spin_current_interface
she_torque
she_torque.x
she_torque.y
she_torque.z
charge_potential
charge_current
charge_current.x
charge_current.y
charge_current.z
```

- [ ] **Step 2: Add tests for quantity resolution**

Tests must prove scalar/vector component lookup works, bootstrap runs omit `charge_potential`, full production runs expose `charge_potential`, and unsupported lanes reject quantities cleanly.

- [ ] **Step 3: Run quantity tests**

Run:

```bash
cargo test -p fullmag-quantities
cargo test -p fullmag-plan quantities
cargo test -p fullmag-runner quantities
```

Expected: pass.

### Task 2.3: Add Runner And C ABI Plan Plumbing

**Files:**

- Modify: `crates/fullmag-runner/src/capabilities.rs`
- Modify: `crates/fullmag-runner/src/fem/`
- Modify: `crates/fullmag-runner/src/native_fem/`
- Modify: `crates/fullmag-fem-sys`
- Modify: `backends/fem/src/api.cpp`
- Modify: `backends/fem/include/*.h` or the current public FEM header source used by `fullmag-fem-sys`.

- [ ] **Step 1: Add failing runner tests**

Tests must assert requested-vs-resolved execution records:

- authored `DriftDiffusionSpinTorque`,
- resolved FEM CPU path,
- no hidden FDM fallback,
- no hidden FEM GPU fallback when GPU is forced and unsupported,
- planned observable ids include SHE quantities only when requested or configured for diagnostics.

- [ ] **Step 2: Add C ABI fields**

The ABI must carry:

```text
she_enabled
she_current_source_name
she_heavy_metal_region
she_ferromagnet_region
she_interface_coupling_id
she_interface_source_selector
she_interface_target_selector
she_theta_sh
she_spin_diffusion_length_m
she_gmix_real_per_ohm_m2
she_gmix_imag_per_ohm_m2
she_ferromagnet_thickness_m
she_cache_charge
she_charge_solve_model
she_contact_count
she_contacts
she_gauge_policy
```

If region/contact selectors are already lowered to numeric mesh/material/boundary attributes by planner/runner, the ABI must carry resolved ids plus provenance strings for diagnostics. Runtime face sets and MFEM attributes must be created by FEM import/resolution code, not authored directly in `ProblemIR`.

- [ ] **Step 3: Keep solver logic out of runner**

Runner code may serialize plan fields, artifacts, capabilities, and provenance. It must not assemble MFEM operators or calculate SHE torques.

- [ ] **Step 4: Run Rust and bindgen-level checks**

Run the narrow checks used by the repo after ABI edits. If a managed FEM runtime build is needed, use the container-backed route:

```bash
just ensure-managed-fem-runtime
```

Expected: generated bindings and runtime bundle are current.

## Milestone 3: Native FEM CPU Implementation

### Task 3.1: Add Native FEM SHE State And Plan Import

**Files:**

- Modify: `backends/fem/include/context.hpp`
- Modify: `backends/fem/core/fem_context_builder.cpp`
- Modify: `backends/fem/src/context.cpp` if state lifecycle needs explicit reset.
- Create: `backends/fem/cpu/mfem/interactions/she.hpp`
- Create: `backends/fem/cpu/mfem/interactions/she.cpp`
- Modify: `backends/fem/CMakeLists.txt`
- Create: `backends/fem/tests/she_contract.cpp`

- [ ] **Step 1: Add native import test**

`she_contract.cpp` must prove:

- disabled plan leaves SHE state disabled,
- enabled plan imports all SI parameters exactly,
- invalid negative or zero physical parameters fail at import with a targeted error,
- missing interface coupling fails before runtime allocation,
- unresolved HM/FM region attributes, empty HM|FM face sets, or non-contacting surface endpoints fail before solver allocation,
- contact references for `ohmic_poisson` import as explicit boundary/contact descriptors,
- zero `theta_sh` remains importable.

- [ ] **Step 2: Run failing native contract test through managed path**

Use the repository FEM build route, not a host-first CMake build:

```bash
just ensure-managed-fem-runtime
```

If a dedicated native test target is added, wire it into the managed build or an existing `just verify-*` recipe before treating it as proof.

- [ ] **Step 3: Implement `SheTransportRuntimeState`**

The state should own plan parameters, resolved region/interface/contact metadata, host observable buffers, and MFEM runtime objects. Keep state dedicated to SHE; do not add scattered top-level `Context` fields for each parameter.

- [ ] **Step 4: Run import test**

Run the new contract target through the same container-backed route used by native FEM tests.

Expected: pass.

### Task 3.2: Implement Prescribed-Current Bootstrap Path

**Files:**

- Create: `backends/fem/cpu/mfem/interactions/she_charge.hpp`
- Create: `backends/fem/cpu/mfem/interactions/she_charge.cpp`
- Modify: `backends/fem/cpu/mfem/interactions/she.*`
- Modify: `backends/fem/tests/she_contract.cpp`

- [ ] **Step 1: Add charge solve tests**

Tests must cover:

- uniform prescribed current source produces the expected `J_c`,
- `phi` solve is bypassed when the first slice uses `prescribed_density`,
- bootstrap provenance records that no charge potential was solved,
- `CurrentTransport(model="ohmic_poisson")` remains rejected in this task,
- charge-current observable is in A/m^2 and not normalized.

- [ ] **Step 2: Implement minimal prescribed-current path**

For the first executable slice, do not implement a fake `ohmic_poisson`. If contacts are absent, carry prescribed `J_c` from the resolved current source and write provenance that charge potential is not solved.

- [ ] **Step 3: Run native contract tests**

Run through the managed/container FEM route selected in Task 3.1.

Expected: pass.

### Task 3.2b: Implement Full Ohmic Poisson Charge-Contact Solve

**Files:**

- Modify: `backends/fem/cpu/mfem/interactions/she_charge.hpp`
- Modify: `backends/fem/cpu/mfem/interactions/she_charge.cpp`
- Modify: `backends/fem/cpu/mfem/interactions/she.*`
- Create: `backends/fem/tests/she_charge_transport_contract.cpp`
- Modify: `scripts/analysis/validate_she_drift_diffusion.py`

- [ ] **Step 1: Add charge-contact tests**

Tests must cover:

- voltage-contact gauge produces a unique `phi` up to the documented gauge rule,
- imposed contact current balances the integrated outgoing current within tolerance,
- `div(J_c)` residual is below the documented tolerance in the HM conducting region,
- open boundaries enforce the documented no-current condition,
- invalid, missing, duplicate, or disconnected contacts fail with targeted errors,
- `charge_potential`, `charge_current`, and contact-balance diagnostics are exposed only for the full solve.

- [ ] **Step 2: Implement Ohmic Poisson operator**

Assemble and solve:

```text
div(sigma grad(phi)) = 0
J_c = -sigma grad(phi)
```

Use the finite-element space, boundary marker, solver, and diagnostic patterns already used by native FEM modules. Do not hand-code a backend-specific public semantic in the runner.

- [ ] **Step 3: Add conservation diagnostics**

Expose:

```text
she_charge_residual_l2
she_charge_current_balance_a
she_charge_contact_currents_a
she_charge_gauge_policy
```

These diagnostics are required before full SHE can leave `source_visible`/bootstrap-only status.

- [ ] **Step 4: Run charge-contact contract tests**

Run the native contract target through the managed/container FEM route selected in Task 3.1.

Expected: charge solve tests pass and `CurrentTransport(model="ohmic_poisson")` can be marked executable only on the FEM CPU lane covered by this proof.

### Task 3.3: Implement Spin Accumulation Solve

**Files:**

- Create: `backends/fem/cpu/mfem/interactions/she_spin_diffusion.hpp`
- Create: `backends/fem/cpu/mfem/interactions/she_spin_diffusion.cpp`
- Modify: `backends/fem/cpu/mfem/interactions/she.*`
- Modify: `backends/fem/tests/she_contract.cpp`
- Create or modify: `scripts/analysis/validate_she_drift_diffusion.py`

- [ ] **Step 1: Add analytic 1D fixture**

Use a planar HM slab where expected `mu_s(z)` is known from the drift-diffusion equation. The test must compare profile shape and sign, not only nonzero output.

- [ ] **Step 2: Implement coupled spin solve**

Implement the coupling strategy selected in Task 0.1:

- if scalar H1 solves are selected, run Picard/relaxation over `mu_s.x/y/z` until the interface-coupling residual meets the documented tolerance,
- if a vector/block solve is selected, assemble the coupled interface term implicitly.

Do not run three one-shot independent scalar solves with the cross-component interface term dropped or frozen without a convergence loop.

- [ ] **Step 3: Add residual diagnostics**

Expose per-component solve residual/iteration count in native diagnostics or internal test hooks:

```text
she_spin_residual_l2.x/y/z
she_spin_iterations.x/y/z
she_spin_interface_residual_l2
she_spin_picard_iterations
```

Do not mark validation complete without residual visibility.

- [ ] **Step 4: Run analytic validation**

Run:

```bash
python3 scripts/analysis/validate_she_drift_diffusion.py --case hm_slab_1d
```

Expected: relative error below the tolerance documented in `docs/physics/0870-fem-she-drift-diffusion.md`.

### Task 3.4: Implement HM|FM Interface Coupling And Projection

**Files:**

- Create: `backends/fem/cpu/mfem/interactions/she_interface.hpp`
- Create: `backends/fem/cpu/mfem/interactions/she_interface.cpp`
- Create: `backends/fem/cpu/mfem/interactions/she_projection.hpp`
- Create: `backends/fem/cpu/mfem/interactions/she_projection.cpp`
- Modify: `backends/fem/cpu/mfem/interactions/she.*`
- Modify: `backends/fem/tests/she_contract.cpp`

- [ ] **Step 1: Add sign and symmetry tests**

Tests must assert expected sign changes for:

- `J_c -> -J_c`,
- `theta_sh -> -theta_sh`,
- interface normal reversal,
- `gmix_imag -> -gmix_imag`,
- `m parallel mu_s` damping-like torque vanishes,
- zero `theta_sh` or zero current produces zero SHE torque,
- `m . tau_she == 0` within tolerance,
- absorbed transverse spin flux and projected torque obey the documented angular-momentum sign convention.

- [ ] **Step 2: Implement interface flux**

Evaluate:

```text
with n oriented from HM toward FM:
n . J_s = -[ gmix_real m x (m x mu_s) + gmix_imag m x mu_s ]
tau_she = gamma_mu0 * hbar / (2 e Ms t_F)
          [ gmix_real m x (m x mu_s) + gmix_imag m x mu_s ]
```

Use the normal orientation documented in the physics note and tests. Interface resolution must consume the resolved HM|FM face set from the coupling/runtime resolver; do not infer faces from string name matching.

- [ ] **Step 3: Implement surface-to-volume torque projection**

Project interface torque onto FM magnetization DOFs using the simplest stable mass/lumped projection that matches current FEM field-buffer patterns. Record whether the torque is in `1/s` direct-RHS units.

The projection test must include nonuniform FM mesh spacing so the implementation cannot pass by applying one global area/volume scale.

- [ ] **Step 4: Run sign tests**

Run the native SHE contract target through the managed/container route.

Expected: all sign and zero-torque cases pass.

### Task 3.5: Add SHE Direct Torque To RK/Heun Stages

**Files:**

- Modify: `backends/fem/cpu/mfem/integrators/rk_stage_rhs.cpp`
- Modify: `backends/fem/cpu/mfem/integrators/rk_stage_rhs.hpp`
- Modify: `backends/fem/cpu/mfem/runtime/backend_step.cpp` only for timing/diagnostics.
- Modify: `backends/fem/tests/she_contract.cpp`

- [ ] **Step 1: Add stage-coupling test**

The test must prove SHE transport is evaluated from `m_stage`, not only from the beginning-of-step magnetization. Use a synthetic state where the interface term changes between stages. Cover every supported explicit RK integrator, not only Heun.

- [ ] **Step 2: Call SHE after `m_stage` is known**

The stage order must be:

```text
predict m_stage
assemble H_eff
compute LLG RHS
add STT direct torques
solve SHE transport for m_stage
add SHE direct torque
complete RK/Heun stage
```

If any integrator has a distinct RHS assembly path, add an explicit test or adapter assertion for that path.

- [ ] **Step 3: Add profiler phase ids**

Add disabled-by-default timings for:

```text
she_charge
she_spin_diffusion
she_interface_projection
she_rhs_add
```

Keep the existing solver profiler disabled-by-default behavior intact.

- [ ] **Step 4: Run managed FEM runtime smoke**

Run:

```bash
just fem-managed-headless cpu examples/she_hm_fm_drift_diffusion_1d.py
```

Expected: JSON run completes, requested FEM CPU is preserved, bootstrap/full-production status is explicit, and SHE diagnostics are present.

## Milestone 4: Observables, Artifacts, API, And Control Room

### Task 4.1: Expose Runtime Outputs

**Files:**

- Modify: native FEM observable mapping in `backends/fem/src/api.cpp`
- Modify: `crates/fullmag-runner/src/fem/`
- Modify: `crates/fullmag-api/src/artifacts.rs`
- Modify: `crates/fullmag-api/src/openapi_v2.rs` and related schemas only if resources change.

- [ ] **Step 1: Add output tests**

Tests must request:

- `spin_accumulation`,
- `spin_accumulation.y`,
- `she_torque`,
- `she_torque.x`,
- `charge_current`,
- `charge_potential` for full `ohmic_poisson` runs only,
- `spin_current_interface`.

They must verify vector/scalar component shapes, units metadata, support status, and bootstrap-vs-full-production availability.

- [ ] **Step 2: Implement data plumbing**

Expose outputs through existing resource/artifact paths. Do not put heavy fields into thin status.

Use the resource-first shape:

```text
GET /v2/sessions/current/data/quantities
GET /v2/sessions/current/data/fields/{quantity_id}/meta
binary data plane for mu_s, J_c, J_s, tau_she, and component fields
```

Thin status may expose only capability flags, revision ids, and small diagnostics summaries.

- [ ] **Step 3: Run API/schema tests**

Run the narrow API tests affected by resource or OpenAPI changes. If generated OpenAPI changes, regenerate and keep `apps/control-room/src/kernel/api/generated/openapi-v2.json` and types consistent. Generated frontend transport/types must be updated through the established OpenAPI generation path, not by hand.

### Task 4.2: Add Control Room Capability And Inspector Surface

**Files:**

- Modify: `apps/control-room/src/kernel/api/quantityIds.ts`
- Modify: `apps/control-room/src/kernel/api/ControlRoomApi.ts` and `apps/control-room/src/kernel/api/apiTypes.ts` if resource methods or types change.
- Modify: resource hooks/domain adapters that map runtime quantities.
- Modify: `apps/control-room/src/modules/inspector/panels/CouplingInspectorPanelModel.ts` and `CouplingInspectorPanel.tsx` for HM|FM interface authoring/readout.
- Modify: `apps/control-room/src/modules/inspector/panels/PhysicsInteractionPanelModel.ts` and `PhysicsInteractionPanel.tsx` only if object interaction panels own SHE torque controls.
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts`, `ObjectMeshPolicyPanel.tsx`, `ObjectRegionsPanelModel.ts`, and `ObjectRegionsPanel.tsx` for mesh/contact/interface diagnostics.
- Modify: `apps/control-room/src/modules/ribbon/ribbonCommands.ts` and `ribbonContributions.tsx` for discoverable commands.
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dFieldMapping.ts`, `viewport3dDomainAdapter.ts`, and `layers/VectorFieldLayer.tsx` only when rendering SHE quantities.
- Modify: generated OpenAPI files only from source generation.

- [ ] **Step 1: Add capability-gating tests**

Control room must show SHE quantities only when `status.capabilities` and `/v2/sessions/current/data/quantities` say they exist. It must not branch into a separate FEM app tree.

Tests must cover:

- no direct component `fetch()`,
- no hand-rolled endpoint strings outside the API client layer,
- bootstrap runs show no `charge_potential` layer,
- full production runs show `charge_potential`, `charge_current`, `spin_accumulation`, `spin_current_interface`, and `she_torque`,
- forced unsupported GPU status appears as unsupported with no silent CPU fallback.

- [ ] **Step 2: Add inspector/readout entries**

Expose requested/resolved SHE status, source binding, HM/FM/interface coupling, charge contacts, gauge policy, mesh/interface resolution diagnostics, bootstrap-vs-full-production status, and available output quantities.

The authoring UI must use the same canonical model as Python:

- current source/contact UI writes `CurrentTransport`,
- HM|FM interface UI writes a typed coupling under the existing `model/couplings` concept,
- SHE torque UI references the current source and coupling id,
- canonical Python export reproduces the selected UI-authored SHE setup.

- [ ] **Step 3: Run required control-room gate**

Every `apps/control-room` change must pass:

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
```

For viewport rendering of new SHE layers, also run the browser smoke required by AGENTS.md for WebGL/viewport changes.

Viewport smoke must assert the canvas is visible, WebGL context is not lost, drawing buffer dimensions are nonzero, and the SHE quantity layer toggles do not hide the base magnetic mesh.

## Milestone 5: Validation And Release Qualification

### Task 5.1: Add Analytic And Effective-Limit Validation

**Files:**

- Create: `examples/she_hm_fm_drift_diffusion_1d.py`
- Create: `scripts/analysis/validate_she_drift_diffusion.py`
- Modify: `docs/physics/0870-fem-she-drift-diffusion.md`

- [ ] **Step 1: Validate HM-only slab**

Run:

```bash
just fem-managed-headless cpu examples/she_hm_fm_drift_diffusion_1d.py
python3 scripts/analysis/validate_she_drift_diffusion.py --case hm_slab_1d
```

Expected: documented tolerance passes for `mu_s(z)`.

- [ ] **Step 2: Validate effective SOT limit**

Run:

```bash
python3 scripts/analysis/validate_she_drift_diffusion.py --case effective_sot_limit
```

Expected: average torque matches the documented DL/FL effective limit within tolerance.

- [ ] **Step 3: Validate sign matrix**

Run:

```bash
python3 scripts/analysis/validate_she_drift_diffusion.py --case sign_matrix
```

Expected: all expected sign reversals pass.

- [ ] **Step 4: Validate mesh refinement against `lambda_sf`**

Run:

```bash
python3 scripts/analysis/validate_she_drift_diffusion.py --case mesh_refinement_lambda_sf
```

Expected: convergence trend matches the documented tolerance and fails when the mesh has fewer than the documented elements across `min(lambda_sf, t_HM)`.

- [ ] **Step 5: Validate Liu/Ta-like and Thiaville DW trends**

Run:

```bash
python3 scripts/analysis/validate_she_drift_diffusion.py --case liu_ta_amplitude_trend
python3 scripts/analysis/validate_she_drift_diffusion.py --case thiaville_dw_dmi_she_trend
```

Expected: trend direction and normalized amplitude windows match the physics note. These are trend gates, not fitted-parameter claims.

- [ ] **Step 6: Validate 3D contact crowding**

Run:

```bash
just fem-managed-headless cpu examples/she_hm_fm_contact_crowding_3d.py
python3 scripts/analysis/validate_she_drift_diffusion.py --case contact_crowding_3d
```

Expected: charge-current conservation, contact current balance, interface torque localization, and provenance for contact/gauge resolution pass documented tolerances.

### Task 5.2: Managed Runtime Proof

**Files:**

- Modify or create validation scripts only if needed.

- [ ] **Step 1: Rebuild managed FEM runtime**

Run:

```bash
just rebuild-fem-runtime
```

Expected: managed FEM runtime bundle is rebuilt successfully.

- [ ] **Step 2: Run FEM CPU runtime proof**

Run:

```bash
just fem-managed-headless cpu examples/she_hm_fm_drift_diffusion_1d.py
just fem-managed-headless cpu examples/she_hm_fm_contact_crowding_3d.py
```

Expected: both runs complete with SHE enabled, explicit bootstrap/full-production status, and no CPU/GPU fallback ambiguity.

- [ ] **Step 3: Run existing FEM regression smoke**

Run:

```bash
just verify-fem-relaxation-runtime
```

Expected: existing relaxation runtime still passes.

### Task 5.3: FEM GPU Slice After CPU Validation

**Files:**

- Create: `backends/fem/gpu/cuda/interactions/she/she_kernels.hpp`
- Create: `backends/fem/gpu/cuda/interactions/she/she_kernels.cu`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_direct_torques.*`
- Modify: GPU runtime dispatch/residency files under `backends/fem/gpu/cuda/`.
- Modify: `docs/specs/capability-matrix-v0.md` and `.json` only after proof.

- [ ] **Step 1: Keep GPU semantic parity with CPU**

Port the same direct-torque signs, units, and output ids. Do not introduce a second SHE equation set for GPU.

- [ ] **Step 2: Add CPU/GPU parity tests**

Compare:

- `tau_she` vector field,
- average torque,
- sign matrix,
- run provenance,
- profiler phases and host/device transfer counts,
- contact solve diagnostics if GPU slice includes full production `ohmic_poisson`; otherwise GPU must advertise only the bootstrap subset.

- [ ] **Step 3: Run managed GPU proof**

Run:

```bash
just rebuild-fem-runtime
just fem-managed-headless gpu examples/she_hm_fm_drift_diffusion_1d.py
```

Expected: forced GPU stays GPU for the implemented subset or fails clearly with a SHE-specific unsupported diagnostic. Silent CPU fallback is a failure.

- [ ] **Step 4: Update capability status**

Only after Step 3 passes, move FEM GPU SHE from `semantic_only`/`source_visible` to `production_executable`. Do not mark it `validated` until CPU/GPU parity and analytic validation run in CI or an equivalent repeatable gate.

## Milestone 6: Final Completion Audit

### Task 6.1: Requirement Coverage Audit

**Files:**

- `docs/plans/active/SHE.md`
- `docs/physics/0870-fem-she-drift-diffusion.md`
- `docs/specs/she-drift-diffusion-fem.md`
- `docs/specs/capability-matrix-v0.md`
- implementation files touched by Milestones 1-5.

- [ ] **Step 1: Build a report-to-task matrix**

Create a short checklist in the PR description or implementation report mapping:

- API and planner,
- FEM transport and HM|FM boundary conditions,
- charge-contact solve and current-conservation diagnostics,
- mesh/interface/contact resolution diagnostics,
- LLG/RK stage coupling,
- observables,
- OpenAPI/resource/UI authoring and canonical Python export,
- validation,
- managed runtime proof,
- capability status.

- [ ] **Step 2: Search for stale semantic-only claims**

Run:

```bash
rg -n "DriftDiffusionSpinTorque.*semantic_only|drift_diffusion.*semantic_only|SHE.*semantic_only|spin_hall.*semantic_only" docs packages crates apps backends
```

Expected: only intentional capability rows for unsupported lanes remain.

- [ ] **Step 3: Run final gates**

Minimum final gates after CPU implementation:

```bash
python3 -m pytest packages/fullmag-py/tests/test_she_drift_diffusion.py packages/fullmag-py/tests/test_current_transport.py packages/fullmag-py/tests/test_stno_spin_torque.py -q
cargo test -p fullmag-ir
cargo test -p fullmag-plan
cargo test -p fullmag-quantities
just rebuild-fem-runtime
just fem-managed-headless cpu examples/she_hm_fm_drift_diffusion_1d.py
just fem-managed-headless cpu examples/she_hm_fm_contact_crowding_3d.py
python3 scripts/analysis/validate_she_drift_diffusion.py --case hm_slab_1d
python3 scripts/analysis/validate_she_drift_diffusion.py --case effective_sot_limit
python3 scripts/analysis/validate_she_drift_diffusion.py --case sign_matrix
python3 scripts/analysis/validate_she_drift_diffusion.py --case mesh_refinement_lambda_sf
python3 scripts/analysis/validate_she_drift_diffusion.py --case contact_crowding_3d
just verify-fem-relaxation-runtime
```

Add control-room gates if `apps/control-room` changed:

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
```

Expected: all pass. A host-only Cargo/CMake pass is not enough for native FEM closure.

## Non-Goals For The First Implementation

- No FDM full drift-diffusion SHE solve.
- No hidden `ohmic_poisson` execution without electrode/contact boundary conditions.
- No production-ready label for the prescribed-current bootstrap subset.
- No multi-torque composition unless planner capability and direct-RHS ordering are explicitly expanded.
- No UI-only SHE editor state that cannot round-trip to Python DSL and `ProblemIR`.
- No `validated` capability status until analytic fixtures and managed runtime gates pass.
- No new FEM solver logic in generic runner dispatch or `mfem_bridge.cpp`.

## Risk Register

| Risk | Mitigation |
|---|---|
| Unit convention drift for `mu_s`, `J_s`, and `gmix` | Physics note must define one convention; native tests cover SI prefactors and effective-limit torque. |
| Interface normal sign bugs | Sign matrix tests must flip `J`, `theta_SH`, normal, `gmix_imag`, and selected `m` states. |
| Prescribed-current bootstrap is mistaken for full production | Capability matrix, provenance, examples, and UI labels must distinguish bootstrap from full contact solve. |
| Contact solve violates current conservation | Full production gates require `div(J_c)`, contact-current balance, and gauge diagnostics. |
| HM|FM interface cannot be resolved from authored strings | Use typed surface endpoints through `CouplingIR` or an equivalent documented coupling owner. |
| Mesh under-resolves `lambda_sf` or HM thickness | Mesh policy and validation require documented elements across `min(lambda_sf, t_HM)`. |
| Scalar spin solves drop interface coupling | Require either Picard/relaxation convergence for scalar solves or a block/vector spin solve. |
| Solver cost explodes from four elliptic solves per RK stage | Start from the documented coupled strategy, cache geometry/operators, add profiler phases before optimizing. |
| FEM GPU silently falls back to CPU | Forced GPU SHE must fail clearly until GPU slice passes; provenance must record requested and resolved execution. |
| Planner exposes executable status before validation | Capability matrix must distinguish `production_executable` from `validated`. |
| UI forks FDM/FEM authoring semantics | Control room must consume same capability/resource vocabulary and canonical Python round-trip. |
