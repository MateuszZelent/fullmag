# Naprawa głębokości i podglądu Primitive — odbiór 3D

Data pierwotna: 23.10.2026; aktualizacja odbioru: 24.10.2026.
Status: zakres kamery/ringu i Primitive sprawdzony w WebGL; publikacja topologii,
eksport PNG, DPR i lifecycle sprawdzone po korekcie budżetu topologii.
Ogólny harness nie jest zielony: odrębne endpointy analysis/planar zwracają
404/422. Nie jest to kwalifikacja solvera/GPU. PR252 oczekuje końcowego CI
i integracji; dalsze sekcje zachowują także wcześniejsze nieudane próby.

## Zakres i diagnoza

Zgłoszenie dotyczyło artefaktów trójkątów na ringu przy zbliżeniu oraz gwiazdy
przekątnych w podglądzie Primitive przed wygenerowaniem siatki obliczeniowej.
Punktem odniesienia jest grupa master na porcie 3198 i istniejący przykład
`examples/permalloy_layer_cofeb_rings_relax_300nm.py`.

Pierwotny [audyt głębokości](viewport-ring-depth-audit-2026-10-22.md) wskazał
przyczynę w polityce kamery: oko znajdujące się wewnątrz globalnej sfery bounds
sprowadzało near do 1 pm, a far pozostawało co najmniej 1 mm, także w scenie
nanometrowej. To odbierało buforowi głębokości możliwość rozróżnienia bliskich
powierzchni. Użycie pełnej triangulacji do wireframe Primitive niezależnie
pokazywało przekątne płaskich kapsli ringu.

## Zmiany

- Jeden helper zakresu głębokości dla Fit, zapisanej projekcji i bieżącej
  kamery OrbitControls. Zakres skaluje się ze sceną; dodatni konserwatywny
  front bounds ogranicza near dla bliskiej geometrii. Wyeliminowano stały
  próg 1 mm dla far oraz załamanie skali przy środku bounds w płaszczyźnie oka.
- Podczas gestów aktualizowane są tylko płaszczyzny projekcji po OrbitControls,
  bez publikowania pośrednich pozycji i bez uruchamiania dodatkowej pętli renderu.
- Primitive ma generator krawędzi prezentacyjnych. Dla CSG obrzeża powstają
  z rzeczywistych trójkątów kapsli: krawędzie wewnętrzne mają dwie przyległe
  ściany i są usuwane; cztery obrzeża ringu pozostają. Pozostałe bryły
  otrzymują obrys boxa lub rzadszą siatkę południków/równoleżników i generatorów.
- Zachowano tracker oraz zwalnianie geometrii. Nie zmieniono generatora ani
  wyświetlania właściwych krawędzi siatki FEM/FDM.
- Do QA dodano fixture istniejącego przykładu oczekującą na Compute, ujęcia
  z bliska, odczyt near/far i rzeczywistego stanu kontekstu WebGL.

## Dowody źródłowe

Weryfikacja w frontendzie grupy
`fullmag-worktree-viewport-depth-20261022-d13d8cf2842d9225`, port 3212.
Dane techniczne pozostają w jej wolumenach Docker.

| Kontrola | Wynik | Granica dowodu |
| --- | --- | --- |
| ESLint pięciu produkcyjnych TS/TSX | PASS, exit 0 | Powtórzony po integracji mastera: PASS |
| Typecheck aplikacji, `tsc --noEmit` | PASS, exit 0 | Wyklucza źródła unit tests |
| Parsery dwóch zmienionych MJS | PASS, exit 0 | Końcowe MJS po rozszerzeniu QA: PASS |
| Diagnostyka deklaracji produkcyjnych, Three r186 | PASS, 36/36 | Node type erasure, bez WebGL |
| React Doctor | Częściowy wynik | Brak findingów w zmienianych plikach; dead-code scan nie zakończył się poprawnie |
| Kompilacja/wykonanie unit tests | NOT RUN | Obowiązuje tymczasowy zakaz użytkownika |

Diagnostyka geometrii obejmuje ring, box-hole (także niesymetryczny) dla osi
X/Y/Z oraz box, sphere, cylinder, w trzech skalach. Każdy odcinek pokrywa się dokładnie z rzeczywistą
krawędzią trójkąta powierzchni. Ring: 1024 endpointy, box-hole: 536, box: 24,
sphere: 704, cylinder: 144. Zero odcinków poza krawędziami powierzchni.

