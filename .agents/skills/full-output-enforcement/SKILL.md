---
name: full-output-enforcement
description: Overrides default LLM truncation behavior. Enforces complete, unabridged output and complete cross-layer Fullmag refactors when the user asks for exhaustive work, avoiding placeholders, partial migrations, and stale architecture leftovers.
---

# Full Output Enforcement

## Baseline

Treat exhaustive requests as production-critical. A partial output is a broken output. If the user asks for all files, all components, all skills, all comments, or a full implementation, deliver the full requested set or clearly pause at a clean boundary.

For Fullmag architecture work, "complete" means cross-layer complete where applicable: docs, Python DSL, `ProblemIR`, planner/capabilities, runtime/provenance, OpenAPI/generated types, API client/resource hooks, unified viewport/ribbon UI, and tests. Do not leave old and new architecture mixed without naming the transition and removal criteria.

## Banned Output Patterns

The following patterns are hard failures. Never produce them:

**In code blocks:** `// ...`, `// rest of code`, `// implement here`, `// TODO`, `/* ... */`, `// similar to above`, `// continue pattern`, `// add more as needed`, bare `...` standing in for omitted code

**In prose:** "Let me know if you want me to continue", "I can provide more details if needed", "for brevity", "the rest follows the same pattern", "similarly for the remaining", "and so on" (when replacing actual content), "I'll leave that as an exercise"

**Structural shortcuts:** Outputting a skeleton when the request was for a full implementation. Showing the first and last section while skipping the middle. Replacing repeated logic with one example and a description. Describing what code should do instead of writing it.

**Fullmag shortcuts:** Updating only UI while bypassing Python/IR/runtime semantics. Updating only backend while leaving OpenAPI/resource hooks stale. Reintroducing bootstrap/poll/preview or direct `fetch()` paths because they are faster to write. Leaving FDM/FEM duplicate trees when the task is about unified workspace behavior.

## Execution Process

1. **Scope** — Read the full request. Count how many distinct deliverables are expected (files, functions, sections, answers). Lock that number.
2. **Map** — For Fullmag work, identify every affected layer before editing.
3. **Build** — Generate or edit every deliverable completely. No partial drafts, no "you can extend this later."
4. **Cross-check** — Before output, re-read the original request. Compare your deliverable count against the scope count. If anything is missing, add it before responding.

## Handling Long Outputs

When a response approaches the token limit:

- Do not compress remaining sections to squeeze them in.
- Do not skip ahead to a conclusion.
- Write at full quality up to a clean breakpoint (end of a function, end of a file, end of a section).
- End with:

```
[PAUSED — X of Y complete. Send "continue" to resume from: next section name]
```

On "continue", pick up exactly where you stopped. No recap, no repetition.

## Quick Check

Before finalizing any response, verify:
- No banned patterns from the list above appear anywhere in the output
- Every item the user requested is present and finished
- Code blocks contain actual runnable code, not descriptions of what code would do
- Nothing was shortened to save space
- Fullmag architecture invariants were preserved or any remaining migration debt is explicit
