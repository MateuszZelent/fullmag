# Przygotowanie środowiska buildu Fullmag na nowym Windows

Ten pakiet przygotowuje checkout Fullmag skopiowany na inny komputer Windows.
Domyślny tryb skryptu jest tylko kontrolą (`check`). Instalacja wymaga jawnego
`-Install`; nie ma ukrytego przejścia przez WSL ani domyślnego fallbacku do CPU.

Głównym wejściem jest
[`scripts/windows/setup_build_environment.ps1`](../../scripts/windows/setup_build_environment.ps1),
a deklaracją wersji i źródeł jest
[`windows_build_requirements.json`](../../windows_build_requirements.json).
Skrypt korzysta z jednego resolvera
[`scripts/fullmag_storage.py`](../../scripts/fullmag_storage.py), więc cache,
toolchainy projektowe i dane buildu pozostają pod lokalnym
`FULLMAG_PROJECT_STORAGE_ROOT`.

## Kontrakt pełnego środowiska backendów

Publiczna trasa instalatora zawsze przygotowuje installed support dla FDM CPU,
FDM GPU, FEM CPU i FEM GPU. Nie wybiera backendu ani urządzenia w instalatorze.
Jednym fizycznym artefaktem jest supersetowy bundle
`windows-native-fem-gpu`; nie są wymagane cztery fizyczne buildy. Agregat
`windows-full-runtime/build-manifest.json` musi jednak zawierać cztery osobne
component proofs (`fdm-cpu`, `fdm-gpu`, `fem-cpu`, `fem-gpu`) związane z tym
bundle'em i jego hashami.

`Ready` oznacza zweryfikowane installed support wszystkich czterech komponentów.
Nie oznacza GPU w komputerze, widocznego sterownika, uruchomionego solvera ani
kwalifikacji fizyki. Brak lub mismatch jednego proofu blokuje agregat; stare
single-lane receipts nie wystarczają. Hardware GPU i runtime są raportowane
osobno. Wymuszone GPU kończy się jawnym błędem bez CPU fallbacku.

Po przygotowaniu narzędzi pełna trasa używa rootowych recept:

```powershell
just windows-full-workspace-build backend=auto device=auto
just windows-full-workspace backend=auto device=auto
```

Recepty pozostawiają wybór backendu i urządzenia aplikacji dla konkretnego
modelu w istniejącym unified workspace. Nie zmieniają DSL, ProblemIR ani
publicznego planera. Integracja agregatu, czterech proofs i obu recept jest
obecnie **NOT VERIFIED**. Próba FEM `34113` zakończyła kompilację wszystkich
targetów C++/CUDA oraz Rust, ale zakończyła się podczas pakowania z powodu
brakującego receiptu providera Boost. Poprawka zakresu Boost, pięć kontroli
natywnych i read-only admission/receipt validation providera (checkpoint
`61949`) zakończyły się terminalnym `PASS`. Nie daje to jeszcze zbiorczego
`Ready` ani dowodu runtime.

Dawne opcje `-Lane` w `setup_build_environment.ps1` pozostają kompatybilnym
raportem komponentowym do czasu pełnego podpięcia agregatu. Ich `ready` nie
jest równoznaczne ze zbiorczym `Ready`; nie należy używać ich jako wyboru zakresu
instalacji.

## Pierwsze uruchomienie

Uruchom **Windows PowerShell**, nie WSL, z katalogu głównego checkoutu. Przy
pierwszej konfiguracji nowego klona wykonaj poniższy przykład w głównym
checkoutcie, nie w worktree; skrypt ustala
główny checkout przez `git worktree list --porcelain` i czyta `.env` głównego
checkoutu; `.env` worktree nie jest alternatywną konfiguracją. Jeżeli główny
`.env` zawiera już `FULLMAG_PROJECT_STORAGE_ROOT`, zachowaj tę wartość i uruchom:

```powershell
# Kompatybilny raport komponentowy; nie jest agregatem Ready.
.\scripts\windows\setup_build_environment.ps1 -Lane all
```

