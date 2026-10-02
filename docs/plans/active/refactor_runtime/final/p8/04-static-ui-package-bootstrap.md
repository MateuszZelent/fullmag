# P8-C — kompletne pliki startowe spakowanego UI

Data: 02.10.2026. Stan poprawki źródłowej i lekkich regresji: PASS.
Pełna instalacja MSI, clean machine i kwalifikacja wydania: NOT VERIFIED.

## Przyczyna i zmiana

`dev-server.mjs` importuje dwa lokalne moduły. MSI kopiował tylko jeden:
brak `scripts/dev-server-public-origin.mjs` kończył uruchomienie Node błędem
`ERR_MODULE_NOT_FOUND`, zanim serwer zaczął przyjmować HTTP. Osobny reproducer
z dokładnie dawnym zestawem dwóch plików potwierdził exit 1. Lokalny eksport
statyczny nie kopiował wrappera, a pakiet przenośny dziedziczył jego zawartość.

Wspólny helper `scripts/stage_control_room_static_runtime.py` kopiuje jawny
zestaw trzech plików: wrapper oraz oba jego lokalne importy. Używają go MSI,
lokalny eksport w Makefile i producent pakietu przenośnego. Zestaw jest
uzupełniany także przy ponownym użyciu aktualnego eksportu, bez wymuszania
jego przebudowy. Helper sprawdza
cały zestaw przed kopiowaniem, odrzuca puste/brakujące pliki i wyjścia przez
linki, sprawdza hash kopii oraz zwraca inventory SHA-256. Walidatory MSI
i portable wymagają wszystkich trzech plików. Helper nie instaluje Node
ani Python i nie zmienia dotychczasowych wymagań tych runtime'ów.

## Dowody

Test `scripts/test_control_room_static_package.py` uruchamia rzeczywisty Node
na prywatnym porcie loopback z samych plików w katalogu pakietu, ze spacją
w ścieżce. Sprawdza HTTP 200 strony i treść assetu. Zawsze kończy wyłącznie
własny proces. Osobny przypadek wykonuje rzeczywisty blok stagingu MSI
w PowerShell z fixture eksportu i sprawdza identyczność wszystkich kopii.

Osiem przypadków PASS obejmuje również brak/pusty plik, katalog zamiast
pliku, nieprawidłowy parent wyjścia i nakładające się drzewa. Po zmianie
producenta MSI ponownie wykonano 15 regresji storage i 61 regresji FEM
assembly: PASS. Testy są interpretowane; nie kompilowano unit testów,
solverów ani nowych pełnych buildów.

Dowód dotyczy bootstrapu Node i stagingu, nie renderowania WebGL, wykonania
solvera, pełnego portable release ani rzeczywistej instalacji MSI. Instancja
3104 i jej sesja pozostały bez zmian. Procenty całego P8 i planu pozostają
bez awansu na podstawie tego ograniczonego dowodu.
