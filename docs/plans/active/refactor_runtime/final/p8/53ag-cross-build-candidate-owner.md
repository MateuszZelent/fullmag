# P8-53AG — potwierdzanie ownera API z innego buildu

Data: 04.10.2026. Zakres: natywny Windows dev, prywatny klient ownera.
P8-53 i cały plan pozostają w realizacji.

## Zmiana

Pierwsze API nadal musi odpowiadać tożsamości skompilowanego launchera.
Dla replacement API launcher otrzymuje osobną tożsamość oczekiwanego buildu
wyłącznie po weryfikacji zapieczętowanego pakietu kandydata. Helper sprawdza
aktywny rejestr workspace i marker storage, namespace pakietu, surowy hash
manifestu, wszystkie 13 EXE oraz profil dev/backend-dev, natywny target MSVC,
CPU-only i jawny brak kwalifikacji. Manifest jest odczytywany ponownie po
weryfikacji. Helper nie dostaje sekretu ownera ani tokenu sondy.

Potwierdzenie nowego ownera nadal sprawdza dokładny PID, port, API UUID,
hash sekretu i prywatny endpoint loopback. Zmienia się tylko źródło oczekiwanej
tożsamości kompilacji: zweryfikowany kandydat zamiast bieżącego launchera.
Konstruktor nie dowodzi zakończenia starego API; pozostaje to obowiązkiem
właściciela procesu. Probe-only override tokenu nie zmienia zwykłego launchera.

Ścieżki Windows z prefiksem `\\?\` przechodzą kontrolę wszystkich przodków;
porównanie `samefile` wiąże je z namespace resolvera przed użyciem jego zapisu.
Nie pomijamy kontroli reparse points przez usunięcie prefiksu tekstowego.

## Dowody

`just windows-workspace-build dev dev 3197 auto`: exit 0, produkcyjne EXE.
Logi: `windows-native-fdm-cpu-dev/windows-runtime/cross-build-owner-final-build.log`
oraz `cross-build-owner-admission-build.log`. Bez kompilowania testów jednostkowych.

Interpretowane regresje: 133 kontroli, bez skipów, exit 0. Obejmują poprawny
pakiet bez mutacji, obcy storage/worktree, zmieniony EXE, niezgodny manifest,
profil/target, wersję oraz rzeczywistą ścieżkę Windows z prefiksem.
Końcowy receipt:
`development-handoff-checks/checks/a831944fff5c4a6bade5c0e380b3a22b/receipt.json`.

`just verify-windows-development-backend-api 809ee2d2d6ae48ee8fb20b0fb760b5dc`:
**284 kontrole, exit 0; wszystkie 101 zarejestrowanych procesów odebrane**.
Receipt: `development-backend-api-checks/checks/3cd74e623d684f99bc74dbb7b24be121/receipt.json`.
Backend source przed/po:
`c65627ce147b6edf374ce1ebe9648fd84ecc647838e7611c844f5ff027afad96`.
Snapshot launchera:
`ab4ef2206092f29e461181395c92e4c8578769e44c632ed1e24ab10c0d718fdf`.
Snapshot replacement API:
`273d37e3a9f7bf988cfdada8a10a3d148637066d9722eefe657ec9e905dccfaf`.

Trzy odrębne sesje obejmują ACK, lost-ACK oraz nowy launcher zarządzający API
wcześniejszego buildu. Stare API kończą się graceful exit 0 po durable commit.
Replacement odtwarza scenę z rzeczywistym assetem magnetyzacji; klient odrzuca
obcy PID, rozbieżną scenę i fałszywy ACK. Potwierdzone completion usuwa aktywne
markery zgodnie z dziennikiem i dopuszcza rzeczywistą mutację HTTP. Kapsuła
pozostaje `staged` do przyszłego potwierdzenia hydration UI.

Nowy klient używa produkcyjnej ścieżki weryfikacji kandydata. PID helpera,
potwierdzony wait i exit code są rejestrowane w receipcie. Disposable replacement
API zatrzymano po próbie bez Compute; ich cleanup nie dowodzi graceful restartu.
Review wykrył dwie usterki integracji; poprawki przeszły ponowny przegląd.
UI użytkownika na 3197 zachowano, końcowy odczyt HTTP 200.

Ścieżki dowodów są względem storage resolvera dla tego checkoutu, profili
`development-handoff-checks`, `development-backend-api-checks` i
`windows-native-fdm-cpu-dev`. Receipt jest dowodem konkretnej pary buildów,
nie wszystkich przyszłych wersji protokołu.

## Otwarte bramki

Produkcyjny supervisor launchera, powtórny live restart tego samego workspace,
warm service/drain, Compute, hydration UI i szkice Inspectora pozostają otwarte.
Cross-build cold-idle proof kolejnego restartu nadal wymaga aktualizacji osobnego
konsumenta `runtime_service_client::verify_api_store`, który używa tożsamości
kompilacji launchera. Nie zmieniono `restart_available=false`.
Live completion pustego workspace, power-loss Windows i kwalifikacja wydania
pozostają NOT VERIFIED. Publikacja na publicznym remote pozostaje zablokowana
przez wcześniejszą automatyczną kontrolę zgody.
