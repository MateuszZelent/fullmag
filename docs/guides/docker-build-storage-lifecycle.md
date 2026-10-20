# Docker DEV — budowanie, zapis danych i retencja

Stan audytu: 18.10.2026. Ten dokument opisuje bieżącą implementację i jej
ograniczenia. Instrukcja startu: [architektura Docker DEV](docker-development-architecture.md).
Polityka nadrzędna: [build-storage governance](fullmag-build-storage-governance.md).

Aktualizacja celu 18.10.2026: użytkownik wymaga przeniesienia wszystkich danych
budowania do Docker named volumes / BuildKit; sesje, wyniki, projekty, ustawienia
i historia pozostają na Windows. [Skill budowania](../../.agents/skills/fullmag-docker-build/SKILL.md)
opisuje ten kontrakt i kontrolę zgodności. Bieżąca ścieżka daily live-shadow DEV
prowadzi assembly, receipty buildu, manifesty i bieżące technical records przez
named control/package volumes grupy Compose. Frozen/static/release oraz legacy
zachowują odrębne hostowe metadata/logi zgodnie ze swoimi receptami; nie są luką
w ścieżce daily DEV. Brak rzeczywistego Docker build/restart/HMR proof pozostaje
**NOT VERIFIED**.

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
| Przygotowanie zależności | `just docker-dev-toolchain` | Obraz toolchaina z CUDA, MFEM, hypre, libCEED i pozostałymi przypiętymi zależnościami; bez aplikacyjnego źródła Fullmaga | Wyjście polecenia / Docker Desktop Builds; BuildKit i technical receipt grupy (**NOT VERIFIED** runtime) |
| Codzienna praca | `just docker-dev ...` | Stały `backend` sprawdza źródła, kompiluje aplikację przyrostowo i uruchamia API/runtime. Stały `frontend` instaluje przypięte zależności JS w swoim named cache i uruchamia Next/HMR | Docker Desktop → wybrana grupa → Logs właściwej usługi |

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
| Zainstalowany wynik kompilacji daily DEV | Kandydat w `.development/candidates/` pod `/opt/fullmag/package`, wybrany przez kontroler | Make zapisuje bezpośrednio do named package volume; brak dodatkowej pełnej kopii w `/build/workspace/.fullmag/local`. Istniejący legacy stage pozostaje zachowany |
| Backend: pakiet v2 | Named volume `fullmag-backend-v2-<24hex>-package` → `/opt/fullmag/package` | Bieżący zweryfikowany pakiet, kontrola publikacji i rollback; bez transferu przez Windows |
| Frontend: zależności, Next i HMR state | Named volume `<compose-project>-fullmag-frontend-dev-v2-<key>` → `/state/development`; control namespace → `/opt/fullmag/control` | Named volume grupy Compose dla pnpm, `node_modules`, Next cache, logów i diagnostycznej kopii receiptu; brak zapisu do Windows storage w ścieżce v2 (**NOT VERIFIED** runtime) |
| Frontend: bieżący owner procesu | `/run/fullmag/frontend-owner/receipt.json` w prywatnym tmpfs 1 MiB, UID/GID 65532, tryb 0700 | Ulotny autorytet procesu i wejście healthchecka; znika po zatrzymaniu kontenera. `/state/development/frontend-dev-receipt.json` zachowuje wyłącznie historię/cache, nie dowodzi żywego ownera. Wdrożenie źródłowe: [ADR 0061](../adr/0061-docker-development-build-and-runtime-container.md); restart runtime **NOT VERIFIED** |
| Frontend: live kod | `app`, `src`, `public`, `scripts` z checkoutu → readonly pod `/state/development/workspace/apps/control-room` | HMR czyta pliki Windows. Wygenerowane pliki i Linux `node_modules` nie trafiają do checkoutu |
| Uruchomienie, sesje i wyniki daily DEV | `<storage>/runs/<worktree-id>/docker-dev/<run-id>/state` → `/state` backendu; frontend dostaje jego `development` | Fizyczne pliki Windows. Restart istniejącego kontenera zachowuje mount; nowy run ma własny namespace |
| Ustawienia i ostatnie projekty | `<storage>/user-data/<compose-project>/workspace.db` → `/user-data` | Trwałe, osobne dla mastera i każdego worktree |
| Fizyczne rezerwacje CPU/GPU | Windows-backed, zarządzany ext4 `host-ledger-v1` → `/host-ledger` wyłącznie backendu; receipt/mount evidence w run root | Wspólny ledger hosta i operacyjny wyjątek dla storage; nie jest cachem ani stagingiem buildu. Izolacja grup nie tworzy dodatkowego fizycznego GPU |
| Assembly, provenance i receipty buildu daily live-shadow | Named control/package volumes grupy Compose oraz magazyn BuildKit | Manifesty wejścia, staging, receipty buildu i live technical records pozostają w danych technicznych Compose; brak rzeczywistego Docker proof pozostaje **NOT VERIFIED** |
| Runtime handoff i dane operacyjne | `<storage>/runs/<worktree-id>/docker-dev/<run-id>` oraz `/state` (legacy/frozen może używać `docker-all`) | Mały namespace na uruchomienie, sesje, wyniki i operacyjne dowody per-run, w tym `startup-provenance` i `runtime-recovery-consumed`; nie jest miejscem cache/stagingu buildu |
| Legacy/release build metadata | `<storage>/builds/...`, `<storage>/runtimes/...` według właściwej recepty | Dozwolone wyłącznie dla legacy, frozen, release lub native-managed profili; nie używać jako ścieżki codziennego Docker DEV |
| Obrazy i BuildKit | Wewnętrzny magazyn Docker Desktop | CUDA/FEM, wrapper i warstwy budowania współdzielą fizyczną pojemność hosta; poza katalogiem sesji |
| Bufory tymczasowe | `/tmp` tmpfs usług, do 512 MiB każda | Ulotne; nie są miejscem trwałego cache ani pakietów |

