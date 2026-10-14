# P8-53CJ — checkpoint diagnostyki exact-layer (14.10.2026)

## Stan integracji

Lokalny master i wynik scalenia PR #165: `5e99782acbb7fb3f65d0cad872e102bf67733103`.
GitHub potwierdził `MERGED` o 09:57:40 UTC. Nie wykonano drugiego merge ani pull.
Zmiany diagnostyczne opisane poniżej są lokalne; nie są produkcyjną poprawką meshera.

## Wykonana próba

Receipt: `C:/git/fullmag/storage/runs/fullmag-0950f4dca4ffe38f/windows-exact-layer-mesh-diagnostics/cd67c459c18c4fdca38cfbf45304a164/receipt.json`.
Gmsh 4.15.2, istniejący interpreter natywnego profilu Windows, suite `scoped-ring`.
Driver zebrał obserwacje i zakończył się kodem 0; nie oznacza to sukcesu regresji.
Każdy wariant wykonał jeden test, bez skipów, i zakończył się błędem:

| Wariant | Wynik |
|---|---|
| baseline | żądane 3 warstwy, zrealizowane 12 przedziałów magnetycznych |
| one_per_partition | niepełna bijekcja periodic faces x_faces |
| magnetic_partitions_only | niepełna bijekcja periodic faces x_faces |

Proces PID 9712 został odczekany; nie było timeoutu ani zatrzymywania procesu.
Fingerprint źródeł pozostał stabilny. Produkcyjny `_gmsh_swept.py` nie został zmieniony.
Pierwszy driver używał nazwy oryginalnego pliku dla funkcji kompilowanej w pamięci;
niepowiązany tekst przy linii tracebacku nie dowodzi dodatkowej przyczyny błędu.

## Następna hipoteza i granica dowodu

Driver zapisuje teraz dokładne źródła wariantów i używa ich ścieżek w tracebackach.
Read-only observer certyfikatu mierzy liczbę par węzłów oraz dopasowanie ścian,
aby rozróżnić brakujące mapowania od odmiennych triangulacji.
Czwarty wariant `magnetic_prism_partitions` wymusza jedną warstwę i recombination
wyłącznie wewnątrz magnetycznej grubości. Istniejący `subdivide_layered_prisms`
wykonuje podział bez nowych węzłów ze wspólnym wyborem diagonalnych krawędzi.
Zewnętrzne air slabs i owner/air size fields pozostają bez zmian.
Propozycja została zapisana przed próbą w kanonicznej nocie
[0102](../../../../../physics/0102-airbox-mesh-grading-geometric.md).

Dwie próby uruchomienia rozszerzonego drivera zakończyły się przed startem:
`Storage is busy: fullmag-0950f4dca4ffe38f`. Owner record wskazywał PID 171412,
zarządzany `run-windows-workspace`, z dzieckiem BuildOnly i buildem desktopu.
Nie usunięto blokady i nie zatrzymano tych procesów. Po zwolnieniu blokady wykonano dwie kolejne próby opisane poniżej.
Wymagane pozostają exact planes, positive tet4, seam incidence, periodic node/face
bijection, owner-floor, rozdzielenie body/air density i rzeczywisty near-to-far growth.
Nie poluzowano guardów ani tolerancji. Solver FEM i kwalifikacja naukowa: **NOT VERIFIED**.

## Kontrole i pozostałe bramki

- Focused validator kanonicznej mapy źródeł: PASS, exit 0.
- AST drivera i `git diff --check`: PASS.
- Wcześniejsze 41 interpretowanych kontroli kontraktu naukowego: PASS;
  nie kompilowano lokalnych testów jednostkowych Rust/native.
- CI dla `5e99782ac`: generated-api-determinism i control-room-contracts PASS.
- Rust CI ujawniło osobny błąd fixture w `crates/fullmag-ir/tests/ir_tests.rs:1937`:
  przypisanie `StudyIR` do `StudyIRV04`. To nie jest błąd produkcyjnego kompilatora API.
- Python mesh i browser-fixture-smoke pozostają czerwone.
- Publiczny restart pozostaje wyłączony; dwa cykle A→B→C i pełny nowy pakiet
  natywny nie zostały potwierdzone. Nie podniesiono procentu zakończenia P8.

## Wynik rozszerzonych prób

| Suite | Baseline | one_per_partition | magnetic_partitions_only | magnetic_prism_partitions |
|---|---|---|---|---|
| scoped-ring | FAIL: 12 przedziałów zamiast 3 | FAIL: periodic faces | FAIL: periodic faces | PASS: 1 test, bez skipów |
| implicit-cap | FAIL: 31 przedziałów zamiast 3 | FAIL: periodic faces | FAIL: periodic faces | PASS: 1 test, bez skipów |

Receipty w tym samym zarządzanym profilu runów:

- scoped-ring: `1383b46c945548a78532d4882755b3d8/receipt.json`, PID 173016;
- implicit-cap: `2630c9896ac14f559a2aab07e1bca0ab/receipt.json`, PID 173564.

Oba procesy odczekano z exit 0, bez timeoutu, terminate lub kill. Fingerprinty
źródeł i interpretera pozostały stabilne. Driver SHA-256:
`d34bf0b41015cc2002ab3db44f12b3e1b287bfa0eab6bfc1ffd3b93dc70609a7`.
Python package fingerprint: `7279c8d35a6cdfd6fb1f074c0fd12a08dcd0d038cbc1de9b6f94c1000f56c9da`.

Observer scoped-ring wykazał brak brakujących węzłów we wszystkich trzech
kandydatach. Przy pełnych mapach węzłów wariant bez recombination dopasował
0/280 ścian, wariant magnetic-only 1148/1208, a magnetic-prism 1208/1208
(70 par powierzchni). Certyfikator odrzucił pierwsze dwa i zaakceptował trzeci.
To dowód różnicy triangulacji, nie brakującego mapowania węzłów.

Wynik stanowi lokalny dowód dwóch istniejących regresji Gmsh 4.15.2.
Nie jest kwalifikacją solvera ani zgodą na pominięcie pozostałych bramek.
Następny krok: przygotować izolowaną poprawkę produkcyjną z tym zakresem,
sprawdzić cztery publiczne Box/DE fixtures oraz owner/body/air metamorphic gates
w CI. Nie zmieniać liczb oczekiwanych ani tolerancji, nie uruchamiać lokalnej
kompilacji testów Rust/native. Pełny restart i procent zakończenia P8 bez zmian.
