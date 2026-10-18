# Fullmag all-in-Docker na Windows — plan i kontrakt storage

Cel: obraz release z UI, API, Pythonem, FEM i GPU NVIDIA oraz tryb developerski
z dwoma kontenerami: frontend HMR z głównego checkoutu i backend FEM/GPU; port hosta 3197;
sesje bezpośrednio w skonfigurowanym storage Windows, bez named volume.
Jednorazowy wyjątek użytkownika dotyczy wymaganej kompilacji testów w CI,
nie lokalnego kompilowania unit testów. Pozostała praca użytkownika zostaje zachowana.

## Uzgodniony kontrakt developerskiego Compose

Źródłem topologii trybu developerskiego jest wersjonowany rootowy `compose.dev.yaml`.
Ma dokładnie dwie usługi, `backend` i `frontend`, oraz prywatną sieć Compose:

- `backend` nie publikuje portu hosta i udostępnia `8081` tylko w sieci Compose;
- `frontend` publikuje `127.0.0.1:3197:8080` (port hosta może być rozwiązany
  przez launcher) i kieruje API przez `http://backend:8081`;
- GPU i accepted store otrzymuje wyłącznie backend; frontend nie dostaje
  certyfikatu writera ani montowania sesji.

Wspólnym parametrem źródła jest `FULLMAG_SOURCE_ROOT`: domyślnie wskazuje
główny checkout Git, a operator może jawnie wskazać wybrany worktree. Dev image
nie kopiuje źródeł aplikacji ani pakietu runtime. Backend używa readonly bindów
`FULLMAG_SOURCE_ROOT` → `/opt/fullmag/source`, pakietu → `/opt/fullmag/package`
oraz provenance → `/opt/fullmag/provenance.json`. Frontend montuje readonly
`apps/control-room/app`, `src`, `public` i `scripts` z tego samego checkoutu;
polling/HMR dotyczy tych katalogów. Konfiguracja, manifesty i metadane freeze są
utrwalane osobno i nie zmieniają się przez HMR.

`compose.static.yaml` pozostaje opcjonalną, osobną ścieżką release/legacy dla
statycznego frontendu. Nie jest wariantem developerskiego HMR.

Zmiana backendu wymaga jawnego capture immutable source i zlecenia do istniejącej
kolejki managed build. Build nie uruchamia automatycznego restartu Rust/API ani
bieżącej symulacji. Obraz developerski oraz integracja rootowego Compose są
**VERIFICATION PENDING** do zakończenia implementacji launchera/renderowania;
ta sekcja nie ustanawia nowych flag recept.

Interfejs launchera po integracji jest jawny i ograniczony do istniejących
recept:

```text
just docker-all-dev <assembly_receipt> [port=3197] [source_root=""]
just docker-all-dev-backend-build [source_root=""]
just docker-all-dev-image <job_id> <commit> [source_digest=""] [native_snapshot_sha256=""] [source_root=""]
```

Pusty `source_root` oznacza główny checkout Git; jawny parametr wymaga
zarejestrowanego worktree. Dwa argumenty obrazu dotyczą clean commit, a cztery
pierwsze argumenty służą immutable snapshotowi (w tym dwa digesty); dla
snapshotu z innego worktree piąty argument
`source_root` (albo `FULLMAG_SOURCE_ROOT`) musi wskazywać ten sam checkout co
submission. Launcher zamraża resolved Compose JSON i kopię źródłowego
YAML w owned run; nie generuje topologii przez Python. `docker-all-image`
pozostaje opcjonalną ścieżką packaged release dla `compose.static.yaml`.

Zależności FEM pozostają kanoniczne dla `docker/fem-gpu/Dockerfile`, w tym
stage `fem-gpu-dev` i przypięte wersje z tego pliku. Nie tworzymy drugiej listy
wersji w Compose ani w planie. Obraz agenta dostarcza `Dockerfile.dev` i
integrację toolchaina; osobny przegląd utrzymuje raport zależności i śledzenie
wersji.

## Zakończone etapy

- Recepty build/image/start, walidacja managed GPU release i immutable image.
- Niezależna kapsuła source bez osłabiania shared CAS; 7 kontroli Python Linux,
  6 Windows i jedna kontrola Bash pominięta na Windows.
- Commity: c9feee383bf72ba352b21c7a8b091d7a8b0bf8ca,
  34f68b6ff58f92e9ab1f5719b5f4b9a854415b39, 8c195ecd292ee5c300342265e30f8be35f1628fc.
