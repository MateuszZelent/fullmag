# Explorer Defaults and Region Inheritance Design

**Status:** Accepted design awaiting written-spec review

**Date:** 2026-07-17

**Scope:** Control Room Explorer defaults and canonical object-region inheritance

## Goal

Make the model tree open at the useful object level while keeping mesh details
collapsed, and make every region inherit its parent object's effective settings
until an author explicitly creates a region-local override.

## User-visible behavior

### Explorer defaults

- The `Objects` branch and every `object.root` node are expanded when they first
  appear in a new Explorer session.
- Mesh subtree roots are collapsed by default. This applies to the model-level
  mesh branch, object mesh branches, and airbox mesh branches that have children.
- Existing explicit user expansion choices are preserved when resources refresh.
  A refresh must not repeatedly force objects open or mesh branches closed.
- Selection reveal and filtering may expand the ancestors required to expose a
  target. This remains explicit navigation behavior, not a new default.
- Resetting the Explorer store restores these semantic defaults.

Defaults are based on node kinds rather than hard-coded instance IDs so that
objects loaded after the initial static tree receive the same behavior.

### Region inheritance

A region is a child scope of its owning object. Its effective configuration is:

```text
effective region value = local region override ?? effective parent object value
```

This rule applies consistently to:

- material assignment and magnetic parameters such as `Ms`, `Aex`, `alpha`,
  and anisotropy parameters;
- magnetization texture and texture transforms;
- mesh policy and mesh sizing controls;
- visualization settings, including visibility, representation, color/quantity,
  opacity, wireframe, glyph, range, and related display controls;
- future region-editable settings unless their contract explicitly declares
  non-inheritance.

Inheritance is dynamic. If the parent object changes, a region without a local
override immediately resolves to the new parent value. Creating a region must
not copy the current parent values into region-owned storage.

An explicit Python assignment, UI edit, or canonical API patch creates a local
override only for the changed setting. Unchanged settings continue to inherit.
`Reset to parent` removes the corresponding local override instead of copying a
parent value into it.

## Canonical data contract

Parent resources remain the source of inherited values. Region resources store
only authored region-local differences and the metadata needed to identify the
owning object. The API must preserve the distinction between:

- an absent override, meaning dynamically inherited;
- an explicit local value, including a value numerically equal to the parent;
- an explicit reset operation, meaning removal of the local override.

Python-authored and UI-authored problems must converge to the same representation.
Python serialization and script export must emit region assignments only when
they are explicit in the canonical model. Runtime and visualization adapters
must consume effective values without materializing inherited values as local
overrides.

## Ownership and data flow

### Explorer expansion state

Expanded node IDs remain private module UI state in
`apps/control-room/src/modules/explorer/explorerStore.ts`. A pure semantic
default resolver derives initial expansion from the current tree. It recognizes
`objects.root` and `object.root` as expanded defaults and mesh subtree roots as
collapsed defaults. The store records which dynamic nodes have already received
a default so resource refreshes do not overwrite user choices.

### Effective region settings

Canonical parent and region resources remain server-owned data. Typed, pure
domain adapters resolve effective region values for inspectors and viewport
planning. Explorer or inspector stores must not copy full object, region, mesh,
or visualization resources.

The resolution order is:

```text
Python/UI authoring
  -> canonical object plus sparse region overrides
  -> ProblemIR/API resources
  -> pure effective-region resolver
  -> inspector presentation and viewport render planning
```

No React component may invent a second inheritance rule. Each setting family
must use its existing canonical resolver or be migrated to one shared resolver
for that family.

## Editing behavior

- Region controls initially display the effective inherited value and an
  `Inherited from object` state.
- Editing one control creates an override for that control only.
- Other controls continue to follow the parent.
- A parent update propagates only to settings without local overrides.
- Resetting one control removes only its override; resetting a section removes
  the overrides owned by that section.
- Visualization is inherited at simulation/session start and remains inherited
  until a region-specific visualization patch is submitted.

## Compatibility and migration

Existing sparse region overrides retain their meaning. Existing resources that
already omit an override are interpreted as inherited; no data migration or
eager backfill is required. If a legacy payload contains copied parent values as
explicit region values, they remain explicit overrides because intent cannot be
reliably inferred from numerical equality.

This change does not alter solver physics, region geometry, priority,
realization policy, mesh membership, or the ownership of canonical resources.

## Error handling

- A region without a resolvable parent object is degraded and reports a clear
  diagnostic instead of silently using arbitrary defaults.
- Unsupported region-local settings remain capability-gated and inherit the
  parent when no supported override exists.
- Invalid explicit overrides are rejected by the existing authoring/API
  validation path; inheritance itself does not mask invalid authored data.

## Verification

Focused tests must prove:

1. a new/reset Explorer expands `Objects` and dynamic object roots;
2. model, object, and airbox mesh subtree roots are collapsed by default;
3. resource refresh does not undo an explicit expand/collapse choice;
4. inherited material, magnetic, texture, mesh, and visualization values follow
   a parent update dynamically;
5. a local override isolates only its setting from later parent updates;
6. `Reset to parent` removes the override and restores dynamic inheritance;
7. Python-authored explicit region values survive the resource and UI path;
8. absent Python region values are not synthesized into local overrides;
9. region visualization initially equals object visualization and diverges only
   after an explicit region patch.

Frontend completion requires focused Vitest coverage plus the full Control Room
`typecheck`, zero-warning `lint`, test suite, React Doctor comparison, and a
browser smoke showing the initial Explorer expansion state and inherited region
visualization.

## Non-goals

- Copy-on-create region settings.
- Persisting canonical region or visualization resources in the Explorer store.
- Changing region nesting support.
- Redesigning Explorer layout, icons, labels, or selection semantics.
- Inferring that an explicit region value equal to its parent is inherited.
