# ADR 0053 — Powtarzalne środowisko natywnego Windows FEM

Status: accepted for implementation; aggregate installed support and runtime NOT VERIFIED.
Data: 2026-10-13.

Zastępuje Windowsową trasę FEM z [ADR 0030](0030-project-storage-and-build-concurrency.md), zachowując jego politykę storage, blokad i provenance. Nie zmienia kontenerowej trasy Linux.

## Kontekst

Skrypt FEM GPU uruchamiany z PowerShell trafiał do kontenera Linux. Trasa
była blokowana przez politykę kolejki ciężkich buildów, a storage Windows
w Docker Desktop udostępniał filesystem 9p, którego writer trwałych sesji
nie akceptuje. Użytkownik zlecił natywny build Windows i przygotowanie
środowiska również na nowym komputerze. Nie zmieniamy polityki writera,
aby dopuścić 9p, i nie wymagamy ext4 od użytkownika Windows.

## Decyzja

Windows FEM używa tych samych źródeł `backends/fem`, MFEM/hypre/libCEED,
publicznego Python DSL oraz ProblemIR. Natywny launcher przekazuje żądane
i rozwiązane urządzenie oraz używa zamkniętej operacji resolvera storage.
Wymuszone GPU kończy się błędem przy brakujących zależnościach CUDA.
Nie dopuszczamy cichego przejścia na CPU lub Docker. Linux zachowuje
istniejące zarządzane recepty kontenerowe.

Przygotowanie nowego komputera jest oddzielone od kompilacji produktu.
Manifest wymagań i skrypt setupu sprawdzają narzędzia, konfigurację storage
i brakujące komponenty. Jawny tryb instalacyjny przygotowuje narzędzia;
bootstrap providerów zamraża pełne SHA źródeł MFEM 4.9, hypre 3.1.0
i libCEED 0.12.0 oraz hashe pobieranych pakietów narzędzi. Dane projektu
pozostają w kanonicznym storage i profilu per-worktree. Nie kopiujemy
ustawień lokalnego hosta do nowego klona.

Planowany publiczny `fullmag.exe` zawiera ekran konfiguracji `.env`. Jego pola
pochodzą wyłącznie z wersjonowanego `.env.example` i manifestu wymagań; ekran
nie tworzy własnego, niejawnego słownika ustawień. Instalator ustala główny
checkout przez Git (`git worktree list --porcelain`) i czyta oraz zapisuje `.env`
głównego checkoutu, nigdy pliku worktree ani ścieżki odziedziczonej z innego
hosta. Brak metadanych Git lub głównego rekordu jest blokadą i nie może prowadzić
do `git init` ani do zgadywania konfiguracji.

Wartość `FULLMAG_PROJECT_STORAGE_ROOT` jest wybierana jawnie w dialogu ścieżki
lokalnej. Przed zmianą GUI musi wykonać walidację resolvera
`scripts/fullmag_storage.py`: ścieżka absolutna i lokalna, właściwy marker
projektu, brak junction/reparse point na trasie oraz pomyślny preflight dla
wybranego profilu. Nieznane wpisy i komentarze `.env` pozostają zachowane.
Podgląd różnic maskuje sekrety, a logi nie zawierają ich wartości. Zapis wymaga
kopii zapasowej i atomowej podmiany; anulowanie, błąd walidacji lub błąd zapisu
pozostawia dotychczasowy `.env` bez częściowej zmiany. Konfiguracja jest
projektowa: instalator nie ustawia globalnego środowiska User/Machine ani
globalnego `PATH`.

### UI instalatora: Avalonia + Fluent jako zewnętrzny proces

Docelowym interfejsem użytkownika publicznego `fullmag.exe` jest samodzielnie
publikowany proces `win-x64` oparty na Avalonia i motywie Fluent. Proces jest
payloadem Burn, ale nie jest biblioteką BA: nie może być ładowany bezpośrednio
przez WiX 3 BA x86. Natywna BA pozostaje cienkim brokerem x86, który posiada
cykl życia Burn (`Detect`, `Plan`, `Apply`, elevation, anulowanie i receipt),
uruchamia proces UI oraz przekazuje mu wyłącznie zatwierdzony kontrakt IPC.
Dotychczasowa forma Win32 w BA nie jest docelowym interfejsem użytkownika i nie
może pozostać ukrytym równoległym formularzem. Samodzielne GUI musi obsługiwać
prezentację, focus, klawiaturę, przewijanie, DPI i dostępność.

