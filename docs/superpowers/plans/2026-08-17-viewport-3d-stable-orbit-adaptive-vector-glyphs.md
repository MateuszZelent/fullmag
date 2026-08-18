# Plan wdrożenia stabilnego orbitowania i adaptacyjnych glyphów

## Cel

Usunąć zanik i przebudowę warstw pola podczas orbitowania oraz zapewnić identyczną, lokalnie adaptacyjną geometrię strzałek we wszystkich ścieżkach FDM/FEM.

## Zadanie 1 — regresja last-good

**Pliki:** `hooks/useViewport3DSceneModel.test.ts`, `hooks/useViewport3DSceneModel.ts`, `viewport3dFieldUpdateHold.ts`, `Viewport3DModule.tsx`, `layers/CameraControls.tsx`.

1. Dodać failing test dla gotowego zgodnego envelope przy aktywnym hold.
2. Dodać kontrakt źródłowy zabraniający rootowego pointer hold i subskrypcji hold w modelu sceny.
3. Powiązać pauzę transportu z lifecycle OrbitControls bez prezentacyjnego stanu React.
4. Zachować zgodny gotowy payload niezależnie od gestu.
5. Uruchomić testy sceny, kamery, hold i modułu.

## Zadanie 2 — kanoniczny resolver skali

**Pliki:** nowy `model/viewport3DVectorGlyphScale.ts` wraz z testem, `hooks/useViewport3DSceneModel.ts`, `layers/fdmCuboidBuildModel.ts`, `viewport3dRenderModel.ts`.

1. Zapisać testy dla izotropii, anizotropii, budżetu, bounds i clampów.
2. Zaimplementować czystą funkcję wyznaczającą charakterystyczny rozstaw oraz długość glyphu.
3. Przekazać rozstrzygniętą skalę do standardowej i vector-only ścieżki.
4. Usunąć podwójny/ad-hoc cap, aby wynik nie zależał od aktywnej warstwy powierzchniowej.
5. Włączyć ten sam kontrakt do budowy segmentów FEM.

## Zadanie 3 — proporcje i semantyka

**Pliki:** `layers/vectorGlyphGeometry.ts`, `layers/VectorFieldLayer.tsx` i testy.

1. Utrzymać długość jednolitą i kanał `relMag` dla koloru.
2. Zmniejszyć domyślne proporcje główki/trzonu tylko na podstawie testu geometrii i przeglądu wizualnego.
3. Zachować `vectorThickness` jako ograniczony mnożnik użytkownika.

## Zadanie 4 — kwalifikacja

1. Uruchomić skupione Vitest.
2. Uruchomić typecheck i statyczne bramki wydajności.
3. Uruchomić browser/WebGL smoke; jeśli integracja Codex nadal blokuje przeglądarkę, zapisać dokładny blocker bez promowania testów statycznych.
4. Uzupełnić audyt o zmienione symbole, wyniki i niezweryfikowane bramki.

## Bramy akceptacji

- gotowy bufor i liczba glyphów nie zmieniają się między pointerdown, orbit i pointerup;
- ruch kamery nie powoduje Reactowej przebudowy modelu pola;
- vectors-only i shader+vectors dają tę samą długość dla tego samego targetu i budżetu;
- długość reaguje na efektywny rozstaw próbek, nie przekracza lokalnego limitu i nie koduje magnitudy;
- canvas pozostaje widoczny, `gl.isContextLost() === false`, drawing buffer ma dodatnie wymiary.

