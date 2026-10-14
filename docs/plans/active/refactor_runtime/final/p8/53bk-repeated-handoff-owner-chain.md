# P8-53BK — łańcuch zakończonych kapsuł i nowy owner

Data: 13.10.2026. Baza: `ce334e8d18da770e14e423776776f6b2dd9a3319`,
współdzielony `master`. Zmiana obejmuje wyłącznie regresje interpretowane;
nie zmienia produkcyjnego protokołu ani dostępności restartu.

## Wynik

Zarządzana recepta `just verify-windows-development-handoff` zakończyła się
`completed`, exit 0: **162 kontrole, zero pominiętych**. Receipt:
`C:\git\fullmag\storage\builds\fullmag-0950f4dca4ffe38f\development-handoff-checks\checks\d061e0844b104248bf03fedb12ce3f34\receipt.json`.
Hash źródeł przed i po sprawdzeniu:
`9c1e23ff7a27632217ca7bc16c403c0352cf855cb6b3d5f765c9720558e2318f`.

Nowa regresja w `scripts/test_windows_development_scene_handoff.py`,
`test_restored_capsule_supports_next_restart_with_new_owner_binding`,
sprawdza następujący łańcuch:

1. Pierwsza kapsuła kopiuje asset `.ovf`; zostaje prawidłowo zakończona
   przez `record_handoff_outcome(..., "restored")`.
2. Oryginalny plik jest usuwany wyłącznie w izolowanej fixture testu.
3. Druga kapsuła otrzymuje nowe API/session identity, kolejny session epoch,
   build B jako źródło i build C jako cel. Generation ownera pozostaje stały.
4. Zweryfikowany asset pierwszej kapsuły jest kopiowany do drugiej;
   zachowane są bajty, rozszerzenie, study intent, editor, workspace
   i project document. Stary binding nie może załadować drugiej kapsuły.
5. Obie kapsuły mają prawidłowo zapisany terminalny stan `restored`.

Dotychczasowy test przekazywał ponownie kapsułę w stanie `staged`.
Nowy przypadek pokrywa brakujące zakończenie poprzedniego przekazania
oraz zmianę owner identity. Nie uruchamia procesu backendu.

## Wykryta niespójność fixture

Pierwszy przebieg `012999abdf5a479586b1484cc0b121db` zakończył się exit 1:
nowy test przeszedł, ale `test_before_capture_persists_prerequisites_and_rejects_scene_drift`
nie podawał wymaganego `project_document_after_grid` ani hashy dokumentu.
Uzupełniono fixture w `scripts/test_windows_development_admission_observation.py`
o oba hashe i przewidywany dokument. Produkcyjna walidacja pozostaje bez zmian;
regresja nadal sprawdza drift sceny oraz brak publikacji niepoprawnego capture.

## Granica dowodu i następny krok

Warstwa danych łańcucha kapsuł: **PASS w opisanym zakresie**.
Przeglądarka A→B→C w jednej działającej sesji: **NOT VERIFIED**.
Obecny harness przeglądarkowy ma jeden baseline i jeden terminalny finish;
natywny probe również przechowuje pojedynczy `RestoredState`. Kolejna próba
wymaga rozszerzenia obu stron oraz osobnej, zweryfikowanej tożsamości C.
Dwa niezależne przebiegi A→B nie zastępują tej bramki.

P8-53, P8 i cały plan pozostają otwarte. Nie uruchamiano kompilacji testów,
nie restartowano workspace użytkownika na 3197 i nie zmieniano storage.
