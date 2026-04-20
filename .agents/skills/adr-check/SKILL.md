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
5. Does it preserve the resource-first browser contract, one API client, and one UI tree?
6. Does it avoid long-lived dual-stack migrations or legacy bootstrap/poll/preview dependencies?
7. Is the decision reversible?
8. What is deliberately out of scope?
9. Which files and modules are impacted now?