Przypięty toolchain producenta to .NET SDK `10.0.402`, target `net10.0` oraz
pakiety `Avalonia`, `Avalonia.Desktop` i `Avalonia.Themes.Fluent` w wersji
`12.1.4`. SDK i pakiety muszą zostać wpisane do osobnego, wersjonowanego
manifestu producenta oraz lock/provenance z dokładnymi hashami przed pierwszym
authoringiem. Publikacja ma być `self-contained` dla `win-x64`, więc komputer
konsumenta nie wymaga wcześniej zainstalowanego .NET. Manifest `windows_installer_build_requirements.json` deklaruje ten toolchain,
a receipt producenta wiąże SDK, payload GUI i ich hashe. Kwalifikacja źródeł,
publikacji EXE, GUI, pełnej instalacji i runtime pozostaje rozdzielona;
samo przypięcie wersji nie poświadcza żadnej z tych bram.

GUI nie wywołuje PowerShell, `fullmag_storage.py`, Git ani Burn bezpośrednio.
Przez jednorazową, uwierzytelnioną sesję IPC żąda `discover`, `preview`,
`commit`, kontroli zależności, instalacji, anulowania, uruchomienia i odczytu
postępu/receipt. Natywna BA przekazuje te żądania do istniejącego helpera
`scripts/windows/installer_env.ps1` i do zamkniętej trasy source-first. Sekrety
nie mogą trafić do argumentów procesu, logów Burn, stdout/stderr, telemetryki,
IPC po zakończeniu sesji ani receiptów. Szczegółowy kontrakt procesu, payloadu i
bram renderowania opisuje
[`windows-installer-modern-ui-20261014.md`](../plans/active/windows-installer-modern-ui-20261014.md).

SLEPc pozostaje osobnym providerem modalnym. Pierwsza natywna trasa dla
wskazanego skryptu minimalizacji używa SLEPc OFF; nie deklaruje obsługi
wszystkich workflowów modalnych. Zmiana nie dodaje semantyki fizycznej,
endpointów OpenAPI ani oddzielnego drzewa UI/viewport.

## Uzupełnienie decyzji — pełne wsparcie backendów (2026-10-15)

Instalator i pełna operacja przygotowania środowiska zawsze przygotowują
zainstalowane wsparcie dla czterech realizacji: FDM CPU, FDM GPU, FEM CPU i
FEM GPU. Instalator nie wybiera backendu ani natywnej lane. Wspólne narzędzia
mogą być współdzielone, ale dowód każdej realizacji pozostaje jawny i związany
ze źródłem, profilem, providerami, artefaktami oraz hashami.

Fizycznym artefaktem tej trasy jest jeden supersetowy bundle profilu
`windows-native-fem-gpu`; nie budujemy czterech osobnych bundle'i ani czterech
fizycznych wariantów tylko po to, aby uzyskać cztery dowody. Bundle i jego
komponenty są publikowane przez agregat
`windows-full-runtime/build-manifest.json`, który musi zawierać cztery
niezależne proofs komponentów: `fdm_cpu`, `fdm_gpu`, `fem_cpu` i `fem_gpu`.
Pojedynczy build może dostarczyć więcej niż jeden komponent, lecz jego receipt
nie może udawać wykonania ani rozstrzygnięcia GPU.

`Ready` oznacza wyłącznie zweryfikowane installed support wszystkich czterech
komponentów i spójność agregatu. Nie oznacza obecności sprzętu GPU, widoczności
sterownika, uruchomienia solvera, kwalifikacji runtime ani kwalifikacji fizyki.
Brak, mismatch lub nieważność jednego component proof blokują agregat; stare
single-lane receipts nie wystarczają do `Ready`. Status hardware GPU i osobne
receipty wykonania zachowują własne pola; requested/resolved execution nie jest
wypełniane przez receipt samego buildu.

