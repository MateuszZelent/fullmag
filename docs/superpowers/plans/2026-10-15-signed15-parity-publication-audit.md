# Signed15 — audyt publikacji dowodów serial/adaptive

Data: 2026-10-15. Worktree: `dispersion-mode-ui-20261008`, branch
`codex/dispersion-mode-ui-20261008`. Przejrzana produkcyjna poprawka:
`8ea04862f2630f0e7d55988ed7ebe6d6b798e227`; poprawka fixture:
`00900295e4545580cfec7da0b9cddbcf7194a03c`.

## Potwierdzone wyniki i granice

- Serial run `6c9b97a7980a452cae15b203526fcb0a` przeszedł kanoniczny pipeline
  i ma 15 rzeczywistych punktów DE od −25 do +25 rad/µm. Nie jest to dowód
  parytetu wykonania równoległego ani pełnej kwalifikacji naukowej.
- Adaptive run `83f4a6cd976541708ac8280431b81361` zakończył się błędem
  importu historycznego boundary hash przy Γ. Poprawka importu i roli
  certyfikatu jest na remote; sześć regresji Rust przeszło w CI38706160578,
  job116325988769. Build252 jest osobnym zadaniem runtime, źródła 8ea04862f…,
  job `32eaaa08d87a4822a60b34bb7b5e6c01`.
- Probe nowego konsumenta na rzeczywistym serial: canonical campaign PASS,
  immutable projection PASS, native identity NOT VERIFIED, ponieważ receipt
  nie wiąże raw SHA pliku `eigen/spectrum.v3.json`. Nie zmieniano starego
  receiptu. Wynik zapisano w `real-signed15-consumer-probe-20261015.json`
  w katalogu dowodów wątku `layered-cap-sliver-diagnostic-20261013`.

## Stan napraw źródłowych po review

- Commit `4ea3da4ebda4288233c9a7c3c78899b848753474` dodaje opcjonalny raw binding
  widma v3 z kontrolą regularności i stabilności; nie dopisuje nic do starych
  receiptów. Własności historycznego v2 pozostają sprawdzane.
- Konsument ma regresje raw/semantic, run-local plan, direct report oraz
  capsule snapshot. Pełna kontrola interpretowana:47 testów i18 podtestów
  PASS, w tym23 testy konsumenta i24 benchmarku.
- Rzeczywista para serial6c9… / adaptive83f… daje `not_verified` z powodu
  nieukończonego adaptive; CLI exit1 jest oczekiwanym odmówieniem parytetu.
- Braki per-worker bundle, assembled-input projection i terminal journal
  binding pozostają OPEN. Zielony konsument nie zastępuje tych producentów.

## Błędy i brakujące dowody

### P1 — katalog widma v3: source FIXED, nowy receipt NOT VERIFIED

`scripts/run_comsol_dispersion_benchmark.py`, `REQUIRED_CASE_ARTIFACTS` oraz
`_validate_case_artifacts`, hashuje podstawowe artefakty v2 i manifest.
Potwierdzony brak to raw binding widma v3. Oddzielny
`bind_signed_state_closure` już wiąże wszystkie opublikowane pliki pod
`eigen/metadata` i `equilibrium`, w tym istniejące identity/preimage oraz
snapshoty. Nie należy duplikować tej kolekcji. Brak bundle w samym workerze
jest odrębnym błędem produkcji opisanym poniżej.

Naprawa: gdy native widmo v3 istnieje, dodać jego raw size/SHA binding po
sprawdzeniu regularności i stabilności pliku. Zachować wymagania v2 oraz
działanie historycznych C0/pozostałych profili bez v3. Reuse istniejącego
closure dla sidecarów. Nie dopisywać hashów do historycznych run-result
po obliczeniu.

### P1 — worker nie otrzymuje zweryfikowanego kontekstu handoff

`eigen_native_artifacts.rs` buduje identity/snapshot dla pary
`(Some(linearization_state), Some(source_relax_handoff))`; pełny bundle
publikuje w gałęzi `source_relax_handoff.verified_replay()`.
`eigen_k_worker::execute_request` wywołuje solve z handoff `None`.
Dlatego ukończony worker sample1 z run83f4… publikuje artifact v7 i state v6,
ale nie pełny bundle; bootstrap sample0 ma komplet.

