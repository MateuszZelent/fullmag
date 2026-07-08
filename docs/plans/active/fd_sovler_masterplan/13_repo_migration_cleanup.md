---
title: Frequency-driven solver - repo migration and cleanup
version: COMSOL-aligned v5.0 full-read canonical
date: 2026-07-07
status: canonical
source_policy: derived only after full read of all uploaded planning documents and the Micromagnetics Module User's Guide V2.13 PDF
supersedes:
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
  - fd_solver_plan_00_index.md through fd_solver_plan_11_decision_closures_adr.md old copies
---

# Repo migration and cleanup

## 1. Install canonical docs

Recommended path:

```text
docs/frequency_domain_solver_v5/
```

Copy all files from this package there.

## 2. Archive older docs

Move these to archive or delete from active docs:

```text
fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
fd_solver_plan_00_index.md ... fd_solver_plan_11_decision_closures_adr.md old copies
frequency_driven_masterplan_comsol_aligned_v2/
frequency_driven_masterplan_comsol_aligned_v3/
frequency_driven_masterplan_comsol_aligned_v3_relaxed_texture/
frequency_driven_masterplan_comsol_aligned_v4_clean/
```

Archive path:

```text
docs/archive/frequency_domain_solver_pre_v5/
```

Archive README:

```text
Historical planning files. Do not use for current implementation decisions. Use docs/frequency_domain_solver_v5/00_README_CANONICAL_FULL_READ.md.
```

## 3. Add pointer in docs index

```markdown
# Frequency-domain solver

Canonical current documentation:

`docs/frequency_domain_solver_v5/00_README_CANONICAL_FULL_READ.md`
```

## 4. Full pack policy

`fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V5.md` is generated from individual v5 files. Do not hand-edit it.
