# P8-C — natywne składanie FEM w pakiecie Windows

Data: 02.10.2026. Implementacja źródłowa i lekkie regresje: PASS.
Rzeczywisty build Windows, solver i instalacja: NOT VERIFIED.

## Zrealizowany zakres

MSI buduje teraz natywny `fullmag_fem` przez frontdoor CMake w osobnym,
zwalidowanym katalogu `native-fem` pod właściwym profilem storage. Budowany
jest wyłącznie produkcyjny target, z jawnym Release i flagami CPU/GPU.
Nie uruchamia Docker Desktop, WSL ani Linuxa. Po buildzie wymagana jest
dokładnie jedna niepusta para DLL/import library w Release albo płaskim
katalogu generatora. Brak, niekompletna para lub dwa kandydaty zatrzymują
pakowanie. Nie ma skanowania historycznych Cargo outputs.

| Ustawienia operatora | Profile | Zakres składania |
|---|---|---|
| FEM `cpu`, CUDA `0` — domyślne | `windows-msi-fem-cpu` | FDM CPU oraz natywny FEM CPU |
| FEM `cpu`, CUDA `1` | `windows-msi-fem-cpu-cuda` | FDM CPU/GPU oraz natywny FEM CPU |
| FEM `gpu`, CUDA `1` | `windows-msi-fem-gpu` | FDM CPU/GPU oraz natywny FEM CPU/GPU |
| FEM `none`, CUDA `0`/`1` | dotychczasowe MSI CPU/GPU | Jawny diagnostyczny pakiet FDM; nie zamyka pełnego celu |

Wybór określają `FULLMAG_WINDOWS_MSI_FEM` i `FULLMAG_WINDOWS_MSI_CUDA`.
GPU bez CUDA oraz brak jawnego istniejącego absolute dependency prefix
są błędem, bez przejścia do FDM-only. Zewnętrzny `FULLMAG_FEM_LIB_DIR` jest
odrzucany dla wariantu FEM. Cargo CLI/API dostaje tę samą listę features
i import library z bieżącego buildu. Historyczny feature `fem-gpu` nadal
obejmuje również native CPU; publiczna semantyka device nie zmienia się.

CPU domyślnie ma SLEPc OFF, GPU ON, zgodnie z dotychczasowym build script;
jawny `FULLMAG_FEM_WITH_SLEPC` zachowano. To wybór assembly dependencies,
nie potwierdzenie dostępności modal solvera. Nie zmieniono fizyki, numerics,
planner legality, requested/resolved execution, OpenAPI ani UI command gates.

## Biblioteki i diagnostyka

DLL trafia obok EXE. Jawne SDK roots są indeksowane rekurencyjnie, więc
provider może umieścić DLL w podfolderach Release. Resolved plik pozostaje
pod deklarowanym root. Konflikty różnych wersji tej samej nazwy, błędny PE
i nvcuda, również z podfolderu, zatrzymują closure. Tylko potrzebne DLL
trafiają do MSI. Brak zależności instalacji od build prefixu wymaga jeszcze
clean-install smoke. Dynamiczne LoadLibrary i pełny ABI/CRT smoke nadal
wymagają osobnej weryfikacji.

Po finalnym PE audit skrypt uruchamia wyłącznie staged
`fullmag runtime fem-availability --json`. Exit 0 nie wystarcza: wymagany
jest pojedynczy JSON object z boolean CPU available=true. Brak, uszkodzony
JSON, tablica, null, nieprawidłowy typ lub niedostępny CPU kończą pakowanie.
CPU package nie może zgłaszać native GPU. GPU build host bez urządzenia
nie jest dowodem GPU execution; diagnostyka trafia wprost do manifestu.

JSON wersji, stagingu i runtime manifests jest zapisywany jako UTF-8 bez BOM.
Regresja wykonuje rzeczywiste funkcje zapisu zarówno w Windows PowerShell 5,
jak i PowerShell 7; starszy `Set-Content -Encoding UTF8` dodawał BOM,
którego parser manifestów Rust nie akceptuje.

Rejestr rodziny `fem-cpu-native` sprawdza dodatkowo dostępność natywnego
FEM CPU; sama obecność ścieżki workera nie wystarcza. Referencyjna rodzina
`fem-eigen-cpu-baseline` zachowuje dotychczasowy kontrakt. Dodane dwie
regresje Rust pozostają NOT COMPILED / NOT RUN zgodnie z czasowym zakazem
kompilowania unit tests. Kompilacja produkcyjna i runtime tej zmiany nie
są jeszcze potwierdzone dla FEM Windows; nie jest to nowy protokół discovery
zdalnego workera. `just check-cli-source` sprawdził produkcyjne źródła CLI
bez natywnego FEM: PASS, exit 0, `source_changed_during_run=false`, receipt
`cd3d54e20fc5404c995e2686df760a0d`. Hash niezmienionego `runtime_registry.rs`
odpowiada hashowi w receipcie: `4398ba7929f157b9682fece7d960343db75765336a08d4832e62ae32514ce16d`.

