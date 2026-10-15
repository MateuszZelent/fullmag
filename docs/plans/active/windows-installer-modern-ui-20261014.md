# Projekt nowoczesnego GUI instalatora Windows — Avalonia + Fluent

Data: 2026-10-14
Status: **UI implemented / aggregate installed support and runtime NOT VERIFIED**
Powiązane decyzje: [ADR 0053](../../adr/0053-native-windows-fem-build-environment.md),
[plan publicznego `fullmag.exe`](windows-installer-exe-20261013.md)

Ten dokument opisuje zaimplementowaną granicę nowoczesnego interfejsu
instalatora oraz pozostałe bramy runtime. Manifest producenta, projekt
Avalonia/Fluent, mirror źródeł, pinned .NET SDK receipt i kontrolowany NuGet
restore są już opisane w kodzie. Dokument nie jest dowodem uruchomienia GUI,
działającego Burna na clean-host ani kwalifikacji runtime.

## Decyzja technologiczna

Publiczny artefakt nadal nazywa się `fullmag.exe` i pozostaje bootstrapperem
WiX 3 Burn. Jego użytkowym interfejsem jest osobny proces Avalonia z motywem
Fluent, publikowany jako self-contained `win-x64`. Projekt źródłowy nazywa się
`Fullmag.Setup.UI`, a zweryfikowana nazwa assembly i prywatnego payloadu to
`FullmagInstallerUi` oraz `FullmagInstallerUi.exe`; te wartości pochodzą ze
wspólnego manifestu producenta.

Burn ładuje natywną BA x86, ponieważ aktualny WiX 3 ABI i `balutil.lib` są
32-bitowe. Ta BA jest brokerem cyklu życia Burn: obsługuje `Detect`, `Plan`,
`Apply`, elevation, anulowanie, receipt i zamknięcie. Uruchamia zewnętrzne GUI
z payloadu i przekazuje mu sesję IPC. Avalonia nie jest ładowana jako DLL BA i
nie jest ograniczana do architektury x86. Zewnętrzne GUI jest jedynym
interfejsem użytkownika; dotychczasowy formularz Win32 BA nie może pozostać
ukrytym równoległym formularzem ani fallbackiem prezentacji.

Istniejący Tauri `fullmag-ui.exe` pozostaje zainstalowanym klientem desktopowym
workspace. Nie jest instalatorem, nie zastępuje GUI Burn i nadal ma własny wymóg
WebView2. Avalonia nie używa WebView2 jako warunku uruchomienia instalatora.

Decyzja wynika z bieżących źródeł: [`FullmagBootstrapperApplication`](../../../scripts/windows/installer/FullmagBootstrapperApplication/)
jest BA Win32 x86, [`Fullmag.Bundle.wxs`](../../../scripts/windows/installer/Fullmag.Bundle.wxs)
jest authoringiem WiX 3, a [`installer_env.ps1`](../../../scripts/windows/installer_env.ps1)
jest istniejącym helperem sesji `.env`. Zainstalowany klient Tauri i jego
binarium `fullmag-ui` są opisane w
[`apps/desktop/src-tauri/Cargo.toml`](../../../apps/desktop/src-tauri/Cargo.toml).
Piny minimalnego producenta oraz kontrakt GUI/NuGet wynikają z
[`windows_installer_build_requirements.json`](../../../windows_installer_build_requirements.json).
`.NET SDK` pozostaje narzędziem project-owned producenta; nie jest wymagany na
komputerze konsumenta.

## Kontrakt instalacji wszystkich realizacji

Modern UI nie wybiera backendu instalacji. Publiczny `fullmag.exe` przygotowuje
installed support FDM CPU, FDM GPU, FEM CPU i FEM GPU przez jeden fizyczny
supersetowy bundle `windows-native-fem-gpu`. Agregat
`windows-full-runtime/build-manifest.json` zawiera cztery jawne component
proofs (`fdm-cpu`, `fdm-gpu`, `fem-cpu`, `fem-gpu`) i wspólną tożsamość
bundle'u; nie oznacza to czterech fizycznych buildów.

Status `Ready` jest dozwolony wyłącznie po pozytywnej walidacji wszystkich
czterech proofs. Hardware GPU, sterownik, wykonanie solvera i physics
qualification są oddzielnymi statusami. Brak GPU nie unieważnia installed
support, ale wymuszone wykonanie GPU kończy się błędem bez CPU fallbacku.
Receipt buildu nie wypełnia pól requested/resolved execution. Aplikacja otwiera
jeden pusty unified workspace i wybiera backend oraz urządzenie dla modelu przez
istniejące API; DSL i planner pozostają bez zmian.

Rootowe recepty `windows-full-workspace-build` i `windows-full-workspace`
uruchamiają `backend=auto device=auto`. Ich integracja i cztery proofs są
obecnie **NOT VERIFIED**; historyczne single-lane receipty nie dają `Ready`.

