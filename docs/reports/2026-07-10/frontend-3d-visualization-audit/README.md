# Audyt frontendu 3D, wizualizacji i kontroli inspektorów

**Data:** 2026-07-10
**Zakres bazowy:** `apps/control-room`, kontrakt v2, renderer R3F/Three.js, inspektory, Ribbon, Explorer, regiony, mesh/airbox, shadery, wireframe, pola, realtime i bramki jakości
**Rewizja audytowana:** `b554346b43a79be1b681189cb5f44fb3bdb4b06a`
**Gałąź:** `salvage/mixed-fem-viewport-35232294`
**Charakter pracy:** audyt nie modyfikował kodu aplikacji; wyniki zapisano w
plikach raportu, a `.gitignore` dostał wąski wyjątek dla tego katalogu

## Aktualizacja dla najnowszej wersji — 2026-07-14

Audyt został ponowiony na `master` przy rewizji
`9f0c64f5bd14d0b47e84727179b817bd6f1d1830` oraz na bieżącym, współdzielonym
worktree. Historyczny dokument `09-remediation-completion.md` nie jest już
dowodem, że obecny frontend 3D jest zamknięty produkcyjnie.

Aktualny wynik bazowy:

- **26/28** historycznych findings pozostaje naprawionych w pierwotnie
  zdefiniowanym zakresie;
- **F3D-003 i F3D-013** są tylko częściowo zamknięte;
- historyczne **F3D-026 i F3D-028 pozostają zamknięte**; brak reprezentatywnego
  gate'a CoFeB oraz niepełny artifact pre-canvas są nowym zakresem F3D-031, a
  nie unieważnieniem ich pierwotnych kryteriów;
- dodano **F3D-029–F3D-032** dla awarii rzeczywistego, dużego FEM CoFeB oraz
  rozjazdu renderer ↔ Explorer;
- aktualny scenariusz `permalloy_layer_cofeb_rings_relax_300nm.py` ma również
  niezależną blokadę materializacji mesha, opisaną poza bilansem błędów
  frontendu.

Najważniejszy werdykt: małe fixture FDM i syntetyczny FEM przechodzą, ale nie
dowodzą działania rzeczywistej sceny FEM. Profil CoFeB z około 833 tys.
komórek wykazał `surface-colors-unavailable`, `vector-segments-unavailable`,
48,4 s pracy workera `field-color`, 47,7 s pojedynczego long tasku i timeout
screenshotu. Po wyłączeniu wektorów surface wracał do `ready`.

Drugi krytyczny rozjazd dotyczy tożsamości sceny: carrier FEM
`part:__air__` może zostać wybrany jako osobny obiekt mimo istnienia
kanonicznego węzła `Airbox`. Pozwala to utrzymywać równoległe override'y i
nakładać passy. F3D-032 ustanawia twardą regułę: każdy semantyczny, pickowalny
cel renderera musi mieć dokładnie jeden kanoniczny węzeł Explorera, a kliknięcie
w viewport musi ten węzeł ujawnić, rozwinąć, przewinąć i podświetlić.

Świeża weryfikacja bieżącego dirty worktree:

- typecheck — pass;
- lint z `--max-warnings=0` — pass;
- pełny Vitest — **325 plików / 3015 testów**, pass;
- browser memory-churn — pass, 120 przełączeń, geometrie `5 -> 5`, heap
  `17,9 -> 19,8 MB`;
- browser FEM topology uploads — pass, 12 przypadków, positions około
  `162,2–164,0 KB`;
- trzy nowe testy API normalizacji Airboxa — pass;
- mimo zielonych bramek nadal brak testu viewport click → istniejący węzeł
  Explorera oraz reprezentatywnego CoFeB surface/vector proof. Zielone wyniki
  nie zamykają F3D-029, F3D-030, F3D-031 ani F3D-032.

Aktualne dokumenty:

- [10-reaudyt-najnowszej-wersji-2026-07-14.md](10-reaudyt-najnowszej-wersji-2026-07-14.md) — pełna macierz 28 findings i dowody;
- [11-regresje-renderera-fem-shaderow-i-wektorow.md](11-regresje-renderera-fem-shaderow-i-wektorow.md) — otwarte problemy correctness/renderera;
- [12-bramki-diagnostyka-i-blokady-runtime.md](12-bramki-diagnostyka-i-blokady-runtime.md) — luki gate'ów i blokada end-to-end.

## Werdykt audytu bazowego z 2026-07-10

Frontend ma solidny fundament: jeden aktywny Canvas 3D, `frameloop="demand"`,
rozdzielone modele topologii i pola, zasobo-centryczne API v2, prawidłowy pełny
wireframe airboxu oraz działające podstawowe bramki WebGL. Nie jest jednak obecnie
bezpieczny jako źródło naukowej interpretacji w każdym stanie przejściowym.

Audyt potwierdził **28 problemów**:

| Priorytet | Liczba | Znaczenie |
|---|---:|---|
| P0 — krytyczny | 4 | możliwe powiązanie pola lub geometrii z niewłaściwą domeną/topologią |
| P1 — wysoki | 9 | nieskuteczne albo sprzeczne kontrolki, rozjazd źródeł prawdy, awarie kluczowych passów |
| P2 — średni | 12 | błędy zakresu, persistence, lifecycle, pamięci, dostępności i bramek |
| P3 — niski | 3 | węższa luka diagnostyczna, lokalne koszty skalowania i cleanup listenerów |

Najważniejszy wspólny problem to brak jednego, twardego kontraktu zgodności:

```text
scene revision
  + domain generation
  + topology identity
  + field revision/indexing
  + canonical visualization target
  = dopiero wtedy legalny render pola
```

Obecna implementacja sprawdza tylko część tych elementów. W rezultacie UI może
pokazać poprawnie wyglądający obraz, którego pochodzenie nie jest aktualne albo
który nie odpowiada wybranemu targetowi.

## Najważniejsze findings

1. Jawna różnica `scene.revision` i `manifest.source_scene_revision` może zostać
   uznana za `current`, jeżeli obiekt nie ma taga dirty (`F3D-001`).
2. Nawet topologia oznaczona jako `stale` pozostaje normalnym nośnikiem shaderów,
   punktów i wektorów (`F3D-002`).
3. `domain_generation_id` z FMVP v3 jest dekodowane, ale nie bierze udziału w
   dopasowaniu pola do domeny/topologii; ręczny parser websocket dodatkowo usuwa
   ten token z eventu invalidation (`F3D-003`).
4. Asynchroniczny model FDM może zwrócić wynik poprzedniego `buildKey`, a błąd
   bieżącego buildu jest połykany (`F3D-004`).
5. Resolver uznaje `geometry_id` za canonical object id mimo braku `object_id`,
   przez co jawny override `part:*` może nie trafić do renderera. Dynamiczna
   bramka pokazała identyczne tryby projekcji, ale jej fixture również jest
   niezgodne z bieżącym OpenAPI i musi zostać naprawione (`F3D-005`).
6. Backend publikuje kompletny effective registry `targets.objects/parts`, ale
   frontend odtwarza targety lokalnie z global state + overrides i go ignoruje
   (`F3D-006`).
7. Inspector utrwala backend-supported patch w drugim lokalnym store, który nie
   jest czyszczony po ACK i może bezterminowo wygrywać z HTTP v2 (`F3D-013`).
8. Region dziedziczy z obiektu `visible` oraz aktywne passy, choć spec wymaga
   dziedziczenia jedynie quantity/palette/style i jawnego włączenia regionu
   (`F3D-009`).
9. FDM nie realizuje niezależnych passów `vectors-only` i `points-only`, mimo że
   Inspector je oferuje (`F3D-008`).
10. Bieżące bramki idle/memory nie montują realnego R3F/WebGL lifecycle i nie
    mogą dowieść braku wycieków workerów/GPU (`F3D-026`).

## Pliki raportu

