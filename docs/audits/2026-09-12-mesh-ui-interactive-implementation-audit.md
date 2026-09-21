# Audyt wdrożenia interaktywnego UI siatki

**Data:** 2026-09-12
**Zakres:** niezacommitowany diff gałęzi `codex/mesh-ui-interactive-20260912` względem `7faa259c5597ba447c413f2aea0ff66d6110b297`, plan wdrożenia oraz dowody w `D:\git\fullmag\task-storage\mesh-ui-interactive-20260912`.
**Werdykt audytu wejściowego:** **wdrożenie nie było gotowe do scalenia**. Po wykonaniu napraw opisanych w tym dokumencie kontrakty UI–API i lifecycle komend meshu są gotowe do scalenia w zakresie tego audytu. Pełny runtime GPU, fault injection natywnego meshera i eksport E2E pozostają osobnymi bramkami kwalifikacji.

Duża część warstwy UI została uporządkowana: edycja formularz/JSON jest spójna, istnieją osłony brudnych szkiców, FEM ma obserwację komendy po `command_id`, historia używa stabilnych identyfikatorów, a test przeglądarkowy potwierdza stabilność paneli Object i Airbox oraz poprawny stan WebGL. Pełny scenariusz interaktywnego testowania parametrów siatki nie jest jednak domknięty. Audyt wykrył trzy blokery, trzy wymagane poprawki oraz jedną sugestię.

## Ustalenia blokujące scalenie

### [Blocker] `fdm_grid_refresh` nigdy nie osiąga stanu terminalnego w rejestrze komend API

Rekonsyliacja rejestru rozpoznaje wynik operacji siatki tylko dla rodzaju `remesh`: `crates/fullmag-api/src/session.rs:249` kopiuje błąd wyłącznie dla `remesh`, a `infer_dispatched_command_completion` w `crates/fullmag-api/src/session.rs:302` nie ma gałęzi `fdm_grid_refresh`. Runtime zapisuje wynik FDM jako `MeshCommandOutcome`, ale API go nie konsumuje.

Skutek jest krytyczny: komenda pozostaje `dispatched`, blokada aktywnej operacji siatki nie zostaje zwolniona, a następne operacje siatki lub obliczeń mogą być stale odrzucane. Dodatkowo `command_resource_invalidations` w `crates/fullmag-api/src/router_v2/handlers/simulation/runtime.rs:3735` publikuje rewizje siatki tylko dla `remesh`, a lista zasobów gotowości w `runtime.rs:1944` również pomija FDM.

Istniejący test `fdm_grid_refresh_command_is_queued_for_atomic_runtime_replan` sprawdza jedynie przyjęcie komendy i oczekuje braku statusu zakończenia. Nie testuje rekonsyliacji ani odblokowania kolejki.

**Wymagana naprawa:** obsłużyć `fdm_grid_refresh` w rekonsyliacji, propagacji błędu, zasobach gotowości i invalidacjach; dodać test API obejmujący `queued -> dispatched -> completed/failed`, zmianę rewizji siatki oraz przyjęcie następnej komendy.

### [Blocker] odzyskiwanie komendy FEM po utracie odpowiedzi lub przeładowaniu używa innego rodzaju komendy niż API

Frontend szuka `entry.kind === "mesh_build"` w `apps/control-room/src/kernel/authoring/geometryLifecycleCommandContributions.ts:465` i odrzuca szczegóły, jeżeli `detail.kind !== "mesh_build"`, w linii 598. Backend mapuje publiczne żądanie `mesh_build` na wewnętrzną komendę `remesh` w `crates/fullmag-api/src/router_v2/handlers/simulation/commands.rs:1847`, a endpoint szczegółów zwraca zapisany rodzaj bez ponownego mapowania.

Skutek: po utracie odpowiedzi POST frontend nie odnajdzie już przyjętej komendy, a po przeładowaniu akcja obserwacji odrzuci poprawną komendę API. Testy przechodzą, ponieważ makiety zwracają `kind: "mesh_build"` i nie odzwierciedlają rzeczywistego kontraktu backendu.

**Wymagana naprawa:** ustalić jeden publiczny rodzaj komendy na granicy API. Preferowane rozwiązanie to publiczne `mesh_build` i jawne mapowanie na `remesh` wyłącznie wewnątrz runtime. Dodać test kontraktowy z rzeczywistą odpowiedzią endpointu szczegółów i scenariusze: utracona odpowiedź POST, przeładowanie strony, wznowienie obserwacji.

### [Blocker] zmiana samej siatki FDM może nadpisać model fizyczny niepełną projekcją sceny

`scene_problem_patch_for_mesh` w `crates/fullmag-api/src/router_v2/handlers/simulation/commands.rs:965` rekonstruuje geometrię, regiony, materiały i magnesy. Przy tym jawnie zeruje między innymi pola `alpha_field`, `a_field`, pola anizotropii, `ms_field`, oś i parametry anizotropii w liniach 990–1015. `prepare_fdm_grid_refresh` stosuje tę łatę do każdego etapu (`crates/fullmag-cli/src/orchestrator/manual_remesh.rs:63-66`), a `apply_scene_problem_patch` zastępuje całe kolekcje `geometry`, `regions`, `materials`, `magnets` i `object_regions` (`crates/fullmag-cli/src/orchestrator.rs:2858-2863`).

