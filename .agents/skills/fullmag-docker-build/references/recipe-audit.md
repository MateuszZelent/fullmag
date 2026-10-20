# Audyt tras `just` i zapisu storage Fullmag

Data audytu: 2026-10-18. Zakres: tylko odczyt worktree wybranego worktree zadania; nie uruchamiano recept, buildów, testów, cleanup ani operacji Git. Raport obejmuje deklaracje `justfile`, globalny wrapper, resolver oraz bezpośrednio wywoływane launchery. Efekty narzędzi zewnętrznych oznaczam jako nieznane, gdy nie wynikają ze źródła.

## Dowód kompletności

Hashe w tym rozdziale zapisują wejścia odczytu bazowego z 18.10.2026; nie są hashami bieżącego HEAD.

- `justfile` ma 7514 linii, 716999 bajtów, SHA256 `5d0c021a54207c282aecfebf0ff663997441f11787400b9ddf77f1af28dace32`.
- Wejścia route wrapperów: `scripts/just_storage_shell.sh` SHA256 `5855ef72b187eb812cb1c8bda9f7c75a2d663a0357b803ad7f54c6e2bbc6cb76`; `scripts/new-problem-verification.just` SHA256 `c4f9b4fb284608cf6043ddf1832151ce91f79dc0c65a3963bad5df60ed98ecda`.
- `just --justfile .../justfile --dump --dump-format json` zakończył się kodem 0; dump zawiera 612 aktywnych recept. Parser źródła wykrywa dodatkowo 1 deklarację platformową `[windows]` (`verify-boris-fullmag-she-nf-windows`, linie 1217–1219), więc 613 deklaracji jest widocznych w pliku, a 612 jest aktywnych w bieżącym środowisku. Pełna lista deklaracji znajduje się w [manifeście TSV](recipe-inventory.tsv).
- Nie ma dyrektyw `import` ani `mod` w `justfile` ani w `scripts/new-problem-verification.just`; drugi plik jest osobnym plikiem just i nie jest automatycznie częścią dumpa.
- Próbka bazowej gałęzi `codex/docker-cpu-startup-20261018` wskazuje commit `dc2bc2698e2c72d254bc8b3edd709c32441825cf`; blob bazowego `justfile` ma SHA256 `04591409a5439a39f47f415557b29cd096380d56ee9db173899da2aa9d658014`. Różnica względem bieżącego pliku ogranicza się do dopisania `gpu_access="auto"` oraz `--gpu-access` w receptach `docker-dev` (linia 32), `docker-dev-recreate` (37) i `docker-dev-build` (46). Obecne argumenty CPU w `windows-build` (389), `windows-test-fem` (403), `build` (440), `run-topological-charge-skyrmion-smoke` (790), receptach relaksacji (1026, 1372), oraz kwalifikacji FEM (1526, 3002) są obecne również w bazowym blobie i nie powinny być przypisywane temu dirty diffowi.
- Tożsamość i dirty status potwierdził agent nadrzędny natywnym Git dla Windows. Odczyt WSL Git nie interpretuje Windowsowego wskaźnika worktree.

## Aktualizacja aktywnej trasy Docker DEV — źródło `9a798d280`

Aktualny hash wrappera scripts/just_storage_shell.sh to
1617d8746b330e01c3ad4fb6fb3f16e71a2ef5450aaf2ca79f42e1656bfe6e1e.
Wartość 5855ef… powyżej należy do historycznego odczytu bazowego.

Powyższy inwentarz justfile jest audytem bazowym z 18.10.2026. Jego wiersze
`Docker dev` i `Docker dev Compose` opisują stan sprzed migracji i nie są opisem
bieżącego HEAD. Dla codziennego `live-shadow-v1` aktualny przegląd źródeł daje:

- jedynym wejściem developerskim pozostaje `just docker-dev-toolchain`, a potem
  `just docker-dev <checkout> <port>`; `just docker-dev-build` jest aliasem
  startu usług (`up`), nie osobnym build-only;
