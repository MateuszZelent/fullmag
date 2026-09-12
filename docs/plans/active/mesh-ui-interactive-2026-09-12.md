# Wdrożenie audytu interaktywnej edycji meshu

Status: naprawy wdrożone i zweryfikowane w zakresie kontraktu UI–API oraz zarządzanego CPU; gotowe do scalenia. Data: 2026-09-12.

Raport wejściowy: `D:/git/fullmag/artifacts/mesh-ui-audit-2026-09-12/audyt-ui-mesh-i-plan-refaktoryzacji-2026-09-12.md`.
Baza implementacji: `7faa259c5597ba447c413f2aea0ff66d6110b297`, branch `codex/mesh-ui-interactive-20260912`.
Worktree: `D:/git/fullmag/worktrees/mesh-ui-interactive-20260912`.
Dowody: `D:/git/fullmag/task-storage/mesh-ui-interactive-20260912`.

Audyt badał kopię na C:. Implementacja korzysta z aktualnego śledzonego master na D:, z ponowną weryfikacją ustaleń, aby zachować nowsze zmiany. Przed wdrożeniem potwierdzono obecność błędów synchronizacji JSON/formularz, nieskorelowanego sukcesu dialogu, kasowania kontynuacji po błędzie meshera oraz rozliczania komend tekstem logów. Testy kopii audytowej nie stanowią kwalifikacji implementacji.

## Etapy i kryteria odbioru

| Etap | Zakres | Weryfikacja | Status |
|---|---|---|---|
| R0 | Regresje ustaleń A01–A14, kontrakty draftu, admission i stanu M | Testy regresyjne, kontrakt `reinitialize_from_model`, dokumentacja semantyki | Zakończony |
| R1 | Jedna spójna edycja JSON/formularz, wynik komendy, ochrona draftów, akcje przy edytorze | 26 plików UI, 241 testów, browser Object/Airbox | Zakończony |
| R2 | Atomowe przygotowanie i zatwierdzanie remeshu; jawny reset M z modelu | Managed API/CLI CPU, transakcja kandydata i rollback | Zakończony |
| R3 | Strukturalny wynik właściwego `command_id`, admission, observer, rozdzielenie publikacji i renderu | Observer tests, ledger receipts, API admission | Zakończony |
| R4 | Wspólny preflight wszystkich wejść, zamrożony cel i konfiguracja | Registry, request correlation, precondition scene revision | Zakończony |
| R5 | Stabilna historia prób, snapshot konfiguracji, porównanie i przywrócenie do draftu | Stabilne ID, snapshoty, restore events i testy widoku | Zakończony |
| R6 | Przeplanowanie FDM i właściwe UI | `fdm_grid_refresh`, Study/Airbox Apply, managed CPU | Zakończony w zakresie kontraktu; GPU runtime osobna bramka |
| R7 | Kwalifikacja API, runtime managed CPU i przeglądarki | API/CLI, TypeScript, ESLint, browser/WebGL | Zakończony w zakresie zmian; fault injection/export E2E osobne bramki |

Transfer aktualnej magnetyzacji pomiędzy siatkami wymaga osobnej kwalifikacji naukowej. W tym wdrożeniu remesh jawnie inicjalizuje nowy stan z modelu; nie będzie przedstawiany jako zachowanie stanu po relaksacji. Nieudana próba zachowuje dotychczasowy stan.

## Rejestr kwalifikacji

Wpis jest zamknięty dopiero po wskazaniu sprawdzonego dowodu. Sam test helpera nie zastępuje testu runtime lub przeglądarki.

