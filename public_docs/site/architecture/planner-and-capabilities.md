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
