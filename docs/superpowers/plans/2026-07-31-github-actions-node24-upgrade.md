# GitHub Actions Node 24 Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove GitHub Actions dependencies on the Node 20 action runtime and verify that every Fullmag workflow still parses and builds correctly.

**Architecture:** Audit every action reference under `.github/workflows`, update action majors whose Node 24 releases are available, and keep explicit project toolchains (such as `node-version: 24.18.0`) unchanged. Validate YAML/workflow contracts locally and run the repository's applicable build checks.

**Tech Stack:** GitHub Actions YAML, Node.js 24, Python validation scripts, repository build/test commands.

## Global Constraints

- Do not change workflow triggers, permissions, build matrices, cache keys, or release behavior.
- Use Node 24-compatible action majors, including the Pages action chain; do not silently downgrade explicit toolchain versions.
- Preserve unrelated dirty-worktree changes.

---

### Task 1: Audit and update workflow action runtimes

**Files:**
- Modify: `.github/workflows/bootstrap.yml`
- Modify: `.github/workflows/contract-guard.yml`
- Modify: `.github/workflows/documentation.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `.github/workflows/windows-msi-container.yml`

- [x] Enumerate every `uses:` action and identify Node 20 majors from the action release metadata.
- [x] Update only the affected action references to their Node 24-compatible majors.
- [x] Confirm no `node20` runtime declarations or Node 20 setup versions remain.

### Task 2: Verify workflow syntax and repository build contracts

**Files:**
- Test: `.github/workflows/*.yml`

- [x] Parse every workflow with an available YAML parser.
- [x] Run repository workflow/static contract tests if present.
- [x] Run the narrowest applicable build/typecheck command for each changed workflow path; the Control Room typecheck passes, while the production build is blocked by a full root filesystem.
- [x] Run `git diff --check` and report any environment-only checks that cannot run locally.

### Task 3: Fix confirmed bootstrap failures

- [x] Run the GitHub Actions logs for the latest `bootstrap` runs and reproduce the
  Python script-export and Playwright setup failures locally.
- [x] Preserve the authored `tolA`/`tolT` spelling through script export while
  retaining canonical A/m storage for the runtime model.
- [x] Install Playwright from the `apps/control-room` workspace where its package
  is declared.
- [x] Add regression coverage for both fixes and rerun the affected Python and
  workflow contract tests.
- [ ] Push or rerun GitHub Actions after the local changes; this is intentionally
  not performed without an explicit publication request.
