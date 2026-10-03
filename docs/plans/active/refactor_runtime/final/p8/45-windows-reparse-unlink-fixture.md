# P8-45 — dowód usuwania samych wpisów linków Windows

Data: 03.10.2026. Baza: `074d5373b6f27292cb6dfa68f289ff14f35971b2`.
Zakres: interpretowany fixture bezpieczeństwa; żadnych danych jobów nie usunięto.

## Problem i wynik

Audyt P8-44 znalazł linki o tagach `0xa000000c` oraz `0xa000001d` w starych
katalogach execution. Istniejąca retencja celowo odrzuca takie drzewa.
Przed proponowaniem rzeczywistego usunięcia potrzebny jest dowód, że
wybrana operacja usuwa sam wpis linku i zachowuje jego cel.

Nowy `scripts/windows/test_runner_execution_cleanup.ps1` tworzy świeży
fixture UUID w temp kanonicznego storage. Przed pierwszym zapisem sprawdza
granice storage i odrzuca przejście przez reparse w katalogach nadrzędnych.
Protected target znajduje się poza testowym execution. Do rzeczywistych
danych runnera script nie ma ścieżki usuwania.

Na PowerShell 7.6.6 potwierdzono trzy typy przez rzeczywisty odczyt tagu
`fsutil reparsepoint query`, przed usunięciem każdego wpisu:

| Fixture | Tag | Operacja | Dowód |
|---|---|---|---|
| Junction do protected directory | `0xa0000003` | `Remove-Item -LiteralPath -Force`, bez `-Recurse` | Link znika; SHA-256 protected sentinel zachowany |
| Windows file symlink | `0xa000000c` | Ta sama nie-rekurencyjna operacja | Protected sentinel poza execution zachowany |
| WSL/LX file link | `0xa000001d` | Ta sama nie-rekurencyjna operacja | `target.bin` zachowany; tag zgodny z rzeczywistym audytem |
| Zwykły katalog fixture execution | Bez pozostałych reparse | Recursive Remove-Item dopiero po kontroli zero links i dokładnego containmentu | Execution usunięty; protected sentinel nadal zgodny |

Końcowy przebieg: **PASS, exit 0**. To test wykonywany bez kompilacji Rust,
C++, C# ani unit-test binaries. Nie wymaga Docker Desktop, WSL ani Linuxa.
WSL/LX oznacza format wpisu w NTFS, a nie zależność procesu testowego od WSL.
Niezależny review fixture: **PASS, brak P0/P1**; sprawdzono ścieżki, uchwyty,
rzeczywisty proof i granicę między fixture a danymi użytkownika.

## Korekta hipotezy podczas testu

Pierwszy fixture linku Linux utworzony przez Docker Desktop miał tag
Windows `0xa000000c`. Samo wywołanie `os.symlink` przez Linux nie dowodziło
więc obsługi tagu LX. Dodana kontrola tagów wykryła różnicę i zatrzymała
przebieg przed usunięciem tego wpisu.

Finalny fixture tworzy dokładny tag LX przez Windows `FSCTL_SET_REPARSE_POINT`
w świeżym własnym pliku. Payload ma version 2 i względne UTF-8 `target.bin`,
zgodnie z odczytaną strukturą rzeczywistego aliasu FEM. Uchwyty zamyka
`finally`; cel i ścieżka tworzonego wpisu są ograniczone do fixture.
Strukturę reparse opisuje [dokumentacja Microsoft](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/content/ntifs/ns-ntifs-_reparse_data_buffer).

## Odtworzenie i granice

```powershell
pwsh -NoProfile -File scripts/windows/test_runner_execution_cleanup.ps1 -RepoRoot <absolutny-checkout>
```

Dowód końcowego przebiegu znajduje się względem kanonicznego storage w:
`tmp/fullmag-0950f4dca4ffe38f/fdm-cpu-release/runner-link-unlink-fixture/228cb2cead2a43a9a0e485ed554a3f3a/proof.json`.
Chroniony cel pozostawiono obok proof. Nie jest to pomiar odzyskania miejsca.

To dowód elementarnej operacji, **nie kwalifikacja cleanupu siedmiu jobów**.
Nie zmieniono `retention.py`, jego odmowy `unsafe_execution_tree`, queue,
mountów, kontenerów ani cache. Do wykonania na danych rzeczywistych nadal
potrzebne są odtwarzalny fresh audit, dokładne cele, bieżące receipts/process/
mount checks, bezpieczna procedura oraz osobna zgoda użytkownika.
Nie uznano brakującego obiektu Docker za dowód zatrzymania jego procesu.

Build 218 nadal czeka na storage. B-04 jest późniejszy od jego źródła;
runtime, przeglądarka, niezależny pakiet Windows i nauka pozostają
NOT VERIFIED. Procenty planu bez awansu.
