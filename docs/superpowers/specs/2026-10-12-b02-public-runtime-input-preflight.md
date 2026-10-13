# B02 — wejścia i preflight publicznej weryfikacji anteny

Status: plan wykonania, **NOT_EXECUTED**. Dokument nie jest wynikiem solvera,
manifestem kwalifikacji ani zastępstwem kanonicznej noty naukowej 0950.
Odczyt źródeł: 2026-10-12. Właściciel wykonania: wątek
`01a12a56-002e-7660-8424-c7e07fb0907a`; ten checkout nie uruchamia drugiego buildu.

## Przypięcie źródeł i brakujące zasoby

Zadeklarowany przez integratora build: `2b566a32ee0245bb8553a336c8fc5947`,
profil `fem-cpu-release`, commit `67ddd77c9d7bee6459f796788c6ed6fe507cb6f5`,
czysty snapshot `32be5af6132b9630c59f93bb118dbe4d0e4de291984772bf9b243febebceb370`.
W chwili przekazania build oczekiwał w kolejce; nie stwierdzono sukcesu pakietu.
Brak rzeczywistych wejść `project.fms`, profilu, budżetu i kapsuły żądania.
Nie należy wpisywać domniemanych ścieżek, hashy ani właścicieli tych zasobów.

Punktem wejścia jest committed `examples/fem_antenna_closed_loop_nonmagnetic.py`
(symbol `study`): microstrip z przewężeniem, płytą powrotną i dwoma mostkami,
pełny obwód 3D, idealny skok potencjału 0,25 V i osobna niemagnetyczna
domena próbkowania. Jedyny etap `inspect_loop` publikuje inspekcję V/J/H.
Nie zmieniać geometrii, tolerancji ani zasilania dla uzyskania dodatniego wyniku.

## Utworzenie rzeczywistych wejść — kolejność planowana

1. Zweryfikować terminalny udany pakiet przez
   `scripts/managed_fem_runtime_package.py::load_package`: dokładny commit,
   snapshot, source/image digest, trusted hashes, receipt i zawartość artefaktów.
   Potrzeba siedmiu binariów wymienionych w
   `scripts/verify_accepted_closed_loop_runtime.py::BINARIES`, trzech zgodnych
   aliasów biblioteki FEM oraz `_fullmag_core.so` z build receipt.
2. Zgodne prywatne API musi ujawnić tożsamość buildu przez
   `/v2/platform/openapi.json`; verifier sprawdza ją przez `assert_build_identity`.
   Nie wykorzystywać istniejącego workspace użytkownika jako prywatnego store.
3. Utworzyć pusty projekt przez `POST /v2/persistence/projects` z jedynym
   wejściem `name`. Oczekiwać HTTP 201. Zachować całą rzeczywistą odpowiedź:
   `project_id`, `revision`, `schema_version`, `migration`, `mode`,
   `archive_base64`, `durability`. Ta operacja zwraca bajty, nie zapisuje pliku
   i nie rozpoczyna przygotowania ani obliczeń.
4. Zdekodować otrzymane `archive_base64` do nowego prywatnego `project.fms`.
   Wyznaczyć SHA-256 dokładnych bajtów; nie utożsamiać go automatycznie z
   `source_hash` odpowiedzi. Archiwum musi być zapisywalne według migracji;
   producent CLI ponownie otwiera je przez `FileProjectRepository`.
5. Przygotować profil z `schema_version: execution_profile.v1`, rzeczywistym
   niepustym `profile_id` i `version` (maksymalnie 256 bajtów UTF-8 każde,
   bez białych znaków i znaków sterujących). `version` nie może być `latest`
   niezależnie od wielkości liter: wersja musi być niezmienna.
   `description` jest opcjonalne, maksymalnie 4096 bajtów UTF-8. Nieznane
   pola są odrzucane przez `ExecutionProfileIR`. `defaults` pominąć
   albo ustawić na pusty obiekt: B02 zabrania nadpisywania żądania przykładu.
   Nie wpisywać do profilu udawanego wyniku publikacji ani rewizji katalogu.
   Obliczyć hash pliku osobno od kanonicznego `profile_sha256` zasobu.
6. Budżet zawiera dokładnie cztery całkowite pola: `cpu_millis`,
   `memory_bytes`, `gpu_memory_bytes`, `storage_bytes`. Dla B02 odpowiednio:
   1..2000, 1..4294967296, dokładnie 0, oraz wartość dodatnia nieprzekraczająca
   wolnego miejsca pomniejszonego o 1 GiB. Wybrać rzeczywiste wartości z oferty
   zasobów i zachować hash pliku; nie traktować `cpu_millis` jako czasu symulacji.
7. Verifier sam odczytuje katalog `/v2/platform/compute/profiles`, publikuje
   profil z aktualnym `expected_revision` i własnym `client_intent_id`, oczekuje
   201 i zapisuje odpowiedź. Nie publikować wcześniej tej samej wersji tak,
   aby zamienić jego wymagane nowe utworzenie w replay HTTP 200.
