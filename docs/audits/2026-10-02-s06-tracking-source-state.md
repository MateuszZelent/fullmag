# S06 — stan źródeł i bramki weryfikacji, 2026-10-02

Baza przeglądu: `423cc02c6d1e23a512de605404c02a543dcfded2`, branch
`codex/eigensolve-dispersion-plan-20260912`. Nie kompilowano testów
jednostkowych ani nie uruchomiono nowego FEM. Poniższe ustalenia dotyczą
źródeł; nie stanowią walidacji numerycznej dyspersji.

## Istniejące podłączenie

| Wymaganie | Aktualny właściciel i dowód źródłowy | Bramka otwarta |
|---|---|---|
| Spójna masa P1 Tet4 | `crates/fullmag-runner/src/eigen/tracking_mass.rs` — `ConsistentP1TrackingMetric::embed`: wkłady czterech węzłów i ich sumy odtwarzają pozadiagonalną masę elementową | Wykonanie Rust oraz parytet z niezależną całką |
| Wspólna siatka i indeksy | Ten sam typ — `compatible`, `physical_node_indices`, `tetra`, objętości i tożsamość siatki | Wielopunktowy runtime i potwierdzenie wspólnego stanu równowagi |
| Overlap pojedynczych modów | `tracking.rs` — `modal_overlap_views`: embedding obu wektorów; niezgodna metryka nie przechodzi na overlap euklidesowy | Odtworzenie edge'ów z rzeczywistych pól |
| Podprzestrzenie zdegenerowane | `tracking_subspace.rs` — `mass_weighted_subspace_transport`: dwukrotna ortogonalizacja, SVD cross Gram, minimum cosinusów kątów głównych, rotacja Procrustesa i odtworzenie frame | Przypadek crossing/split/merge i niezależny replay |
| Próg overlapu | `tracking.rs` — `find_subspace_matches`: próg dotyczy `principal_minimum`; składnik częstotliwości nie ratuje słabego overlapu | Kontrola na fizycznym przypadku i badanie kroku k |
| Zakaz mieszania sample'ów | Ta sama funkcja odrzuca wspólny transport frame'ów z różnych ostatnich próbek | Przejście przez lukę w rzeczywistym path |
| Wejście produkcyjnego path | `crates/fullmag-runner/src/fem/eigen_path.rs` — budowanie `SingleKModeResult`: Cartesian nodal envelope i `consistent_p1_metric`, bez diagonalnych wag | Managed multi-k i poprawność fazy dla signed k |
| Publikacja edge'ów | `artifacts/modal_manifest.rs` — `branch_point_tracking_score_source`; zachowane raw mode ID i odrębny tag transportu podprzestrzeni | Zgodność manifest/CSV/UI z rzeczywistymi branchami |

Nie należy ponownie implementować samego SVD/transportu tylko dlatego,
że starsza tabela planu mówi o brakujących podprzestrzeniach. S06 nie jest
jednak ukończone: kod i przygotowane testy nie dowodzą wykonania runtime,
poprawności branch labels ani fizycznego rozdzielenia bliskich modów.

## Niezależny review — luka S06 do S07

Review potwierdził podłączenie masy i transportu, ale wskazał P1 publikacji:
`TrackedBranchPoint` zachowuje confidence i `overlap_prev`, bez principal
cosines, rzędu/identyfikatora klastra oraz rodzaju przejścia. Oba writery
gubią te dane. Ogólny `modal_manifest.rs::write_branch_bundle_with_sample_namespace`
nie publikuje również `tracking_method` i `overlap_floor`, których wymaga
produkcyjna bramka k-path w `docs/specs/frequency-domain-artifacts-v2.md`.
Producent `fem/eigen_path.rs` już publikuje te dwie wartości, lecz także
nie przenosi principal-angle evidence. Ponowne wnioskowanie o metodzie
z obecności wektora/overlapu nie zastępuje zapisu rzeczywiście użytej krawędzi.

Następny przyrost powinien wprowadzić wspólny typ provenance krawędzi:
metoda, próg, definicja metryki, cluster ID/rank, principal minimum/cosines,
transition kind i gap/restart. Tracker ma go ustalać podczas przypisania,
a oba writery mają serializować ten sam dowód. Nie wolno wytwarzać
principal cosines z confidence ani oznaczać scalar overlap przy transporcie
podprzestrzeni. Istniejąca scalar production gate nie kwalifikuje subspace
transportu; rozszerzenie naukowego dowodu wymaga osobnego kontraktu.