- [01-correctness-provenance-and-staleness.md](01-correctness-provenance-and-staleness.md) — aktualność sceny, topologii, pola i FDM.
- [02-renderer-shaders-fields-and-passes.md](02-renderer-shaders-fields-and-passes.md) — shadery, projekcja powierzchni, effective target registry i niezależne passy.
- [03-wireframe-mesh-airbox-and-regions.md](03-wireframe-mesh-airbox-and-regions.md) — mesh, wireframe, airbox, region carriers i zakres targetów.
- [04-inspectors-state-inheritance-and-accessibility.md](04-inspectors-state-inheritance-and-accessibility.md) — source of truth, reset/inheritance, kontrolki i dostępność.
- [05-resource-api-realtime-and-cache-identity.md](05-resource-api-realtime-and-cache-identity.md) — resource-first API, scoped query identity i realtime.
- [06-performance-webgl-workers-and-memory.md](06-performance-webgl-workers-and-memory.md) — workery, cache, GPU uploads, bufory i cleanup.
- [07-tests-gates-and-audit-evidence.md](07-tests-gates-and-audit-evidence.md) — wykonane komendy, wyniki, ograniczenia i problemy bramek.
- [08-remediation-roadmap.md](08-remediation-roadmap.md) — kolejność napraw, zależności i kryteria wyjścia.

Każdy problem ma w pliku kategorii: symptom, dowód, mechanizm, wpływ, plan naprawy,
test regresyjny i mierzalne kryterium akceptacji.

## Zakres pokrycia

| Obszar | Co sprawdzono | Wynik |
|---|---|---|
| Canvas i WebGL | montowanie, visibility, context loss, drawing buffer, demand loop | smoke pozytywny; bramka lifecycle niepełna |
| Topologia i domena | scene/manifest freshness, FDM/FEM adapters, topology identity | cztery problemy P0/P1 |
| Pola i shadery | FMVP, scoped buffers, scalar/orientation/complex attributes, projection modes | błędna identity + nieskuteczna projekcja |
| Passy | surface, wireframe, points, vectors, bounds/frame | FEM rozdzielone; FDM points/vectors niekompletne |
| Wireframe i airbox | surface/full, hidden edges, opacity, reset/persistence | rendering poprawny; persistence airboxu niepełne |
| Target registry | object, part, region, airbox, configured/effective state | backend registry nie jest kanonicznie konsumowane |
| Explorer/Ribbon/Inspector | selection, patch, clear, inherited, disabled states | kilka rozjazdów źródeł prawdy i semantyki |
| Regiony | authored/realized/projection, carriers, child overrides | carrier rozdzielony; visibility/inheritance błędne |
| API/realtime | typed facade, HTTP OpenAPI, WS/AsyncAPI, invalidation, scoped keys | HTTP kontrakt aktualny; parser WS gubi generation id, invalidation jest zbyt szerokie |
| Performance | cache, workery, GPU upload, listener cleanup, idle | siedem problemów/ryzyk z konkretnym planem pomiaru |
| Dostępność | toggle/segmented/color controls | brak pełnej semantyki stanu dla AT |

## Metoda i poziomy dowodu

Wnioski zostały zestawione z kontraktami w:

- `docs/specs/frontend-v2/04-state-management.md`;
- `docs/specs/frontend-v2/05-viewport-architecture.md`;
- `docs/specs/frontend-v2/14-viewport-3d-module.md`;
- `docs/specs/frontend-v2/17-performance-memory-profiler.md`;
- `docs/specs/frontend-v2/23-per-object-visualization-control.md`;
- `docs/specs/frontend-v2/24-geometry-object-authoring-lifecycle.md`;
- `docs/specs/resource-first-control-room-api-v2.md`.

Stosowane klasy dowodu:

- **R — reprodukcja runtime:** błąd został odtworzony w skrypcie browser/screenshot;
- **T — test utrwala błąd:** istniejący test jawnie oczekuje zachowania sprzecznego
  ze specyfikacją;
- **S — dowód statyczny:** przepływ wartości i brak cleanup/validation są
  jednoznaczne w kodzie;
