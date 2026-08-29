---
title: Control Room capability register
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-capability-register)=
# Control Room capability register

This register is the frontend source of truth used by public documentation
entries. It separates a Python/ProblemIR capability from an actually authored
Control Room path. A Python option is never described as UI-supported merely
because the backend can represent it.

## 1. How to read the status

| Status | Meaning for documentation |
|---|---|
| `implemented` | The named Control Room route and fields exist in the current frontend source. The feature page must give the exact tree, panel, field group, and Apply/Build action. |
| `partial` | A related panel exists, but only a subset of the Python/API surface is exposed. The page must list the supported subset and mark the remaining parameters as TODO. |
| `TODO` | No supported authoring route exists. The page must direct the user to Python and record the missing UI route as a TODO. |
| `inspection-only` | The UI displays resolved or runtime data but does not author the corresponding Python option. Do not describe inspection as configuration. |

## 2. Current authoring routes

| Capability | Control Room route | Current status | Source owner |
|---|---|---|---|
| Geometry object and basic shape authoring | `Model Explorer -> Objects -> <object> -> Geometry` | `partial` | `GeometryObjectPanel` |
| Scalar magnetic material values | `Model Explorer -> Objects -> <object> -> Material` | `partial` | `ObjectMaterialPanel` |
| Magnetic interaction selection | `Model Explorer -> Objects -> <object> -> Physics` | `partial` | `PhysicsInteractionPanel` |
| Initial magnetization texture | `Model Explorer -> Objects -> <object> -> Magnetization` | `partial` | `ObjectMagneticTexturePanel` |
| FDM/FEM mesh policy | `Model Explorer -> Objects -> <object> -> Mesh` | `implemented` for advertised fields only | `ObjectMeshPolicyPanel` |
| Region material and mesh overrides | `Model Explorer -> Objects -> <object> -> Regions` | `partial` | `ObjectRegionOverviewPanel`, `ObjectRegionMeshPanel` |
| Study and stage authoring | `Model Explorer -> Stages -> Add stage` | `partial` | `StudyStageDraftEditor`, `StudyGlobalAuthoringModel` |
| Relax/run/eigenmode/frequency result inspection | `Model Explorer -> Stages -> <stage> -> Inspector` | `partial` | `RelaxStageInspector`, `RunStageInspector`, `EigenmodesStageInspector`, `FrequencyResponseStageInspector` |
| Table and field autosave | `Model Explorer -> Stages -> <stage> -> Autosave` | `partial` | `AutosaveStageInspector`, `TableAutosaveStageInspector` |
| Runtime and resolved ProblemIR metadata | `Model Explorer -> Runtime` | `inspection-only` | `RuntimeExplorerInspectorPanels`, `StudyInspectorPanel` |

## 3. Parameter classes with explicit TODO

The following classes must remain marked as frontend TODO until a dedicated
authoring control and transaction exists in `apps/control-room`:

| Python/API surface | Required documentation status |
|---|---|
| Standalone `Problem`, `ProblemIR`, and direct IR editing | `TODO`: the Control Room authors a study, not an arbitrary standalone IR document. |
| Advanced geometry boolean/import/auxiliary operations not present in `GeometryObjectPanel` | `TODO`: document the Python route and do not invent an inspector path. |
| Spatial material fields and interaction-specific fields absent from `ObjectMaterialPanel` or `PhysicsInteractionPanel` | `TODO`: scalar UI support does not imply field support. |
| Texture presets not exposed by `ObjectMagneticTexturePanel` | `TODO`: list the exposed subset and retain Python as the current route. |
| Runtime selection, artifact publication, and provenance mutation | `inspection-only` or `TODO`: runtime metadata is displayed, not authored, unless a source-backed transaction is named. |
| Backend-specific solver options without a corresponding stage editor field | `TODO`: show the Python signature and planner/backend status separately. |

## 4. Required per-page frontend section

Every terminal page must contain a section named `How to set it in Control
Room` or `Control Room crosswalk`. That section must include:

1. the exact tree and panel path when a route is implemented;
2. the field group and parameter names exposed by that panel;
3. the transaction (`Apply`, `Build`, or stage submission) and invalidation;
4. the supported subset when the route is partial;
5. a literal `TODO: frontend support` entry for every parameter with no route;
6. a link to this register and the frontend source symbol.

## 5. Source-code index

| Claim | Repository path | Stable symbol |
|---|---|---|
| Geometry authoring | `apps/control-room/src/modules/inspector/panels/GeometryObjectPanel.tsx` | `GeometryObjectPanel` |
| Material authoring | `apps/control-room/src/modules/inspector/panels/ObjectMaterialPanel.tsx` | `ObjectMaterialPanel` |
| Interaction authoring | `apps/control-room/src/modules/inspector/panels/PhysicsInteractionPanel.tsx` | `PhysicsInteractionPanel` |
| Texture authoring | `apps/control-room/src/modules/inspector/panels/ObjectMagneticTexturePanel.tsx` | `ObjectMagneticTexturePanel` |
| Mesh authoring | `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx` | `ObjectMeshPolicyPanel` |
| Stage authoring | `apps/control-room/src/modules/inspector/panels/StudyStageDraftEditor.tsx` | `StudyStageDraftEditor` |
| Runtime inspection | `apps/control-room/src/modules/inspector/panels/RuntimeExplorerInspectorPanels.tsx` | `RuntimeExplorerInspectorPanels` |
## Control Room crosswalk

This page is the Control Room surface itself. The status is `partial` unless every listed field has a named inspector and transaction. Fields not present in the cited component are `TODO: frontend support`; runtime/result-only views are `inspection-only`. See {doc}`/frontend/capability-register`.

## Python/API crosswalk

Python remains the authoritative authoring contract. Use the linked `{doc}``/python-api/index` pages for exact constructors, functions, arguments, units, and failure semantics; this page must not invent a Python signature.

## Physics and bibliography scope

This UI page introduces no independent physical model. It presents controls for an existing backend contract. Bibliography: not applicable unless a terminal page below introduces a scientific model; implementation references are the cited frontend component and linked API page.
## Source-code index

- Frontend implementation owners: `apps/control-room/src/modules/inspector/panels/GeometryObjectPanel.tsx`, `ObjectMaterialPanel.tsx`, `PhysicsInteractionPanel.tsx`, `ObjectMagneticTexturePanel.tsx`, `ObjectMeshPolicyPanel.tsx`, and `StudyStageDraftEditor.tsx`, as applicable to the route above.

