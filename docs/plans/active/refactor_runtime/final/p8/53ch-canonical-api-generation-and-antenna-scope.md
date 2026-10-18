# P8-53CH — kanoniczna generacja API i scope fixture anteny

Data: 14.10.2026. Baza `438be9cbab21b00f4a3fccd7284c77c13cfe9742`.

## Przyczyna driftu

Lokalne generate-client odtwarzało checked JSON, natomiast CI generuje najpierw
nowy eksport schemy z Rust. Historyczny checked JSON miał inną kolejność map
paths/schemas, kolejność required w StageExecutionResource i stary opis
session_id nieobecny w bieżącym Rust schema. Sam generator typów nie usuwa
różnicy źródłowego eksportu. Nie należy ręcznie przestawiać generated types.

Przyjęto maszynowy JSON z source-review artefaktu CI
`generated-api-contract-38539711740`, artifact ID `11882200857`, przypiętego
przez GitHub do SHA `6357af85e4225ef0ac5d0dfafc24333e512b2869`.
Sprawdzono pełny zakres API od tego SHA: zmienił się tylko session.rs lifecycle,
bez schem i producentów eksportu. Porównanie przed przyjęciem wymagało:
identycznych paths, identycznego zestawu required oraz dokładnie dwóch
różnic JSON: kolejności required i usunięcia starego description session_id.
Pozostała semantyka całego dokumentu musiała być identyczna.

Następnie standardowa managed trasa generate-client wytworzyła typy i wrapper.
JSON/types/client są bajtowo identyczne z artefaktem CI. Duży diff jest głównie
przemieszczeniem wygenerowanych bloków do kolejności eksportu, bez zmiany
zestawu pól lub endpointów. To przyjęcie zidentyfikowanego maszynowego
artefaktu źródłowego, nie native runtime receipt ani kwalifikacja builda.

| Artefakt | SHA-256 po odtworzeniu |
|---|---|
| openapi-v2.json | 3badb7ec33af004e496d4e56676135eed8080f9df181f6d129fe0b45e720d569 |
| openapi-v2-types.ts | 5d686183548dee0be48775bc95988b37f6d8b898083bf043d8e19f0f9c0f5b46 |
| openapi-v2-client.ts | 76f8ce6163c912d27a005d039ebae9b098d708ef4ffead3d0ec6f6f598967641 |

## Dowody i odmowy

- Pierwszy staging odmówił po równoległej edycji fixture anteny; generator
  nie wykonał wtedy semantycznej generacji. Drugi preflight odrzucił literówkę
  w ścieżce workspace. Żadnej odmowy nie obchodzono.
- Stabilna generacja: receipt `6993a37a3ec5409b917d73509324ef77`, PASS/exit 0,
  source digest before=after
  `3b58140e9ce0fcd98b43f83113f123fad2c7feeb54d802125102122f19c1d8ff`.
- Production source TS7: `9234cc7fef9f40868da84894e0ffc26e`, PASS.
- API hygiene: `cb382a4cceb942d78cffa4bd1a57e1ec`, PASS.
- Przyszłe CI generated-api-determinism na przyjętym SHA nadal wymagane;
  lokalna zgodność z wcześniejszym CI nie zastępuje jego odbioru.

## Pozostały mock anteny i odebrany lifecycle

Control Room na bazie 438be9cba poprawił się do 8535 PASS / 6 FAIL / 13 skipped,
7 unhandled errors, 828 plików PASS / 1 FAIL / 1 skipped (job 115780902983).
Pozostał AntennaObjectPanel: mock commands nie miał getSessionScopeKey.
Uzupełniono ten kontrakt tym samym scope key co request expectations;
asercje pending draft, revision i rebase pozostają. TSX parser i diff check
PASS; lokalnych compiled units nie wykonano. CI nowego mocka: NOT VERIFIED.

Physical-field-source-contracts na 438be9cba, job 115780883971: SUCCESS.
Potwierdzono 315/315 fullmag-session i 87/87 API session, w tym obie regresje
snapshot reconciliation oraz late magnetic frame standalone inspection.
Review session.rs nie znalazło actionable P0/P1/P2. To odbiór tych kontraktów,
nie pełnego native pakietu, przeglądarki, A→B→C ani kwalifikacji naukowej.

**P8 i cały plan pozostają IN PROGRESS; procentów nie podniesiono.**