Na nowym klonie bez tej wartości ścieżkę podaje operator:

```powershell
$storage = Join-Path (Split-Path -Parent (Get-Location).Path) 'storage'
.\scripts\windows\setup_build_environment.ps1 `
  -Install `
  -StorageRoot $storage `
  -Lane all
```

Ten przykład jawnie wybiera kanoniczny lokalny katalog `storage` obok głównego
checkoutu, który resolver może zainicjalizować po kontroli. Ścieżka musi być
absolutną lokalną ścieżką Windows. UNC, udział SMB, ścieżka przeniesiona z
poprzedniego komputera oraz domyślny wybór „na wszelki wypadek” są odrzucane.
Istniejące `.env` nie jest przepisywane. Gdy operator poda `-StorageRoot` dla
pliku bez tej zmiennej, skrypt dopisze tylko jedną nową linię po pomyślnym
przejściu resolvera. Niestandardowy root poza tym kanonicznym katalogiem musi
być wcześniej osobno zarejestrowany przez operatora i mieć zaakceptowany marker
resolvera; setup nie tworzy ani nie adoptuje takiego rootu automatycznie. Zasady
rejestracji opisuje [governance storage](fullmag-build-storage-governance.md).
Kopiowany checkout musi zachować metadane `.git`; bez nich skrypt odmawia
`git init` i nie tworzy fałszywej tożsamości źródeł. Jeżeli `git.exe` nie jest
jeszcze dostępny, `-Install` może zainstalować Git przez `winget` po tej kontroli;
resolver storage nadal musi później potwierdzić prawidłowy checkout.

Najpierw można wyświetlić raport maszynowy bez instalowania i bez tworzenia
project-owned tooling:

```powershell
# Raport kompatybilności komponentów; pełne Ready wymaga agregatu.
.\scripts\windows\setup_build_environment.ps1 -Lane all -Json
```

Raport rozdziela `installation` (co skrypt próbował zainstalować),
`compiler_status`, `provider_status`, `runtime_tool_status` oraz `runtime`.
Pole `readiness` ma trzy istotne wartości: `ready`, `blocked` oraz
`compiler_ready_provider_pending`. Ta ostatnia oznacza, że narzędzia kompilatora
i wspólne narzędzia są gotowe, ale przypięty provider FEM wymaga pierwszego
zarządzanego bootstrapu. Status `pass` oznacza dostępność i zgodność
sprawdzanego narzędzia. Nie oznacza buildu, uruchomienia solvera, dowodu
urządzenia GPU ani kwalifikacji fizyki.
Raport `storage_profile` dla `fem-cpu` i `fem-gpu` musi odpowiednio wynosić
`windows-native-fem-cpu` albo `windows-native-fem-gpu`; profil `windows-setup`
dotyczy wyłącznie wspólnego lane native.
Jeżeli receipt providera istnieje, jego `plan.root` i `plan.prefix` muszą wskazywać
wybrany profil. Receipt CPU wymaga `cuda=false` i pustych architektur; receipt GPU
wymaga `cuda=true` oraz niepustej, numerycznej listy architektur CUDA, na przykład
`89` albo `89;90`. Niezgodny receipt jest blokadą, a brak receiptu pozostaje
`pending` do czasu zarządzanego bootstrapu.

## Zakres instalacji

`-Install` używa dokładnych identyfikatorów `winget` dla narzędzi systemowych,
przypiętego instalatora Node.js z SHA-256 oraz oficjalnych URL/hashy dla
artefaktów projektowych. Instalacja systemowa może
wymagać uprawnień administratora i restartu nowej powłoki. Skrypt nie zmienia
globalnego `PATH`; aktualizuje go tylko w bieżącym procesie i pokazuje ścieżki
storage w raporcie. W tej samej powłoce można od razu użyć project-owned
`just`; po otwarciu nowej powłoki powtórz kontrolę i dodaj zweryfikowany katalog
narzędzi z raportu do `PATH` tej powłoki albo wywołaj `just.exe` z jego pełnej
ścieżki.

Wspólny zestaw native wymaga:

- Visual Studio Build Tools z workloadem **Desktop development with C++**,
  MSVC x64, Windows SDK i `vcvars64.bat`; optionalny clang z Visual Studio nie
  zastępuje przypiętego LLVM providera; pełne IDE Visual Studio nie jest
  wymagane;
- Rustup oraz `stable-x86_64-pc-windows-msvc`, `cargo`, `rustc`, `rustfmt` i
  `clippy`;
- CMake >= 3.25, zweryfikowany interpreter CPython `python.exe` >= 3.12,
  project-owned `uv==0.13.0`, Node 24.18.x–24.99.x, Corepack (`corepack.exe`
  lub `corepack.cmd`) z
  `pnpm@10.8.1` oraz project-owned `just==1.51.0` z przypiętego oficjalnego
  archiwum ZIP;
- Git dla Windows.

`-Lane fem-cpu` i `-Lane fem-gpu` pozostają diagnostyką pojedynczego komponentu,
a nie wyborem zakresu instalacji. Pełna trasa przygotowuje cztery component
proofs z jednego bundle'u `windows-native-fem-gpu`; stare receipty jednej lane
nie mogą zasilić agregatu `Ready`. Obowiązujące piny to:

| Komponent | Wersja / commit | Właściciel instalacji |
| --- | --- | --- |
| MFEM | `v4.9` / `d9d6526cc1749980a2ba1da16e2c1ca1e07d82ec` | `native_fem_dependencies.ps1` |
| hypre | `v3.1.0` / `9dc9e18aed6a945a95f966e57daacfb1c269f6ec` | `native_fem_dependencies.ps1` |
| libCEED | `v0.12.0` / `4018a20a98d451fac24765d3ddb936861647ce8d` | `native_fem_dependencies.ps1` |
| Ninja | `1.13.2` | project-owned `fem-dependencies` |
| LLVM/`clang-cl` | `23.1.3` | project-owned `fem-dependencies` |
| Microsoft MPI SDK | `10.1.1` | project-owned `fem-dependencies` |

Bootstrap providerów pobiera Ninja do przypiętego katalogu po sprawdzeniu
SHA-256. Node.js jest pobierany z oficjalnego archiwum v24.18.0 i instalowany
dopiero po sprawdzeniu SHA-256. LLVM, SDK MPI i biblioteki MFEM/hypre/libCEED
pozostają własnością istniejącego bootstrapu; skrypt setupu nie buduje ani nie
instaluje drugiego stosu FEM. Jeżeli któregoś providera brakuje, `-Install`
raportuje go jako `pending`, o ile kompilator i pozostałe wymagane narzędzia są
gotowe; setup nie blokuje zakończenia wyłącznie oczekiwaniem na pierwszy
bootstrap. Dla `-Lane fem-gpu` wymagany jest również `nvcc` z CUDA
>= 13.3. Sterownik, widoczność GPU i wykonanie CUDA są osobnymi bramkami.

WiX jest opcjonalny i jest wymagany tylko po `-WithWix`:

```powershell
.\scripts\windows\setup_build_environment.ps1 -Install -Lane all -WithWix
```

`-WithWix` sprawdza obecnie narzędzie `wix.exe` dla przyszłego authoringu
bootstrappera Burn. Istniejący [`build_windows_msi.ps1`](../../scripts/windows/build_windows_msi.ps1)
wywołuje WiX 3 przez `candle.exe` i `light.exe`; przejście kontroli `-WithWix`
nie potwierdza gotowości tej ścieżki MSI. Obecna kwalifikacja MSI pozostaje
`NOT VERIFIED`.

### Dwie trasy instalatora

Obsługiwane są dwie odrębne trasy. Użytkownik, który pobiera gotowy publiczny
`fullmag.exe`, pobiera go wyłącznie z GitHub Releases maintenera; plik wykonywalny
nie jest przechowywany w repozytorium Git ani tworzony przez instalację narzędzi na
komputerze konsumenta. Budowanie wydania ze źródeł wymaga natomiast sklonowanego
lub skopiowanego checkoutu z metadanymi `.git`. Archiwum ZIP bez `.git` nie jest
wejściem tej trasy: operator musi użyć `git clone` albo samodzielnie przygotować
repozytorium z rozwiązywalnym `HEAD` przed uruchomieniem skryptu. Skrypt nie wykonuje
`git init` i nie zgaduje proweniencji.

Producent uruchamia osobny check-first bootstrap:

```powershell
# Uruchom z głównego checkoutu i potwierdź wcześniej lokalny root storage.
$storage = Join-Path (Split-Path (Get-Location).Path -Parent) 'storage'
.\scripts\windows\setup_installer_build_environment.ps1 -StorageRoot $storage -Json
.\scripts\windows\setup_installer_build_environment.ps1 -Install -StorageRoot $storage
```

Manifest [`windows_installer_build_requirements.json`](../../windows_installer_build_requirements.json)
rozróżnia minimalne narzędzia producenta: Git i Python są wymagane przed
odkryciem głównego checkoutu oraz ekranu `.env`, MSVC z targetem x86 i Windows
SDK są wymagane do authoringu BA, CMake pozostaje narzędziem kompilacji pomocniczej,
na tym etapie instalowany jest project-owned WiX 3.14.1 z przypiętego archiwum
`candle.exe`, `light.exe`, `heat.exe`, `WixBalExtension.dll` i
`WixUIExtension.dll`. Hash archiwum w manifeście jest lokalnym dowodem pobranego
assetu i wymaga niezależnej weryfikacji przed publikacją.

Skrypt używa [`installer_env.ps1`](../../scripts/windows/installer_env.ps1) oraz
`scripts/fullmag_storage.py` do odczytu głównego `.env`, jawnego wyboru storage,
walidacji resolvera i rejestracji ścieżek przed pierwszym zapisem project-owned
narzędzi. `-Install` nie instaluje Rust, Node/pnpm, uv, just, CUDA, MPI, Ninja,
LLVM ani MFEM/hypre/libCEED; te elementy należą do pełnego buildu źródłowego i
pozostają w `setup_build_environment.ps1`. `fullmag.exe` z trasy producenta jest
nadal nieweryfikowanym artefaktem wydania: ten bootstrap nie buduje BA, MSI ani
nie dowodzi działania runtime'u.

Pełny producent instalatora source-first jest osobnym wejściem:

```powershell
# Pierwszy start może przygotować minimalne narzędzia producenta.
.\scripts\windows\build_installer_from_source.ps1 -InstallMissing -StorageRoot $storage

