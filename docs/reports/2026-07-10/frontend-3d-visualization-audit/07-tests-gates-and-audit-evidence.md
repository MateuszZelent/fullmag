# 07. Testy, bramki i materiał dowodowy

## F3D-026 — zielone idle/memory testy nie montują realnego lifecycle renderera

**Priorytet:** P2 — średni
**Dowód:** G
**Kontrakt:** gate wydajności i pamięci ma mierzyć zachowanie realnego
React/R3F/WebGL/browser lifecycle, nie tylko obecność wzorców w źródle.

### Dowód i mechanizm

- `apps/control-room/scripts/audit-idle-performance.mjs:1-120` jest skanerem
  tekstowym. Sprawdza `frameloop="demand"`, liczbę wystąpień
  `requestAnimationFrame`, brak `setInterval` i kilka nazw symboli.
- Nie uruchamia aplikacji, nie liczy faktycznych klatek i nie wykryje pętli
  wywołującej `invalidate()` z eventu/effectu.
- `apps/control-room/src/modules/viewport-3d/viewport-memory-stress.test.ts:69-115`
  nazwany "repeated mount cycles" nie montuje React, R3F, WebGL ani workerów.
  Tworzy sztuczne rekordy `Viewport3DResourceTracker` i wywołuje `disposeAll`.

### Wpływ

Ciągły redraw, leak GPU buffer, pozostający worker albo listener może współistnieć
z zielonymi obecnymi gate'ami. Te testy są użyteczne jako hygiene/unit checks, ale
nie dowodzą properties deklarowanych przez ich nazwy.

### Plan naprawy

1. Zachować obecny skan jako `check:viewport-3d-idle-source-hygiene`.
2. Dodać browser idle gate z realnym Canvas:
   - ustabilizowanie sceny;
   - stałe okno 5-10 s;
   - dokładnie 0 nowych dirty frames, draw calls i resource requests po settle.
3. Dodać realny stress 3D <-> 2D, quantity, projection, region i style, mierzący
   workery, timery, subscriptions, WebGL buffers/textures/programs oraz heap.
4. Porównać baseline, peak i after-unmount; ustalić tolerancję plateau, nie
   absolutne zero dla cache współdzielonych.
5. Uruchamiać gate w CI na wspieranym Chromium/software WebGL oraz okresowo na
   hardware GPU.

### Kryterium akceptacji

- Gate celowo wykrywa kontrolowany `invalidate` loop, worker leak i GPU buffer
  leak w testowych mutacjach.
- Po settle idle ma dokładnie 0 nowych klatek/draw calls/requestów. Heap/cache po
  stress wracają do udokumentowanego plateau/tolerancji.
- Unit/source hygiene i browser runtime są raportowane osobno.

## F3D-027 — canonical API hygiene gates mają fałszywe trafienia

**Priorytet:** P2 — średni
**Dowód:** R + S
**Kontrakt:** strict resource-first gate musi być zielony na poprawnym kodzie i
precyzyjnie blokować direct fetch/legacy endpointy.

### Dowód i mechanizm

- `pnpm --dir apps/control-room check:api-hygiene` kończy się błędem, ponieważ
  regex `preview[-/]` w
  `apps/control-room/scripts/check-api-hygiene.mjs:30-39` dopasowuje poprawne
  nazwy klas `*-data-preview-*`.
- `./scripts/ci-resource-first-gates.sh --strict` kończy się błędem, ponieważ
  regex `fetch\s*\(` w `scripts/ci-resource-first-gates.sh:192-198` dopasowuje
  `refetch()` i `noopRefetch()`.
- Ręczne wyszukiwanie dokładnego `\bfetch\s*\(` poza dozwoloną warstwą API nie
  wykazało bezpośrednich component fetches w audytowanej ścieżce.

### Wpływ

Bramki są stale czerwone na canonical code, więc tracą wartość blokującą i
zachęcają do ignorowania przyszłych prawdziwych naruszeń.

### Plan naprawy

1. Dla fetch użyć granicy identyfikatora/AST-aware scan, który rozróżnia
   `fetch(` od `refetch(`.
2. Dla legacy preview dopasowywać endpoint/path/import semantics, nie dowolny
   fragment nazwy CSS.
3. Dodać fixture tests skryptów:
   - positive: direct fetch, legacy preview endpoint/import;
   - negative: refetch, noopRefetch, data-preview CSS.
4. Ustawić oba gates jako wymagane dopiero po zielonym baseline.

### Kryterium akceptacji

- Oba polecenia są zielone na obecnym canonical code.
- Wstrzyknięty direct component `fetch()` oraz legacy path są wykrywane.
- False-positive fixtures pozostają zielone.

## F3D-028 — brakuje production-like trybu dla browser memory churn gate

**Priorytet:** P2 — średni
**Dowód:** G
**Kontrakt:** gate deklarowany jako weryfikacja pamięci musi mieć udokumentowany,
powtarzalny tryb uruchomienia odpowiadający produkcyjnemu lifecycle.

### Dowód i mechanizm

- `pnpm --dir apps/control-room build:webpack` zakończył się poprawnie.
- Uruchomienie `pnpm --dir apps/control-room audit:viewport-3d-memory-churn`
  przeciwko produkcyjnemu serwerowi zakończyło się:

```text
Fullmag browser audit hook is not installed.
```

- Warunek znajduje się w
  `apps/control-room/scripts/audit-viewport-3d-memory-churn.mjs:324`.
- Brak hooka w zwykłej produkcji jest intencjonalny
  (`KernelProvider.tsx:324+`), więc nie jest awarią produkcyjnego buildu. Problemem
  jest brak dedykowanego production-like audit mode. Próba dev została przerwana
  przez HMR/koordynację wspólnego serwera i nie jest traktowana jako błąd produktu.