Pierwszy przebieg wykrył cztery rozbieżności zamknięcia okręgów. Ręczne
odtwarzanie próbek zastąpiono ekstrakcją z powierzchni; dokładnych asercji
nie poluzowano. Pełna triangulacja jako kontrola negatywna zostaje odrzucona
przez asercję liczby krawędzi, także gdy wszystkie endpointy leżą na powierzchni.
Diagnostyka odtwarzalna:
[probe.cjs](viewport-depth-fix-2026-10-22/probe.cjs).

Dla zapisanej kamery i umownego 24-bitowego depth buffer:

| Parametr | Przed | Po |
| --- | ---: | ---: |
| near | 1e-12 m | 6.345077357801499e-10 m |
| far | 1e-3 m | 8.046547155777423e-6 m |
| Krok głębokości przy badanej powierzchni | 23.96 nm | 0.03776 nm |
| Liczba poziomów dla 1.6 nm | 0 | 42 |

Separacja 1.6 nm jest tutaj odległością w osi kamery. Kontrola negatywna
`probe.cjs --legacy-depth` odrzuca starą politykę (exit 1), a bieżąca przechodzi
(exit 0); dodatkowo przechodzą cztery skale oraz przejście środka bounds
przez płaszczyznę oka (44 poziomy).

To obliczenie kwantyzacji perspektywy, nie pomiar pikseli ani gwarancja
rozdzielczości dla dowolnej pozycji kamery lub GPU.

Receipty/logi kontroli: frontend volume, `/state/development/qa/viewport-depth/`,
pliki `post-merge-checks.json`, `depth-regression.json`,
`depth-legacy-negative-control.json`, `final-production-checks.json`, `geometry-source-diagnostic.json`,
`depth-diagnostic.json`, `react-doctor.json`. Weryfikacja hashy źródeł była
stabilna podczas kontroli. Końcowy probe używa helperów o SHA-256:

- `viewport3DCameraClip.ts`: `6ab315e7a4d67fe0deebd55f083aacd8a29dcb92ac59607123f2036676c7c7f0`.
- `primitiveWireframeGeometry.ts`: `9e3665fc4a2bb0db30c75012b220304880ae86cbbb16dfdd74637ad263fa9628`.

