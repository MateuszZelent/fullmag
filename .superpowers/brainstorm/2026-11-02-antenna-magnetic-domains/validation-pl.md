# Walidacja brainstormu domen anteny i ferromagnetyka

Data: 02.11.2026. Baza źródeł: `8088f0191b19dd456e2e8ba67723a4c7e80dbabc`.

| Kontrola | Wynik | Zakres dowodu |
|---|---|---|
| Focused scientific-documentation-contract dla `design.source-map.json` | PASS, exit 0 po uzupełnieniu tabel | Sekcje, symbole i SI, równania, publiczne parametry, ścieżki i symbole źródeł. |
| Testy samego kontraktu dokumentacji | 41 PASS, exit 0 | Walidator i jego przypadki odrzucenia; bez kompilacji testów Rust/native. |
| `fm.FieldTarget.object("waveguide").to_ir()` | PASS, exit 0 | Rzeczywisty publiczny selector zwraca `{"kind":"object","object_id":"waveguide"}`; bez Solve. |
| Builder check | Brak istotnych pytań | Wykonalność projektu; szczegóły w `builder-check-pl.md`. |
| Nowa budowa meshu / transport / LLG | Nie wykonywano w ramach brainstormu | Dokument nie jest dowodem wdrożenia. |
| Nowe renderowanie UI / WebGL | Nie wykonywano w ramach brainstormu | Drzewo w dokumencie jest propozycją logiczną, nie screenshotem produktu. |
| Publiczny Sphinx / publication gate | Nie uruchamiano | To wewnętrzny dokument projektu, nie publikacja naukowa w `public_docs/site`. |

Pierwsza kontrola source-map wykazała niepełne literalne definicje symboli,
tabelę parametrów, brak jawnego statusu planned_contract i skrótowe mapowanie IR.
Uzupełniono je na podstawie faktycznego `StudyUniverseConfig.to_ir()` oraz walidacji
w `StudyUniverseHandle.mesh` i `_validate_mesh_control_values`. Wynik końcowy jest
oddzielony od nieudanej pierwszej próby; nie zaliczono jej wstecznie.

Pełne logi są w prywatnym wolumenie kontrolnym grupy anten:
`verification/antenna-magnetic-domains-brainstorm-20261102/`.
Dokument i mapa nie zmieniają statusów inspection-only ani bramek kwalifikacji.
Bramka changed-page i commit dokumentu zostaną odnotowane w końcowym receipcie
w tym samym katalogu kontrolnym; samo istnienie tego raportu ich nie dowodzi.
