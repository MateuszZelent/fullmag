---
name: test-driven-development
description: "Use for non-trivial behavior changes or bug fixes that need an executable regression check."
---

# Test the intended behavior

Read the affected code, callers, and existing tests. Define the observable requirement, including relevant edge cases and failure behavior. Reuse an existing test if it already reproduces the defect.

For new non-trivial behavior, write the smallest meaningful regression check before implementing when practical. Run it and confirm it fails for the intended missing behavior rather than a setup error. Implement the root-cause fix, then run the covering checks and required project gates. Refactor only what this change needs.

For reversible low-impact edits such as wording or formatting, use a diff, parser, linter, or render check as appropriate instead of inventing a behavioral test. For generated files, verify the generator and contract. Security, data integrity, scientific validation, and explicit project gates retain their required coverage.

If code already exists before its test, keep the work and add a behavioral check; demonstrate the regression on the baseline in isolation when useful. Do not delete working code as a process penalty or revert another contributor's changes to manufacture a red phase.

Test behavior rather than mocks or implementation details. Use the project's existing test tools. Once checks pass, repeat or broaden them only after relevant changes, failures, or unresolved concerns. Report what ran and what it proves.
