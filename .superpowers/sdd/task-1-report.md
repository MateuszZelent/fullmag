# Task 1 — test RED granicy środkowej warstwy FDM

## Status

`DONE`

## Implementacja

Dodano endpointowy test
`planar_default_fdm_even_depth_uses_cell_centered_midplane` w
`crates/fullmag-api/src/router_v2/tests.rs`.

Fixture opisuje regularną geometrię FDM `2×2×2` z origin
`[-1, -1, -1] m`, spacing `[1, 1, 1] m`, revision `8` i polem `m`
niezerowym wyłącznie w niższej z dwóch środkowych warstw (`z-index=0`).
Górna warstwa jest zerowa.

Test wykonuje kolejno:

1. `GET /v2/sessions/current/data/fields/m/meta` i potwierdza zakres
   canonical field `min=0`, `max=1`;
2. `GET /v2/sessions/current/data/fields/m/planar-default/meta` dla
   `component=magnitude`, `resolution=16×16`;
3. bezpośrednią asercję, że default frame ma cell-centered
   `origin_m[2] == -0.5`;
4. odczyt canonical scalar link zawierającego sample token i expected
   revisions, dekodowanie FMVP oraz wymaganie 256 próbek i co najmniej jednej
   wartości o `abs(value) > 1e-12`.

Nie zmieniono kodu produkcyjnego.

## RED command i pełna istotna porażka

```bash
CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=/mnt/fullmag-zfn2-native/cargo-targets/planar-redesign-api cargo test -p fullmag-api planar_default_fdm_even_depth_uses_cell_centered_midplane -- --nocapture
```

Wynik: expected RED, `exit 1`, test skompilował się i uruchomił:

```text
running 1 test
test router_v2::tests::planar_default_fdm_even_depth_uses_cell_centered_midplane ... FAILED

thread 'router_v2::tests::planar_default_fdm_even_depth_uses_cell_centered_midplane' panicked at crates/fullmag-api/src/router_v2/tests.rs:36551:5:
assertion `left == right` failed
  left: Number(0.0)
 right: Number(-0.5)

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 922 filtered out
```

Porażka dowodzi dokładnego błędu: default frame dla parzystej liczby warstw
publikuje geometryczne `z=0.0`, czyli granicę komórek, zamiast środka niższej
centralnej komórki `z=-0.5`. Obecny floor sampler wybiera przez to zerową
górną warstwę. Dalsza asercja FMVP pozostaje w teście i po naprawie położenia
płaszczyzny wymaga niezerowego planar magnitude.

Pierwszy przebieg diagnostyczny użył niedozwolonego `resolution=2×2` i był RED
na `planar_meta_response.status(): 400 != 200`. To nie był poprawny RED.
Fixture skorygowano do istniejącego minimum `16×16`; dopiero powyższy przebieg
jest zachowanym dowodem regresji.

## Files changed

- `crates/fullmag-api/src/router_v2/tests.rs` — test regresyjny, commitowany.
- `.superpowers/sdd/task-1-report.md` — ten raport, poza commitem.

Commit: `b1464b481` (`test: reproduce planar FDM midplane boundary bug`).

## Weryfikacja

- focused Cargo test: oczekiwany właściwy RED opisany wyżej;
- `rustfmt --edition 2021 --check crates/fullmag-api/src/router_v2/tests.rs`:
  `exit 0`;
- `git diff --check -- crates/fullmag-api/src/router_v2/tests.rs`: `exit 0`;
- osobne `git diff --cached --name-only` przed commitem wskazało wyłącznie
  `crates/fullmag-api/src/router_v2/tests.rs`.

Workspace-wide `cargo fmt --all -- --check` nie przeszedł przez obcą,
niestage'owaną zmianę formatowania w
`crates/fullmag-api/src/session_persistence.rs:2727`. Nie zmieniono tego pliku;
zawężony rustfmt dla `tests.rs` przeszedł.

## Self-review

- Fixture reprodukuje rzeczywistą geometrię problemu: parzysta liczba warstw,
  niezerowe wartości tylko w niższej centralnej warstwie i zerowa warstwa nad
  nią.
- Test korzysta z rzeczywistych endpointów, canonical scalar link i istniejącego
  dekodera FMVP, bez mockowania handlera.
- RED powstaje z oczekiwanej semantyki cell-centered slice, nie z błędu setupu,
  statusu HTTP, tokenu ani dekodera.
- Asercje nie zostały osłabione; po naprawie wymagają zarówno właściwego frame
  origin, jak i niezerowego planar magnitude.
- Commit zawiera wyłącznie plik testowy.

## Concerns

- Test celowo pozostaje RED do czasu naprawy produkcyjnego resolvera default
  FDM slice; nie jest to zielona bramka obecnego mastera.
- Istniejące ostrzeżenia `unused_mut` i `dead_code` w `fullmag-engine`,
  `fullmag-runner` i `fullmag-api` są niezależne od tego testu.
- Współdzielony worktree nadal zawiera obce zmiany w `progress.md`,
  `session_persistence.rs`, `external_solvers/3` i plany redesignu; nie zostały
  dotknięte ani stage'owane przez ten task.
