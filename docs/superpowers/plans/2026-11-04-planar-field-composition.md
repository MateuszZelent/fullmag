# Wspólny przekrój 2D: demag i magnetyzacja

Cel: na jednej płaszczyźnie fizycznej pokazać H_demag w Universe/Airboxie oraz m w materiale ferromagnetycznym. Wspólny zoom, przesuwanie i przekrój; oddzielne jednostki, palety, maski oraz legendy. Nie zmieniamy solvera, materiałów, skryptu ani ProblemIR. Pracujemy bezpośrednio w wyraźnie wskazanym przez użytkownika lokalnym masterze i istniejącej grupie fullmag-master/3342. Zachowujemy wszystkie wcześniejsze i cudze zmiany.

Wybrana implementacja: addytywne `planar.field_overlays` (maksymalnie cztery profile z unikalnymi id), korzystające z istniejących typowanych zasobów planar. Główna warstwa pozostaje dotychczasowym profilem. Każdy overlay określa quantity, component, scope i prezentację; źródło, fizyczny przekrój, rozdzielczość i interakcja są wspólne. UI udostępni magnetyzację jako teksturę kierunku, wektory albo oba sposoby. Domyślna propozycja: tekstura m na tle mapy demag, zgodnie z pytaniem przedstawionym użytkownikowi. Alternatywa z dwoma oddzielnymi panelami nie realizuje wspólnego obrazu. Współdzielenie ustawień 3D naruszałoby istniejący kontrakt niezależnych profili 2D/3D.

## Tożsamość fizycznego przekroju

Dla źródła default opcjonalne `position_m` oznacza bezwzględną współrzędną SI wzdłuż normalnej, bez przyciągania do środków komórek lub płaszczyzn węzłów. Nie może współistnieć z `position_fraction`. Istniejący sampler ocenia pole na tej płaszczyźnie; nie dodajemy interpolacji ani nowego algorytmu. FDM nadal korzysta z obecnej rekonstrukcji cell-constant, FEM z obecnego ewaluatora. To sterowanie odczytem, bez zmiany publicznego Python DSL i ProblemIR. Parametr wiąże się z tokenem próbki, linkami, maską, wektorami i metadanymi; brak obsługi nie może powodować powrotu do innej płaszczyzny.

Każda warstwa zachowuje swój raster i zakres UV. Współrzędne lokalne przeliczamy przez `frame.origin_m`, `u_axis`, `v_axis` do wspólnego układu głównej warstwy. Nie łączymy próbek według indeksów ani procentów dwóch różnych siatek. Weryfikujemy zgodność płaszczyzn, operatora, generacji domeny i pochodzenia próbki. Maska m pozwala rysować magnetyzację wyłącznie w ferromagnetyku. Brak przecięcia oznacza pustą warstwę, a nie przyciągnięcie do najbliższego obiektu. Nie przedstawiamy starej warstwy jako bieżącej po zmianie przekroju lub źródła.

Źródła semantyki: `crates/fullmag-runner/src/planar/source.rs` (resolver źródła i snap); `crates/fullmag-api/src/router_v2/handlers/data/planar_fields.rs` (build próbki i linki); istniejące FDM/FEM ewaluatory planar. Wsparcie i runtime każdej realizacji pozostają osobnymi dowodami; ta praca nie stanowi kwalifikacji parytetu czterech solverów.

## Kroki i odbiór

- [ ] Backend: profile overlay, walidacja i zgodność zapisu starszych sesji; bezwzględny przekrój i regresje tokenów/linków.
- [ ] Generacja OpenAPI/typowanego klienta w zarządzanej grupie; zasoby i klucze cache uwzględniają pozycję SI.
- [ ] Frontend: aktywne tylko na żądanie zasoby dodatkowych warstw, dopasowanie płaszczyzn/pochodzenia, osobne legendy i sterowanie.
- [ ] Renderer: jeden stos 2D, istniejące workery i maski; utrzymanie canvas przy aktualizacji oraz cleanup bez pętli bezczynnej.
- [ ] Weryfikacja: testy kontraktu/niezgodnych płaszczyzn/masek i regresje wcześniejszego trybu; managed typecheck/lint; przebudowa backendu w tej samej grupie z zachowaniem wyników; faktyczny test dwóch wielkości w przeglądarce na 3342. Osobno raportujemy source, runtime i render.