Certyfikat przyjęcia Windows storage, który służy wyłącznie do autoryzacji
mountu danych użytkownika, jest jawną operacyjną infrastrukturą i może pozostać
w run namespace. Nie jest to certyfikat ani receipt procesu budowania i nie
otwiera wyjątku dla zapisu cache, stagingu lub provenance buildu na hoście.

`fullmag.backend-build-cache.v2` wylicza parę wolumenów z checkoutu/worktree,
toolchaina i profilu Cargo. Zmiana wrapper image sama nie zmienia tej pary.
Zwykła zmiana źródeł również nie tworzy nowej pary. Nowy toolchain/profil lub
inny worktree może utworzyć kolejną generację; poprzednia pozostaje.
Fragment nazwy `<24hex>` jest skrótem hasha; pełna tożsamość jest w labels i
receipcie. Pełna ścieżka każdego native cache to
`/build/workspace/.fullmag-build/cargo-targets/direct/<profile>/build/<crate>/out/native-build`,
gdzie `<crate>` oznacza `fullmag-fdm-sys-stable` lub `fullmag-fem-sys-stable`.

Cache frontendu v2 zależy od checkoutu/worktree, manifestów zależności i pinów
narzędzi. Port jest zachowany w receipcie i konfiguracji endpointu, ale nie
powinien tworzyć nowego named volume. Edycja TS/CSS nie tworzy nowej generacji
cache; zmiana lockfile, dependency seed lub profilu może ją utworzyć. Zmiana
interwału Watchpack nie rotuje tego cache.

