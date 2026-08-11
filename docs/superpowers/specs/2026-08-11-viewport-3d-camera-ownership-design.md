# Projekt jednolitej własności kamery viewportu 3D

**Status:** projekt do przeglądu użytkownika  
**Data:** 2026-08-11  
**Zakres:** `apps/control-room`, R3F/Drei/Three.js, stan kamery, gesty, synchronizacja zdalna, auto-fit, projekcja i kwalifikacja WebGL  
**Decyzja:** zatwierdzony wariant A — jedna kanoniczna granica commitowania kamery

## 1. Kontekst

Audyt `docs/audits/2026-08-11-viewport-3d-camera-rewind-performance-audit.md` wykazał wyścig pomiędzy żywą kamerą Three.js, `viewport3dStore` i `CameraRegistryController`. Podczas orbitowania kamera jest mutowana imperatywnie przez `OrbitControls`, ale główna ścieżka gestu nie otwiera transakcji w registry. Równolegle registry może przyjąć stan zdalny, a bezwarunkowa synchronizacja registry → store może ponownie nałożyć starszą pozycję na żywą kamerę. Auto-fit i własna implementacja wheel zoom tworzą dodatkowe, niezależne drogi nadpisania.

Projekt usuwa wielokierunkową własność pozycji kamery. Nie stroi wyłącznie timeoutów ani współczynników tłumienia, ponieważ nie zapewniłoby to monotoniczności stanu.

## 2. Cele i kryteria sukcesu

### 2.1. Cele

1. Żywa kamera Three.js i `OrbitControls` są jedynym właścicielem pozycji w trakcie interakcji.
2. `CameraRegistryController` jest jedynym kanonicznym właścicielem zatwierdzonego snapshotu kamery.
3. Każdy gest ma monotoniczną epokę; callback starszego gestu nie może zatwierdzić ani przywrócić kamery.
4. Stan zdalny nie może zmienić żywej kamery podczas gestu ani po lokalnej, niezatwierdzonej zmianie.
5. Auto-fit działa wyłącznie w jawnym trybie automatycznym lub na jawne polecenie użytkownika.
6. Orbit, pan, wheel zoom, HUD/ViewCube, zmiana projekcji, fit i reset korzystają z jednego lifecycle’u.
7. Viewport zachowuje `frameloop="demand"`, zerowe renderowanie w idle i pełną jakość wizualizacji.
8. Test przeglądarkowy wykrywa cofnięcie trajektorii, a nie tylko porównuje pozycję końcową.

### 2.2. Definicja ukończenia

Zmiana jest ukończona dopiero wtedy, gdy:

- dwusekundowe orbitowanie, pan i wheel zoom nie wykazują skoku do wcześniejszego snapshotu;
- stan zdalny i aktualizacja bounds wstrzyknięte w środku gestu nie nadpisują żywej kamery;
- wheel zoom przebiega w wielu klatkach przy włączonym damping i kończy się dokładnie jednym commitem;
- zmiana projekcji zachowuje bieżący widok i wykonuje dokładnie jeden commit;
- jawne fit/reset działają deterministycznie i unieważniają starszą epokę;
- gesty kamery nie uruchamiają requestów `data`, `model`, `meshing` ani `visualization`;
- po settle żywa kamera, target controls, registry i kompatybilna projekcja store są zgodne według jednej tolerancji;
- po uspokojeniu kamery demand loop wraca do zera;
- canvas jest widoczny, WebGL nie jest utracony, a drawing buffer ma niezerowy rozmiar;
- testy jednostkowe, integracyjne, typecheck i browser smoke przechodzą na świeżym uruchomieniu.

## 3. Granice zakresu

### 3.1. W zakresie

- lifecycle `OrbitControls` dla orbit, pan i wheel;
- transakcje interakcji w `CameraRegistryController`;
- synchronizacja żywej kamery, registry, `viewport3dStore` i visualization state;
- auto-fit, jawne fit/reset, HUD/ViewCube i przełączanie perspektywa/ortho;
- tolerancje porównania zależne od skali;
- diagnostyka trajektorii i testy wydajności/lifecycle.

### 3.2. Poza zakresem

