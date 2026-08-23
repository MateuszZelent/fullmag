# Bootstrap workflow contract hardening

## Context

Pull request #56 restores the repository bootstrap gates, but review found two
remaining false-negative cases in `scripts/test_bootstrap_workflow_contract.py`:

1. action-version checks compare action counts with human-facing step names, so
   renaming a step can hide an outdated `uses:` version;
2. gitlink checks require only a matching `path` entry and can accept a
   `.gitmodules` section without a clone URL.

The implementation must remain dependency-free, run on Windows and Linux, and
keep `.github/workflows/bootstrap.yml` as the workflow source of truth.

## Considered approaches

### 1. Parse the relevant contracts with the Python standard library

Extract YAML `uses:` values with an anchored line parser and read
`.gitmodules` with `configparser`. Validate the actual action references and
the complete submodule records. This is the selected approach because it is
independent of step display names and adds no CI dependency.

### 2. Use broader regular expressions

Regular expressions can validate both files with less helper code, but quoting,
indentation, and section boundaries make the `.gitmodules` check unnecessarily
fragile.

### 3. Add a YAML parser

A YAML parser would model the workflow precisely, but it would introduce a new
dependency solely for a small static contract test. `.gitmodules` would still
need a separate parser.

## Design

The test module will expose small private helpers with one responsibility each:

- collect normalized `uses:` values from workflow lines whose first YAML key is
  `uses`;
- assert that every reference for a governed action family uses the required
  version and that the expected family is present;
- parse `.gitmodules` sections and build a mapping from normalized path to a
  nonempty URL;
- enumerate tracked gitlinks from the Git index and require exactly one complete
  metadata record for each path.

Action checks will cover `actions/checkout`, `actions/setup-node`,
`actions/setup-python`, `actions/upload-artifact`, and `pnpm/action-setup`.
Unrelated third-party actions remain outside this contract.

The gitlink check will fail for a missing section, duplicate path, empty URL, or
metadata that points to a path not matching the tracked gitlink. It will not
attempt network access or validate remote reachability.

## Error behavior

Failures will identify the action family or gitlink path and describe the
violated invariant. Parsing malformed `.gitmodules` content will fail the test
rather than silently treating it as absent metadata.

## Verification

Tests will first demonstrate both reported false negatives:

- renaming a workflow step and downgrading its action must fail;
- removing a gitlink URL while retaining its path must fail.

The repository contract test must then pass against the real files. The full
PR verification also includes Python API contracts, TypeScript typechecking,
targeted ESLint and Vitest, `git diff --check`, and fresh GitHub Actions runs.
The Rust DMI contract remains dependent on Linux CI because the local Windows
build previously exhausted disk space before completing.

## Scope boundaries

This change does not alter workflow behavior, action versions, submodule
membership, product code, OpenAPI, runtime semantics, or frontend architecture.
It only makes the existing bootstrap invariants resistant to the two reviewed
false-negative cases.
