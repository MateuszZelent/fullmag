# T12 — kontrolowany odczyt bazy anteny przed alokacją

## Stan i zakres

Źródłowy przyrost względem `c5b676e2608a24b22a42f3a7ed580feacf7378bb`.
Poprzedni loader czytał manifest i wszystkie pliki rewizji przez `fs::read`,
zanim sprawdził deklarowane rozmiary i numerical evidence. Wielki zbędny plik
mógł zostać wczytany tylko po to, by późniejszy verifier go odrzucił.

Nie zmieniono równań, normalizacji prądu, schematu artefaktu, Python DSL,
`ProblemIR`, wyboru urządzenia ani realizacji solvera. Kontrola I/O jest wspólna
dla konsumentów FDM CPU, FDM GPU, FEM CPU i FEM GPU; żadna z tych realizacji nie
otrzymuje na podstawie tej zmiany nowej kwalifikacji wykonania lub fizyki.

## Kontrakt źródłowy

| Granica | Implementacja i zachowanie |
|---|---|
| Manifest | `antenna_field_solution.rs::parse_verified_manifest`: odmowa ponad 16 MiB przed parsowaniem; limit zgodny z niezależnym czytnikiem Python. `antenna_stage.rs::read_solution_file` sprawdza typ i długość przed rezerwacją pamięci. |
| Plan odczytu | `antenna_field_solution.rs::antenna_field_solution_payload_lengths`: tylko jednoznaczny manifest ze zweryfikowanym content digest; scalar/layout/unit/shape, unikalne porty i ścieżki oraz znany operator. Nie jest to samodzielny certyfikat pola. |
| Rozmiary | f64: checked `8 * value_count`; tet4 u32: checked `4 * value_count`; evidence v3: checked `288 + 96 * target_count`, zgodność carrier count, schema i istniejący limit miliona targetów. Limit direct-v3 nie jest narzucany vector-potential. |
| Namespace | Wyłącznie kanoniczne slash-only refs pod dokładnym `antenna/field_solutions/<solution_id>/`; odmowa traversal, pustych komponentów, dot components, backslash, ADS/colon, obcych namespaces i aliasów referencji. |
| Rewizja | Istniejąca, lecz niekompletna rewizja nie uruchamia legacy fallbacku. Poprawny legacy flat asset pozostaje obsługiwany przy nieistniejącej wskazanej rewizji. |
| Pliki | `antenna_stage.rs::collect_solution_files`: enumeracja metadanych, odmowa niezadeklarowanych plików przed ich odczytem, dokładne długości zadeklarowanych payloadów. Oddzielne revision siblings są pomijane tylko w legacy namespace. |
| Uchwyty | `project_storage.rs::open_verified_artifact`: Unix otwiera komponenty przez `openat` z no-follow i directory flags; Windows porównuje finalną ścieżkę otwartego uchwytu oraz odmawia reparse przed odczytem. Unix nonblocking chroni przed blokadą na FIFO. |
| Zaufany root | Alias jawnie wskazanego katalogu wyników jest rozwiązywany do canonical root. Kontrola potomków nie oznacza ochrony przed dowolną mutacją hierarchii powyżej tego zaufanego root. |
| Odczyt | `read_solution_file`: fallible reservation, odczyt porcjami do sprawdzonej długości plus jeden bajt detekcji wzrostu; ponowna kontrola długości uchwytu i ścieżki. Pełny verifier nadal sprawdza SHA, dane skończone i bramkę v3. |
| Cache/publikacja | Inspekcja cache i porównanie legacy manifestu przy publikacji korzystają z ograniczonego odczytu; inspekcja istniejącej niekompletnej rewizji nie ukrywa jej przez fallback. |

## Weryfikacja

- `git diff --check`: PASS.
- `rustfmt --emit stdout --config skip_children=true`: PASS dla czterech
  zmienionych plików Rust; dowód składni, nie typecheck ani runtime.
- Dwa przebiegi niezależnego review źródłowego: po włączeniu istniejącego
  mechanizmu uchwytów brak wskazanego nowego blockera źródłowego.
- Dodano regresje `bounded_reads_check_file_length_before_allocation`,
  `cold_load_refuses_extras_and_incorrect_declared_lengths`,
  `existing_incomplete_revision_never_falls_back_to_valid_legacy`,
  `root_alias_is_allowed_but_descendant_links_are_refused`,
  `cold_load_refuses_junction_descendants_without_symlink_privilege`,
  `payload_read_plan_refuses_unsafe_alias_and_overflow_metadata`,
  `direct_read_plan_applies_evidence_bounds_before_payload_io` i
  `read_plan_preserves_vector_potential_carrier_support_above_direct_limit`.
- **Nie kompilowano ani nie uruchomiono tych regresji Rust.** Obowiązujący zakaz
  kompilowania testów pozostaje w mocy. Ich RED/GREEN, typecheck produkcyjny,
  Windows/Linux I/O, junction/handle race qualification i rzeczywiste odczytanie
  opublikowanej bazy pozostają **NOT VERIFIED**.
- Nie powtarzano zielonych testów Python, których źródła się nie zmieniły.
  Nie przedstawia się ich jako dowodu dla zmienionego loadera Rust.

## Pozostałe bramki

Uzupełnienie dowodu 2026-10-08: `just check-cli-source`, czysty HEAD
`fbae293cca60562d71a404b954e7444138f45a45`, receipt
`c090f270323a4b8eb041f1823e2002ed`: PASS, exit 0. Produkcyjny runner i jego
konsumenci w CLI przeszli typecheck, z identycznym digestem źródeł przed/po.
To zastępuje wcześniejszy brak dowodu typecheck dla tej konfiguracji Windows;
nie wykonuje testów Rust, I/O, race qualification ani natywnych solverów.

Deklarowana długość jest dokładnym limitem jednego odczytu, a nie globalnym
budżetem RAM. Duży, poprawnie zadeklarowany plik i wiele portów nadal wymagają
estymacji łącznej pamięci oraz polityki kosztu z T11. `try_reserve_exact` umożliwia
odmowę błędu rezerwacji, lecz nie dowodzi bezpieczeństwa wobec overcommit.
Nie należy arbitralnie zmniejszać obsługiwanych carrierów, by ukryć tę bramkę.

Pełny odbiór wymaga wykonania regresji po odwołaniu zakazu, buildu zarządzaną
trasą, rzeczywistych publikacji v3 i przejścia precompute/import/compute_fields/
Relax/LLG/FFT. Ten checkpoint nie zamyka T12 ani T00–T18 i nie upoważnia do
produkcyjnego merge Draft PR. Nie zamykano ani nie restartowano aktywnej sesji.
