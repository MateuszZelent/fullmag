# P6-A — natywna granica tożsamości artefaktów FMR

Data: 30.09.2026

Status: **WIP / RUST SYNTAX + REVIEW PASS / NATIVE BUILD QUEUED / TESTS NOT RUN**.

## Wykonany zakres

Dodano osobny kontekst C `FullmagFemFrequencyDomainArtifactIdentityV1`
z `abi_version`, `struct_size` i czterema pożyczonymi stringami UTF-8:
`session_id`, `run_id`, `stage_id`, `runtime_id`. Dotychczasowy request C
FMR zachowuje layout. Deklaracja po stronie Rust sys odpowiada polom C.

Nowe wejście `fullmag_fem_frequency_domain_validate_artifact_identity_v1`
sprawdza kontrakt przed użyciem pól: wersję i rozmiar, niepuste wartości,
UTF-8, mutable aliasy i znaki sterujące. Kontrola aliasów uwzględnia ASCII
case oraz białe znaki Unicode na granicach wartości, zgodnie z regułą
istniejącego `FrequencyDomainArtifactIdentity` w Rust. Nie normalizuje ID
do publikacji i nie uruchamia solvera.

Walidator ma właściciela w
`backends/fem/include/frequency_domain/artifact_identity.hpp`; fasada C
w `backends/fem/src/api.cpp` obsługuje tylko ABI i komunikat błędu.
Nie dodano ownership do `Context`, IR ani diagnostyki operatora.

## Weryfikacja

- Parser Rust sys: **PASS**, bez kompilacji testów.
- Scoped diff check: **PASS**.
- Test rzeczywistego wejścia C, pod feature `build-native`, został napisany
  dla prawidłowego contextu, aliasów, Unicode, control character, null,
  błędnej wersji i błędnego rozmiaru. **NOT RUN** zgodnie z `AGENTS.md`.
- Nowy nagłówek wymaga jawnego włączenia do następnego snapshotu jako
  untracked input. Bieżący job `9eb85e72e82048f2b7e0558b86d66014`
  dotyczy wcześniejszego przyrostu manifestów i nie dowodzi tej zmiany.
- Natywna kompilacja i wykonanie walidatora pozostają **NOT VERIFIED**.

## Podłączona ścieżka solve i publikacji

Nowe wejście C `fullmag_fem_frequency_domain_solve_driven_response_with_identity_v1`
przyjmuje osobny context oraz niezmieniony request C i callback z potencjałem.
Runner waliduje ID, przechowuje cztery CString przez cały synchroniczny solve
oraz przekazuje context do natywnego requestu. Stare wejścia pozostają dostępne.

Wewnętrzny request C++ ma wersję 13 i dopisany wskaźnik ownership. Wersje
0/9/12 kopiowane są wyłącznie do końca starego prefiksu; nie odczytują nowego
wskaźnika. Nagłówek wersji/rozmiaru sprawdzany jest przed kopiowaniem. Osobny
context C ma obowiązkową wersję i pełny rozmiar.

Sześć miejsc zapisu manifestu korzysta ze wspólnego writera. Przed otwarciem
pliku przygotowuje on dokładne session/run/stage/runtime ID i zastępuje mutable
URL-e w sekcji resources przez null. Zachowuje ścieżki artefaktów i deskryptory
payloadów. Błąd alokacji raportuje artifact_error. Nie poprawia plików po solve.

Identity-aware runner dopuszcza natywne FMR pod istniejącym feature FEM;
niepowodzenie wyboru natywnej ścieżki nie przechodzi w dense_reference.
Dense wymaga nadal jawnej polityki. Wymuszone GPU zachowuje brak fallbacku.

Rozszerzono istniejące regresje natywnego wyniku poprawnego i manifestu błędu
Floquet o cztery dokładne ID i brak mutable URL. Testy są **NOT RUN**;
nie kompilowano ich, zgodnie z bieżącym zakazem AGENTS.md.

## Pozostałe kroki

1. Niezależny review ABI, lifetimes i publikacji.
2. Managed build snapshotu z jawnym włączeniem nowego nagłówka.
3. Dowód wykonania C ABI i publikacji pełnego/częściowego manifestu.
4. Scoped commit i push po adekwatnej weryfikacji, z zachowaniem cudzych zmian.

Odczyt runnera 30.09.2026 wykazał worker_state=stopping oraz
accepting_jobs=false. Poprzedni job zachowuje stan running; jego log zawiera
build receipt succeeded i trzy etapy exit 0, lecz finalizacja kolejki nie jest
potwierdzona. Nie wznowiono pauzy operatora ani nie uruchomiono alternatywnego
builda. Nowa implementacja natywna pozostaje **NATIVE BUILD NOT VERIFIED**.

