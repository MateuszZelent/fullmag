# ADR 0085: Współdzielony, adresowany treścią cache kompilatora dla Docker DEV

Status: przyjęte 19.11.2026. Uzupełnia [ADR 0076](0076-single-private-volume-per-dev-group.md)
pkt 7 i [ADR 0067](0067-docker-dev-group-isolation.md); nie zmienia topologii
prywatnego volume grupy.

## Kontekst

ADR 0076 pkt 7 czyści prywatne compiler outputs `.fullmag-build` przed każdą
rzeczywistą kompilacją i po publikacji pakietu. Dzięki temu grupa nie trzyma
kilku gigabajtów Cargo targetu i drzewa CMake, ale każda kompilacja backendu jest
zimna: zmiana jednego pliku w `crates/fullmag-runner` kompiluje od nowa wszystkie
crate'y zewnętrzne, cały workspace oraz natywne FEM/FDM C++/CUDA.

Pomiar z 19.11.2026 (grupa `fullmag-worktree-open-airbox-k0-modal-20261119-b-*`,
checkout Windows, linie `backend-dev: phase=` w logu kontenera `backend`):

| Scenariusz | `phase=sync` | `phase=make` | Cargo CLI+API | Cargo `fullmag-py-core` |
|---|---:|---:|---:|---:|
| Pierwszy start świeżego worktree | 517 s | 649 s | 7 min 45 s | 2 min 48 s |
| Restart po edycji 1 pliku Rust (runner) i 1 pliku C++ | 9 s | 858 s | 9 min 55 s | 3 min 20 s |

Restart po małej zmianie jest więc tak samo drogi jak zimny build. Współdzielone
były już: obraz toolchaina (BuildKit), Cargo registry/git i zweryfikowane pakiety
(tylko dla identycznych źródeł).

### Dlaczego są dwa wywołania Cargo

`make install-cli-dev` buduje najpierw `fullmag-cli` + `fullmag-api` z cechami
`cuda`/`fem-gpu`, a potem osobno `fullmag-py-core` (cdylib `_fullmag_core.so`
do certyfikacji siatki w Pythonie) bez tych cech. Resolver Cargo unifikuje cechy
w obrębie jednego wywołania, więc wspólne crate'y (`fullmag-ir`, `-plan`,
`-session`, `-engine`, `-runner`, ...) mają w obu wywołaniach inny zestaw cech
i kompilują się drugi raz. Połączenie wywołań wciągnęłoby `fem-gpu`/CUDA do
modułu Pythona (link z `libfullmag_fem.so` i bibliotekami CUDA przy imporcie),
czyli zmieniłoby jego zachowanie runtime. Zostawiamy dwa wywołania; ich drugi
koszt usuwa cache z tej decyzji, bo identyczne wywołania kompilatora z
poprzednich buildów trafiają w cache niezależnie od tego, w którym wywołaniu
Cargo wystąpiły.

### Czy natywny build C++ jest szeregowy

Nie w praktyce. `CMAKE_BUILD_PARALLEL_LEVEL=1` jest tylko fallbackiem.
`build.rs` w `fullmag-fem-sys` i `fullmag-fdm-sys` w trybie direct Compose usuwa
tę zmienną i przekazuje do `cmake --build` (generator Unix Makefiles)
`MAKEFLAGS` z jobserverem Cargo, więc kompilacja C++/CUDA współdzieli 16 tokenów
`CARGO_BUILD_JOBS` z rustc. Szeregowy `--parallel 1` następuje wyłącznie wtedy,
gdy jobserver lub generator nie spełnia warunków; wtedy `build.rs` drukuje
`cargo:warning=... uses --parallel 1`. W zmierzonych logach takiego ostrzeżenia
nie ma. Pole `native_parallelism=shared-or-serial` opisuje obie możliwości, nie
stwierdza szeregowości. Zmiana nie jest potrzebna.

## Decyzja

1. Backend daily DEV (profil `backend-dev`) używa dwóch adresowanych treścią
   cache kompilatora współdzielonych przez wszystkie grupy projektu:
   - `sccache` jako `RUSTC_WRAPPER` dla rustc;
   - `ccache` jako `CMAKE_C_COMPILER_LAUNCHER`, `CMAKE_CXX_COMPILER_LAUNCHER`
     i `CMAKE_CUDA_COMPILER_LAUNCHER` dla natywnych FEM/FDM (gcc i nvcc).
   Release, frozen i kwalifikacja nie używają tego cache.
2. Narzędzia należą do obrazu toolchaina (`docker/fem-gpu/Dockerfile`, etap
   `fem-gpu-dev`): `sccache` z przypiętego wydania GitHub ze sprawdzeniem
   SHA-256, `ccache` z repozytorium Ubuntu obrazu bazowego. Wersje są zapisane w
   `dependency-versions.json` (`actual.compile_cache`).
3. Dane leżą w istniejącym project-scoped wolumenie `fullmag-shared-cargo-v1-*`,
   w podkatalogu `compile-cache/` obok `home/` (CARGO_HOME):
   `compile-cache/sccache` i `compile-cache/ccache`. Launcher tworzy je w tym
   samym inicjalizatorze co `home/` (UID/GID 65532) i montuje subpath
   `compile-cache` wyłącznie do usługi `backend` pod
   `/opt/fullmag/shared-compile-cache` (`FULLMAG_SHARED_COMPILE_CACHE`).
   Frontend go nie dostaje. Nie powstaje nowy wolumen ani nowa rola wolumenu.