- zmiana backendów FDM/FEM, topologii, pól lub jakości renderowanej sceny;
- zmiana publicznego API v2 visualization state;
- nowy globalny store lub nowy framework sterowania kamerą;
- ciągłe logowanie trajektorii w produkcji;
- obniżenie jakości, gęstości glyphów lub ukrywanie warstw jako rozwiązanie wydajnościowe.

## 4. Model własności

Stan kamery zostaje rozdzielony według lifecycle’u, a nie skopiowany do trzech równorzędnych źródeł prawdy.

| Warstwa | Odpowiedzialność | Może sterować żywą kamerą |
|---|---|---|
| Three.js camera + Drei `OrbitControls` | pozycja, target, up i skala ortho podczas aktywnego gestu lub tłumienia | tak, podczas transakcji gestu |
| `CameraRegistryController` | kanoniczny zatwierdzony snapshot, dirty state, persisted shadow i rewizja | tak, tylko podczas dopuszczonej hydracji lub jawnego polecenia |
| `viewport3dStore` | preferencje/projekcja UI i kompatybilny odczyt zatwierdzonego snapshotu | nie jako niezależny owner pozycji |
| visualization state API | trwały snapshot sesji | pośrednio, wyłącznie przez reguły adopcji registry |
| auto-fit / fit / reset / HUD | polecenia do właściciela runtime | tak, przez jawną transakcję programową |

`viewport3dStore.camera` nie może być równoległym, deklaratywnym wejściem nakładanym na kamerę po każdej zmianie. Jeżeli pole pozostaje przejściowo dla kompatybilności, jest wyłącznie projekcją ostatniego zatwierdzonego snapshotu registry i nie inicjuje ponownego ustawienia żywej kamery.

## 5. Transakcja gestu i monotoniczna epoka

Wprowadzamy jeden koordynator lifecycle’u w warstwie viewportu. Nie tworzy on nowego globalnego źródła stanu; zarządza referencjami runtime powiązanymi z konkretnym canvasem.

Minimalny kontrakt:

```ts
interface CameraGestureTransaction {
  begin(source: CameraGestureSource): number;
  markChanged(epoch: number): void;
  settle(epoch: number): void;
  cancelAndBegin(source: CameraGestureSource): number;
  dispose(): void;
}
```

`CameraGestureSource` rozróżnia co najmniej `orbit`, `pan`, `wheel`, `orientation-hud`, `fit`, `reset`, `projection` i `debug`. Każde `begin()` zwiększa `gestureEpoch`. Wszystkie opóźnione callbacki przechowują epokę i przed działaniem sprawdzają, czy nadal jest aktualna.

### 5.1. Początek

Na początku gestu:

1. zwiększamy `gestureEpoch`;
2. anulujemy timer commitowania poprzedniej epoki;
3. oznaczamy aktywny gest w lokalnym refie viewportu;
4. wywołujemy `cameraRegistry.beginInteraction(epoch)`;
5. aktywujemy istniejący field-update hold;
6. zapamiętujemy źródło gestu i snapshot początkowy wyłącznie do diagnostyki/testu.

Regularne eventy `OrbitControls` muszą uruchamiać ten sam lifecycle co HUD. Nie ma osobnego lifecycle’u wheel.

### 5.2. Trwanie i damping

`change` oznacza lokalną zmianę w bieżącej epoce i invaliduje demand frame. Zakończenie DOM pointer/wheel nie kończy automatycznie transakcji, jeśli `OrbitControls` nadal wykonuje damping. Gesture hold pozostaje aktywny do rzeczywistego uspokojenia controls.

Wykrycie spoczynku opiera się na stabilności żywego snapshotu przez ograniczoną liczbę kolejnych klatek albo na istniejącym sygnale zakończenia controls połączonym z fazą quiet. Stały timeout może być bezpiecznikiem cleanup, ale nie może być źródłem prawdy o zakończeniu animacji.

### 5.3. Commit

Po settle bieżącej epoki:

1. atomowo odczytujemy z aktywnej kamery i controls: `position`, `target`, `up`, projection oraz `orthographicScale`;
2. porównujemy snapshot przy użyciu wspólnej tolerancji zależnej od skali;
3. wykonujemy najwyżej jeden `cameraRegistry.patchCamera(snapshot, epoch)`;
4. registry publikuje zatwierdzony snapshot do deklaratywnych konsumentów;
5. planujemy persistence istniejącą ścieżką resource-first;
6. zwalniamy interaction i field hold dopiero po commicie lub jednoznacznym stwierdzeniu braku zmiany.

Nie wykonujemy równoległego `setCamera()` i `patchCamera()` z tej samej ścieżki. Starsza epoka kończy się bez skutków.

### 5.4. Cleanup

Unmount, wymiana canvasa lub sesji:

- anuluje timer/RAF settle i pending commit;
- unieważnia bieżącą epokę;
- zwalnia field hold;
- zamyka interaction w registry bez adopcji persisted shadow;
- odpina event listenery controls i canvas;
- nie wykonuje spóźnionego persistence po dispose.

## 6. Synchronizacja lokalna i zdalna

### 6.1. Persisted shadow

Każda nowsza rewizja zdalna aktualizuje `persistedShadow` i metadane rewizji. Nie oznacza to automatycznie adopcji do żywej kamery.

### 6.2. Dopuszczona adopcja zdalna

Stan zdalny może ustawić żywą kamerę tylko wtedy, gdy zachodzi jeden z przypadków:

1. pierwsza kompletna hydracja canvasa;
2. zmiana tożsamości sesji/sceny wymagająca nowego snapshotu;
3. brak aktywnej interakcji, brak lokalnego dirty state i brak nowszej lokalnej epoki;
4. jawne polecenie użytkownika przywracające zapisany widok.

Aktualizacja przychodząca podczas gestu pozostaje wyłącznie w `persistedShadow`. Po zakończeniu lokalnego gestu lokalny commit ma pierwszeństwo; nie wykonujemy automatycznego snap-back.

### 6.3. Zmiana `endInteraction()`

`CameraRegistryController.endInteraction()` przestaje ustawiać kamerę na `persistedShadow` tylko dlatego, że bieżący bit `dirty` jest fałszywy. Metoda kończy ochronę transakcji i publikuje status. Adopcja zdalna jest osobną, jawną operacją sprawdzającą rewizję, epokę i lokalny ownership.

### 6.4. Registry → store

Bezwarunkowe registry → `viewport3dStore.setCameraView()` zostaje usunięte lub ograniczone do kompatybilnej projekcji po commicie. Efekty R3F nie mogą interpretować tej projekcji jako polecenia ustawienia żywej kamery podczas normalnej rewizji zasobu.

## 7. Auto-fit i programowe polecenia

### 7.1. Tryb zarządzania

Viewport ma jawny tryb:

- `auto` — od pierwszej hydracji do pierwszego gestu użytkownika; aktualizacja istotnych bounds może dopasować kamerę;
- `user` — po pierwszym orbit/pan/wheel/HUD; bounds nie zmieniają pozycji samoczynnie;
- jawne `fit` — pojedyncza transakcja programowa dopasowująca aktualne bounds, po której ownership pozostaje `user`;
- jawne `reset` — pojedyncza transakcja programowa przywracająca kanoniczny widok początkowy i ponownie włączająca `auto` do następnego gestu użytkownika.

Asynchroniczna zmiana bounds podczas gestu może zostać zapamiętana jako dostępna, ale nie jest wykonywana w środku gestu ani automatycznie po nim, gdy kamera jest w trybie `user`.

### 7.2. Fit/reset

Jawne fit/reset:

1. unieważnia poprzednią epokę;
2. rozpoczyna programową transakcję;
3. oblicza widok z aktualnych bounds;
4. ustawia żywą kamerę i target;
5. wykonuje jeden commit registry;
6. kończy transakcję bez dodatkowej synchronizacji store → camera.

## 8. Wheel zoom, orbit i pan

Usuwamy własny capture wheel handler, własną animację zoomu oraz drugi timeout kończący gest. Standardowa obsługa Drei/Three `OrbitControls` jest właścicielem dolly/zoom i damping. Zachowujemy:

- istniejące ograniczenia odległości/skali;
- demand rendering i invalidację na zmianę;
- field-update hold przez całą aktywną fazę i damping;
- jeden commit po settle;
- osobne pokrycie perspektywy i ortho w testach.

Orbit i pan korzystają z identycznej transakcji. Różnica źródła gestu służy diagnostyce, nie tworzy osobnej logiki synchronizacji.

## 9. Projekcja, HUD i ViewCube

Zmiana perspektywa ↔ ortho jest jawnym poleceniem programowym:

1. anuluje bieżącą epokę i jej pending commit;
2. odczytuje aktualny żywy widok;
3. przenosi position/target/up do nowej kamery;
4. wylicza lub zachowuje równoważną skalę ortho;
5. przełącza aktywną kamerę;
6. wykonuje dokładnie jeden commit nowego snapshotu.

HUD/ViewCube używa tego samego koordynatora. Animowany snap kończy się commitem dopiero po settle; przerwanie snapu nowym gestem użytkownika unieważnia starszą epokę.

## 10. Tolerancje

Wszystkie warstwy używają jednego zestawu funkcji porównania:

- tolerancja position/target jest względna względem `max(sceneDiagonal, cameraTargetDistance, minimumSceneScale)` z małą granicą absolutną;
- `up` używa osobnej tolerancji bezwymiarowej/kątowej;
- `orthographicScale` używa tolerancji względnej;
- registry quantization i testy korzystają z tych samych zasad semantycznych;
- exact equality w store nie decyduje o tym, czy należy sterować żywą kamerą.

Konkretne wartości zostaną dobrane testami dla scen nanometrowych i większych, a nie przez zachowanie obecnego absolutnego `1e-7`.

## 11. Diagnostyka i obserwowalność

Dodajemy audytowy, domyślnie wyłączony bounded trajectory probe. Jest aktywowany wyłącznie przez browser smoke lub jawny tryb diagnostyczny i przechowuje ograniczony ring buffer próbek:

- frame/timestamp;
- żywe `camera.position`, `controls.target`, `up` i projection;
- zatwierdzony snapshot registry oraz `persistedShadow`;
- kompatybilny snapshot store;
- `gestureEpoch`, source, interaction/dirty/field-hold state;
- przyczynę invalidacji/commitu/adopcji.

Probe nie wykonuje alokacji ani logowania w normalnym trybie produkcyjnym. Test analizuje trajektorię w kierunku gestu i oznacza nieuzasadniony powrót w stronę wcześniejszego snapshotu.

## 12. Strategia testów

### 12.1. Testy jednostkowe

- epoka rośnie dla każdego nowego gestu;
- callback settle/commit starej epoki jest ignorowany;
- jedno settle daje najwyżej jeden commit;
- remote update podczas interakcji aktualizuje tylko shadow;
- `endInteraction()` nie wykonuje snap-back;
- dispose zwalnia hold i anuluje callbacki;
- porównanie tolerancji działa dla scen nanometrowych i makroskopowych.

### 12.2. Testy integracyjne komponentów

- zwykły OrbitControls otwiera i zamyka transakcję registry;
- remote update w środku orbit/pan/wheel nie zmienia żywej kamery;
- bounds update w środku gestu nie uruchamia fit;
- pierwszy gest przełącza `auto` → `user`;
- jawny fit/reset unieważnia starszą epokę i wykonuje jeden commit;
- projection swap zachowuje widok i wykonuje jeden commit;
- unmount nie pozostawia timerów, listenerów ani aktywnego hold.

### 12.3. Browser smoke / Playwright

Test wykonuje na realnym canvasie kolejno:

1. ładowanie i kontrolę widoczności canvasa;
2. kontrolę `gl.isContextLost() === false` i niezerowego drawing buffer;
3. orbit przez co najmniej 2 s z próbkowaniem trajektorii;
4. pan;
5. wheel zoom perspektywiczny;
6. zmianę na ortho i wheel zoom ortograficzny;
7. zdalną rewizję i zmianę bounds wstrzyknięte podczas gestu;
8. jawny fit/reset;
9. oczekiwanie na idle i potwierdzenie braku dalszych dirty/render frames;
10. kontrolę niedozwolonych requestów i błędów konsoli.

