# S07/S10 — audyt parametru żyromagnetycznego

## Błąd i naprawa

Wspólne `modal_manifest.rs::summarize_mode`, `mode_bundle.rs::write_mode_bundle`
i `kittel.rs::k0_kittel_expected_frequency_hz` używały gamma0=2.211e5 niezależnie
od planu. Dla innego materiału metadane mogły zachować wewnętrzną zgodność
gamma0=mu0*gamma, lecz opisywać inną dynamikę niż wykonany solver. Oracle
Kittela również porównywał z innym gamma niż plan.

`PathSolveResult.gamma0_rad_s_per_a_m` jest teraz wymagane. Orchestrator oraz
adapter bias-field sweep przenoszą wartość planu. Oba writery i oracle stosują
ten parametr bez domyślnej stałej. Stała referencyjna pozostała wyłącznie
w przygotowanych fixture'ach pod cfg(test). Konwersja do rad/(s T) dzieli
gamma0 w rad/(s A/m) przez mu0. Nie zmieniono jednostek publicznego Python/IR.

## Korekty z review

1. P2: publisher `fem/eigen_path_artifacts.rs` omijał ochronę przed overflow
   gamma0/mu0. Wspólny walidator jest używany na wejściu wykonania i przez
   `eigen_path_publication_gamma0` przed serializacją widma i pól. Bramka
   sprawdza też dokładną zgodność gamma planu i wyniku; diagnostyka korzysta
   z wyniku. Prywatne renderery JSON działają po tej bramce.
2. P2: skończone gamma i H mogły dać nieskończoną częstotliwość Kittela.
   Oracle odrzuca nieskończoną lub niedodatnią częstotliwość. Niezależna
   analityka finite-airbox DE/BV już posiada analogiczny guard.
3. Czytnik artefaktów sprawdza zgodność gamma0, gamma i mu0 każdego modu
   ze stałymi wykonania. Spójna, lecz błędna para gamma0/gamma jest odrzucana.

## Dowody i ograniczenia

| Kontrola | Wynik | Co dowodzi |
| --- | --- | --- |
| Istniejący verifier artefaktów | 213 PASS, 69,23 s | Brak regresji sprawdzanych kontraktów Python |
| test_modal_gamma_provenance.py | 6 PASS, 4 subtesty invalid | Routing źródeł, algebra SI, wykonany guard czytnika |
| Parser Rust | PASS | Poprawność składni; nie type-check ani runtime |
| Mapa źródeł noty 0831 | PASS | Strukturalne mapowanie dokumentacji |
| Kontrakty walidatora dokumentacji | 35 PASS, 18,92 s | Kontrola narzędzia dokumentacji, bez solvera |
| Nowe natywne fixture'y | Przygotowane, niewykonane | Wymagają przyszłej autoryzowanej bramki; nie PASS |
| Managed runtime i fizyka | NOT VERIFIED | Brak aktualnego uruchomienia poprawki |

Prepared fixtures obejmują spectrum v2/v3, mode fields, niereferencyjne gamma,
Larmor/thin-film, overflow częstotliwości i publikacji, mismatch plan/wynik.
Źródłowy review nie wykazał P1; dwa P2 poprawiono. Nie kompilowano jednostek.

Historyczny benchmark DE używa gamma referencyjnego; ta poprawka nie jest
wyjaśnieniem różnicy około 2 MHz. #196 jest osobnym niezmiennym snapshotem
71ec3f159b47ee7a56e471020923248c2cac283f. Odczyt API po poprawkach: queued,
waiting_for_disk, brak aktywnych jobów, 173 936 640 B wolnego. Sterownik 7375
pozostaje aktywny. Brak nowych punktów FEM i kwalifikacji COMSOL.

S07/S10 pozostają otwarte: aktualny runtime, provenance/replay, interakcje,
pełne widmo, zbieżność i scientific gates wymagają odrębnych dowodów.

## Follow-up single-k po checkpointcie 91473c678

Checkpoint bazowy: `91473c678aeb8806aaaf423239ae80654dc1b4be`.
Końcowy review potwierdził naprawę P2 ścieżki i oracle, lecz wskazał pozostałe
miejsca publikacji wyników single-k. `execute_fem_eigen_inner` sprawdza teraz
gamma przed wykonaniem, a `native_modal_artifacts` niezależnie waliduje je
przed budową artefaktów. Oba obliczają gamma0/mu0 z walidowanej wartości.
Suite gamma: 7 PASS; parser obu zmienionych modułów Rust, mapa źródeł
i diff-check PASS. Nie uruchomiono
natywnego solvera, nie zmieniono częstotliwości istniejących wyników.
