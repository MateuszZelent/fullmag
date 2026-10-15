# Plan: publiczny instalator `fullmag.exe` dla Windows

Data: 2026-10-13
Status: **producer implemented / aggregate installed support NOT VERIFIED / runtime NOT VERIFIED**
Zakres przeglądu: istniejący pakiet WiX 3 MSI, Tauri desktop, setup środowiska,
kontrakt konfiguracji `.env` oraz zewnętrzny interfejs Avalonia/Fluent.
Ten dokument porządkuje kontrakt i zakres authoringu Burn; nie zmienia
istniejącego MSI i nie potwierdza clean install ani gotowości GUI.

## Cel i granice

Wydaniem publicznym ma być jeden plik `fullmag.exe`, będący graficznym
bootstrapperem WiX Burn. Obowiązują dwie trasy:

1. konsument pobiera gotowy `fullmag.exe` wyłącznie z GitHub Releases; plik
   wykonywalny nie jest przechowywany w repozytorium Git i nie jest budowany na
   komputerze konsumenta;
2. producent pracuje ze sklonowanym lub poprawnie skopiowanym checkoutem Git.
   Source-first Burn najpierw wykonuje rzeczywisty, przypięty setup środowiska i
   uzgodniony pierwszy build zarządzany albo jawnie kończy się jako `setup-only`;
   nie może uruchamiać pustego pakietu tylko po to, aby spełnić schemat Chain.

Source-first jest obecnie jedyną wspieraną publiczną trasą budowy EXE, także
w workflow release. Istniejący `fullmag.msi` i `Route release` pozostają
historycznym wariantem wewnętrznym i są fail-closed do czasu dostarczenia
rzeczywistego agregatu all-capability z czterema component proofs; nie są
wymaganiem source-first ani drugim publicznym artefaktem. Po przygotowaniu
środowiska kolejne przebudowy deweloperskie pozostają obsługiwane przez
zarządzane recepty `just windows-build` i resolver storage.

## Kontrakt gotowości wszystkich backendów

Publiczny instalator przygotowuje installed support dla czterech realizacji:
FDM CPU, FDM GPU, FEM CPU i FEM GPU. Fizycznym artefaktem source-first jest
jeden supersetowy bundle `windows-native-fem-gpu`; nie powstają cztery fizyczne
buildy. `windows-full-runtime/build-manifest.json` jest agregatem i musi
wskazywać cztery niezależne component proofs (`fdm-cpu`, `fdm-gpu`, `fem-cpu`,
`fem-gpu`) oraz wspólną tożsamość bundle'u, źródła i hashy.

`Ready` może oznaczać tylko installed support wszystkich czterech proofs. Nie
jest to hardware GPU, wykonanie solvera ani kwalifikacja fizyki. Receipt buildu
potwierdza capability/artifact, nie requested/resolved execution. Brak lub
mismatch proofu blokuje agregat, a stare single-lane receipts nie wystarczają.
Wymuszone GPU musi zgłosić błąd bez CPU fallbacku.

Rootowe recepty `windows-full-workspace-build` i `windows-full-workspace`
przyjmują `backend=auto device=auto`; nie przypinają backendu w instalatorze.
Pusty unified workspace pozwala aplikacji wybrać backend i urządzenie dla
modelu przez istniejące API. Nie zmieniamy DSL, ProblemIR ani publicznego
planera. Agregat i integracja recept są **NOT VERIFIED**.

### Decyzja interfejsu instalatora

Docelowe GUI instalatora używa Avalonia z motywem Fluent i jest publikowane jako
zewnętrzny, samodzielny proces `win-x64`. Publiczne `fullmag.exe` nadal jest
jednym bootstrapperem WiX 3 Burn; proces Avalonia jest jego payloadem UI, a nie
drugim publicznym artefaktem i nie jest biblioteką BA. Natywna BA pozostaje
brokerem x86 dla WiX 3: utrzymuje `Detect`/`Plan`/`Apply`, elevation,
anulowanie, receipt i przekazywanie żądań do helpera. Dotychczasowy formularz
Win32 w BA nie jest docelowym interfejsem i nie może być ukrytym fallbackiem
obok nowego GUI.

Proces Avalonia nie wywołuje PowerShell, Git, Burn ani `fullmag_storage.py`.
Łączy się z brokerem przez jednorazową, uwierzytelnioną sesję IPC i otrzymuje
wyłącznie jawny kontrakt `discover`/`preview`/`commit`, kontroli zależności,
instalacji, anulowania, uruchomienia oraz postępu i receiptów. Szczegółowy
projekt procesu, payloadów, pinów oraz bram renderowania znajduje się w
[`projekcie UI Avalonia + Fluent`](windows-installer-modern-ui-20261014.md).
### Aktualny checkpoint producenta (2026-10-15)

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