- **G — luka w bramce:** gate nie mierzy deklarowanej właściwości;
- **M — wymaga pomiaru:** kod wskazuje realne ryzyko, ale wielkość efektu musi
  zostać zmierzona w prawdziwym WebGL/browser lifecycle.

Raport nie traktuje automatycznych ostrzeżeń jako findings bez ręcznego
potwierdzenia. W szczególności odrzucono fałszywe alarmy React Doctor dotyczące
cleanupów zwracanych przez `EventBus.on` i subskrypcji `useSyncExternalStore`.

## Obszary potwierdzone jako poprawne

- Tylko aktywny ciężki viewport jest montowany; nie znaleziono drugiego Canvas 3D.
- Canvas korzysta z `frameloop="demand"`; nie znaleziono bezwarunkowego idle loop.
- Browser smoke potwierdził widoczny, niepusty canvas, nieutracony kontekst WebGL
  i dodatnie wymiary drawing buffer.
- FEM ma rozdzielone passy surface/wireframe/points/vectors.
- Pełny airbox wireframe zawiera proceduralny interior bounds/volume overlay,
  zachowuje hidden-edge semantics i nie dziedziczy opacity powierzchni.
- Region field carrier używa manifestowego `mesh_part_ids`; membership/projection
  pozostaje diagnostycznym fallbackiem.
- Komponenty nie wykonują bezpośredniego `fetch()`; używają typed facade i hooks.
- HTTP OpenAPI v2 wygenerowane w repo jest zgodne z aktualnym generatorem
  backendu. Ten dowód nie obejmuje ręcznie utrzymywanego WS/AsyncAPI ani parsera
  eventów; ich drift jest częścią `F3D-003`.
- HTTP pozostaje źródłem snapshotów/PATCH, a websocket przenosi invalidation.
- ETag/304, bounded resource caches i warm quantity switching są obecne.
- Typecheck, lint, pełny Vitest i build produkcyjny zakończyły się powodzeniem.

## Ograniczenia audytu

1. Nie było aktywnej sesji solvera z pełnym zestawem rzeczywistych FDM/FEM pól;
   browser smoke używał wspieranego trybu bez sesji i fixture API.
2. Wbudowany `audit:viewport-3d-memory-churn` wymaga dev-only browser hook. Hook
   nie jest instalowany w produkcyjnym buildzie, dlatego nie dostarczył miarodajnego
   pomiaru produkcyjnego.
3. Sterowanie Chrome przez plugin nie zostało użyte: inicjalizacja pluginu w tej
   sesji odrzuciła ścieżkę WSL jako nie-lokalny `file:` URI. Zamiast tego użyto
   repozytoryjnych skryptów Playwright/browser smoke.
4. Findings oznaczone klasą **M** są wiarygodnymi lukami ownership/performance,
   ale przed ustaleniem budżetu naprawy wymagają pomiaru WebGL buffers/bytes na
   reprezentatywnej scenie.
5. Katalog zawiera raport i dokładne polecenia głównych bramek, ale nie archiwizuje
   pełnego stdout, wersji Chromium, screenshots ani JSON metrics z każdego
   przebiegu. Wyniki bez artefaktu są oznaczone jako obserwacje audytu, nie
   samodzielny evidence bundle.

## Warunek uznania audytu za zamknięty

Nie wystarczy, że TypeScript i testy jednostkowe są zielone. Zamknięcie wymaga:

1. usunięcia wszystkich P0 i P1;
2. odwrócenia testów, które dziś utrwalają niepoprawny kontrakt;
3. browser smoke dla przejść `current -> stale -> rebuilt` oraz
   `object -> region -> airbox`;
4. wizualnego rozróżnienia wszystkich trybów projekcji;
5. jednego canonical target resolvera używanego przez viewport, Ribbon i Inspector;
6. produkcyjnego memory/lifecycle gate z realnym mountem R3F/WebGL;
7. braku nieskończonych retry i widocznego statusu PATCH;
8. ponownego uruchomienia pełnych bramek z wynikami zapisanymi obok raportu.
