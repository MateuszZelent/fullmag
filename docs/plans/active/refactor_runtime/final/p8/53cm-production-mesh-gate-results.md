# P8-53CM — rzeczywiste wyniki bramek meshera

Źródłowa baza prób: `02e286a0ba038fa7562fb51750a92ac83ac836f1` plus lokalny,
niezintegrowany candidate `_gmsh_swept.py`: magnetic-only prism partitions.
Nie awansowano kwalifikacji solvera ani procentu ukończenia planu.
Root przejrzał pełny diff; niezależne review nie znalazło P0/P1/P2 w źródłach,
lecz testy ujawniły niezakończone bramki. Kod kandydata pozostaje WIP.

## Wykonane bramki

Receipty pod `C:/git/fullmag/storage/runs/fullmag-0950f4dca4ffe38f/windows-exact-layer-mesh-diagnostics/`:

| Próba | Receipt | Rzeczywisty wynik |
|---|---|---|
| pierwszy start ogólnym wrapperem | `75051413f737489f864ec58823377ecb/receipt.json` | odmowa preflight przed child: istniejący rzeczywisty `.fullmag` wymaga jawnej migracji; danych nie ruszono |
| publiczny Box/DE, cały plik | `9fc0a10d6bd94f7f9f91324a20a83f68/receipt.json` | JUnit: 39 testów, 36 PASS / 3 FAIL / 0 skip, 329.08 s |
| produkcyjny scoped-ring + implicit-cap | `2522d8de654b48bda6595673eb8b77e6/receipt.json` | 2/2 PASS, 0 skip |
| owner-fields + report proof | `85c6d5f3688641e589a0d8a3e65b6fb5/receipt.json` | 2 wybrane testy; FAIL rzeczywistego subcase ring XY; JUnit 4 rekordy |
| ponowienie scoped-ring po zmianie kontraktu verifiera | `9124ffa69e554f1990b2caf3723179f8/receipt.json` | 2/2 PASS, pełne pokrycie call reports, 0 skip |

Wszystkie uruchomione child procesy odczekano; nie było timeoutu ani terminate/kill.
Fingerprint produkcyjnego Python: `a141c283bb06ff96bc223ba9fff31fcf843b4d7f73553933790a632fe89c3aba`.
Fingerprint test_meshing: `fab07e3dbe3977648e329ebec406aa52271fce521a59745b2ec9ecd48986baf4`.
Ostatni driver: `8b8fd6b4691feeb5081cbba3f4144cdd923a907175492fd88204f7f116975789`.
Gmsh 4.15.2, pytest 9.0.3, numpy 2.1.3, Python 3.12.2; to interpretowana
diagnostyka meshera, bez lokalnej kompilacji testów Rust/native.

## Rozstrzygnięcia i granice

Trzy błędy Box porównują wszystkie poziomy Z powietrza do samych granic CAD:
470/151, 6547/807 i 262/105. Guard magnetycznych warstw nie jest już przyczyną.
ADR-0027 i per-geometry lowering wiążą exact layers z magnetycznym obiektem;
geometry-only exterior air dopuszcza dodatkowe węzły 3D. Nota 0104 ma jednak
historyczny opis pełnej meshed extrusion. Przed zmianą fixture należy ujednolicić
opis i zachować ścisłe asercje CAD boundaries, magnetic L+1, nieprzecinania
partycyjnych płaszczyzn, dodatnich objętości, PBC i ograniczeń air step.
**Nie zmieniono expected, tolerancji ani tych trzech testów.**

Owner-fields wykazał oddzielny, rzeczywisty problem: przy stałym owner_hmax=20 nm
zmiana airbox_hmax 30→50 nm zmienia siedem współrzędnych XY pierścienia.
Box i porównanie hint 20→10 nm nie wykazały tej porażki. Nie poluzowano porównania
XY. Następna diagnoza rozdziela wpływ air fields od kolejności/tagów Gmsh i RNG.
Nie przywracać kopiowania jednego globalnego capu; zniszczyłoby to zakres lokalnych
pól 3D, którego osobną porażkę dokumentuje nota 0104.

Verifier obsługuje trzy zamknięte suite’y i zapisuje terminalny receipt pod blokadą
storage. Nie korzysta z prepared workspace links, nie migruje `.fullmag` i nie
zajmuje kolejki ciężkich buildów. Przypina sześć fingerprintów, ścieżki i wersje
modułów, count i coverage wykonanych call reports. Pytest 9 zapisuje subtests jako
osobne rekordy JUnit: count JUnit może być większy od liczby wybranych testów,
ale każdy zebrany test musi mieć udany call, bez failed/skipped reports.
Pierwszy Box receipt ma błędne pole collected=0 z session.testscollected;
autorytatywny JUnit i pełny log zachowują 39 wykonanych przypadków. Counter naprawiono
na len(session.items); nie przedstawiono tego nieudanego receipt jako PASS.

## Integracja i następny krok

Commity fixture IR `02e286a0ba038fa7562fb51750a92ac83ac836f1` i Inspector SI
`450a9280acceab8566a0e9f21df6a317835565ea` są na branchu
`codex/ir-and-inspector-fixture-contracts-20261014`, draft PR #168:
https://github.com/MateuszZelent/fullmag/pull/168.
Remote master tymczasem otrzymał obcy merge #167 (`3cd393220d91c6bca7171220588fcc6833180e71`);
nie wykonano force push, pull/fetch ani cofania cudzej pracy. PR jest mergeable,
ale CI i integracja pozostają wymagane. Mesher WIP nie jest w tym PR.
Bootstrap CI `38554289498` potwierdzono jako in_progress dla 450a9280a.

Następne kroki: rozstrzygnąć owner XY i zakres testu air planes, wykonać wszystkie
właściwe regional-density gates; dopiero wtedy promować poprawkę meshera.
Osobno doprowadzić PR #168 do końca cyklu. Restart A→B→C, native full-package
oraz solver/device/scientific release qualification nadal **NOT VERIFIED**.
