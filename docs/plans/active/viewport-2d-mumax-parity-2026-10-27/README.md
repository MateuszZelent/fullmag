# Refaktoryzacja widoku 2D: parytet ergonomii mumax3 dla FDM i FEM

- Data: 2026-10-27
- Audytowana rewizja: `38ffb49bf` (`master`)
- Status pakietu: decyzje D2D-01…D2D-13 przyjęte poleceniem „zrealizuj wszystko zgodnie z planem” (2026-10-27); stan realizacji etapów w [05-plan-wdrozenia.md](05-plan-wdrozenia.md) i w [ledgerze statusu](../../../status/2d-slice-capabilities.md)
- Kontynuacja: [audyt 2026-08-31](../../../audits/2026-08-31-planar-2d-fdm-fem-comsol-progress-audit.md) (v0.7), który zatrzymał się na makietach UI i otwartych decyzjach §26.3
- Wiążące wejścia: [ADR 0020](../../../adr/0020-planar-field-map-and-monitor.md), [nota fizyczna 0970](../../../physics/0970-planar-monitor-sampling-and-projection.md), [spec 15](../../../specs/frontend-v2/15-viewport-2d-module.md), 23 decyzje zatwierdzone w §26.2 audytu z 31.08

## Cel

Widok 2D ma działać dla użytkownika tak prosto jak panel Display w mumax3: wybór wielkości, składowej, warstwy i strzałek w jednym rzędzie, natychmiastowa odpowiedź przy zmianie warstwy i czytelne kolorowanie wektora jednym obrazem. Jednocześnie ma zachować to, czego mumax3 nie ma: tożsamość klatki, provenance, fail-closed diagnostykę i poprawną fizycznie próbkę na siatkach FEM.

