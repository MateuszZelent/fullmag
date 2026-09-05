---
name: verification-before-completion
description: "Use before reporting a change complete to match each claim to current verification evidence."
---

# Evidence before completion claims

Match each claim to the evidence that proves it: a behavior test for a fix, compiler output for a build, browser evidence for rendering, or numerical/runtime evidence for scientific claims. A successful linter or a subagent summary does not establish all of these.

Run the applicable checks, inspect their output and exit status, and record source/input identity and material limitations. Evidence remains usable while the relevant source, inputs, environment, and required freshness conditions are unchanged. It need not be rerun in the same message as the final answer.

Review delegated changes and their evidence. Independently verify risky or unsupported claims, without automatically repeating a completed suite. Re-run checks after relevant changes or when failures or remaining concerns justify it.

For Fullmag, keep source/contract tests, managed runtime execution, browser/WebGL proof, physics validation, and release qualification distinct. Mark an unavailable required lane `NOT VERIFIED`; do not downgrade the requirement or relabel a diagnostic as qualification.

Before finishing, compare the result with the requested scope and report what changed, what was verified, and what remains blocked. Do not claim full completion from a plausible diff or partial checks.