- Managed GPU job e7325f418ca74bc0bc4d21e24c0fd090 przyjęty z czystego commita.
- Żywa sonda 7656cafdee4d4d78816536e272582fee: 9p 0x1021997, fsync katalogu,
  atomowa zamiana, lock pomiędzy procesami, no-follow symlink/junction oraz
  readback po ponownym starcie własnego kontenera przeszły. Power loss NOT VERIFIED.

## Kolejne etapy i bramki

1. Wdrożyć jawny `windows-folder-v1` dla roli session. Zwykłe 9p bez dowodu
   nadal jest odrzucane. Kwalifikacja dotyczy wyłącznie `/state` na lokalnym
   NTFS/ReFS potwierdzonym przez natywny Windows launcher.
2. Launcher wydaje readonly attestation hosta, przeprowadza probe/restart przed
   pierwszym uruchomieniem API i dopiero potem pozwala entrypointowi opublikować
   grant powiązany z namespace mountów oraz inode/device bieżącego kontenera.
3. Core Rust sprawdza grant, host attestation, zakres ścieżki, tożsamość source,
   aktualnego exe i obrazu. Native Windows odmawia użycia wewnętrznego store
   oznaczonego jako należący do Docker; nie zakładamy interoperacyjności locków
   Win32/Linux. Nie zmieniamy writera, lease, no-follow ani publication barriers.
4. Kontrole źródeł i CI unit tests; managed build końcowego commita; image assembly;
   create/save/reopen i ponowny start własnego kontenera; GPU oraz browser/canvas
   pozostają osobnymi bramkami. Nie restartować Docker VM ani obcych aplikacji.
5. Review, push/PR, wymagane checks, merge, główny master fast-forward i bezpieczny
   cleanup tylko własnego worktree. Dirty master może blokować końcową integrację.

## Kontrakt JSON v1 dla implementacji

Readonly host attestation: `/run/fullmag/windows-folder-host.json`.
Pola: `schema="fullmag.windows-folder-host.v1"`, `storage_profile="windows-folder-v1"`,
`role="session"`, `owner_scope="docker-desktop-linux"`, `host_root` (absolutny Windows),
`host_filesystem` (NTFS/ReFS), `host_drive_type=3`, `host_volume_serial` (u32),
`host_root_no_reparse=true`, `owner_token` (UUID), `engine_id`, `image_id` (sha256:hex64),
`source_commit` (hex40), `binary_hashes` (mapa nazwa pliku bin -> hex64),
`artifact_receipt_sha256` (hex64), `restart_expected_sha256` (hex64),
`restart_verified=true` przed uruchomieniem API.

Grant: `/state/.fullmag-windows-folder-grant.json`.
Pola: `schema="fullmag.windows-folder-session.v1"`, `storage_profile="windows-folder-v1"`,
`role="session"`, `state="operational"`, `container_root="/state"`,
`host_attestation_sha256` (hex64), `owner_token` (jak host), `root_device`, `root_inode`,
`mount_namespace_inode` (u64), `power_loss="NOT VERIFIED"`,
`checks` (mapa dokładnie poniższych nazw, wszystkie true): `file_sync`,
`directory_sync`, `atomic_replace`, `atomic_directory_publish`, `process_lock`,
`no_follow_symlink`, `no_follow_junction`, `sqlite_transactions`, `restart_readback`.

Host marker: `/state/.fullmag-windows-folder-owner.json`, ta sama host attestation
(na hoście ścieżka rootu Windows). Stan oznacza namespace tylko dla Docker;
nie jest upoważnieniem do takeover ani native Windows writer. Stary marker lub
niepotwierdzony właściciel wymaga kontrolowanego recovery, nigdy age/PID takeover.

To operacyjny admission na konkretnym montowaniu, nie kwalifikacja power-loss,
restartu VM, fizyki ani wszystkich konfiguracji Docker Desktop. Dowody pozostają
w storage i są powiązane z source/binary/image/artifacts.

## Checkpoint adaptera storage

Adapter Rust i kontrola launchera są zaimplementowane. Próba `fa70d054fb1f4ceead650d3cf9cd573e`
wykonała wszystkie dziewięć kontroli oraz native Windows readback (PASS),
bez kwalifikacji power-loss. Kontener próbny: `8d1bb2df28b18e3f70ad54ae66c4ac7a1fbe06d906d65787b3fc6f884de0b995`.
Dziewięć interpretowanych testów kontraktu Python przeszło na Linux.
Review wykrył brak katalogu certyfikatu i weryfikacji readonly mountu; poprawiono
te miejsca oraz bounded native no-follow read i porównanie hashy provenance.