- backend i frontend należą do grupy Compose wybranego checkoutu. Źródła są
  readonly bindami; backend build/package, frontend state/cache oraz control
  receipts/logs mają przypięte wolumeny nazwane; BuildKit/obrazy pozostają po
  stronie Docker Engine;
- hostowy `storage` nadal obsługuje rejestr projektu/worktree, blokady, małe
  wskaźniki/operatorowe receipty, run evidence i host-ledger oraz dane
  użytkownika. To nie jest miejsce na Cargo/CMake/pnpm/Next, staging, konteksty,
  pakiety ani logi buildu;
- `docker-all-*`, runner/frozen/release oraz natywne `just`-recepty są osobnymi
  trasami, nie domyślnym DEV i nie fallbackiem dla tej grupy;
- brak automatycznego GC wolumenów i BuildKit oraz brak quota pozostają luką
  retencji. Usunięcie kontenera nie usuwa nazwanych wolumenów ani warstw/cache.
  Cold build, start, inspect mountów, cache-hit po restarcie i HMR pozostają
  `NOT VERIFIED` bez dowodu z Docker Desktop.

Aktualny `justfile` ma 7516 linii, 717145 bajtów i SHA256
`d52763ba8ac9e8e0daa63d3c4c61ed8fe53794866195044b863454495c44ee2d`.
Zapisany wyżej hash `5d0c021a…` i rozmiar 7514/716999 opisują bazowy odczyt,
nie obecny plik. Od źródła `69bfd1c44` doszły dwie linie komentarza
oznaczające `docker-all-*` jako legacy; nie zmieniły recept. Bieżący dump
`just --dump --dump-format json` nadal wykazuje 612 aktywnych recept.

Tabela i hash justfile poniżej zachowują odtwarzalność pierwotnego audytu
wszystkich 612 aktywnych recept. Przed użyciem innych rodzin niż codzienny DEV
sprawdź ich bieżące źródła i platformową trasę; to PR nie migruje ich writerów.

## Delta tras codegen — odczyt 19.10.2026

Odczytowy `just --justfile justfile --dump --dump-format json` zwrócił kod 0
oraz **614 aktywnych recept**. Nie uruchamiał ich ciał. Historyczny manifest TSV
powyżej pozostaje bazą z 18.10; nie przedstawiaj jego 612 nazw jako bieżącego dumpa.

- `justfile`: 7523 linie, 717681 bajtów, SHA256
  `4d09df29dc01e54cd48130fb7f152155378a23b0b497c73f6ef3fc6b866b54e8`.
- `scripts/just_storage_shell.sh`: 883 linie, 60947 bajtów, SHA256
  `090a3cefec756f03fbf72548feec8d2b9f846161f94af8bde23c51abbf277e9c`.
- Doszły `docker-dev-codegen` i `generate-api-openapi-legacy`;
  `generate-api-openapi` zmienił trasę. Ta delta nie kwalifikuje pozostałych rodzin.

| Recepta | Trasa i granica zapisu |
| --- | --- |
| `docker-dev-codegen <source>` | `docker_dev.py codegen-openapi` → `docker_dev_codegen.py`; wymaga już działających stałych usług wybranej grupy. Eksportuje OpenAPI z istniejącej binarki backendu i uruchamia generatory w istniejącym frontendzie. Nie buduje, nie restartuje ani nie tworzy kontenerów. |
| `generate-api-openapi <source>` | Alias tej samej trasy codziennego DEV, z jawnym checkoutem. Wrapper przekazuje samo `source_root`, bez prefiksu argumentu. |
| `generate-api-openapi-legacy` | Zachowana odrębna trasa release/CI przez `verify_session_persistence.py`; nie jest fallbackiem DEV ani trasą volume-only. |

Codegen zapisuje staging w wolumenie frontendu, a techniczny receipt pod
`/opt/fullmag/control/backend/codegen/openapi-v2/`. Na hoście publikuje tylko
cztery wersjonowane źródła w `apps/control-room/src/kernel/api/generated/`:
`openapi-v2.json`, `openapi-v2-types.ts`, `openapi-v2-client.ts` i
`openapi-v2-paths.ts`. To zamierzona zmiana kodu, bez hostowego cache/logu buildu.
Sprawdza obraz, mounty, provenance binarki i zmianę źródeł przed publikacją;
zmiana checkoutu lub niedostępna usługa zamyka trasę zamiast uruchamiać inną.

