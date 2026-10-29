# Universe anteny — propozycja jawnego profilu pracy pola

Status: użytkownik zatwierdził dokładny profil z propozycji 58e96 i jedną próbę Universe.
Implementacja źródłowa jest integrowana; build, CI i nowe wykonanie H pozostają
bramkami weryfikacji. Nie deklarujemy wykonanego Solve ani kwalifikacji.
Zakres: wyłącznie inspekcja niemagnetycznej pełnej pętli FEM CPU/double.
Nie jest to kwalifikowana baza anteny ani reprodukcja publikacji.

## Zmierzony punkt wyjścia

Przykład `examples/fem_antenna_closed_loop_universe.py` zachowuje obwód i źródło,
a zamiast lokalnej kostki tworzy Universe z marginesem 0,5 µm po każdej stronie.
Parametry otoczenia: minimum 150 nm, maksimum 500 nm, growth 1,6, geometric.
Diagnostyczna generacja dała 1154 węzły i 6487 Tet4 w 12,44 s, bez fallbacku.
Nie wysłano Solve. Przy poprzedniej siatce źródła 1867 Tet4 potrzeba
2 154 518 par; zachowany domyślny profil dopuszcza najwyżej 1 000 000.
Liczność nowego źródła musi zostać ponownie sprawdzona po jego przygotowaniu.

Zachowany wynik b0 ma 26 138 par, 993 244 kernel evaluations i 26 138 ledger
visits; nie wymagał refinement i nie miał unconverged pairs. To 38 wywołań
kernela na zwykłą parę. Dla oszacowanej nowej domeny minimum wynosi
81 871 684 wywołania przed Duffy i adaptacją. Nie jest to prognoza czasu.
SHA256 zachowanego bundle:
`fd5edd5783f7b018559ccd589ceb6ae59c3f8a89b240da9f8ab01a7e7ed8ec62`.
SHA256 dowodu kwadratury:
`7416af155e6d68859335f117d4afe49aa2fbc77c35cd7e5987c6adbdfc48ef61`.

## Zatwierdzony profil

| Parametr | Zachowany domyślny profil | Zatwierdzony profil wymagający jawnego wyboru |
|---|---:|---:|
| `solver_policy` | `production_default` | `volume_inspection_v1` |
| Resolved policy | `closed_loop_direct_defaults.unqualified.v2` | `closed_loop_direct_volume.unqualified.v1` |
| Łączna liczba par | 1 000 000 | 4 000 000 |
| Kernel evaluations, cały przebieg | 100 000 000 | 500 000 000 |
| Ledger visits, cały przebieg | 100 000 000 | 500 000 000 |
| Liście na punkt | 1 000 000 | 1 000 000 |
| Rząd bazowy / głębokość | 4 / 6 | 4 / 6 |
| Tolerancja absolutna / względna | 1e-9 A/m / 1e-5 | 1e-9 A/m / 1e-5 |

Przy limicie 4M bazowy koszt zwykłych par wynosi maksymalnie 152M wywołań;
pozostały limit obejmuje adaptację i Duffy. Nadal możliwa jest jawna odmowa
przy przekroczeniu pracy lub braku zbieżności. Nie podnosimy limitów RAM/CPU
kontenera, nie obniżamy gęstości siatki ani tolerancji. Liczniki są wspólne
dla całego zapytania; nie resetujemy ich przez batching i nie ponawiamy Solve.

## Zgodność i dokładny zakres implementacji

1. Wspólny resolver dwóch profili w `crates/fullmag-ir/src/antenna.rs`;
   wybór wyłącznie w preparowanej zamkniętej pętli
   `materialize_antenna_closed_loop_current_input` w
   `crates/fullmag-plan/src/antenna_current_source.rs`.
2. Existing `solver_policy` przechodzi przez Python i round-trip; nowego pola
   modelu ani równoległego solvera nie dodajemy. Przykład
   `fem_antenna_closed_loop_universe.py` jawnie wybiera `volume_inspection_v1`.
3. Runner przekazuje wybrany tuple do natywnego wywołania i weryfikuje go w
   snapshotcie. Native używa jednego resolvera dla walidacji, pojedynczego
   WorkBudget oraz zapisu headera.
4. Layout C ABI pozostaje bez zmiany. Obecny limit par jest zamkniętym
   selektorem: 1..1M oznacza legacy work 100M, dokładnie 4M oznacza volume
   work 500M; inne wyższe wartości są odrzucane.
5. Cold evidence v1 nadal dopuszcza tylko legacy tuple. Closed-loop evidence
   v2 rozpoznaje dokładnie oba tuple, nigdy dowolne wartości poniżej maksimum.
   Nowy reader zachowuje odczyt wcześniejszych wyników, w tym b0. Starszy
   reader bezpiecznie odrzuci nowy profil. Do oglądania nowych wyników
   potrzebny jest spójny nowy pakiet.
6. Zakres nie obejmuje zakwalifikowanej bazy, LLG, FDM/GPU ani rozszerzenia
   external-lead. Requested/resolved policy i wszystkie realne limity
   pozostają zapisane i sprawdzane przy cold load.

## Weryfikacja przed uznaniem za działające

- Regresje default odmowa / opt-in dopuszczenie dla 2 154 518 par, limit 4M,
  overflow, nieznany profil i niedopuszczalne mieszane tuple.
- Dowód ciągłości licznika przez wiele targetów, zgodność zapisanych limitów,
  cold round-trip obu profili i niezmienność wcześniejszych wyników.
- Python → IR → Python zachowuje jawny profil.
- Build i API przez istniejący stały backend własnej grupy WSL/Docker.
- Jedna nowa próba Universe; skończone H, kompletna topologia, zgodne
  V/J/H/provenance i jawne jednostki. Dotychczasowe wyniki pozostają zachowane.
- Widok przez istniejące Objects → antenna → Visualization → Raw SI results;
  osobne klatki siatki i czytelnych wektorów. Rzeczywisty browser/WebGL nadal
  jest wymaganą bramką, a nie skutkiem samego przejścia CI.

## Zapis zgody i jej granice

Instrukcje AGENTS.md przekazane przez użytkownika, sekcja 8, wymagają pytania,
gdy zmiana dotyka elementu „load-bearing, versioned, or has a migration path”.
Dla tego wersjonowanego budżetu i zgodności czytników użytkownik zatwierdził
powyższy konkretny profil. Zgoda dotyczy wdrożenia oraz jednej ograniczonej
próby pełnej domeny; nie oznacza zgody na usunięcie danych lub kolejne
podnoszenie limitów. Jest to decyzja o konkretnym projekcie, nie zatwierdzenie
wyniku przed wykonaniem ani deklaracja kwalifikacji naukowej.

Kontrakt fizyczny i mapa implementacji: nota 0950, sekcja
`antenna-universe-inspection-carrier`. Siatka i wynik źródłowy pozostają
odrębnymi nośnikami. Pełny wynik H w Universe nie został jeszcze wykonany.
