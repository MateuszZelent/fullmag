# ADR 0086: explicit opt-in material-driven physics activation

- Status: accepted for implementation
- Date: 2026-11-22
- Complements: [ADR 0008](0008-inspector-draft-apply-transaction.md), [ADR 0024](0024-compositional-physics-object-model.md), [ADR 0083](0083-material-library-and-self-contained-model-copies.md)
- Governance contract: `AGENTS.md` ("Physics modules must only be activated explicitly")

## Context

In the Control Room Material inspector (`ObjectMaterialSpec`), authoring constitutive material parameters ($M_s$, $A_{\mathrm{ex}}$, $K_{u1}/K_{u2}$, $K_{c1}/K_{c2}/K_{c3}$, $D_{\mathrm{ind}}$, $D_{\mathrm{bulk}}$) or assigning a library preset (for example Permalloy, CoFeB, or hcp Cobalt) commonly precedes enabling the matching physics interactions (`exchange`, `uniaxial_anisotropy`, `cubic_anisotropy`, `interfacial_dmi`, `bulk_dmi`) and study-level flags (`study.demag_enabled`, `study.exchange_enabled`).

A previous remediation change activated these physics interactions and global study flags automatically whenever a material was assigned or edited, swallowing activation failures in empty `catch {}` blocks. That violated two core repository invariants:

1. **Explicit physics activation.** `AGENTS.md` and ADR 0024 require that physics modules are never enabled implicitly or silently as a side effect of assigning a material, especially when study-level flags affect every magnetic object in the scene.
2. **Visible failure reporting.** Swallowing backend rejection errors in empty `catch {}` blocks hides unsupported lane/capability failures and leaves the user believing an interaction was activated when it was not.

At the same time, users want a fast, discoverable workflow to activate the physics modules required by a newly assigned material without navigating across multiple Physics inspector pages.

## Decision

1. **Explicit opt-in control, off by default.** The Material inspector draft (`UnifiedObjectMaterialDraft`) carries an explicit boolean field `activateRequiredPhysics` defaulting to `false`. The UI renders a dedicated switch labeled `"Also enable required physics modules on Apply"` in the Material assignment section for magnetic bodies.
2. **Transparent live preview of pending activations.** Below the switch, the inspector renders a live summary with badges computed from a pure shared selector (`computePendingPhysicsActivations`) listing the exact inactive object interactions and disabled study flags (`Exchange`, `Uniaxial anisotropy`, `Cubic anisotropy`, `Interfacial DMI`, `Bulk DMI`, `Demag`, `Exchange (study)`) that will be enabled if opted in.
3. **Zero silent activation when off.** When `activateRequiredPhysics` is `false`:
   - Assigning or editing a material never calls `patchObjectInteraction` for `exchange`, `interfacial_dmi`, or `bulk_dmi`, and never mutates `study.demag_enabled` or `study.exchange_enabled`.
   - Uniaxial and cubic anisotropy interactions are persisted strictly according to the user's explicit `uniaxialEnabled` / `cubicEnabled` controls and parameter edits.
4. **Structured error reporting — no empty `catch {}`.** When `activateRequiredPhysics` is `true`, each activation failure is captured into a structured `PhysicsActivationError[]` list (`module`, `label`, `message`) returned from `commitObjectMaterialDraft` and displayed in an inspector error notice (`tone: "err"`) so partial activation failures are immediately visible.
5. **Bundled study mutations.** When constitutive metadata and opted-in study physics flags (`demag_enabled`, `exchange_enabled`) are both changed during Apply, they are merged into a single `merge_patch` transaction rather than issuing redundant study transactions.

## Consequences

- Default material assignment and editing strictly honors the explicit-physics contract in `AGENTS.md` and never alters global study flags or other objects unexpectedly.
- Users who want one-click physics setup from material parameters can opt in explicitly, inspect the exact badges of modules to be enabled before clicking Apply, and see any lane/API activation errors clearly.
- Existing material API endpoints, `SceneDocument` schema, and canonical Python export remain unchanged.
