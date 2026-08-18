# Stabilne orbitowanie i adaptacyjne glyphy wektorowe w Viewport 3D

**Data:** 2026-08-17  
**Status:** zatwierdzony przez użytkownika  
**Wariant:** A — jednolita długość kierunkowa, adaptacyjna geometria, wartość pola kodowana kolorem

## Problem

`pointerdown` na root viewportu aktywuje hold zasobów pola oraz publikuje jego stan do szerokiego `useViewport3DSceneModel`. Bieżąca logika last-good wybiera `null` podczas aktywnego hold nawet wtedy, gdy hook nadal posiada zgodny gotowy bufor. Powoduje to zanik warstwy pola i jej ponowną budowę po `pointerup`.

Tryb FDM `vectorOnly` omija `resolveFdmVectorGlyphScale`. Otrzymuje globalną długość równą 5% najdłuższego wymiaru sceny, podczas gdy zwykła ścieżka cuboidu nakłada lokalny limit. Przełączenie shader+vectors na vectors-only zmienia więc geometrię tych samych danych.

## Kontrakt docelowy

1. Gest kamery nie zmienia aktywnego bufora pola, modelu renderu, jakości, DPR, widoczności ani opacity.
2. Hold może zatrzymać nowe transfery, ale nie może publikować prezentacyjnego stanu React ani usuwać przyjętych danych.
3. Wszystkie ścieżki FDM i FEM korzystają z jednej semantyki skali glyphu.
4. Długość podstawowa wynika z lokalnego rozstawu renderowanych próbek, nie z samego rozmiaru sceny.
5. `vectorLengthScale` jest ograniczonym mnożnikiem prezentacyjnym podstawowej długości.
6. Długość glyphu nie koduje wartości pola. Wartość względna pozostaje w kanale `relMag` i może być kodowana kolorem.
7. Proporcje główki i trzonu są czytelne, ale nie dominują nad odstępem próbek.

## Lifecycle gestu

Hold transportu zostanie powiązany z rzeczywistym rozpoczęciem i zakończeniem gestu OrbitControls, a nie z dowolnym pointer-down rootu. Model sceny nie będzie subskrybował `holdActive`. Resource store zachowa już przyjęty payload; nowe odpowiedzi mogą zostać odroczone do końca gestu.

Niezależnie od transportu selektor last-good musi zachować zgodny gotowy envelope. Test regresji obejmie przypadek `status=ready`, aktywny hold i istniejący zgodny payload.

## Skala glyphów

Nowy resolver przyjmie charakterystykę nośnika i efektywnego próbkowania:

- FDM: spacing osi, liczba kandydatów, liczba faktycznie renderowanych glyphów i scope;
- FEM: bounds/pozycje wybranych węzłów i liczba renderowanych glyphów;
- fallback: objętościowy rozstaw `cbrt(volume / count)` z ograniczeniem przez dodatnie wymiary bounds.

Podstawowa długość będzie ułamkiem charakterystycznego rozstawu próbek i zostanie ograniczona dolnym oraz górnym limitem zależnym od nośnika. Ten sam resolver zostanie wywołany przed standardową i `vectorOnly` ścieżką. Funkcje budujące segmenty nie będą samodzielnie zmieniały semantyki skali.

## Wydajność

Obliczenie skali odbywa się podczas budowy planu lub joba, nie na klatkę kamery. Resolver operuje na metadanych i nie wykonuje pełnego nearest-neighbour nad tysiącami punktów. Klucze buildów zawierają rozstrzygniętą skalę, więc zmiana ustawień unieważnia właściwy job, ale ruch kamery nie.

## Weryfikacja

- test jednostkowy last-good dla gotowego payloadu podczas hold;
- test źródłowy: brak subskrypcji `holdActive` w modelu sceny i brak root pointer hold;
- test zgodności skali standard/vector-only;
- testy FDM dla siatek izotropowych, anizotropowych i zmiennego budżetu;
- test FEM/fallback dla bounds i liczby próbek;
- test proporcji glyphu;
- browser smoke: canvas widoczny, WebGL zdrowy, niezerowy drawing buffer, glyph count nie spada podczas orbitowania.

