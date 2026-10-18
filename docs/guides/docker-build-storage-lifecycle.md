# Docker DEV — budowanie, zapis danych i retencja

Stan audytu: 18.10.2026. Ten dokument opisuje bieżącą implementację i jej
ograniczenia. Instrukcja startu: [architektura Docker DEV](docker-development-architecture.md).
Polityka nadrzędna: [build-storage governance](fullmag-build-storage-governance.md).

Aktualizacja celu 18.10.2026: użytkownik wymaga przeniesienia wszystkich danych
budowania do Docker named volumes / BuildKit; sesje, wyniki i ustawienia
pozostają na Windows. [Skill budowania](../../.agents/skills/fullmag-docker-build/SKILL.md)
opisuje ten kontrakt i kontrolę zgodności. Poniższy audyt opisuje stan bazowy;
nie jest deklaracją, że migracja zapisów hostowych została wykonana.

**Nie mamy jeszcze kompletnego automatycznego sprzątania storage.** Kod usuwa
zweryfikowane starsze pakiety backendu i nieosiągalne techniczne snapshoty
ledgera. Nie usuwa automatycznie starych generacji cache, obrazów, katalogów
uruchomień ani wszystkich pozostałości po awarii. Samo używanie Dockera nie
ogranicza zużycia fizycznego dysku Windows.

## 1. Dwa etapy budowania w jednej grupie

Wybieramy jeden zarejestrowany checkout. Główny checkout otrzymuje grupę
`fullmag-master`, worktree — `fullmag-worktree-<worktree-id>`. W obu etapach
poniżej ma to być ta sama grupa, ustalona przez resolver.

| Etap | Polecenie | Co faktycznie buduje | Gdzie obserwować |
| --- | --- | --- | --- |
| Przygotowanie zależności | `just docker-dev-toolchain` | Obraz toolchaina z CUDA, MFEM, hypre, libCEED i pozostałymi przypiętymi zależnościami; bez aplikacyjnego źródła Fullmaga | Wyjście polecenia / Docker Desktop Builds; receipt bootstrapu |
| Codzienna praca | `just docker-dev ...` | Stały `backend` sprawdza źródła, kompiluje aplikację przyrostowo i uruchamia API/runtime. Stały `frontend` instaluje przypięte zależności JS w swoim cache i uruchamia Next/HMR | Docker Desktop → wybrana grupa → Logs właściwej usługi |

Toolchain jest obrazem budowanym przez **Docker Compose build / BuildKit**.
Nie jest trzecią stałą usługą aplikacji ani osobnym `backend-build`.
BuildKit może używać własnych zasobów technicznych silnika: nazwa projektu
Compose nie oznacza, że każdy krok Dockerfile jest procesem działającego
kontenera `backend`. Nie uruchamiamy `fem-gpu-toolchain` przez `compose up` jako
zastępczego backendu. Krótkie zarządzane kontrole storage/manifestów pozostają
operacjami utrzymania przypisanymi do grupy, bez wykonywania symulacji.

`just docker-dev-toolchain` przekazuje `--direct-development`: ta flaga wybiera
projekt checkoutu. Sam bootstrap bez niej należy do osobnej trasy pierwszej
konfiguracji hosta i używa `fullmag-toolchain`; nie jest odpowiednikiem recepty
DEV. Również `docker-dev up` może przed startem usług przygotować przez BuildKit
obrazy development-base i helper/runtime wrapper, jeżeli nie ma zgodnego
przypiętego obrazu. To nadal budowa środowiska kontenera; kod aplikacji
kompiluje dopiero stały `backend`.

Obraz zależności przygotowujemy na nowym hoście lub po zmianie jego wejść.
Zwykła edycja Rust/TypeScript nie wymaga ponownego budowania bibliotek CUDA/FEM.
Deklaracje wersji: `docker/fem-gpu/Dockerfile`, `rust-toolchain.toml`,
`Cargo.lock`, manifesty Python/JS i `pnpm-lock.yaml`. Obraz zapisuje manifest
`/opt/fullmag-deps/share/fullmag/dependency-versions.json`.

## 2. Gdzie trafiają dane

W tabeli `<storage>` oznacza `FULLMAG_PROJECT_STORAGE_ROOT` z lokalnego `.env`
głównego checkoutu, odczytanego przez resolver. `<worktree-id>` jest tożsamością
Git/resolvera; `<run-id>` jest tożsamością uruchomienia, nie kluczem cache.
Ścieżka wewnątrz Dockera nie jest dodatkowym dyskiem fizycznym.

