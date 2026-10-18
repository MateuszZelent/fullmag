# Audyt writerów — stan bazowy 18.10.2026

Odczyt źródeł na bazie `dc2bc2698e2c72d254bc8b3edd709c32441825cf`
z niezacommitowanymi zmianami CPU w launcherach/Compose. Tożsamość worktree
sprawdzono natywnym Git dla Windows; WSL Git nie interpretuje jego Windowsowego
wskaźnika `.git`. Numery linii odnoszą się do tego odczytu. To mapa do ponownej
weryfikacji przy zmianie kodu, nie dowód uruchomienia wszystkich tras.

## Wynik

Obecna ścieżka nie spełnia granicy „wszystkie dane budowania wyłącznie w Docker
named volumes/BuildKit, dane użytkownika runtime na Windows”. Backend v2 ma
prawidłową parę named volumes dla `/build` i `/opt/fullmag/package`, a właściwy
`backend_dev.py` zapisuje cień źródeł, Cargo/CMake, staging i pakiet w tych
wolumenach. Granica jest jednak obchodzona przez warstwę przygotowawczą:

- bootstrap toolchaina zapisuje kontekst, render Compose, logi, manifesty i
  receipty w hostowym `storage/runs` oraz `storage/index`;
- `docker_dev.py` zapisuje per-run konteksty obrazów, `iidfile`, logi, overlaye,
  receipty i metadata index w hostowym `storage/builds/.../direct-compose`;
- `compose.dev.yaml` nadal montuje writable provenance z Windows;
- frontend v1 używa hostowego pliku ext4 8 GiB jako backing file czterech bindów,
  a bazowy `/state/development` pozostaje bindem Windows z frozen inputs,
  receiptem i `next.log`;
- release/frozen oraz starsze trasy `compose.yaml`, `compose.windows.yaml`,
  `compose.backend-build*.yaml` i backend/frontend cache v1 nadal mają hostowe
  targety build/cache/package.

Named volume nie oznacza zatem, że cały przebieg buildu jest wolumen-only. Audyt
mountów końcowych usług nie obejmuje writerów hostowego launchera ani alokacji
BuildKit, więc sam PASS takiego audytu jest tylko częściowy.

## Mapa writerów i trwałości

