---
name: adr-check
description: "Use when creating, reviewing, or updating Fullmag architecture decision records (ADR)."
---

# ADR check

Use this skill to:

- verify whether a change needs a new ADR,
- compare implementation against existing ADRs,
- draft concise decision, status, consequences, and follow-up sections,
- detect conflicts between MVP scope and long-term roadmap.

## Checklist

1. What problem is being fixed?
2. Which invariant or trade-off is affected?
3. Does the decision preserve one semantic core across Python, UI, `ProblemIR`, planning, and execution?
4. Does it keep execution selection explicit and modular?
5. Is the decision reversible?
6. What is deliberately out of scope?
7. Which files and modules are impacted now?
