# P6-63 — wspólny czytnik historycznej geometrii pola

Data: 01.10.2026. Baza: `3720d91f060d0abeb0cd4c774f78441c10fd702b`.
Status: produkcyjny czytnik i jego konsument; źródła PASS, runtime **NOT VERIFIED**.
Pełny zakres P0–P8 zachowany. P6 około **52%**, cały plan około **49%**.

`fullmag_session::solution_field_geometry::read_pinned_solution_field_geometry`
jest wspólnym cold readerem dla dokładnego `PinnedSolutionTensorSource`.
Rozwiązuje historyczny tensor, ładuje jego konkretną rewizję SolutionSet
i member, wybiera jedno dokładne powiązanie geometrii, weryfikuje owner,
hashe/długości CAS oraz zgodność geometrii, supportu i layoutu tensora.
Brak powiązania daje `None`; obcy owner, uszkodzenie i duplikat są błędami.
Nie czyta aktywnego runtime, nie wybiera latest i nie uruchamia solvera.

Natywna bramka mapy korzysta z tego czytnika zamiast własnej kopii lookupu.
Nadal oddzielnie porównuje rzeczywisty indexed geometry digest i pełną
partycję okresową core. Nie zmieniono równań, indeksów, parametrów ani
kwalifikacji reprezentacji: saved geometry zachowuje `not_verified`.

Budżety pozostają istniejące: manifest 1 MiB i geometry JSON 64 MiB.
Czytnik dekoduje cały ograniczony payload geometrii; nie jest jeszcze
paginated/streaming transportem ani gwarancją pamięci dla dowolnej siatki.
Nie przenosi tych danych do JSON statusu.

## Dowody

- `just check-cli-source` po finalnym formatowaniu: PASS, exit 0,
  `windows-api-source-check/cli-source-check/ec8ad7c5a29a456ebc2434fb95ae16d8/receipt.json`
  pod resolved `storage/builds/fullmag-0950f4dca4ffe38f`.
- Recepta sprawdza produkcyjny `fullmag-cli --bin fullmag` i jego zależności,
  bez test targets oraz natywnych solverów. Nie jest managed FEM buildem.
- Dodano źródła regresji exact revision mimo późniejszej rewizji, obcego
  runu, zachowania `not_verified` i jawnego braku powiązania. Zgodnie z
  zakazem użytkownika nie kompilowano ani nie uruchamiano tych testów.
- Zakres zmiany obejmuje cztery własne, uprzednio czyste pliki Rust;
  obce zmiany session/API pozostają zachowane.
- Independent review nie wykazał P0/P1; potwierdził zachowanie exact owner,
  CAS, support/layout oraz oddzielnych kontroli mapy i native digestu.

## Dalszy etap

Pinned geometry resource i bounded binary transport mają korzystać z tego
samego czytnika oraz tożsamości geometrii i źródła. Następnie centralna fasada,
resource hook, codec i jeden viewport wymagają odrębnych kontroli zakresu,
supportu, pamięci, anulowania i rzeczywistego browser/WebGL proof.
Nie wolno zastąpić tych bramek samym czytnikiem. Native compilation,
accepted FEM snapshot, archive roundtrip, nauka, GPU i release pozostają
otwarte. Runner był zatrzymany po jawnym graceful stop operatora; kolejny
odczyt health potwierdził zewnętrzne wznowienie i działający build 192.
Job zakończył się 01.10.2026 o 14:40 UTC z exit 0 dla źródeł P6-60;
walidacja jego artefaktów i wykonanie runtime pozostają osobnymi bramkami.