Job `e7325f418ca74bc0bc4d21e24c0fd090` zakończył się kodem 2 przed kompilacją:
brak Rust nightly w pustym cache GPU. Uzupełniono wyłącznie pusty cache GPU
niezależną kopią istniejącego toolchaina CPU; readonly probe wykazał
`rustc 1.100.0-nightly (cea272fa3 2026-09-07)`. Nie zastąpiono GPU przez CPU.
Źródłowy cache CPU pozostał bez zmian. Artefakty błędu i kapsuła są zachowane
do diagnozy; nie usunięto execution, współdzielonych cache ani pakietów.
Skill `fullmag-build-stage-cleanup` jest niedostępny; zastosowano retencję governance.

Pozostałe bramki: nowy managed build końcowego commita, złożenie obrazu,
API/save/reopen/restart sesji, rzeczywista realizacja FEM GPU, przeglądarka/WebGL,
CI zadania i pełny cykl PR/integracji. Wyjątek kompilacji testów dotyczy tylko CI.

## Uzupełnienie startu pełnego workspace

Review wykazał, że standalone API nie uruchamia canonical runtime service.
Pakiet release ma schedulery/workery/resource publishers; należy podpiąć
`fullmag-bin runtime service-ensure` i `service-status` do entrypointu,
z read-only konfiguracją usługi API oraz tym samym accepted-store bindingiem.
Dodany wewnętrzny bootstrap inicjalizuje tylko `/state/runs/docker-all/session-store`
po ścisłym Windows-folder admission; istniejący/niepełny store nie jest nadpisywany.
Nie używamy windows-only managed initializer ani Pythonowej imitacji SessionStore.

Domyślne jawne budżety operatora: kontener 4 CPU/8 GiB; compute 3 CPU/6 GiB,
preparation 1 CPU/1 GiB oraz pozostała pamięć dla API. Nie są to pomiary sprzętu.
Usługa accepted zachowuje bieżący v1 CPU contract; guard host execution v2 pozostaje.
Bieżąca accepted ścieżka FEM nie obsługuje GPU; GPU w obrazie używa istniejącej
trasy CLI. Nie rozszerzamy capability map ani API.

Driver CUDA zainicjalizował się w przypiętym obrazie GPU i wykrył jedną kartę;
nie jest to dowód wykonania solvera FEM. Job `df2c236db17340f0a742af0beb328be1`
potwierdził anulowanie (exit 143), więc jego diagnostyka/kapsuła pozostają zachowane.


## Naprawy bazowe zatwierdzone przez użytkownika

Włączono zapisane lokalne commity 059d7a2e6330233fa75da6e5d97fc9d95cd4c109,
c0edb5b82cb22b0107c6dc35c3f8f910db734c96, ea8acefc0c6dfc0300d63f37908db189acb108a7
i ec416fe3bd9f04bcb68558e9cbfe489fa10a8916. Niezapisane cudze zmiany głównego
checkoutu pozostały nietknięte. Minimalna naprawa czterech fixture'ów API została
zapisana jako a1c80f59ba98ee1fce5715e88a31e308c052c2eb; diff check i review źródeł
przeszły. Kompilacja tych fixture'ów pozostaje bramką CI, nie została wykonana
lokalnie. Pozostałe naprawy obejmują generator otwartych JSON i swept mesh Gmsh.

Rejestr zadania ma stan implementation. Nie usuwano danych etapu; zachowano
kapsuły, execution błędu/anulowania, logi i próbki storage. Ostatni pomiar wolnego
miejsca przed końcowym buildem: 16 185 716 736 bajtów. Ponowna ocena retencji
po kwalifikacji runtime; sam rozmiar lub wiek danych nie jest dowodem zbędności.


Runtime service jest podpięty do entrypointu. Read-only health wymaga gotowej
usługi. Bootstrap i terminal drain wykorzystują kanoniczne Rust API; częściowy
store, zmieniony owner, niepewny start lub drain zachowują dowody i wymagają
recovery. Nadzór przypina API instance/build/accepted binding oraz service owner.
Review poprawił reeksport drain, admission wszystkich binariów release i
zachowanie ownera po błędzie późniejszej obserwacji. 17 interpreted checks
przeszło na Linux; na Windows 14 przeszło, 3 Linux-only zostały pominięte.
AST, rustfmt nowego modułu i Bash syntax przeszły. Nowa kompilacja CLI i
wykonanie Rust regresji pozostają wyłącznie do CI/managed build.

