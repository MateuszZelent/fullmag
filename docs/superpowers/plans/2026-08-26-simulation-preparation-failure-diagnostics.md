# Simulation Preparation Failure Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dostarczyć precyzyjny, dostępny modal błędu przygotowania symulacji z działaniami naprawczymi i kopiowalnym pełnym pakietem diagnostycznym.

**Architecture:** Kanoniczny zasób HTTP v2 pozostaje źródłem prawdy. `simulationPreparationModel.ts` ograniczenie interpretuje predykaty, `simulationPreparationDiagnostics.ts` tworzy allowlistowaną projekcję JSON, a `SimulationPreparationFailureDialog.tsx` prezentuje warstwę użytkową i zwijane dane techniczne bez własnego transportu.

**Tech Stack:** React 19, TypeScript, Radix Dialog, Vitest, istniejące tokeny `--fm-*` i klasy `fm-*`.

## Global Constraints

- Nie zmieniać OpenAPI v2, wygenerowanego transportu ani endpointów; zmiana jest frontend-only.
- Nie dodawać bezpośredniego `fetch()` ani drugiego źródła stanu.
- Zachować surowe `failure.detail`, correlation ID, requested/resolved execution, etapy i ograniczony log tail.
- Kopiować tylko allowlistowaną projekcję; nie kopiować nieznanych pól odpowiedzi.
- Wszystkie nowe klasy CSS muszą mieć prefiks `fm-` i używać tokenów `--fm-*`.
- Nie wykonywać stagingu ani commita w tym współdzielonym drzewie.

---

### Task 1: Precyzyjny model przyczyn

**Files:**
- Modify: `apps/control-room/src/kernel/layout/simulationPreparationModel.ts`
- Test: `apps/control-room/src/kernel/layout/simulationPreparationDiagnostics.test.ts`

**Interfaces:**
- Consumes: `failure.detail: string | null` z `SimulationPreparationResource`.
- Produces: `parsePreparationFailurePredicates(detail)` i `resolvePreparationFailureCauses(detail)` oraz `SimulationPreparationFailureView.causes`.

- [ ] **Step 1: Dodać testy znanego, wielokrotnego, nieznanego i ograniczonego predykatu**

Test ma wymagać dokładnego mapowania `gpu_dmi_kernel_not_mixed_p1`, zachowania kolejności wielu predykatów, widocznego fallbacku dla nieznanego identyfikatora oraz `omittedCount` po przekroczeniu 32 pozycji.

- [ ] **Step 2: Uruchomić RED**

Run: `env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/kernel/layout/simulationPreparationDiagnostics.test.ts`

Expected: test nowej przyczyny lub ograniczenia kończy się FAIL przed implementacją.

- [ ] **Step 3: Wdrożyć minimalny bounded parser i mapowanie**

Parser odczytuje tylko `failed_predicates=[...]`, analizuje maksymalnie pierwsze 4096 znaków, zwraca maksymalnie 32 predykaty po maksymalnie 160 znaków i sygnalizuje pominięte dane. Znane identyfikatory otrzymują `label` i `action`; nieznane zachowują oryginalny identyfikator.

- [ ] **Step 4: Uruchomić GREEN**

Run: `env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/kernel/layout/simulationPreparationDiagnostics.test.ts`

Expected: `5 passed`.

### Task 2: Specjalny modal i pełny raport

**Files:**
- Modify: `apps/control-room/src/kernel/layout/SimulationPreparationFailureDialog.tsx`
- Modify: `apps/control-room/src/kernel/layout/SimulationStartupOverlay.tsx`
- Modify: `apps/control-room/src/kernel/layout/simulationPreparationDiagnostics.ts`
- Modify: `apps/control-room/src/design/styles/dialog-simulation-startup.css`
- Test: `apps/control-room/src/kernel/layout/SimulationPreparationMounted.test.tsx`

**Interfaces:**
- Consumes: `SimulationPreparationViewModel.failure`, `serializeSimulationPreparationDiagnostics(snapshot)` i `navigator.clipboard.writeText`.
- Produces: modal z sekcjami podsumowania, przyczyn, kontekstu oraz `<details>` z pełnym raportem; przycisk `Copy full diagnostic report`.

- [ ] **Step 1: Dodać failing mounted test**

Fixture ma używać aktualnego `failed_predicates=[gpu_dmi_kernel_not_mixed_p1]`. Test wymaga widocznych tekstów `What happened`, `How to fix`, `Technical diagnostics`, zalecenia `FEM CPU`, identyfikatora predykatu, kodu błędu, correlation ID oraz przycisku `Copy full diagnostic report`.

- [ ] **Step 2: Uruchomić RED**

Run: `env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/kernel/layout/SimulationPreparationMounted.test.tsx -t "auto-opens one precise failure dialog"`

Expected: FAIL na brakujących nagłówkach lub etykiecie przycisku.

- [ ] **Step 3: Wdrożyć minimalną strukturę modala**

Surowy detail trafia do sekcji `What happened`; przyczyny są listą kart z `label`, `action` i kodem predykatu; dane kontekstu pozostają w `<dl>`; pełny JSON trafia do domyślnie zwiniętego `<details>`. Stopka zawiera kopiowanie, przejście do Diagnostic Recorder i zamknięcie.

- [ ] **Step 4: Dodać style token-first**

Użyć istniejących tokenów powierzchni, obramowania, tekstu i odstępów. Modal ma ograniczoną wysokość, przewijalne body, czytelne karty przyczyn i przewijalny monospace report; bez nowych surowych kolorów.

- [ ] **Step 5: Uruchomić GREEN**

Run: `env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/kernel/layout/SimulationPreparationMounted.test.tsx`

Expected: wszystkie testy pliku PASS, w tym kopiowanie, retry i nawigacja do diagnostics.

### Task 3: Audyt kompletności i regresji

**Files:**
- Verify: wszystkie pliki z Tasks 1–2.

**Interfaces:**
- Consumes: finalny modal i serializer.
- Produces: dowód testów, typecheck, React diagnostics i renderu.

- [ ] **Step 1: Zweryfikować bezpieczny pakiet**

W teście skopiowany JSON musi mieć maksymalnie 200 logów, zawierać `diag-42`, wszystkie etapy i requested/resolved execution oraz nie zawierać `secret-token` ani `/private/model.py` z pól spoza allowlisty.

- [ ] **Step 2: Uruchomić focused suite i typecheck**

Run: `env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/kernel/layout/simulationPreparationDiagnostics.test.ts src/kernel/layout/simulationPreparationModel.test.ts src/kernel/layout/SimulationPreparationMounted.test.tsx`

Run: `pnpm --dir apps/control-room typecheck`

Expected: wszystkie focused testy i typecheck PASS.

- [ ] **Step 3: Uruchomić React Doctor dla zmian**

Run: `cd apps/control-room && npx react-doctor@latest --verbose --scope changed`

Expected: brak nowego błędu dotyczącego zmienionych plików i brak regresji wyniku.

- [ ] **Step 4: Wykonać wizualny smoke**

Uruchomić Control Room, wyświetlić fixture błędu przygotowania i sprawdzić: dialog mieści się w viewport, fokus pozostaje w dialogu, przyczyna i zalecenie są czytelne, technical details rozwijają się, kopiowanie zgłasza sukces, a reduced-motion nie wpływa na dostępność.

- [ ] **Step 5: Sprawdzić końcowy diff**

Run: `git diff --check`

Expected: exit 0; brak zmian w OpenAPI/generated transport oraz brak nieprefiksowanych klas CSS.
