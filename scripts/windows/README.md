# Pakowanie Fullmaga dla Windows

Wersja produktu Windows ma działać bez Docker Desktop, WSL i Linuxa.
Bieżąca implementacja pakowania jest częściowa; poniższe trasy nie są
potwierdzeniem kwalifikacji pełnego produktu ani czterech lane'ów.

## Natywny packager

[build_windows_msi.ps1](build_windows_msi.ps1) buduje Windows CLI/API/UI,
statyczny Control Room i wheel Python, następnie przygotowuje MSI przez
WiX. Wymaga narzędzi MSVC x64, Rust, Node, pnpm, Python, uv i WiX na executorze.
`FULLMAG_WINDOWS_NODE_RUNTIME_ROOT` wskazuje jawny absolute katalog natywnej
dystrybucji x64 Node 24.18–24.99 z `node.exe` oraz `LICENSE`. MSI kopiuje
runtime i licencję, zamraża hashe i obejmuje Node wspólnym audytem PE/DLL.
Statyczny launcher wybiera dołączoną kopię bezpośrednio.
Przed buildem packager sprawdza zgodność deklaracji `pyproject.toml` i
`packages/fullmag-py/uv.lock`. Obecny lock wymaga odświeżenia; kontrola nie
zastępuje pełnego uv export ani weryfikacji wheeli i CPython bundle.
Runtime packages używają teraz locked export ze wszystkimi extras,
osobnego wheelhouse, SHA-256 i offline instalacji wymagającej hashów.
Bootstrap uv, synchronizacja locka i prawdziwy Windows graph/import/DLL/PYD
pozostają otwarte. uv jest narzędziem buildu, nie wymaganiem użytkownika.
MSI wymaga jawnego `FULLMAG_WINDOWS_PYTHON_RUNTIME_ROOT` z zatwierdzoną
dystrybucją embeddable CPython 3.12 x64 i licencją. Kopiuje runtime,
standard library i generuje izolowane ścieżki lokalnych pakietów. Native
EXE/DLL/PYD interpretera mają płaski audyt PE. Dodatkowy rekurencyjny audyt
obejmuje scientific wheels i bin; potwierdza dostępność importów, bez kwalifikacji
loadera/ABI. Po import smoke porównuje pełną listę i hashe obrazów. Realny
bundled import i pełny MSI pozostają NOT VERIFIED. Build Python
instalujący wheels musi używać CPython 3.12; minimum publicznego DSL nie zmienia się.
Nie uruchamia Linuxa ani WSL. Domyślnie pakuje FDM CPU; jawne
`FULLMAG_WINDOWS_MSI_CUDA=1` wymaga nvcc i dodaje FDM CUDA.
Domyślne `FULLMAG_WINDOWS_MSI_FEM=cpu` dodaje budowę natywnego FEM CPU;
`gpu` wymaga również CUDA=1 i providera MFEM CUDA. Jawne `none` tworzy
diagnostyczny pakiet FDM-only. Brak wymaganego prefixu zatrzymuje assembly.

Storage ustala [wspólny resolver](fullmag_storage.ps1), korzystający z
lokalnej konfiguracji głównego checkoutu albo jawnego ustawienia procesu.
Profile `windows-msi-fem-cpu`, `windows-msi-fem-cpu-cuda` i
`windows-msi-fem-gpu` mają oddzielne katalogi buildu; diagnostyczny tryb
none zachowuje `windows-msi-cpu` / `windows-msi-gpu`.
Cały skrypt przechodzi przez managed storage wrapper z blokadą i końcowym
stanem wykonania; to nie zastępuje zarządzanej kolejki pełnych buildów.

Każda próba dostaje osobny `runs/windows-msi-<UUID>` w rozwiązanym profilu:
`stage`, `wix`, `python-wheels`, `fullmag.msi` i stage manifest. Nie ma
kasowania wspólnego stagingu ani fallbacku Cargo na osobny root dysku.
Frontend korzysta z walidowanych compatibility links. Ścieżki Cargo,
native FDM i runu są sprawdzane przed ich wykorzystaniem.

DLL runtime trafiają do `bin` obok EXE; packager sprawdza konflikty nazw,
niepuste pliki i hashe. Native FDM pochodzi z bieżącego profilu, z katalogu
`Release` lub płaskiego katalogu Ninja. Dwa kandydaty są błędem; nie wybiera
się najnowszego pliku ze starych Cargo build directories. Inventory/hash nie
zastępuje audytu importów ani testu zgodności ABI.