## Macierz aktualnych dowodów i granice

| Obszar | Dowód | Status |
| --- | --- | --- |
| Publiczny payload | Producer `32521`, terminalny `PASS/0`, starsza trasa single-lane | **PASS/0 dla tej trasy**; aggregate i runtime NOT VERIFIED |
| GUI Environment | `29483`: sześć pól i `RUST_LOG` po edycji; poprawka `CanPrimaryAction` ma kontrolę źródłową/protokół | Pełny artifact, preview/commit `.env` i clean-host NOT VERIFIED |
| FEM GPU | `34113`: C++/CUDA/Rust skompilowane; pakowanie zatrzymane na brakującym receiptcie Boost | NOT VERIFIED; brak aggregate/provider/runtime proof |
| Boost provider | Poprawka zakresu + pięć kontroli natywnych | Kontrole i read-only admission/receipt validation realnego providera `61949` terminalnie PASS; aggregate/runtime NOT VERIFIED |
| Tool-cache | Kandydat zachowany w `/tmp`, baseline ekstrakcji przywrócony | Odłożone; istniejący host nie migrowany |

Pierwsza próba `43686`/`97213` miała przedwczesną obserwację kontenera i nie
stanowi dowodu wejścia do Environment. Późniejsze `29483` jest ograniczonym,
rzeczywistym dowodem widoku i edycji pól, lecz nie kwalifikuje całej ścieżki.

## Stan potwierdzony w źródłach

| Obszar | Dowód | Wniosek dla najmniejszej implementacji |
| --- | --- | --- |
| MSI | [`scripts/windows/build_windows_msi.ps1`](../../../scripts/windows/build_windows_msi.ps1), linie 803–872 | Produkt jest generowany inline w składni WiX 3; nie ma wersjonowanego `Product.wxs`. |
| Narzędzia MSI | ten sam skrypt, linie 441–451 i 889–899 | Obecna ścieżka używa `heat.exe`, `candle.exe`, `light.exe` oraz `WixUIExtension`; `wix.exe` z manifestu nie zastępuje tego toolchainu. |
| Payload | ten sam skrypt, linie 581–600 | Staging zawiera zarówno `bin\fullmag.exe` (CLI), jak i `bin\fullmag-ui.exe` (desktop). Publiczny Burn `fullmag.exe` musi mieć odrębne miejsce artefaktu i nie może zostać pomylony z binarium zainstalowanym. |
| Globalne środowisko | generowany `Product.wxs`, linie 836–840 | MSI ustawia systemowy `PATH` przez `Environment ... System="yes"`. To narusza kontrakt ADR 0053/guide „bez globalnego User/Machine environment ani globalnego PATH”; Burn nie naprawi tej mutacji przez samo opakowanie. |
| Licencje | root `LICENSE`, `NOTICE`, `readme.md`, `docs/guides/fullmag-licensing.md` oraz metadane pakietów | Apache-2.0 jest wdrożone dla kodu własnego Fullmag. Pełny inwentarz licencji zależności i notices wydania pozostaje `NOT VERIFIED`; root licencja nie obejmuje zewnętrznych solverów, runtime'ów ani danych. |
| Tauri | `apps/desktop/src-tauri/Cargo.toml`, sekcja `[[bin]]`; `apps/desktop/src-tauri/tauri.conf.json`, `bundle.active` | Zainstalowany klient nazywa się `fullmag-ui.exe`; bundlowanie Tauri jest wyłączone. Burn i WebView2 należą do osobnych granic. |
| Setup | [`scripts/windows/setup_build_environment.ps1`](../../../scripts/windows/setup_build_environment.ps1) oraz [`windows_build_requirements.json`](../../../windows_build_requirements.json) | Setup jest narzędziem check/install. Nie jest edytorem GUI `.env`, nie ma transakcyjnego podglądu różnic i nie kwalifikuje runtime desktopowego. |
| Kontrakt `.env` | [`docs/guides/windows-build-environment.md`](../../guides/windows-build-environment.md), linie 174–219; [`ADR 0053`](../../adr/0053-native-windows-fem-build-environment.md), linie 32–49 | Pola muszą pochodzić z `.env.example` i manifestu; zapis dotyczy głównego checkoutu wskazanego przez Git, z resolverem storage, maskowaniem sekretów, kopią zapasową i atomową podmianą. |
| Edycja `.env` | [`scripts/windows/installer_env.ps1`](../../../scripts/windows/installer_env.ps1) oraz jego funkcje `Get-FullmagInstallerEnvSession`, `Get-FullmagInstallerEnvPreview`, `Commit-FullmagInstallerEnvProposal` i `Cancel-FullmagInstallerEnvProposal` | `review_frontend` było nazwą roli/delegacji agenta, a nie modułem produktu. Rzeczywisty helper jest już osobnym, dot-sourceable skryptem i zachowuje kontrakt resolvera, pól template, redakcji sekretów, backupu oraz atomowego zapisu. BA musi wywoływać jego jawny interfejs; nie należy tworzyć modułu `review_frontend`. |