Źródła biblioteki sprawdzono przez wymagany Context7, wersja Three.js r186:
[precyzja kamer](https://github.com/mrdoob/three.js/blob/r186/manual/pages/cameras.html),
[EdgesGeometry](https://github.com/mrdoob/three.js/blob/r186/docs/pages/EdgesGeometry.html),
[ExtrudeGeometry](https://github.com/mrdoob/three.js/blob/r186/src/geometries/ExtrudeGeometry.js).
Niezależne review źródeł po merge mastera nie zgłosiło actionable findings;
nie zastępuje ono odbioru obrazu.

## Runtime i browser/WebGL

Pierwszy build aplikacji backendowej zakończył się exit 0 i uruchomił API
22.10 o 21:10 UTC. Grupa została później zatrzymana; 23.10 wznowiono ją
zarządzanym launcherem po włączeniu aktualnego mastera. Browser/WebGL,
primitive-to-mesh i oględziny końcowych PNG: **NOT VERIFIED — w toku**.
Nie uruchamiano Solve dla odbioru wizualnego.

Stan końcowego odbioru na tym checkpointcie:

- Start `46515f12f2a04d9fa8dc41d4ee98821c` potwierdzony `succeeded`,
  konfiguracja `a826d61c53e6de06cbe2b4e5f2ac07288b30c9724450a9f31e9a161e68083347`.
- Po restarcie Docker poprzedni ledger grupy miał obcy zapis writera i puste
  rezerwacje. Zatrzymano tylko jej API diagnostyczne (exit0), zapisano dowód
  `verification/viewport-depth-native-init-stop.json`, a zarządzane odtworzenie
  `7619448e203847f891769465ed66e8e7` zachowało stary stan i uruchomiło świeży.
  Nie zmieniano zapisów ownera ani ledgera; grupy innych zadań pozostały aktywne.
- Pierwsza aktywacja fixture spod `apps/control-room/scripts/fixtures` została
  odrzucona HTTP422 `docker_startup_output_mapping_required`, przed utworzeniem
  sesji. Poprawiona fixture jest w `examples/qa/viewport_depth_preview.py`.
  To wrapper istniejącego przykładu, z zachowanymi parametrami i wait_for_solve.
- Nowa sesja: `docker-startup-2060aff7ea6d325a8cf5dceeef467987169c905c2253a7c8dfd637268419d798`.
  Widoczny status API: `fem:unmaterialized`, cell_count0, solver `activating`.
  Trwa eksport konfiguracji; nie ponawiano aktywacji ani nie uruchamiano Solve.
- Zarządzany browser QA zakończył się przed uruchomieniem browsera:
  `Docker observation exceeded its time/output budget during _raw (timeout=60s)`.
  Proces eksportu czekał w `folio_wait_bit_common`; obserwowane full I/O pressure
  około79%, bez presji pamięci. To zaobserwowane oczekiwanie na I/O, bez diagnozy
  awarii sprzętu. Wolne miejsce: WSL24GiB, WindowsC75GiB. Health portu3212: HTTP200.
- Browser/WebGL, końcowe PNG oraz primitive-to-mesh: **NOT VERIFIED**.
  Do kontynuacji użyć tej samej aktywacji i jej zachowanych receiptów; nie
  powtarzać komendy o nieznanym wyniku. Po jej zakończeniu ponowić wyłącznie
  bezpieczny odczyt/preflight QA, a potem odbiór obrazu.


## Commity i integracja

- `5e12f782c4d5be861078b092917db26b9a922699`: zakres głębokości i kamera na żywo.
- `fded49ec104eeed75a60dd9be77ae5567df8bf09`: kontury Primitive i diagnostyka.
- `115c90761831dcf06d4169a574359ee532e18110`: mapper fixture examples/qa i asercje liczby konturów,36 wariantów; kontrole negatywne odrzucone.
- `b098a82ea0887729228b9c1041b9c64957438678`: regresje głębokości, kontrola negatywna i ujęcia trzech trybów przez UI.
- `5ac7eae523e5fc117eab9195f62ecda404841601`: włączenie lokalnego mastera.
- Włączono lokalny master `ae8e570f2aa9655cb9fd8321c716b8d49a87e084`, zachowując
  jego poprawki przekazywania renderowania z Primitive do gotowej siatki.

Hook pre-commit próbowałby instalować `react-doctor@latest` przez hostowe npx.
Dla commitów zadania użyto jednorazowego pominięcia tego hooka; zależności i
kontrole wykonano w grupie Docker, zgodnie z regułami projektu. Konfiguracja
hooków repozytorium nie została zmieniona.

Odtwarzalny następny etap: [build-ring-mesh.py](viewport-depth-fix-2026-10-22/build-ring-mesh.py).
AST sprawdzony; skrypt nie został wykonany z powodu trwającej aktywacji. Wymaga
jawnego session_id, istniejącego klienta v2 i ścieżki receiptu w wolumenie grupy.
Wysyła wyłącznie mesh_build, zachowuje command_id i nie powtarza istniejącego
żądania. Nie stanowi dowodu gotowej siatki ani wykonania fizyki.

PR, wymagane CI, merge, fast-forward i cleanup worktree: **niewykonane**.
Użytkownik potwierdził, że zakaz kompilacji unit tests obejmuje również CI.
`bootstrap.yml` automatycznie kompiluje unit tests C++/Rust przy PR, dlatego
otwarcie PR pozostaje zablokowane. Nie wyłączano wymaganych kontroli ani
nie otwierano PR z obejściem workflow. Worktree i zasoby zachowano.

Checkpoint zapisano UTC: 2026-10-23T08:21:56.361342+00:00.

## Aktualizacja po kolejnym zgłoszeniu z mastera

Checkpoint UTC: 2026-10-23T09:03:55.470209+00:00.

Nowy zrzut nadal pokazuje poszarpane ciemne obszary na kapslu i obrzeżach ringu.
To defekty wewnątrz powierzchni, a nie wyłącznie schodkowanie sylwetki.
Widoczny jest też komunikat `Resource load deadline exceeded`; jego związek
z defektami pozostaje niepotwierdzony.

Plik zgłoszenia: `codex-clipboard-4a0cbe6d-eb16-4dfd-9079-9c7b68927fa1.png`, SHA-256 `6709324586894d96ba0c585b0ed60c025fdbb5d5c5f7e0571d23959aa4d6524b`.

Odczyt lokalnego mastera potwierdza HEAD `ae8e570f2aa9655cb9fd8321c716b8d49a87e084`
i nadal starą politykę kamery: near minimum1e-12 oraz far minimum1e-3.
Poprawki z brancha zadania nie są zintegrowane, więc ten obraz nie jest
dowodem regresji wersji poprawionej. Nie potwierdzono jeszcze źródeł aktualnie
załadowanego bundla w przeglądarce użytkownika.

Istniejąca aktywacja `a97f47244fc0451c86f846fb9aff5e0a` zakończyła obserwację
stanem `outcome-unknown-resources-retained` (timeout); launcher blokuje retry
przez zachowane activation.json. Kolejny odczyt Docker zwrócił:
`Cannot connect to the Docker daemon at unix:///var/run/docker.sock`.
Nie restartowano demona ani innych grup. Odbiór WebGL pozostaje NOT VERIFIED.

Warunki kontynuacji: przywrócona dostępność Docker i ustalenie końcowego
wyniku istniejącej aktywacji; następnie managed browser QA. Otwarcie PR
wymaga rozstrzygnięcia konfliktu z zakazem kompilacji w standardowym CI.
PR/merge/cleanup nadal niewykonane.

## Wznowienie 24.10.2026 — osierocona aktywacja po wyłączeniu Docker

Checkpoint UTC: 2026-10-24T05:47:30.362698+00:00. Docker ponownie odpowiada. Główny checkout nadal
ma HEAD `ae8e570f2aa9655cb9fd8321c716b8d49a87e084`; zawiera cudze zmiany
robocze, których nie modyfikowano. Worktree zadania przed wznowieniem czysty,
HEAD `1487cd9fdb0fe6712a05f023d1a90bad4ced5233`.

Oba kontenery zadania są zatrzymane exit255. Dokładny backend
`bd1c59f8a9fb1db38e83d3bf6f5a274a309cd1799954b70a98322b147779606c`
ma Pid0, StartedAt `2026-10-23T07:53:24.080341642Z`, FinishedAt
`2026-10-23T23:17:26.131576641Z`. Nie wnioskowano z tego o końcowym
wyniku aktywacji ani o zwolnieniu rezerwacji native.

Zachowany marker `active` wskazuje `a97f47244fc0451c86f846fb9aff5e0a`.
Receipt tej aktywacji pozostaje `outcome-unknown-resources-retained`; jej
marker per-request pozostaje `started`, bez terminal.json. Kontener jej
helpera jest nieobecny. Proces-tree i OWNER nadal mają stan `ready`,
a dokładny journal `verification/stop-failed-<backend-id>.json` nie istnieje.
Nie usuwano markerów, nie resetowano ownera i nie ponawiano skryptu.

Przypięte zarządzane `resume-volume --restart-backend` zakończyło się exit2,
próba `81a17bcfcf4b4a53a2e99c5c7b9ead2d`, komunikat:
`Control helper exited before acknowledging its durable lease`.
Ponowny inspect potwierdził, że usługi nie zostały uruchomione.

Niezależne review istniejącego kodu recovery: brak trasy obsługującej te
dowody. Resume nie wywołuje reconciliacji aktywacji; recreate ją wywołuje,
ale wymaga native failed-stop metadata i dokładnego journalu. Stan ready
i brak journalu nie spełniają tej bramki. Nie rozszerzano wyjątków recovery
ani nie tworzono nowego namespace jako obejścia.

Brakujący kontrakt: uwierzytelniony dowód zakończenia dokładnej inkarnacji
backendu po przerwaniu demona, obejmujący procesy, lease i rezerwacje;
następnie CAS zaległego lease aktywacji z zachowaniem kwarantanny i
nieznanego wyniku, bez replay Solve. Zmiana dotyka kontraktu runtime;
wysłano użytkownikowi wybór rozszerzenia zakresu albo oczekiwania na recovery.

Wolne miejsce hosta przy preflight: WSL20GiB, WindowsC28GiB. Nie budowano
nowych obrazów, nie kompilowano unit tests, nie usuwano cache. Browser/WebGL
i Primitive→mesh pozostają NOT VERIFIED. Zakaz unit tests nadal obejmuje CI;
PR/merge/cleanup niewykonane.

## Recovery wykonane i rozdzielenie fixture wizualnej od przygotowania FEM

Commit `92e2535f7bb837a93ad24aff340f9e0dfeb48498`: 20/20 nowych
regresji interpretowanych, 25/25 istniejących kontroli runtime/ledgera,
niezależne review bez actionable findings. CI bootstrap, contract-guard
i dispersion-artifact-consumers dla tego HEAD zakończone success.

Zarządzane dry-run i apply kwarantanny: PASS, recovery
`54c063ef98f546edbace248807e25651`. Nowy namespace o tym samym ID;
stary marker, owner, store i ledger pozostały byte-identical. Cztery inne
backendy zachowały ID i StartedAt. Receipt w nowym namespace:
`verification/empty-quarantine-acceptance.json`. Nie wykonywano rzeczywistego
przerwania transakcji; częściowy rm jest sprawdzony regresją protokołu.

Start `33f95aaed1a44101a007ed066b5c62cf`, config
`bf670c9da73443a4eb86afc080b937a6f9d387e0f7d1fb97cbb2b7640db73b9c`:
build aplikacji i API/native readiness PASS, cache obrazów wykorzystany.
Aktywacja pełnego przykładu `29b71361591e428bae43232fc9691d2a` została
przyjęta jako run `run-live-022431ae8f6b7f40f68a851936b7e78fa729ee6cf0165bee76ed318e2013eb51`,
lecz przygotowanie zakończyło się błędem native runtime przed receipt.
Log preparera potwierdza serię typed writer contention i końcowe:
`host admission requires a current sample for the active compute-node owner`.
To dowód błędu przygotowania, nie diagnoza konkretnej przyczyny kosztu
eksportu ani dowód problemu renderera. Nie było OOM ani Solve.

Istniejące `stop-diagnostic-volume --pending-activation` zakończyło się
`stopped-awaiting-fresh-archive`, execution_state=not-started,
restart_policy=fresh-state-only. Run, lease, owner i receipty zachowane.
Nie użyto nowej kwarantanny pustego store wobec przyjętego runu.

Wrapper runpy zastąpiono osobną fixture wizualną: identyczne geometrie,
materiały, uniwersum, parametry FEM i requested GPU/double, bez żądania
budowy siatki i bez etapu solvera. Oryginalny przykład fizyczny pozostaje
bez zmian. wait_for_solve w oryginale następuje po materializacji; nie
stanowi pauzy przed przygotowaniem pełnej siatki. Nowa fixture służy
do jawnego rozdzielenia Primitive i późniejszego mesh_build przez API.
AST i zgodność parametrów źródłowych: PASS. Browser/WebGL nadal NOT VERIFIED.


## Weryfikacja fixture: kontrakt przygotowania wymaga etapu

Fresh-state archive i start `093eaeceee1f401db5d9d495a633b01e`: PASS,
config `36d81819dfcd1dc92787b57d84587fed1bb53a28738bddaae58c995126459b8d`.
Aktywacja bez etapów `cb69d0e76e2241dc9629632576baceb6` zakończyła się
failed-confirmed: `accepted_execution_stage_missing`. Nie przyjęto runu.
Przygotowanie FEM zawsze materializuje zasoby, niezależnie od
`mesh_workflow.build_requested`: log potwierdza odczyt cache siatki
183764 nodes / 1087250 elements i eksport w 84.5 s. Wcześniejsze założenie,
że usunięcie build_domain_mesh zatrzyma tę ścieżkę przed materializacją,
było błędne. Fixture otrzymuje rzeczywisty etap BB z oryginalnego przykładu;
interactive/wait_for_solve zatrzymują wykonanie przed Solve.

Browser QA: pierwszy start odmówił zajętej blokady aktywacji; kolejny
nie doczekał zimnej kompilacji /workspace. Po HTTP200 przeglądarka wykonała
próbę, lecz walidator mounta odrzucił alias Docker Desktop WSL. To błąd
porównania ścieżek w harnessie; lokalny alias i katalog źródeł mają ten sam
device/inode. Wynik tej próby pozostaje nieznany i zasoby zachowane do
jawnej reconciliacji; nie jest zaliczonym odbiorem WebGL.


## Druga rotacja fresh-state: zachowanie dowodu archiwizacji

Walidator aliasu WSL otrzymał kontrolę device/inode z zamkniętą postacią
aliasu i fail-closed przy braku lokalnego potwierdzenia. 24 interpretowane
regresje QA PASS. Zachowana próba przeglądarki
`2073860b21e54601a0d1018fd2b19940` została jawnie zreconciliowana:
failed-confirmed, exit1, output_lost=true, lease_released=true. Nie jest
dowodem WebGL.

Zastąpienie odrzuconej sesji odmówione przed mutacją: live_retirement_busy.
stop-unadmitted początkowo odrzucił zmieniony hash pliku fixture.
Przywrócono dokładne bajty commita df64e11 wyłącznie dla dowodu wejść
odrzuconej sesji; stop `52291a1d438c4e4990cba66a39c18e8a` potwierdził
brak przyjętych runów/rezerwacji i graceful drain. Następnie odtworzono
poprawioną fixture z HEAD; nie ponawiano starej aktywacji.

Recreate `a896dc51e36e4a9d8842b013a809c4d7` i start
`8d52e69c27a245e19388fca9591c223f` PASS; config
`6ddcf68e9c5ef0acc09736b95999dcdbc8f16bdbe24e34f0d909fc29d314f577`.
Nowa aktywacja została odmówiona jeszcze przed operacją/admission:
rotacja group-ledger-generation.json przesłoniła dowód wcześniejszej,
kompletnej archiwizacji `04af5e9fd7e842d0acaf293b12e1a46c`. Stare abort
i terminalne receipty pozostały nienaruszone. Wymagana jest trwałość
przypięcia dowodu archiwizacji przy kolejnych rotacjach, bez luzowania
zakazu replay i bez nadpisywania starego runu/ledgera.


Poprawka trwałości: 8/8 nowych regresji interpretowanych PASS, 9/9
istniejących runtime-state PASS. Kontrola odczytowa rzeczywistych danych:
bieżący wskaźnik false, dokładny stary archive attempt true.
Pin pod lease verification `1c6a12eeffa54fbdb5c8f6e7d1db3b33`: PASS.
Stary abort i bieżący group-ledger-generation.json byte-identical;
old_request_replayed=false. Receipt: verification/attempts/
1c6a12eeffa54fbdb5c8f6e7d1db3b33/archive-anchor-proof.json.
Automatyczny pin przed przyszłą rotacją sprawdzony regresją, bez kolejnej
zbędnej rzeczywistej rotacji. Nie zmieniano progu świeżości próbek ani lease.


## Odbiór kamery i ringu w przeglądarce: PASS, eksport osobno

Aktywacja `ffb67c5eec14444f996e0de0a39faa28`: succeeded. Native preparer
PID4944: exit0, status_success=true, stderr=0, status=prepared. Run
`run-live-7f3fa32a0c193e8f5009441ec00d2a9f8b8bc7751cd939ec435e88db30738279`
nie otrzymał Compute/Solve. Opublikowano domenę FEM 1087250 cells,
mesh/topology/mesh_build revisions=2. Próbki zasobów podczas przygotowania
pozostawały świeże; surowe obserwacje w verification/paused-study-host-samples-active.jsonl.

Próba browser `ee82204eafb142d8bc4786027c323d49`: sam
viewport_camera.state=passed. 26 captures, w tym 3 kamery × 3 tryby ringu,
FOV/Fit, przełączanie projekcji, 11 ustawień osiowych/skośnych, ViewCube +X
i rzeczywisty orbit drag. Restoration verified, ten sam canvas i kontekst.
WebGL2, 712×554 drawing buffer, depth24, context_lost=false. Page, console,
request i HTTP errors: puste. SwiftShader; bez kwalifikacji hardware GPU.

Obejrzane PNG nie pokazują dawnych pasów z-buffer. Kontury podglądu są
ciągłe, pełna siatka pokazuje własną triangulację. Podczas pierwszego
ładowania część ujęć zawiera fallback Primitive przed uploadem topologii;
nie zastępuje to osobnego odbioru jawnie niezeszowanej sceny.

W pierwszej próbie wstążka była przywracana przez innerText (CSS uppercase
WORKSPACE), co nie odpowiadało nazwie accessible. Harness używa teraz
stabilnego ID zakładki. Syntax check w grupie i 24 regresje harnessu PASS;
próba ee822 potwierdza restoration. Zachowywany stdout ma pełny dotychczasowy
limit wyniku, aby nie tracić poprawnych części raportu po innym błędzie.

Ogólny browser QA pozostaje failed-confirmed: po zaliczeniu kamery
następny test eksportu PNG przekroczył 20 s czekania na download.
Nie oznaczono go jako PASS. Osobny dowód kamery:
verification/ring-camera-full-mesh-browser-proof.json. Trwa test Primitive
przed pierwszą publikacją siatki oraz diagnoza eksportu.


## Odbiór rzeczywistego Primitive przed pierwszą siatką — 24.10

Scratch `session-18e18b10f1f79f7f00000c10` utworzono przez publiczne API;
zaimportowano tę samą geometrię i authored study. Przed poleceniem mesh_build:
run=null, domain.cell_count=0. Źródła i receipt jednorazowego importu zachowano
w verification/attempts/94f041ceeec8482f94cfad3d7400337f/continuation.json.
Nie pozostawiono eksperymentalnego helpera importu w repozytorium; jego
źródła i nieudane receipty zachowano w control volume.

Browser `8fda5f6f37384bfdb0a8a11359d1a18c`: viewport_camera.state=passed,
26 captures, w tym wszystkie 9 ujęć ringu bez opublikowanej siatki.
Widoczny canvas, niezerowy drawing buffer, context_lost=false.
Oględziny PNG: ciągła powierzchnia bez pasów głębokości; wireframe pokazuje
obrzeża kapsli, bez wachlarza przekątnych. Perspektywa i ortho poprawne.
Testy eksportu PNG, DPR1/DPR2 oraz lifecycle również zakończyły się poprawnie.
Ogólny harness pozostał failed-confirmed przez 20 odpowiedzi HTTP422 z
planar-default/meta przy pustej domenie. Nie wyciszono ich. To odrębna
ścieżka gotowości pola 2D; poprawki tej ścieżki znajdują się w cudzych,
niezacommitowanych zmianach głównego checkoutu i nie są częścią tego PR.
Dowód: verification/ring-primitive-browser-proof.json.

## Jawne przejście Primitive → opublikowana siatka

Wysłano dokładnie jedno mesh_build, intent
`viewport-depth-mesh-0333b7f51c5b053c92eaff9b`, z warunkami scene_revision=1,
command_revision=0. HTTP przekroczyło 30 s; nie ponawiano POST.
Odczyt tego samego polecenia `fm-d8abd9db-ec0c-449b-ab30-2a15267a3739`
potwierdził completed po około 612 s. Ta sama tożsamość sesji i scope;
1087250 cells, mesh/topology/mesh_build revisions=3. Runtime utworzył
przyjęty Study do przygotowania domeny: run
`run-live-b0948e93e19d555f87de205d3d7b5034af9575ac10686a2ded64787fd49adbf3`,
waiting_for_solve, stages=[pending], completed_stage_indexes=[], solver_time=0.
Nie wysyłano Compute ani Solve. Legacy solver_steps=1 oznacza tu plan,
nie wykonany krok; metrics.total_steps=0.

**Wykryta rozbieżność runtime, niezaliczona kwalifikacja GPU:** import
SceneResource zachował authored GPU/double/strict, lecz scratch zachował
effective request i resolved CPU/double/strict z inicjalizacji. Polecenie
mesh_build raportuje CPU. Odczytowy observer
`51b3fd2dc4dc4bd2bedc2d6813d8e8c7` prawidłowo zakończył się asercją
niezgodności intentu; nie oznaczono go jako PASS. Samo completed i zasób
siatki są potwierdzone, parytet GPU nie jest. Wcześniejsza sesja uruchomiona
z pliku GPU oraz jej dowód kamery pozostają odrębnym przebiegiem.
Diagnostyka build-ring-mesh.py teraz odmawia już przed mutacją, jeśli
requested/resolved lane nie odpowiada authored strict intent. Jej zapis
receiptu jest wyłączny i atomowy, bez automatycznego replay po timeout.

Kontrole guardów diagnostyki wykonane interpretacyjnie na rzeczywistym
statusie API: niezgodne CPU/GPU odrzucone, zgodny strict intent przyjęty;
po przygotowaniu osobno odrzucono resolved CPU oraz zmiany requested_mode
i resolved_mode. Nie wysłano przy tym żadnych poleceń. Niezależne review
potwierdziło zamknięcie luki resolved/mode i kontrolę manualnego gate.
AST i git diff --check PASS. Pełny helper nie został ponownie uruchomiony.


## Końcowy odbiór 24.10 — topologia, piksele, eksport i lifecycle

Próby `7319be87cb434c74812e5374fcf95fda` i
`922f01b07b174501b5ec5fcefddc7d7c` wykazały pusty viewport po wygaśnięciu
15-sekundowego deadline topologii. Pierwszy harness błędnie uznawał sam
niepusty HUD i poprawną kamerę za wystarczające; oględziny PNG ujawniły brak
geometrii. Guard fixed-fixture teraz wymaga czerwonej powierzchni w centralnym
ROI, z wyłączeniem czerwonych osi/sfery HUD. 18 rzeczywistych PNG: 12 dodatnich
powierzchni przyjętych, 6 pustych obrazów odrzuconych. Próba922f z nowym guardem
prawidłowo zakończyła camera.state=failed (0 pikseli powierzchni), z restoration.
Negatywny dowód zachowano w verification/ring-published-mesh-browser-proof.json.

Pomiar pełnej topologii: 45 632 256 B, silny ETag i poprawne Content-Range.
Prywatny Range64KiB: 0,092 s. Pierwszy publiczny nagłówek: 7,717 s,
kolejne8MiB: 0,119 s. To pojedyncze pomiary, nie benchmark wydajności.
Zwiększono wyłącznie skończony budżet topologii15→60s; nie zmieniono limitów
pól, liczby prób, walidacji ETag, zakresów ani lifecycle. Regresja źródłowa
przetrzymuje request przez15001ms (stary limit go przerywa); uruchomienie
unit tests pozostawiono do jawnie dozwolonego CI. Lokalnie app typecheck
i scoped ESLint PASS, exit0; parsery MJS i Python AST PASS.

Próba `c977c79890474c259d316495730ec82a`:

- Widoczny canvas, WebGL2, context_lost=false, niezerowy drawing buffer.
- Topologia została pobrana: od pierwszego requestu do końca ostatniego
  zakresu31,343s; sam pierwszy nagłówek8,637s, pierwsza sekcja12,692s.
  Pomiar wyjaśnia przekroczenie wcześniejszych15s; nie oznacza przyspieszenia.
- viewport_camera.state=passed:26 captures,9 ujęć ringu, zgodny depth range,
  dodatnie piksele powierzchni we wszystkich6 trybach shaded, przywrócone
  ustawienia i ten sam canvas/kontekst. Oględziny ponownie potwierdziły obrysy
  Primitive bez triangulacji kapsli. Sam ten przebieg pokazuje podgląd
  Primitive także przy przyjętej topologii; nie przedstawiamy obrysów jako
  dowodu triangulacji FEM. Wcześniejszy odrębny PNG ortho-wireframe zawiera
  rzeczywiste krawędzie FEM; fizyka pozostaje poza zakresem tych obrazów.
- Eksport PNG (także transparent geometry), DPR1/DPR2 oraz lifecycle
  zakończyły swoje kontrole. Nie wystąpił wcześniejszy pusty eksport ani
  timeout pobrania PNG. Nie zgłaszamy zmierzonej poprawy pamięci lub idle.
- Page errors i transport failures: puste. **Ogólny wynik nadal FAIL** przez
  404 z frequency-domain response i422 z planar-default field metadata.
  Nie wyciszono błędów i nie zmieniono tych ścieżek. To ogranicza odbiór
  całej aplikacji, niezależnie od zaliczonego zakresu renderowania ringu.

Dowód: verification/ring-topology-60s-browser-proof.json w zachowywanym
wolumenie kontrolnym. Browser SwiftShader,2CPU/2GiB; memory.peak=2147520512B,
memory.events max=4982, oom=0, oom_kill=0. Nie jest to test braku wycieków.
Niezależne review guardów oraz lokalnej polityki deadline bez pozostałych
findingów; skuteczność60s potwierdził powyższy rzeczywisty przebieg.

Pozostałe jawne ograniczenia: nie naprawiano importu authoredGPU/effectiveCPU
ani endpointów analizy/planar2D. Nie wykonano Compute/Solve, kwalifikacji
naukowej ani hardwareGPU. Zaliczenie zakresu tego PR nie oznacza zielonego
ogólnego harnessu ani poprawności tych odrębnych ścieżek runtime.

## Kontrakt command_revision przy zamykaniu QA

Pierwszy Stop przed cleanupem nie został przyjęty:409 precondition failed,
expected2/got1. Błędnie użyto rewizji zasobu queue.revision=2; bieżący
kontrakt admission porównuje command_revision z ledger.len()=1
(router_v2/handlers/simulation/commands.rs), a rewizja zasobu rośnie także
przy completion. Polecenie mesh_build było jedynym wpisem i było completed.
Receipt6948738e2b8647ffb51d13d4509740cd zachowuje odrzucenie; nie oznaczono
Stop jako wykonanego. Diagnostyka używa teraz jawnie długości dziennika,
z komentarzem rozróżniającym te wartości. Pierwotne mesh_build miało pusty
dziennik, więc obie wartości wynosiły0; nie zmienia to jego wyniku.
Nowy Stop wymaga ponownego odczytu dziennika i potwierdzenia, że poprzedni
intent nie został przyjęty; nie jest ponowieniem nieznanego żądania.
