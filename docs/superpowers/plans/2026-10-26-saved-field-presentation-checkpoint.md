# Zapisane pola: sterowanie prezentacją i zgodna legenda

Data: 26.10.2026. Zakres: fragment E5–E7, nie odbiór całego E0–E12.
Baza kandydata: `7bbd00e85efdb453066e131b7d89356202910372`.

## Zachowanie

Po wybraniu zapisanego datasetu jego prezentacja pozostaje aktywna także po przejściu do Airbox → Visualization. Użytkownik może zmieniać widoczność powierzchni, siatki i strzałek, komponent, paletę, automatyczny lub ręczny zakres SI oraz parametry strzałek. Sterowanie używa wspólnego szablonu Inspectora i istniejących kontrolek. Powrót do bieżącego widoku respektuje blokadę zmiany selekcji z niezapisanym draftem. Te działania nie uruchamiają Solve i nie zmieniają konfiguracji live.

Przedstawiany jest własny nośnik i aktywny support wybranego wyniku, a nie domyślnie cały Universe. Brak próbki nie jest zerem; skalar nie otrzymuje strzałek. Metadane, projekt i pełna niezmienna tożsamość datasetu muszą odpowiadać wybranemu wynikowi. Istniejące bramki binarnego transportu, geometrii i integralności pozostają zachowane.

Ręczne zakresy są oddzielne dla normy i x/y/z, walidowane i kopiowane w kontrolerze prezentacji; Auto usuwa tylko odpowiedni zakres. Kolory zachowują jednostki i wartości fizyczne niezależnie od długości lub budżetu strzałek. Powierzchnia i wektory mogą mieć różne legendy. Legenda używa zakresu/palety potwierdzonego widocznego buildu; podczas nowego uploadu zachowuje poprzednią skalę. Koperta workera przekazuje metadane wraz z RGB i transformacjami. Zmiana datasetu czyści raporty, a cleanup właściciela nie kasuje cudzej nowej skali.

Przejściowy błąd odświeżenia poprawnych metadanych tego samego wyniku ma osobne ostrzeżenie. Nie wyłącza wszystkich lokalnych kontrolek. Obca tożsamość, niewłaściwy projekt, brak danych, błąd początkowego odczytu lub nieobsługiwany descriptor pozostają odmową. To zachowanie dotyczy metadanych Inspectora; nie osłabia bramek danych binarnych viewportu.

## Właściciele

- `src/kernel/visualization/ObjectVisualizationController.ts`: mała konfiguracja prezentacji przypięta do selection, nie tablice danych.
- `src/kernel/resources/savedFieldViewportResources.ts`: wspólna bramka metadanych Inspectora i pełnej ścieżki binarnej.
- `src/modules/inspector/panels/SavedFieldVisualizationPanel.tsx`: wspólny układ i lokalne mutacje; istniejący resource owner dostarcza metadane.
- `src/modules/viewport-3d/model/viewport3DVisibleColorScale.ts`: tylko małe metadane widocznej skali i klucz wybranego store; bufory pozostają w upload stores.
- `src/modules/viewport-3d/layers/VectorFieldLayer.tsx` i `FallbackTopologyMeshLayer.tsx`: potwierdzenie wyświetlanego bufora, cleanup i raport do Frame.
- `src/modules/viewport-3d/Viewport3DModule.tsx`: maksymalnie dwa rekordy skali saved; bez pozornej sesji live i bez wpisywania saved ranges do rejestru live.

Ścieżki `src` powyżej są względem `apps/control-room`.

## Dowody i granice

Kandydat wyklucza współdzielony `ArtifactInspectionSource.tsx`, API oraz niezależny routing właściciela Universe. Izolacja obejmuje HEAD plus jawnie wybrane zmiany, z wyłączeniem pozostałego lokalnego WIP; pliki HMR i współdzielony indeks nie są podmieniane podczas testów. Kontrole wykonuje istniejący frontend grupy Docker DEV anteny, nie hostowy build.

Dowody są w wolumenie kontrolnym grupy, `verification/saved-presentation-commit-20261026/`: dokładne candidate JSON/patch, trzy interpretowane regresje, parser, mechaniczny przegląd granicy, izolowany native TypeScript i lint. Pierwszy błąd harnessu `import.meta.url` oraz początkowa odmowa cwd z powodu subpath wolumenu są zachowane osobno. Regresja odświeżenia odtwarzała wyłączenie kontrolek przed poprawką.

**Nie zweryfikowano:** faktyczny draw WebGL, canvas/context/drawing-buffer, stabilność focus/scroll/DOM w przeglądarce oraz kompletny wynik nowej pełnej próby Universe. Kontrole SSR/modelu/upload callbacków nie zastępują tych bramek. Nie kompilowano testów jednostkowych. To lokalny checkpoint źródeł; brak kwalifikacji wydania, fizyki nowej siatki i całego E0–E12.
