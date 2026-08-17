# Przebudowa Inspectora wizualizacji 3D — kontekst na dole

**Data:** 2026-08-17  
**Status:** zatwierdzony wariant A przez użytkownika  
**Zakres:** `apps/control-room/src/modules/inspector`  

## Cel

Inspector wizualizacji ma zaczynać się od czynności sterujących widokiem, a nie
od ogólnych metadanych. Użytkownik powinien najpierw widzieć i obsługiwać
przełącznik kontekstu oraz ustawienia renderowania, a dopiero na końcu mieć
dostęp do informacji opisowych i diagnostycznych.

## Aktualny problem

`VisualizationTargetInspectorPanel` renderuje `ScientificInspectorTemplate`
przed właściwą treścią panelu. Szablon umieszcza na początku `Status`,
`Physical properties` i `Provenance`. Następnie
`ObjectVisualizationPanelView` renderuje grupę `Target` jako pierwszą sekcję
kontrolek. W efekcie najważniejsze ustawienia wizualizacji są odsunięte w dół,
a metadane zajmują początkową przestrzeń Inspectora.

## Decyzja projektowa — wariant A

Zmiana pozostaje lokalna dla Inspectora wizualizacji. Wspólny
`ScientificInspectorTemplate` nie otrzymuje globalnej zmiany kolejności, która
mogłaby zmienić inne Inspectory.

Kompozycja zostaje rozdzielona na dwa elementy:

1. **Tożsamość u góry** — tytuł `Object visualization` oraz istniejące badge
   `physicalLabel` i `methodLabel`. Ten fragment zachowuje orientację użytkownika
   po wejściu do panelu.
2. **Kontekst na dole** — istniejące grupy `Status`, `Physical properties`,
   `Provenance` oraz pełna grupa `Target`, renderowane po wszystkich aktywnych
   kontrolkach wizualizacji.

Nie zmienia się znaczenie żadnego pola, targetu, override'u, statusu zasobu ani
proweniencji. Zmienia się wyłącznie hierarchia i kompozycja UI.

## Docelowa kolejność

Dla gotowego targetu 3D:

```text
Object visualization + badges
View / 3D–Planar
Display
  Display passes
  Render mode
  Quantity source
Surface Coloring
Vectors
Points (jeśli aktywne)
Wireframe (jeśli aktywny)
Geometry Scope (jeśli dostępny)
Diagnostics & overrides
Status
Physical properties
Provenance
Target
```

Sekcje kontekstu pozostają zwijalne i domyślnie zamknięte, tak jak obecna
grupa `Target`. Ich zamknięcie nie usuwa danych ani nie wpływa na renderowanie.
Checkbox `Apply edits to child regions`, gdy jest dostępny, pozostaje w grupie
`Target`, ponieważ jest to override przypisany do targetu.

## Stany szczególne

- **Brak targetu:** nagłówek pozostaje widoczny; treść pokazuje komunikat o
  braku targetu; dolne `Status` i `Target` raportują odpowiednio `unavailable`
  oraz `No visualization target`.
- **Ładowanie baseline:** kontrolki pozostają zablokowane zgodnie z obecnym
  stanem; `Status` i `Target` są nadal na dole, a stan ładowania jest widoczny
  w treści panelu.
- **Kontekst planar:** nagłówek, przełącznik `View` i sekcja planar pozostają
  na początku; kontekst naukowy nadal jest renderowany po treści planarnej.
- **Błąd lub degradacja renderera:** istniejące ostrzeżenia, statusy resource i
  `Diagnostics & overrides` zachowują obecne wartości oraz kolejność w obrębie
  własnych grup.

## Granice odpowiedzialności

- `ScientificInspectorTemplate` zachowuje dotychczasowy kontrakt dla innych
  paneli.
- Wizualizacyjny panel dostaje lokalny sposób renderowania nagłówka i dolnego
  kontekstu; nie dodaje transportu ani nowych zasobów.
- Model `useObjectVisualizationPanelState` pozostaje właścicielem targetu,
  statusu, proweniencji, baseline i override'ów.
- Żaden komponent UI nie buduje endpointu ani nie pobiera danych bezpośrednio.
- Zmiana nie zmniejsza jakości renderowania, nie ukrywa warstw i nie zmienia
  domyślnych ustawień wizualizacji.

## Dostępność i semantyka

Kolejność musi być zmieniona w drzewie React/DOM, a nie przez CSS `order`.
Focus z klawiatury, kolejność czytnika ekranu i kolejność wizualna mają być
zgodne. Istniejące przyciski zwijania muszą nadal expose'ować poprawne
`aria-expanded` i `aria-controls`.

## Weryfikacja

Implementacja musi dostarczyć:

1. test renderowania potwierdzający, że nagłówek jest przed kontrolkami, a
   `Status`, `Physical properties`, `Provenance` i `Target` po nich;
2. testy stanów brak targetu, baseline loading oraz planar;
3. regresję istniejących testów `ObjectVisualizationPanel`,
   `ScientificInspectorTemplate` i accessibility;
4. typecheck oraz targeted lint dla zmienionych plików;
5. browser smoke Inspectora potwierdzający kolejność widocznych sekcji,
   działanie zwijania i brak utraty canvas/WebGL po zmianie ustawienia.

## Poza zakresem tego projektu

Naprawa Airboxa, znikania renderera po `Points` oraz błędu pobierania
`H_eff/H_demag` jest osobnym strumieniem diagnostyczno-implementacyjnym.
Współdzieli z tym projektem jedynie wymóg, aby przebudowa Inspectora nie
zmieniała resource hooków, render lifecycle ani kontraktu danych pola.

## Kryteria akceptacji

- Pierwszymi informacjami operacyjnymi po nagłówku są przełącznik widoku i
  kontrolki wizualizacji.
- Żadna z czterech grup kontekstowych nie pojawia się przed kontrolkami.
- Pozostałe Inspectory zachowują dotychczasową kolejność.
- Zmiana targetu, ilości, trybu renderowania, Points, Wireframe i Vectors nie
  traci stanu ani nie powoduje dodatkowego żądania tylko z powodu nowej
  kolejności UI.
- Testy i smoke nie wykazują regresji w dostępności ani lifecycle viewportu.
