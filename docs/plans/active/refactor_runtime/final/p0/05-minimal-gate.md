# P0 — minimalny odbiór przed rozpoczęciem P1

Data: 20.09.2026. Decyzja użytkownika: „ok wykonaj to co niezbedne i przejdz do p1”. Zakres: niezbędna weryfikacja persistence na syntetycznych danych; bez kompilowania solverowych testów jednostkowych, bez GC na danych użytkownika. Praca bezpośrednio na autoryzowanym `masterze`.

## Wynik

**PASS dla minimalnej bramki źródeł/session na lokalnym Windows. P1 rozpoczęty.** To nie jest pełny odbiór produkcyjny P0 ani kwalifikacja wydania.

Recepta `just verify-session-persistence` wykonuje wyłącznie `cargo test --locked -p fullmag-session`. Osobny, ograniczony helper korzysta z resolvera storage, blokady profilu, odrębnych katalogów testowych oraz receiptu źródeł i toolchainu. Nie przygotowuje legacy linków `.fullmag` ani nie omija trasy pełnych buildów. Regresje helpera: 6 passed.

| Zestaw | Wynik |
|---|---|
| Testy biblioteki session | 51 passed |
| `tests/p0_archive.rs` | 7 passed |
| `tests/p0_store.rs` | 12 passed |
| Doc tests | 0 tests |
| Łącznie | 70 passed, 0 failed, 0 ignored |

Wśród testów store jest funkcja pomocnicza procesu potomnego; rzeczywiste zabicie procesu i ponowne przejęcie blokady sprawdza osobny test. Liczba 70 jest liczbą raportowaną przez główne zestawy Cargo, nie liczbą odrębnych scenariuszy produktu.

## Dowody

- Run ID: `236ce87237184c099c89d5e75f89d63b`, stan `passed`, exit 0.
- HEAD: `14c8e73a6f3c55f4fc080835a6156f2a4db8f111`, checkout dirty.
- Scoped content SHA-256 przed i po: `e6793e84c0987ce43af9efe213da46f02d14817597589b8736694b93c9a4f6da`.
- Receipt względem skonfigurowanego storage root: `builds/fullmag-0950f4dca4ffe38f/windows-session-check/session-persistence/236ce87237184c099c89d5e75f89d63b/receipt.json`.
- Receipt SHA-256: `d17d2d972f131330cf05a78140bf87b566297118da2d9f0386fe52e373d0d6d3`.
- Log w tym samym katalogu: `cargo.log`, SHA-256 `03b851e1e27faf4d1ae5b29fdcbd21fef8930b6adf84396e80b2a56585439e75`; hash zweryfikowany z pliku.
- Hostowy toolchain tej ograniczonej trasy: rustc 1.94.1 / cargo 1.94.1, `x86_64-pc-windows-msvc`; konkretne ścieżki i pełne wersje w receipcie.

Po dodaniu P1 do workspace ponownie porównano 48 zapisanych plików session/IR/quantities z receiptem: zero zmian. Root Cargo.toml/Cargo.lock i helper tras zostały następnie rozszerzone o application; pełny digest bieżącego workspace jest więc inny. Nie ponawiano niezmienionych zielonych regresji P0 wyłącznie z powodu dodania niezależnego crate’a.

Pierwszy run `85f547226a4b4d06a35868db5c2d41eb` zakończył się 49 passed / 2 failed i pozostaje zachowany. Poprawiono dwa testy: Windows nie pozwala odczytywać deskryptora podczas aktywnego exclusive lock, a fixture sesji musi zapisać wskazywany run przed manifestem sesji. Nie osłabiono produkcyjnych warunków integralności.

## Co zostało sprawdzone

- Wyłączność writera, odmowa obcego unlock/zapisu i zwolnienie native lease po śmierci procesu.
- Odmowa traversal, zarezerwowanych identyfikatorów Windows oraz przekierowania zapisu przez junction.
- Zachowanie poprzednich generacji CURRENT, niepublikowanie niepełnego checkpointu i jawny błąd uszkodzonego stanu.
- Fault injection przed publikacją oraz po rename: niepewna synchronizacja katalogu nie usuwa opublikowanego pliku ani poprzedniej generacji.
- GC preview bez usuwania, odmowa starego planu, uszkodzonego recovery i nieznanego grafu.
- Materialne referencje primary/aux; eksport i import rzeczywistych syntetycznych bajtów, stanu integratora i RNG; walidacja schematu backendu oraz zgodności common state.
- Odmowa importu do niepustego store bez nadpisania istniejącego pliku kontrolnego.

## Granica przejścia

Można rozwijać P1-A: use cases dokumentu i port repozytorium bez runtime; P1-C: zachowanie powłoki i stanu interfejsu. Nowy format/projektowy adapter dyskowy wymaga własnych regresji roundtrip, revision conflict i zachowania nieznanych pól. Zielone testy SessionStore nie dowodzą poprawności nieistniejącego jeszcze ProjectRepository.

Nadal `NOT VERIFIED`: rzeczywista utrata zasilania, Windows directory durability, wykonawcze bramki innych systemów plików/platform, integracyjne trasy API/CLI na działającej aplikacji, browser/WebGL, nauka, wydanie oraz pomiary baseline P0-E. Dotychczasowy pełny build potwierdza zapisaną kapsułę, nie późniejsze nowe źródła P1.

Nie wykonywano operacji na danych użytkownika, commitów, pushu, merge ani cleanupu. Logi i receipt obu uruchomień pozostają zachowane.