| Dane | Miejsce / mount | Trwałość i izolacja |
| --- | --- | --- |
| Źródła i Git | Wybrany checkout → `/opt/fullmag/source`, Git common → `/opt/fullmag/source-git`; readonly | Jeden wybór dla obu usług. Źródła pozostają na Windows |
| Backend: build v2 | Named volume `fullmag-backend-v2-<24hex>-build` → `/build` | Prywatny trwały cache checkoutu/profilu/toolchaina, w dysku danych Docker Desktop |
| Cień źródeł backendu | `/build/workspace`; aktualny manifest `/build/.fullmag-live-source/manifest.json` | Stabilny workspace synchronizowany przy starcie. Manifest zastępowany, nie katalog na każdy commit |
| Rust/CMake | `/build/workspace/.fullmag-build/cargo-targets/direct/<cargo-profile>`; osobne `fullmag-fdm-sys-stable/out/native-build` i `fullmag-fem-sys-stable/out/native-build` pod `build/`; `CARGO_HOME=/build/cargo` | Zachowany cache. W komendach Cargo `/workspace` jest aliasem workspace; nie osobną kopią na hoście |
| Zainstalowany wynik kompilacji | `/build/workspace/.fullmag/local` | Techniczne wyjście Make; odrębne od zweryfikowanego pakietu runtime |
| Backend: pakiet v2 | Named volume `fullmag-backend-v2-<24hex>-package` → `/opt/fullmag/package` | Bieżący zweryfikowany pakiet, kontrola publikacji i rollback; bez transferu przez Windows |
| Frontend: zależności i Next | `<storage>/build-volumes/fullmag-frontend-cache-v1-<key>.ext4`; po zamontowaniu cztery podkatalogi cache/pnpm/node_modules | Plik ext4 o pojemności logicznej 8 GiB. Nie jest named volume backendu v2 |
| Frontend: live kod | `app`, `src`, `public`, `scripts` z checkoutu → readonly pod `/state/development/workspace/apps/control-room` | HMR czyta pliki Windows. Wygenerowane pliki i Linux `node_modules` nie trafiają do checkoutu |
| Uruchomienie, sesje i wyniki | `<storage>/runs/<worktree-id>/docker-all/<run-id>/state` → `/state` backendu; frontend dostaje jego `development` | Fizyczne pliki Windows. Restart istniejącego kontenera zachowuje mount; nowy run ma własny namespace |
| Ustawienia i ostatnie projekty | `<storage>/user-data/<compose-project>/workspace.db` → `/user-data` | Trwałe, osobne dla mastera i każdego worktree |
| Fizyczne rezerwacje CPU/GPU | Zarządzany ext4 `host-ledger-v1` → `/host-ledger` wyłącznie backendu | Wspólny ledger hosta. Izolacja grup nie tworzy dodatkowego fizycznego GPU |
| Wejścia launchera/provenance | `<storage>/builds/<worktree-id>/docker-all-gpu/direct-compose/<id>` i katalog runu | Małe manifesty, przypięte obrazy, wygenerowany Compose, certyfikaty i receipty. To nie Cargo target |
| Bootstrap zależności | Katalog runu `toolchain-bootstrap-<id>` z kontekstem Dockerfile i receipt | Techniczne wejścia obrazu, nie archiwum pełnych źródeł aplikacji DEV |
| Obrazy i BuildKit | Wewnętrzny magazyn Docker Desktop | CUDA/FEM, wrapper i warstwy budowania współdzielą fizyczną pojemność hosta; poza katalogiem sesji |
| Bufory tymczasowe | `/tmp` tmpfs usług, do 512 MiB każda | Ulotne; nie są miejscem trwałego cache ani pakietów |

`fullmag.backend-build-cache.v2` wylicza parę wolumenów z checkoutu/worktree,
toolchaina i profilu Cargo. Zmiana wrapper image sama nie zmienia tej pary.
Zwykła zmiana źródeł również nie tworzy nowej pary. Nowy toolchain/profil lub
inny worktree może utworzyć kolejną generację; poprzednia pozostaje.
Fragment nazwy `<24hex>` jest skrótem hasha; pełna tożsamość jest w labels i
receipcie. Pełna ścieżka każdego native cache to
`/build/workspace/.fullmag-build/cargo-targets/direct/<profile>/build/<crate>/out/native-build`,
gdzie `<crate>` oznacza `fullmag-fdm-sys-stable` lub `fullmag-fem-sys-stable`.

Cache frontendu zależy od checkoutu, worktree, **portu**, manifestów zależności
i pinów narzędzi. Edycja TS/CSS nie tworzy nowego pliku ext4; zmiana portu lub
lockfile może go utworzyć. Zmiana interwału Watchpack nie rotuje tego cache.