# Kolejne buildy, po przygotowaniu narzędzi:
just windows-installer-build
```

Producent zamraża kod, buduje BA i helper środowiska, a następnie pakuje
`fullmag.exe` przez WiX 3 Burn. Nie wymaga gotowego MSI ani wcześniejszego buildu
Fullmaga. Wynik i manifest są w profilu `windows-installer-source` rozwiązanym
przez storage; komenda wypisuje dokładną ścieżkę EXE. Wersję produktu czyta z
`[workspace.package]` zamrożonego `Cargo.toml`. Sam sukces pakowania nie dowodzi
instalacji na czystym komputerze ani wykonania FEM GPU; te bramki pozostają
`NOT VERIFIED` do osobnego sprawdzenia. Po instalacji środowiska kolejne buildy
Fullmaga używają dotychczasowych zarządzanych poleceń, bez ponownego kreatora.

Authoring Burnu ma dwa jawne tryby. Trasa release przekazuje istniejący MSI,
manifest stagingu, licencję i zweryfikowaną BA; WiX root pochodzi z
resolverowego profilu narzędzi `windows-setup`. Wywołanie wrappera powinno
zachować `-InstallerStorageProfile windows-setup`, podczas gdy
`-StorageProfile` opisuje wybraną trasę runtime. Dzięki temu setup i authoring
sprawdzają ten sam project-owned `build_root`.
Zarządzany producent source-first używa dla własnego lease/build rootu profilu
`windows-installer-source`; nie jest to wybór backendu instalacji. Source-first
jest obecnie jedyną wspieraną publiczną trasą EXE, także w workflow release.
Historyczne MSI wrapping/`Route release` pozostają fail-closed do czasu
rzeczywistego agregatu all-capability z czterema component proofs. Fizyczny
bundle `windows-native-fem-gpu` oraz agregat
`windows-full-runtime/build-manifest.json` muszą zachować cztery component proofs.
GUI nie wybiera lane Burn; wybór FDM/FEM i CPU/GPU następuje dopiero dla modelu
w aplikacji. Provenance wrappera zapisuje profile storage i narzędzi osobno.
`-WixRoot` wskazuje dokładnie
resolverowy `installer-tools\wix-3.14.1`; wrapper sprawdza receipt oraz hashe i
nie korzysta z przypadkowego `candle.exe` z globalnego `PATH`. Trasa
`-Route source-first` nie przyjmuje MSI. Wymaga zweryfikowanego
`-EnvironmentBootstrapExe` oraz jego hasha, pełnej tożsamości źródeł i
`-ProductVersion`; Burn przekazuje helperowi zaakceptowany checkout, storage,
profil, tryb `setup-only` albo `initial-build` i ścieżkę receipt. Brak helpera,
receiptu lub zgodności hashy blokuje authoring. CMake/MSVC nie są dowodem
wykonania żadnej z tych tras; clean install i runtime pozostają `NOT VERIFIED`.

## Przyszły instalator GUI

Obecny wewnętrzny artefakt pakowania to istniejący MSI z
[`scripts/windows/build_windows_msi.ps1`](../../scripts/windows/build_windows_msi.ps1),
który generuje produkt WiX 3. Publicznym artefaktem dystrybucji ma być pojedynczy
`fullmag.exe` jako bootstrapper GUI. Wewnętrzna implementacja może użyć tego MSI
wewnątrz łańcucha WiX Burn: najpierw sprawdza wymagania systemowe i uruchamia
kontrolowane prerequisites, a następnie instaluje pakiet Fullmag. MSI nie staje się
drugim publicznym artefaktem. Po instalacji kolejne
przebudowy deweloperskie pozostają zarządzane przez `just windows-build fem gpu` (lub wybraną trasę CPU/FDM) i resolver
storage. Burn jest opakowaniem istniejącego MSI; nie należy tworzyć równoległego
produktu ani niejawnie migrować WiX 3 do WiX 4 bez osobnej decyzji architektonicznej.

Zainstalowany desktop Fullmag używa Tauri (`fullmag-ui.exe`), więc instalator GUI
musi w pierwszym kroku sprawdzić Microsoft Edge WebView2 Runtime. Publiczny
`fullmag.exe` jest nazwą bootstrappera Burn, a nie binarium Tauri; sam bootstrapper
C++ nie jest klientem WebView2. Gdy runtime nie jest obecny, kontrakt przyszłego
`fullmag.exe` powinien uruchomić oficjalny Evergreen Bootstrapper WebView2 albo
zakończyć się czytelnym blokującym komunikatem przed uruchomieniem zainstalowanego
UI. Nie wolno uznać samej gotowości kompilatora za zainstalowany produkt desktopowy.
Bieżący setup środowiska nie instaluje ani nie kwalifikuje WebView2, dlatego jego raport zachowuje
`runtime: NOT VERIFIED`. Zobacz [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/)
i [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).

### Przebieg kreatora

Planowany kreator `fullmag.exe` prowadzi przez ekran powitalny, licencję,
wybór checkoutu i konfigurację `.env`, kontrolę zależności, podsumowanie
planowanych zmian, instalację z postępem oraz wynik weryfikacji. Po sukcesie
użytkownik może uruchomić Fullmaga. Rebuildy z kodu korzystają później z `just`.
Ekran licencji musi używać zatwierdzonej treści licencji produktu i udostępniać
informacje o licencjach dołączanych komponentów. Tekst licencji produktu
oraz wymagane zgody instalatorów zależności pozostają wejściami kwalifikacji
wydania; dokumentacja kreatora nie ustanawia nowych warunków licencji.

### Ekran konfiguracji `.env`

Planowany `fullmag.exe` ma zawierać ekran konfiguracji `.env` przed rozpoczęciem
instalacji. Ekran pokazuje wyłącznie pola z wersjonowanego
[`.env.example`](../../.env.example) oraz kontraktu manifestu wymagań; obecny
template obejmuje parametry `RUST_LOG`, `POSTGRES_PASSWORD`,
`MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, a także ścieżki
`FULLMAG_PROJECT_STORAGE_ROOT` i opcjonalny `FULLMAG_WINDOWS_VOLATILE_ROOT`.
Manifest [`windows_build_requirements.json`](../../windows_build_requirements.json)
wiąże wybór storage z `FULLMAG_PROJECT_STORAGE_ROOT`, resolverem i profilami.
Nowe pole wymaga najpierw zmiany wersjonowanego template/manifestu. GUI nie może
zgadywać pól na podstawie zmiennych procesu ani kopiować konfiguracji z innego
komputera.