Poprawka generatora OpenAPI została zapisana jako
f6b904d308307df4b63ee60c577313067cd19836. Canonical openapi-typescript 7.13.0
wygenerował typy; ponowna generacja była identyczna, strict noEmit realistycznej
fixture snapshot/policy przeszedł. Local Vitest został odrzucony przez automatic
approval review: wyjątek dotyczy tylko CI zadania. Nie wykonano obejścia.


## Korekta instalacji frontendu Docker

Próba `290c6c55e2284d0699a8829895e747ca` potwierdziła Node 24.18.0 i pnpm
10.8.1, lecz instalacja zakończyła się `ENOTDIR` dla symlinkowanego
`workspace/node_modules`. Next i HMR nie wystartowały. Poprzedni stan, logi
i cache pozostają zachowane; nowa próba użyje świeżego workspace.

Frontend przekazuje pnpm rzeczywiste katalogi importerów pod
`state/development/workspace`. Niemutujący polling sprawdza te katalogi
oraz dokładne cele aliasów cache; zmiana kończy nadzór przez istniejącą
ścieżkę błędu, bez naprawiania mountów, takeover ani wymuszonego kill.
15 interpretowanych kontroli Linux przeszło; Windows: 5 PASS i 10 pominiętych
kontroli specyficznych dla Linux. AST i niezależny review przeszły.
Cold/warm Docker oraz HMR pozostają NOT VERIFIED do nowej próby.

Runner potwierdził po zwolnieniu miejsca około 31,7 GB wolnego storage.
Preview `plan-3b71bc43f0c344a18a41e40eed65ad1c` dla dwóch zakończonych jobów
zadania ma 0 kandydatów; danych nie usunięto. W istniejącej kolejce obserwujemy
job `e8a13bc0d2914851a27667fa0a575989`, profil `fem-gpu-release`, source
`b5814b313a2d8a500d2e24576f16cbfc48934955`. To wersja sprzed korekty pnpm;
jej build nie będzie dowodem kompletnego końcowego obrazu. Nie uruchomiono
równoległego ciężkiego buildu ani nie zatrzymano obserwowanego joba.


## Korekta bazowej siatki dla bramek CI

Scoped magnetic intervals używają pojedynczej recombined extrusion, a zewnętrzne
powietrze pozostaje geometry-only. Pole właściciela nie eksportuje `VOut` do
powietrza. Ring otrzymuje osobny powierzchniowy target ziarna 2D, ponieważ
późniejszy volume-only scope nie obejmował źródłowej płaszczyzny w dolnym airboxie.
Zachowano wszystkie guardy CAD, exact magnetic layers, dodatnich komórek i PBC.

Dowody końcowego zachowania: 2 owner-field consumers, 6 ring i 6 periodic
przechodzą; 3 publiczne przypadki Box/DE przechodzą. Sześć syntetycznych guardów
przechodziło dla niezmienionej fixture. Pełny wcześniejszy wynik 4 przypadków Box
jest pre-seed evidence dla statycznie niezmienionej ścieżki Box. Świeży retest
cap-below został przerwany kodem 130; nie raportujemy go jako świeżego PASS.
Manifest wiąże logi, komendy, wersje i raw/LF SHA źródeł; dowody zachowano
pod `storage/tmp/<worktree-id>/docker-all-gpu/scientific-evidence`.

Noty i mapy 0102/0104 opisują implemented candidate. Density, managed runtime,
solver i produkcyjna kwalifikacja FEM CPU/GPU pozostają NOT VERIFIED.
AST, JSON, source-map validator i 41 kontraktów dokumentacji przeszły;
nie kompilowano lokalnych testów Rust/C++.

### Checkpoint — kontrakty Python i potwierdzony build wcześniejszego SHA

- Testy prywatnego helpera eigen przekazują wymagane `magnet_vars={}`.
- Test auxiliary identity sprawdza osobno `object_id`, `name` i `geometry_id`, zgodnie z istniejącym adapterem; produkcyjna ścieżka SceneDocument pozostała niezmieniona.
- Dokładny zestaw CI Python: **127 PASS w 66,08 s**; publiczny verifier tożsamości i rename: **1 PASS**. Nie kompilowano lokalnych testów Rust/C++ ani Vitest.
- Managed job `e8a13bc0d2914851a27667fa0a575989`, źródło `b5814b313a2d8a500d2e24576f16cbfc48934955`: terminalny koordynator **succeeded, exit 0**. Wszystkie trzy etapy (`native-build`, `frontend-dependencies`, `frontend-build`) zakończyły się kodem 0.
- Natywny validator sprawdził immutable source, 127 hashy oraz wymagane 12 binariów, PyO3 i statyczny frontend. To dowód buildu wcześniejszego źródła; nie obejmuje końcowego obrazu, HMR, API ani wykonania FEM GPU.
- Własne zgłoszenie `996c0d7f284e4cefb08972d959a860d0` anulowano w stanie `queued`, aby zastąpić je poprawionym spójnym źródłem. Kapsuła i dowody pozostają w storage.
- Pozostała korekta fixture meshing: większy clearance przechodzi niezmieniony próg jakości 0.1, ale asercja kontrastu source-face wymaga dalszej diagnozy. Nie obniżono progu ani ratio.

