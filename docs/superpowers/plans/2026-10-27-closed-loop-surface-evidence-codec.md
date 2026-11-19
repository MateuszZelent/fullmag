# Odczyt dowodów pola RT0 — checkpoint 27.10.2026

Zakres: narzędzie kontroli transportu i formatu zapisanych danych, bez nowej
metody numerycznej. Wspólny smoke odrzucał poprawny format FM-RT0-SURF-V1,
ponieważ wymagał wyłącznie starszego FM-OEF1-Q3-V2 i jego stałej długości.
Przed poprawką odtworzono odmowę direct_evidence descriptor differs.

## Zmiana

`scripts/smoke_antenna_closed_loop_inspection.py::validate_resource` używa
kanonicznego direct_evidence_schema. Nowy `verify_field_evidence`, wywoływany
przez dotychczasowy decode_payloads, obsługuje oba formaty bez fallbacku
na inny solver lub quantity. Sprawdza framing i dokładne długości, nagłówki
źródła/certyfikatu/prądu, ordered target digest oraz bitową zgodność H i
współrzędnych. Zachowuje signed zero, sprawdza skończoność diagnostyk trzech
precyzji i legalną odmowę binary64. Wersje i inspection_only pozostają jawne.

Surowe 14-elementowe tablice liczników są porównywane z manifestem bez zmian
wartości. Dla istniejącej projekcji API named_work_kind.v1 mapowane są jedynie
azwy znanych kategorii; całe requested/resolved policy nadal musi być zgodne.
Nie zmieniają się limity, tolerancje, binarny codec native lub naukowa bramka.
Pełną walidację numeryczną wykonuje nadal canonical Rust cold verifier.
`scripts/smoke_antenna_artifact_fields.py` używa istniejącego importu wspólnego
dekodera; nie wprowadzono drugiego klienta lub endpointu.

## Sprawdzenie i granice dowodu

Root uruchomił w istniejącym kontenerze backendu:
`python3 -B -m unittest -v test_smoke_antenna_closed_loop_inspection.py`
z katalogu scripts: 14 testów PASS, 0,731 s. Negatywne przypadki obejmują
obce source/policy/carrier/H, uszkodzone nagłówki, długości i trailing bytes,
nieznany schemat, powielone klucze JSON i nieskończone liczby. Kontrola AST
również przeszła. Testów Rust nie kompilowano.

Pełny decode_payloads odczytał historyczny pakiet
ed9e6ed4089d552ca7511408de9246f56f4d8a0d93b8bfd57e36fc1da2d1faf5:
14 targetów, 1865 komórek źródła, format surface; raw i named projection PASS.
To dowód formatu i powiązań transportu. Nie kwalifikuje obecnego binarium
ani pełnego Universe 1145/6428 z przewodnikiem 1856 Tet4. Nie wykonano nowego
HTTP, importu, eksportu, Solve, benchmarku lub browser smoke dla tego commita.

Dowody w wolumenie kontrolnym grupy, katalog
verification/closed-loop-smoke-surface-evidence-20261027/: red.log, checks.json,
retained-format-final.json, root-recheck.json i źródła. Root recheck dotyczy
14 testów tego modułu; większa liczba w łącznym green-final.log obejmuje
odrębne moduły i nie jest liczbą testów tego jednego pliku.

SHA256 produkcyjnego skryptu:
3c51153e2a3736bfda462b001371b5a1fcdd865bc46382a49fd0f8a262758e61.
SHA256 modułu testów:
c77e064bb76a22012e1444cd2fe46282b2df6f703ad8038a2b56c757d9f195d1.