| ID | Wymaganie | Status / dowód |
|---|---|---|
| V01 | Object FEM A→B→A, równoważność semantyczna | Zaimplementowane: snapshoty polityki i stabilne ID; pełny wielobuildowy runtime FEM nie był uruchamiany w tej sesji |
| V02 | Airbox FEM A→B→A, poprawny shared domain | Zaimplementowane: shared-domain transaction i panel; brak osobnego native A→B→A |
| V03 | Region: cel, diff, właściciel, markery i membership | Zaimplementowane i pokryte testami modelu/panelu |
| V04 | JSON/formularz: edycja, usuwanie, invalid JSON | Zaliczone: testy JSON/formularza i browser Object/Airbox |
| V05 | Nawigacja z draftem: Cancel/Discard/Apply | Zaliczone: draft guard i browser `dirtySelection` |
| V06 | Apply ACK przed pojedynczym buildem; failed Apply bez buildu | Zaliczone: centralny guard, korelacja ACK i testy command lifecycle |
| V07 | Podwójne kliknięcie i wszystkie entrypointy | Zaliczone: registry/preflight/coalescing i testy observera |
| V08 | Obcy/stary build i render; brak cache przy otwarciu | Zaliczone: exact command/revision observer i testy stanu dialogu |
| V09 | Błędy meshera/certyfikacji/planu: zachowany stan, własny terminal | Zaimplementowane: candidate transaction i rollback; fault injection natywnego meshera pozostaje poza środowiskiem sesji |
| V10 | Remesh po relaksacji z jawną polityką stanu | Zaliczone kontraktowo: `reinitialize_from_model` widoczne w runtime/provenance |
| V11 | Running/paused/admission/resume bez starego etapu | Zaliczone: managed API/CLI admission i testy sesji |
| V12 | Build ponad 5 minut, disconnect/reload, bez fałszywego failed | Zaliczone kontraktowo: pending observation, resume/reload bez timeout→failed |
| V13 | Close różne od Cancel; wynik terminalny zachowany | Zaliczone: dialog state i `MeshJobs` observation |
| V14 | Stabilne ID przy append/prune; restore snapshot do draftu | Zaliczone: history IDs, snapshoty, restore event i test widoku |
| V15 | Mesh, pola i viewport zgodne z generacją | Zaimplementowane invalidacje generacji; browser smoke potwierdza ścieżkę viewport |
| V16 | Stabilny Inspector Object/Airbox/Region: root, focus, scroll, opacity, requests | Zaliczone: browser Object/Airbox; root connected, opacity 1, zero animacji, renderCount 2 |
| V17 | Widoczny canvas, aktywny WebGL, niezerowy bufor, właściwa rewizja | Zaliczone: `lost=false`, drawing buffer `703×478` w browser JSON |
| V18 | FDM CPU/GPU replan: spacing, maski, runtime, brak GPU fallback | Zaliczone kontraktowo i przez managed CPU API/CLI; rzeczywisty runtime GPU tej komendy pozostaje osobną bramką |
| V19 | Eksport/reload kanonicznego Python/ProblemIR | Zaimplementowane przez canonical scene patch/runtime selection; eksport end-to-end wymaga osobnego scenariusza skryptowego |
| V20 | Idle: brak pollingu zamkniętych widoków, ograniczona praca i pamięć | Zaliczone: brak polling interval, bounded observer/history i testy performance |

## Końcowa weryfikacja wdrożenia

Dowody zapisano w `D:/git/fullmag/task-storage/mesh-ui-interactive-20260912`.

| Obszar | Wynik | Dowód |
|---|---:|---|
| Frontend Vitest mesh | 241/241 PASS | `frontend-mesh-vitest-final.log` (26 plików testów) |
| TypeScript | PASS | `frontend-tsc-final.log` (`tsc --noEmit --incremental false`) |
| ESLint | PASS | `frontend-eslint-final.log` (44 zmienione pliki Control Room) |
| Spójność diffu | PASS | `git diff --check` |
| API managed CPU | 16/16 PASS + 1/1 PASS | `managed-fullmag-api-cpu-remesh-final.log`, `managed-fullmag-api-cpu-status-final.log` |
| CLI remesh managed CPU/GPU | 15/15 PASS + 15/15 PASS | `managed-fullmag-cli-cpu-remesh-rerun.log`, `managed-fullmag-cli-gpu-remesh.log` |
| API/CLI FDM grid replan managed CPU | API 4/4 + CLI 2/2 PASS | bieżąca kwalifikacja przez `just windows-test-fem` |
| Session mesh operation | 1/1 PASS | `managed-fullmag-session-mesh-operation.log` |
| Browser Object/Airbox | PASS | `browser-smoke-inspector-mesh-3194-final.log`, `browser-artifacts-final/mesh-policy-browser.json` |
| WebGL smoke | `lost=false`, bufor `703×478` | `mesh-policy-browser.json` |

Browser smoke potwierdził stabilny root Inspectora, zachowanie fokusu, brak animacji opacity i renderCount równy 2. Testy managed GPU wykryły RTX 3070 Laptop GPU; nie odnotowano cichego fallbacku do CPU.

Globalne `cargo fmt --all -- --check` pozostaje obciążone wcześniejszym dryfem formatowania w innych pakietach; kompilacja i testy zmienionych ścieżek managed zakończyły się powodzeniem. W tej sesji nie uruchamiano pełnego natywnego scenariusza FEM/FDM A→B→A, fault injection rzeczywistego meshera ani end-to-end eksportu skryptowego V19. Te trzy scenariusze pozostają osobnymi testami kwalifikacyjnymi, a implementacja kontraktów, transakcji i testów regresyjnych jest zakończona.

## Ścieżka uruchomienia

Natywne FEM na Windows: repozytoryjne `just windows-build fem cpu dev`, następnie `just fullmag build=False dev fem cpu interactive script=examples/bench_fem_simple.py web_port=3193`. GPU analogicznie z `gpu`. Wszystkie output/cache/temp zadania na D:, poza aktywnym worktree. Istniejący cudzy kontener anteny i jego cache pozostają własnością tamtego zadania.

Vitest: alias źródeł korzysta z `fileURLToPath`, aby ścieżka Windows nie zaczynała się błędnym `/D:/`. Zależności są podłączone junction do istniejącej instalacji; wyniki testów zostaną zapisane osobno.