Stary backend v1 używał pliku ext4 w `build-volumes`. Nie należy utożsamiać go
z aktywną parą v2 ani usuwać jako efektu migracji. Starsze/frozen ścieżki mogą
mieć source capsules pod `runs/<worktree-id>/<capture-id>/source` i staging
obrazów pod `builds/.../images` / `runtimes/.../docker-all-images`. Nie są to
nowe archiwa źródeł wykonywane przy każdym restarcie bezpośredniego DEV.

## 3. Procedura startu i kolejnej iteracji

1. Na nowym klonie skonfiguruj storage, źródła i port przez
   `python -B scripts/setup_docker.py`; sprawdź `--check`. Nie kopiuj `.env`
   innego hosta ani nie wybieraj storage przez przypadkowy fallback.
2. Przejdź do **wybranego checkoutu**, następnie uruchom oba etapy z niego:

   ```powershell
   Set-Location $source
   just docker-dev-toolchain
   just docker-dev "$source" 3197
   # Alternatywnie uruchom model z pliku z tego samego checkoutu:
   just docker-dev "$source" 3197 "examples/fem_relax_gpu_smoke.py"
   ```

   Nie wykonuj pierwszego polecenia w masterze, jeżeli drugim wybierasz inny
   worktree. Odpowiednik bez `just` musi przekazać `$source` jako `--repo-root`
   bootstrapu; to ten argument ustala grupę toolchaina.
3. Launcher rozwiązuje grupę, port, sieć, storage i przypięte obrazy; sprawdza
   istniejących konsumentów, przygotowuje/reużywa cache i zapisuje receipty.
   Nie przejmuje obcej grupy. Backend ma wewnętrzne `8081`; tylko frontend
   wystawia wybrany port loopback.
4. Przy każdym starcie backend pod blokadą cache odczytuje aktualny readonly
   checkout i tworzy spójny manifest. Przy zgodnym pakiecie przechodzi ścieżką
   `phase=start state=cache-hit` do API. Przy zmianie uzgadnia cień ext4,
   zachowuje metadane niezmienionych plików i uruchamia przyrostowy Make/Cargo.
5. Zmieniony kod oraz rzeczywiści zależni konsumenci mogą wymagać kompilacji.
   Nie obiecujemy przebudowy wyłącznie jednego crate ani czasu kilku sekund.
   Zmiana wspólnych typów, build-info, flag czy kompilatora poszerza zakres.
   Pełny digest źródeł obejmuje też frontend: jego edycja może ominąć szybkie
   użycie pakietu i wejść ponownie w Make/publikację, mimo zachowanego cache
   kompilacji natywnej. To znana granica obecnej optymalizacji.
6. Nowy pakiet powstaje w prywatnym kandydacie. Po walidacji i trwałej
   publikacji poprzedni staje się rollbackiem. Dopiero potem wykonuje się
   retencja starszych pakietów. Błąd kompilacji nie uruchamia nowego API;
   poprzedni zweryfikowany pakiet zostaje zachowany.
7. Frontend reaguje przez HMR. Zmiany backendu stosujemy przez restart
   **backendu tej grupy**, po zapisaniu projektu i zakończeniu symulacji.
   Restart nie tworzy z założenia nowego cache ani nie powtarza Solve skryptu.
   Zmiana obrazu/mountów może wymagać kontrolowanego odtworzenia usługi.
8. Po etapie sprawdź wynik i receipt, stan cache/retencji oraz wolne miejsce.
   Nie uznawaj stanu `Running` kontenera za potwierdzenie gotowości API.

Profil aplikacji DEV to `backend-dev`; `docker-all-gpu` pozostaje nazwą
pełnego profilu builda. Dostępność GPU w runtime i wybór solvera są osobnymi
decyzjami. Release korzysta z zamrożonych wejść i osobnej kwalifikacji; nie
zastępuje tej ścieżki przyrostowej. Eksport obrazu do TAR dla transportu offline
nie jest etapem codziennego startu DEV.

## 4. Co sprzątamy automatycznie, a co pozostaje