Skutek: operacja dotycząca wyłącznie dyskretyzacji może usunąć przestrzennie zmienne parametry materiałowe lub inne dane obecne w kanonicznym `ProblemIR`. Narusza to zasadę, że zmiana siatki nie redefiniuje fizyki.

**Wymagana naprawa:** aktualizować wyłącznie część geometrii/dyskretyzacji przez kanoniczny adapter albo ponownie obniżyć pełny model sceny do `ProblemIR`. Dodać regresję z anizotropią, polami materiałowymi, wieloma etapami i aktywnymi modułami fizyki; po A→B→A wszystkie dane poza siatką muszą pozostać identyczne.

## Wymagane poprawki

### [Required] panele FDM kończą przepływ na przyjęciu komendy

`StudyInspectorPanel.tsx:901` i `AirboxMeshParametersPanel.tsx:231` wysyłają `fdm_grid_refresh`, po czym pokazują komunikat o przyjęciu. Nie ustawiają `client_intent_id`, nie obserwują konkretnego `command_id`, nie czekają na stan terminalny i nie pokazują błędu runtime. Użytkownik nie wie, czy nowa siatka została rzeczywiście uruchomiona, odrzucona albo wycofana.

**Wymagana naprawa:** skierować FDM przez ten sam mechanizm korelacji i obserwacji co FEM, z osobnym komunikatem o przyjęciu i zakończeniu, stanem błędu oraz informacją o polityce zachowania/resetu stanu magnetyzacji.

### [Required] odtwarzanie historii nie potrafi przywrócić braku nadpisania polityki

Snapshot może legalnie zawierać `null` dla obiektu lub domeny. `ObjectMeshPolicyPanel.tsx:937-938` zamienia wartość na rekord i kończy obsługę dla `null`. `AirboxMeshParametersPanel.tsx:176-179` robi to samo dla `universe/shared_domain`. Jednocześnie `meshBuildHistory.ts:196` oznacza cały snapshot jako odtwarzalny, więc UI pokazuje akcję Restore, która w tych przypadkach nic nie robi.

**Wymagana naprawa:** potraktować `null` jako polecenie usunięcia lokalnego nadpisania i powrotu do dziedziczonej polityki. Dodać testy Object i Airbox dla przejścia `brak nadpisania -> wartość -> Restore(brak nadpisania)`.

### [Required] deklarowana kwalifikacja FDM GPU i status planu wykraczają poza dowody

Log `managed-fullmag-cli-gpu-fdm-grid-final.log` uruchamia dwa testy pomocnicze zakończone w około 0,04 s. Testy w `crates/fullmag-cli/src/orchestrator.rs:14081` i `:14107` sprawdzają serializację workspace oraz zastosowanie łaty. Nie uruchamiają komendy, nie tworzą runtime GPU, nie weryfikują CUDA ani braku fallbacku CPU. Obecność RTX 3070 w kontenerze nie dowodzi wykonania tej ścieżki na GPU.

Dowód przeglądarkowy obejmuje PUT/GET polityk Object i Airbox. Nie zawiera POST komendy symulacji, przebiegu FDM ani panelu Region. Plan mimo to oznacza R0–R7 jako zakończone, chociaż sam odnotowuje brak natywnego A→B→A, fault injection i eksportowego E2E.

**Wymagana naprawa:** zmienić status planu na częściowy do czasu zamknięcia bramek. Uruchomić rzeczywistą komendę FDM CPU i GPU przez zarządzany runtime, potwierdzić rozstrzygnięty backend/device, brak fallbacku, zmianę generation ID, zachowanie masek oraz stan terminalny API. Browser E2E powinien objąć Object, Region, Airbox, FEM i FDM.

## Sugestia

### [Suggestion] historia nie odczytuje czasu trwania publikowanego przez backend

Backend publikuje `duration_ms`, natomiast `apps/control-room/src/shared/domain/mesh/meshBuildHistory.ts:193-195` odczytuje tylko `mesh_time_seconds`, `duration_seconds` i `build_duration_seconds`. Nowe wpisy mogą więc stale pokazywać brak czasu trwania.

**Proponowana naprawa:** odczytać `duration_ms / 1000` i dodać jeden test normalizacji.

## Macierz kryteriów akceptacji

