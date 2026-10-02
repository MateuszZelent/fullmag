# Pakowanie Fullmaga dla Windows

Wersja produktu Windows ma działać bez Docker Desktop, WSL i Linuxa.
Bieżąca implementacja pakowania jest częściowa; poniższe trasy nie są
potwierdzeniem kwalifikacji pełnego produktu ani czterech lane'ów.

## Natywny packager

[build_windows_msi.ps1](build_windows_msi.ps1) buduje Windows CLI/API/UI,
statyczny Control Room i wheel Python, następnie przygotowuje MSI przez
WiX. Wymaga narzędzi MSVC x64, Rust, Node, pnpm, Python i WiX na executorze.
Nie uruchamia Linuxa ani WSL. Domyślnie pakuje FDM CPU; jawne
`FULLMAG_WINDOWS_MSI_CUDA=1` wymaga nvcc i dodaje FDM CUDA. Natywnego FEM
CPU/GPU oraz pełnego bundle zależności jeszcze nie dodano.

Storage ustala [wspólny resolver](fullmag_storage.ps1), korzystający z
lokalnej konfiguracji głównego checkoutu albo jawnego ustawienia procesu.
Profile `windows-msi-cpu` i `windows-msi-gpu` mają oddzielne katalogi buildu.
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

Przed tworzeniem MSI `verify_pe_dependencies.py` sprawdza AMD64/PE32+ oraz
zwykłe i opóźnione importy każdej EXE/DLL w `bin`, przez MSVC dumpbin.
Biblioteki aplikacji, CRT i CUDA runtime muszą być w bundle; dopuszczone są
jawne komponenty Windows/API sets oraz NVIDIA driver dla wariantu CUDA.
Graph i hashe trafiają do manifestów. Brakujący import kończy pakowanie
błędem. Bramka nie wykonuje obrazów, nie sprawdza symboli/ABI ani dynamicznych
LoadLibrary, Python extensions, zewnętrznego Node/Python czy dostępności
komponentów na minimalnej wersji Windows; te punkty wymagają runtime smoke.

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

Aktualny payload wymaga Windows Python 3.12+ i Node 24.18+ na PATH.
Pełne zależności natywne, FEM CPU/GPU, runtime provenance, aktualny build,
clean install/open/upgrade/rollback oraz trwały storage/recovery nadal
wymagają implementacji i osobnego dowodu. Stan i regresje źródłowe są w
[raporcie P8-C](../../docs/plans/active/refactor_runtime/final/p8/01-windows-native-gaps.md).
