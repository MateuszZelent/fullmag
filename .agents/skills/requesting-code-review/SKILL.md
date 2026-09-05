---
name: requesting-code-review
description: "Use for a requested review, a substantial or risky change, or a required pre-merge review."
---

# Request a focused review

Identify the exact scope: committed range, staged change, or working-tree files. Inspect and resolve the actual base/head; `HEAD~1` is not a reliable default for multi-commit or uncommitted work.

Give an authorized reviewer the requirements, relevant project constraints, exact diff or files, and available validation evidence. Prefer a focused context for independent review. Do not tell the reviewer what verdict to reach or exclude a class of legitimate correctness findings.

Ask for actionable findings with file locations, affected behavior, severity, and evidence. Evaluate correctness, scope, security, maintainability, and applicable scientific/API contracts. A low-impact edit may need only a local diff review unless the project or user requires independent review.

Fix substantiated blocking issues, challenge unsupported suggestions with evidence, and distinguish nits from defects. Repeat review only for changed findings or unresolved risks. Do not automatically rerun unchanged tests, force a new agent for each fix, or publish review comments without authorization. Use the project's review practices when available.
