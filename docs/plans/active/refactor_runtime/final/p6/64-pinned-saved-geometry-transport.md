# P6-64 — przypięty transport geometrii i supportu

Data: 01.10.2026. Baza: `78e6082904b36dc331b3207ac99270d022b18f27`.
Status: źródła, codegen, TypeScript i API hygiene PASS; runtime **NOT VERIFIED**.
Zakres P0–P8 zachowany. P6 około **52%**, cały plan około **49%**.

## Zmiana

Trzy zasoby API dotyczą konkretnego artefaktu MaterializedDataset w historycznej
rewizji SolutionSet: metadane geometrii, topologia FMMT v2 i support FMSP v1.
Czytnik P6-63 rozwiązuje dokładny owner i źródło tensora. Brak geometrii jest
jawny; nie ma odczytu latest, aktywnej sesji ani uruchomienia solvera.

Metadane rozróżniają rzeczywiste artefakty SolutionSet i geometry payload CAS,
który nie otrzymuje wymyślonego artifact ID. Rekordy artefaktów zawierają
`kind`, schema, ID, hash, length i accepted-state. Manifesty mają kind `other`;
accepted-state musi odpowiadać przypiętemu tensorowi i datasetowi.
Binary endpoints wymagają trzech oczekiwanych rootów CAS: dataset manifest,
geometry manifest i geometry payload. Strong ETag obejmuje SHA rzeczywistego
zserializowanego body. Wspólny handler obsługuje Range, 304 i 416; OpenAPI
opisuje odpowiedź 206 jako `application/octet-stream`.

FMMT v2 zachowuje indeksy i markery, ale nie zastępuje pełnego MeshIR.
FMSP ma 24-bajtowy nagłówek i bitset LSB-first według kanonicznych indeksów
węzłów. Maska pochodzi z zapisanej semantyki pola; padding jest zerowy.
Checksum obejmuje całe body, zanim dane trafią do konsumenta.

Centralna fasada i resource hooks zachowują pełny kanoniczny klucz datasetu,
rooty i tożsamość geometrii. Cache należy do istniejącego resource runtime.
Topologia korzysta z istniejącego decode schedulera i AbortSignal;
fallback bez Web Worker pozostaje synchroniczny. Brak bounded projekcji jest
jawnie niedostępny. Hooki nie są jeszcze podłączone do przestrzennego renderera.

## Dowody źródłowe

Receipts pod resolved `storage/builds/fullmag-0950f4dca4ffe38f`:

- Produkcyjna kompilacja API i OpenAPI: PASS, exit 0,
  `windows-api-source-check/api-openapi-codegen/3651931f6eed4641853d2cd6b2304403/receipt.json`.
- Generowanie klienta: PASS, exit 0,
  `windows-control-room-source-check/generate-client/77305e47cf564170be82428497ce1ed6/receipt.json`.
- Końcowy produkcyjny TypeScript (bez test targets): PASS, exit 0,
  `windows-control-room-source-check/production-source/d4346f999dff4a9c92aa14c911c0674e/receipt.json`.
- API hygiene: PASS, exit 0,
  `windows-control-room-source-check/api-hygiene/5c0bf96552c742fd86a1c835dd9cb471/receipt.json`.

Review wskazało niepełną tożsamość artefaktu, brak binary content-type dla 206
oraz dekodowanie topologii na głównym wątku. Poprawki uwzględniono.
Dodano źródła regresji FMSP header/padding/checksum, FMMT mixed-topology
preflight względem wspólnego serializera, body-based ETag i trzech CAS roots.
Testy nie są kompilowane zgodnie z zakazem użytkownika.

## Build i otwarte bramki

Build 192 (`5d750ed66e584869ab6e88e48c457c86`) ma exit 0.
Niezależne `validate_build_receipt()` potwierdziło 113/113 artefaktów,
237 533 872 B, SHA-256, containment, trusted context i spójne receipts.
Źródło: `fa7378e72018e8d98157ff37a27861c48f670626`; native snapshot:
`540bb2ff7be94c4b6a21efb31b73a66c65346d89b41c12a1a9f0b8a75a3f7934`.
Obraz: `sha256:e9b8ec88b9a9ea09a6cd5e3ad3945fcabd269541f1cdd24ffafd3dff3925399d`.
Ten build obejmuje P6-60, a nie P6-64.

Health o 21:10 UTC potwierdził działający worker i obcy aktywny job 194.
Wolne miejsce: 8 314 101 760 B, mniej niż 8 GiB. Nie zlecono kolejnego pełnego
buildu; zachowano aktywny job, profile, cache i konfigurację operatora.
Artefakt CLI jest Linux ELF. Driver archiwum na Windows wymaga adapteru
kontenerowego wykonującego dokładny artefakt, zanim nastąpi save/open/corrupt.

Geometry JSON jest dekodowany w całości do limitu 64 MiB; manifest ma limit
1 MiB, topologia 64 MiB, support 1 MiB. Range konstruuje pełne body.
Limity nie dowodzą peak RAM, streamingu ani agregatowego kosztu wszystkich
tablic podczas dekodowania. Jest to otwarta bramka P1, podobnie jak wykonywalne
regresje HTTP. Reprezentacja naukowa pozostaje `not_verified`.

Backend HTTP, accepted FEM snapshot, archive roundtrip, jeden viewport,
browser/WebGL, pomiar pamięci, nauka, GPU i release pozostają **NOT VERIFIED**.

Kontrakt: [ADR-0041](../../../../../adr/0041-saved-field-geometry-root.md).