Dla FDM jest to głównie praca na UI i kontrakcie odczytu (dane już leżą na siatce komórek). Dla FEM problemem jest sam sampler: brak warstw danych, lokalizacja punktu bez indeksu przestrzennego, brak Pyramid5/Hex8 i koszt ponownego próbkowania przy każdej klatce pola. Ten pakiet rozdziela te dwa tory i proponuje dla FEM podział na etap geometryczny (kosztowny, cache'owany) i etap polowy (tani, przy każdej klatce), co daje FEM zachowanie „jak mumax” przy zmianie kroku czasowego.

## Dokumenty

| Plik | Zawartość |
|---|---|
| [01-audyt-stanu-2026-10-27.md](01-audyt-stanu-2026-10-27.md) | Audyt delta względem 31.08: każda pozycja P0/P1/P2, nowe ustalenia, wyniki testów kontraktowych, drift dokumentacji |
| [02-kontrakt-referencyjny-mumax3.md](02-kontrakt-referencyjny-mumax3.md) | Zachowanie panelu Display mumax3 z dowodami `path:line` i mapowanie na tryby Fullmag |
| [03-specyfikacja-ux-widoku-2d.md](03-specyfikacja-ux-widoku-2d.md) | Docelowe zachowanie produkcyjne: układ, kontrolki, odczyty, stany, skróty, warianty i rekomendacje dla §26.3 |
| [04-projekt-techniczny-fem.md](04-projekt-techniczny-fem.md) | Projekt FEM: indeks przestrzenny, cache wag pikseli, Pyramid5/Hex8, warstwy FEM, airbox, sonda, budżety |
| [05-plan-wdrozenia.md](05-plan-wdrozenia.md) | Etapy F0–F6 z zadaniami, plikami, bramkami weryfikacji i kryteriami ukończenia |
| [06-projekt-poziomu-b.md](06-projekt-poziomu-b.md) | Projekt etapu F6: profil liniowy, multislice, streamlines, nawigator czasu, gizmo płaszczyzny, indeks przestrzenny i gather na GPU |
| [mockups/viewport-2d-mockups.html](mockups/viewport-2d-mockups.html) | Interaktywne makiety (otwórz w przeglądarce): FDM, FEM swept Prism6, FEM Tet4, FEM mieszana; stany klatki; warianty układu; multislice; profil. Prywatna kopia online: <https://claude.ai/artifact/XbXgzAkbtHcpr3JVebHUKP> |

## Rejestr decyzji proponowanych

Żadna z poniższych decyzji nie jest zatwierdzona. Decyzje §26.2 audytu z 31.08 pozostają wiążące i nie są tu ponownie otwierane.

| ID | Propozycja | Rozstrzyga | Dokument |
|---|---|---|---|
| D2D-01 | Układ „wariant C”: pasek kontrolek nad mapą (wielkość, składowa, płaszczyzna, warstwa, strzałki, siatka) + Inspector dla reszty; oba czytają ten sam `visualization/state.planar` | §26.3.1 | 03 §2 |
| D2D-02 | Nowa składowa prezentacyjna `direction` jako domyślna dla `m`: koło barw mumax3 w układzie świata (barwa = atan2(v̂y, v̂x), jasność = 0,5 + 0,5·v̂z), ta sama funkcja co w widoku 3D (`magnetizationHslRgb`) | luka mumax | 02 §4, 03 §4 |
| D2D-03 | FDM domyślnie 1 piksel rastra = 1 komórka (bez resamplingu), powiększenie nearest-neighbour; box-average tylko powyżej limitu i jawnie oznaczony | parytet mumax | 03 §5 |
| D2D-04 | Strzałki: siatka 2D w przestrzeni ekranu, groty, minimalna długość w px, glif normalny ⊙/⊗, punktowa ewaluacja w backendzie | §26.3.5 | 03 §6, 04 §8 |
| D2D-05 | FEM: dwuetapowy sampler — etap geometryczny (lokalizacja + wagi kształtu na piksel, cache) i etap polowy (gather O(piksele·≤8)) | wydajność FEM | 04 §3 |
| D2D-06 | FEM „warstwa”: przystanki z certyfikatu swept (`magnetic_plane_coordinates_m`), warstwy nazwane = obiekty (slab), dla Tet4 płaszczyzna ciągła ze znacznikami nawigacyjnymi | warstwy FEM | 04 §5 |
| D2D-07 | Kontrola typów elementów tylko w obrębie wybranego targetu/scope zamiast całej siatki | szybki zysk P0-03 | 04 §6 |
| D2D-08 | Pyramid5 i Hex8 z bazą identyczną z bazą solvera (do potwierdzenia w nocie 0970) | P0-03 | 04 §6 |
| D2D-09 | Multislice jako siatka zsynchronizowanych paneli 2D nad jednym datasetem; podgląd 3D później | §26.3.2 | 03 §9 |
| D2D-10 | Manipulator płaszczyzny: najpierw edycja liczbowa + suwak + skróty, gizmo w 3D w etapie B | §26.3.3 | 03 §8 |
| D2D-11 | Stany klatki: podgląd / analiza / nieaktualna / brak próbki / nieobsługiwana; ostatnia dobra klatka bez przyciemniania | §26.3.7 | 03 §7 |
| D2D-12 | Budżety P50/P95 dla przełączenia warstwy i nowej klatki pola (tabela w 03 §10) | §26.3.8 | 03 §10 |
| D2D-13 | Streamlines po kwalifikacji quivera i koła barw (etap F6) | §26.3.4 | 05 |

## Synchronizacja istniejącej dokumentacji

Ten pakiet nie zastępuje ADR 0020, noty 0970 ani spec 15. Po akceptacji wymaga następujących zmian (etap F0 planu):

| Dokument | Problem | Działanie |
|---|---|---|
| [docs/ui/2d-slice.md](../../../ui/2d-slice.md) | Opisuje niezatwierdzony draft `Midplane` i limit 50k segmentów; sprzeczne ze źródłem `Default` z ADR 0020 | Przepisać na podstawie 03 po implementacji F1 |
| [docs/status/2d-slice-capabilities.md](../../../status/2d-slice-capabilities.md) | Ma być jedynym ledgerem statusu; brak wpisów po 16.08 | Uzupełnić o wynik 01 i utrzymywać jako jedyne źródło statusu |
| [viewport-2d-planar-monitor-production-masterplan-2026-07-18-pl.md](../viewport-2d-planar-monitor-production-masterplan-2026-07-18-pl.md) | Oznaczony w audycie 31.08 jako fałszywie zamknięty | Oznaczyć `superseded` z linkiem do tego pakietu |
| [viewport-2d-refactor-2026-08-12/](../viewport-2d-refactor-2026-08-12/) | Plany sierpniowe, częściowo wykonane (źródło `Default`) | Oznaczyć jako historyczne; otwarte pozycje przeniesione do 05 |
| [0970-planar-monitor-sampling-and-projection.md](../../../physics/0970-planar-monitor-sampling-and-projection.md) | Brak trybów warstw, cache wag, baz Pyramid5/Hex8, statusów sondy | Aktualizacja przez `scientific-documentation-contract` przed F2/F3 |
| [15-viewport-2d-module.md](../../../specs/frontend-v2/15-viewport-2d-module.md) | Brak paska kontrolek, składowej `direction`, stanów klatki | Aktualizacja spec przed F1 (reguła „spec first” z 9.4) |
| [capability-matrix-v0.md](../../../specs/capability-matrix-v0.md) | Wiersze planar FEM | Aktualizacja przy F3 |

## Status plików

Pakiet został zapisany w głównym checkoutcie jako pliki nieśledzone. Nie wykonano commita, push ani PR. Zmiana `external_solvers/neuralmag` w checkoutcie należy do innej pracy i nie jest częścią tego pakietu.