Dowody tego etapu: 15 lekkich testów Pythona codegen zaliczonych, w tym
wykonywalny test wrappera z wybraną ścieżką zawierającą spację. Rzeczywiste
wykonanie codegen w obu usługach pozostaje **NOT VERIFIED** do ich startu.

## Integracja mastera PR #198 — bieżąca delta tras

Po scaleniu źródeł `b48b2934df60b074d00fce7b01ea040180505ad4` odczytowy
`just --dump --dump-format json` daje **620 aktywnych recept**. Delta 614
powyżej opisuje stan sprzed tej integracji, a TSV nadal dokumentuje bazę.

- `justfile`: 7546 linii, 720070 bajtów, SHA256 `baffe84779a79109dc6030ebb8ea55137034cd150e96dfbf8996915033ede2be`.
- `scripts/just_storage_shell.sh`: 908 linii, 63438 bajtów, SHA256 `d034b607528372d6ec881a70837235bb5ef6e7c4e99b240ee1e592e9c31846d3`.

Dołączyły `docker-dev-images`, `docker-dev-stop-failed`,
`docker-dev-control-checks`, `docker-dev-resume`, `docker-dev-restart-idle`
i `docker-dev-recreate-volume`. `docker_dev.py up` korzysta teraz z
`docker_volume_dev.py`, a toolchain/helper images z `docker_build_control.py`.
Receipty, konfiguracje i logi tej trasy są w build-control volume; wejście
recreate przez hostowy receipt DEV jest wycofane. Wrapper zachowuje fixed-argv
oraz nowe piny `attempt`/`config_sha256`; nie wykonuje dopasowanego tekstu
komendy jako dowolnej powłoki. Dziewięć lekkich testów granicy shell PASS.

Stosuj [przewodnik bieżących komend](../../../../docs/guides/docker-volume-development.md).
Opis `_backend_start_inputs`, hostowego wskaźnika runu i frontend-cache-v2
we wcześniejszych sekcjach jest historią poprzedniego launchera, nie mapą
writerów nowego `docker_volume_dev.start`. Sam merge i dump nie kwalifikują
runtime, HMR, restartu ani wykonania solvera.

## Delta aktywacji skryptu — 19.10.2026

Bieżący dump parsera ma **621 aktywnych recept**. Dodatkowa `docker-dev-script`
wykonuje stały wrapper w istniejącym backendzie, bez Compose lifecycle,
nowego kontenera aplikacji i przebudowy. Źródła są czytane z readonly bindu;
autoryzacja i receipty pozostają w control volume. Piny oryginalnej próby
mogą mieć powiązany, trwale zweryfikowany sukces resume/iteration. Wynik
unknown nie jest automatycznie ponawiany. Aktywacja ładuje zweryfikowane
bajty helpera wybranego worktree, również gdy launcher pochodzi z głównego
checkoutu. Weryfikacja źródeł: 12 lekkich regresji aktywacji i 6 granicy argv
PASS; runtime **NOT VERIFIED**.

- `justfile`: 7550 linii, 720560 bajtów, SHA256 `c96cc146411e61b4f5fa53399a9f849c76a775e4ccc6ca9b93f8ffaa17bb7f0f`.
- `scripts/just_storage_shell.sh`: 913 linii, 64054 bajty, SHA256 `49d4ec057e09fb9d0efc9cdcb0939bddeaf12f4aad105b08c5947a67eb2114b2`.

Powyższe wcześniejsze delty pozostają historycznymi checkpointami. Nie
przekwalifikowują pozostałych recept ani nie zmieniają bazowego manifestu TSV.

## Granica wspólna dla recept

Od tego miejsca szczegółowy inwentarz rodzin i numery linii opisują audyt bazowy, nie bieżącą trasę Docker DEV. Aktualna trasa jest opisana wyżej; historyczne wiersze Docker dev i Docker dev Compose niżej zachowują dowód wcześniejszych writerów i nie są instrukcją uruchamiania.

