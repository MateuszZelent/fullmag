# MESH-GATE-004 — Architecture and zero-warning lint closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zamknąć dokładne architecture-hygiene i lint failures audytowanego snapshotu bez unrelated refactorów.

**Architecture:** Najpierw odtworzyć pełny output na bieżącej rewizji, sklasyfikować ownership, następnie naprawić tylko naruszenia blokujące mesh/PBC audit gate.

**Tech Stack:** Control Room lint/architecture scripts, TypeScript

## Global Constraints

- Zero warnings.
- Bez wyłączania reguł, globalnych ignores i drive-by formatting.
- Jeśli failure zniknął przez obce zmiany, zapisać świeży PASS zamiast tworzyć pusty diff.

---

**Finding:** MESH-GATE-004, P1.

### Task 1: reproduce current output

- [ ] Uruchomić osobno `pnpm --dir apps/control-room lint` i `pnpm --dir apps/control-room check:architecture-hygiene`; zachować pełny stdout i exit code.
- [ ] Dla każdego failure wskazać exact file/rule i potwierdzić, że dotyczy bieżącego snapshotu.

### Task 2: surgical repair

- [ ] Dodać lub poprawić focused test dla naruszonego contractu, jeśli failure jest semantyczny.
- [ ] Zmienić wyłącznie wskazane linie zgodnie z frontend v2 module/API/state rules; nie tłumić warningu.

### Task 3: full zero-tolerance gate

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
pnpm --dir apps/control-room check:api-hygiene
pnpm --dir apps/control-room check:architecture-hygiene
```

- [ ] Wszystkie komendy exit 0 i lint ma 0 warnings.
- [ ] Commit tylko jeśli istnieje diff: `git add apps/control-room && git commit -m "fix(ui): close mesh audit hygiene gates"`.

**Exit:** wszystkie pięć komend PASS na tej samej rewizji; evidence zawiera pełne wyniki, nie opis z pamięci.

