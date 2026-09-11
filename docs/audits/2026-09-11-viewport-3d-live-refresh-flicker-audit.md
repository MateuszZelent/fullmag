# Audyt: migotanie wizualizacji 3D przy synchronizacji danych z backendem

**Data:** 2026-09-11
**Zakres:** `apps/control-room` — ścieżka live-refresh viewportu 3D: WebSocket → inwalidacja zasobów → HTTP/FMVP → dekodowanie → build off-main-thread → upload GPU → render R3F. Dodatkowo strona serwera (`crates/fullmag-api`) w części dotyczącej publikacji zmian i formatu payloadu pól.
**Powód:** aktywna symulacja — co ~2 s następuje aktualizacja danych, przy której shadery obiektów i nakładka pola demagnetyzującego chwilowo znikają / wracają do stanu początkowego. Efekt: widoczne „mruganie" całej animacji.
**Werdykt w skrócie:** architektura jest dobra i w dużej mierze już utwardzona przeciw temu problemowi (retencja ostatniego dobrego bufora, atomiczny swap geometrii, materiały niezależne od rewizji danych, `frameloop="demand"`). Migotanie **nie wynika z braku architektury, tylko z pięciu konkretnych, punktowych luk w tej architekturze** — trzech w warstwie renderu i dwóch w warstwie zasobów. Transport jest binarny i sensownie zaprojektowany, ale ma dwa tanie, duże rezerwy: **wartości są przesyłane jako `float64` bez żadnej kompresji**.

---

## 1. Streszczenie wykonawcze

### 1.1. Co faktycznie powoduje migotanie

Uszeregowane wg pewności i wpływu:

| ID | Przyczyna | Warstwa | Pewność | Wpływ |
|---|---|---|---:|---:|
| **VPF-001** | „Staged reveal" (`useViewport3DModelLayerStage`) **synchronicznie zeruje etap do 0 w trakcie renderu**, co odmontowuje `FdmCuboidLayer` i zeruje `fieldVector`/`surfaceColors`/`vectorSegments` we wszystkich widokach FDM na ~3 klatki. Klucz resetu zawiera warunki `fdmTargetViews.length > 0` i `fdmNativeLayerViews.length > 0`, więc **każde chwilowe opróżnienie kolekcji widoków wywala całą geometrię i pole na twardo, bez żadnego przejścia**. | render | wysoka | krytyczny |
| **VPF-002** | `publish(null, geometry, null)` w uploadzie kolorów: gdy retencja nie przejdzie (4 miejsca), hook natychmiast zwraca `buffer: null`. Konsument (materiał) gasi wtedy `vertexColors`/shader i powierzchnia wraca do płaskiego koloru — **mimo że dane w atrybucie GPU są nadal poprawne**. | render | wysoka | duży |
| **VPF-003** | Koordynator uploadu GPU **nie ma rotacji hostów** — `runFrame()` zawsze startuje od `activeHosts[0]` przy wspólnym budżecie 3 ms/klatkę. Host zarejestrowany wcześniej (np. duży rebuild geometrii/glifów) może w nieskończoność zagładzać host uploadu kolorów. Ticket, który nie zdąży przed kolejną rewizją, jest **abortowany bez rollbacku** (rollback tylko dla `status === "failed"`). | render | wysoka | duży |
| **VPF-004** | Inwalidacja per-quantity jest w praktyce inwalidacją całego poddrzewa `/(…)/data/fields/{quantity}/`: jedno zdarzenie WS unieważnia **próbki wektorowe wszystkich części, `meta` i `availability`** dla danej wielkości. Dodatkowo każdy udany fetch wektora **sam z siebie** unieważnia `…/meta` (kolorbar) poza oknem koalescencji rAF — czyli N części = N dodatkowych, niezbatchowanych renderów i N dodatkowych GET-ów na tick. | zasoby | wysoka | średni (amplifikuje 001–003) |
| **VPF-005** | `FallbackTopologyMeshLayer` tworzy **nowy `THREE.ShaderMaterial` przy każdej rewizji** (bufor kolorów w tablicy zależności `useMemo`) i nie przekazuje `retentionKey`. To dokładnie ten antywzorzec, przeciw któremu utwardzono `MeshPartLayer` (komentarze „S-08"). **Uwaga: w obecnym drzewie ten komponent nie jest nigdzie renderowany** — to martwy kod, ale i gotowa pułapka przy ponownym włączeniu. | render | wysoka (kod) / n.d. (runtime) | latentny |

### 1.2. Czego **nie** potwierdzono (ważne, żeby nie naprawiać czegoś, co działa)

- **To nie jest bug „keyed remount"**. Żaden `key=` w ścieżce renderu nie zawiera rewizji, generacji ani identyfikatora bufora (`key={view.target.id}`, `key={canvasContextKey}`, stałe stringi dla kamer).
- **Canvas R3F nie jest przemontowywany ani rekonfigurowany.** `gl` jest jednym z 4 zamrożonych obiektów modułowych (komentarz „S-15"), `frameloop` jest stałą modułową, `canvasContextKey` zależy tylko od profilu wizualnego.
- **Warstwa cache nie kasuje danych przy refetchu.** `markResourceLoading()` zachowuje `data` i ustawia status `stale`, a `markResourceError()` też nie czyści `data`. Scene model dodatkowo składa `stale → ready`, gdy dane są obecne, i trzyma `displayedFieldVector`/`committedFieldVector`.
- **`MeshPartLayer`, `FdmCuboidLayer`, `VectorFieldLayer` nie odtwarzają materiałów per rewizja.** Materiały są memoizowane po „variant key" (kształt programu GL), dane wchodzą przez `updateScalarSurfaceShaderMaterial` mutujące uniformy, a `needsUpdate` leci tylko przy realnej zmianie źródła shadera.
- **Geometria FDM ma poprawną retencję.** `topologyKey` (`fdm-grid:…|generation=…|shape=…|membership=…|topology=…`) **nie zawiera rewizji pola**, więc `retainLastGood` trzyma poprzedni model w czasie przebudowy; `buildKey` zawiera rewizję pola i wymusza rebuild — to jest właściwy podział.
- **To nie jest polling.** Patrz §3.

### 1.3. Transport danych — odpowiedź na pytanie „czy to nie powinno być binarne"

**Już jest binarne.** Format `FMVP` (magic `"FMVP"`, 48-bajtowy nagłówek LE, opcjonalny blok metadanych `FMMI` w v3), dekodowany w dedykowanym Web Workerze z zero-copy transferem `ArrayBuffer`. WebSocket przenosi wyłącznie małe powiadomienia JSON, żadnych danych masowych. To jest dobrze zrobione.

Rezerwy są gdzie indziej:

| ID | Problem | Szacowany zysk |
|---|---|---|
| **VPD-001** | Wartości są **wyłącznie `float64`** — dekoder wprost rzuca wyjątek dla innego `kind`. Wizualizacja nie potrzebuje podwójnej precyzji (`crossSectionCodec` już używa `Float32Array`). | **−50 % bajtów** |
| **VPD-002** | **Zero kompresji** — brak `CompressionLayer`/gzip/brotli/zstd w `fullmag-api`, brak obsługi `Content-Encoding`. Pola magnetyzacji są gładkie i kompresują się typowo 2–4×. | **−50…−75 % bajtów**, zmiana konfiguracyjna |
| **VPD-003** | `max_samples` jest opcjonalne; ścieżki FDM/airbox przekazują budżet, ale przy jego braku serwer wysyła **pełne pole** co tick. | zależne od sceny |
| **VPD-004** | Brak delty między rewizjami — co 2 s leci całe pole, choć między krokami solvera zmienia się niewielka część. | rząd wielkości dla wolno zmiennych pól |
| **VPD-005** | Jeden współdzielony worker dekodujący dla wszystkich rodzajów payloadu; awaria konstruktora wyłącza dekodowanie off-thread **na całą sesję** (zapamiętane `null`). | stabilność klatek |

Szacunek (nie pomiar): siatka 128×128×4, 3 komponenty → `65 536 × 3 × 8 B ≈ 1,5 MB` na aktualizację, czyli ~0,8 MB/s przy 2 s. Siatka 10⁶ komórek → `≈ 23 MB` (a z `Uint32` indeksami węzłów ≈ 27 MB), czyli **11–14 MB/s nieskompresowanego f64 dla jednej wielkości**. Samo VPD-001 + VPD-002 sprowadza to do ~3–6 MB/s bez żadnej zmiany kontraktu semantycznego.

---

## 2. Zakres, metodyka i ograniczenia dowodowe

**Metodyka:** statyczna analiza kodu źródłowego — frontend (`apps/control-room/src`: `kernel/{api,realtime,resources,visualization}`, `modules/viewport-3d/**`) oraz backend (`crates/fullmag-api`: `main.rs`, `field_store.rs`, `router_v2/handlers/data/fields.rs`, `schemas/realtime.rs`). Uzupełniono syntezą wcześniejszych dokumentów wewnętrznych, w szczególności `docs/audits/2026-08-27-control-room-field-data-instability-diagnostic.md` i `docs/audits/2026-09-03-control-room-frontend-full-audit-and-refactor-plan.md`.

**Ograniczenia — należy je czytać razem z wnioskami:**

1. **Brak pomiaru runtime.** Nie było działającego backendu ani sesji przeglądarkowej. Wszystkie wnioski są kontraktowe/kodowe; kolejność i częstość faktycznego wystąpienia VPF-001…003 wymaga potwierdzenia profilerem (§8).
2. **Baza dowodowa to stan roboczy gałęzi `fix/viewport-3d-audit-s18-s19-upload-20260910`** (pliki z 8–11 września) nałożony na ostatni snapshot osiągalny z packfile'i (`f565821`, 2026-09-02). Wierzchołek `master` był w tym momencie luźnym obiektem git, niedostępnym dla użytej ścieżki odczytu — **raport odnosi się więc do drzewa roboczego, nie dosłownie do `master`**. Różnice w plikach dotkniętych bieżącą naprawą S-18/S-19 mogą istnieć.
3. Pliki `modules/viewport-3d/build-engine/{gpu,cache,workerPool}/**` udało się odczytać wyłącznie w wersji z 2026-09-02 (limit głębokości ścieżki przy transferze). Jeżeli `viewport3dGpuUploadManager.ts` zmieniono po tej dacie, ustalenie VPF-003 należy zweryfikować ponownie.
4. Repozytorium jest w trakcie aktywnej naprawy tego samego obszaru (nazwy gałęzi: `viewport-3d-audit-s16-postprocessing`, `…-s18-s19-upload`). Część ustaleń może pokrywać się z pracą w toku.

**Stos:** Next 16.2.11, React 19.2.4, `@react-three/fiber` 9.5.0, `three` 0.183.2, `frameloop="demand"`, `reactStrictMode: false` (globalnie, z powodu WebGL w viewporcie).

---

## 3. Jak to faktycznie działa — i sprostowanie w sprawie „2 sekund"

### 3.1. Pipeline live-refresh

```
[solver] → [CLI live publisher] → [fullmag-api]
     │
     ├─ WebSocket "fullmag.live.v1"  ── JSON, tylko powiadomienia ──────────┐
     │     resource.batch_changed { resource, revision, quantity_ids,       │
     │                              broad, domain_generation_id }           │
     │                                                                      ▼
     │                                            RealtimeInvalidationBridge
     │                                            (koalescencja w 1× rAF)
     │                                                      │
     │                                                      ▼
     │                                            ResourceInvalidationController
     │                                            → ResourceRuntimeStore.ensureLoad()
     │                                              (dedup / abort / sequence guard)
     │                                                      │
     └─ HTTP GET /v2/sessions/current/data/fields/{q}/samples/vector ◄──────┘
            200 application/octet-stream  → FMVP (48 B header + f64 AoS)
            202 application/json          → pending (retry_after_ms)
            204 / 304                     → brak treści
                       │
                       ▼
        binaryDecodeScheduler → Web Worker (zero-copy transfer)
                       │
                       ▼
        buildViewport3DTargetFieldBuffer  →  color/glyph/cuboid build
        (viewport3dBuildScheduler, lane concurrency, latestWins, worker)
                       │
                       ▼
        useViewport3DScalarColorUpload / GpuUploadManager
        (chunki po 8192 wierzchołków, budżet 3 ms/klatkę,
         needsUpdate dopiero w onVisible = pseudo-atomowość)
                       │
                       ▼
        R3F invalidate() → jedna klatka on-demand
```

### 3.2. „Następna synchronizacja za 2 s" — to nie jest polling

Wskaźnik w UI (`viewport3dRefreshCountdown.ts`) **nie odlicza do zaplanowanego żądania**. Liczy on *obserwowany* odstęp między rewizjami i wygładza go filtrem `0,35 × poprzedni + 0,65 × zaobserwowany`, z klamrą 200–5000 ms. Prawdziwe 2 s pochodzi z serwerowej polityki QoS `field_sample_publish_ms: 2_000` (`crates/fullmag-api/src/schemas/realtime.rs:128`), przekazywanej do klienta w komunikacie `hello` i używanej po stronie klienta wyłącznie jako `minRefetchIntervalMs` (dolna granica odstępu po inwalidacji) — nie jako interwał `setInterval`.

**Konsekwencja dla naprawy:** „wydłużenie interwału" nic nie da jakościowo — schowa objaw i pogorszy płynność animacji. Problemem jest to, *co* dzieje się w jednym cyklu, a nie *jak często* cykle następują. Docelowo dobrze zrobiony cykl powinien pozwolić **skrócić** okno (np. do 500–1000 ms), a nie wydłużyć.

Wskaźnik ma jednak własny, drobny wkład w wrażenie „mrugania": `VIEWPORT_3D_REFRESH_FLASH_MS = 650` wymusza stan `updated` przez 650 ms po każdej rewizji, a stany `loading`/`stale` przełączają go na `syncing`. Przy cyklu 2 s HUD zmienia stan 2–3 razy na cykl. To kosmetyka, ale zsynchronizowana z migotaniem sceny wzmacnia jego percepcję.

---

## 4. Findings — warstwa renderu

### VPF-001 — „Staged reveal" odmontowuje geometrię i zeruje pole na twardo

**Priorytet: P0. Status: CONFIRMED (statycznie).**

`layers/Viewport3DScene.tsx`:

```ts
// resolveViewport3DModelLayerStageKey(...)
return [
  topologyModel?.meshGenerationId ?? "no-mesh-generation",
  topologyModel?.meshRevision ?? "no-mesh-revision",
  topologyModel?.nodeCount ?? 0,
  topologyModel?.magneticParts.length ?? 0,
  topologyModel?.airboxParts.length ?? 0,
  primitiveModel?.sceneRevision ?? "no-scene-revision",
  primitiveModel?.objects.length ?? 0,
  fdmNativeLayerViews.length > 0 ? "fdm-native-ready" : "fdm-native-empty",
  fdmTargetViews.length > 0 ? "fdm-ready" : "fdm-empty",
].join(":");

// useViewport3DModelLayerStage(...)
const stage = stageState.resetKey === resetKey ? stageState.stage : 0;   // ← reset w RENDERZE
```

Etapy (`resolveViewport3DModelLayerStageVisibility`): `stage ≥ 1` → `baseGeometry`, `stage ≥ 2` → `fieldDrivenLayers`, `stage ≥ 3` → reszta. Powrót do 3 zajmuje **trzy `requestAnimationFrame`**, a na każdym kroku wołane jest `invalidate()`, więc każdy pośredni (wygaszony) stan **jest faktycznie malowany**.

Skutki w tym samym commicie renderu:

```ts
const stagedFieldModel = stageVisibility.fieldDrivenLayers ? fieldModel : null;
const stagedFdmTargetViews = stageVisibility.fieldDrivenLayers
  ? fdmTargetViews
  : fdmTargetViews.map((view) => ({ ...view,
      fieldVector: null, surfaceColors: null,
      vectorColors: null, vectorGlyphColors: null, vectorSegments: null }));
...
{stageVisibility.baseGeometry && fdmCuboidLayerEnabled ? ( <> …<FdmCuboidLayer …/>… </> ) : null}
```

To jest dosłowny opis objawu zgłoszonego przez użytkownika: **shader znika, pole demag znika, wraca „od zera"**.

Dwa niezależne wektory wyzwalania:

1. **Fragilny klucz.** Warunki `…length > 0 ? "ready" : "empty"` opierają się na kolekcjach przeliczanych co render z długiego łańcucha zależności (`fdmMultilayerLayout.data`, `fdmTargetViewsResult.status`, mapy ustawień per-target, mapy wyników buildów). Jednorazowe, przejściowe „pusto" w dowolnym ogniwie — np. `204 not-applicable` opisane w audycie z 2026-08-27, chwilowa rotacja katalogu pól, miss w mapie — **wywala pełny teardown geometrii, choć siatka się nie zmieniła**.
2. **Churn zależności.** `useMemo` klucza zależy od referencji `fdmNativeLayerViews`/`fdmTargetViews`/`topologyModel`/`primitiveModel`, a te są nowymi obiektami praktycznie co tick (ich własne `useMemo` zależą od `fieldVector`). Klucz jest więc przeliczany co 2 s; jedyną ochroną jest to, że wynikowy string *zwykle* wychodzi identyczny. To nie jest gwarancja, tylko szczęście.

Dodatkowo: hook `useViewport3DSceneModel` zwraca **niememoizowany literał obiektowy ~90 pól**, rozlewany jako `<Viewport3DScene {...sceneProps}>` — nie ma taniego „bezpiecznika: nic się nie zmieniło" na szczycie drzewa. Zespół zastosował już tę dyscyplinę dla `canvasGlOptions`/`canvasCamera` (komentarz „S-15"), ale nie dla staged-reveal.

**Rekomendacja:**

1. Rozdzielić dwa pojęcia: **„nowa topologia" (uzasadnia staged reveal) vs „nowe wartości pola" (nie uzasadnia)**. Z klucza resetu usunąć flagi `…length > 0`; zostawić wyłącznie tożsamość topologii/sceny (`meshGenerationId`, `meshRevision`, `sceneRevision`, `nodeCount`).
2. Reset etapu przenieść z ciała renderu do efektu z **histerezą**: kolekcja pusta przez ≥ N klatek (albo ≥ 150 ms) dopiero wtedy degraduje etap. Chwilowe „pusto" nie może odmontowywać warstw.
3. Zamiast twardego `: null` dla `fieldVector`/`surfaceColors` — **trzymać ostatni dobry bufor** (ten sam wzorzec, co `retainLastGood` w `FdmCuboidLayer`).
4. Jeżeli wygaszenie jest naprawdę potrzebne (np. realna zmiana siatki), zrobić je **przez `opacity` z krótkim cross-fade**, a nie przez odmontowanie poddrzewa.

**Kryterium akceptacji:** w 60-sekundowym przebiegu aktywnego solvera licznik `model-layer-stage-reset` (już istnieje w `tracker.recordDirtyFrame`) wynosi **0** poza zdarzeniami zmiany siatki.

---

### VPF-002 — `publish(null)` gasi kolory, mimo że dane na GPU są poprawne

**Priorytet: P0. Status: CONFIRMED (statycznie).**

`hooks/useViewport3DScalarColorUpload.ts`:

```ts
export function canRetainViewport3DScalarUploadBuffer({ … }): boolean {
  return Boolean(
    allowRetention &&
      requestedRetentionKey &&      // ← brak klucza = brak retencji
      buffer &&
      geometry === requestedGeometry &&
      retentionKey === requestedRetentionKey,
  );
}
```

Cztery miejsca resetu: linie **219**, **243**, **406**, **440** — wszystkie `store.publish(null, geometry, null)`, każde natychmiast po nim `tracker.recordDirtyFrame(...)` + `invalidate()`, czyli wymuszają odmalowanie stanu „bez kolorów".

Istotny niuans: `viewport3dGeometryColors.ts` (zmieniony 2026-09-11) **celowo nie zeruje atrybutu GPU** przy `colorBuffer === null` — komentarz wprost opisuje wcześniejszy błąd „flash to black". Ochrona ta jest jednak **omijana**, ponieważ konsument (materiał w `MeshPartLayer`) bramkuje próbkowanie kolorów na **zwracanej wartości hooka**, a nie na stanie atrybutu geometrii. Dane są dobre, a i tak nie są próbkowane.

**Rekomendacja:**

1. Rozdzielić w publikowanym snapshocie dwa stany: `buffer: null` (naprawdę nie ma czego pokazać) i `buffer: <ostatni dobry>, fresh: false` (jest stary, ważny bufor). Materiał gasi `vertexColors` tylko w pierwszym przypadku.
2. Zezwolić na retencję **domyślnie** (`allowRetention` + fallbackowy `retentionKey` wyprowadzony z `geometry` + `vertexCount`), zamiast wymagać jawnego klucza od każdego wywołującego. Dziś brak klucza cicho wyłącza cały mechanizm — to pułapka, w którą już wpadł `FallbackTopologyMeshLayer` (VPF-005).
3. Dodać test regresyjny: „sekwencja rewizji z jedną przerwą w dostępności bufora nie zmienia `material.vertexColors` na `false`".

---

### VPF-003 — brak rotacji w koordynatorze uploadu GPU + abort bez rollbacku

**Priorytet: P1. Status: CONFIRMED (statycznie, na snapshocie 2026-09-02).**

`build-engine/gpu/viewport3dGpuUploadManager.ts`:

```ts
function runFrame(): void {
  …
  let hostIndex = 0;                       // ← ZAWSZE od zera, brak rotacji
  while (hostIndex < activeHosts.length) {
    const frameElapsedMs = Math.max(0, host.now() - frameStartMs);
    if (frameElapsedMs >= targetFrameBudgetMs || frameElapsedMs >= maxFrameBudgetMs) break;
    host.runFrame(frameStartMs, targetFrameBudgetMs, maxFrameBudgetMs);
    …
  }
}
```

Budżet jest współdzielony i wyznaczany jako **minimum** po wszystkich hostach (`minActiveBudget`) — domyślnie `targetFrameBudgetMs: 3`, `maxFrameBudgetMs: 5`. Hosty rejestrują się per mesh-part, per warstwa (kolory skalarne, kolory shaderowe, geometria, glify wektorowe, cuboidy FDM), więc przy scenie z kilkoma częściami ich liczba to kilkanaście. Host z indeksem 0, który stale ma chunki do wysłania, **konsumuje cały budżet co klatkę**, a hosty dalsze nigdy nie dostają czasu.

Druga połowa problemu — `settleTicket`:

```ts
if (status === "failed") { rollbackTicket(ticket); }   // rollback TYLKO dla failed
```

Abort (`settleTicket(ticket, "aborted")`) rollbacku **nie robi**. A abort jest wołany bezwarunkowo przy każdym przebiegu efektu uploadu (nowa rewizja = nowe zależności), czyli co ~2 s. Ticket zagłodzony przez VPF-003 zostaje więc anulowany z częściowo zapisanymi chunkami w **żywej, współdzielonej tablicy `Float32Array`**, bez `needsUpdate` (więc GPU jeszcze tego nie widzi) i bez cofnięcia. Kolejny ticket startuje od zera i jest narażony dokładnie tak samo.

Efekt netto: okno „nowe dane jeszcze nie widoczne" rozciąga się z ~1 klatki do wielu klatek, cyklicznie, co przy VPF-002 daje widoczne gaszenie kolorów.

**Rekomendacja:**

1. **Rotacja round-robin** (`startIndex` przesuwany między klatkami) albo kolejka priorytetowa z wiekowaniem ticketów. Host czekający N klatek dostaje priorytet.
2. **Rollback także dla `aborted`** — albo, lepiej, prawdziwy back-buffer dla kolorów (patrz punkt 3).
3. **Zastosować dla kolorów wzorzec, który już działa dla geometrii.** `useViewport3DGeometryUpload` robi poprawny atomowy swap: buduje nowy obiekt obok, publikuje dopiero po ukończeniu, a przy błędzie przywraca `previousGeometry`. Kolory nie mają odpowiednika i dlatego są jedyną warstwą podatną na „pół-stan".
4. Dodać do diagnostyki metrykę: **rozkład liczby klatek od `revision arrived` do `onVisible`** per host. To jest liczba, którą trzeba trzymać przy 1–2.

---

### VPF-004 — amplifikacja inwalidacji i niezbatchowany kaskadowy refetch `meta`

**Priorytet: P1. Status: CONFIRMED (statycznie).**

Strona serwera jest poprawna: `crates/fullmag-api/src/main.rs` ustawia dla zmian próbek pola `broad: false` i konkretną listę `quantity_ids`, a `broad: true` tylko gdy nie da się wskazać zmienionych wielkości (`changed_field_sample_quantity_ids(...)` zwraca pustą listę) albo przy pierwszym snapshocie po podłączeniu. To jest rozsądny fallback, nie ścieżka domyślna.

Problem jest po stronie klienta. Ponieważ dla próbek pól `recommended_fetch: None`, `RealtimeInvalidationBridge` nie ma ścieżki „exact" i schodzi do `queueFieldSampleQuantityInvalidation(quantityId, …)`, która dopasowuje **cały prefiks** `…/data/fields/{quantityId}/`. Jedno zdarzenie unieważnia więc równocześnie:

- `…/{q}/samples/vector` dla **każdej** części / scope'u (osobne żądanie na część — `loadViewport3DFieldRequestsBounded`, brak fan-in po stronie HTTP),
- `…/{q}/meta` (zakres kolorbara),
- `…/{q}/availability`,

a dla `m` dodatkowo `queueMagnetizationFieldDependents(...)` (m.in. ładunek topologiczny), niezależnie od tego, czy ktokolwiek to wyświetla.

Do tego dochodzi kaskada po stronie viewportu: `invalidateViewport3DFieldMetaResources(...)` jest wołane **po każdym udanym fetchu wektora** (4 miejsca w `viewport3dResources.ts`). Te wywołania dzieją się w `.then()` poszczególnych żądań, czyli **poza jednym `requestAnimationFrame`**, w którym `RealtimeInvalidationBridge` koalescencjonuje zmiany. `ResourceInvalidationController.invalidate*()` powiadamia subskrybentów **synchronicznie, per klucz**. N części, których żądania rozjeżdżają się w czasie → **N osobnych fal renderu na tick**, każda mogąca trafić w VPF-001/002.

**Szacunek:** scena z 3–5 częściami + nakładka pola → rzędu **10–15 GET-ów na 2 s** plus 2 POST-y ACK wizualizacji na viewport na rewizję.

**Rekomendacja:**

1. **Endpoint zbiorczy** na próbki pola dla wielu scope'ów w jednym żądaniu (`?scope_id=a,b,c` lub POST z listą) — jeden round-trip zamiast N.
2. `…/{q}/meta` (zakres kolorbara) powinien przyjeżdżać **razem z payloadem wektora** — najlepiej w bloku metadanych `FMMI` (min/max już policzone po stronie serwera). To eliminuje całą kaskadę i N dodatkowych żądań.
3. Dopóki (2) nie jest zrobione: przenieść `invalidateViewport3DFieldMetaResources` **do tego samego okna rAF**, co bridge (wspólny scheduler flush), żeby N części dawało jeden commit.
4. Zawęzić `queueFieldSampleQuantityInvalidation` do `…/{q}/samples/` — `availability` zmienia się na zdarzeniach cyklu życia, nie na każdej próbce.
5. `queueMagnetizationFieldDependents` wywoływać tylko gdy zależny zasób ma aktywnego subskrybenta.

---

### VPF-005 — `FallbackTopologyMeshLayer`: materiał odtwarzany per rewizja (martwy kod)

**Priorytet: P2 (usunięcie/naprawa higieniczna). Status: CONFIRMED w kodzie, NIE W ŚCIEŻCE RUNTIME.**

```ts
const scalarShaderMaterial = useMemo(() => {
  …
  return tracker.track("material", createScalarSurfaceShaderMaterial(visibleShaderScalarColors, {…}));
}, [ …, visibleShaderScalarColors ]);   // ← bufor kolorów w deps → new ShaderMaterial co rewizję
```

plus brak `retentionKey` w wywołaniach `useViewport3DScalarShaderColorUpload`/`useViewport3DScalarColorUpload` (kontrast: `MeshPartLayer` przekazuje `scalarColorRetentionKey`), plus fallback JSX na płaski `<meshBasicMaterial>` gdy materiał jest `null`.

Weryfikacja: `grep` po całym `apps/control-room/src` pokazuje, że komponent **nie jest importowany nigdzie poza własnym plikiem**. W ścieżce renderu jest `TopologyMeshLayer` → `MeshPartLayer`.

**Rekomendacja:** usunąć plik albo doprowadzić do wzorca „S-08" z `MeshPartLayer` (`useMemo` po `scalarSurfaceShaderVariantKey(...)`, dane przez `updateScalarSurfaceShaderMaterial`, realny `retentionKey`). Zostawienie go „na wszelki wypadek" to gotowa regresja na przyszłość.

---

### VPF-006 — drobne, kosmetyczne wzmocnienia percepcji migotania

**Priorytet: P3.**

- `viewport3dRefreshCountdown.ts`: `VIEWPORT_3D_REFRESH_FLASH_MS = 650` przy cyklu 2 s daje 2–3 zmiany stanu HUD na cykl (`counting → syncing → updated → counting`). Warto skrócić flash do ~200 ms albo pokazywać `syncing` dopiero po progu (np. > 400 ms trwania), żeby HUD nie „pulsował" w rytm sceny.
- `VectorFieldLayer.syncVectorGlyphColorState` ustawia `material.vertexColors` i `material.needsUpdate = true` przy każdym przejściu `glyphColors` w falsy — to przełącza define `USE_COLOR` i wymusza rebuild programu. Dziś osłania to retencja stale w `viewport3dDerivedBufferCache`, ale klasa błędu jest ta sama co VPF-002.

---

## 5. Findings — transport i format danych

### VPD-001 — `float64` jako jedyny dopuszczalny typ wartości

**Priorytet: P1. Status: CONFIRMED. Zysk: −50 % bajtów i −50 % czasu dekodowania.**

`kernel/api/codecs/fieldVectorCodec.ts`:

```ts
const KIND_F64 = 1;
…
if (kind !== KIND_F64) throw new Error(`Unsupported FMVP value kind: expected ${KIND_F64}, got ${kind}`);
…
values: new Float64Array(buffer, valueOffset, valueCount),
```

Serwer symetrycznie: `crates/fullmag-api/src/field_store.rs` → `write_f64_values`, `FIELD_VECTOR_BINARY_KIND_F64`.

Do renderu podwójna precyzja jest zbędna — kolory i glify i tak przechodzą przez `Float32Array` na GPU. W repo jest już precedens: `crossSectionCodec` używa `Float32Array`.

**Rekomendacja:** dodać `KIND_F32 = 2` do FMVP (format ma pole `kind`, więc jest to rozszerzenie kompatybilne wstecz), wybierać per żądanie (`?precision=f32`) i używać f32 dla wszystkich ścieżek wizualizacyjnych; f64 zostawić dla eksportu/inspekcji numerycznej. Dodatkowo: dla wektorów jednostkowych (`m`) docelowo rozważyć `i8`/`i16` znormalizowane — kolejne 2–4×, ale to już zmiana kontraktu wymagająca osobnej kwalifikacji.

### VPD-002 — brak jakiejkolwiek kompresji odpowiedzi

**Priorytet: P1. Status: CONFIRMED. Zysk: 2–4× na typowych, gładkich polach. Koszt: konfiguracja.**

W `crates/fullmag-api/src` nie ma **żadnego** wystąpienia `compression`/`gzip`/`brotli`/`zstd`/`content-encoding`. Router v2 zakłada tylko middleware `request-id` i `contract-version`; `main.rs` dokłada `DefaultBodyLimit` i `cors`. W `docker/`, `compose.yaml`, `compose.windows.yaml` nie ma nginx/caddy z gzipem. Jedyne, co może zadziałać, to domyślny `compress: true` Next.js przy proxy `rewrites()` — ale ta ścieżka **znika** przy `FULLMAG_CONTROL_ROOM_STATIC_EXPORT=1`, gdzie przeglądarka rozmawia bezpośrednio z Rustem.

**Rekomendacja:** `tower_http::compression::CompressionLayer` (zstd + gzip) na routerze v2. `fetch` obsługuje `Content-Encoding` przezroczyście — po stronie klienta zero zmian. Uwaga: zmierzyć koszt CPU kompresji przy 2 s cyklu; dla zstd na poziomie 1–3 powinien być pomijalny wobec zysku na sieci i na czasie do pierwszego bajtu.

### VPD-003 — `max_samples` opcjonalne; przy braku serwer wysyła pełne pole

**Priorytet: P2. Status: CONFIRMED.**

`sample_unscoped_field_values` (`router_v2/handlers/data/fields.rs`) redukuje próbki tylko gdy `max_samples` jest podane; `None` → pełne `raw_values`. Frontend przekazuje budżety dla ścieżek FDM/airbox (`FDM_DISPLAY_CELL_BUDGET`, `resolveViewport3DAirboxVectorSampleBudget`, `maxVectors`), ale nie ma gwarancji, że **każda** aktywna ścieżka live to robi.

**Rekomendacja:** ustalić, że live-poll viewportu **zawsze** przekazuje rozwiązany budżet z `visualizationVectorCapacity`; brak `max_samples` traktować jako ścieżkę eksportu/inspekcji, nie wizualizacji. Dodać test kontraktowy na obecność parametru w żądaniach viewportu.

### VPD-004 — brak delty między rewizjami

**Priorytet: P2 (duży zysk, większy nakład). Status: brak implementacji.**

Co 2 s przesyłane jest całe pole, mimo że między krokami solvera zmienia się zwykle niewielki podzbiór komórek. Blok metadanych FMMI już niesie `domain_generation_id`, hash topologii i `mesh_topology_revision` — jest gdzie zaczepić schemat różnicowy (bitmapa „dirty" + wartości zmienionych komórek, z okresowym keyframe).

Tańszy krok pośredni, do zrobienia od razu: **realnie używać `ETag`/`If-None-Match`**. Instalacja istnieje (`ControlRoomApi` obsługuje 304), ale trzeba potwierdzić, że pętla live przekazuje poprzedni `etag` — wtedy niezmienione pole kosztuje 304 bez treści zamiast pełnego transferu.

### VPD-005 — jeden worker dekodujący, trwały fallback na main thread

**Priorytet: P2. Status: CONFIRMED.**

`binaryDecodeScheduler.ts` trzyma **jeden** modułowy `BinaryDecodeWorkerClient` dla wszystkich rodzajów payloadu (topologia, wektory pól, jakość siatki, przekroje) — dekodowania serializują się za sobą. Gdy konstruktor workera rzuci wyjątek, wynik `null` jest **zapamiętany na całą sesję** i od tego momentu wszystko dekoduje się synchronicznie na wątku głównym. Przy payloadzie 23 MB to jest gwarantowany zjazd klatek.

**Rekomendacja:** mała pula (2–4) workerów z osobnymi kolejkami per rodzaj, oraz ponowna próba utworzenia workera po zadanym czasie zamiast trwałego `null`. Dodatkowo: telemetria „dekodowanie na main thread" jako sygnał alarmowy, nie cicha degradacja.

### VPD-006 — `proto/` nie jest używane

Katalog `proto/` zawiera wyłącznie `fullmag/control/v1/jobs.proto` (submit/status zadań); `grep` nie znajduje żadnego odwołania w `crates/`, `backends/`, `packages/`, `apps/`. Ścieżka pól **nie** używa protobufa. Albo dokończyć, albo usunąć — dziś to mylący scaffold.

---

## 6. Ocena ogólna architektury (co jest zrobione dobrze)

Warto to zapisać, bo przy naprawie łatwo zepsuć rzeczy, które działają:

1. **`frameloop="demand"` z jawnymi „dirty reasons".** Viewport nie renderuje klatek bez powodu, a każdy powód jest nazwany i policzalny (`tracker.recordDirtyFrame`). To jest dokładnie ta infrastruktura, której trzeba do zmierzenia i zamknięcia tego problemu.
2. **Rozdział „program GL" vs „dane".** Materiały memoizowane po variant-key, dane przez mutację uniformów, `needsUpdate` tylko przy realnej zmianie źródła shadera (komentarze „S-08"). To poprawny wzorzec i jest przestrzegany w warstwach produkcyjnych.
3. **Retencja i klucze buildów.** Rozdzielenie `buildKey` (zawiera rewizję pola → wymusza rebuild) i `topologyKey` (nie zawiera → pozwala trzymać ostatni dobry wynik) jest właściwą decyzją projektową.
4. **Atomowy swap geometrii** (`useViewport3DGeometryUpload`) z rollbackiem do `previousGeometry` — wzorzec do skopiowania na kolory.
5. **Sekwencyjne zabezpieczenie zasobów.** `ResourceRuntimeStore` ma dedup po rewizji, `abortStaleInflight`, serializację żądań i `entry.sequence` sprawdzany w `then/catch/finally` — starsza odpowiedź nie nadpisze nowszej. To jest solidne.
6. **Binarny transport z dekodowaniem off-thread i zero-copy transferem.** WebSocket tylko dla powiadomień. Kierunek jest dobry; brakuje f32 i kompresji.
7. **Bardzo wysoka gęstość testów** (~640 plików testowych) i egzekwowany `check-architecture-hygiene.mjs`.

Główny dług strukturalny jest gdzie indziej i został już opisany w audycie z 2026-09-03: `useViewport3DSceneModel.ts` ma 6575 linii i 93 eksporty, `Viewport3DModule.tsx` 3359, `viewport3dRenderModel.ts` 3172. To nie jest bezpośrednia przyczyna migotania, ale to **powód, dla którego tego rodzaju błędy są trudne do zauważenia i łatwe do wprowadzenia** — logika etapowania sceny jest zakopana w pliku, którego nikt nie czyta w całości.

---

## 7. Plan naprawczy

### Faza A — usunięcie migotania (1–2 tygodnie, P0)

| # | Działanie | Finding | Nakład |
|---|---|---|---|
| A1 | Wyciąć flagi `…length > 0` z klucza staged-reveal; reset etapu tylko przy realnej zmianie topologii/sceny | VPF-001 | S |
| A2 | Reset etapu przenieść z renderu do efektu z histerezą (≥150 ms pustki) | VPF-001 | S |
| A3 | Zamiast `: null` dla `fieldVector`/`surfaceColors`/`vectorSegments` — retencja ostatniego dobrego bufora | VPF-001 | M |
| A4 | Rozdzielić `buffer: null` od `buffer: last-good, fresh: false`; materiał gasi kolory tylko w pierwszym przypadku | VPF-002 | M |
| A5 | Retencja domyślnie włączona (fallbackowy `retentionKey` z `geometry`+`vertexCount`) | VPF-002 | S |
| A6 | Round-robin / wiekowanie w koordynatorze uploadu GPU | VPF-003 | S |
| A7 | Rollback także dla `status === "aborted"` | VPF-003 | S |
| A8 | Testy regresyjne: „przerwa w dostępności bufora nie gasi kolorów", „stage-reset = 0 przy stałej topologii" | — | M |

### Faza B — redukcja ruchu i liczby renderów (2–3 tygodnie, P1)

| # | Działanie | Finding | Nakład |
|---|---|---|---|
| B1 | `kind = f32` w FMVP + `?precision=f32` dla ścieżek wizualizacyjnych | VPD-001 | M |
| B2 | `CompressionLayer` (zstd+gzip) na routerze v2 + pomiar kosztu CPU | VPD-002 | S |
| B3 | Zakres kolorbara (`meta`) dostarczany w bloku FMMI razem z wektorem; likwidacja kaskady `invalidateViewport3DFieldMetaResources` | VPF-004 | M |
| B4 | Zbiorczy endpoint próbek dla wielu scope'ów (fan-in N żądań → 1) | VPF-004 | M |
| B5 | Zawężenie `queueFieldSampleQuantityInvalidation` do `…/samples/`; dependents tylko przy aktywnym subskrybencie | VPF-004 | S |
| B6 | Pula workerów dekodujących + ponowna próba zamiast trwałego fallbacku | VPD-005 | S |
| B7 | Wymuszenie `max_samples` na wszystkich ścieżkach live | VPD-003 | S |
| B8 | Potwierdzić realne użycie `ETag`/`If-None-Match` w pętli live | VPD-004 | S |

### Faza C — utwardzenie i dług (P2)

| # | Działanie | Finding | Nakład |
|---|---|---|---|
| C1 | Prawdziwy back-buffer dla kolorów (wzorzec z `useViewport3DGeometryUpload`) | VPF-003 | M |
| C2 | Opcjonalny cross-fade między rewizjami (dziś `meshPartScalarTransition.ts` mimo nazwy **nie** interpoluje — jest tylko budowniczym klucza i selektorem pipeline'u) | VPF-001 | M |
| C3 | Usunąć albo naprawić `FallbackTopologyMeshLayer` | VPF-005 | S |
| C4 | Skrócić `REFRESH_FLASH_MS`, progować stan `syncing` | VPF-006 | S |
| C5 | Delta-encoding pól między rewizjami (bitmapa dirty + keyframe) | VPD-004 | L |
| C6 | Wydzielić logikę etapowania sceny z `useViewport3DSceneModel.ts`/`Viewport3DScene.tsx` do osobnego, testowalnego modułu | dług | M |
| C7 | Usunąć nieużywane `proto/` albo dokończyć integrację | VPD-006 | S |

---

## 8. Jak to zmierzyć (obowiązkowe przed uznaniem naprawy za zamkniętą)

Repozytorium ma już całą potrzebną instrumentację — trzeba ją tylko spiąć w jeden pomiar.

**Przebieg referencyjny:** aktywny solver, 60 s, scena z nakładką pola demag i co najmniej 3 częściami.

| Metryka | Źródło | Cel |
|---|---|---|
| liczba `dirty reason = "model-layer-stage-reset"` | `Viewport3DResourceTracker` | **0** poza zmianami siatki |
| liczba przejść `material.vertexColors: true → false` | nowy licznik w `MeshPartLayer` | **0** |
| klatki od „rewizja zdekodowana" do `onVisible` ticketu kolorów | `viewport3dGpuUploadDiagnostics` | p95 ≤ 2 |
| liczba ticketów `aborted` na tick | `GpuUploadManager` | **0** w stanie ustalonym |
| liczba GET `/data/fields/**` na tick | `RequestDiagnosticsController` | ≤ liczba realnie zmienionych wielkości |
| liczba commitów React na tick | React Profiler / `kernel/performance` | **1** |
| bajty/tick i czas dekodowania | `RequestDiagnosticsController` (`byteLength`) + `binaryDecodeScheduler` | linia bazowa przed/po B1+B2 |
| udział dekodowania na main thread | `binaryDecodeScheduler` | **0 %** |

Dodatkowo: rozszerzyć CI o jeden skrypt smoke `smoke:viewport-3d-live-refresh`, który uruchamia fixture z sekwencją rewizji i asercjonuje trzy pierwsze metryki. Dziś w CI działają tylko 2 z 24 istniejących skryptów `smoke:*` (ustalenie z audytu 2026-09-03), a ten obszar jest ewidentnie regresogenny.

---

## 9. Powiązania z wcześniejszymi ustaleniami

- `docs/audits/2026-08-27-control-room-field-data-instability-diagnostic.md` — opisuje **backendową** przyczynę znikania wektorów demag: błędna klasyfikacja częściowych paczek jako terminalnych, rotacja katalogu pól, `204 not-applicable` usuwające poprawny wpis z cache. Naprawiono. Niniejszy audyt pokazuje, że **frontend nadal ma wzmacniacze** tego typu zdarzeń (VPF-001, VPF-002): pojedyncze, przejściowe „pusto" wciąż powoduje twardy teardown warstw. Nawet po naprawie backendu warto usunąć wzmacniacze — inaczej każda przyszła chwilowa dziura w publikacji znów da migotanie.
- `docs/audits/2026-09-03-control-room-frontend-full-audit-and-refactor-plan.md` — dług strukturalny (mega-pliki, wąskie pokrycie smoke w CI, globalnie wyłączony `reactStrictMode`). Punkty C6 i pomiar z §8 wprost realizują część tamtego planu.
- Gałęzie `fix/viewport-3d-audit-s16-postprocessing-20260909` i `fix/viewport-3d-audit-s18-s19-upload-20260910` — praca w toku w dokładnie tym obszarze. Przed wdrożeniem Fazy A należy zestawić ją z tym, co już zrobiono w S-18/S-19.

---

## 10. Załącznik — mapa plików istotnych dla tego problemu

| Plik | Rola w problemie |
|---|---|
| `modules/viewport-3d/layers/Viewport3DScene.tsx` | staged reveal, klucz resetu, gaszenie warstw (**VPF-001**) |
| `modules/viewport-3d/hooks/useViewport3DScalarColorUpload.ts` | retencja, `publish(null)` (**VPF-002**) |
| `modules/viewport-3d/build-engine/gpu/viewport3dGpuUploadManager.ts` | budżet klatki, brak rotacji, rollback (**VPF-003**) |
| `kernel/realtime/RealtimeInvalidationBridge.ts` | mapowanie zdarzeń WS na inwalidacje, koalescencja rAF (**VPF-004**) |
| `modules/viewport-3d/viewport3dResources.ts` | kaskada `meta`, fan-out żądań per część (**VPF-004**) |
| `modules/viewport-3d/layers/FallbackTopologyMeshLayer.tsx` | materiał per rewizja, martwy kod (**VPF-005**) |
| `modules/viewport-3d/viewport3dRefreshCountdown.ts` | HUD odliczania (**VPF-006**), źródło mylącego wrażenia „pollingu" |
| `kernel/api/codecs/fieldVectorCodec.ts` | FMVP, `float64` (**VPD-001**) |
| `crates/fullmag-api/src/field_store.rs` | enkoder FMVP, `write_f64_values` (**VPD-001**) |
| `crates/fullmag-api/src/router_v2/mod.rs`, `main.rs` | brak warstwy kompresji (**VPD-002**) |
| `crates/fullmag-api/src/router_v2/handlers/data/fields.rs` | `max_samples`, próbkowanie serwerowe (**VPD-003**) |
| `kernel/api/binaryDecodeScheduler.ts` | pojedynczy worker, trwały fallback (**VPD-005**) |
| `kernel/realtime/communicationPolicy.ts`, `crates/fullmag-api/src/schemas/realtime.rs` | `field_sample_publish_ms = 2000` — źródło „2 sekund" |
| `modules/viewport-3d/layers/MeshPartLayer.tsx` | wzorzec referencyjny „S-08" (materiał po variant-key + retencja) |
| `modules/viewport-3d/hooks/useViewport3DGeometryUpload.ts` | wzorzec referencyjny atomowego swapu z rollbackiem |