| Artefakt | Writer i dowód w źródle | Obecna lokalizacja | Trwałość, duplikacja, ocena |
|---|---|---|---|
| Checkout/Git | `compose.dev.yaml:67-80` montuje wybrany checkout i Git common readonly | Windows checkout → `/opt/fullmag/source`, `/opt/fullmag/source-git` | To wejście, nie artefakt buildu. Jedna kopia źródła jest prawidłowa. |
| Cień backendu | `backend_dev.py:921-1024` synchronizuje `/build/workspace` i usuwa wyłącznie nieaktualne pliki źródłowe | Named volume `/build` | Prawidłowa lokalizacja. Cache `.fullmag-build`, `.fullmag-cargo`, `.fullmag-rustup`, Cargo/CMake i `TMPDIR` są ustawiane pod `/build` (`backend_dev.py:1636-1705`). |
| Pakiet, kandydat, rollback | `backend_dev.py:442-518`, `1996-2068`, `2880-3015` | Named volume `/opt/fullmag/package` | Prawidłowy current + bezpośredni rollback pod blokadą. `.development/retired` archiwizuje receipt/rotation/log, ale nie ma limitu bajtów, liczby ani wieku; błąd walidacji może pozostawić cały łańcuch (`backend_dev.py:2275-2506`, `2974-2986`). |
| Log Make backendu | `backend_dev.py:2548-2578` zapisuje `direct-backend-build.log` i jednocześnie przekazuje strumień na stdout | Log w `/build/workspace/.fullmag/local` + Docker logging driver | Pełny strumień istnieje w dwóch miejscach. Brak sprawdzonej retencji logu/Docker drivera. |
| Runtime provenance | `backend_dev.py:2739-2803` publikuje `/opt/fullmag/provenance.json`; zapis używa `O_RDWR` i `ftruncate` (`2806-2859`) | Host writable bind `${FULLMAG_PACKAGE_PROVENANCE}` → `/opt/fullmag/provenance.json` (`compose.dev.yaml:93-100`) | Narusza volume-only. To świadomy handoff do hostowego `run_root/provenance.json`, nie techniczny wyjątek runtime. |
| Backend cache control/overlay | `docker_dev.py:1235-1330` zapisuje `backend-cache-maintenance.json` i `backend-cache-overlay.json`; v2 helper generuje parę named volumes | Hostowy run root dla overlay/receipt; dane builda w named volumes | Dane sterujące są hostowe. `docker_backend_volume_cache.py:199-257` ma dobrą tożsamość i labels, ale `363-430`, `886-946` nadal wylicza i zapisuje canonical host receipt. Para nie ma GC (`738-766` tylko tworzy brakujące volume). |
| Toolchain context | `bootstrap_docker_toolchain.py:223-279` tworzy `runs_root/toolchain-bootstrap-<uuid>/context`, kopiuje wejścia (`capture_inputs`), renderuje `compose.json`, a `241-256` publikuje receipt/index | Hostowy `storage/runs` + `storage/index` | Każdy bootstrap może zostawić kontekst, Compose i receipt. Obraz/warstwy są dodatkowo w daemon image store/BuildKit. To co najmniej hostowa kopia kontekstu i metadata poza volume. |
| Toolchain log/manifest | `bootstrap_docker_toolchain.py:278-332` zachowuje wynik, `dependency-versions.json` i receipt; przy błędzie `323-331` jawnie zatrzymuje zasoby | Hostowy run toolchaina | Brak bounded retencji runów, logów, contextów i indexu. Ten sam obraz ma manifest w warstwie obrazu, a launcher utrzymuje dodatkową kopię. |
| Development-base context | `docker_dev.py:442-469` kopiuje `BASE_CONTEXT_FILES` do `run_root/development-base-context` i zapisuje JSON; `684-806` buduje z tego kontekstu i zapisuje hostowy log/iid/receipt | Hostowy `storage/builds/.../direct-compose/<uuid>` | Kontekst powstaje dla każdego runu nawet przy reuse obrazu; zawartość jest identyfikowana hashem, ale nie ma content-addressed reuse w Docker-managed control volume. |
| Runtime image context/build | `docker_dev.py:1122-1232` wylicza context, a przy braku obrazu `1195-1201` zapisuje `image-build.log`; `1227-1231` zapisuje receipt | Hostowy run root + hostowy `storage/index` (`571-595`) + daemon image/BuildKit | Image layers mogą być współdzielone przez digest, lecz tagi, run receipts, log i metadata narastają. Brak owned image/BuildKit GC. |
| Host launcher JSON | `_write_json` w `docker_dev.py:341-352`; `_environment` tworzy `state`, certificate, provenance i input files (`1373-1448`); start inputs `1879-2000` tworzy dalsze placeholdery/context | Hostowy run root | Małe pliki są nadal build-control/provenance. Nie powinny być w user-data ani hostowym build storage, jeżeli kontrakt wymaga Docker-only; powinny trafić do Docker-managed control volume. |
| Direct run metadata | `_new_run_root` (`docker_dev.py:877-887`) tworzy `builds/<worktree>/.../direct-compose/<uuid>`; runtime `fullmag_docker_runtime.py:2717-2785` zapisuje `receipt.json`, `compose.json`, assembly/start receipts | Hostowy `storage/builds` i `storage/runs` | UUID runu tworzy nowy katalog niezależnie od cache key. Bez bounded GC każdy start zostawia metadata i potencjalnie kopie overlay/context. |
| Frontend dependency/cache | `frontend_dev.py:61-78`, `736-754`, `1423-1458` zapisuje workspace, `.next`, pnpm store, pnpm home, Corepack, HOME i tmp pod `/state/development`; `compose.dev.yaml:165-168` montuje ten root jako writable host bind | Windows `${FULLMAG_STATE_ROOT}/development` | Narusza volume-only. Dodatkowe cztery podkatalogi są bindami ext4, lecz baza, frozen inputs, receipt i log pozostają na Windows. |
| Frontend ext4 backing | `docker_frontend_cache.py:268-294` wybiera `storage/build-volumes/fullmag-frontend-cache-v1-<key>.ext4`; `590-735` kopiuje helper/overlay do hostowego runu i tworzy host receipt; `docker_frontend_cache.sh:198-224` `truncate`/`mkfs.ext4`/loop-mountuje plik | Hostowy plik ext4 w `storage/build-volumes`, bindy do `/state/development/{cache,pnpm-store,...}` | To nie jest Docker named volume. Każdy nowy klucz zostawia plik; helper odmontowuje tylko po błędzie (`231-243`), nie usuwa backing image. |
| Frontend cache identity | `docker_frontend_cache.py:184-219` obejmuje `source_root`, worktree, **host_port**, dependency seed i toolpins | Jeden plik ext4 na pełny hash | Port nie zmienia pnpm/node_modules/Next artefaktów, więc powoduje niepotrzebne kopie przy zmianie portu. Należy oddzielić identity cache od runtime endpointu albo udowodnić wymóg izolacji. |
| Frontend log/receipt/frozen inputs | `frontend_dev.py:505-543` zapisuje frozen inputs, `1075-1118` receipt, `1168-1185` otwiera `next.log`; `1317-1333` drukuje lifecycle na stdout, a `1332+` tailuje plik | Windows `/state/development/{frozen-inputs,inputs-freeze.json,frontend-dev-receipt.json,next.log}` + Docker log | Techniczne dane buildu są na Windows. `next.log` jest pełnym append logiem bez rotacji; stdout jest kolejną kopią części strumienia. |
| Frozen/source archives | `docker_backend_inputs.py:729-798` zapisuje live manifest do `build_root/direct-backend-inputs/<capture_id>`; `800-856` tworzy staging i `backend-source.tar`/manifest | Hostowy `storage/builds/<worktree>/.../direct-backend-inputs` | Legacy/frozen trasa przechowuje pełne snapshoty per capture. `finally` usuwa tylko staging, nie finalne archive. W daily live-shadow nie jest to konieczne, ale recepty nadal istnieją. |
| Release/frozen package | `compose.backend-build.yaml:8-49` montuje hostowy source tar/manifest, writable `/state` i package; `compose.backend-build-live.yaml:5-50` montuje hostowy build state i package | Host storage przez bindy | Dozwolone tylko jako wyraźna release/legacy trasa, lecz nie może zostać omyłkowo użyte jako volume-only DEV. |
| Legacy backend v1 | `compose.backend-cache.yaml:20-25` montuje hostowy `/build`; `docker_backend_cache.sh:81-103`, `414-440` tworzy/growuje `storage/build-volumes/fullmag-backend-build-cache-v1-<key>.ext4` | Hostowy ext4 backing | Wersja v1 nie ma migracji ani GC; pozostaje po uruchomieniu v2. Nie wolno liczyć jej jako v2 named volume ani usuwać jako skutku migracji. |
| Legacy root/Windows Compose | `compose.yaml:9-25`, `54-85` oraz `compose.windows.yaml:17-50` montują checkout, `.fullmag-build`, Cargo target, `.fullmag-cache`, runtime, pnpm/node_modules i temp z hosta | Host checkout/storage | Jawne bypassy volume-only. Powinny być oznaczone legacy/non-DEV i zablokowane przez launcher ścieżki daily DEV. |
| Docker images/BuildKit | `compose.toolchain.yaml:5-24` i `_docker_live` (`docker_dev.py:761-772`, `1195-1201`) zlecają Compose/BuildKit build | Docker daemon image store/BuildKit | Trwa niezależnie od kontenera, named volume i hostowych receipts. Źródłowy host context nadal istnieje przed wysłaniem do daemon. Kod nie implementuje selektywnego GC obrazu/cache. |
| Runtime user data | `fullmag_docker_runtime.py:603-617` tworzy `storage/user-data/<compose-project>`; `compose.dev.yaml:101-116` montuje `/user-data` i `/state` | Windows storage | Sesje, modele/projekty, wyniki, ustawienia i historia mają pozostać na Windows (`docker-development-architecture.md:302-308`). To zakres chroniony przed build cleanupem. |
| Runtime technical cache | `fullmag_storage.py:440-464` nadal wyprowadza `CUDA_CACHE_PATH=cache/cuda`; legacy `compose.yaml:39-43` i `compose.windows.yaml:90-97` wskazują hostowy `.fullmag-cache`, a frontend `/state/development` zawiera HOME/tmp/Next/pnpm | Windows storage w legacy/current frontend route | To nie jest naukowy wynik ani ustawienie użytkownika. CUDA JIT/cache, Next/pnpm/node_modules, frozen inputs, build logs i technical receipts powinny zostać w Docker-managed volume. Nie wolno przenieść do Docker user-data sesji/results tylko dlatego, że oba są pod `/state`. |
| Host ledger | `compose.host-ledger.yaml:28-70` używa `privileged`, `pid: host`, `nsenter` i writable host backing; `docker_host_ledger.py:347-365` wymusza `storage/build-volumes` | Zarządzany host ext4/ledger | To współdzielona infrastruktura rezerwacji fizycznego hosta, nie build cache ani dane użytkownika. Zachować osobną własność, lease i historię; wyłączyć z build GC. |