Istniejąca dokumentacja już wymaga publicznego `fullmag.exe`, zachowania WiX 3
oraz osobnej decyzji przed migracją do WiX 4
([guide](../../guides/windows-build-environment.md), linie 139–161;
[ADR 0053](../../adr/0053-native-windows-fem-build-environment.md), linie
71–84). `wix.exe` oznaczony w manifeście jako
`optional_future_burn_tool` nie jest dowodem gotowego authoringu Burn. Obecny
authoring release i source-first helper są odrębnymi wejściami kwalifikacji.

Istniejący `FullmagBootstrapperApplication` jest obecnie natywną biblioteką
Win32 x86 z interfejsem formularza i prywatnym helperem PowerShell. Docelowy podział jest obecnie skompilowany i został użyty przez producer run
`40782`: BA pozostaje brokerem Burn, a prezentacja jest zewnętrznym payloadem
Avalonia. Ten dowód dotyczy kompilacji i authoringu; nie potwierdza jeszcze
uruchomienia GUI, IPC ani clean-host.

Wcześniejszy receipt/provenance z identyfikatorem zaczynającym się od
`1e4f...` zachowuje dowód backendowego etapu: kompilacji/linkowania BA/helpera,
authoringu Candle/Light oraz source-first EXE. Ten dowód dotyczy orkiestracji i
payloadu producenta; nie kwalifikuje nowego GUI Avalonia, jego renderowania ani
publicznego doświadczenia instalatora. Nie należy usuwać tego rozróżnienia przy
aktualizacji statusu modern UI.

### Historyczne, ograniczone dowody

`40782` pozostaje historycznym dowodem backendowego BA/helpera, authoringu
Candle/Light i source-first EXE. Smoke `1243` dla artefaktu
`windows-installer-source-c8c09f771a2a484bac887b0bac967794` zapisał czytelne
`welcome.png` i `license.png` (dark Fluent, 1196×799), a `normal_cancel=true`
i kod Burn `0x4c7` potwierdzono w ograniczonym zakresie. Próba
`5aef749474cd490dbdffe9c473c84fda` pozostała niekwalifikująca.

Smoke `96454` (`745fae981ee94cbabbd2eabf410c4640`) potwierdził akceptację
licencji, trzy widoczne ścieżki, `Back` i normalny `Cancel`; pełny wizard,
`.env`, jasny motyw, DPI, clean-host i FEM pozostały poza zakresem. Render
`39129` (`f4836bb88b434fe9ae6840e78b20dad3`) potwierdził ograniczony ekran
`Paths` z kontrolkami combobox i uczciwym opisem. Fault tests `54268`
(`5516f60eaf164508ba29f4e56ddf2154`, `a9221033217148cb94c986b3a0ce6ff8`)
były syntetycznymi testami diagnostycznymi, nie kwalifikacją Burn/install/FEM.

Wcześniejszy GUI env run `97621` dowiódł szybkiej blokady preadmission i braku
zapisu `.env`, ale zakończył się timeoutem waitera; zachowujemy go jako dowód
historyczny. Aktualny błąd jest opisany w checkpointcie producenta powyżej.

## Najmniejszy proponowany podział

### 1. Source-first: rzeczywisty setup i pierwszy build bez MSI

Source-first wymaga osobnego pakietu `ExePackage` z rzeczywistym, zweryfikowanym
helperem środowiskowym. Nie wolno dodawać pustego EXE, skryptu kończącego się
bez działania ani `ExePackage`, którego jedynym celem jest przejście walidacji
schematu. Helper jest przyjmowany przez authoring z pełną ścieżką i hashem oraz
ma otrzymać od BA następujący jawny kontrakt:

```text
fullmag-installer-environment.exe
  --checkout <absolutny checkout Git>
  --storage-root <jawny lokalny root storage>
  --profile <windows-native-fdm-cpu|windows-native-fem-cpu|windows-native-fem-gpu>
  --mode <setup-only|initial-build|launch-ui>
  --receipt <ścieżka receipt w zaakceptowanym storage>
  --admission-path <prywatna ścieżka rekordu admission w runs storage>
  --admission-sha256 <64-znakowy hash rekordu admission>
```

Tryb `launch-ui` jest prywatnym uruchomieniem po ukończonym buildzie: `--receipt`
jest wtedy istniejącym wejściem, którego helper nie nadpisuje. Nie jest to tryb
pakietu instalacyjnego Burn ani zamiennik `initial-build`.

BA przekazuje wartości dopiero po `discover` i zaakceptowaniu konfiguracji
`.env`; nie używa globalnych zmiennych środowiskowych i nie przenosi sekretów.
Helper wywołuje przypięty setup producenta, a dla `initial-build` uruchamia
konkretną zarządzaną receptę pierwszego buildu. `setup-only` jest jawną opcją
diagnostyczną: zapisuje receipt z `mode=setup-only`, nie udaje zbudowanego
produktu i nie odblokowuje instalacji desktopu. `initial-build` może zakończyć
się sukcesem tylko z receiptem zawierającym wejściowy checkout, profil, pełny
hash źródeł, polecenie/receptę, hash artefaktu i terminalny status; brak albo
niezgodność receipt zatrzymuje łańcuch.

Profil `windows-installer-source` jest osobnym, zamkniętym profilem resolvera
dla storage, lease i artefaktów producenta. Nie wolno utożsamiać go z profilem
runtime ani traktować go jako wyboru lane. Source-first używa jednego
supersetowego bundle'u `windows-native-fem-gpu`; agregat
`windows-full-runtime/build-manifest.json` zapisuje cztery component proofs
FDM CPU/GPU i FEM CPU/GPU oraz ich wspólną tożsamość. GUI nie wybiera backendu;
receipt buildu opisuje installed support, a osobny execution receipt zachowuje
requested/resolved execution.

`Fullmag.Bundle.wxs` dla tej trasy ma zawierać wyłącznie ten `ExePackage` oraz
payloady BA/helpera potrzebne do konfiguracji. Nie może wymagać istniejącego
MSI ani traktować braku MSI jako błędu source-first. `InstallCommand` musi
wiązać zaakceptowane zmienne Burn (`FullmagSourceCheckout`,
`FullmagStorageRoot`, `FullmagStorageProfile`, `FullmagBootstrapMode`,
`FullmagReceiptPath`, `FullmagSourceAdmissionPath`,
`FullmagSourceAdmissionSha256`) i nie może zawierać wartości wpisanych na stałe z hosta.
BA ustawia te zmienne przed planowaniem, a następnie weryfikuje receipt po
`OnExecuteComplete`. Historyczny producer run `40782` potwierdził zbudowanie helpera,
admission/provenance i payloadu; `OnExecuteComplete`, pełny Burn runtime oraz
test na czystym Windows pozostają **NOT VERIFIED**.

### 2. Zachować obecnego producenta MSI jako payload WiX 3

Istniejący staging, manifest i `fullmag.msi` powinny pozostać produkowane przez
`scripts/windows/build_windows_msi.ps1`. Przed opakowaniem wydania trzeba jednak
utrzymać usunięcie generowanego wpisu systemowego `PATH` w komponencie
`PathComponent` z linii 836–840. Zmiana źródłowa została wykonana przez
właściciela MSI; kompilacja WiX 3, upgrade, uninstall i clean install pozostają
`NOT VERIFIED`. Nie wolno ukryć tych bram w authoringu Burn.

### 3. Dodać warstwę Burn w tym samym WiX 3

Nowe pliki authoringu objęte tym przyrostem:

```text
scripts/windows/installer/Fullmag.Bundle.wxs
scripts/windows/build_windows_installer_exe.ps1
scripts/test_windows_installer_exe.py
```

Istniejący helper konfiguracji pozostaje w ścieżce:

```text
scripts/windows/installer_env.ps1
```

Jest to helper dostarczony przez osobnego workera, a nie nowy moduł o nazwie
`review_frontend`.