Przed kopiowaniem dodatkowych DLL `plan_pe_dependencies.py` wyznacza pełny
zbiór zwykłych/delay importów `bin`, również importów bibliotek pośrednich.
Źródła są jawne: `VCToolsRedistDir/x64` wybranego MSVC (CRT/OpenMP/CXXAMP),
katalog nvcc i jego `x64` tylko dla CUDA, oraz opcjonalne katalogi operatora
w `FULLMAG_WINDOWS_MSI_DLL_ROOTS` (lista oddzielona średnikami). Ostatnia
zmienna wskazuje istniejące wejścia SDK/dependency prefix, nie nowy storage
ani alternatywny katalog wyników. Nie ma automatycznego przeszukiwania PATH,
System32 ani innych wersji SDK. Jawne roots są skanowane rekurencyjnie,
z kontrolą pozostania resolved DLL pod root. Brak zależności, konflikt nazwy z różnymi
hashami, zły target lub zmiana pliku zatrzymują plan przed dodatkowym copy.
Kopiowane są tylko potrzebne DLL; manifesty zapisują ich źródła i hashe.
Nvcuda.dll nie może być w bin ani w SDK root; sterownik jest wyłącznie
zewnętrznym wymaganiem CUDA. Staged DLL również nie może różnić się od
kandydata o tej samej nazwie w jawnym SDK.
Staged EXE/DLL i SDK sources są ponownie sprawdzane przed copy, a wyniki copy
muszą zgadzać się z planem. Dane wejściowe nie są uruchamiane.

Przed tworzeniem MSI `verify_pe_dependencies.py` sprawdza AMD64/PE32+ oraz
zwykłe i opóźnione importy każdej EXE/DLL w `bin`, przez MSVC dumpbin.
Biblioteki aplikacji, CRT i CUDA runtime muszą być w bundle; dopuszczone są
jawne komponenty Windows/API sets oraz NVIDIA driver dla wariantu CUDA.
Graph i hashe trafiają do manifestów. Brakujący import kończy pakowanie
błędem. Bramka nie wykonuje obrazów, nie sprawdza symboli/ABI ani dynamicznych
LoadLibrary, Python extensions, zewnętrznego Node/Python czy dostępności
komponentów na minimalnej wersji Windows; te punkty wymagają runtime smoke.

## Wybór natywnego MFEM

Konfiguracja FEM na Windows wymaga `FULLMAG_FEM_DEPENDENCY_PREFIX` wskazującego
istniejący prefix wejściowych bibliotek x64 MSVC. Nie jest to nowy katalog
wyników. Prefix musi zawierać dokładnie jeden `MFEMConfig.cmake` w root,
`lib/cmake/mfem`, `lib/cmake/MFEM`, `share/mfem` albo `share/cmake/mfem`.
Konfiguracja z PATH, starego `MFEM_DIR` lub przekierowania CMake nie zastępuje
tego wyboru. Usunięcie zmiennej w Cargo czyści poprzednią wartość cache.

Provider eksportuje jawne flagi double/single/CUDA; wymagane jest double,
a CUDA musi odpowiadać żądanemu wariantowi buildu. `CMAKE_BUILD_TYPE` musi być
jawny. Wybrana niepusta biblioteka `.lib`, albo `.dll` z import library `.lib`,
musi znajdować się w tym prefixie i mieć konfigurację zgodną z profilem.
Linux zachowuje istniejące `find_package(MFEM CONFIG REQUIRED)`.

To kontrola konfiguracji i ścieżek. Nie dowodzi architektury COFF, ABI/CRT,
kompletności HYPRE/libCEED/PETSc/SLEPc ani działania natywnego FEM. Nie
dostarczono jeszcze kwalifikowanego prefixu Windows ani jego receipts.

SLEPc ON wymaga w tym samym prefixie named config adapters MPI/PETSc/SLEPc
i imported targets `MPI::MPI_CXX`, `PETSC::petsc`, `SLEPC::slepc`. MPI jest
wybierany przed MFEM; stale cache/default discovery nie zastępuje wyboru.
Configi i konkretne biblioteki wybrane przez modal resolver trafiają do
inventory z hashami po configure, po buildzie i przed stagingiem. OFF nie
publikuje starego ON inventory. Pełny SDK, ABI i modal execution wymagają
własnego receiptu. CPU domyślnie ma SLEPc OFF, GPU ON; jawny
`FULLMAG_FEM_WITH_SLEPC` pozostaje dostępny.