## Aktualny checkpoint producenta (2026-10-15)

Source-first producer `32521` zakończył się kodem 0. Jest to jednak dowód
starszej trasy single-lane; nie poświadcza agregatu czterech realizacji,
pełnego Burn runtime ani instalacji na czystym hoście.

Pierwsza próba GUI (`43686`, przygotowanie `97213`) nie dowodziła przejścia do
Environment: harness uznał obecność kontenera za gotowy ekran, zanim asynchronicznie
opublikowano pola. Zakończenie z brakiem pola sekretnego nie jest dowodem błędu
zapisu ani dowodem działającego formularza; nie odnotowano zapisu `.env`, wycieku
sekretu ani pozostawionego procesu.

Na artefakcie starszej trasy późniejszy test GUI `29483` rzeczywiście
wyświetlił Environment, sześć pól i edycję `RUST_LOG`. Akcja przejścia była
jednak wyłączona, ponieważ `OnFieldChanged` resetował stan po spełnieniu
warunku Environment. Źródłowa poprawka wiąże `CanPrimaryAction` z
`HasAdmission && EnvironmentFields.Count > 0`; jej kontrola źródłowa/protokół
przeszła. Pełny preview/commit `.env`, clean-host i runtime pozostają
`NOT VERIFIED`.

Managed FEM attempt `34113` zakończył kompilację wszystkich targetów C++/CUDA
oraz Rust, ale zakończył się podczas pakowania z powodu brakującego receiptu
przypiętego providera Boost. Poprawka zakresu Boost, pięć kontroli natywnych
i read-only admission/receipt validation providera (checkpoint `61949`)
zakończyły się terminalnym `PASS`. Pełny aggregate, uruchomienie FEM i runtime
pozostają `NOT VERIFIED`.

Eksperymentalny cache narzędzi został odłożony. Kandydat, testy i ograniczenia
pozostają w `/tmp/fullmag-tool-cache-candidate-20261015/`, a worktree wrócił
do wcześniejszej ekstrakcji narzędzi. To świadomie zachowuje lukę wydajnościową;
nie jest dowodem kwalifikacji kolejnych przebudów.

## Piny producenta i payload

Rekomendowany, dokładny zestaw wejściowy implementacji:

| Wejście | Pin | Zakres | Status dowodu |
| --- | --- | --- | --- |
| .NET SDK | `10.0.402`, Windows x64 | Tylko producent GUI; target `net10.0` | Manifest, `global.json`, extracted-tree receipt, `dotnet --version` i producer run `8ac65ab017dd4276bbaa7cdd8bf90b4f` potwierdzone; uruchomienie GUI NOT VERIFIED |
| `Avalonia` | `12.1.4` | API i aplikacja | Direct pin, locked restore/hash inventory i payload runu `8ac65ab017dd4276bbaa7cdd8bf90b4f` potwierdzone; runtime GUI NOT VERIFIED |
| `Avalonia.Desktop` | `12.1.4` | Windows desktop backend | Direct pin, locked restore/hash inventory i payload runu `8ac65ab017dd4276bbaa7cdd8bf90b4f` potwierdzone; runtime GUI NOT VERIFIED |
| `Avalonia.Themes.Fluent` | `12.1.4` | Motyw i kontrolki Fluent | Direct pin, locked restore/hash inventory i payload runu `8ac65ab017dd4276bbaa7cdd8bf90b4f` potwierdzone; render NOT VERIFIED |
| Burn | WiX 3.14.1, istniejący pin | Natywna BA x86 i bundle | BA/helper, Candle/Light i source-first EXE runu `8ac65ab017dd4276bbaa7cdd8bf90b4f` potwierdzone; Burn runtime i clean-host pozostają NOT VERIFIED |

Producent czyta ten zestaw z wersjonowanego manifestu. `global.json` wybiera
dokładnie `10.0.402` z polityką odrzucającą roll-forward, a setup sprawdza hash
archiwum i receipt extracted tree przed użyciem `dotnet.exe`. Builder wykonuje
restore z jednym jawnym źródłem NuGet, używa wersjonowanego locka
`s/ui/packages.lock.json` jako wejścia mirroru i uruchamia restore w trybie
`--use-lock-file --locked-mode`,
sprawdza target `net10.0/win-x64`, porównuje transitive package inventory z
lockiem i zapisuje dla każdego pakietu wersję, NuGet content hash oraz SHA-256 i
SHA-512 lokalnego `.nupkg` w provenance. Publikacja używa `--no-restore` po tym
sprawdzeniu.