8. Uruchomić dopiero zgodny managed Linux verifier z wszystkimi wymaganymi
   flagami `main`; ścieżki kontenera rozwiązać z rzeczywistych mountów.
   `repo-root` musi wskazywać `source-capsule/tree`, nie mutowalny checkout.
   Kapsuła źródeł i kapsuła żądania runtime są różnymi zasobami.

## Kapsuła żądania — wymagania, nie gotowy manifest

Przyszły zapis żądania musi przypiąć właściciela wykonania, identyfikator buildu,
commit, snapshot i source digest, ścieżkę terminalnego pakietu, kapsułę źródeł,
storage root, świeży output root, rzeczywiste ścieżki i SHA-256 projektu,
profilu i budżetu, jawny interpreter obrazu oraz `solve_timeout_seconds`
w zakresie 1..3600. Istniejący launcher definiuje już schema ID
`fullmag.accepted-closed-loop-launch.v1`; nie należy tworzyć konkurencyjnego formatu.
Kontrola musi odrzucać brakujące wartości zamiast uzupełniać je placeholderami.

`scripts/launch_accepted_closed_loop_runtime.py::launch` przyjmuje dokładnie
14 kluczy: `schema`, `repo_root`, `source_capsule`, `managed_build_run_root`,
`output_root`, `image`, `commit`, `snapshot`, `source_digest`,
`solve_timeout_seconds`, `driver`, `project`, `execution_profile`, `resources`.
Ostatnie cztery są obiektami zawierającymi dokładnie `path` i `sha256`.
Właściciel jest generowany przez launcher, nie dostarczany jako dodatkowe pole.
Storage jest rozwiązywany z `repo_root`; interpreter to `/usr/bin/python3`
w przypiętym obrazie. Obraz wymaga pełnego `sha256:` digest, Linux/amd64.
Driver musi wskazywać dokładny plik `scripts/verify_accepted_closed_loop_runtime.py`
z kapsuły, zgodny ścieżką, rozmiarem i hashem z manifestem.

`repo_root` kapsuły żądania jest checkoutem używanym do resolvera storage;
nie mylić go z flagą `--repo-root` drivera, którą launcher ustawia na
`/probe/project/worktrees/source/tree`. Wejścia są kopiowane i montowane
read-only pod `/probe/input`; pakiet pod `/probe/project/storage/import/build/{job}`.
Tylko dedykowane proof i runs są zapisywalne. Kontener nie ma sieci, portów
ani GPU; ma 2 CPU, 4 GiB RAM, użytkownika 65532, read-only root i limit 256 PID.
Nie zastępować publicznego tworzenia projektu wywołaniem z tego offline kontenera:
projekt musi powstać wcześniej przez zgodne prywatne API i zostać przypięty.

Przed uruchomieniem sprawdzić limit plików: projekt 64 MiB, profil 1 MiB,
budżet 64 KiB; dodatni rozmiar, absolutna ścieżka, brak symlinków w rodzicach,
brak `..`, hash dokładnych bajtów. Output i namespace runów muszą być nowe.
Interpreter i NumPy są sprawdzane w obrazie; natywny core musi pochodzić
z dokładnie zaakceptowanego pakietu. Nie korzystać z hostowego core.

## Tożsamość publicznego przebiegu

`crates/fullmag-cli/src/accepted_script_run.rs::submit_script` przechwytuje
rzeczywisty skrypt, kompiluje pipeline i zachowuje źródła jako immutable assets.
Study i run są wyprowadzane z SHA-256 klucza idempotencji. Nie wpisywać ręcznie
`task_id`: odczytać go z faktycznej materializacji i katalogu runu.
Publiczny transport (`accepted_run_transport.rs::submit_run_request`) wykonuje:
POST runs → POST materialization → GET run. Submit nie uruchamia solvera.

Verifier wymaga pojedynczego accepted task oczekującego przygotowania.
Po Prepare powiązanie run/task/preparation_attempt/resource/lease_token musi
być identyczne w launch, exit i released lease; receipt ma schemat
`closed_loop_preparation_receipt.v1` i `preparation_id = prep-{task_id}`.
Start ma jedną próbę, bez automatycznych retry, z zakończonym workerem i
zwolnionym lease. Attempt i ownership epoch pochodzą z wykonania, nie szablonu.

Cold API odkrywa wynik przez `/v2/persistence/projects/{project}/runs/{run}`
i podzasoby `solution-sets/{id}/revisions/{revision}/members/.../artifacts`.
Wymagany jest jeden state-free succeeded member i jeden bundle
`fullmag.antenna.closed_loop_bundle@v1`, z dokładnym CAS object_ref.
Etap ma wyprowadzony `INSPECTION_EXECUTION_ID`, nie literalne `inspect_loop`.
Rewizja jest kanonicznym dodatnim dziesiętnym stringiem poniżej 2^64.

