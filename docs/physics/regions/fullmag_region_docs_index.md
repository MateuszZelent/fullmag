# Fullmag region / interface documentation bundle

This bundle contains three complementary documents:

1. `docs/physics/0461-multi-region-note-corrected.md`  
   Corrected and expanded version of the original multi-region note.

2. `docs/physics/0460-sharp-interfaces-multi-body-and-parameter-fields.md`  
   Main physics and architecture note. This is the primary long-form design document.

3. `docs/adr/0002-regions-not-primary-inter-body-physics.md`  
   ADR-style architectural decision and implementation roadmap.

## Recommended reading order

1. Read the corrected note first.
2. Then read the long physics/architecture note.
3. Finally use the ADR as the implementation contract.

## Recommended project decisions

- Keep `Region` lightweight and topological.
- Make constitutive parameter fields explicit and validated.
- Make inter-body couplings explicit.
- Keep demag global and based on physical magnetization `M = Ms * m`.
- Preserve one-body heterogeneous media and multi-body coupled systems as separate semantic modes.