| Obszar | Ocena | Dowód lub brak |
|---|---|---|
| Formularz ↔ JSON | Spełnione dla Object i Airbox | testy jednostkowe i browser smoke |
| Ochrona brudnego szkicu | Spełnione dla sprawdzonych paneli | stabilność wyboru, focusu i scrolla w browser smoke |
| Korelacja FEM po `command_id` | Częściowo | działa podczas bieżącej sesji; odzyskiwanie po reloadzie jest zepsute przez `mesh_build`/`remesh` |
| Terminalny wynik FDM | Niespełnione | brak rekonsyliacji `fdm_grid_refresh` |
| Transakcyjny rollback | Konstrukcja wiarygodna, kwalifikacja niepełna | brak natywnego fault injection |
| Historia i Restore | Częściowo | stabilne ID; brak obsługi snapshotu `null`, brak czasu trwania |
| FDM CPU/GPU | Niespełnione jako kwalifikacja produkcyjna | testy helperów zamiast rzeczywistego runtime |
| Browser E2E | Częściowo | Object/Airbox i WebGL; brak Region, komendy runtime i FDM |
| Eksport i reload | Niezweryfikowane | plan oznacza brak E2E eksportu |

## Wykonana weryfikacja

- Przegląd 57 zmienionych plików oraz dokumentu wdrożeniowego i zebranych logów.
- Ponowne uruchomienie pięciu zestawów Vitest dotyczących lifecycle komend, dialogu i historii: **5 plików, 60 testów, wszystkie przeszły**.
- `git diff --check`: brak błędów białych znaków.
- Analiza dowodu przeglądarkowego: synchronizacja JSON, odrzucanie błędnego JSON, ochrona brudnego szkicu oraz WebGL przeszły dla Object/Airbox.
- Analiza logów zarządzanych testów CPU/GPU wykazała, że obecny test GPU nie wykonuje ścieżki runtime FDM.

Powyższy werdykt dotyczył stanu przed naprawami. Po zmianach te trzy kontrakty mają testy regresyjne i przechodzą w ścieżce CPU zarządzanego kontenera; kwalifikacja produkcyjnego GPU i fault injection nadal wymaga osobnych scenariuszy.

## Plan naprawczy

1. Ujednolicić publiczny rodzaj komendy i dodać test kontraktowy API–frontend dla utraconej odpowiedzi oraz reloadu.
2. Domknąć lifecycle `fdm_grid_refresh`: gotowość, ledger, outcome, invalidacje, terminalny błąd/sukces i odblokowanie kolejki.
3. Zastąpić niepełną łatę sceny kanonicznym przepływem aktualizacji `ProblemIR`; udowodnić brak dryfu fizyki.
4. Podłączyć oba panele FDM do wspólnego obserwatora komend i jawnej polityki stanu.
5. Naprawić Restore dla `null`, obsługę `duration_ms` i rozbieżność `explicit_selection` (`commands.rs:1041` wobec kanonicznej logiki w `fullmag-authoring/src/adapters.rs:308-312`).
6. Uruchomić brakujące bramki: FEM Object/Region/Airbox A→B→A, natywny rollback z błędem, rzeczywisty FDM CPU/GPU, eksport/reload oraz browser E2E z POST komend.
7. Dopiero po przejściu tych bramek zmienić plan na zakończony i przygotować commit.

## Stan po naprawach — 2026-09-12

Naprawiono wszystkie blokery i wymagane poprawki objęte audytem:

1. `fdm_grid_refresh` jest rekonsyliowany do stanów `completed`, `failed` i `rejected`, propaguje błąd, zwalnia admission oraz publikuje invalidacje rewizji siatki i topologii.
2. Publiczny kontrakt API używa `mesh_build`; wewnętrzne `remesh` pozostaje szczegółem kolejki. Dodano test szczegółu i listy komend oraz obsługę utraconego ACK i reloadu po stronie UI.
3. FDM aktualizuje wyłącznie dyskretyzację. `apply_scene_discretization_patch` nie zastępuje geometrii, materiałów, magnesów, regionów ani `object_regions`; regresja potwierdza zachowanie tych kolekcji.
4. Study i Airbox korzystają ze wspólnego obserwatora terminalnego FDM, z komunikatem sukcesu/błędu i informacją o reinitializacji magnetyzacji.
5. Restore obsługuje `null` jako usunięcie lokalnego nadpisania, a historia odczytuje `duration_ms`.
6. FDM bez materializowanej sceny jest odrzucany przed kolejką; nie zostaje jako komenda, która dopiero później awarii.

Weryfikacja po naprawach:

- frontend: 103 testy celowane, TypeScript (`--incremental false`) i ESLint — zaliczone;
- lokalny API: 4/4 testy lifecycle FDM oraz 13/13 testów macierzy admission — zaliczone;
- zarządzany kontener CPU przez `just windows-test-fem`: API 4/4 i CLI 2/2 — zaliczone;
- `git diff --check` — zaliczone.

Do osobnej kwalifikacji pozostają: rzeczywiste wykonanie tej konkretnej komendy w runtime GPU bez fallbacku, fault injection natywnego meshera oraz pełny eksport/reload skryptu. Nie blokują one scalenia napraw kontraktu UI–API objętych niniejszym audytem, ale nie należy ich przedstawiać jako już zaliczonych.