Instalator ustala checkout przez Git, a główny checkout przez pierwszy rekord
`git worktree list --porcelain`; ekran czyta i zapisuje `.env` wyłącznie tam.
Brak metadanych `.git`, brak rekordu głównego checkoutu albo próba użycia
worktree-local `.env` blokuje instalację. Instalator nie wykonuje `git init` i nie
tworzy alternatywnego źródła konfiguracji.

Wybór `FULLMAG_PROJECT_STORAGE_ROOT` odbywa się w jawnym dialogu lokalnej ścieżki.
Przed pokazaniem możliwości zapisu instalator sprawdza absolutną ścieżkę Windows,
odrzuca ścieżki względne, drive-relative, UNC i sieciowe, a następnie uruchamia
wspólny [`fullmag_storage.py`](../../scripts/fullmag_storage.py) dla wybranego
profilu. Walidacja musi potwierdzić marker projektu, brak junction/reparse point
na całej trasie oraz preflight resolvera. Istniejąca wartość z głównego `.env`
nie może zostać po cichu zastąpiona; rozbieżność z wyborem operatora jest blokadą.
`FULLMAG_WINDOWS_VOLATILE_ROOT` pozostaje opcjonalną, lokalną ścieżką zgodną z
template i nie staje się drugim rootem storage.