`justfile:1-6` ustawia `bash scripts/just_storage_shell.sh` jako shell. Wrapper ma jawne dispatch dla bootstrapu/Docker dev (`scripts/just_storage_shell.sh:115-160`), legacy runtime (`187-201`), Windows (`228-247`), Control Room/OpenAPI (`249-280`), runnera/benchmarków (`409-470`) oraz helperów (`474-802`). Wyjątki od inicjalizacji storage są ograniczone do odczytów/list (`386-399`).

Każda inna recepta przechodzi przez fallback (`scripts/just_storage_shell.sh:825-849`): wrapper uruchamia `fullmag_storage.py prepare-links --compat` (oraz `--frontend` dla ścieżek frontendowych), a następnie `fullmag_storage.py run` wokół ciała recepty. To samo dotyczy recept pozornie read-only, więc sam brak `mkdir` w ciele nie dowodzi braku zapisu hostowego. Guard blokuje tylko literalne prefiksy `/tmp/fullmag-`, `/tmp/fullmag/` i `native/build` (`815-823`); nie blokuje ogólnie `.fullmag/reports`, `apps/control-room/.next/dev`, `/mnt` ani arbitralnych ścieżek Compose.

`scripts/fullmag_storage.py:325-420` rozwiązuje project root, storage root i build storage; `440-467` eksportuje CARGO/PNPM/npm/pip/uv/CUDA/Playwright/TMPDIR; `560-590` inicjalizuje markery, index, locki i katalogi; `700-720` zapisuje link registry; `840-860` zapisuje lock właściciela; `995-1157` zapisuje statusy buildów, logi i receipty. Fallback wrappera oraz te funkcje są więc wspólnym hostowym route/storage writerem.

## Mapa rodzin i tras