Rootowe recepty `windows-full-workspace-build` i `windows-full-workspace`
uruchamiają pełną trasę z `backend=auto` i `device=auto`. Nie przyjmują
przypięcia FDM/FEM ani CPU/GPU jako wyboru instalatora. Po otwarciu pustego,
jednego workspace aplikacja wybiera backend i urządzenie dla konkretnego modelu
zgodnie z istniejącym API. Nie zmieniamy publicznego DSL, ProblemIR ani
semantyki planera. Wymuszone GPU przy braku sprzętu lub runtime kończy się
jawnym błędem i nie przechodzi cicho na CPU.

Agregat, cztery component proofs i integracja obu recept są obecnie
**NOT VERIFIED**. Próba `FEM34113` zakończyła się błędem podczas pakowania
brakującego receiptu Boost; ten historyczny attempt nie może zasilać zbiorczego
`Ready` bez pozostałych proofs i agregatu.

### Bieżący stan dowodów (2026-10-15)

Source-first producer `32521` zakończył się terminalnym `PASS/0`, ale jest to
starszy dowód single-lane i nie poświadcza agregatu czterech realizacji.
Następna próba FEM `34113` zakończyła kompilację wszystkich targetów C++/CUDA
oraz Rust, lecz zakończyła się podczas pakowania z powodu brakującego receiptu
przypiętego providera Boost. Zakres poprawki wymaganych nagłówków Boost, pięć
kontroli natywnych i tylko do odczytu admission/receipt validation providera
(checkpoint `61949`) zakończyły się terminalnym `PASS`. Installed support
wszystkich czterech realizacji, agregat, runtime i kwalifikacja fizyki pozostają
**NOT VERIFIED**.

## Uruchomienie workspace po pierwszym buildzie

Source-first `initial-build` przygotowuje rzeczywisty statyczny pakiet workspace,
a nie wyłącznie binarium headless. Pełna trasa korzysta z jednego supersetowego
bundle'u `windows-native-fem-gpu` oraz agregatu
`windows-full-runtime/build-manifest.json`; cztery component proofs nie oznaczają
czterech fizycznych buildów. Rootowe recepty `windows-full-workspace-build` i
`windows-full-workspace` uruchamiają odpowiednio build i pusty workspace z
`backend=auto device=auto`, bez przypięcia backendu. Ich integracja pozostaje
**NOT VERIFIED**.

FEM otwiera ten sam kanoniczny pusty workspace przez jawne `fullmag ui --browser`.
Domyślne `fullmag ui` zachowuje klienta desktopowego. Nie dodajemy przykładowej
symulacji ani nowego endpointu, klienta API, drzewa viewportu czy semantyki IR.
Fizyczny bundle profilu `windows-native-fem-gpu` opisuje superset zainstalowanego
wsparcia, a agregat wylicza cztery component proofs; pusty workspace nie ma jeszcze
modelu fizycznego. Aplikacja wybiera backend i urządzenie dla modelu. Każde
późniejsze wykonanie musi nadal zachować requested/resolved execution i odmówić
cichego fallbacku GPU na CPU.

Manifest pakietu jawnie poświadcza obsługę browser workspace oraz inventory
frontendu, CLI/API, DLL i providerów. Pakiet headless bez tego poświadczenia
nie może zostać użyty przez ścieżkę UI. Runtime zachowuje profil FEM, preflight,
lease i terminalny receipt; nie przechodzi przez validator pakietu FDM-only.
Heavy slot obowiązuje podczas builda, a nie przez cały czas działania interfejsu.
Żywa lease używanego pakietu nadal chroni go przed nadpisaniem. Przeglądarka
korzysta z własnego portu i instancji API; nie wolno dołączać do obcego workspace
na zajętym porcie. Domyślny port FEM może być wybierany dynamicznie.