Przed zatwierdzeniem użytkownik otrzymuje podgląd różnic z zamaskowanymi
sekretami. Podgląd, komunikaty i logi nie mogą zawierać wartości
`POSTGRES_PASSWORD` ani `MINIO_ROOT_PASSWORD`. Anulowanie, odrzucenie walidacji
lub błąd zapisu nie zmienia `.env`. Po zatwierdzeniu instalator wykonuje kopię
zapasową, zapisuje nową treść przez plik tymczasowy i atomową podmianę, zachowując
nieznane wpisy, komentarze i pozostałą kolejność konfiguracji. Niepowodzenie
któregokolwiek kroku pozostawia poprzedni plik jako aktywny i nie uruchamia
dalszej instalacji. Konfiguracja trafia do projektowego `.env`; GUI nie ustawia
globalnego User/Machine environment ani globalnego `PATH`.

Status tego ekranu to `NOT VERIFIED` i `planned`. Obecny
[`setup_build_environment.ps1`](../../scripts/windows/setup_build_environment.ps1)
pozostaje narzędziem check/install: czyta `.env` głównego checkoutu, a przy
`-Install -StorageRoot` może dopisać brakującą linię storage. Nie jest edytorem
GUI i nie dostarcza jeszcze kontraktu podglądu różnic, maskowania sekretów,
kopii zapasowej ani atomowej transakcji opisanej powyżej.

