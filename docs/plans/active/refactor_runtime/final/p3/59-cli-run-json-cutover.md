# P3/P5 — cutover publicznego `run-json`

Data checkpointu: 28.09.2026.

## Wynik

Publiczne `fullmag run-json <accepted-run.json> --api-url <origin>` korzysta z
jednego produkcyjnego transportu accepted-run: ogranicza i waliduje payload,
wykonuje Submit przez HTTP API v2, a domyślnie także materializację katalogu i
readback. Flaga `--submit-only` zachowuje wcześniejszą możliwość zakończenia po
durable acceptance.

Dawne bezpośrednie wykonanie kanonicznego `ProblemIR` ma teraz ukrytą nazwę
`run-problem-json-direct`. Korzystają z niej wyłącznie repozytoryjne benchmarki,
smoke'i i bramki naukowe, które nie mają jeszcze accepted RunSpec. Komenda nie
jest widoczna w publicznym helpie i nie stanowi dowodu accepted-runtime.

`submit-run-json` pozostaje ukrytym aliasem zgodności, delegującym do dokładnie
tego samego transportu co `run-json`. Nowe bramki accepted-runtime oraz bieżące
repozytoryjne wywołania używają już nazwy publicznej.

## Zakres migracji

- wariant CLI `run-json` ma wyłącznie pola accepted requestu, `api_url` i
  `submit_only`;
- direct ProblemIR ma odrębny, ukryty wariant i nie współdzieli ścieżki
  wykonawczej z publicznym transportem;
- wszystkie aktywne skrypty repozytorium zostały przypisane jawnie do transportu
  accepted-run albo do wewnętrznej ścieżki direct;
- ADR-0034 określa właściciela mostów i warunek ich późniejszego usunięcia;
- regresje parsera pilnują kontraktu pól oraz niewidoczności obu nazw
  przejściowych w publicznym helpie.

## Weryfikacja i ograniczenia

`cargo check -p fullmag-cli --bin fullmag`, scoped `rustfmt`, Cargo metadata i
składnia dziewięciu zmienionych skryptów Python przechodzą. Trzy testy parsera
CLI zostały dodane, ale profil testowy zatrzymał się przed ich wykonaniem z `no
space on device`; po próbie wolumin `C:` miał około 12 MiB wolnego miejsca.
Wspólny `target` nie został usunięty, ponieważ mógł być używany przez inne
zadania. Managed runner pozostaje niedostępny z wcześniejszym `Docker Desktop
coordinator request failed`.

Dlatego cutover jest zamknięty na poziomie źródła i decyzji architektonicznej,
ale test parsera oraz procesowy dowód publicznej nazwy pozostają **NOT
VERIFIED**. Wskaźniki pozostają konserwatywnie: **P3 93%, P5 87%, cały plan
około 49%**.
