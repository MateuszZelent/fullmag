# MESH-GATE-003 — Periodic antidot reproducibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Usunąć dwa znane failures periodic-antidot i uczynić fixture niezależną od niejawnych environment overrides.

**Architecture:** Przykład ma jawny versioned config; test sanitizes environment i porównuje canonical authored/runner settings. Preconditioner/restart contract jest wspólny z fixture.

**Tech Stack:** Python example/Pytest, runner config

## Global Constraints

- Test nie dziedziczy zmiennych mogących zmienić fizykę, chyba że są parametrem case.
- Example i fixture używają jednego config source.
- Naprawa nie polega na osłabieniu assertions.

---

**Finding:** MESH-GATE-003, P1.
**Files:** `packages/fullmag-py/tests/test_periodic_antidot_relaxation_example.py`, właściwy `examples/fem_periodic_antidot_relax_exchange_coupled*.py`, runtime config helpers.

### Task 1: reproduce exact failures

- [ ] Uruchomić `PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_periodic_antidot_relaxation_example.py -vv` w sanitized env i zapisać oba failure messages.
- [ ] Dodać parametryczny test, który ustawia znane overrides i dowodzi, że fixture je jawnie odrzuca lub raportuje.

### Task 2: canonical example config

```python
@dataclass(frozen=True)
class PeriodicAntidotFixtureConfig:
    preconditioner: str
    restart: int
    pbc_axes: tuple[bool, bool, bool]
```

- [ ] Przykład i test importują jeden config; environment overrides są allowlisted i zapisane w provenance.
- [ ] Uzgodnić preconditioner/restart z rzeczywistym supported contract; uruchomić test file, PASS.

### Task 3: managed example

- [ ] Uruchomić matching periodic-antidot managed recipe i artifact validator; PASS bez lokalnych overrides.
- [ ] Commit: `git add packages/fullmag-py/tests/test_periodic_antidot_relaxation_example.py examples && git commit -m "test(pbc): make periodic antidot fixture reproducible"`.

**Exit:** test file i managed example są zielone w czystym środowisku; każdy override jest jawny w config/provenance.

## Evidence update (2026-07-14, canonical fixture controls)

- [x] RED reproduced two failures in the sanitized fixture suite: the frequency
  example contained direct environment reads and exported `auto`/`8192` instead
  of the asserted response policy.
- [x] Added `PeriodicAntidotFixtureConfig` as the single allowlisted control
  source. The example imports that config, records the resolved preconditioner
  and restart count in runtime metadata, and keeps stage/state overrides out of
  the example source itself.
- [x] `PYTHONPATH=packages/fullmag-py/src python3 -m pytest
  packages/fullmag-py/tests/test_periodic_antidot_relaxation_example.py -q` —
  6 passed; `scripts/test_frequency_domain_runtime_targets.py -q` — 62 passed.
- [ ] Managed runtime execution and artifact reproducibility remain open.
