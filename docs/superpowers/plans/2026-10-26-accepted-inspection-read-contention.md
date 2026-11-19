# Odczyt zaakceptowanego wyniku przy aktywnym solverze — 26.10.2026

> Aktualny checkpoint integracji i zakres dowodów: [27.10.2026, PR #247](2026-10-27-antenna-master-pr247-checkpoint.md). Poniższe statusy opisują kolejne historyczne etapy.

Status: patch przygotowany w źródłach; bez wdrożenia do działającego pakietu. Build, testy Rust i rzeczywiste HTTP nowej wersji NIE ZWERYFIKOWANE. Aktywnej próby Universe nie przerywano.

## Potwierdzone zachowanie

Nowy pakiet API poprawnie odnalazł katalog starego, zakończonego sukcesem wyniku `run-antenna-mpfr-confirmatory-v2-20261026-01`, ale istniejący walidator `scripts/validate_accepted_antenna_closed_loop_http.py::validate` zakończył się błędem po czterech ograniczonych próbach odczytu metadanych: `antenna_store_busy`. To odmowa transportu/uzyskania spójnego snapshotu; nie jest to nowy błąd numeryczny zachowanego wyniku ani dowód pełnej mapy.

W aktywnej próbie `run-live-62d110763485b10e2512922267a1aed284996710852d4fd27cb3f4ad71a1e496` pracuje PID 5124. Kernelowe próbki `/proc/locks` przez około 12 sekund pokazały EX na inode 241611 w 22 z 24 obserwacji: 9 razy worker 5124, 13 razy API 4054. Dwie obserwacje były bez locka; właściciel nabywał blokadę 10 razy. To częste przejściowe contention, nie dowód jednej blokady przez cały Solve. Sam FD ani `WRITER.owner.json` nie są autoryzacją do zwalniania blokady.

Ścieżka: `accepted_antenna_inspection.rs::load_accepted_antenna_inspection` → `study_inspection_integrity.rs::load_saved_inspection` → `SessionStore::read_transaction` → `writer.rs::ReadTransaction::acquire`. Katalog discovery nie wykonuje pełnego odczytu numerycznego, dlatego może przejść wcześniej. Worker i supervisor publikują heartbeat/journal pod writer; ich częstotliwości i zabezpieczenia Stop pozostają bez zmian.

## Rozpatrzone rozwiązania

| Wariant | Ocena |
|---|---|
| Więcej ponowień całego HTTP/dekodowania | Powtarza kosztowne prace, nie rozwiązuje precyzyjnie akwizycji; nie wybrano. |
| Ograniczone oczekiwanie wyłącznie na shared transaction | Wybrano: brak odczytów przed fence, brak powtórnej walidacji/dekodowania, zachowane błędy i deadline. |
| Skrócenie sekcji EX replay/heartbeat | Potencjalna dalsza optymalizacja; wymaga osobnego pomiaru i ochrony przejść koordynatora, nie jest częścią patcha. |
| Nowy kontrakt niezmiennego snapshotu/MVCC | Większa zmiana wersjonowanego modelu spójności; brak istniejącego gotowego API, nie wdrażamy równoległego magazynu. |

Dokumentacja Rust potwierdza wzajemne wykluczanie SH/EX i nieokreślone zachowanie ponownego lockowania klona już zablokowanego uchwytu: [std::fs::File](https://doc.rust-lang.org/std/fs/struct.File.html). Patch używa istniejącego natywnego shared acquisition; nie klonuje EX w celu ominięcia bramki i nie usuwa locka.

## Zakres patcha

Jedyny plik produkcyjny: `crates/fullmag-runtime-control/src/study_inspection_integrity.rs`.

- `load_saved_inspection` nabywa shared transaction przez prywatny `acquire_inspection_read_transaction`: limit 5 s, jitter 5–40 ms zgodny ze wzorcem `lib.rs::retry_store_writer_busy_within`. Ponawia tylko prawdziwy `std::fs::TryLockError::WouldBlock`, zachowuje oryginalny error chain i nie dotyka globalnego helpera writer.
- `verify_saved_inspection` zachowuje natychmiastową akwizycję, ponieważ eksport wywołuje je także synchronicznie z wątku async.
- Oba przekazują uzyskany `ReadTransaction` do wspólnego `read_saved_inspection`. Guard obejmuje całą dotychczasową walidację oraz zbudowanie odczytanego wyniku.
- Numeryczne handlery API już używają pojedynczego admission permit i `spawn_blocking`: `accepted_antenna_resource.rs::get_accepted_antenna_inspection`, `accepted_antenna_payload.rs` oraz `accepted_inspection_fields.rs`. Nie dodano oczekiwania w wątku Tokio obsługującym HTTP.
- Nie zmieniają się JSON/OpenAPI, jednostki, tożsamości, metoda obliczeń, tolerancje, lease, katalogi, journal ani CAS. Nie ma fallbacku bez blokady ani pomijania walidacji przy trafieniu cache.

Porównanie źródeł dowiodło bajtowo identycznej treści walidatora po wyłącznie przeniesieniu akwizycji i przekazaniu tego samego guardu do odczytu journalu. Nadal wymagane są: exact attempt/epoch, trwały successful Completed, accepted preparation, manifest i CAS, zgodność artifact ID oraz zewnętrzna rewalidacja katalogów.

## Dowody i pozostałe bramki

W wolumenie kontrolnym grupy:

- `verification/accepted-cold-read-new-package-20261026/`: odmowa rzeczywistego HTTP i kernelowe próbki blokad;
- `verification/inspection-read-lock-retry-20261026/`: patch, źródło, hash, kontrola parsera i porównanie walidatora.

Dodano trzy regresje Rust: oczekiwanie na zwolnienie writer i współistnienie dwóch SH bez nowego ownera; deadline zachowujący WouldBlock i owner; natychmiastowe odrzucenie uszkodzonego deskryptora. Testy nie zostały skompilowane ani uruchomione z powodu obowiązującego zakazu. Parser Rust nie zastępuje testów lub buildu. Niezależny przegląd nie wykazał osłabienia produkcyjnego kontraktu; uwagi o read/write testowego deskryptora, rzeczywistym upływie deadline i przypięciu ownera uwzględniono.

Najpierw trzeba zachować terminalny wynik obecnego pełnego Solve i sprawdzić publikację V/J/H. Dopiero potem zarządzany build we własnej grupie Docker oraz kontrola nowego readera: sukces podczas krótkiego writer, odmowa po deadline przy długim writer, niezmienne owner/claim/journal i odrzucenie uszkodzonego CAS/obcych pins. Browser/WebGL i pełne UI pozostają osobnymi, niezaliczonymi bramkami.

SHA256 patcha: `d08f7056447d4dc3df6347d34a445eb070b5f42a86ee1149919e6434895a184b`.
SHA256 źródła: `fa2fd7ad90c299b0477f387cce3c58a94042d94ece19a4f72f9f8efbc3ab4c06`.

## Wdrożenie i HTTP po zakończeniu próby — 27.10.2026

Managed iteration cb64d7ff17f144739d78745a9483d16a skompilował i uruchomił
powyższy reader. Root potwierdził zgodność źródła fa2fd7ad90c299b0477f387cce3c58a94042d94ece19a4f72f9f8efbc3ab4c06
z build shadow. Przy pustym Workspace historyczne V/J/H przeszło 33 kontrole
publicznego HTTP; osobno saved geometry/FMDS również PASS. To rzeczywiste
wykonanie nowego readera, bez nowego Solve. Nie oznacza kwalifikacji pięciosekundowej
granicy pod wymuszonym contention; tych trzech testów Rust nadal nie uruchomiono.
Dowody i zakres: 2026-10-27-cold-http-empty-workspace-checkpoint.md.
