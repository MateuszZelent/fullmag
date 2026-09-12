# Publiczna dokumentacja rotated interfacial DMI — projekt

## Cel

Publiczne drzewo dokumentacji ma przedstawiać trzy odmienne warianty oddziaływania
Dzyaloshinskii–Moriyi jako równorzędne kontrakty fizyczne:

1. `Interfacial DMI`;
2. `Bulk DMI`;
3. `Rotated interfacial DMI`.

Warunki brzegowe oraz walidacja pozostają stronami przekrojowymi wspólnymi dla wariantów DMI.
Nie są prezentowane jako dodatkowe typy oddziaływania.

## Hierarchia i nawigacja

Strona `public_docs/site/physics/interactions/dmi/index.md` otrzyma kolejność:

1. `interfacial`;
2. `bulk`;
3. `rotated-interfacial`;
4. `boundary-conditions`;
5. `validation`.

Nowa terminalna strona `rotated-interfacial.md` będzie jedynym publicznym właścicielem wspólnej
fizyki rotated interfacial DMI. Strona `validation.md` otrzyma jedynie skrócony wpis o przypadku
Göbel 2019 i odsyłacz do właściciela; nie będzie powielała równań ani API.

## Zakres strony właścicielskiej

Strona spełni `scientific-documentation-contract` i będzie zawierała:

- energię, pole efektywne oraz naturalny warunek brzegowy;
- pełną tabelę symboli i jednostek SI;
- konwencję znaku, chiralości i orientacji cienkiej warstwy;
- publiczne API `fullmag.RotatedInterfacialDMI(D=...)` i kanoniczne `ProblemIR`;
- kompletny przykład stage-first oparty na scenariuszu Göbel 2019;
- osobne realizacje FDM CPU, FDM GPU, FEM CPU i FEM GPU;
- macierz rozdzielającą implementację od naukowej kwalifikacji runtime;
- obserwable `H_dmi_rotated`, `eden_rotated_dmi` i `E_rotated_dmi`;
- ograniczenia, bibliografię Göbel 2019 i indeks kodu;
- sąsiedni plik `rotated-interfacial.source-map.json`.

## Figura walidacyjna

Do `public_docs/site/_static/images/validation/` trafi reprodukowalna figura PNG wygenerowana z
artefaktu `scenario_fdm.zarr`, a obok niej repozytoryjny skrypt budujący obraz. Układ figury:

1. trzy porównywalne panele `initial`, `relaxed`, `100 ps hold` z jedną skalą $m_z$;
2. powiększenie końcowego rdzenia z wektorami $(m_x,m_y)$;
3. zwięzły blok metryk: ładunek topologiczny, energia, rozdzielenie rdzeni, urządzenie i precyzja;
4. podpis jawnie ograniczający kwalifikację do FDM CUDA FP64 na wskazanym urządzeniu.

Obraz jest dowodem wizualnym pomocniczym. Rozstrzygającym dowodem pozostaje raport weryfikatora
Berg–Lüschera i zgodność receipt/runtime.

## Statusy i zakaz nadinterpretacji

- FDM CUDA FP64: wykonany przypadek Göbel 2019, urządzenie i brak fallbacku udokumentowane.
- FDM CPU: operator referencyjny przetestowany, lecz ten przypadek runtime nie został wykonany.
- FEM CPU/GPU: operator zaimplementowany i objęty testami kontraktowymi; reprodukcja bimeronu
  Göbel 2019 nie została wykonana i pozostaje `NOT VERIFIED`.
- Ruch prądowy/SOT bimeronu nie wchodzi w zakres wpisu walidacyjnego.

## Walidacja publikacji

Akceptacja wymaga:

1. walidacji nowego source map i zestawu testów walidatora;
2. `validate_changed_scientific_docs.py` dla diffu gałęzi;
3. `scripts/check_public_doc_examples.py`;
4. ścisłego buildu Sphinx z ostrzeżeniami jako błędami;
5. walidacji wyrenderowanego HTML strony terminalnej;
6. inspekcji końcowej figury i potwierdzenia, że pochodzi z kwalifikowanego artefaktu.

## Poza zakresem

- zmiana implementacji solvera;
- nowy benchmark FEM;
- kwalifikacja FP32;
- reprodukcja dynamiki SOT z publikacji;
- przebudowa pozostałych stron DMI niezwiązana z dodaniem trzeciego wariantu.