`Fullmag.Bundle.wxs` dla trasy release powinien używać namespace WiX 3 i
wskazywać istniejący `fullmag.msi` jako `MsiPackage`.
`build_windows_installer_exe.ps1` powinien
korzystać z tego samego resolvera storage, przyjmować dokładny manifest/staging
MSI i wypisywać publiczny artefakt `fullmag.exe` poza katalogiem `bin` MSI.
Aktualny wrapper przyjmuje `-MsiPath`, `-StageManifestPath`, `-MsiSha256`,
`-StageManifestSha256`, `-LicenseFile`, `-LicenseFileSha256`, `-BootstrapperApplicationDll`,
`-BootstrapperApplicationSha256`, stabilny `-BundleUpgradeCode` oraz jawne
`-InstallerStorageProfile windows-setup`. Dla zamkniętej trasy source-first
`-StorageProfile windows-installer-source` oznacza producer storage; nie jest
to wybór lane runtime. Przed
wywołaniem `candle.exe`/`light.exe` sprawdza hash każdego payloadu, zgodność
manifestu i wspólny katalog runu. Linkowanie Burn wymaga WiX 3 oraz
`WixBalExtension`; nie wolno zastąpić `candle.exe`/`light.exe` poleceniem
WiX 4 `wix build` bez osobnego ADR.