| rodzina | recepty i źródło | trasa wejściowa | zapisy / ryzyko |
|---|---|---|---|
| Docker dev (historyczny stan bazowy) | `justfile:27-46`; `scripts/docker_dev.py` | `docker-dev-toolchain`, `docker-dev`, `docker-dev-recreate`, `docker-dev-recover-orphan`, `docker-dev-build` | Bootstrap tworzy hostowy kontekst/receipt (`bootstrap_docker_toolchain.py:223-332`). Docker dev tworzy hostowe `development-base-context` (`docker_dev.py:442-469`), image receipt/log (`729-806`, `1195-1231`), run root (`877-887`, `1918-2001`, `2094-2108`) oraz state/provenance/input binds. `docker-dev-build` wywołuje `up` (`2146-2160`), więc nie jest build-only. Bezpośrednie cache backendu są named volumes, ale overlay maintenance i receipty są hostowe (`1235-1320`).
| Docker dev Compose (historyczny stan bazowy) | `compose.dev.yaml:15-50,81-116,130-194`; `frontend_dev.py:61-78,736-746,867-885,1117-1185` | backend/frontend stałej grupy | Backend ma named volumes `backend-cache-build` i `backend-cache-package`, lecz w historycznym stanie provenance (`compose.dev.yaml:93-100`) i frontend state/cache/log (`155-168`; `frontend_dev.py:1117-1185`) były bind-mountami hostowymi — był to gap względem kontraktu Docker-volume-only.
| legacy all-Docker | `justfile:50-79`; `scripts/fullmag_docker_runtime.py:791-1036` | `docker-all-build`, `docker-all-image`, `docker-all-start`, `docker-all-dev`, `docker-all-dev-backend-build`, `docker-all-dev-image`, `docker-all-verify`, `docker-all-toolchain-bootstrap` | Osobna ścieżka kopiuje source capsule do `runs_root/<capture>/source`, tworzy kontekst, stage, provenance, image-id, logi i receipty (`791-957`, `961-1036`). Dubluje dzisiejszy `docker-dev`, ma odrębne project/group semantics i używa bezpośrednich operacji Docker.
| runner/obrazy | `justfile:137-290`; wrapper `409-470` | `runner-image`, `runner-build-image`, `runner-coordinator-image`, `runner-coordinator-base`, `runner-coordinator-context`, frozen/BORIS image/build, `runner-*` lifecycle | `runner-image:137` i `runner-build-image:140` uruchamiają raw `docker build`; koordynator ma własne context/image/cache/log/retention. Nie jest to gwarantowana grupa `fullmag-master`/`fullmag-worktree-*`. Stop/cancel/retention/reconcile są operacjami cleanup lub state mutation.
| Windows/native | `justfile:301-408`; `scripts/windows/run_fullmag.ps1:231-233,393-430,800-874,924-944` | setup/doctor/UI/workspace build/recover/backend-dev/archive/windows-build/windows-test-fem i Windows verify | Hostowe rooty build/cache/target, frontend staging i CARGO/FFM; odrębna ścieżka względem Compose volumes. Wymaga jawnego oznaczenia jako Windows-host route, nie dowodzi Docker dev.
| Python/Make/desktop/package | `justfile:410-483` | `ensure-python`, `build`, `build-static-control-room`, `build-desktop*`, `package-installer*`, `package` | `ensure-python` instaluje do `.fullmag/local/python` (410-433). `build-desktop:446-449` uruchamia hostowe cargo i kopiuje binaria; warianty Docker/package mają osobne Compose lub export paths (451-483). To kilka równoległych packaging routes.
| API/client generation | `justfile:604-636`; wrapper `249-280` | `generate-api-openapi`, `export-runner-openapi(-snapshot)`, `generate-control-room-client`, source/typecheck/import/hygiene checks | Generatory zmieniają artefakty checkoutu i/lub `.fullmag`; wrapper zapisuje provenance/links. Są odrębną kategorią source generation, nie buildem obrazu.
| FDM/FEM/native contract | `justfile:936-2254` | `verify-*`, `repair-managed-native-cmake-build-tool`, GPU/CUDA/CPU/mixed/native ABI/transaction/relaxation routes | Ciała zawierają 101 `cmake`, 82 `cargo`, 206 `docker compose` (liczby markerów tekstowych dla 612 recept). Są routes container-backed tylko tam, gdzie konkretna recepta rzeczywiście przypina właściwy Compose/project; większość należy oznaczyć `NOT VERIFIED` bez wykonania. `rm -rf` i raporty występują w wielu ciałach.
| FEM frequency/static/PBC | `justfile:2391-5722` | frequency-domain, periodic/airbox, relaxation, static PBC, fixture/report/performance/qualification families | Duże rodziny wywołują Compose/cmake/cargo, tworzą fixture/report/artifact w `.fullmag/reports`, `apps/control-room/.next/dev` lub `/mnt`; helper effects and external solvers remain unknown unless source shows them. Nie należy nazywać ich jedną trasą cache.
| browser/runtime | `justfile:5740-6416` | `control-room*`, `run*`, `run-headless*`, browser/WebGL smoke/replay and authoring gates | Fallback wrapper przygotowuje links/storage nawet dla verify. `control-room-stop:5750` mutuje runtime. Browser proof and host logs are separate from build proof.
| managed FEM runtime | `justfile:6477-7347`; `scripts/export_fem_gpu_runtime.sh:481-505,1281-1301` | variant select/restore/migrate/backup, `ensure-managed-fem-runtime`, prune, provenance, headless, rebuild, Nsight, Hypre variants | `ensure-managed-fem-runtime:6572-6634` może wywołać `rebuild-fem-runtime:7271`; exporter bind-mountuje source snapshot i target, a CARGO_HOME/log/staging zapisuje na hostowym target. `prune-managed-fem-runtimes:6636-6643` ma dry-run `apply=0`; `apply=1` usuwa. Są jawne runtime swap/backup routes.
| końcowe production routes | `justfile:7451-7514` | racetrack/current solved production and final GPU checks | Bezpośrednie Compose/cmake/cargo, hardcoded native roots (`/mnt/fullmag-zfn2-native`, `/zfn2`) i raporty; trzeba oznaczyć bypass/NOT VERIFIED dla unified launcher.

## Najważniejsze znane bypassy i duplikacje

