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

## Pierwsze uruchomienie

Uruchom **Windows PowerShell**, nie WSL, z katalogu głównego checkoutu. Przy
pierwszej konfiguracji nowego klona wykonaj poniższy przykład w głównym
checkoutcie, nie w worktree; skrypt ustala
główny checkout przez `git worktree list --porcelain` i czyta `.env` głównego
checkoutu; `.env` worktree nie jest alternatywną konfiguracją. Jeżeli główny
`.env` zawiera już `FULLMAG_PROJECT_STORAGE_ROOT`, zachowaj tę wartość i uruchom:

```powershell
.\scripts\windows\setup_build_environment.ps1 -Lane native
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
.\scripts\windows\setup_build_environment.ps1 -Lane fem-gpu -Json
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

`-Lane fem-cpu` lub `-Lane fem-gpu` dodatkowo sprawdza przypięty bootstrap
FEM. Obowiązujące piny to:

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
.\scripts\windows\setup_build_environment.ps1 -Install -Lane native -WithWix
```

`-WithWix` sprawdza obecnie narzędzie `wix.exe` dla przyszłego authoringu
bootstrappera Burn. Istniejący [`build_windows_msi.ps1`](../../scripts/windows/build_windows_msi.ps1)
wywołuje WiX 3 przez `candle.exe` i `light.exe`; przejście kontroli `-WithWix`
nie potwierdza gotowości tej ścieżki MSI. Obecna kwalifikacja MSI pozostaje
`NOT VERIFIED`.

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
Windows i trasy FEM są opisane w
[`windows-first-development.md`](windows-first-development.md). Dla FEM
obowiązuje `scripts/windows/run_fullmag_fem.ps1` oraz przypięty provider
bootstrap; hostowy `cmake`, `cargo` lub bezpośrednia biblioteka mogą być tylko
diagnostyką, gdy istnieje zarządzana recepta.

Przykładowy następny krok po instalacji narzędzi FEM:

```powershell
.\scripts\windows\setup_build_environment.ps1 -Lane fem-gpu
just windows-build fem gpu
```

`just windows-build fem gpu` jest zarządzaną receptą, która przygotowuje
przypiętego providera i przechodzi do właściwej trasy FEM. Dla CPU użyj
`just windows-build fem cpu`. To jest już próba buildu/runtime’u i wymaga
własnych wejść, profilu, locka i receiptów. Zielony raport setupu sam w sobie
ich nie tworzy; niższy launcher
`scripts/windows/run_fullmag_fem.ps1` pozostaje granicą wykonania recepty.

## Co oznaczają blokady

- `missing`: narzędzie nie istnieje lub nie jest w zatwierdzonym project-owned
  katalogu;
- `not_verified`: narzędzie istnieje, ale wersja, provider receipt albo
  przypięcie nie zgadza się z manifestem;
- `pending`: provider jest własnością zarządzanego bootstrapu i czeka na
  `just windows-build fem gpu` albo odpowiadającą trasę CPU;
- `blocked`: instalator, resolver, uprawnienia albo storage odmówiły działania;
- `runtime: NOT VERIFIED`: setup nie uruchomił buildu ani solvera.

Po instalacji otwórz nową powłokę i powtórz `-Json`. Jeżeli raport zawiera
`compiler_ready_provider_pending`, uruchom właściwy zarządzany bootstrap FEM z
jawnie wybranym profilem i architekturami CUDA; nie podmieniaj go globalnym
LLVM, losowym Ninja ani fallbackiem CPU.

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