4. Bezpieczeństwo kluczy. Wpis jest trafiany tylko przy identycznych wejściach:
   - sccache hashuje skróty bibliotek kompilatora rustc, pełną linię poleceń,
     treść źródeł i rlib zależności, zmienne `CARGO_*`, zmienne czytane przez
     `env!` oraz wersję rustc. Nowy nightly w obrazie daje nowe klucze.
   - ccache hashuje treść binarki kompilatora (`CCACHE_COMPILERCHECK=content`,
     nie mtime, bo obrazy toolchaina są przebudowywane), argumenty, treść źródła
     i wszystkich dołączonych nagłówków, w tym MFEM/PETSc/hypre z
     `/opt/fullmag-deps`.
   Tożsamość toolchaina jest więc częścią każdego klucza, a zmiana toolchaina
   powoduje chybienie, nigdy błędne trafienie. Osobny namespace per toolchain
   nie jest potrzebny; stare wpisy wypiera LRU.
   Ścieżki są w każdej grupie identyczne (`/build/workspace`, CARGO_HOME
   `/opt/fullmag/shared-cargo`, `CCACHE_BASEDIR=/build/workspace`), więc trafienia
   działają między worktree.
5. Cache nie jest wejściem semantycznym. Nie wchodzi do tożsamości pakietu
   (`_shared_package_identity`) ani do receiptu pakietu. Każda awaria (brak
   mountu, narzędzia, katalog niezapisywalny lub z linkiem, serwer sccache nie
   wstaje) wyłącza cache dla tej kompilacji z logiem
   `phase=compile-cache state=disabled reason=...`; build biegnie wtedy jak przed
   tą decyzją. Brak cache nigdy nie blokuje buildu.
6. Przy aktywnym sccache `CARGO_INCREMENTAL=0` (Makefile wyłącza incremental,
   gdy `RUSTC_WRAPPER` wskazuje sccache). sccache nie cache'uje crate'ów
   inkrementalnych, a ADR 0076 i tak usuwa stan inkrementalny przed każdą
   kompilacją, więc incremental nie dawał tu zysku.
7. Sesja buildu: backend uruchamia serwer sccache przed `make`
   (`SCCACHE_IDLE_TIMEOUT=0`, bo długi krok natywny może zostawić rustc
   bezczynnym), a po `make` — także nieudanym — loguje statystyki tej kompilacji
   i zatrzymuje serwer:
   `phase=compile-cache state=stats native_hits=… native_misses=…
   native_uncacheable=… rust_hits=… rust_misses=… rust_uncacheable=…`.
   Statystyki natywne pochodzą z prywatnego `CCACHE_STATSLOG` tej kompilacji w
   `/build/tmp`, nie z globalnych liczników współdzielonego katalogu.

## Retencja i lifecycle

- Limity: sccache `SCCACHE_CACHE_SIZE=32G`, ccache `CCACHE_MAXSIZE=16G`. Oba
  narzędzia same usuwają najstarsze wpisy (LRU) po przekroczeniu limitu.
  Każdy serwer sccache liczy limit z własnego widoku katalogu; przy kilku
  równoległych grupach chwilowy rozmiar może przekroczyć limit o rozmiar wpisów
  dopisanych przez inne grupy w trakcie jednej kompilacji.
- Współbieżność: ccache jest projektowany do współdzielenia katalogu między
  procesami. sccache zapisuje wpis do pliku tymczasowego i atomowo zmienia jego
  nazwę; wpis usunięty przez LRU innej grupy daje chybienie i zwykłą kompilację,
  nie błędny wynik.
- Cache jest w całości odtwarzalny. Usunięcie `compile-cache/` (albo jednego z
  podkatalogów) przy zatrzymanych buildach kosztuje wyłącznie jeden zimny build
  na grupę; inicjalizator odtworzy katalogi przy następnym `up`. Nie usuwaj przy
  tym `home/` ani całego wolumenu `fullmag-shared-cargo-v1-*`, i nie wykonuj tego
  podczas aktywnej kompilacji którejkolwiek grupy.
- `worktree-finish` i retencja grupy nie dotykają `compile-cache/`: to zasób
  projektu, jak Cargo registry.
- Rozmiar mierz `docker system df -v` dla wolumenu albo
  `du -sh /opt/fullmag/shared-compile-cache/*` w działającym backendzie.

## Skutki

- Zmiana Dockerfile zmienia ID obrazu toolchaina, a więc tożsamość pakietów:
  każda grupa po aktualizacji launchera przejdzie raz pełną kompilację (która
  zarazem napełnia cache).
- Część grafu zawsze się kompiluje: `fullmag-build-info` wkompilowuje znacznik
  czasu i snapshot źródeł (`env!`), więc jego rlib i wszystkie zależne crate'y
  (`fullmag-runtime-control`, `fullmag-runner`, `fullmag-api`, `fullmag-cli`,
  `fullmag-py-core`, ...) nie trafiają w cache przy żadnej zmianie źródeł.
  Crate'y `bin`/`cdylib`/`proc-macro` sccache z zasady nie cache'uje (linker).
  Oddzielenie tożsamości buildu od grafu rlib jest osobnym usprawnieniem.
- `phase=sync` (kopiowanie ~10 tys. plików przez 9p z checkoutu Windows) tej
  decyzji nie dotyczy; checkout na ext4 w WSL pozostaje zalecany.

Implementacja: `scripts/docker_shared_build_storage.py`,
`scripts/docker_volume_dev.py`, `docker/all-in-one/backend_dev.py`
(`_shared_compile_cache`), `Makefile` (`install-cli-dev`),
`docker/fem-gpu/Dockerfile`. Pomiary A/B: sekcja „Pomiar" poniżej.

## Pomiar

Uzupełniany po pomiarze A/B na docelowym hoście.
