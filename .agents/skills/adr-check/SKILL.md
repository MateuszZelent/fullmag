---
name: adr-check
description: "Use when creating, reviewing, or updating Fullmag ADRs, especially decisions touching OpenAPI, workspace/ribbon architecture, unified viewport, runtime semantics, execution selection, or long-lived migrations."
---

# Fullmag ADR Check

Use this skill when a change may alter product architecture, public contracts, or cross-layer behavior.

## Decision Gate

Create or update an ADR when the change:

- changes canonical semantics, `ProblemIR`, execution selection, or provenance,
- changes OpenAPI, generated types, API modules, resource hooks, codecs, or realtime contracts,
- changes the workspace shell, ribbon command model, docking model, or unified viewport routing,
- introduces, removes, or extends a backend capability or runtime stage lifecycle,
- keeps a transitional path alive long enough to affect future work.

## Required Checks

1. State the product problem in physics and workflow terms, not only implementation terms.
2. Identify the invariant being protected: one Python DSL, one `ProblemIR`, one planner vocabulary, one OpenAPI control-plane contract, one unified viewport tree.
3. Record requested intent vs resolved execution reality for any backend/runtime decision.
4. Preserve the OpenAPI-first browser contract: generated types, typed API client, resource hooks, binary codecs for heavy data, and revision-aware resources.
5. Preserve the workspace direction: one ribbon command surface, docked panels, unified FDM/FEM viewport routing, no Build/Analyze/Study app split.
6. Name all legacy concepts being retired or isolated: bootstrap blobs, poll session blobs, preview mutation for quantity switching, direct component `fetch()`, duplicated FDM/FEM UI trees.
7. Explain migration scope, compatibility, and removal criteria for any temporary bridge.
8. List the exact docs, code modules, tests, and generated artifacts that must change.
9. Be honest about what is implemented now, what is planned, and what remains unsafe.

## ADR Shape

Keep ADRs short and decision-oriented:

- context,
- decision,
- consequences,
- implementation obligations,
- rollback or migration plan,
- tests and validation.

Do not write ADRs as roadmap essays. If the work is not implementation-ready, say so directly.