- `justfile:137-145` raw Docker runner images; `440-483` host cargo/Make oraz równoległe Docker packaging; `936-945`, `1177-1222`, `2018-2129`, `2391-2505`, `2537-4325`, `4504-4716`, `7125-7130`, `7451-7514` bezpośrednio zawierają Compose/cmake/cargo i wymagają per-recipe project/source/storage audit.
- Występują hardcoded `/mnt/fullmag-zfn2-native` i `/zfn2` (`1195-1204`, `1600-1700`, `1862-1916`, `7451-7514`) oraz bezpośrednie zapisy report/artifact (`617-618`, `1330-1338`, `3146-3149`, `4687-4716`, `5096-5115`).
- Statyczne markery: `docker compose` 206 recept, `cmake` 101, `cargo ` 82, `just build` 35, `ensure-managed-fem-runtime` 121, `ensure-python` 69, pnpm/npm/corepack 13, raw `docker build` 1, raw `docker run` 1. To są markery ciał, nie dowody wykonania ani kwalifikacji.
- Recepty `verify-*` i `run-*` są mieszaniną kontraktów źródłowych, buildów, runtime, browser, benchmarków i generatorów. Sam prefiks nie może wyznaczać polityki cache; manifest TSV daje punkt wyjścia do jawnego routingu.

## Cleanup i retencja

Nie znaleziono `docker system prune` ani `docker volume prune` w `justfile`. Znaleziono natomiast operacje usuwania i retencji: `runner-container-stop:167`, `runner-cancel:200`, retention plan/preview/get/apply `275-284`, replace `287`, reconcile `290`, `control-room-stop:5750`, runtime select/restore/migrate/backup `6495-6549`, `prune-managed-fem-runtimes:6636-6643` oraz wiele `rm -rf` (m.in. `1458`, `1510`, `1531`, `1941-1996`, `2320`, `2462`, `2539-4325`, `4399-4650`, `5570-5638`, `6175-6203`, `6442`, `6579`, `7464`). Żadnej z tych tras nie uruchamiano. Globalny guard nie chroni wszystkich tych celów; skill powinien wymagać rozpoznania owner/process/container/mount/lease i wyłączyć nieautoryzowane usuwanie volumes/build-volumes.

## Zalecenia dla `.agents/skills/fullmag-docker-build`

1. Traktować manifest TSV jako manifest wejściowy i dodać drift check oparty o `just --justfile <path> --dump --dump-format json`; porównywać 612 aktywnych nazw oraz 613 deklaracji głównego pliku, a osobno 2 deklaracje pomocniczego pliku (615 łącznie); zachować platform gating i hashe obu plików.
2. Wymagać tabeli route contract dla każdej nowej recepty: source-root, Compose project/group, storage resolver/profile, host-write allowlist, named volumes, receipt/provenance, cleanup class, runtime/browser boundary.
3. Oznaczyć `docker-dev*` jako jedyną ścieżkę codziennego developmentu dopiero po usunięciu lub opasaniu hostowych context/receipt/provenance/frontend-state writes; `docker-dev-build` nazwać właściwie albo rozdzielić start od build.
4. Odrębnie oznaczyć legacy `docker-all*`, runner, Windows/native, exporter/managed-FEM i package/desktop jako non-default routes; żadna nie może być uznana za zgodną tylko dlatego, że wywołuje Docker.
5. W wrapperze rozszerzyć ochronę celu i logowanie decyzji: literalny `/tmp` guard jest za wąski; każdy hostowy writer powinien przejść przez resolver/receipt, a bez niego route ma status `NOT VERIFIED`.
6. Utrzymywać allowlistę cleanup z osobną autoryzacją dokładnych build volumes oraz domyślnym dry-run; `rm -rf`, retention, runtime swap i `/mnt` outputs muszą mieć osobne klasy oraz preflight aktywnych procesów/mountów.
7. Raportować osobno source/static, managed runtime, browser/WebGL, solver/physics i release evidence; `just` exit 0 ani AST dump nie dowodzi żadnej z tych bramek.

## Drift check i ograniczenia

