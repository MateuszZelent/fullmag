---
title: FEM frequency-domain documentation entrypoint
version: COMSOL-aligned v5.1 decision-complete
status: canonical
scope: FEM frequency-domain documentation
---

# FEM frequency-domain documentation

This directory is the canonical FEM frequency-domain masterplan package. Its
manifest assigns a role to every active document and identifies generated and
historical material.

## Authority hierarchy

1. `docs/physics` defines equations and units.
2. `docs/architecture` and `docs/specs` define ownership and public architecture.
3. Masterplan normative documents define implementation order.
4. Status and readiness documents record current evidence only.
5. `old/` is historical and never normative.

The V5 full pack is currently a disabled stale generated snapshot. It is not
an independent authority; use this README and the manifest until Task 10
regenerates it after every manifest-declared canonical input is complete.

## Document roles

- **normative** documents define durable required design and implementation
  order and cannot contain dated append-only implementation evidence.
- **validation** documents define certification and benchmark expectations.
- **implementation_status** documents record source, artifact, or runtime evidence.
- **supporting** documents provide inventory, migration, and traceability context.

Documents `08`, `16`, and `18` are transitional
**implementation_status** documents with `target_role=normative` in the
manifest. Their owner Tasks 5, 4, and 6 respectively must rewrite the active
bodies before promotion.

## Production-claim schema

Every production claim must include a non-empty `validated_scope` and exactly
one `implementation_state` from `absent`, `contract_only`, `source_visible`,
or `executable`, plus one `validation_state` from `unvalidated`,
`algebra_validated`, `physics_validated`, or `production_qualified`.
`production_executable` does not imply `production_qualified`, and a narrow
validated scope cannot promote a broader capability. The manifest is the
machine-readable definition of this schema.

## Read order for implementers

1. Read the applicable physics note and architecture/specification document.
2. Read this entrypoint and `01_full_read_inventory_and_resolution.md`.
3. Read normative documents in manifest order: `02` through `07`, `12`, then
   planned `23` and `24` when they are created.
4. Use validation documents `09` and `15` to define acceptance evidence.
5. Consult implementation-status documents only to establish the current
   boundary; they do not alter normative requirements.

## Read order for status auditors

1. Read this entrypoint, the manifest, and the applicable physics and
   architecture/specification documents.
2. Read implementation-status documents `08`, `10`, `11`, `16`, `17`, `18`,
   `19`, and `20` in manifest order.
3. Read the planned readiness matrix `25` when it is created; it is linked by
   the Markdown status chapter rather than duplicated in the full pack.
4. Validate claims with the named runtime gates and their artifacts.

FDM is outside this package's scope. Documentation and source inspection do
not establish production proof; required runtime gates and their evidence do.

## Historical material

The `old/` directory contains frozen source snapshots for superseded documents.
They may be consulted for provenance but must not define current physics,
algorithms, implementation order, or implementation status.