MSI buduje wyłącznie produkcyjny target `fullmag_fem` w walidowanym
`native-fem` root, z Release i jawnymi flagami CPU/GPU. Wymaga jednej pary
DLL/import `.lib`, przekazuje ją do Cargo CLI/API przez prebuilt adapter
i kopiuje DLL obok EXE. Zewnętrzny `FULLMAG_FEM_LIB_DIR` jest odrzucany dla
FEM. Hash DLL, import library, głównego provider configu oraz argumenty
CMake są zapisane w manifestach; to częściowy inventory wejść, nie pełny
SDK receipt.

Po PE audit staged CLI musi zwrócić poprawny JSON object z CPU available.
Nie kompiluje się ani nie uruchamia solvera w tej diagnostyce. Status GPU
jest zapisany bez uznania go za device execution. Runtime manifests FEM
są experimental/public=false do osobnej kwalifikacji lane/release.

Wszystkie JSON manifests są zapisywane jako UTF-8 bez BOM, również
w Windows PowerShell 5. Dla rodziny `fem-cpu-native` rejestr wymaga
dostępnego natywnego FEM CPU; sama obecność EXE nie wystarcza. Nie
zmienia to dostępności referencyjnego `fem-eigen-cpu-baseline`.

## CI bez publikacji wydania

[Workflow](../../.github/workflows/windows-msi-container.yml) zachowuje nazwę
pliku dla kompatybilności, ale wykonuje teraz natywny packager. Wymaga
osobnego runnera z labels `self-hosted`, `windows`, `x64`,
`fullmag-native-msvc-wix`. Jobs tego workflow są serializowane bez
przerywania aktywnej próby. Runner musi mieć narzędzia oraz skonfigurowany
przez operatora storage z właściwym project marker.

Zmienna repozytorium `FULLMAG_WINDOWS_CI_STORAGE_ROOT` określa root storage
tego executora. Brak konfiguracji jest błędem; nie kopiować ścieżki z innego
hosta. Upload otrzymuje ścieżki z `steps.package.outputs`, emitowane dopiero
po potwierdzeniu niepustych plików MSI i manifestu. Brak artefaktów kończy
upload błędem. Workflow dopuszcza ręczne pakowanie testowe przez `workflow_dispatch`;
nie tworzy taga ani GitHub Release.

Dispatch wybiera FEM cpu/gpu/none oraz CUDA. Natywny FEM wymaga operatorowych
vars `FULLMAG_WINDOWS_FEM_CPU_PREFIX` albo `FULLMAG_WINDOWS_FEM_GPU_PREFIX`,
z istniejącymi bibliotekami Windows/MSVC. GPU nie dziedziczy CPU prefixu,
gdy jego własna konfiguracja jest pusta. Automatyczny push używa FEM CPU.

Enrolment i wykonanie tego natywnego executora pozostają NOT VERIFIED.
Nie uruchomiono workflow w ramach tego fragmentu. Na lokalnym hoście z
Fullmag_build_runner pełne buildy pozostają w kolejce; brak profilu Windows
nie upoważnia do ciężkiego hostowego fallbacku.

## Dawna trasa kontenerowa

[build_installer_windows_container.ps1](build_installer_windows_container.ps1)
i [Dockerfile](../../docker/windows-msi/Dockerfile) pozostają historyczną
trasą narzędziową. Wrapper ma unikalną nazwę kontenera i nie kasuje kontenera
o wspólnej nazwie. Ta trasa nie jest już wejściem workflow MSI. Mapowanie
kanonicznego storage/common Git root oraz podpięcie do zatwierdzonej kolejki
Windows nie są zweryfikowane; nie przedstawiać jej jako działającej ścieżki
buildu ani zależności produktu Windows.

## Pozostałe bramki

Aktualny payload nadal wymaga Windows Python 3.12+ na PATH. Dołączony Node
jest zaimplementowany źródłowo; rzeczywista instalacja MSI pozostaje NOT VERIFIED.
Rzeczywisty bundle zależności natywnych, FEM CPU/GPU, runtime provenance, aktualny build,
clean install/open/upgrade/rollback oraz trwały storage/recovery nadal
wymagają implementacji i osobnego dowodu. Stan i regresje źródłowe są w
[raporcie P8-C](../../docs/plans/active/refactor_runtime/final/p8/01-windows-native-gaps.md).