Składnia `BootstrapperApplication SourceFile` oraz dodatkowych payloadów jest
zgodna z [oficjalnym opisem authoringu BA WiX 3](https://docs.firegiant.com/wix3/bundle/authoring_bundle_application/)
i [opisem custom BA](https://docs.firegiant.com/wix3/bundle/ba/). Dokumentacja
WiX wymaga od zewnętrznej BA eksportu `BootstrapperApplicationCreate`; ten
przyrost jedynie wiąże zweryfikowaną bibliotekę i nie udaje jej implementacji.

`WixStandardBootstrapperApplication` wystarczyłby do licencji i postępu, ale
nie daje ekranu, który czyta wersjonowany template, uruchamia resolver storage,
pokazuje redagowany diff i wykonuje atomową transakcję `.env`. Dlatego sam plik
`.wxs` nie jest kompletną implementacją. Ten przyrost nie tworzy pozornej BA:
`-BootstrapperApplicationDll` musi wskazywać zewnętrzną, zweryfikowaną bibliotekę
BA dostarczoną przez właściciela technologii, a brak biblioteki lub jej hasha
kończy się błędem przed authoringiem. Aktualny authoring przekazuje do BA
licencję, `installer_env.ps1`, manifest stagingu i receipt provenance jako
payloady.

### 3a. Zewnętrzne GUI Avalonia + Fluent

GUI musi być osobnym payloadem procesu `win-x64`, uruchamianym przez natywną BA
poza jej x86 ABI. Minimalny kontrakt produkcyjny jest następujący:

- .NET SDK `10.0.402`, target `net10.0`, publikacja `self-contained` dla
  `win-x64`;
- dokładne piny `Avalonia`, `Avalonia.Desktop` i
  `Avalonia.Themes.Fluent` `12.1.4`, zapisane w wersjonowanym manifeście
  producenta oraz lock/provenance z hashami pakietów;
- pełny katalog wyjściowy publikacji jako payload BA, z manifestem nazw, rozmiaru
  i SHA-256 każdego pliku. Nie zakłada się pojedynczego EXE, dopóki publikacja
  nie dowiedzie, że wszystkie zależności są rzeczywiście włączone;
- brak wymogu zainstalowanego .NET na komputerze konsumenta. Wymóg SDK dotyczy
  wyłącznie producenta budującego bundle i musi być rozdzielony od manifestu
  runtime FEM;
- brak bezpośredniego ładowania Avalonia DLL przez `BootstrapperApplication`.
  WiX 3 BA pozostaje natywnym x86 brokerem, a GUI może być x64.

Broker powinien przekazać procesowi tylko identyfikator sesji i dane
niebędące sekretami. IPC musi mieć wersję schematu, jednorazowy nonce, kontrolę
ACL/tożsamości procesu i terminalne zamknięcie. Żądania konfiguracji trafiają
do `scripts/windows/installer_env.ps1`; GUI nie zapisuje `.env`, nie tworzy
storage i nie uruchamia helpera z własnym command line. Zatrzymanie GUI lub
brokera musi anulować bieżącą operację, zamknąć helpera i pozostawić receipt oraz
`.env` w stanie określonym przez transakcję.

Brakujące po stronie producenta są jeszcze manifest pinów .NET/Avalonia,
authoring payloadu i most brokera. Nie wolno używać obecnego Win32 formularza
jako dowodu modernizacji ani dodawać WiX 4 tylko po to, aby osadzić GUI.
Szczegółowy model ekranów i bram opisuje
[`windows-installer-modern-ui-20261014.md`](windows-installer-modern-ui-20261014.md).

### 4. Wydzielić kontrakt konfiguracji `.env`

Rzeczywista granica helpera, wywoływanego przez custom BA, to:

```text
scripts/windows/installer_env.ps1
```

Skrypt udostępnia sesję oraz operacje odpowiadające `discover`, `preview`,
`commit` i `cancel` przez jawne funkcje PowerShell. BA może zbudować nad nimi
most interaktywny, ale sam helper nie jest GUI. Nie wolno zmieniać jego
interfejsu na moduł `review_frontend` ani przekazywać sekretów jako argumentów
procesu.
Sekrety nie mogą wystąpić w argumentach procesu, standardowym logu Burn ani
raporcie. Ścieżki i statusy mogą być przekazywane w raporcie, lecz wartości
`POSTGRES_PASSWORD` i `MINIO_ROOT_PASSWORD` muszą być stale maskowane.

Kontrakt pomocnika:

1. Odczytać `.env.example` i manifest wymagań jako jedyne źródła pól. Wykryć
   checkout przez `git worktree list --porcelain` i użyć pierwszego rekordu jako
   głównego checkoutu. Brak `.git` albo rekordu głównego kończy operację przed
   zapisem.
2. Przekazać wybraną przez operatora absolutną, lokalną ścieżkę do
   `scripts/fullmag_storage.py` i wymusić walidację markera, całej trasy bez
   junction/reparse point oraz preflight dla właściwego profilu. Odrzucić
   ścieżkę względną, drive-relative, UNC i udział sieciowy.
3. Zbudować redagowany diff, zachowując nieznane wpisy, komentarze, kolejność
   i istniejące wartości. Rozbieżność z istniejącym
   `FULLMAG_PROJECT_STORAGE_ROOT` zatrzymać i wymagać jawnej decyzji operatora.
4. Dopiero po akceptacji wykonać kopię zapasową, zapisać nową treść do pliku
   tymczasowego i atomowo podmienić `.env`. Anulowanie, błąd walidacji, błąd
   zapisu albo błąd instalacji nie może pozostawić częściowego `.env` ani
   uruchomić kolejnego kroku Burn.

BA musi wykonać tę transakcję przed instalacją per-machine MSI albo użyć
niepodniesionego pomocnika przed fazą wymagającą administratora. W przeciwnym
razie podniesiony proces może zmienić właściciela lub ACL użytkownikowego
`.env`. Obecnego `setup_build_environment.ps1` nie należy przedstawiać jako
implementacji tego kontraktu; może służyć tylko do check/install zależności i
raportu JSON.

### 5. WebView2 i pozostałe prerequisites

BA powinien wykryć Microsoft Edge WebView2 Runtime przed propozycją uruchomienia
`fullmag-ui.exe`. Brak runtime oznacza kontrolowane uruchomienie oficjalnego
Evergreen Bootstrappera WebView2 albo czytelną blokadę. Dokładny pakiet,
architektura, wersja, hash, tryb offline i zachowanie anulowania muszą zostać
zamrożone w manifeście przed authoringiem; obecny wpis manifestu ma status
`NOT VERIFIED`.

Kontrola kompilatora i providerów może korzystać z raportu
`setup_build_environment.ps1 -Json`, ale nie może traktować gotowego
kompilatora jako dowodu zainstalowanego desktopu, działającego WebView2,
wykonania FEM ani kwalifikacji fizyki. Burn nie dodaje WSL ani cichego CPU
fallbacku.

## Przebieg i granice instalacji

1. Natywna BA x86 uruchamia zweryfikowany payload Avalonia `win-x64` i przekazuje
   mu sesję IPC. Avalonia wykrywa architekturę, istniejącą wersję pakietu i
   WebView2, następnie pokazuje zatwierdzony tekst licencji oraz informacje o
   komponentach. BA nie renderuje równoległego formularza Win32.
2. Avalonia żąda przez brokera `discover`; pomocnik wyznacza główny rekord Git.
   UI pokazuje wyłącznie pola z template/manifestu.
3. Operator wybiera storage. `preview` wykonuje walidację resolvera i pokazuje
   redagowany diff. Anulowanie kończy Burn bez zapisu i bez planowania MSI.
4. Po akceptacji `commit` wykonuje backup oraz atomowy zapis `.env`. Dopiero
   udany commit odblokowuje plan instalacji.
5. BA wybiera trasę. Source-first ustawia zmienne zaakceptowanego checkoutu,
   profilu, trybu i receipt, a następnie planuje rzeczywisty `ExePackage`; nie
   dodaje MSI. Trasa release planuje istniejący MSI. Faza wymagająca
   administratora nie może przenosić sekretów w command line.
6. Po source-first Burn weryfikuje terminalny receipt setupu albo pierwszego
   buildu. Po trasie release Burn instaluje MSI per-machine, sprawdza obecność
   `bin\fullmag-ui.exe`, `bin\fullmag.exe`, rejestru i skrótu oraz zapisuje
   receipt bez sekretów.
7. Uruchomienie desktopu następuje dopiero po pozytywnym wykryciu WebView2.
   Rebuildy z checkoutu pozostają zarządzane przez `just` i kanoniczny storage;
   nie są udawanym skutkiem source-first `setup-only`.

Publiczny `fullmag.exe` w katalogu wydania jest więc Burnem; zainstalowany
`Program Files\Fullmag\bin\fullmag.exe` pozostaje CLI. Oba pliki nie mogą być
ze sobą utożsamiane ani nadpisywać się podczas stagingu.

## Przyrosty implementacyjne i bramki

| Przyrost | Zakres | Wymagana weryfikacja |
| --- | --- | --- |
| A. Source-first helper | Zweryfikowany `ExePackage`, parametry checkout/storage/profile/mode/receipt oraz admission path/hash, przypięty setup i rzeczywisty initial build albo jawny `setup-only`. | Parser authoringu, mocked commandline/receipt checks, a potem czysty Windows z profilem CPU i GPU; żaden no-op nie kwalifikuje trasy. |
| B. MSI contract | Usunięcie globalnego `PATH`, potwierdzenie identyfikatorów i zachowania upgrade/uninstall istniejącego MSI. | WiX 3 compile/link oraz czysta maszyna Windows; do tego czasu MSI `NOT VERIFIED`. |
| C. Burn authoring | `Fullmag.Bundle.wxs`, build wrapper i zewnętrzna zweryfikowana BA DLL WiX 3 dla obu tras; publiczny output `fullmag.exe`. | Run `40782` potwierdził parser/compile/link z `candle/light`, `WixBalExtension`, payload inventory i publiczny bundle; runtime Burn, install i upgrade pozostają osobne. |
| D. `installer_env.ps1` + BA bridge | Discover/preview/commit, resolver storage, maskowanie, zachowanie komentarzy/nieznanych wpisów, backup i atomowość. | Source/interpreted checks helpera i osobno mocked BA bridge: cancel, invalid path, reparse/UNC, conflict, write error i sekret w logu; żadna ścieżka błędu nie zmienia `.env`. |
| E. BA orchestration | Kolejność `.env` → prerequisites → source-first ExePackage albo release MSI, brak sekretów w command line/logach, zachowanie elevation i rollback. | Mocked detect/plan/apply, receipt validation i testy anulowania WebView2; po nich testy na czystym Windows. |
| F. Modern UI Avalonia | Self-contained `win-x64`, Avalonia/Fluent, payload manifest, IPC z x86 BA, bez globalnego .NET i bez starego formularza Win32. | Najnowszy producer PASS/0 potwierdził manifest, EXE/UI i provenance; smoke `96454` oraz fault tests `54268` potwierdziły ograniczone przejścia i diagnostykę. Pełny Burn render `39129` zakończył się PASS/0 (evidence `f4836bb88b434fe9ae6840e78b20dad3`), a `paths.png` (`1196x799`) z nowymi kontrolkami combobox i uczciwym opisem zostało obejrzane. Render light/dark, DPI 100/150/200, Tab/focus, accessibility i pełny runtime pozostają NOT VERIFIED. |
| G. Release qualification | Apache-2.0 dla kodu własnego, third-party notices, WebView2, install/repair/upgrade/uninstall/rollback i Tauri. | Czysta maszyna bez WSL/Docker, online/offline prerequisite, non-admin/admin, rzeczywisty start `fullmag-ui.exe`; osobno runtime i physics gates. |

Historyczny producer run `40782` potwierdził C#/XAML publish, self-contained single-file
payload, hash/size inventory, Candle/Light i końcowy wrapper. Nadal nie wolno
traktować tych dowodów jako uruchomienia GUI, pełnego Burn runtime, clean install
ani działającego produktu.

## Blokery przed użyciem wydaniowym

1. **P1 — pełny artifact GUI i ścieżka `.env`.** Producer `32521` zakończył się
   PASS dla starszej trasy single-lane. Run `29483` potwierdził sześć pól i
   edycję `RUST_LOG`, a poprawka warunku akcji ma kontrolę źródłową/protokół;
   pełny preview/commit `.env`, clean-host i runtime nadal nie mają proofu.
2. **P1 — pełny Burn/runtime.** Ograniczone smoke/fault evidence nie dowodzi
   pełnego kreatora, instalacji, clean-host, upgrade/repair/uninstall ani
   uruchomienia z cache Burn.
3. **P1 — FEM.** Próba `34113` skompilowała C++/CUDA/Rust, lecz pakowanie
   zatrzymał brakujący receipt providera Boost. Poprawka zakresu Boost i pięć
   kontroli natywnych oraz read-only admission/receipt validation realnego
   providera `61949` zakończyły się terminalnym PASS; aggregate, uruchomienie
   FEM, brak fallbacku i runtime pozostają `NOT VERIFIED`.
4. **P1 — MSI, notices i clean-host.** Kwalifikacja istniejącego MSI,
   kompletnego inwentarza zależności, WebView2/Tauri oraz końcowego cyklu
   wydania wymaga osobnych dowodów.
5. **P2 — tool-cache.** Eksperymentalna migracja cache została odłożona; obecna
   ścieżka zachowuje wcześniejszą ekstrakcję. Kandydat i ograniczenia są
   archiwizowane w `/tmp/fullmag-tool-cache-candidate-20261015/`.

## Decyzja końcowa tego planu

Najmniejszy spójny kontrakt ma dwie trasy w WiX 3 Burn: natywną BA x86 jako
broker oraz zewnętrzne, self-contained GUI Avalonia/Fluent `win-x64`. Trasa
konsumencka pobiera gotowy `fullmag.exe` wyłącznie z GitHub Releases. Trasa
producenta używa jawnego checkoutu Git, transakcji `installer_env.ps1` i
zweryfikowanego source-first `ExePackage`, który wykonuje przypięty setup oraz
initial build albo jasno raportuje `setup-only`; nie wymaga MSI. Osobny wariant
release może opakować istniejący WiX 3 MSI jako wewnętrzny payload. Obecny
formularz Win32 BA nie jest docelowym UI i nie może być ukrytym fallbackiem.

`Fullmag.Bundle.wxs` i wrapper fail-closed weryfikują wejścia, hashe,
provenance, licencję Apache-2.0 dla kodu własnego oraz BA. Run `40782` dowodzi
produkcji publicznego bundle i prywatnego payloadu GUI, ale nie dowodzi jeszcze
uruchomienia GUI, WebView2, clean install, runtime desktopu, notices zależności
ani kwalifikacji FEM. Wcześniejsze dowody backendowego BA/helpera i source-first
EXE są zachowane jako węższy dowód orkiestracji i nie zastępują tych bram.


## Gotowość pełnego środowiska i bramy

Source-first producer nie kończy się statusem `Ready` po pojedynczym
single-lane receipcie. `Ready` wymaga wszystkich czterech poprawnych proofs w
`windows-full-runtime/build-manifest.json`, choć może je dostarczyć jeden
fizyczny bundle `windows-native-fem-gpu`, bez czterech osobnych buildów.
Hardware GPU, uruchomienie solvera i kwalifikacja fizyki są niezależne i nadal
mają status **NOT VERIFIED**. Rootowe `windows-full-workspace-build` oraz
`windows-full-workspace` używają `backend=auto device=auto`; aplikacja wybiera
realizację dopiero dla konkretnego modelu. Publiczny DSL i planner pozostają
bez zmian.

Bieżące producer/BA/GUI dowody dotyczą authoringu i payloadu o węższym zakresie.
Nie dowodzą jeszcze agregatu czterech component proofs ani pełnego runtime.

## Archiwalne checkpointy (2026-10-14 i wcześniejsze)

Poniższe wpisy zachowują historię prac; nie są bieżącą kwalifikacją.


Kontrakt pozostaje bez zmian: WiX 3 Burn z natywną BA x86 jako brokerem oraz
zewnętrzne, self-contained GUI Avalonia/Fluent `win-x64`. Source-first wykonuje
rzeczywisty setup i initial build albo jawnie raportuje `setup-only`; nie używa
MSI jako ukrytego wymagania i nie uruchamia WSL ani cichego CPU fallbacku.

Historyczny producer `8ac65ab017dd4276bbaa7cdd8bf90b4f` ma zachowane
receipt/provenance oraz payload proof. Pierwsza obserwacja GUI z tego etapu,
która twierdziła „Environment reached”, była przedwczesną obserwacją kontenera
przed publikacją pól i nie jest dowodem formularza ani `.env`. Managed FEM build
`3131` zakończył się przed pobraniem Boost; jego log i poprawka walidatora są
archiwalne. Bieżącą macierz dowodów podano wyżej.
