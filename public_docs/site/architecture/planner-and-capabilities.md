---
title: Planner and Capabilities
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/specs/capability-matrix-v0.json
---

(public-docs-architecture-planner-and-capabilities)=
# Planner and capabilities

The planner takes the canonical `ProblemIR` and resolves which backend, device, precision, and
execution mode can satisfy the request. It reports an unsupported combination instead of silently
changing the requested interaction, solver, device, or precision.

## Resolution record

| Concept | Public meaning |
|---|---|
| Requested intent | What the script authored |
| Resolved execution | What the planner selected after capability checks |
| Capability matrix | The checked support/qualification registers per lane |
| Scope reasons | Fail-closed explanations for rejected combinations |

## Lane policy

Resolved execution is always recorded in provenance. Source presence, compilation, or use of a
skipped test never promotes a lane to qualified; GPU claims require executed-device evidence.
Unsupported and planned lanes are reported explicitly rather than overclaimed.

## Where the policy is enforced

- Python `Problem` validation and lowering: `packages/fullmag-py/src/fullmag/model/problem.py`.
- Capability and routing decisions: the Rust planner behind the native runner.
- Public capability statuses: {doc}`../validation/qualification-status`.

The planner is a product boundary: a supported identifier does not prove executability, and an
unavailable lane must fail clearly.
## Control Room crosswalk

This architecture page has no direct authoring screen. Use the object, material, physics, mesh, or stage editor named by the relevant terminal API page; architecture concepts are currently `inspection-only` unless a concrete UI owner is listed. `TODO: frontend support` applies to architecture capabilities without a corresponding control. See {doc}`/frontend/capability-register`.

## Python/API crosswalk

This page documents architecture rather than a standalone Python callable. Exact constructors, arguments, validation, and examples belong to the linked Python API pages; do not infer a public function from an internal architecture term.

## Physics and bibliography scope

No independent physical model is introduced here. Scientific equations are owned by the applicable physics or numerical-methods page. Bibliography: not applicable to this architecture overview; implementation ownership is recorded in the source-code references on the terminal page.
## Source-code index

- No standalone Python callable is introduced by this architecture page. Use the exact source symbol named by the linked API or implementation page; architecture terms alone are not public functions.