### Plan naprawy

1. Udostępnić bezpieczny audit driver w dedykowanym `NEXT_PUBLIC_AUDIT_BUILD=1`,
   nie w zwykłej produkcji.
2. Zbudować osobny production-like audit artifact z tym flagem i bez HMR.
3. Wybrać jedną spójną ścieżkę sterowania:
   - preferowana: zmieniać quantity przez normalne UI, a hook zostawić read-only;
   - alternatywa: mutujący test-driver wyłącznie w dedykowanym buildzie z
     przechwyconym fixture API. Obecny skrypt wywołuje `setGlobalQuantity()`, więc
     nie można równocześnie deklarować w pełni read-only hooka.
4. Skrypt powinien sam uruchamiać/posiadać serwer albo jednoznacznie wymagać URL;
   nie może zakładać współdzielonego dev servera.
5. Zapisać JSON baseline/after i screenshots/diagnostics w artefaktach CI.

### Kryterium akceptacji

- Gate uruchamia się w powtarzalnym production-like buildzie bez ręcznej HMR.
- Weryfikuje mount/unmount, workery, WebGL, cache i subscriptions.
- Zwykły production build nie eksponuje audit hooka.

## Wyniki wykonanych poleceń

| Polecenie | Wynik | Interpretacja |
|---|---|---|
| `pnpm --dir apps/control-room typecheck` | pass | brak błędów TypeScript |
| `pnpm --dir apps/control-room lint` | pass, 0 warnings | lint baseline czysty |
| pełny `pnpm --dir apps/control-room test` | pass: 305 plików, 2738 testów | szeroka regresja zielona; część testów utrwala błędne semantyki |
| równoległe targetowane testy renderer/state | pass: obserwowane przebiegi 340 i 244 testów | pomocnicze; dokładny argv/stdout nie został zarchiwizowany |
| `pnpm --dir apps/control-room build:webpack` | pass | produkcyjny build poprawny |
| `pnpm --dir apps/control-room audit:idle-performance` | pass | tylko source hygiene, patrz `F3D-026` |
| `CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 pnpm --dir apps/control-room smoke:viewport-3d` | pass po warm-up | canvas widoczny i niepusty, context current, drawing buffer > 0 |
| `pnpm --dir apps/control-room screenshot:viewport-3d` | fail dwukrotnie | projection modes identyczne na niekanonicznym fixture; gate wymaga naprawy, `F3D-005` |
| `pnpm --dir apps/control-room audit:viewport-3d-memory-churn` przeciw ordinary production | brak hooka zgodnie z config | ujawnia brak osobnego production-like audit mode, `F3D-028` |
| `pnpm --dir apps/control-room check:api-hygiene` | fail | false positive `data-preview`, `F3D-027` |
| `./scripts/ci-resource-first-gates.sh --strict` | fail | false positive `refetch/noopRefetch`, `F3D-027` |
| HTTP OpenAPI generator compare | pass w audycie równoległym | obserwacja niearchiwizowana; nie obejmuje WS/AsyncAPI |

Pierwsza próba no-session smoke przekroczyła 15 s podczas cold compile. Po
rozgrzaniu tego samego serwera smoke przeszedł. Nie klasyfikowano cold compile
timeout jako defekt renderera.

Katalog raportu nie jest pełnym evidence bundle: nie zawiera surowych logów,
JSON metrics, wersji Chromium ani screenshots z każdego przebiegu. Świeże,
odtwarzalne polecenia główne to typecheck, lint, pełny Vitest i build podane w
tabeli. Wyniki targetowanych przebiegów, HTTP OpenAPI compare i browser smoke są
obserwacjami tej sesji; przed merge napraw powinny zostać ponownie uruchomione z
artefaktami CI. Nie wykonano backendowego testu WS/AsyncAPI ani end-to-end eventu
zmieniającego tylko `domain_generation_id`; ta luka jest częścią `F3D-003`.

## Browser smoke — co zostało realnie potwierdzone

- camera gestures i projection round-trip skryptu;
- widoczny canvas;
- obraz różny od jednolitego tła;
- `gl.isContextLost() === false`;
- dodatnie wymiary drawing buffer;
- brak stałego `THREE.WebGLRenderer: Context Lost` w zaliczonym przebiegu;
- region overlay selection/mode przeszedł przed błędem projection fixture.

## React Doctor — sposób użycia wyniku

`react-doctor` zwrócił wynik 61/100 i 247 automatycznych sygnałów. Narzędzie
zostało uruchomione na zgodnym zastępczym Node, ponieważ lokalny Node 22.8 był
oznaczony jako niewspierany. Wynik nie jest traktowany jako 247 potwierdzonych
błędów.

Po ręcznej weryfikacji do raportu weszły tylko sygnały mające jednoznaczny dowód:

- brak accessibility state dla toggle/segmented controls (`F3D-017`);
- powtarzane liniowe wyszukiwanie regionów (`F3D-025`);
- potrzeba realnej, a nie syntetycznej bramki lifecycle (`F3D-026`).

Odrzucono między innymi fałszywe ostrzeżenia o cleanupach tam, gdzie API
`EventBus.on` i subscribe faktycznie zwracają poprawną funkcję unsubscribe.

## Inne wyniki horyzontalne

`check:architecture-hygiene` zgłosił surowe kolory w
`FrequencyDomainResultInspectors.tsx`. To leży poza szczególnym przepływem
3D/visualization target audit i nie zostało dopisane jako finding bez pełnego
przeglądu tego modułu. Pozostaje jednak czerwonym wynikiem globalnej bramki, który
powinien zostać obsłużony przez właściciela modułu frequency-domain.