Minimalny odczytowy check: `just --justfile <checkout>/justfile --dump --dump-format json`, następnie odczyt `.recipes` i porównanie nazw/hash z tym raportem. Nie uruchamiać recept w ramach drift check. Pełna ścieżka efektów zewnętrznych pozostaje nieznana bez czytania/uruchamiania każdego helpera, Dockera i skryptu powłoki; wnioski powyżej dotyczą statycznie widocznych writerów i tras.


## Dodatkowy plik just

`scripts/new-problem-verification.just` zawiera dwie odrębne recepty:
`verify-new-problem-browser` i `generate-new-problem-client`. Nie dziedziczy
globalnego shell wrappera głównego `justfile`. Obie wywołują
`scripts/verify_new_problem_browser.py` (druga z `--generate-client`).
Helper tworzy snapshot aplikacji, katalog output, linki Next/node_modules,
logi procesów oraz katalogi browser/screenshots pod run root
(`:225-267`, `:324-396`, `:527-564`). To trasa kwalifikacji/generacji
z zapisami hostowymi, a nie volume-only DEV. Należy odróżnić celowo
wersjonowane wygenerowane źródła API od odtwarzalnego output/cache.

Manifest obejmuje 612 aktywnych deklaracji głównego pliku, jedną Windows-only
i dwie deklaracje dodatkowego pliku (615 łącznie). Klasyfikacja rodzin jest
orientacyjna; nie stanowi dowodu efektów wszystkich zależnych programów.
Zmiana wrappera/resolvera może zmienić zapisy każdej recepty bez zmiany jej ciała.

## Delta wdrożenia volume DEV

Powyższy manifest i numery linii opisują stan bazowy. Po wdrożeniu migracji
dump checkpointu `e56d6828d59c216225245808a0c03f081f56b4c3` zawiera **619** aktywnych recept.
Nie wykonano wszystkich recept; kwalifikacja runtime dotyczy jawnie opisanych
prób DEV. Nie przenoś wyniku na release, CI, benchmarki ani kwalifikację naukową.

Wejścia tego checkpointu, sprzed integracji mastera `fc50a43efa6a19ed10e03e1f9a0060809014605f`:

- `justfile`: `4d6b20206f98c0fc79915c811899febe7c70da608ba88c83e71a6d94e26a39c0`;
- `scripts/just_storage_shell.sh`: `2aaef57f7cded6b4d293212cc313cc35b703dc6b1174d0eefa7b546decad9395`.

Nowe/zmienione wejścia DEV: `docker-dev-toolchain`, `docker-dev-images`,
`docker-dev`, `docker-dev-build`, `docker-dev-control-checks`, `docker-dev-resume`,
`docker-dev-recreate-volume`, `docker-dev-restart-idle`, `docker-dev-stop-failed`.

W zadaniu mixed-P1 dodano `docker-dev-stop-unadmitted`: wąskie zatrzymanie
zewnętrznie odrzuconego startupu przed przyjęciem RunIntent. Wrapper przekazuje
wyłącznie jawnie przypięte identyfikatory do `docker_dev.py stop-unadmitted`,
bez hostowego `storage.run`. Dowody i journal trafiają do control volume;
cache i dane użytkownika pozostają zachowane. Nowa recepta wymaga oddzielnego
dowodu rzeczywistego graceful stopu; samo dodanie wpisu jej nie kwalifikuje.
Bootstrap uruchamia `docker_build_control`; aplikacja używa `docker_volume_dev`.
Wrapper przekazuje te ścisłe wzorce bez hostowego `storage.run`. Starszy
`docker-dev-recreate` odmawia przed inicjalizacją hostowego logu/kontekstu.

Przegląd diffu wrappera: nowe gałęzie dotyczą tylko wskazanych wejść; istniejący
fallback i gałęzie innych rodzin nie zmieniły zachowania. Zmiana wspólnego pliku
nie kwalifikuje pozostałych recept jako volume-only. Ich ograniczenia z audytu
bazowego pozostają aktualne do osobnej weryfikacji.

Dokładny format operacji i granic zapisu opisuje
[przewodnik DEV](../../../../docs/guides/docker-volume-development.md).