Prywatny tryb helpera `launch-ui` ponownie waliduje zaakceptowany checkout,
admission, `.env`, profil i ukończony receipt pierwszego buildu. Nie nadpisuje
tego receiptu i nie instaluje narzędzi. BA uruchamia go asynchronicznie, z
jawnym statusem żądania startu; samo utworzenie procesu nie dowodzi renderowania
UI. Browser opener należy do CLI, więc BA nie otwiera drugiej karty. Wymóg
WebView2 dotyczy klienta desktopowego, nie browser workspace FEM.

Ta część kontraktu jest przyjęta do implementacji. Wymaga osobnych dowodów
native CLI/build, rzeczywistego GUI instalatora, API/browser/WebGL i wykonania
FEM GPU; do ich uzyskania pozostaje **NOT VERIFIED**.

## Obowiązki implementacji i weryfikacji

- `setup_build_environment.ps1` i manifest wymagań: read-only check, jawny
  install, zachowanie istniejącego `.env`, konfiguracja storage nowego klona.
- Przyszły `fullmag.exe`: ekran pól zgodny z template/manifestem, wybór głównego
  checkoutu i storage, resolver/marker/reparse/preflight, redagowany diff,
  backup i atomowy zapis z transakcją anulowania/błędu; GUI pozostaje `planned`,
  `NOT VERIFIED`.
- `native_fem_dependencies.ps1` oraz `native_ceed/`: przypięte wejścia,
  MSVC ABI, CUDA, spójne alloc/free, inventory i brak kompilacji unit tests.
- Agregat `windows-full-runtime/build-manifest.json`: cztery jawne component
  proofs z jednego bundle'u `windows-native-fem-gpu`; brak proofu jednej lane
  pozostaje blokadą `Ready`.
- `fullmag_storage.py` i launchery: preflight, lease, heavy lock, snapshot
  źródeł, DLL audit/hash, requested/resolved execution i terminalny receipt.
- Dowód zainstalowanego wsparcia wszystkich czterech realizacji oraz osobne
  dowody wykonania CPU/GPU i walidacji fizyki. Wszystkie te bramy pozostają
  **NOT VERIFIED**; parser i testy orkiestracji ich nie zastępują.

## Zgodność i rollback

Historyczna trasa Docker pozostaje jawnie wybieraną zgodnością przez
`FULLMAG_FORCE_WINDOWS_FEM_DOCKER=1`; nie jest fallbackiem po błędzie
natywnym. Ma własne wymagania storage i kwalifikacji. Poprzedni zweryfikowany
pakiet oraz wyniki sesji pozostają zachowane po nieudanej kompilacji.
Publiczny instalator okienkowy ma nazywać się `fullmag.exe`. Gotowy plik
jest publikowany wyłącznie jako asset GitHub Releases; repozytorium Git zawiera
źródła, authoring i manifesty, a nie EXE/MSI. Drugą trasą jest lokalna budowa
instalatora ze źródeł przez `build_installer_from_source.ps1` lub, po
przygotowaniu narzędzi, `just windows-installer-build`.

Lokalny producent używa WiX 3 Burn, osobnego zamkniętego profilu
`windows-installer-source` i zamrożonych źródeł. Minimalny bootstrap producenta
przygotowuje Git, Python, MSVC x86, Windows SDK, CMake i przypięty WiX;
nie wymaga wcześniejszego buildu Fullmaga ani gotowego MSI. Source-first bundle
zawiera rzeczywisty helper przygotowania środowiska i pierwszego zarządzanego
buildu. Jest to obecnie jedyna wspierana publiczna trasa EXE; historyczne MSI
wrapping/`Route release` pozostają fail-closed do czasu rzeczywistego agregatu
all-capability z czterema component proofs. Po jednorazowym przygotowaniu
środowiska kolejne rebuildy pozostają zarządzane przez recepty `just windows-build`
i `just fullmag`.

GUI oraz ekran konfiguracji `.env` wymagają osobnego dowodu runtime i mają
status `NOT VERIFIED`; sam skrypt setupu nie jest ich implementacją. Kopia zapasowa
`.env` stanowi punkt powrotu przed atomową podmianą. Anulowanie lub błąd przed
zatwierdzeniem nie może zmienić pliku ani uruchomić instalacji.
Pełne wydanie instalatora i clean-install wymagają osobnej kwalifikacji.
