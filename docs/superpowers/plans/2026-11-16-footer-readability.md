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
- [x] Worker odpowiada za FooterTelemetry.tsx i footer-telemetry.css; główny agent za pozostałe widoki i style.
- [x] Uporządkować zakładki, przewijanie, nagłówki i statusy wszystkich siedmiu widoków.
- [x] Wykonać adekwatne testy źródeł i commit spójnego etapu.

### Etap 2: Browser QA i integracja

- [x] Zautomatyzować regresję light/dark, siedmiu zakładek, kontrastu i małych paneli; zapisać rzeczywiste zrzuty.
- [x] Typecheck, lint, testy, architecture hygiene i React review.
- [ ] Review diff, commit, push, PR, wymagane CI i merge.
- [ ] Fast-forward głównego mastera; zapisać status integracji oraz pozostawiony podgląd w rejestrze.

## Dowody i dopracowanie widoku kompaktowego

- Commit źródłowego etapu: `ee7525301945925c7e578abf1fab56c0d4a601de`; pierwszy CI bootstrap i contract-guard zakończyły się sukcesem.
- Po zrzucie rzeczywistego panelu o wysokości 100 px połączono nawigację Overview/Antenna z nagłówkiem i zastosowano natywne details dla kontekstu metryk. Wartości i jednostki pozostają od razu widoczne; szczegóły rozwija Enter.
- Zarządzane testy po tej poprawce: 9782/9782, typecheck i scoped lint bez błędów. Architecture hygiene bez błędów; review zmian prezentacji bez wymaganych poprawek.
- Kontrola przeglądarkowa footera jest podpięta do istniejącego audytu CI memory-churn z pełnym fixture FDM. Sprawdza wszystkie zakładki/motywy, kontrast >= 4.5, widoczne liczby przy wysokości <= 110 px, klawiaturę i przewijanie; zapisuje PNG oraz weryfikuje canvas.
- Szerszy lokalny audyt viewportu zatrzymał się wcześniej na przezroczystym eksporcie nieopublikowanego pola m w osobnej sesji QA. Ten zakres pozostaje NOT VERIFIED; nie obniżono progów ani kontroli audytu viewportu.

- Końcowa kontrola zrzutów z CI ujawniła brakujące odpowiedzi diagnostyczne w fixture: błąd zasobu nie był błędem konsoli/HTTP i zasłaniał nawigację. QA otrzymuje osobną kontrolę powiadomień o błędach, a fixture poprawne odpowiedzi zgodne z typami API; nie ukrywamy komunikatu ani nie zmieniamy zachowania produkcyjnego.

- CI dla `ac8d83db8fc29542eb874c4fe00e55a737ef9160`: Control Room i cały browser-fixture-smoke zielone; 14 próbek, minimum kontrastu 5.1701:1, w obu motywach wysokość 104 px i cztery widoczne wartości, 16 metryk dostępnych w panelu o wysokości 180 px. Powtórna bramka po uzupełnieniu fixture wymaga również braku powiadomień o błędach i zapisuje rozwinięty panel o wysokości 300 px.