Stary backend v1 oraz historyczny frontend cache v1 używały plików ext4 w
`build-volumes`. Są to adaptery legacy i nie należy utożsamiać ich z aktywną
parą named volumes v2 ani usuwać ich jako skutku migracji. Starsze/frozen/release
ścieżki mogą mieć source capsules pod `runs/<worktree-id>/<capture-id>/source`
i staging obrazów pod `builds/.../images` / `runtimes/.../docker-all-images`.
Nie są to nowe archiwa źródeł wykonywane przy każdym restarcie bezpośredniego DEV.

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
3. Launcher rozwiązuje grupę, port, sieć, hostowy storage danych użytkownika,
   techniczne named volumes i przypięte obrazy; sprawdza istniejących
   konsumentów i przygotowuje/reużywa cache. W daily live-shadow assembly,
   provenance, receipty buildu i live technical records trafiają do control/
   package volumes; hostowy run root zachowuje wyłącznie pointery i dowody
   operacyjne uruchomienia. Frozen/static/release oraz legacy mogą zapisywać
   własne metadata/logi hostowe według odrębnych recept. Brak rzeczywistego
   Docker proof pozostaje **NOT VERIFIED**. Nie przejmuje obcej grupy. Backend ma
   wewnętrzne `8081`; tylko frontend wystawia wybrany port loopback.
4. Przy każdym starcie backend pod blokadą cache odczytuje aktualny readonly
   checkout i tworzy spójny manifest w technicznym wolumenie. Przy zgodnym
   pakiecie przechodzi ścieżką `phase=start state=cache-hit` do API. Przy zmianie
   uzgadnia cień named volume, zachowuje metadane niezmienionych plików i
   uruchamia przyrostowy Make/Cargo. Zgodność tej ścieżki z rzeczywistym
   uruchomieniem Docker pozostaje **NOT VERIFIED**; hostowe metadata/logi
   frozen/static/release nie zmieniają kontraktu daily live-shadow.
5. Zmieniony kod oraz rzeczywiści zależni konsumenci mogą wymagać kompilacji.
   Nie obiecujemy przebudowy wyłącznie jednego crate ani czasu kilku sekund.
   Zmiana wspólnych typów, build-info, flag czy kompilatora poszerza zakres.
   Pełny digest źródeł obejmuje też frontend: jego edycja może ominąć szybkie
   użycie pakietu i wejść ponownie w Make/publikację, mimo zachowanego cache
   kompilacji natywnej. To znana granica obecnej optymalizacji.
