# Task 1 report: canonical automatic sinc-sampling contract

## Result

- Status: `DONE`
- Commit: `0cad9cc6f729a61ff11e7c4b0e3ff6b922885238`
- Commit subject: `Document automatic sinc sampling`

## Files

- Committed: `docs/physics/0920-time-domain-microstrip-antenna-zeeman-mask.md`
  - Added the exact automatic sinc-cutoff equations and 5 GHz numerical example.
  - Defined Python/UI round-trip, tagged ProblemIR policy, legacy compatibility,
    ordered per-Run resolution, FDM/FEM CPU/GPU parity, provenance, scheduler
    behavior, and fail-closed conditions.
  - Reconciled the existing UI preview text so it distinguishes the bare
    Nyquist-limit period from the guarded automatic period.
- Report only: `.superpowers/sdd/task-1-report.md`
- Preserved and never staged:
  `examples/fem_periodic_antidot_relax_exchange_coupled_time_domain_k0.py`

## TDD/static verification

### RED: required contract absent before editing

Command:

```bash
set -eu
note=docs/physics/0920-time-domain-microstrip-antenna-zeeman-mask.md
for pattern in '### Automatic response sampling from a sinc cutoff' 'f_{N,target}=1.3 f_{c,max}' '6.5 GHz' 'auto_sinc_cutoff' 'source drive identifiers' 'fails closed during workflow validation/planning'; do
  rg -q -F "$pattern" "$note" || { echo "MISSING: $pattern"; exit 1; }
done
```

Output and status:

```text
MISSING: ### Automatic response sampling from a sinc cutoff
exit 1
```

The failure was the expected missing-contract failure, not a command error.

### GREEN: strict contract and placeholder check

Command:

```bash
set -eu
note=docs/physics/0920-time-domain-microstrip-antenna-zeeman-mask.md
for pattern in '### Automatic response sampling from a sinc cutoff' 'f_{N,target}=1.3 f_{c,max}' '6.5 GHz' 'auto_sinc_cutoff' 'source drive identifiers' 'fails closed during workflow validation/planning'; do
  rg -q -F "$pattern" "$note" || { echo "MISSING: $pattern"; exit 1; }
done
section=$(sed -n '/^### Automatic response sampling from a sinc cutoff$/,/^### 5\.2 Quantities$/p' "$note")
if printf '%s\n' "$section" | rg -n 'TODO|TBD|<[^>]+>|PLACEHOLDER'; then
  echo 'Placeholder marker found in automatic sampling subsection'
  exit 1
fi
echo 'STATIC CONTRACT PASS: 6/6 required markers; no placeholders'
```

Output and status:

```text
STATIC CONTRACT PASS: 6/6 required markers; no placeholders
exit 0
```

### Required brief command

Command:

```bash
rg -n "Automatic response sampling|6.5 GHz|auto_sinc_cutoff|provenance|FDM|FEM" docs/physics/0920-time-domain-microstrip-antenna-zeeman-mask.md
```

Relevant new-section output (the command also reported the note's existing FDM,
FEM, and provenance occurrences):

```text
644:### Automatic response sampling from a sinc cutoff
655:1.3 supplies a 30% Nyquist guard. For `f_c,max=5 GHz`, `f_N,target=6.5 GHz`,
671:auto_sinc_cutoff { nyquist_guard_factor: 1.3 }
676:read-only authoring payloads. The resolved numerical period is plan/provenance
688:One backend-neutral planner resolver serves FDM and FEM, on CPU and GPU, after
696:Run/stage provenance and sampling artifacts record the requested policy,
700:for FDM and FEM and is retained across Python/UI round-trip.
exit 0
```

### Final completeness and diff checks

The final check asserted these exact fixed-string markers:

```text
### Automatic response sampling from a sinc cutoff
f_{c,max}=\max_{d\in D_{sinc}(run)} f_{c,d},\qquad
f_{N,target}=1.3 f_{c,max},\qquad
\Delta t_{sample}=\frac{1}{2f_{N,target}}.
6.5 GHz
13 GHz
76.923076923 ps
auto_sinc_cutoff
source drive identifiers
fails closed during workflow validation/planning
Python/UI round-trip
FDM and FEM
```

It also isolated the new subsection and rejected `TODO`, `TBD`, angle-bracket
placeholders, and `PLACEHOLDER`, then ran `git diff --check`.

Output and status:

```text
COMPLETENESS PASS: exact equation/value markers and cross-layer terms present; no placeholders; diff check clean
exit 0
```

Post-commit verification ran the required search, the strict marker and
placeholder assertions, and:

```bash
git show --check --stat --oneline HEAD
git diff-tree --no-commit-id --name-only -r HEAD
git status --short
```

Output:

```text
0cad9cc6 Document automatic sinc sampling
HEAD=0cad9cc6f729a61ff11e7c4b0e3ff6b922885238
HEAD_PATHS:
docs/physics/0920-time-domain-microstrip-antenna-zeeman-mask.md
WORKTREE_STATUS:
 M examples/fem_periodic_antidot_relax_exchange_coupled_time_domain_k0.py
POST-COMMIT PASS: prescribed search and strict contract checks passed; committed diff check clean
```

## Self-review

- Reviewed every changed line against the approved design.
- Confirmed the factor `1.3` is fixed and not exposed as author tuning.
- Confirmed automatic intent is separate from resolved execution state.
- Confirmed resolution is ordered and per-Run, with numeric cadence unchanged.
- Confirmed one backend-neutral resolver serves FDM/FEM and CPU/GPU.
- Confirmed missing/invalid inputs and incapable backends fail closed.
- Confirmed preview limits do not invalidate a physically valid runtime clock.
- Confirmed the commit contains exactly one task-owned physics-note path.

## Concerns

None. This task intentionally publishes documentation only; implementation and
runtime tests belong to later tasks in the approved plan.