Kryteria trajektorii:

- zoom wykorzystuje więcej niż jedną klatkę przy aktywnym damping;
- nie ma skoku do snapshotu sprzed gestu;
- nie ma zmiany kierunku o wielkości przekraczającej tolerancję bez odpowiadającego jej inputu użytkownika lub jawnego polecenia;
- każdy gest kończy się jednym zatwierdzonym snapshotem.

### 12.4. Bramy końcowe

- zawężone testy Vitest kamery/viewportu;
- pełny typecheck `apps/control-room`;
- testy architektury/state hygiene;
- repozytoryjny viewport browser smoke;
- pomiar demand idle;
- ręczna kwalifikacja aktywnej sesji FDM i FEM obejmująca orbit, pan, wheel, projection, Fit, Reset i ViewCube;
- React Doctor bez regresji wyniku dla zmienionego zakresu.

## 13. Kolejność migracji

1. Dodać testy odtwarzające stale epoch, remote mid-gesture, bounds mid-gesture i snap-back registry.
2. Rozszerzyć registry o jawny kontrakt epoki i rozdzielić `endInteraction` od adopcji remote.
3. Wprowadzić koordynator transakcji przy aktywnym canvasie i podłączyć OrbitControls/HUD.
4. Zmienić commit na atomowy registry-only i usunąć równoległe zapisy pozycji.
5. Usunąć bezwarunkowe registry → store → live camera sprzężenie zwrotne.
6. Wprowadzić `auto`/`user` ownership dla fit oraz skalowe tolerancje.
7. Usunąć własny wheel zoom i oprzeć lifecycle na OrbitControls + settle.
8. Ujednolicić projection, fit/reset i ViewCube przez epokę.
9. Dodać bounded trajectory probe i rozszerzyć browser smoke.
10. Uruchomić pełne bramy oraz udokumentować świeży dowód runtime.

Każdy krok musi pozostawić viewport kompilowalny i objęty zawężonym testem. Usuwanie kompatybilnych pól store następuje dopiero po usunięciu wszystkich konsumentów; nie wykonujemy szerokiej refaktoryzacji niezwiązanych warstw.

## 14. Ryzyka i zabezpieczenia

| Ryzyko | Zabezpieczenie |
|---|---|
| Drei `end` następuje przed końcem widocznego damping | osobna faza settle oparta na stabilności żywego snapshotu |
| remote revision zostaje utracona | shadow zawsze przyjmuje nowszą rewizję, niezależnie od adopcji |
| szybkie gesture chaining zatwierdzi stary stan | monotoniczna epoka i latest-wins check w każdym callbacku |
| projection swap zmieni kadr | przeniesienie żywego pose/target i test równoważności widoku |
| auto-fit przestanie reagować na pierwsze dane | tryb `auto` do pierwszej świadomej interakcji użytkownika |
| demand loop nie wróci do idle | bounded settle, cleanup i dedykowany idle gate |
| diagnostyka pogorszy wydajność | compile/runtime gate oraz ring buffer aktywny tylko w audycie |
| usunięcie store pose złamie UI | etapowa kompatybilna projekcja zatwierdzonego snapshotu i testy konsumentów |

## 15. Niezmienniki implementacyjne

1. Podczas aktywnej epoki tylko żywa kamera/controls może zmieniać pose.
2. Każdy pose widoczny deklaratywnie pochodzi z zatwierdzonego snapshotu registry.
3. Jeden gest daje zero commitów przy braku ruchu albo dokładnie jeden commit po zmianie.
4. Starsza epoka nigdy nie zapisuje, nie adoptuje remote i nie zwalnia hold nowszej epoki.
5. `endInteraction()` nigdy samoczynnie nie przywraca persisted shadow.
6. Bounds nie przesuwają kamery w trybie `user`.
7. Nie istnieje drugi wheel listener ani osobna animacja zoomu poza OrbitControls.
8. Każde programowe ustawienie kamery przechodzi przez transakcję i commit registry.
9. Po settle demand loop pozostaje bezczynny do następnego zdarzenia.
10. Zmiana nie obniża jakości renderingu ani nie omija resource-first API.
