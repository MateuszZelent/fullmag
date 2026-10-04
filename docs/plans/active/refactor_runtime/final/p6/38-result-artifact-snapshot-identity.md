# Przyrost 38 — zgodność rewizji z odczytanymi wynikami

Data: 2026-09-30. Cel P0–P8 pozostaje aktywny; P6 nadal **52%**.
Kod i specyfikacja: `18336ee821bad94ab6fc913b367020e066ee667c`.

## Błąd i wynik

Katalog datasetów obliczał `artifact_digest`, po czym osobnym odczytem
parsował JSON. Podmiana pliku między operacjami mogła połączyć hash A
z indeksem i projekcją z danych B. Fencing kontekstu sesji nie wykrywa takiej
zmiany artefaktu w tej samej sesji.

Właściciel `router_v2/handlers/analysis/results.rs` odczytuje teraz każdy
artefakt raz. Dekodowany `Value` i SHA-256 powstają z tego samego bufora.
Migracja obejmuje field sweep, spectrum v3/v2, response sweep, gamma i DSF.
Każdy builder zachowuje dokładny hash w `source_artifacts.revision`;
`dataset_revision` uwzględnia źródła, a projekcje tę rewizję datasetu.
Deklaracja `payload.source_revision` nie zastępuje hasha bajtów.

Dotychczasowy adapter ma limit 64 MiB surowych bajtów na artefakt i odczytuje
najwyżej limit + jeden bajt. Przekroczenie zwraca HTTP 500 z kodem
`RESULT_ARTIFACT_BYTE_LIMIT`, bez obciętego datasetu i bez fallbacku. Błąd I/O
lub JSON również przerywa publikację. Nie zmieniają się schematy OpenAPI,
generated client, frontend ani semantyka solverów.

## Weryfikacja

- Kontrola produkcyjnych źródeł API: **PASS**, exit 0,
  `source_changed_during_run=false`.
- Receipt: `C:/git/fullmag/storage/builds/fullmag-0950f4dca4ffe38f/windows-api-source-check/api-source-check/844b6ea22128404598bf883c983e7ac7/receipt.json`.
- Niezależny przegląd: **PASS** w ograniczonym source review (niezależny reviewer).
- Kontrola diff/parser: **PASS**, staged scope, parser Rust i UTF-8.

Przygotowano pięć regresji: hash dokładnych bajtów mimo równoważnego JSON,
limit i liczba odczytanych bajtów, malformed/truncated JSON oraz I/O failure,
deterministyczna zmiana pliku po EOF i związanie manifestu/projekcji gamma
z digestem. **NOT COMPILED / NOT RUN** — bieżące AGENTS.md zakazuje kompilacji
testów jednostkowych. Kontrola źródeł nie zalicza tych scenariuszy.

Sprawdzenie źródeł korzysta ze współdzielonego dirty checkoutu; nie stanowi
kwalifikacji czystego pakietu na remote ani dowodu managed runtime.

## Runner i granice dowodu

Worker jest żywy i przyjmuje zadania, lecz ma około 5,23 GiB (`5614022656` bajtów) wolnego storage,
poniżej bramki 8 GiB opisanej w `docs/guides/local-container-runner.md`.
Przypięte buildy pozostają queued, exit code nie istnieje:

| Job | Pełny commit źródłowy | Profil | Stan |
|---|---|---|---|
| `a5b88dbd27414615ae44413357d542b7` | `69e11c75abdea606dd9c709b0fd517742158fe8c` | `fem-cpu-release` | queued |
| `106c264dfe954e6b816a7811bbde2d4b` | `620654ca8215db5458d01a6b88a639087e66948a` | `fem-cpu-release` | queued |

Nie usuwano danych ani nie obniżano admission guard. Dla przyrostu 38 nie zlecano kolejnego pełnego buildu w zablokowanej
pojemnościowo kolejce. Jego pełny build i managed runtime pozostają
**NOT VERIFIED**; receipt źródeł API nie zastępuje tej bramki.

Limit wejścia nie dowodzi szczytowego RAM po parsowaniu ani bounded pamięci
całego indeksu. Jeden odczyt nie gwarantuje atomowej publikacji producenta
podczas zapisu in-place ani spójnej migawki wielu artefaktów. Dotychczasowe
walidatory, jakość wyników i publication barrier pozostają wymagane.

## Następne otwarte kroki

1. Revision-fenced zasób porównania dwóch datasetów z jednostkami,
   kompatybilnością przestrzeni i receipt jawnej projekcji.
2. Integracja istniejącego `PlotDefinition` z API i trwałymi export recipes.
3. Porównania w jednym interfejsie z keyboard/browser proof, bounded cache
   oraz oddzielnym authored/resolved/executed i quality status.
4. Terminalne managed receipts dla przypiętych buildów oraz produkcyjne
   import/recovery i peak-RAM evidence poprzednich przyrostów.

Żaden z tych kroków nie został zaliczony samym source checkiem przyrostu 38.
