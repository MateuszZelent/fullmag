---
title: Physics, Couplings, Frozen Spins, Antennas & Transport
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-inspectors-physics-antennas-and-transport)=
# Physics, Couplings, Frozen Spins, Antennas & Transport

The Control Room splits micromagnetic and spintronic physics authoring into dedicated inspector
panels governed by lane capabilities (`useActiveLaneCapabilities` and `interactionSpecsForDiscretization`).
Every panel shares the `PhysicsInspectorOverview` header contract (`scope.kind`, `stableRef`, and
upstream dependency readiness) and enforces optimistic `scene_revision` concurrency on commit.

## Micromagnetic Interactions, Couplings, and Frozen Spins

```{image} /_static/images/ui/inspector-physics-couplings-frozen-spins.png
:alt: Frozen Spins inspector configuring constraint frz_edge_pin with In region selection targeting obj_yig_film and reg_pinning_ring
:align: center
:width: 100%
```

- **Local & Global Interactions (`ObjectPhysicsInspectorPanel`, `PhysicsModuleInspectorPanel`)**: Edits per-object or study-wide micromagnetic terms—exchange, uniaxial/cubic anisotropy (with opt-in material physics activation), external Zeeman bias, Dzyaloshinskii–Moriya interactions (`bulk`, `interfacial`, `D2d`), RKKY/surface coupling terms, and stray/demagnetizing toggles—showing active-lane availability and disabled reasons (`resolveActiveLaneOperation`) when a discretization or solver lane withholds a term.
- **Regional Field Drives & Mask Antennas (`FieldDriveInspectorPanel`, `RegionalFieldDrivePanel`, `AntennaRegionalMaskInspectorSpecPanel`)**: Configures spatially localized or masked external field waveforms (`sinc`, `sinusoidal`, `piecewise_linear`) with unit-aware scalar inputs (`ps`/`ns`, `GHz`/`Hz`, `m`/`nm`, `rad`, `mT`/`T`) and live `SincPulsePreview` plots.
- **Explicit Couplings (`CouplingInspectorPanel`)**: Inspects object-pair or region-pair couplings (`toggle-enabled`, `delete`) with immediate history-tracked mutations via `MODEL_COUPLINGS_RESOURCE_KEY`.
- **Frozen Spins Constraints (`FrozenSpinsInspectorPanel`)**: Authors `FrozenSpinsDefinition` policies using `SelectionExpressionBuilder` predicates, membership and reference-state policies, runtime preview visualization (`FrozenSpinsOverlay`), and solver activation controls across objects or regions.

## RF Antennas and Arbitrary Waveforms

- **Canonical Field-Drive & Solved Antennas (`inspectors/objects/antenna/*`, `AntennaObjectPanel`)**: Eleven dedicated antenna routes (`AntennaOverviewInspectorSpecPanel`, `AntennaRegionalMaskInspectorSpecPanel`, `AntennaGeometryInspectorSpecPanel`, `AntennaTerminalsInspectorSpecPanel`, `AntennaConductorInspectorSpecPanel`, `AntennaPortInspectorSpecPanel`, `AntennaSolutionInspectorSpecPanel`, `AntennaProjectionInspectorSpecPanel`, `AntennaDriveInspectorSpecPanel`, `AntennaSpectrumInspectorSpecPanel`, `AntennaVisualizationInspectorSpecPanel`) configure antenna excitation direction, field amplitude (`mT`/`T`), `sinc` / `sinusoidal` / piecewise waveform tables, conductor geometry, OCC terminals, resistive/lumped ports, pre-solved magnetic field basis overlays in 3D, and explicit antenna round trips with `scene_revision` conflict detection/rebase.

```{image} /_static/images/ui/inspector-antenna-rf-and-waveforms.png
:alt: Solved antenna drive inspector showing Preview t0, Current I(t) [A] waveform plot, CSV/TSV/PNG export controls, and preview sample scrubber
:align: center
:width: 100%
```

## Spin Transport, Spin Torques, Oersted Fields & Spin Interfaces