6. Nowy pakiet powstaje w prywatnym kandydacie named package volume. Po
   walidacji i trwałej publikacji poprzedni staje się rollbackiem. Dopiero
   potem wykonuje się retencja starszych pakietów. Błąd kompilacji nie uruchamia
   nowego API; poprzedni zweryfikowany pakiet zostaje zachowany. W daily
   live-shadow assembly/provenance i receipty pozostają w control/package
   volumes, a `startup-provenance`, `runtime-recovery-consumed`, host-ledger i
   certyfikat mountu są per-run operacyjnymi dowodami w Windows run root.

   W ścieżce backend-dev kontroler może przekazać Make prywatny
   `FULLMAG_INTERNAL_INSTALL_ROOT`, wskazujący wyłącznie na wcześniej utworzonego
   i oznaczonego właścicielem kandydata w named package volume. Make zapisuje tam
   wynik bez tworzenia drugiej kopii w `.fullmag/local`; istniejący legacy
   `.fullmag/local` pozostaje na miejscu i jest porównywany przez bounded snapshot
   metadanych przed/po materializacji źródeł oraz Make. Każda zmiana tej starej
   ścieżki kończy operację fail-closed. Przed rotacją kontroler materializuje
   dozwolone aliasy SONAME, sprawdza kompletny inwentarz, hashe, manifesty i
   marker kandydata. Zmienna jest usuwana z odziedziczonego środowiska i ustawiana
   tylko przez kontroler. Jedyny dodatkowy output Make `bin/fullmag` jest usuwany
   jako własny wrapper repo-local przed inwentarzem; po relokacji kandydata jego
   względne rooty repozytorium/runtime byłyby błędne. Domyślne, ręczne oraz
   release/static targety zachowują `.fullmag/local`. Dla direct DEV stdout Make
   od początku trafia do `/build/failed-candidate-diagnostics/<candidate>/`, a
   kontroler najpierw zapisuje terminalny receipt z hashem i rozmiarem, dopiero
   potem usuwa wyłącznie bounded, marker-owned inwentarz znanych outputów.
   Retencja obejmuje najwyżej 8 zakończonych błędów i 64 MiB logów; receipt
   pozostaje także po wycofaniu logu. Udany log jest kopiowany do kandydata i
   źródło techniczne jest usuwane dopiero po jego publikacji. Logi opcjonalne,
   częściowe receipty oraz nieznany, uszkodzony albo niekompletny do potwierdzenia
   kandydat pozostają i blokują publikację do ręcznej diagnostyki.
   Czas między przeniesieniem payloadu a usunięciem markera jest jawnie
   odzyskiwalny: następny preflight najpierw weryfikuje bieżący pakiet i jego
   rzeczywisty inwentarz z hasha receiptu, a potem usuwa wyłącznie marker-only
   kandydata z identycznym dowodem. Po przerwaniu tuż po unlink markera usuwa
   także wyłącznie pusty katalog o nazwie z własnej przestrzeni kandydatów;
   payload, dodatkowy wpis albo niezgodny hash pozostaje fail-closed. Cargo,
   CMake, runtime cache, rollback i dane użytkownika nie należą do tej ścieżki;
   sam routing nie jest dowodem odzyskania fizycznego miejsca na hoście.
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
| Binarne pakiety backendu | Po udanej publikacji w named package volume: bieżący + jeden bezpośredni rollback; starsze potwierdzone backupy usuwane od najstarszego | Tylko poprawny łańcuch receiptów/rotacji pod blokadą. Nieznane/uszkodzone dane pozostają; `retention skipped` wymaga sprawdzenia |
| Dowody usuniętych pakietów | Receipt i rotacja w `/opt/fullmag/package/.development/retired`; bez kopii pełnego build logu; najwyżej 8 archiwów i 64 MiB payloadu | Najnowsze wpisy zostają; starsze/za duże archiwa z manifestem i bezpiecznym drzewem są usuwane. Pełny legacy log jest hashowany tylko, gdy zachowane archiwum mieści się w budżecie |
| Logi stdout/stderr kontenerów DEV | Compose używa `json-file`, `max-size=10m`, `max-file=3` dla usług grupy | Do 30 MiB na kontener dla kopii logów Dockera; nie ogranicza plików logów w named volumes ani BuildKit |
| Log Next.js | Stały `/state/development/next.log` oraz najwyżej jeden `/state/development/next.log.rollback` w frontend cache volume; po przejęciu istniejącego runtime locka pełny regularny `next.log` jest atomowo obracany i katalog jest synchronizowany przed utworzeniem świeżego pliku | Retencja bieżącej i jednej poprzedniej generacji ma limit 64 MiB na plik; stdout ponad limit pozostaje w rotowanym driverze Docker. Ścieżki nieznane, dowiązania, hardlinki i pliki nieregularne są zachowywane/fail-closed, bez ogólnego GC |
| Staging kandydata daily live-shadow | Named package volume; usuwanie tylko znanych, oznaczonych kandydatów po potwierdzonym błędzie albo publikacji | Dziennik `rotation.pending.json` pozwala odzyskać dokładną przerwaną rotację przy kolejnym starcie. Nieznane, zmienione lub niekompletne dowody pozostają zachowane; brak ogólnego sweepu |
| Cień źródeł | Uzgodnienie jednego workspace w `/build`, usunięcie usuniętych plików źródłowych | Nie kasuje używanego cache Cargo/CMake. Jeden aktualny manifest zamiast historii snapshotów źródeł |
| Snapshoty host-ledgera | Ograniczony GC pod blokadą po publikacji/operacjach ledgera | Usuwa wyłącznie bezpieczne nieosiągalne CAS `snapshot` i `snapshot-order-v2`; zachowuje bieżący digest. Limit inspekcji 256 wpisów na katalog/wywołanie |
| Rezerwacje, readiness i recovery | Zachowanie historii i dowodów | Powyższy GC nie usuwa historii rezerwacji, CAS readiness ani sesji |
| Cargo/CMake/pnpm/Next | Ponowne użycie trwałego cache | Brak ogólnego limitu ani GC starych generacji. Cargo target może rosnąć wraz z wariantami grafu/flag |
| Backend v1/v2 i historyczny frontend ext4 | Jawne przygotowanie/reuse dokładnej tożsamości | Legacy adaptery nie usuwają starych wolumenów/backing files. Nowa generacja named volume nie dowodzi zbędności poprzedniej |
| Build logs, receipty i provenance daily live-shadow | Control/package volumes grupy Compose oraz BuildKit; stdout direct Make ma bounded receipt/log w `/build/failed-candidate-diagnostics`, najwyżej 8 terminalnych błędów / 64 MiB; Docker stdout ma limit 10 MiB × 3 pliki na kontener | cache Cargo/CMake, BuildKit i stare wolumeny nadal nie mają ogólnego limitu/GC; retencja `next.log` dotyczy wyłącznie dwóch znanych ścieżek technicznych opisanych wyżej. Unknown/building records są zachowywane fail-closed. Runtime proof **NOT VERIFIED**; hostowe metadata/logi frozen/static/release należą do osobnych recept |
| Runy, logi sesji, failed/unknown i per-run evidence | Zachowanie w Windows `/state`/run root, w tym `startup-provenance`, `runtime-recovery-consumed`, host-ledger i certyfikat mountu | To operacyjne dowody sesji/runtime, nie dane buildu; brak pełnej automatycznej retencji tej ścieżki |
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