| Klasa danych | Obecny mechanizm | Granica / ryzyko wzrostu |
| --- | --- | --- |
| Binarne pakiety backendu | Po udanej publikacji: bieżący + jeden bezpośredni rollback; starsze potwierdzone backupy usuwane od najstarszego | Tylko poprawny łańcuch receiptów/rotacji pod blokadą. Nieznane/uszkodzone dane pozostają; `retention skipped` wymaga sprawdzenia |
| Dowody usuniętych pakietów | Receipt, rotacja i log archiwizowane w `/opt/fullmag/package/.development/retired` przed usunięciem binariów | Brak limitu wieku/rozmiaru archiwum; małe metadane i logi nadal narastają |
| Normalny staging kandydata/kopii | `finally` usuwa własne tymczasowe drzewa po powrocie operacji | Przerwanie procesu/zasilania może pozostawić `.backend-package-candidate-*`, `.backend-capsule-*`, `.manifest.*.tmp`; brak ogólnego sweepu. Przy niepewnym rollbacku zachowujemy dowody |
| Cień źródeł | Uzgodnienie jednego workspace, usunięcie usuniętych plików źródłowych | Nie kasuje używanego cache Cargo/CMake. Jeden aktualny manifest zamiast historii snapshotów źródeł |
| Snapshoty host-ledgera | Ograniczony GC pod blokadą po publikacji/operacjach ledgera | Usuwa wyłącznie bezpieczne nieosiągalne CAS `snapshot` i `snapshot-order-v2`; zachowuje bieżący digest. Limit inspekcji 256 wpisów na katalog/wywołanie |
| Rezerwacje, readiness i recovery | Zachowanie historii i dowodów | Powyższy GC nie usuwa historii rezerwacji, CAS readiness ani sesji |
| Cargo/CMake/pnpm/Next | Ponowne użycie trwałego cache | Brak ogólnego limitu ani GC starych generacji. Cargo target może rosnąć wraz z wariantami grafu/flag |
| Backend v1/v2 i frontend ext4 | Jawne przygotowanie/reuse dokładnej tożsamości | Adaptery nie usuwają starych wolumenów/backing files. Nowa generacja nie dowodzi zbędności poprzedniej |
| Runy, logi, receipty, failed/unknown | Zachowanie do diagnozy i provenance | Brak pełnej automatycznej retencji tej ścieżki; kolejne uruchomienia zwiększają liczbę katalogów |
| Sesje, projekty, wyniki, `workspace.db` | Trwałe dane użytkownika | Wyłączone ze sprzątania technicznego |
| Obrazy / BuildKit / stare grupy | Brak automatycznego globalnego czyszczenia Fullmaga | Zatrzymany kontener nadal może referencjonować obraz/cache; inna grupa może go używać |

Retencja pakietów jest zaimplementowana i ma testy wykonywalne. Jej wykonanie
na kolejnych **rzeczywistych pakietach obecnej grupy v2** pozostaje
**NOT VERIFIED**. Nie wolno zamieniać tej informacji na deklarację, że cały
storage jest już ograniczony automatycznym limitem.

Osobny `just prune-managed-fem-runtimes apply=0 keep_per_family=2` jest
dry-runem retencji zarządzanych runtime'ów FEM. Nie czyści automatycznie
cache Compose, wszystkich katalogów `runs` ani dysku Docker Desktop.
`apply=1` wymaga sprawdzenia dokładnego planu i autoryzacji; nie jest krokiem
zwykłego restartu DEV.

## 5. Miejsce na dysku i bezpieczne utrzymanie

Sprawdzamy osobno fizyczny wolny dysk hosta, wolne miejsce wewnątrz ext4/
Docker VM oraz rozmiary należących do zadania artefaktów. Duży limit wirtualnego
dysku Dockera nie dostarcza wolnego miejsca na pełnym dysku Windows.
Pojemność logiczna `.ext4`/VHDX, faktycznie zaalokowane bajty i bajty możliwe
do odzyskania to trzy różne pomiary. Nie sumuj rozmiarów logicznych jako
„tyle można skasować”. Usunięcie plików wewnątrz VM nie dowodzi automatycznego
zmniejszenia hostowego pliku dysku.

Obecny preflight frontendu na Windows wymaga minimum 16 GiB wolnego przy nowym
cache (8 GiB pliku + 8 GiB headroom), a 8 GiB przy istniejącym. Sprawdza miejsce
przed i po przygotowaniu. To dolny próg, **nie estymacja zimnego builda**.
Adapter backendu v2 waliduje wolumeny/receipty, ale nie estymuje całego Cargo
targetu. Backend przed kandydatem może oszacować miejsce na podstawie poprzedniego
pakietu; pierwszy build nie ma takiego odniesienia. Storage probe sprawdza
semantykę zapisu/locków/SQLite, nie zastępuje pomiaru pojemności.

Procedura sprzątania wymaga:

1. Zidentyfikowania dokładnej grupy, źródeł, profilu, cache i właściciela.
2. Inwentaryzacji procesów, wszystkich kontenerów/mountów, lease, rezerwacji,
   rollbacku i referencji wyników. Wiek/nazwa/`reclaimable` nie wystarczają.
3. Planu dry-run z konkretnymi celami i zmierzonymi bajtami; przy nieznanym
   właścicielu/referencji zachowania danych i zapisania przyczyny.
4. Wykonania wyłącznie autoryzowanego zakresu po ponownym sprawdzeniu użycia,
   pod właściwą blokadą, z zachowaniem receiptów i provenance.
5. Raportu wykonania oraz pomiaru wolnego miejsca przed/po.

Nie używamy globalnego `docker system prune`, usuwania volumes ani kasowania
`target` jako rutynowego odzyskiwania miejsca. Skill
`fullmag-build-stage-cleanup` nie był dostępny podczas tego audytu; zastosowano
reguły retencji z build-storage governance, bez usuwania danych użytkownika.

## 6. Wynik weryfikacji 18.10.2026

Źródła audytu: baza `f57b9e59346edf18eda4a38d671cb8361e3a1512`; równoległe
zmiany CPU są WIP i nie stanowią dowodu gotowego backendu.

- Docker inspect potwierdził frontend działający/healthy, readonly źródła,
  cztery bindy cache ext4 i backend **exited** z parą named volumes v2,
  `/state` Windows, `/user-data` grupy oraz wspólnym `/host-ledger`.
- Na hoście było około **68,84 GiB wolnego na C:** w chwili pomiaru. W
  `build-volumes` wykryto stary backend 50 GiB, cztery frontendowe pliki po
  8 GiB i ledger 128 MiB — **rozmiary logiczne, nie miejsce do odzyskania**.
- 15 celowanych testów Python retencji, błędów publikacji i reuse workspace
  przeszło w istniejącym kontenerze, na tymczasowych fixture'ach ext4.
  Pierwsza próba w `/tmp` została odrzucona przez `noexec`; zachowano oba
  wyniki. Testy nie kompilowały Rust ani nie usuwały rzeczywistych pakietów.
- Zweryfikowano zgodność źródeł, mountów i procedury. **NOT VERIFIED:** pełny
  nowy build/start backendu v2, rzeczywisty restart cache-hit, pomiar małej
  zmiany modułu oraz retencja po wielu produkowanych pakietach.
- Znane luki: brak GC starych generacji cache/obrazów, ograniczenia archiwów
  logów/runów oraz odzyskiwania orphan staging. Potrzebują osobnej,
  kontrolowanej implementacji; ten audyt ich nie wdraża.

Dowody lokalne, względem `<storage>`:

- `cache/tmp/docker-build-storage-lifecycle-audit-20261018.json` — stan/mounty,
  etykiety dwóch wolumenów, ograniczona inwentaryzacja i wolne miejsce;
- `cache/tmp/docker-build-storage-lifecycle-checks-20261018.json` — pierwsza
  próba w `noexec`;
- `cache/tmp/docker-build-storage-lifecycle-checks-r2-20261018.json` — 15/15 PASS.

Nie usunięto rzeczywistych cache, wolumenów, wyników ani historii. Lokalny
raport nie jest deklaracją zajętości/retencji na innym komputerze.

## 7. Punkty kontrolne implementacji

- [`compose.dev.yaml`](../../compose.dev.yaml) — usługi i bazowe mounty;
- [`bootstrap_docker_toolchain.py`](../../scripts/bootstrap_docker_toolchain.py)
  `compose_project`, `build` — grupa i receipt BuildKit/Compose;
- [`docker_backend_volume_cache.py`](../../scripts/docker_backend_volume_cache.py)
  `prepare`, `validate` — tożsamość/reuse pary v2, bez prune;
- [`backend_source.py`](../../docker/all-in-one/backend_source.py)
  `capture_live_source_manifest` — aktualny manifest;
- [`backend_dev.py`](../../docker/all-in-one/backend_dev.py)
  `_start`, `_build_environment`, `_retain_package_backups` — build, publikacja,
  rollback i retencja;
- [`docker_frontend_cache.py`](../../scripts/docker_frontend_cache.py)
  `cache_key`, `_require_cache_capacity`, `prepare` — frontend ext4;
- [`host_resource_ledger.rs`](../../crates/fullmag-session/src/host_resource_ledger.rs)
  — ograniczone sprzątanie technicznych CAS, bez kasowania rezerwacji;
- [`test_docker_backend_dev.py`](../../scripts/test_docker_backend_dev.py)
  — wykonywalne regresje publikacji i retencji.