### Checkpoint — test-only blokady kompilacji Rust w CI

W `fullmag-application` uzupełniono dwa importy `#[cfg(test)]` i domyślne `antenna_inventory` w testowym literalze `ScriptExecutionConfig`. Są to przyczyny pięciu błędów kompilacji kroku `cargo test -p fullmag-application --no-fail-fast` w CI `38633512350` / job `116090784830`. Parser-only rustfmt i diff check: PASS. Lokalnych testów Rust/C++ nie kompilowano; potwierdzenie kompilacji i działania oczekuje na wymagane CI poprawionego brancha.


### Checkpoint — realizacja lokalnego celu na źródłowej powierzchni

Przyczyną regresji kontrastu siatki był lokalny Box pomijany przez początkową triangulację 2D. Plane-aware seedowanie osadza punkty na rzeczywistej przyciętej powierzchni, uwzględnia owner lower bounds i wyklucza otwory CSG. Zakres Box i progi testu pozostają niezmienione; fixture otrzymała większy clearance powietrza bez obniżenia jakości 0.1 ani ratio 1.5. Dwie mock fixtures przyjmują kanoniczne object_id.

- Pięć focused interpreted Gmsh regressions: **PASS, exit 0, 10.519 s**. Log SHA256 `32ae2b8c28a75c16e711265cedf197cc9d045b4efc4274cd6aeb8c0530a7aad3`.
- Publiczny harness: **3 PASS, 42 deselected, exit 0, 300.79 s**, Python 3.10.12/Gmsh 4.15.2. Log SHA256 `f7f70dcc947880130f4f1788e9ba7709867160d10125e2f141095387ac1a5cec`.
- AST oraz source-map validators 0102/0104: **PASS**. Niezależny review: PASS po korekcie fail-closed bounding box.
- Runner zdrowy i idle, lecz aktualny pomiar Windows i runnera wykazuje około **2.03 GiB wolnego**. Wymagane minimum kolejnego buildu wynosi 8 GiB; operator otrzymał prośbę o zwolnienie miejsca. Nie usunięto cache, kapsuł, wyników ani dowodów.
- Końcowy build poprawionego SHA, obraz, dwa kontenery, HMR i runtime GPU/storage pozostają **NOT VERIFIED**.

Niepoprawny bbox (konwersja, długość, NaN/Inf, odwrócone granice) kończy się RuntimeError zamiast pominięcia seedowania; wyjątki CAD propagują. Nowa wykonywalna regresja i powtórzone focused Gmsh consumers: PASS. Dowody i bieżące raw/LF SHA zapisano w `scientific-evidence/source-plane-seed-evidence.json`.


### Checkpoint — przywrócenie kontraktu autosave w eksporcie

CI końcowego `cf54c6b5de72e1ab5ead82d58ef989fff88687f3` potwierdziło 127 scene/eigen, 45 Gmsh i 20 Göbel contracts, lecz checker output storage nie mógł zaimportować `_scene_stage_autosave`. Helper wydzielono z istniejącego parsera `_render_scene_stage_autosave_suffix`, zachowując strict nested-field validation, cadence, aliases, defaults oraz None semantics. Renderer korzysta z tej samej ścieżki. Asercja quantity dla authored `name: "m"` oczekuje kanonicznego `m`, zgodnie z lowererem.

`python3 scripts/check_output_storage_contract.py`: **PASS, exit 0**, `output-storage interpreted contract: ok`. Niezależny review i diff check: **PASS**. Nie kompilowano lokalnych testów.

Pełny push-run scoped Gmsh przeszedł; PR-run zatrzymał się na jednej multi-object conformity regresji. Porównanie faktycznych checkoutów i przyczyny algorytmu jest w toku; nie obniżono wymagania conformal_occ. Końcowy build/runtime i integracja nadal blokowane przez wolne miejsce i niedostępny required FEM runner.


### Checkpoint — kontrola powtarzalności scoped Gmsh CI

