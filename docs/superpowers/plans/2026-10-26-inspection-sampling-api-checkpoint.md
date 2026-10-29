# API inspekcji: własny nośnik pola anteny

Data: 26.10.2026. Zakres: spójny fragment E4–E5, bez zaliczenia całego przepływu.
Baza: `d069a375c963a6bb0bbc9862739b949055c6fec0`.

## Kontrakt i zgodność

Istniejący `ArtifactFieldLocatorResource` otrzymuje opcjonalny `sample_carrier` pochodzący ze zweryfikowanego, niezmiennego wyniku zamkniętej anteny. Deskryptor H zachowuje domenę, rodzaj nośnika, położenie próbek i digest topologii producenta. V, cell-local J i J w centrach pozostają na własnym nośniku przewodnika. Deskryptora H nie wolno użyć dla V/J.

Global wymaga full, fem_domain_mesh_asset, próbek węzłowych i własnej topologii. Object wymaga właściwego object_id oraz fem_mesh_asset z niepustym kluczem geometrii; klucz geometrii może różnić się od ID obiektu. Niezgodna domena, rodzaj, lokalizacja lub format digestu jest odrzucany. Brak pola pozostaje czytelnym wariantem legacy; nie daje dowodu, że wynik obejmuje Universe. Pole nie staje się wymagane w starym locatorze.

Weryfikator cold bundle nadal niezależnie wiąże zaakceptowany source, próbkowanie, payloady i sygnatury przed adapterem. Rewalidacja ownera i kontekstu obserwacji przed odpowiedzią pozostaje zachowana. Pełny MeshIR digest producenta nie jest bieżącym topology_fingerprint; sama liczba próbek lub scope=full nie pozwala przypisać wyniku do edytowalnej siatki. Nie wprowadzono endpointu, drugiego klienta ani transferu ciężkich tablic w statusie.

## Pamięć materializacji

Już załadowane capacities payloadów liczone są raz; mnożnik 16 obejmuje wyłącznie bufory rozwijane do finalnych widoków V/J/H. Evidence i preimages pozostają zweryfikowanymi wejściami, ale nie są rozwijane szesnastokrotnie. Retained state osobno rozlicza końcowe capacities, w tym nowe stringi deskryptora. Limit materializacji pozostaje 128 MiB; upstream ogranicza metadane do 64 KiB, a istniejący slack obejmuje mapy/rekordy. Ten rachunek **nie jest limitem RSS całego HTTP ani wcześniejszego cold verifiera**. Decoder ma odrębny budżet bundle; nie zmieniono go tutaj.

## Dowody

Sześć zmienionych plików Rust jest bajtowo zgodnych zarówno z cieniem, jak i manifestem źródeł istniejącego, zakończonego powodzeniem buildu Docker DEV. Manifest SHA256 `582c533dc5bbfa4c21775adfc9c032ae32886a545e0d9ceb25b453531c353a1d` odpowiada receiptowi pakietu. Rzeczywisty proces API używa binarium SHA256 `73fccee19b7f1ed9d9545f0d3ae2c203d2f967183f03a40291803a00e5279a42`. Build był live-shadow na bazie b81d660036dbf399ed041b16483bf0564e84cabf z przypiętymi dirty sources; nie jest to pristine build niniejszego commita. Receipt ma state=succeeded oraz qualification=NOT VERIFIED.

Rzeczywisty GET `/v2/platform/openapi.json`: HTTP200. Wszystkie statyczne części dokumentu są identyczne z wersjonowanym kontraktem: 1161 schematów, 310 ścieżek. Różnią się wyłącznie jawne rozszerzenia tożsamości buildu i runtime store. TypeScript odtworzony przez openapi-typescript7.13.0, transport/path client przez generator repozytorium i Python przez generate_python_api_models.py --check: zgodność bajtowa. Kontrola API hygiene PASS. Generatorów nie kierowano do cargo ani do zapisu źródeł HMR.

Niezależny review nie znalazł blokera źródeł; potwierdził granice accounting, własność nośników i zachowanie cold verification. Dowody: `verification/inspection-api-contract-20261026/` w wolumenie kontrolnym grupy, w tym kopie receiptu/manifestu, source-package-binding-final.json, live-openapi.json, complete-contract-comparison.json oraz raporty codegen/API hygiene.

**Niezaliczone bramki:** nowe regresje Rust są w źródłach, ale nie były kompilowane ani uruchamiane z powodu obowiązującego zakazu. Sam schema GET nie dowodzi działania binary field endpoints, atomic V/J/H, cold-load ani rendererów. Pełny Solve Universe nadal wymaga wyniku; próba odczytu wcześniejszego H14 napotkała osobny antenna_store_busy. Patch oczekiwania na read lock nie należy do tego fragmentu i wymaga późniejszego managed buildu. Browser/WebGL i odbiór E12 pozostają NIE ZWERYFIKOWANE. Nie restartowano aktywnego API ani nie ponawiano Solve.