To jest plan integracji, nie gotowy instalator GUI. Nie ma jeszcze zatwierdzonego
łańcucha Burn, kontraktu upgrade/rollback ani dowodu działania `fullmag.exe`.
Kontrakt należy utrzymywać w [`ADR 0053`](../adr/0053-native-windows-fem-build-environment.md)
i obejmuje wersję WiX, identyfikatory pakietów prerequisites, kolejność kontroli,
ekran konfiguracji `.env` oraz własność MSI. Dokumentacja Burn:
[WiX Burn](https://docs.firegiant.com/wix/tools/burn/).

## Ścieżka po setupie

Po przejściu kontroli używaj zarządzanych wejść repozytorium. Natywny launcher
Windows i trasy backendów są opisane w
[`windows-first-development.md`](windows-first-development.md). Pełna trasa
używa rootowych recept bez przypięcia backendu:

```powershell
just windows-full-workspace-build backend=auto device=auto
just windows-full-workspace backend=auto device=auto
```

Pierwsza recepta weryfikuje lub buduje jeden supersetowy bundle
`windows-native-fem-gpu` i agregat czterech component proofs; druga otwiera pusty
unified workspace. Są to bramy installed support, nie dowody runtime ani fizyki.
Wybór backendu i urządzenia pozostaje per model w aplikacji. Istniejące
`just windows-build fem cpu/gpu` i analogiczne trasy są komponentowymi,
manualnymi ścieżkami diagnostycznymi; ich pojedynczy receipt nie daje zbiorczego
`Ready` i nie może cicho zastąpić wymuszonego GPU CPU.

## Co oznaczają blokady

- `missing`: narzędzie nie istnieje lub nie jest w zatwierdzonym project-owned
  katalogu;
- `not_verified`: narzędzie istnieje, ale wersja, provider receipt albo
  przypięcie nie zgadza się z manifestem;
- `pending`: component proof albo provider nie jest jeszcze gotowy; agregat
  czeka na wszystkie cztery proofs, bez uznawania pojedynczej lane za Ready;
- `blocked`: instalator, resolver, uprawnienia albo storage odmówiły działania;
- `runtime: NOT VERIFIED`: setup nie uruchomił buildu ani solvera;
- `Ready`: wyłącznie cztery poprawne proofs installed support; hardware GPU i
  runtime qualification są osobnymi statusami.

Po instalacji otwórz nową powłokę i powtórz `-Json`, a następnie sprawdź
`windows-full-runtime/build-manifest.json`. Jeżeli którykolwiek component proof
jest `pending`, agregat nie jest `Ready`. Nie podmieniaj providerów globalnym
LLVM, losowym Ninja ani fallbackiem CPU; brak sprzętu GPU pozostaje osobnym
blokiem wykonania wymuszonego GPU.

Źródła instalacyjne są dokumentowane przez właścicieli narzędzi: [Visual
Studio C++ Build Tools](https://learn.microsoft.com/en-us/cpp/build/building-on-the-command-line),
[identyfikatory workloadów i komponentów Visual Studio](https://learn.microsoft.com/en-us/visualstudio/install/workload-and-component-ids),
[winget](https://learn.microsoft.com/en-us/windows/package-manager/winget/install),
[Rustup](https://rust-lang.org/tools/install/),
[CMake](https://cmake.org/download/),
[just 1.51.0](https://github.com/casey/just/releases),
[Node.js 24.18.0](https://nodejs.org/download/release/v24.18.0/),
[uv](https://docs.astral.sh/uv/getting-started/installation/),
[CUDA na Windows](https://docs.nvidia.com/cuda/cuda-installation-guide-microsoft-windows/)
i [WiX](https://docs.firegiant.com/wix/using-wix/).
