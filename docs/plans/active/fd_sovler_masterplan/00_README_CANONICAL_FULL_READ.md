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

The generated full pack is a reading convenience. It is not an independent
authority; the manifest and its included active documents remain authoritative.

## Document roles

- **normative** documents define required design and implementation order.
- **validation** documents define certification and benchmark expectations.
- **implementation_status** documents record source, artifact, or runtime evidence.
- **supporting** documents provide inventory, migration, and traceability context.

## Read order for implementers

1. Read the applicable physics note and architecture/specification document.
2. Read this entrypoint and `01_full_read_inventory_and_resolution.md`.
3. Read normative documents in manifest order: `02` through `08`, `12`, `16`,
   `18`, then planned `23` and `24` when they are created.
4. Use validation documents `09` and `15` to define acceptance evidence.
5. Consult implementation-status documents only to establish the current
   boundary; they do not alter normative requirements.

## Read order for status auditors

1. Read this entrypoint, the manifest, and the applicable physics and
   architecture/specification documents.
2. Read status documents `10`, `11`, `17`, `19`, and `20` in manifest order.
3. Read the planned readiness matrix `25` when it is created; it is linked by
   the Markdown status chapter rather than duplicated in the full pack.
4. Validate claims with the named runtime gates and their artifacts.

FDM is outside this package's scope. Documentation and source inspection do
not establish production proof; required runtime gates and their evidence do.

## Historical material

The `old/` directory contains frozen source snapshots for superseded documents.
They may be consulted for provenance but must not define current physics,
algorithms, implementation order, or implementation status.