## Socket i uprzywilejowane writer’y

Nie znaleziono w audytowanych Compose mountu `/var/run/docker.sock` ani
`/run/docker.sock`. Wręcz przeciwnie, `docker_backend_volume_cache.py:1121-1143`
odrzuca taki mount, a `docker/all-in-one/backend_volume_cache_maintenance.py:1-8`
deklaruje brak komunikacji z socketem. Nie należy więc raportować fikcyjnego
„kontenera z Docker socketem”.

Jest jednak realna granica własności: hostowy Python launcher uruchamia Docker
CLI i zapisuje hostowe receipts/contexts, a legacy/frontend/host-ledger
maintenance ma `privileged`, `pid: host`, `nsenter` i writable bindy
(`compose.host-ledger.yaml:28-70`; analogicznie cache v1). Te serwisy mogą pisać
hostowy backing z definicji i muszą pozostać osobno oznaczone, ograniczone do
zweryfikowanych ścieżek oraz wyłączone z „Docker volume-only” claimu. Przeniesienie
build artifacts do named volumes nie może przyznać backendowi socketu ani
szerszego host namespace.


Nie uruchamiano buildów, cleanupu ani pomiaru daemona w ramach tego audytu.
Pełne nazwy plików backend/frontend w tabeli są pod `docker/all-in-one/`;
pozostałe launchery pod `scripts/`. Bieżące zasady retencji opisuje
[kontrakt danych](artifact-policy.md).
