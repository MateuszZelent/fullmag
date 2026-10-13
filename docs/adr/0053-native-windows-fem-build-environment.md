# ADR 0053 — Powtarzalne środowisko natywnego Windows FEM

Status: accepted for implementation; runtime NOT VERIFIED.
Data: 2026-10-13.

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

SLEPc pozostaje osobnym providerem modalnym. Pierwsza natywna trasa dla
wskazanego skryptu minimalizacji używa SLEPc OFF; nie deklaruje obsługi
wszystkich workflowów modalnych. Zmiana nie dodaje semantyki fizycznej,
endpointów OpenAPI ani oddzielnego drzewa UI/viewport.

## Obowiązki implementacji i weryfikacji

- `setup_build_environment.ps1` i manifest wymagań: read-only check, jawny
  install, zachowanie istniejącego `.env`, konfiguracja storage nowego klona.
- Przyszły `fullmag.exe`: ekran pól zgodny z template/manifestem, wybór głównego
  checkoutu i storage, resolver/marker/reparse/preflight, redagowany diff,
  backup i atomowy zapis z transakcją anulowania/błędu; GUI pozostaje `planned`,
  `NOT VERIFIED`.
- `native_fem_dependencies.ps1` oraz `native_ceed/`: przypięte wejścia,
  MSVC ABI, CUDA, spójne alloc/free, inventory i brak kompilacji unit tests.
- `fullmag_storage.py` i launchery: preflight, lease, heavy lock, snapshot
  źródeł, DLL audit/hash, requested/resolved execution i terminalny receipt.
- Dowód rzeczywistego buildu Windows i wykonania wskazanego skryptu FEM GPU.
  Parser i testy orkiestracji nie zastępują tej bramki ani walidacji fizyki.

## Zgodność i rollback

Historyczna trasa Docker pozostaje jawnie wybieraną zgodnością przez
`FULLMAG_FORCE_WINDOWS_FEM_DOCKER=1`; nie jest fallbackiem po błędzie
natywnym. Ma własne wymagania storage i kwalifikacji. Poprzedni zweryfikowany
pakiet oraz wyniki sesji pozostają zachowane po nieudanej kompilacji.
Publiczny instalator okienkowy ma nazywać się `fullmag.exe`. Może używać
MSI wewnętrznie; po jednorazowym przygotowaniu środowiska kolejne rebuildy
pozostają zarządzane przez recepty `just windows-build` i `just fullmag`.
Implementacja GUI oraz ekran konfiguracji `.env` są planowane i mają status
`NOT VERIFIED`; obecny skrypt setupu nie jest ich implementacją. Kopia zapasowa
`.env` stanowi punkt powrotu przed atomową podmianą. Anulowanie lub błąd przed
zatwierdzeniem nie może zmienić pliku ani uruchomić instalacji.
Pełne wydanie instalatora i clean-install wymagają osobnej kwalifikacji.
