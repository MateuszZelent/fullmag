# Weryfikacja i remediacja audytu relaksacji FDM/FEM z 2026-08-20

## Zakres i poziom dowodu

Zweryfikowano pakiet `fullmag_relaxation_audit_evidence_bundle (1).zip` względem
bieżącego drzewa źródłowego. Pakiet audytu był audytem D1 opartym na źródłach:
nie zawierał świeżego uruchomienia zarządzanego runtime, parity CPU/GPU ani
kwalifikacji FP32. Dlatego poniższe wyniki rozdzielają:

- potwierdzony defekt źródłowy i wykonaną naprawę,
- twierdzenie przesadzone lub niepotwierdzone,
- lukę kwalifikacyjną, której nie wolno uznać za naprawioną testem jednostkowym.

Nie zmieniono statusu żadnego lane'u na production-qualified.

## Werdykt dla znalezisk

| ID | Werdykt po weryfikacji | Remediacja / pozostały gate |
|---|---|---|
| FM-RELAX-001 | Częściowo trafne, priorytet P0 przesadzony | `production_executable` nie oznacza `validated`; brak `validated_workload` pozostaje jawną luką kwalifikacyjną. Bez zmiany semantyki capability. |
| FM-RELAX-002 | Potwierdzone i naprawione | Legacy `torque_tolerance_unit="T"` jest konwertowane do A/m; dodano walidację jednostki i testy konfliktu aliasów. |
| FM-RELAX-003 | Potwierdzone w części i naprawione | Projekcja używa teraz dzielenia przez `m·m`; zerowa, subnormalna, niefinitywna retraction aktywnego spinu jest odrzucana przed ewaluacją backendu. Zero jest zachowane tylko dla jawnie nieaktywnej komórki. |
| FM-RELAX-004 | Potwierdzone i naprawione | Secanty PG-BB są transportowane do zaakceptowanej przestrzeni stycznej; usunięto nieosiągalną gałąź fallback. Naprawiono ścieżkę wspólną oraz referencje CPU SoA/AoS. |
| FM-RELAX-005 | Niepotwierdzone jako defekt P1 | Dokumentacja kanoniczna definiuje standardowy test Armijo. Audyt nie dostarczył kontrprzykładu pokazującego błędną akceptację po retraction. Pozostaje kandydatem P2 do testów adversarial, nie podstawą do zmiany równania. |
| FM-RELAX-006 | Potwierdzone i naprawione | FDM CUDA obserwuje torque przed klasyfikacją zdegenerowanego gradientu i wymaga kanonicznego potwierdzenia próbkami. |
| FM-RELAX-007 | Potwierdzone i naprawione | Referencyjne direct minimizers CPU nie kończą już stanu początkowego po pojedynczej próbce torque. |
| FM-RELAX-008 | Potwierdzone i naprawione | FEM CPU NCG i FEM GPU NCG wykonują potwierdzenie torque przed stopem `Gradient`. |
| FM-RELAX-009 | Potwierdzone w części i naprawione w potwierdzonym zakresie | FEM tangent-plane implicit otrzymał kanoniczne potwierdzenie torque. Sam zarzut cancellation wymaga osobnego kontrprzykładu numerycznego i nie został uznany za udowodniony. |
| FM-RELAX-010 | Defekt ABI potwierdzony, zasięg publiczny przesadzony; naprawione fail-closed | Planner już odrzuca publiczne multilayer+transport. Natywne ABI przenosi teraz wybór multilayer przed rozpoczęcie transakcji, a binding transportu odrzuca multilayer-v2. |
| FM-RELAX-011 | Potwierdzone i naprawione | Provenance zapisuje requested/resolved direction policy, solver i preconditioner wraz z nazwami zmiennych środowiskowych; GPU nie deklaruje polityk CPU. |
| FM-RELAX-012 | Niepotwierdzone jako błąd semantyczny | CPU i GPU mają odrębne realization IDs, co jest zgodne z dopuszczoną remediacją audytu. Parity obu realizacji nadal wymaga runtime gate. |
| FM-RELAX-013 | Potwierdzone i naprawione | Usunięto niepodłączoną, rozbieżną kopię workflow relaksacji pod `src/solvers/fdm/workflows/relaxation`; dodano kontrakt zapobiegający jej odtworzeniu. |
| FM-RELAX-014 | Potwierdzone; poprawiono osiągalność gate, pełny gate nadal niepraktyczny | Moduł testów fizycznych FDM został podłączony do integration-test root i otrzymał receptę `just`. Po aktualizacji fixture dwa scenariusze przeszły; testy demag/SP4 wykonują dziesiątki tysięcy kroków i nie zakończyły się w praktycznym czasie, więc kwalifikacja pozostaje otwarta. |
| FM-RELAX-015 | Potwierdzona luka zakresu, nie defekt do lokalnej poprawki | Ogólna kwalifikacja FEM dla materiałów niejednorodnych i DG0 Ms wymaga osobnego projektu fizyczno-numerycznego. Bez zmiany. |
| FM-RELAX-016 | Potwierdzone i naprawione | Poprawiono antydampingowy znak w komentarzu równania modułu FEM overdamped LLG. |
| FM-RELAX-017 | Potwierdzona luka kwalifikacyjna | Nie wykonano pełnego managed runtime, CPU/GPU parity i FP32 qualification dla całej macierzy. Status pozostaje BLOCKED/niezakwalifikowany. |
| FM-RELAX-018 | Zarzut nieaktualny dla obecnego kontraktu artefaktów | Metadane artefaktów zawierają requested execution, a execution provenance przechowuje rozwiązany backend/device i fallback. Bez zmiany; potrzebny świeży test artefaktu dla pełnego dowodu runtime. |