PR-run `38646416166` (merge commit `72be6528...`) i push-run `38646406470` (`cf54c6b5...`) mają identyczny tree SHA i blob hashes meshera, testu oraz workflow. Używały Gmsh 4.15.2/Python 3.11.17 i tych samych zależności, ale różnych obrazów Ubuntu runnera. W jednym runie Cylinder + ArchWaveguide odrzucił zdegenerowane Tet4 w OCC, a fallback nie spełnił wymagania `conformal_occ`; drugi run przeszedł. Nowe source-plane seedowanie nie jest wywoływane przez ten przypadek.

Test `test_multi_object_sizing_cylinder_and_waveguide` z `FULLMAG_GMSH_THREADS=1`: **PASS, exit 0, 53.477 s**, przy zachowanych progach i konforemności. Log SHA256 `01fb0f197ae472dac6b94553d7161b5cabc15bc225365ae375edd021c2b31210`. Scoped CI przypina jeden wątek i rejestruje wersje, CPU/affinity oraz ustawienia wątków. Jest to ograniczenie zmienności scheduling w tej bramce, nie dowód ostatecznej przyczyny ani kwalifikacja produkcyjnego OCC. Production runtime parallelism pozostaje bez zmian. Pełny scoped zestaw oczekuje na nowe CI.

Końcowy obraz/HMR/GPU/session storage i integracja nadal **NOT VERIFIED**: ostatni pomiar C: 0.66 GiB wolnego, wymagane minimum runnera 8 GiB; required managed FEM runner offline/queued. Cache, źródła, wyniki i cudze zmiany zachowane.

Test fake konfiguratora izoluje tylko dwa ambient thread overrides; nie zmienia resolvera ani asercji requested=4. Dwa interpreted thread checks z ambient FULLMAG_GMSH_THREADS=1: **PASS, exit 0**. YAML, embedded Python i niezależny review: **PASS**. Timeout 15 min zachowano: poprzedni pełny job trwał 451.18 s, publiczny gate 281.58 s, 338-testowy zestaw 130.738 s.


### Checkpoint — pojedyncza synchronizacja outputów Study

Dla `surface == "study"` usunięto ponowne clear/redeclare po `_sync_stage_output_snapshot`. Flat/legacy zachowuje dotychczasową kolejność, a Stage bez Study metadata ma istniejący continue guard. Testów nie zmieniono.

`PYTHONPATH=packages/fullmag-py/src python3 -m pytest -q packages/fullmag-py/tests/test_script_builder_roundtrip.py packages/fullmag-py/tests/test_study_stages.py`: **82 PASS, 39 subtests PASS, exit 0, 92.88 s**. Exact output-storage checker: **PASS, exit 0**. Diff check i niezależny review: **PASS**. Pierwszy lokalny brak editable package odtworzono przez PYTHONPATH, bez zmiany suite.

Ponowny pomiar native Windows: **9.64 GiB wolnego**, minimum runnera spełnione. Retencja: zachowujemy cache przyrostowy, ostatni zweryfikowany pakiet b581, kapsuły, logi i receipty; brak autoryzowanego usuwania. Po commicie czystego źródła kolejnym krokiem jest managed GPU build, następnie obraz i dwa kontenery. Required Linux FEM runner nadal pozostaje niedostępny.


### Checkpoint — stabilna sygnatura magnetyczna przy paddingu AIR

Finalny scoped CI `38651245873` / job `116150299032` wykonał 338 testów: jeden stary test wymagał różnicy sygnatur po zmianie wyłącznie exterior AIR paddingu. Aktualne source-owner sizing/separacja magnetycznych i powietrznych intervalów daje identyczne sygnatury. Test wymaga teraz ich równości, zachowując marker, quantization, dodatnie liczności i pełny klucz node/tet/edge/digest. Nie zmieniono generatora ani asset pipeline; stara nazwa nie ma referencji w mapach/docs.

Przy `FULLMAG_GMSH_THREADS=1`: exact invariance fixture **PASS, exit 0, 1.307 s**; najbliższy frozen-signature consumer **PASS, exit 0, 34.541 s**. Native Git diff/check: **PASS**.

Managed job `5d3a5982650b47fea8b3f214caa959ea` nadal jest przypięty do czystego `fa60821af3da9285d6083f951ca3057d4b79f270`, source digest `011371071f6e6471d7e570e36335925c62eb50c27f93f6462ecd1c7d1ac61b4e`, snapshot `4173a13617362474f6484d2d330c7a14b22713cdeddb27289ab8db604bc7278c`. Odczyt otwartego pliku koordynatora potwierdził verify_source kapsuły 8686 plików/356489140 B. Worker/kompilacja nie były jeszcze potwierdzone w tym checkpointcie. Ta późniejsza korekta testu nie zmienia produkcyjnych źródeł budowanego pakietu. Pełny Python contracts job `116150299762` dla fa608 zakończył się success.