`remap_single_k_mode_artifacts` i manifest obsługują już ścieżki tych
sidecarów. Samo kopiowanie identity bootstrapu na kolejne indeksy byłoby
niepoprawne: target plan, sample index, dynamic boundary oraz hashe stanu
muszą odpowiadać rzeczywistemu punktowi.

Naprawa: przenieść zweryfikowany kontekst źródłowego handoff do produkcji
identity każdego punktu, zachowując source/target binding i exact bytes.
Użyć istniejących typed builderów/validatorów; brak dowodu ma odrzucać
publikację. Wymagana regresja Γ wewnątrz ścieżki oraz bootstrap Γ→±k,
coverage wszystkich sample i testy mutacji, następnie managed runtime.

### P1 — lineage-sensitive operator digest nie jest niezmiennikiem fizycznym

`eigen_shared_domain.rs`, tuple `linearization_operator_input`, zawiera
`linearization_state_digest` i `equilibrium_artifact_digest` obok rzeczywistych
składników operatora i tablic linearyzacji. Dwa zgodne fizycznie uruchomienia
mogą mieć różne wartości tego hasha. Istniejący operator-input signature v1
nie publikuje pełnego preimage złożonych wejść shared-domain.

Naprawa: zaprojektować osobny, addytywny i wersjonowany preimage rzeczywistych
wejść fizycznych operatora; zachować dotychczasowy digest lineage i jego
lokalne spectrum↔manifest binding. Przed implementacją uzupełnić notę
naukową i kontrakt publikacji. Sama różnica lineage hasha oznacza brak
dowodu projekcji fizycznej, a nie potwierdzoną różnicę fizyki.

### P1 — raw hash wejścia workera i semantic digest mają różne role

`eigen_k_worker::equilibrium_artifact_sha256` hashuje surowe bajty pliku
źródłowego. Pole `equilibrium_artifact_sha256` w identity wiąże semantyczny
`content_sha256`. Nie wolno porównywać tych dwóch wartości jako równych.
Tak samo `plan_sha256` hashuje cały plan z run-local ścieżką artefaktu;
jego różnica między runami sama nie dowodzi zmiany fizycznej.

Naprawa konsumenta: osobno zweryfikować raw binding wejścia i semantic
content/identity, a porównanie fizyczne oprzeć na jawnej projekcji. Brak
opublikowanego źródła lub projekcji pozostaje NOT VERIFIED.

### P1 — raport procesu i journal terminalny to odrębne artefakty

`eigen_path.rs` publikuje `eigen/parallel_execution.v1.json` jako bezpośredni
`ProcessPoolReportV1`. `k_process_pool.rs` zapisuje admission journal z
`terminal_state`, `events_truncated` i `report` w osobnej kopercie.
Bezpośredni raport nie jest błędnym JSON tylko dlatego, że nie zawiera
koperty. Nie wolno jednak dopowiadać brakującego terminal proof.

Naprawa: konsument rozróżnia oba obsługiwane formaty, a producent jawnie
wiąże pełny journal terminalny z wynikiem. Dla signed15 pool ma 14 zadań
o indeksach 1…14; punkt0 jest seedem poza poolem. Co-activity wymaga
znaczników czasu i jakości pomiarów, nie samego ustawienia max_workers.

## Kolejność wdrożenia i odbiór

1. Odczytać terminalny receipt build252 i zweryfikować jego źródła/runtime.
2. Dokończyć ścisły konsument bez utożsamiania różnych ról hashów; testować
   również rzeczywisty format raportu, nie wyłącznie syntetyczną kopertę.
3. Uzupełnić katalog dowodów nowej kampanii i publikację per-worker bundle.
4. Wdrożyć jawny fizyczny preimage operatora oraz terminal journal binding,
   poprzedzone właściwą notą i kontraktem. Regresje Rust tylko w GitHub Actions.
5. Policzyć serial/adaptive na tym samym nowym buildzie i modelu. Weryfikować
   wszystkie 15 punktów, residual≤1e-8, częstotliwości rel1e-8/abs1e-6Hz,
   tożsamość wejść i rzeczywistą co-activity 14 zadań.
6. Osobno kontynuować zbieżność, BV, niezależny count proof, full61/8bands,
   COMSOL A1, S09/provider, GPU/interakcje, UI/browser i integrację S00–S12.

Brakujące bramki pozostają OPEN / NOT VERIFIED. Ten audyt ani zielone testy
kontraktowe nie podnoszą kwalifikacji całego solvera.