Sprawdzamy osobno fizyczny wolny dysk hosta, wolne miejsce na dysku danych
Docker Desktop, zajętość named volumes/BuildKit oraz rozmiary należących do
zadania artefaktów. Duży limit wirtualnego dysku Dockera nie dostarcza wolnego
miejsca na pełnym dysku Windows. Pojemność logiczna wolumenu lub legacy VHDX,
faktycznie zaalokowane bajty i bajty możliwe do odzyskania to trzy różne pomiary.
Nie sumuj rozmiarów logicznych jako „tyle można skasować”. Usunięcie danych z
wolumenu nie dowodzi automatycznego zmniejszenia hostowego pliku dysku.

Historyczny frontend v1 miał preflight 16 GiB dla nowego pliku ext4 (8 GiB
cache + 8 GiB headroom) i 8 GiB dla istniejącego. Te wartości dotyczą wyłącznie
legacy adaptera. Dla aktywnego v2 wymagane miejsce powinno być mierzone na
dysku danych Docker Desktop; zgodność launchera z tym rozróżnieniem pozostaje
**NOT VERIFIED**. Adapter backendu v2 waliduje named volumes/receipty, ale nie
estymuje całego Cargo targetu. Backend przed kandydatem może oszacować miejsce
na podstawie poprzedniego pakietu; pierwszy build nie ma takiego odniesienia.
Storage probe sprawdza semantykę zapisu/locków/SQLite, nie zastępuje pomiaru
pojemności Docker Desktop.

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
zmiany CPU są WIP i nie stanowią dowodu gotowego backendu. Poniższe obserwacje
opisują historyczny baseline z 18.10, a nie kwalifikację obecnej ścieżki v2.

- Historyczny Docker inspect potwierdził frontend działający/healthy, readonly
  źródła, cztery bindy legacy cache ext4 i backend **exited** z parą backendowych
  named volumes v2, `/state` Windows, `/user-data` grupy oraz wspólnym
  `/host-ledger`. Te bindy ext4 nie opisują aktywnego kontraktu frontend v2.
- Na hoście było około **68,84 GiB wolnego na C:** w chwili pomiaru. W
  `build-volumes` wykryto stary backend 50 GiB, cztery legacy frontendowe pliki
  po 8 GiB i ledger 128 MiB — **rozmiary logiczne, nie miejsce do odzyskania**.
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
  `cache_key`, `prepare`, `validate_container` — frontend v2 named volume;
  historyczny ext4 adapter pozostaje poniżej jako compatibility-only;
- [`host_resource_ledger.rs`](../../crates/fullmag-session/src/host_resource_ledger.rs)
  — ograniczone sprzątanie technicznych CAS, bez kasowania rezerwacji;
- [`test_docker_backend_dev.py`](../../scripts/test_docker_backend_dev.py)
  — wykonywalne regresje publikacji i retencji.