Po restarcie koordynatora o 10:27:24 UTC zatwierdzony klient odmawia dostępu:
`Container profile allow-list mismatch`. Nie zmieniono konfiguracji runnera
ani nie obchodzono kontroli profili. Następny build wymaga zgodnego klienta
i zdrowego runnera przyjmującego zadania; snapshot musi jawnie objąć nowy
nagłówek `backends/fem/include/frequency_domain/artifact_identity.hpp`.

Znaleziono zgodny wersjonowany klient w istniejącym worktree
`C:\git\fullmag\worktrees\eigensolve-dispersion-plan-20260912` (commit
`f60fc7e3f796bd434dcae90cd4cd428dd451624d`). Odczyt z jawnym wskazaniem źródeł
bieżącego checkoutu potwierdził zdrowy runner przyjmujący zadania i końcowy
sukces wcześniejszego joba. Nie zmieniano konfiguracji ani profilu buildu.

Review wykrył błędny literal backslash w helperze C++; poprawiono go.
Obsługa wyjątków obejmuje teraz std::exception. C++ i Rust mają zgodne
compile-time assertions: size=40, align=8, offsets=0/4/8/16/24/32.
Regresja natywnego kontraktu sprawdza ignorowanie nowego wskaźnika dla
starszego prefiksu ABI. Wszystkie testy pozostają NOT RUN.
Ograniczenie routingu FMR do feature `fem-gpu` było istniejącym kontraktem;
tej zmiany nie rozszerzono na profile zawierające wyłącznie `fem-native`.

Ponowny niezależny review nie znalazł błędu blokującego po korektach.
Pozostaje uwaga P2: helper operuje na znanym formatowaniu generowanych
manifestów, a nie na ogólnym parserze JSON. Zmiana formattera wymaga
odrębnej weryfikacji. Nie jest to dowód kompilacji lub wykonania.

## Snapshot i kolejka

- Job: `7953ba4088a142c889c5ed9c12be7332`.
- Request key: `p6-native-fmr-identity-20260930-v1`.
- Profil: `fem-cpu-release`, operation=build, source=snapshot.
- Digest: `a7aba8c96b183250025a8bc44dacc7dcff45a7d4fb5b84039ecb26d8ad2d1417`.
- Bazowy HEAD: `7189af5a98af65dbd1957411484112066be16bfa`.
- Źródła: `C:\git\fullmag\fullmag`; klient z wersjonowanego worktree użyty
  z jawnym `--worktree`, bez zmiany CPU/GPU lub tworzenia koordynatora.
- Nowy nagłówek jawnie dołączony przez `--include-untracked`; odczyt kapsuły
  potwierdził zgodność jego SHA256 z plikiem roboczym.
- Stan ostatniego odczytu: **queued**, za istniejącym aktywnym zadaniem.
  Nie przerywano cudzej pracy. Natywne źródła przyrostu 27 są nadal robocze,
  nie zostały zacommitowane ani wysłane jako zweryfikowany etap.

Następny krok: odczytać terminalny wynik i receipt, naprawić rzeczywisty błąd
kompilacji, jeżeli wystąpi; następnie scoped commit/push i osobna bramka runtime.

To jest implementacja źródeł, nie dowód gotowej natywnej publikacji FMR.
P6 pozostaje **52%**. Zachować zastane zmiany formatowania sys i pozostałą
pracę współdzielonego checkoutu; staging obejmuje tylko nowe bloki.

## Końcowy wynik buildu — 30.09.2026

Job `7953ba4088a142c889c5ed9c12be7332` zakończył się **succeeded, exit 0**.
Receipt `fullmag.local-runner.build-receipt.v1` potwierdza profil
`fem-cpu-release` i digest snapshotu wskazany powyżej. Etapy native-build,
frontend-dependencies i frontend-build mają exit 0. Inwentarz zawiera
112 artefaktów z poprawnymi SHA256 i rozmiarami; binaria API oraz zasoby
workspace są niepuste. Dziewięć plików produkcyjnych tego przyrostu zachowuje
zgodność SHA256 z kapsułą źródeł. To kontrola receipt i tożsamości,
nie ponowne pobranie i hashowanie wszystkich plików wyjściowych.

**Managed build: PASS.** Receipt nadal oznacza qualification=NOT VERIFIED.
Testów jednostkowych nie kompilowano; wykonanie ABI, manifesty z rzeczywistego
solve, GPU oraz walidacja naukowa pozostają **NOT VERIFIED**. Historyczne
wpisy queued/pauzy powyżej opisują wcześniejsze odczyty.
