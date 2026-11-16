# Footer Readability Implementation Plan

> **For agentic workers:** Execute bounded tasks in the existing owned worktree; do not delegate further or overwrite other workers.

**Goal:** Przebudować wszystkie zakładki footera dla czytelnego monitorowania i diagnostyki.

**Architecture:** Zachowujemy moduł transport-footer w panel-bottom, wspólne Tabs/PanelChrome i istniejące resource hooks. Zmiany dotyczą prezentacji i responsywności; żadnych nowych transportów.

**Tech Stack:** Istniejące React/Next.js, Radix shared primitives, tokeny Catppuccin, CSS container queries.

**Spec:** ../specs/2026-11-16-footer-readability-design.md

## Global Constraints

- Wszystkie nowe klasy fm-, kolory z --fm-*; bez nowych zależności.
- Zachować wartości, jednostki, session/run provenance i active-only lifecycle zakładek.
- Testy i frontend wyłącznie w fullmag-worktree-fullmag-eacf66fd4f16a992; nowy preview3306 zachowuje odrębną sesję testową. Poprzednia sesja3294 jest zachowana po blokadzie readmission.

## Review Focus

- Wąski pływający panel: wszystkie zakładki, fokus i akcje ramki dostępne.
- Niski footer: żadne metryki nie są ukrywane bez możliwości przewinięcia.
- Długie wartości/identyfikatory: dostęp do całej treści i jednostek.
- Jasny/ciemny motyw: semantyczne kolory nie obniżają kontrastu etykiet.
- Inactive tabs: brak dodatkowych zasobów, timerów i drugich chart owners.

### Etap 1: Spójny footer i metryki

- [x] Przeanalizować właściwe guide Modern Web Guidance.
- [ ] Worker odpowiada za FooterTelemetry.tsx i footer-telemetry.css; główny agent za pozostałe widoki i style.
- [ ] Uporządkować zakładki, przewijanie, nagłówki i statusy wszystkich siedmiu widoków.
- [ ] Wykonać adekwatne testy źródeł i commit spójnego etapu.

### Etap 2: Browser QA i integracja

- [ ] Zautomatyzować regresję light/dark, siedmiu zakładek, kontrastu i małych paneli; zapisać rzeczywiste zrzuty.
- [ ] Typecheck, lint, testy, architecture hygiene i React review.
- [ ] Review diff, commit, push, PR, wymagane CI i merge.
- [ ] Fast-forward głównego mastera; zapisać status integracji oraz pozostawiony podgląd w rejestrze.
