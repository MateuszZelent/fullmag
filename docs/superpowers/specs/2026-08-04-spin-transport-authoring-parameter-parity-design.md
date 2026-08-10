# Spin transport authoring parameter parity

## Context

The implementation plan requires one leaf-by-leaf parity gate for the public
Python authoring surface, `ProblemIR`, planner-facing scene resources, and the
Control Room transport inspectors. The repository already has typed Python
models and typed TypeScript resource adapters, but the coverage is currently
distributed across tests and raw JSON editors. That makes it possible for a
field to exist in one layer while being renamed, dropped, or silently
normalized in another.

The gate must cover the authoring contract without pretending that an
unsupported execution lane is qualified. A parameter may therefore be
`executable`, `declared_unsupported`, or `not_applicable`; only the first is
eligible for execution evidence, while the latter two must round-trip or fail
closed according to the manifest.

## Decision

Add a versioned manifest at
`docs/specs/spin-transport-authoring-parameter-parity-v1.json`. Each manifest
entry identifies:

- a stable parameter ID;
- the canonical authoring family and variant;
- the canonical IR path relative to the resource;
- the Python constructor/attribute and `to_ir()` path;
- the Control Room draft field or typed JSON collection;
- SI unit and value kind;
- status (`executable`, `declared_unsupported`, or `not_applicable`);
- round-trip policy (`required`, `preserve_and_reject`, or `forbidden`);
- the planner error class required when execution is unavailable.

The manifest is the inventory, not a second physics schema. Existing Python,
Rust, OpenAPI, and TypeScript types remain the semantic owners. A missing
manifest entry, missing required field, or unclassified unsupported field is a
gate failure.

## Canonical data flow

```text
manifest
  -> Python fixture (typed DSL -> to_ir)
  -> scene-document canonicalization (Python -> resource JSON)
  -> ProblemIR/planner validation (Rust)
  -> Control Room draft builders (TypeScript)
  -> normalized resource fixture comparison
```

The comparison is structural and path-based. Numeric values are compared with
the existing canonical JSON tolerance policy; vectors preserve component
order and signed zero is not used as a physics discriminator. Unknown records
remain lossless and read-only. Known records may be mutated only after the
existing clone-only validation endpoint accepts them.

## Scope of the first gate

The first version covers the currently public transport families:

1. `CurrentTransport` prescribed density and Ohmic/M2 material, boundary,
   gauge, and linear-solver fields;
2. `SpinDriftDiffusion` steady/transient fields, spin materials, interfaces,
   spin boundaries, solver policy, nonlinear policy, and requested execution;
3. canonical Zhang--Li, Slonczewski v2, and prescribed SOT resources;
4. analytic cylindrical and named-source Oersted resources, including time
   dependence where the public model supports it.

Future fields such as MQS/skin-effect policy, distributed FEM KKT controls, or
an unqualified FEM GPU lane must be listed explicitly as
`declared_unsupported`, never omitted.

## Failure semantics

- Missing or renamed fields fail the parity gate with the parameter ID and all
  four paths.
- A value accepted by Python but absent from the scene/UI resource fails the
  gate; a raw JSON editor is not evidence of a typed field unless the manifest
  explicitly marks the collection as an opaque, lossless boundary.
- A declared unsupported execution combination must produce a planner/API
  rejection containing the manifest error class and must not select another
  backend or device.
- A capability row is not promoted by this gate. It remains bounded authoring
  evidence until its numerical and managed-runtime gates pass.

## Test layers

### Python

`packages/fullmag-py/tests/test_spin_transport_authoring_parameter_parity.py`
builds one typed fixture per family, verifies every manifest path, performs
scene-document canonicalization, and checks normalized round-trip equality.

### Rust/ProblemIR

The existing `fullmag-ir` and `fullmag-plan` tests consume the same fixture
and verify that recognized resources preserve the manifest paths while
unsupported execution requests fail closed with the declared error class.

### Control Room

The existing transport draft models and inspectors expose a test-only
manifest assertion. It checks that each executable field has a typed draft
field and that raw JSON collections are explicitly classified. A focused
Vitest test compares `currentTransportDraft`, `spinTransportDraft`, and the
torque/Oersted builders against the manifest.

### Managed gate

`just verify-spin-transport-authoring-parameter-parity` runs the Python and
Rust checks, then the focused Control Room test. It writes a small JSON report
with manifest digest, source revision, layer results, unsupported-case errors,
and no solver qualification claims.

## Non-goals

This design does not add new physical equations, promote SML/MQS/FEM GPU, or
replace the existing OpenAPI generator. It does not make raw JSON collections
fully editable; it makes their lossless/deferred status explicit and prevents
them from being mistaken for complete typed coverage.

## Approval boundary

Implementation is ready only after this design and the generated task plan
are reviewed. The next implementation slice may then add the manifest and
its red/green tests without changing solver equations.