### Checkpoint — zgodne ustawienie wątków bramek Python

Scoped Gmsh CI `38654772329` przeszedł pełny zestaw 338 testów z `FULLMAG_GMSH_THREADS=1`. Bootstrap Python contracts `116161809040` nie miał tego ustawienia i otrzymał różne sygnatury w tej samej bramce invariance. Job `python-contracts` otrzymuje identyczne ustawienie jednego wątku; zakres pozostaje wyłącznie CI. YAML parse i kontrola diff: PASS. Nie powtarzano lokalnie pełnego zestawu ani nie kompilowano testów jednostkowych. Nowy wynik Bootstrap wymaga CI. Produkcyjne źródła pakietu fa608 pozostają bez zmian; tożsamości artefaktu nie przepisujemy na późniejszy commit.


### Checkpoint — izolacja bramki blokady manifestu

CI bdb74: pełny scoped Gmsh i Python contracts PASS. Ubuntu terminal-artifact-attestation `38657642161` / job `116171098417` miał 48 PASS i jeden błąd WouldBlock w eligible_attestation_read_failure_preserves_running_manifest_for_retry. Nie znaleziono dowodu wycieku guardu; krótkie dziedziczenie deskryptora przy równoległym fork/spawn pozostaje hipotezą, nie dowiedzioną przyczyną. Wyłącznie ten binarny zestaw CI otrzymuje --test-threads=1, aby izolować niezależne testy flock od testu tworzącego proces potomny. Test rzeczywistej blokady między procesami i wszystkie asercje pozostają aktywne; runtime i locki nie są zmieniane. YAML/parser i diff check PASS; kompilacja oraz wynik pozostają do potwierdzenia wyłącznie w CI.

Agent omyłkowo edytował workflow w main. Native Git wykazał wyłącznie własny dwuliniowy fragment; przeniesiono go do worktree zadania i odtworzono dokładny fragment main bez nadpisywania innych kroków ani cudzych zmian.


### Checkpoint — wznowienie po pełnym dysku i JSON mount recovery

Operator zwolnił miejsce; ostatni odczyt około84GiB na C:. Zatwierdzony restart Docker Desktop wymagał zatrzymania wyłącznie jego procesów i dystrybucji docker-desktop. Silnik29.8.1 odpowiada. GPU diagnostic w izolowanym kontenerze PASS: RTX4080SUPER. Root-only loop probe PASS: ext4 /dev/loop2, exact backing_file, unmount i detach potwierdzone; wcześniejszy probe używał domyślnego UID65532, więc jego odmowa nie była ograniczeniem Desktopa. Nie kwalifikuje to jeszcze FEM.

Przyczyną fałszywej odmowy recovery joba5d3 jest obsolete konwersja JSON list montowań do tuple w reconcile_build; mount_identity zwraca listy. Usunięto wyłącznie tę konwersję. Real reconcile z fakeDocker po JSONroundtrip przechodzi pełne attestation i nadal odrzuca tampered mount. Zestaw interpreted build-executor:28PASS. Root review diff:PASS.

Wdrożony stary koordynator nie potrafi terminalizować confirmed exited2 workera, a normalny replace wymaga idle. Przygotowano tymczasowy jednorazowy helper dla tego samego koordynatora z przypiętym job/container/worktree/profile, exact SHA starej i naprawionej funkcji, read-only DB preflight oraz explicit guards. Dry-run:PASS, bez zmiany stanu. Ewentualne apply ma wywołać zwykłe locks/attest/finish_build, nie edytować ręcznie DB/journal/lease. Helper SHA256 5fbb95a900b9b6075af51c331b413b0ace0154bf7aaa345e5ded33687117536d. Wymagane są niezależny review, pause przed apply oraz normalny replace koordynatora po terminalizacji; wykonanie i końcowy build pozostają NOT VERIFIED.


### Checkpoint — materializacja aplikacji i trwałe recovery

Finalny Bootstrap0e5 miał101PASS/9FAIL w application materialization/eigen selector, bez błędu kompilacji. Naprawiono lokalne fixtures: deterministyczny run_id szablonu, aktualny tekst guardu, istniejący kanoniczny Zhang–Li v1 oraz lokalny minimalny MeshIR dla testów materializacji FEM. Wspólny accepted fixture nie został zmieniony. Trzy błędy anten wymagały poprawki produkcyjnej: zbiór deklarowanych stage IDs obejmuje teraz również children. Zachowano deklaracje top-level/disabled oraz odmowę unknown ID; nie zmieniono fizyki, schematów ani kryteriów walidacji anten. JSON/source hygiene PASS, nowe sekcje formatowania zgodne; pełny rustfmt wskazuje istniejący drift poza zmianą. Rust/Cargo nie uruchamiano lokalnie; behavior/compile proof oczekuje na CI. Root review źródłowego diff PASS, niezależny review w toku.