P2: prywatna heurystyka degeneracji 1e-4 względnie daje około 1 MHz przy
10 GHz. Nie jest dowodem fizycznej degeneracji ani potwierdzonym błędem
solvera; nie zmieniono jej bez badania. Potrzebne są jawna polityka i
badanie stabilności względem kroku k oraz rozszczepienia siatką.

P2 signed k: znak wektora i exp(+ik·r) są źródłowo poprawne. Brakuje
regresji [-K,0,+K] z celowym przestawieniem modów i ich faz, degeneracją
oraz zachowaniem potencjalnej niereciproczności. Nie wolno odbijać punktów
liczonych tylko po dodatniej stronie zamiast wykonać ujemną stronę.

Native gate aktualnie odrzuca damping Include w `fem/eigen_capability.rs`.
Przyszłe dopuszczenie tłumienia musi jednocześnie rozstrzygnąć lewą/prawą
bazę lub jawne ograniczenie tego trackera; metryka prawego wektora nie
stanowi automatycznie biortogonalnego dowodu dla problemu niehermitowskiego.

## Oddzielne ustalenie: referencyjne gamma w publikacji

`crates/fullmag-runner/src/eigen/artifacts/modal_manifest.rs::summarize_mode`
wpisuje `reference_modal_gamma_rad_s_t()` i
`REFERENCE_MODAL_GAMMA0_RAD_S_PER_A_M`. Funkcja nie otrzymuje aktualnego
parametru planu. Tymczasem `orchestrator.rs::run_path_or_single` ma
`plan.gyromagnetic_ratio`. Dla konfiguracji z innym gamma manifest może
raportować błędne gamma, nawet gdy solver policzył poprawną częstotliwość.
To błąd metadanych/provenance S07/S10, nie dowód błędu widma ani przyczyna
rozbieżności w benchmarku używającym referencyjnego gamma.

Naprawa wymaga przekazania aktualnego parametru przez wspólny wynik path
do writerów, testu niereferencyjnej wartości oraz zgodności jednostek
gamma0/gamma i odbiorników manifestu. Nie wolno odtwarzać gamma z
częstotliwości, nazwy pliku ani domyślnej stałej referencyjnej. Punkt nie
został naprawiony w tym przeglądzie.

## Następne dowody

1. Uzgodnić aktualny status tabeli S06 z powyższym kodem.
2. Naprawić typed edge provenance i zgodność obu writerów z kontraktem,
   przygotować regresję signed-k, degeneracji i zachowania raw IDs.
3. Wykonać managed piloty i multi-k, zachowując raw punkty oraz pola.
4. Odtworzyć kąty główne i branch assignment na rzeczywistych modach;
   zmniejszyć krok k i sprawdzić stabilność oraz przypadki luk/degeneracji.
5. Zweryfikować manifest/CSV i render w UI. Sam scatterplot nie dowodzi
   fizycznej tożsamości gałęzi ani kompletności widma.
# Checkpoint naprawy provenance — 2026-10-02

P1 utraty krawędzi naprawiono w kodzie trackera i obu writerach. Rekord
zawiera rzeczywistą politykę, metrykę, transition, predecessor/gap oraz
principal cosines/rank i raw ID obu próbek. Historyczne punkty nie dostają
wymyślonego dowodu, a uszkodzony obecny rekord daje błąd importu.
Review dodatkowo wykryło restart publikowany jako seed: naprawiono go na
new_branch/modal_overlap_unavailable i zablokowano weighted summary przy
brakującej ciągłości. Indeksy klastrów są lokalnymi danymi diagnostycznymi;
tożsamość wyznaczają predecessor, bieżąca próbka i raw mode ID.

Kontrole: 6 interpretowanych testów źródeł/algebry consistent mass PASS,
parser Rust PASS, walidator mapy 0831 PASS. Przygotowane testy native dla
signed k/faz/reorder/split, restartu i writer pair/gap nie były kompilowane
ani uruchamiane. Naprawa źródeł nie zamyka managed runtime, convergence,
replay, fizycznych crossing/split/merge ani authored degeneracy policy.
