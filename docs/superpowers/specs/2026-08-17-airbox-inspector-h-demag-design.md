# Airbox Inspector i wektory H_demag — projekt wariantu A

**Status:** zatwierdzony przez użytkownika 2026-08-17

## Cel

Airbox ma jeden Inspector, w którym kontrolki wizualizacji zaczynają się od `View`, a informacje ogólne są zwinięte na dole. `H_demag` ma jedną target-aware identity zasobu, zgodną w availability, meta, vector request, cache, diagnostyce i rendererze. Zakończeniem jest browser/WebGL proof widocznych wektorów `H_demag` w Airbox.

## Projekt UI

`AirboxVisualizationPanel` jest panelem self-framing: sam renderuje `ScientificInspectorIdentity`, właściwe kontrolki oraz dolny `ScientificInspectorContext`. Route `airbox.visualization` i `mesh-part-airbox` nie mogą owijać go w `DedicatedInspectorRouteFrame`.

Docelowa kolejność:

1. tożsamość Airbox visualization;
2. `View`;
3. `Display`, `Render Mode`, `Quantity Source`;
4. `Surface Coloring`, `Vectors` i kontrolki aktywnych passów;
5. `Overrides`;
6. zwinięty `Target`;
7. zwinięte `Status`, `Physical properties`, `Provenance`.

Nie zmieniamy ram innych Inspectorów, które nie mają własnej tożsamości i kontekstu.

## Projekt identity pola Airbox

Wspólny resolver zwraca identity rzeczywistego carriera:

- FDM Airbox: `scope_kind=airbox`, `scope_id=airbox`;
- FEM Airbox: `scope_kind=airbox`, `scope_id=<mesh part id>`, standardowo `part:__air__`;
- brak rozstrzygniętego carriera: stan pending/unavailable, bez niepełnego requestu `scope_kind=airbox` bez `scope_id`.

Resolver jest używany przez availability, meta, vector demand/request key, retry, debug export i renderer. UI nie tworzy endpointów; HTTP v2 i centralny `ControlRoomApi` pozostają źródłem prawdy, a WebSocket wyłącznie unieważnia zasoby.

## Lifecycle i renderer

Zmiana quantity lub sposobu kolorowania nie przebudowuje topologii. Przy zachowaniu tej samej topology/carrier identity renderer utrzymuje ostatni przyjęty bufor aż do adopcji nowej rewizji pola. Wektory Airbox są osobnym passem; kwalifikacja odbywa się przy wyłączonym wireframe, aby nie maskować wyniku.

## Hydration

Wskazany mismatch zawiera DOM `ext-megabonus-main-content`, którego aplikacja nie renderuje. Jest to modyfikacja dokumentu przez rozszerzenie przeglądarki. Aplikacja musi przejść czysty Playwright bez hydration error; nie dodajemy `suppressHydrationWarning` ani innych obejść dla obcego DOM.

## Bramy akceptacji

- Airbox ma dokładnie jedną ramę naukowego Inspectora i `View` występuje przed `Status`.
- Żaden request Airbox field vector nie ma `scope_kind=airbox` bez `scope_id`.
- FDM żąda `scope_id=airbox`; FEM żąda aktualnego mesh-part carriera.
- `H_demag` availability i vector payload są ready/adopted dla tego samego request key.
- Browser smoke pokazuje dodatnią liczbę glyphów `H_demag`, wireframe wyłączony, canvas widoczny, WebGL context nieutracony i dodatni drawing buffer.
- Zapisany screenshot stanowi dowód wizualny; brak błędów konsoli aplikacji i hydration mismatch w czystym profilu.

