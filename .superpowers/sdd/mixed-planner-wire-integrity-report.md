# Slice 3.2a — mixed-mesh wire integrity

Base revision: `9026f137187af68a8525ae6e191e8c11de008b8b`

Status: implementation and review remediation complete for the scoped wire/IR/planner integrity slice. No files were staged or committed.

## Implemented

- Python remesh inline and topology-artifact payloads preserve `cell_mesh_parts` and `mixed_layer_topology_certificate`; shared-domain build reports retain the accepted certificate.
- Rust `FemConnectivityIR` carries typed `FemCellMeshPartIR` values (`magnetic`, `transition_air`, `far_air`) and validates one classification per cell for classified meshes.
- Planner packing reorders mesh-part labels with cells. Planner merging concatenates classified labels by cell ordinal and rejects mixing classified and legacy-unclassified inputs.
- Topology fingerprint v2 includes mesh parts through identical ordered Python/Rust encodings. Both languages freeze the same complete Prism6/Pyramid5/Tet4 fixture to:

  ```text
  sha256:2071f6b9a2bf468fc82296f34744b07475315a5f0d26c5b06e52b54064f474e2
  ```

- `MixedLayerTopologyCertificateV1IR` validates schema/status, exact sweep and layer evidence, planes, tolerances, volumes, markers, conformity counts, deterministic-input provenance, element-family evidence, quality metrics, facet evidence, and exact topology fingerprint/count binding.
- `FemDomainMeshAssetIR` has one canonical certificate truth in the typed shared-domain build report. A legacy mesh-level compatibility copy is accepted only when identical, promoted when needed, rejected on conflict, and omitted from canonical serialization.
- CLI inline and artifact transports preserve mesh parts and typed build reports, promote a consistent artifact certificate into the typed report/provenance, reject top-level-only or conflicting evidence, and run full `FemDomainMeshAssetIR` validation before accepting the response.
- API topology subsetting preserves per-cell mesh-part labels.
- A managed `just verify-fem-mixed-wire-cli-contract` recipe runs the three focused CLI tests in Compose service `fem-gpu` with `FULLMAG_USE_MFEM_STACK=ON` and Cargo features `cuda fem-gpu`. It reuses the existing `fullmag` Compose project so worktree execution does not allocate another Docker subnet.

## TDD evidence

RED evidence included:

- mesh-part round-trip/length/fingerprint tests failed before typed propagation;
- planner pack and merge tests returned empty mesh-part arrays before propagation;
- negative certificate tolerance was accepted and conflicting certificate copies were ignored before fail-closed validation/deserialization;
- Python inline/artifact transports raised `KeyError: 'cell_mesh_parts'` before preservation.

GREEN evidence:

```text
cargo test -p fullmag-ir
59 unit tests passed; 148 integration tests passed; doc tests passed
```

```text
cargo test -p fullmag-plan
247 tests passed
```

```text
PYTHONPATH=packages/fullmag-py/src \
  packages/fullmag-py/.venv/bin/pytest -q \
  packages/fullmag-py/tests/test_mixed_element_meshing.py \
  -k 'topology_fingerprint_v2_matches_frozen_rust_fixture or mixed_remesh_inline_payload_preserves_parts_and_certificate or mixed_remesh_artifact_preserves_parts_and_certificate'
3 passed, 153 deselected
```

```text
just verify-fem-mixed-wire-cli-contract
Finished test profile in 13m 09s
3 passed; 0 failed; 0 ignored; 237 filtered out
```

The managed CLI gate compiled the native FEM/CUDA stack in the `fem-gpu` container (CUDA 12.4.1) and executed:

- `mixed_wire_preserves_typed_report_and_rejects_top_level_only`
- `mixed_wire_hydrates_artifact_certificate_into_typed_report`
- `mixed_wire_rejects_mismatched_topology_and_report_certificates`

The initial worktree-scoped Compose invocation could not allocate a new subnet (`all predefined address pools have been fully subnetted`). No network was deleted; the recipe was made worktree-safe by selecting the existing `fullmag` Compose project, after which the required managed gate passed.

## Scope boundary

- This slice qualifies semantic transport, certificate binding, and planner mesh-part lineage.
- It does not claim native mixed-element assembly, solver execution, or SP4 physics qualification.
- No capability eligibility, native ABI, solver algorithm, or scenario behavior was changed.