## Bramki i ograniczenia dowodu

`verify-saved-inspection` musi potwierdzić pass/read_only, zgodne CAS,
artifact_id i preparation_id oraz niezmieniony fingerprint store.
Odrzucenia: niezgodny attempt, epoch i CAS; na osobnym ograniczonym klonie
także zmieniony preparation_id i brak dokładnego durable Completed.
Nie modyfikować store dodatniego przebiegu ani wspólnej kolejki.
Limity logów: stdout 4 MiB, stderr 1 MiB; store do 20000 plików, 512 MiB
na plik, 2 GiB łącznie. Timeout obserwacji nie pozwala uruchomić duplikatu.

Udany receipt oznacza wyłącznie sprawność tego inspekcyjnego przebiegu,
publikacji i integralności odczytu. `scientific_qualification = not_verified`,
`publication = inspection_only` pozostają prawidłowe również przy `passed`.
Nie dowodzi to zbieżności pola, reusable basis, LLG, FFT odpowiedzi ani UI.
FEM CPU/double jest jedyną trasą tego testu; FDM CPU, FDM GPU i FEM GPU
nie są nim kwalifikowane. Test browser/WebGL z rzeczywistym H pozostaje
oddzielną bramką po udanym przebiegu i podłączeniu danych do UI.

## Indeks źródeł i weryfikacja dokumentu

- `examples/fem_antenna_closed_loop_nonmagnetic.py::study` — wejście fizyczne.
- `scripts/verify_accepted_closed_loop_runtime.py::{main,run,validate_budget,one_task,preparation_proof,public_output,fixed_bytes}` — flagi i bramki.
- `scripts/managed_fem_runtime_package.py::{load_package,runtime_runs_root}` — pakiet i storage.
- `scripts/launch_accepted_closed_loop_runtime.py::{SCHEMA,launch,attest,image_admission}` — kapsuła i izolacja wykonania.
- `scripts/test_launch_accepted_closed_loop_runtime.py::Admission` — interpretowane negatywy bez Dockera.
- `crates/fullmag-cli/src/accepted_script_run.rs::submit_script` — capture i lowering.
- `crates/fullmag-cli/src/accepted_run_transport.rs::submit_run_request` — publiczne operacje.
- `crates/fullmag-api/src/schemas/projects.rs::{ProjectCreateRequest,ProjectDocumentResource}` i `router_v2/handlers/persistence/projects.rs::create` — projekt bytes-only.
- `crates/fullmag-api/src/schemas/compute_profiles.rs::{ExecutionProfileInputSchema,PublishExecutionProfileRequest}` — profil i publikacja.
- `crates/fullmag-ir/src/execution_profile.rs::{ExecutionProfileIR::validate,validate_profile_identity,ExecutionProfileIR::canonical_sha256}` — walidacja bajtowa i niezmienność wersji.
- `crates/fullmag-application/src/run_spec.rs::RequestedResourceBudget` — budżet.

Dowód tego dokumentu: odczyt implementacji i przypiętego przykładu; wykonanie
operacji publicznych, managed runtime i browser: **NOT_EXECUTED**.
Porównanie dziesięciu powyższych plików źródłowych z pełnym commitem
`67ddd77c9d7bee6459f796788c6ed6fe507cb6f5`: pusty diff, exit code 0.
Nie jest to terminalna publikacja naukowa ani nowa definicja fizyki;
równania, jednostki i kwalifikacja operatora pozostają własnością noty 0950.

Uzupełnienie dowodu 2026-10-12: launcher również ma pusty diff względem tego
commita. Interpretowany unittest jego admission: 10 testów, 9 zaliczonych,
1 pominięty z powodu braku uprawnienia hosta do symlinków, exit code 0.
Wywołania Docker są mockowane; ten wynik nie dowodzi działającego kontenera,
rzeczywistego preflight pakietu ani pola anteny. Pliki tymczasowe były na D.

Interpretowane `scripts/test_verify_accepted_closed_loop_runtime.py::ClosedLoopVerifierTests`:
18 testów, 17 zaliczonych, 1 pominięty (symlinki), exit code 0.
Sprawdzono negatywy owner/run/stage/attempt/epoch/revision, state-free bundle,
budżet, hashe, rozmiar, fingerprint, prywatny klon oraz ograniczanie logów
małego procesu Pythona. Dwa pliki suite mają pusty diff względem przypiętego commita.
Test overflow zgłosił `ResourceWarning` dla PID 65344, ponieważ obserwacja
jest przerywana bez zabijania procesu; kolejna kontrola `Get-Process` nie
znalazła PID. Nie uznawać samego zielonego unittest za dowód poprawnego
zarządzania wszystkimi procesami rzeczywistego solvera.
