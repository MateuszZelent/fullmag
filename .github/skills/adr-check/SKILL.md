---
name: adr-check
description: "Use when creating, reviewing, or updating a Fullmag ADR or making a durable architecture, public-contract, or migration decision."
---

# Fullmag ADR Check

Use this skill when a change makes a durable decision about product architecture, canonical semantics, public contracts, runtime ownership, or a long-lived migration. Do not create an ADR for a routine implementation, generated-file refresh, bug fix, or test-only change unless it records a new durable decision.

The user instruction and root `AGENTS.md` take precedence over this skill. If the relevant shared routing file exists, use `../../instructions/contracts.md`; do not reload a skill already read in the current turn unless it changed or a required reference is missing.

## ADR gate

Create or update an ADR only when the change:

- changes canonical physical semantics, `ProblemIR`, execution selection, provenance, or capability vocabulary;
- changes the public OpenAPI/resource contract or the ownership boundary between runtime and browser;
- changes the unified workspace, ribbon, docking, viewport, or module-kernel architecture;
- introduces, removes, or extends a backend capability or runtime stage lifecycle;
- keeps a compatibility bridge or transitional path long enough to affect future work.

A routine endpoint/schema implementation follows the existing ADR and updates its contract, tests, and generated artifacts without creating another ADR.

## Required decision record

Record only the sections relevant to the decision:

1. product problem in physics and workflow terms;
2. invariant being protected: one Python DSL, one `ProblemIR`, one planner vocabulary, one OpenAPI control-plane contract, and one unified viewport tree;
3. requested intent versus resolved execution reality for backend/runtime decisions;
4. affected OpenAPI, generated types, resource hooks, codecs, realtime events, commands, and viewport consumers;
5. legacy or transitional paths, owner, compatibility scope, and removal criterion;
6. exact documentation, source modules, tests, and generated artifacts that must change;
7. implemented, planned, unsafe, and rollback states.

If the decision has no effect on a listed area, omit it instead of filling a template.

## Shape

Keep the ADR decision-oriented:

- context;
- decision;
- consequences;
- implementation obligations;
- migration or rollback plan;
- tests and validation.

Do not write a roadmap essay.