Po niezależnym review i dry-run helper recovery5fbb... zastosowano dokładny one-line fix w jednorazowym procesie ISTNIEJĄCEGO koordynatora przy paused admission. Oryginalne locks/attestation/finish_build zapisały worker.log/receipt.json, potem queue.finish: job5d3 terminal failed/exit2. Nie ręcznie edytowano DB/journal/lease. Następnie normalny just runner-container-replace wdrożył obraz sha256:d6ed446684ec506ed70147f2b0c226f24d99c98384134d98bfd612ef3436910e, kontener df21b0655db7. Klient zwrócił niejednoznaczny błąd lifecycle lock po faktycznej wymianie; nie ponawiano mutacji. Dockerinspect/API i exact corrected function SHA75deb26917451103fb27bf523a4a442201c1053db1810510dfa62169a980d49a potwierdziły wdrożenie. Health ok=true, paused, brak aktywnych jobów i worker_error=null. Kolejny krok: clean commit, managed GPU build, obraz i realne runtime/HMR/FMS próby oraz odrębna kwalifikacja CI.


### Checkpoint — izolowany routing wykonawcy CI

Pełny build ba4e2e18382e473eb9db68f9dd5600f0 działa dla czystego commita 428780137ba8a01384e0ae43e9baf04931e5692e. Health koordynatora: ok=true, worker_alive=true, worker_error=null. Bieżące CI: Python/Control Room/scoped-mesh/dispersion/contract/docs PASS; Rust w toku. Wynik pakietu i runtime pozostają NOT VERIFIED.

Ostatnia etykieta runs-on korzysta z repo variable FULLMAG_FEM_RUNNER_LABEL z dotychczasowym fallbackiem fem-managed. Pozwala skierować nowy run do ephemeral fem-managed-docker bez przejmowania 29 cudzych oczekujących jobów. Zachowano pełną bramkę, job key, env i kody wyjścia; kontrakt linux-ext4-loop-v1 pozostaje bez zmian. YAML/source/guide interpreted check i native Git diff check PASS. Nie uruchamiano Cargo ani lokalnej kompilacji testów. Zmienna repozytorium nie istnieje; nie została jeszcze utworzona. Operator artifacts i rzeczywista kwalifikacja nadal w przygotowaniu. Ten fragment dotyczy wyłącznie CI/docs/testu źródłowego i nie zmienia kapsuły budowanego pakietu 4287801.


### Checkpoint — zgodność pozostałych fixture materializacji

CI428 Bootstrap38695285731 / Rust116290304934: materializacja106PASS/4FAIL. Pozostałe błędy dotyczą testowych danych: Zhang–Li fullmag/FEM wybrany w FDM oraz fixed_timestep1e-13 ponad limit1.74879e-14 lokalnej siatki. Fixture FDM używa teraz kanonicznego zhang_li.mumax3.v1 i jawnego object_id/target; lokalny fixture FEM ma typowaną siatkę oraz fixed_timestep1e-15. Produkcyjny materializer, katalog capability i guard numeryczny pozostają bez zmian. Wspólny accepted fixture nie jest zmieniany. JSON/source checks, rustfmt parser i native diff check PASS; niezależna implementacja i root review PASS. Kompilacja/testy Rust wyłącznie w kolejnym wymaganym CI. Pakiet managed ba4e pozostaje przypięty do4287801, bo późniejsze zmiany obejmują tylko CI/docs/fixtures.


### Checkpoint — kolejka CI i gotowość wykonawcy

Doprecyzowano, że repo variable wybiera etykietę kolejki; gotowość środowiska jest wymagana przed rejestracją/startem wykonawcy. Nie zmieniono bramki ani jej preflightu. GitHub potwierdził0 runnerów i brak zmiennej; ustawienie dedykowanej etykiety pozwoli uruchomić pozostałe CI bez czekania na wolny pierwszy git status przez9p. Actual UID1001 probes Docker29.8.1/RTX4080SUPER/ext4-loop/exact backing PASS; Python bootstrap w toku. Pełna kwalifikacja FEM pozostaje NOT VERIFIED. Doc diff/source check PASS.
