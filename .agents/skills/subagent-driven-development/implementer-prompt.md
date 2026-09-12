# Implementer brief

Use the host's available delegation tool and preserve its configured model/effort unless a different choice is authorized. Fill only the fields the task needs:

- Goal and scope: concrete outcome; allowed files and shared resources.
- Inputs: task brief path or concise requirements, dependency interfaces, exact user values, working directory.
- Constraints: applicable project rules, existing dirty changes, side-effect permissions.
- Verification: covering tests or artifact/runtime evidence required by the change.
- Return: status, changed files, commands and results, remaining concerns; report path when the evidence is large.

The worker reads the relevant code and callers, resolves routine choices from evidence, implements the complete assigned scope, and verifies it. Ask the coordinator about consequential missing information while continuing independent work. Do not commit, publish, or remove data without authorization.

Use `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or `BLOCKED` with an explanation supported by the work. Existing tests may supply the reproducer. Fix review findings and rerun covering checks after relevant changes; do not automatically rerun a whole suite or delete code to enforce a process.