## Wprowadzone zabezpieczenia

1. Ujednolicono jednostkę tolerancji torque do A/m na granicy Python API.
2. Projekcja styczna i retraction są odporne na stan poza rozmaitością oraz aktywne
   wektory zerowe; błędny trial nie trafia do backendu.
3. PG-BB używa transportowanych secantów w nowej przestrzeni stycznej.
4. Stopy wynikające z degeneracji gradientu nie omijają potwierdzenia torque.
5. Multilayer-v2 nie może rozpocząć transakcji transportowej, której nie domknie.
6. Runtime provenance ujawnia środowiskowe polityki direct minimizer FEM.
7. Usunięto martwą, rozbieżną implementację relaksacji.
8. Ignorowane testy fizyczne FDM stały się osiągalne przez dedykowaną receptę.

## Świeże dowody wykonane podczas remediacji

- Python API: 23 testy zaliczone (`23 passed`, 268 odfiltrowanych, 21 subtestów).
- Semantyka minimizatorów Rust: 51 testów zaliczonych, w tym transported secant,
  aktywny wektor zerowy, masked inactive zero i Armijo.
- Provenance Rust w konfiguracji domyślnej: 5 testów zaliczonych.
- Provenance w zarządzanym kontenerze z `--features fem-gpu`: 5 testów zaliczonych;
  kompilacja objęła rzeczywiste ścieżki FEM CPU/GPU.
- Semantyczny kontrakt spójności FEM: zaliczony.
- FDM physics qualification: `exchange_only_random_to_uniform` oraz
  `uniform_field_alignment` zaliczone po podłączeniu modułu i certyfikatu siatki.
- `git diff --check`: zaliczony.

## Bramki niezaliczone lub nieukończone

- `verify-fem-relaxation-source-contract` zatrzymuje się przed kontraktami
  relaksacji na niezależnym dryfcie inwentarza dostępu/producentów siatki FEM.
  Nie aktualizowano oczekiwanych skrótów, ponieważ bieżące drzewo współdzielone
  zawiera obce zmiany w tym obszarze.
- Pełna recepta FDM physics qualification nie kończy się w praktycznym czasie:
  scenariusze thin-film/SP4 nadal wykonują do 50 000 kroków referencyjnego CPU.
  Uruchomienia przerwano bez wyniku; nie są PASS ani FAIL fizyki.
- Pełny managed runtime, CPU/GPU parity, FP32, mesh refinement, powtarzalność i
  porównanie z niezależnym oracle pozostają wymagane przed użyciem produkcyjnym.
- Hostowa próba CUDA nie jest dowodem kwalifikacyjnym i wcześniej zatrzymała się
  na `ptxas fatal: Internal error: writing file`; nie zastępuje recepty zarządzanej.

## Końcowy status

Potwierdzone błędy źródłowe zostały naprawione i objęte wąskimi regresjami.
Audyt był użyteczny do znalezienia defektów, lecz przeszacował część priorytetów
i zasięgów. Fullmag relaxation nadal nie ma kompletnego dowodu produkcyjnego dla
całej macierzy FDM/FEM × CPU/GPU × FP64/FP32 × algorytm. W szczególności nie wolno
z tego raportu wyprowadzać statusu production-qualified ani gotowości do wyników
naukowych bez brakujących bramek runtime i niezależnych oracle.
