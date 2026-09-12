---
name: systematic-debugging
description: "Use to investigate a defect, failing check, or unexplained runtime behavior before fixing it."
---

# Find and verify the root cause

Read the complete relevant error and reproduce the symptom when possible. Inspect recent changes, the failing code, its callers, and a working equivalent. Trace invalid data or state to the shared source before editing individual symptoms.

Form a concrete hypothesis and use the smallest diagnostic that distinguishes it from alternatives. At component boundaries, record only the state needed to locate the failure; redact credentials and private payloads. Avoid broad environment dumps.

Fix the demonstrated cause and verify the original symptom plus affected contracts. Reuse an existing reproducer; add a regression check for non-trivial behavior. Choose build and runtime commands from the project, including managed/container requirements.

After repeated unsuccessful attempts, stop repeating the same intervention. Summarize the evidence, examine a different hypothesis, and consult current primary documentation when the failure depends on an unfamiliar or changing tool. Continue authorized investigation; ask the user only when a material decision or unavailable prerequisite blocks it. Do not infer a broken architecture solely from the number of attempts.

For timing issues, use observable conditions and bounded timeouts rather than arbitrary sleeps. For external failures, report the exact boundary and distinguish mitigation from a verified fix. Supporting references on root-cause tracing, condition-based waiting, and defense in depth are optional when they resolve the current issue.