Aktualny `windows_installer_build_requirements.json` obejmuje Git/Python/MSVC
x86/Windows SDK/CMake/WiX, .NET SDK oraz trzy bezpośrednie pakiety Avalonia.
Manifest i źródłowe testy opisują kontrakt producenta. W historycznym producer runie `8ac65ab017dd4276bbaa7cdd8bf90b4f`
rzeczywisty locked restore, publikacja C#/XAML self-contained single-file,
payload inventory, Candle/Light i finalny wrapper zakończyły się sukcesem.
Ograniczony smoke GUI potwierdził wybrane ekrany i anulowanie; pełne GUI,
uruchomienie z cache Burn i kwalifikacja wydania pozostają NOT VERIFIED.

Publikacja musi być `self-contained` dla `win-x64`, aby obecność .NET na nowym
komputerze nie była prerequisite GUI. Nie wolno jednak zakładać, że wynik jest
jednym plikiem: authoring przyjmuje cały katalog publikacji albo udowodniony
single-file output. Manifest payloadu rejestruje względną ścieżkę, rozmiar i
SHA-256 każdego pliku oraz relację do zamrożonego builda. Burn nie może pobierać
brakujących DLL z PATH ani z globalnego środowiska.

Wersjonowany `s/ui/packages.lock.json` jest wejściem release i pozostaje poza
`s/ui/obj`, które zawiera wyłącznie wygenerowane artefakty restore/publish.
Builder sprawdza przed i po restore targety, wersje, content hash, lokalne
archiwa `.nupkg` oraz osobno trzy SDK-driven runtime packs; nie używa
`--force-evaluate` ani nie generuje locka podczas produkcji. Ten kontrakt jest zaimplementowany i został wykonany w historycznym producer runie `8ac65ab017dd4276bbaa7cdd8bf90b4f`:
locked restore, publish payloadu oraz integralność inventory są potwierdzone.
Ograniczony smoke GUI jest opisany w sekcji dowodów; uruchomienie z cache Burn,
pełne GUI i kwalifikacja wydania pozostają **NOT VERIFIED**. Sam publish nie
dowodzi zachowania na czystym hoście.

## Granice procesów i IPC

Przepływ ma cztery rozdzielone odpowiedzialności:

| Proces/granica | Odpowiedzialność | Czego nie robi |
| --- | --- | --- |
| WiX 3 Burn + natywna BA x86 | Lifecycle Burn, elevation, plan/apply, cancellation, receipt, broker IPC | Nie renderuje docelowego formularza Win32 i nie zapisuje `.env` samodzielnie |
| `FullmagInstallerUi.exe` (`Fullmag.Setup.UI`, Avalonia/Fluent, win-x64) | Ekrany, walidacja prezentacyjna, focus/Tab, scroll, DPI, dostępność, redagowany diff, komunikaty postępu | Nie uruchamia PowerShell/Git/Burn, nie rozwiązuje storage i nie zapisuje `.env` |
| `installer_env.ps1` oraz zamknięty helper source-first | Git main checkout, template/manifest pól, resolver/marker/reparse/preflight, preview/commit/cancel, backup i atomowy zapis | Nie renderuje GUI i nie przyjmuje sekretów z command line |
| Skrypty producenta/chain | Przypięty setup, source-first initial build albo release MSI, provenance | Nie udaje sukcesu przez pusty `ExePackage` ani nie tworzy globalnego PATH |

Sesja IPC musi mieć wersję schematu, jednorazowy nonce lub równoważny token,
kontrolę ACL/tożsamości procesu oraz jawny stan terminalny. Minimalne operacje
to `hello/capabilities`, `discover`, `preview`, `commit`, `check`, `install`,
`cancel`, `launch`, `progress/receipt` i `shutdown`. Konkretne kodowanie
wiadomości pozostaje decyzją implementacyjną, lecz nie może rozszerzać granicy
uprawnień.

BA tworzy sesję i sprawdza, że połączenie pochodzi od uruchomionego GUI z tego
samego kontekstu użytkownika. GUI nie otrzymuje haseł w argumentach procesu,
nie wypisuje ich do stdout/stderr i nie zapisuje ich w lokalnym logu. Odpowiedzi
helpera, logi Burn, statusy i receipt są redagowane; wartości sekretów mogą być
używane tylko w pamięci sesji, jeżeli helper wymaga ich do walidacji. Zamknięcie
GUI, anulowanie Burn lub zerwanie IPC musi zakończyć helper i zostawić `.env`
oraz receipt w stanie wynikającym z transakcji, bez osieroconego procesu.

## Ekrany i przebieg

GUI ma prowadzić użytkownika przez jeden jawny przepływ:

1. ekran powitalny i licencja;
2. wybór trasy: gotowy payload release albo source-first z checkoutu Git;
3. `discover` głównego checkoutu przez broker;
4. formularz `.env` z polami tylko z `.env.example` i manifestu;
5. dialog lokalnej ścieżki `FULLMAG_PROJECT_STORAGE_ROOT`;
6. podgląd redagowanych różnic i kontroli zależności;
7. zatwierdzenie transakcji, backup i atomowy zapis;
8. plan/apply Burn albo source-first setup/initial build z postępem;
9. weryfikacja receipt/provenance i kontrolowane zakończenie.

Dialog storage musi wymagać jawnej, absolutnej ścieżki lokalnej. Broker i helper
sprawdzają marker, brak junction/reparse point, preflight właściwego profilu,
istniejący `.env` oraz zgodność z głównym checkoutem. Anulowanie przed
`commit` nie zapisuje pliku i nie planuje instalacji. Nieznane wpisy i komentarze
`.env` są zachowane, a błędny zapis nie może pozostawić częściowego pliku.

Source-first jest obecnie jedyną wspieraną publiczną trasą EXE, także w workflow
release. Historyczne `Route release`/MSI wrapping pozostają fail-closed do czasu
rzeczywistego all-capability manifestu z czterema component proofs. Source-first
nie wymaga MSI: uruchamia rzeczywisty przypięty helper i initial build albo
jawnie raportuje `setup-only`. WebView2 jest sprawdzane dopiero dla zainstalowanego
Tauri `fullmag-ui.exe`; nie jest prerequisite Avalonia GUI. Obie trasy wymagają
tego samego zweryfikowanego frozen snapshotu: release porównuje jego source
identity z MSI stage manifest, a authoring/WXS/UI czyta z tego snapshotu zamiast
z mutable checkoutu. Odczyt i publikacja są ograniczone do jawnych storage
roots oraz sprawdzonego drzewa artefaktu.

## Macierz aktualnych dowodów i granice

| Obszar | Najnowszy dowód | Status |
| --- | --- | --- |
| Producer `fullmag.exe` | Producer `32521`, terminalny `PASS/0`, starsza trasa single-lane | **PASS/0 dla tej trasy**; aggregate i runtime NOT VERIFIED |
| GUI Environment | Run `29483`: sześć pól i edycja `RUST_LOG`; poprawka `CanPrimaryAction` ma kontrolę źródłową/protokół | Pełny artifact, preview/commit `.env` i clean-host NOT VERIFIED |
| GUI `.env` preview/commit | Producer `32521` zakończony, bez dowodu pełnej transakcji `.env` | NOT VERIFIED; brak pełnego preview/commit proof |
| Pełne backendy | Jeden bundle `windows-native-fem-gpu` i agregat czterech component proofs | NOT VERIFIED; stare single-lane receipty nie dają `Ready`, brak runtime/physics qualification |
| FEM/Boost | Próba `34113`: C++/CUDA/Rust skompilowane, pakowanie zatrzymane na brakującym receiptcie Boost; poprawka zakresu + pięć kontroli natywnych | Read-only admission/receipt validation realnego providera `61949` terminalnie PASS; aggregate/runtime NOT VERIFIED |
| Tool-cache | Kandydat zachowany w `/tmp`, baseline ekstrakcji przywrócony | Odłożone; brak migracji istniejącego hosta |

Historyczne smoke/fault runs (`1243`, `96454`, `39129`, `54268`) pozostają
archiwum ograniczonych kontroli Welcome/license, Paths/Back/Cancel i procesów.
Nie dowodzą pełnego kreatora, Burn runtime, clean-host, `.env`, light/dark/DPI,
accessibility ani kwalifikacji wydania.

## Zakres implementacji i blokady

Zaimplementowany zakres obejmuje manifest SDK/NuGet, projekt Avalonia/Fluent,
mirror źródeł, payload Burn i provenance BA. Zachowuje WiX 3; modern UI jest
zewnętrznym self-contained payloadem `FullmagInstallerUi.exe`, a nie biblioteką
BA ani drugim publicznym artefaktem.

Do kwalifikacji pozostają: nowy artifact po poprawce GUI, pełna ścieżka
`.env` (preview/commit/backup/atomowość), pełny Burn/IPC, clean-host, MSI,
WebView2/Tauri, jasny motyw, poziomy DPI i accessibility. Dla FEM brakuje
ponownego linkowania po poprawce `native_ceed`, uruchomienia GPU i kontroli
fizyki; nie wolno przedstawiać kompilacji CUDA/C++ jako dowodu runtime.

Stany `NOT VERIFIED` wynikają z konkretnych brakujących dowodów. Starsze runy
`8ac65ab…`, `76362`, `97621`, `96454`, `39129`, `54268` oraz wcześniejsze
próby FEM są archiwalne i nie zastępują producer `32521` ani przyszłego
kwalifikowanego buildu FEM. Pełne identyfikatory, logi i receipty
pozostają w storage runów; ten plan zachowuje tylko zwięzłą macierz.