- **Current & Spin Transport (`CurrentTransportInspectorPanel`, `SpinTransportInspectorPanel`, `StructuredCurrentClosureInspectorPanel`, `StructuredCurrentSourceCutInspectorPanel`)**: Authors `current_transport` and `spin_transport` scene records (including conductor transport quantities on resolved object cells and staged spin Hall currents on continuous FDM grids), closure definitions, structured current source cuts, validation requests (`transport-authoring-validation.v1`), and prescribed density policies where supported by the active lane.
- **Spin-Transfer / Spin–Orbit Torques & Oersted Fields (`SpinTorqueInspectorPanel`, `OerstedFieldInspectorPanel`)**:
  - `spin_torque`: Supports `zhang_li` (adiabatic/non-adiabatic $\beta$), `slonczewski` ($\lambda$ asymmetry, $\epsilon'$, polarization, free-layer thickness, fixed-layer orientation), and `prescribed_sot` ($\xi_{\text{DL}}$, $\xi_{\text{FL}}$, stack normal), bound either directly to prescribed current density or to an upstream `current_transport` source.
  - `oersted_field`: Supports `oersted_cylinder` and `oersted_field` (`from_current_solution`) bound to current transport solutions.
- **Spin Interfaces (`SpinInterfaceInspectorPanel`)**: Authors `transparent` and normal/ferromagnet mixing interfaces across explicit regions. On tetrahedral FEM meshes, `verifySpinInterfaceMeshOrientation` queries shared `tet4` interface facet adjacency and verifies whether the authored interface normal agrees with side $A \to B$ orientation (reporting shared facet count and physical interface area in $\text{m}^2$).

```{image} /_static/images/ui/inspector-spin-transport-sot-stt.png
:alt: Transport torque inspector displaying st_sot_stack scope, lane, and status cards, Prescribed SOT model, and SOT drive JSON payload
:align: center
:width: 100%
```

## Selection routes and Python interoperability

- **Selection routes**: `object.physics` / `physics.module` (`ObjectPhysicsInspectorPanel`, `PhysicsModuleInspectorPanel`), `physics.coupling` (`CouplingInspectorPanel`), `physics.field-drive` (`FieldDriveInspectorPanel`), `object.frozen-spins` (`FrozenSpinsInspectorPanel`), `object.antenna*` (11 `Antenna*InspectorSpecPanel` routes), `physics.current-transport` / `physics.spin-transport` (`CurrentTransportInspectorPanel`, `SpinTransportInspectorPanel`), `physics.spin-torque` / `physics.oersted-field` (`SpinTorqueInspectorPanel`, `OerstedFieldInspectorPanel`), and `physics.spin-interface` (`SpinInterfaceInspectorPanel`).
- **Mutation discipline**: All authoring transactions run through `runAuthoringMutationWithHistory`, support Undo/Redo, and verify active lane capability matrices before enabling writes.
- **Python alignment**: Physics modules, field drives, antennas, frozen spins, current/spin transport, and spin interfaces map directly to their `packages/fullmag-py` constructors on objects, regions, and `Study`. Specialized material field closures or custom solver coefficients without a dedicated inspector form remain `Python-only` (see {doc}`/frontend/capability-register`).

## Source-code index

| Responsibility | Repository path | Stable symbol |
|---|---|---|
| Local/global interaction panel | `apps/control-room/src/modules/inspector/inspectors/objects/physics/ObjectPhysicsSpec.tsx` | `ObjectPhysicsInspectorPanel` |
| Shared physics overview & dependency header | `apps/control-room/src/modules/inspector/panels/PhysicsInspectorOverview.tsx` | `PhysicsInspectorOverview` |
| Regional field drives & sinc preview | `apps/control-room/src/modules/inspector/panels/RegionalFieldDrivePanel.tsx` | `RegionalFieldDrivePanel` |
| Explicit inter-object/region couplings | `apps/control-room/src/modules/inspector/inspectors/objects/physics/DemagAndCouplingSpecs.tsx` | `CouplingInspectorPanel` |
| Frozen spins constraints & selection rules | `apps/control-room/src/modules/inspector/panels/constraint/FrozenSpinsInspectorPanel.tsx` | `FrozenSpinsInspectorPanel` |
| Antenna composition overview & sub-specs | `apps/control-room/src/modules/inspector/inspectors/objects/antenna/AntennaOverviewSpec.tsx` | `AntennaOverviewInspectorSpecPanel` |
| Antenna RF & waveform authoring | `apps/control-room/src/modules/inspector/panels/AntennaObjectPanel.tsx` | `AntennaObjectPanel` |
| Current transport closures | `apps/control-room/src/modules/inspector/panels/transport/CurrentTransportPanel.tsx` | `CurrentTransportInspectorPanel` |
| Spin transport closures | `apps/control-room/src/modules/inspector/panels/transport/SpinTransportPanel.tsx` | `SpinTransportInspectorPanel` |
| Spin torque | `apps/control-room/src/modules/inspector/inspectors/objects/transport/SpinTorqueSpec.tsx` | `SpinTorqueInspectorPanel` |
| Oersted field | `apps/control-room/src/modules/inspector/panels/transport/OerstedFieldPanel.tsx` | `OerstedFieldInspectorPanel` |
| Spin interface & tet4 orientation proof | `apps/control-room/src/modules/inspector/panels/transport/SpinInterfacePanel.tsx` | `SpinInterfaceInspectorPanel` |
