# P8 — konstrukcja CAD od obiektu i pełne regresje

Data: 15.10.2026. Baza: `d9f2beadef172be080ae6844ff43e8fa846ee3b9`,
współdzielony `master`. Kontynuacja 53CT; pełny plan P0–P8 pozostaje aktywny.

## Zmiana i granice

W `_generate_coincident_ring_airbox_mesh` zastosowano dokładnie kandydata
sprawdzonego w receipcie `84350daa85c449e3b5924494f33e9c9d`: magnetyczne
interwały powstają pierwsze od dolnej powierzchni obiektu. Powietrze powstaje
następnie w górę i w dół; mapy wolumenów wracają do kolejności rosnącego z
przed przypisaniem grup fizycznych. Zachowano SI levels, authored owner/air
targets, lokalne pola, klasyfikację otworu i zabezpieczenia topologii.
Scoped magnetic intervals mają jedną warstwę pryzm, konwertowaną istniejącym
algorytmem bez dodawania węzłów; zewnętrzne air pozostaje geometry-only.

CAS pliku przed zmianą:
`e4c6f353037293cb9ca7e469100f7908ca232acc0f30ba2d3914bee66338aaf0`.
Plik po zmianie:
`b698b7258b7107b486163b5b1300b0140271a53cbc62b8b7fb5b2c2365bb29d4`.
Hash funkcji:
`ad7fc38a9d26ee25bcc94d6bccfa1885f3219581f8ab7d93e304f94d7b6b8944`.
Zachowano dokładnie prefix 94098 B i suffix 63486 B poza funkcją,
sygnaturę, budżet wywołań oraz CRLF. AST i diff check: PASS.

## Dowody odbioru

| Bramka | Dowód | Stan |
|---|---|---|
| Diagnostyka body-first 30/50 nm | 53CT, receipt `84350daa85c449e3b5924494f33e9c9d`, identyczny digest body XY | observed; nie zastępuje regresji |
| Pełny Box | receipt `409ccebf9ac340ec94f4b45b24bdf813`, 45/45, bez skip, 452.35 s | PASS, exit 0 |
| Owner-fields | receipt `e83f417a5e9a46fcb4eb4eeff955f2d9`; precedence, pola lokalne i dowód postmesh; 2/2, 12.83 s | PASS, exit 0 |
| Scoped-ring | receipt `6ad52b15f503403daa8cc3e478e7263d`; lower-bound route/report oraz implicit air cap; 2/2, 22.11 s | PASS, exit 0 |
| Mapy źródeł 0102/0104 | oba focused validators exit 0 | PASS |
| Kontrakt walidatora dokumentacji | interpreted unittest, 41 testów, exit 0 | PASS |
| FEM CPU/GPU solver, fizyka, wydanie | brak nowego dowodu z tej zmiany | NOT VERIFIED |

Box: źródła, HEAD i interpreter stabilne, child summary valid, PID 23568
odczekany, bez timeout/terminate/kill. Obejmuje wcześniejszy FAIL
`test_public_box_explicit_airbox_minimum_above_body_hmax_is_preserved`.
Owner-fields i scoped-ring: źródła/HEAD stabilne, child summaries valid,
procesy odczekane, bez timeout/terminate/kill. Żaden wybrany test nie został
pominięty. Pełny zestaw Python CI nadal wymaga odbioru po publikacji poprawki.

Review odnotowuje odrębną granicę: otwór pierścienia w przedziałach grubości
filmu współdzieli wymuszoną warstwę z annulus, choć jego wolumen jest air.
Geometry-only dotyczy zewnętrznych air slabs. To zachowana grouped ring-hole
constraint, a nie dowód dowolnego niezależnego zagęszczenia z wewnątrz otworu.
Przed ogólną kwalifikacją pól air wymagana jest dodatkowa próba drobnego
air/ROI targetu w tym otworze; obecne zielone bramki nie zamykają tej kwestii.

## Retencja

Receipty, logi, JUnit i siatki diagnostyczne pozostają danymi dowodowymi.
Nie usuwano danych, cache, stagingu ani wcześniejszych pakietów runtime.
Ponowna ocena po terminalnych regresjach i trwałym zapisaniu ich wyników;
nieudany natywny build z 53CT nie zastępuje ostatniego działającego pakietu.
Nie zmieniano cudzych plików API/frontend ani indexu przy tej poprawce.

Własne terminalne katalogi etapu (pełny prefiks:
`C:/git/fullmag/storage/runs/fullmag-0950f4dca4ffe38f/windows-exact-layer-mesh-diagnostics/`):

| Katalog / właściciel | Kategoria / rozmiar logiczny | Decyzja i dowód |
|---|---|---|
| `409ccebf9ac340ec94f4b45b24bdf813` / root, Box | receipt/log/JUnit/temp, 107546 B | zachować jako dowód 45/45; nie jest wykazany jako zbędny |
| `e83f417a5e9a46fcb4eb4eeff955f2d9` / root, owner-fields | receipt/log/JUnit/temp, 9227 B | zachować jako dowód niezależności owner; brak autoryzacji usunięcia |
| `6ad52b15f503403daa8cc3e478e7263d` / root, scoped-ring | receipt/log/JUnit/temp, 9134 B | zachować jako dowód zgrubienia air i lower-bound; brak autoryzacji usunięcia |

Nie proponowano apply ani nie uruchamiano prune. Pomiar wolnego miejsca C:
78785249280 B; nie oznacza odzysku miejsca. Ponowna ocena tych dokładnych
katalogów po odbiorze CI i ustaleniu trwałego archiwum dowodów.