Przy SLEPc ON Windows wymaga trzech jawnych adapterów config w tym samym
prefixie: MPI, PETSc i SLEPc, z imported targets `MPI::MPI_CXX`,
`PETSC::petsc` i `SLEPC::slepc`. MPI wybierany jest przed discovery MFEM.
Brakujący lub niejednoznaczny config, ambient library/wrapper oraz plik
poza prefixem zatrzymują konfigurację. Referencje MPI interface są
rozwiązywane do konkretnych bibliotek. Linux zachowuje dotychczasowe discovery.

Mapowania imported Release/Debug muszą zachować tę samą konfigurację;
również jawne puste mapowanie jest odrzucane. Opcje linkera nie mogą
wybrać ambient library zamiast przypiętego pliku. CMake może zmieniać
wybór biblioteki przez
[MAP_IMPORTED_CONFIG](https://cmake.org/cmake/help/latest/prop_tgt/MAP_IMPORTED_CONFIG_CONFIG.html),
więc kontrola samych `IMPORTED_LOCATION_RELEASE`/`DEBUG` nie wystarcza.

Version/stage manifest zapisuje hash DLL, import library, głównego configu
MFEM oraz rzeczywiste argumenty CMake. Config sprawdzany jest przed i po
native buildzie; DLL/import/config ponownie przed stagingiem. To częściowy
inventory wejść linkowania, nie kompletny receipt całego SDK, headers ani
wszystkich statycznych bibliotek. Dla SLEPc ON inventory obejmuje także
konkretne configi i link inputs wybrane przez modal resolver; ich hashe są
zamrażane po configure, sprawdzane po buildzie i ponownie przed stagingiem.
Brak lub niezgodny schema/profile inventory kończy pakowanie. SLEPc OFF
nie przenosi starych wpisów cache do aktualnego manifestu. Runtime manifests mają
`stability=experimental`, `public=false`; `qualification=not_verified`
pozostaje jawne. Manifest informuje o składzie pakietu, nie o kwalifikacji nauki.

## Weryfikacja i pozostające bramki

**61** regresji assembly PowerShell PASS. **27** PE planner, **23** PE audit,
**15** storage oraz **8** DLL staging PASS dla zgodnych źródeł. Dodatkowo
**19** configure-only regresji modal provider PASS: **153** łącznie.
Pokryto oddzielne profile/features, brak fallbacku, discovery pary, rzeczywisty
przepływ wywołań z kontrolowanym CMake, zatrzymanie po błędzie, hash/config
mutation, strict JSON, manifesty i SDK roots, nested closure/conflict/driver,
dziedziczone prebuilt w trybie none oraz operatorowy routing prefixów CI,
modal inventory/schema/profile/targets, mutację lub zniknięcie wejścia,
SLEPc OFF ze starym cache i BOM obu wersji PowerShell.
Fikstury CMake/DLL nie są rzeczywistymi bibliotekami. Nie kompilowano unit tests,
native runtime ani MSI i nie wykonano solvera.

Natywne CI korzysta z operatorowych `FULLMAG_WINDOWS_FEM_CPU_PREFIX` /
`FULLMAG_WINDOWS_FEM_GPU_PREFIX`, z jawnymi inputami FEM/CUDA. Zmiana native
lub backend sources również wyzwala build workflow. API GitHub wykazało
**0 zarejestrowanych self-hosted runnerów** repozytorium w chwili kontroli;
nie uruchomiono workflow ani ciężkiego hostowego fallbacku. Read-only preflight
resolvera potwierdza trzy nowe profile na bieżącej konfiguracji storage.

Pozostają kwalifikowany executor Windows, rzeczywisty i wersjonowany prefix
MFEM/HYPRE/libCEED/modal, odpowiedni Windows receipt, linking/provenance,
bramki czterech lane'ów, standalone Python/Node payload, clean install/open/
upgrade/rollback oraz storage/checkpoint/restart/restore. Managed Linux
[build 204](02-fem-cpu-build-204.md) sprawdza wcześniejszy SHA i nie obejmuje
tej zmiany. Sesja 3104 oraz cudze dirty źródła pozostają zachowane.
