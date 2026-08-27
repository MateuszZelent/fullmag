# Diagnostyka niestabilności danych pól w Control Roomie

**Data:** 2026-08-27
**Zakres:** sesja FEM GPU `session-1787783828923-72382`, pola `m` i `H_demag`, zasoby v2, cache zasobów, viewport 3D i planar
**Stan raportu:** przyczyny potwierdzone i naprawione w kodzie; testy jednostkowe, kontraktowe, typecheck, React Doctor i zarządzany test FEM przeszły; kwalifikacja w otwartej przeglądarce jest zablokowana błędem połączenia narzędziowego

## 1. Streszczenie wykonawcze

Niestabilność jest rzeczywista i powstaje przed rendererem Three.js. Dla niezmienionej sesji, generacji domeny i identycznego zapytania serwer cyklicznie zwraca:

- `m`, część `part:permalloy_layer_geom`: `200 -> 204 -> 202 -> 200`;
- `m`, pełny nośnik: `200 -> 202 -> 200`;
- `H_demag`, pełny nośnik: `202 -> 200 -> 202`.

Równocześnie `/v2/sessions/current/data/fields` nie jest stabilnym katalogiem pól. W kolejnych próbkach zmieniał zawartość między m.in.:

- `H_demag, H_eff, m`;
- `H_eff, m, torque`;
- `torque, H_ani, m`;
- `H_ani, eden_ex, m`;
- `eden_demag, eden_total, m`.

To nie jest zmiana możliwości solvera ani domeny. Jest to obrót chwilowych stanów asynchronicznego materializera, który przecieka do zasobu używanego przez viewport jako bieżąca prawda o nośnikach.

Bezpośrednia przyczyna rotacji została zlokalizowana w klasyfikacji publikacji CLI. Asynchroniczny materializer FEM kończy po jednym polu i przekazuje jednopolową paczkę `cached_preview_fields`. `terminal_authoritative_field_update()` uznaje jednak każdą niepustą paczkę, w której wszystkie pola mają `materialized_at_unix_ms > 0`, za kompletny terminalny snapshot generacji. Następnie `ingest_preview_fields_from_update()` zeruje `latest_fields` i ustawia `replace_latest_fields=true`. Każde kolejne ukończone pole zastępuje więc poprzednią generację zamiast do niej dołączyć. Zaobserwowana kolejność `H_demag -> H_eff -> torque -> ...` jest kolejnością kolejki materializera, a nie zmianą możliwości solvera.

Frontend wzmacnia błąd: odpowiedź `204 not-applicable` usuwa poprawny wpis z cache i zwraca `null`. Kolekcja traktuje ten wynik jako udane, gotowe, ale puste odświeżenie. W rezultacie ostatni poprawny bufor znika dokładnie wtedy, gdy backend przechodzi przez chwilowe okno bez opublikowanego źródła.

Endpoint planarny ma ponadto drugi, niezależny błąd zgodności z bieżącą domeną FEM: gdy `m` jest akurat opublikowane, sampler odrzuca siatkę Prism6 jako `unsupported_element_order`, ponieważ implementacja wymaga Tet4/P1. Dlatego ten sam URL przełącza się między `404 quantity_not_materialized` i `422 unsupported_element_order`.

## 2. Zaobserwowane objawy

1. Wektory demagnetyzacji pojawiają się na krótko i znikają.
2. Powiadomienia raportują `ResourcePartialLoadError` dla `m` na części `part:permalloy_layer_geom`, ale pokazują `Status unknown`.
3. Planarny zasób `m/planar-default/meta` przełącza się między `404 quantity_not_materialized` i `422 unsupported_element_order` dla Prism6.
4. Konsola pokazuje wiele nieudanych i ponawianych żądań oraz materializację `compute_fields`.
5. Wystąpił komunikat `THREE.WebGLRenderer: Context Lost`.

Punkty 1, 2 i 4 mają wspólną, potwierdzoną przyczynę w publikacji zasobów pola. Punkt 3 łączy tę samą utratę publikacji z osobnym brakiem obsługi elementów Prism6. Punkt 5 wymaga osobnej kwalifikacji po usunięciu burzy invalidacji; obecne dowody nie pozwalają uznać utraty WebGL ani za przyczynę znikania danych, ani za nieszkodliwy teardown.

## 3. Dowody runtime

### 3.1. Niespójny pojedynczy snapshot API

Dla dokładnego zasobu zgłoszonego przez UI:

```text
GET /v2/sessions/current/data/fields/m/samples/vector
    ?component=full
    &scope_id=part%3Apermalloy_layer_geom
    &scope_kind=part

HTTP 204 No Content
```

W tej samej chwili metadata zwracała:

```text
quantity_id=m
state=stale_complete
materialization_reason_code=field_materialization_stale
resolved_capability.provider=available
resolved_capability.request=field_vector
resolved_capability.materialization=materialized
resolved_capability.render=renderable
resolved_capability.carriers=[]
```

To jest wewnętrzna sprzeczność kontraktu: zasób deklaruje `materialized` i `renderable`, ale nie publikuje żadnego nośnika, a binarny endpoint zwraca brak payloadu.

### 3.2. Powtarzalna oscylacja tego samego URL

Próbkowanie identycznych URL-i przez około 16 sekund dało między innymi:

```text
00:54:03.101  part-m=200  full-m=200  full-demag=202  H_ex,H_demag,m
00:54:03.720  part-m=204  full-m=202  full-demag=202  H_ex,H_demag,m
00:54:04.030  part-m=204  full-m=202  full-demag=200  H_demag,H_eff,m
00:54:06.165  part-m=204  full-m=202  full-demag=200  H_eff,m,torque
00:54:11.079  part-m=202  full-m=202  full-demag=202  eden_total,eden_ani,m
00:54:13.389  part-m=200  full-m=200  full-demag=202  m,H_ex
00:54:14.955  part-m=204  full-m=202  full-demag=202  H_ex,H_demag,m
```

Sesja pozostawała `running`, domena FEM miała tę samą generację `6200970733836594816`, a topologia tę samą rewizję `4`. Zmieniał się wyłącznie chwilowy stan materializacji/publikacji pól.

### 3.3. Stabilna możliwość kontra niestabilna materializacja

`/v2/sessions/current/data/quantities` stale deklarował dla `m` i `H_demag`:

```text
provider=available
request=field_vector
render=renderable
publication=interactive
materializable=true
```

Natomiast `/v2/sessions/current/data/fields` publikował tylko aktualnie ukończone/oczekujące elementy cyklu materializera. Viewport używa drugiego zasobu do podejmowania decyzji o istnieniu żądań Airbox, więc chwilowy brak wpisu usuwa całą mapę żądań `H_demag`.

### 3.4. Dokładny błąd endpointu planarnego

Próbkowanie dokładnego URL-u z konsoli przez około 18 sekund, przy tej samej sesji i generacji domeny, zwracało naprzemiennie:

```text
HTTP 404
code=quantity_not_materialized
message="quantity_not_materialized: field 'm' is not published"
```

oraz:

```text
HTTP 422
code=unsupported_element_order
capability_reason=unsupported_element_order
message="unsupported_element_order: tet4 P1 nodal carrier required:
         tet4 topology required, but cell 0 is Prism6"
```

`404` występuje, gdy błędne zastąpienie generacji usuwa `m`. `422` występuje, gdy `m` jest dostępne i wykonanie dochodzi do `build_fem_target()`, które bezwarunkowo wywołuje `mesh.require_tet4_elements()`.

## 4. Potwierdzone przyczyny

### FDI-000 — jednopolowa paczka asynchroniczna jest błędnie uznawana za pełny terminalny snapshot

**Priorytet:** P0
**Status:** CONFIRMED

`FemPreviewHandoff` materializuje pola sekwencyjnie. `poll_cached()` zwraca `Some(Vec<...>)` natychmiast, gdy gotowe jest co najmniej jedno pole, więc zwykła paczka cadence może zawierać tylko jedną wielkość. Każde ukończone pole otrzymuje dodatni `materialized_at_unix_ms`.

`terminal_authoritative_field_update()` rozpoznaje terminalny snapshot jako:

```text
update.finished || fields.iter().all(|field| field.materialized_at_unix_ms > 0)
```

Drugi warunek nie rozróżnia kompletnego snapshotu finalizera od zwykłego jednopolowego wyniku asynchronicznego. Po jego spełnieniu `ingest_preview_fields_from_update()` wykonuje:

```text
latest_fields = empty
preview_fields.clear()
pending_preview_fields.clear()
replace_latest_fields = true
clear_preview_cache = true
```

API przyjmuje tę publikację jako atomowe zastąpienie generacji i usuwa wszystkie wcześniej opublikowane pola. Następne ukończone pole powtarza operację.

**Kod:**

- `crates/fullmag-runner/src/fem/relax/preview.rs`, `FemPreviewHandoff::poll_cached()`, `promote_completion()` i kolejka `cache_queue`;
- `crates/fullmag-runner/src/fem/relax/llg_overdamped.rs` oraz `direct_minimizer.rs`, budowa bieżących `StepUpdate` z częściowym `cached_preview_fields`;
- `crates/fullmag-cli/src/live_workspace.rs`, `terminal_authoritative_field_update()` i `ingest_preview_fields_from_update()`;
- `crates/fullmag-api/src/session.rs`, `apply_current_live_field_frame_in_place()` — zastąpienie `latest_fields` i wyzerowanie `preview_cache`.

**Skutek:** źródło prawdy traci poprzednie wielkości przy każdym ukończeniu zadania materializera. Jest to bezpośrednia przyczyna rotującego katalogu i przejść `200/202/204`.

### FDI-001 — chwilowy stan materializera zastępuje stabilny obraz opublikowanych pól

**Priorytet:** P0
**Status:** CONFIRMED

`get_field_catalog()` buduje katalog głównie z `latest_fields`, `preview_cache` oraz bieżącego `field_materialization_states`. Nie uzupełnia stabilnie wszystkich pól dostępnych w resolved provider registry. W czasie asynchronicznej, sekwencyjnej materializacji katalog obraca się razem z aktualnie przetwarzanymi wielkościami.

**Kod:**

- `crates/fullmag-api/src/router_v2/handlers/data/fields.rs`, `get_field_catalog()`, szczególnie linie 1886-2184;
- `crates/fullmag-api/src/router_v2/handlers/data/quantities.rs`, `annotate_runtime_quantity_state()` — istniejący wzorzec rozdzielenia capability od materialization;
- `crates/fullmag-runner/src/fem/relax/llg_overdamped.rs` i `direct_minimizer.rs` — producent chwilowych `field_materialization_states`.

**Skutek:** z zasobu wykorzystywanego do routingu znikają legalne ilości i nośniki mimo niezmienionej domeny oraz możliwości wykonania.

### FDI-002 — endpoint wektora przełącza istniejący zasób między `200`, `202` i `204`

**Priorytet:** P0
**Status:** CONFIRMED

`get_field_vector()` zwraca `202`, gdy widzi bieżący materializer/komendę, ale zwraca `204`, gdy w danym snapshotcie nie potrafi rozwiązać źródła i nie widzi aktywnego stanu pending. Wskutek nieatomowej widoczności źródła, statusu materializera i nośnika ten sam zasób okresowo wpada w obie gałęzie.

**Kod:**

- `crates/fullmag-api/src/router_v2/handlers/data/fields.rs`, `get_field_vector()`, linie 4501-4760;
- gałęzie `materializer_pending`/`active_command_id` i końcowe `NO_CONTENT`, linie 4690-4739;
- `crates/fullmag-api/src/session.rs`, scalanie runtime/field frame i `preview_cache`;
- `crates/fullmag-cli/src/live_workspace.rs`, publikacja `preview_fields` wraz z `clear_preview_cache`.

**Skutek:** HTTP v2 nie prezentuje jednego spójnego, monotonicznego snapshotu publikacji pola.

### FDI-003 — `204` kasuje ostatni poprawny bufor frontendu

**Priorytet:** P0
**Status:** CONFIRMED

W `loadCachedBinaryResource()`:

```ts
if (result.status === "not-applicable") {
  cache.delete(key);
  return null;
}
```

Następnie loader kolekcji dodaje `null`, nie zgłasza błędu i zwraca pustą mapę jako udany wynik. Mechanizm last-good działa tylko dla `error/loading/stale`; nie działa dla udanego pustego wyniku i nie może odtworzyć bufora, ponieważ wpis cache został wcześniej skasowany.

**Kod:**

- `apps/control-room/src/modules/viewport-3d/viewport3dResources.ts`, `loadCachedBinaryResource()`, linie 835-902;
- `useViewport3DPartFieldVectors()`, linie 2040-2129;
- analogiczne loadery quantity i Airbox;
- `resolveViewport3DFieldVectorCollectionLastGood()`, linie około 359-402.

**Skutek:** pojedyncze chwilowe `204` bezpośrednio usuwa widoczne wektory.

### FDI-004 — routowanie Airbox zależy od rotującego katalogu materializacji

**Priorytet:** P0
**Status:** CONFIRMED

`resolveViewport3DAirboxFieldVectorResourceRequests()` zwraca pustą mapę, jeśli bieżący `fieldCatalog` nie zawiera ilości o domenie `full_domain`. Gdy `H_demag` znika z chwilowego katalogu, zmienia się tożsamość kolekcji na `...:none`, a last-good nie ma już żadnych request IDs do zachowania.

**Kod:**

- `apps/control-room/src/modules/viewport-3d/viewport3dResources.ts`, linie 1094-1142;
- `apps/control-room/src/kernel/api/quantityIds.ts`, `fieldCatalogQuantitySupportsAirbox()`;
- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`, budowa planu żądań.

**Skutek:** wektory `H_demag` znikają nawet wtedy, gdy poprawny bufor nadal istnieje w pamięci klienta.

### FDI-005 — błąd kolekcji ukrywa status i reason code żądania składowego

**Priorytet:** P1
**Status:** CONFIRMED

Loader zachowuje szczegóły w `requestFailures`, lecz nadrzędny `ResourcePartialLoadError` nie wystawia bezpośrednio `status`, `code` i `reason_code` pierwszej przyczyny. Ogólny mechanizm `resource:load-failed` raportuje więc `Status unknown`.

**Kod:**

- `apps/control-room/src/modules/viewport-3d/viewport3dResources.ts`, `createViewport3DFieldVectorPartialLoadError()` i loadery kolekcji;
- `apps/control-room/src/kernel/resources/resourceLoadFailure.ts`;
- `apps/control-room/src/modules/overlay/NotificationsSurfaceModel.ts`.

**Skutek:** operator widzi lawinę mało użytecznych powiadomień zamiast np. `202 field_materialization_pending` dla konkretnego request ID.

## 5. Ustalenia niezależne

### FDI-006 — planarne `404`

**Priorytet:** P1
**Status:** CONFIRMED

Planarny endpoint pobiera `m` z tego samego niestabilnego źródła publikacji, dlatego zwraca `404 quantity_not_materialized` w oknie po błędnym zastąpieniu generacji. Gdy `m` ponownie się pojawia, request nie może się udać: `build_fem_target()` wymaga Tet4/P1, a bieżąca domena składa się z Prism6, więc zwraca `422 unsupported_element_order`.

**Kod:**

- `crates/fullmag-api/src/planar_sampling/target.rs`, `build_fem_target()` i `mesh.require_tet4_elements()`;
- `crates/fullmag-api/src/router_v2/handlers/data/planar_fields.rs`, obsługa `planar-default`;
- `crates/fullmag-api/src/router_v2/handlers/data/resolved_spatial_field.rs`, rozwiązanie bieżącego źródła `m`.

**Skutek:** naprawa samej atomowości usunie `404`, ale odsłoni stałe `422`. Aby zasób planarny działał na tej sesji, trzeba albo wdrożyć poprawne próbkowanie Prism6, albo jawnie wyłączyć niedostępny tryb przed wysłaniem requestu. Druga opcja usuwa pętlę błędów, ale nie dostarcza rastra planarnego.

### FDI-007 — utrata kontekstu WebGL

**Priorytet:** P1
**Status:** NOT VERIFIED

Jeden wpis `THREE.WebGLRenderer: Context Lost` jest sygnałem awarii lifecycle zgodnie z kontraktem projektu. Nie ma jednak dowodu, że to on usuwa wektory: oscylacja `200/202/204` została potwierdzona bez renderera. Możliwe są dwa niezależne problemy albo utrata kontekstu wtórna wobec HMR/remountu i burzy aktualizacji.

Automatyczne sterowanie otwartą przeglądarką zostało zablokowane przez błąd warstwy narzędziowej dotyczący ścieżki sandboxu. Dlatego `gl.isContextLost()`, rozmiar drawing buffer i stabilność canvasu muszą zostać sprawdzone po naprawie przy działającym połączeniu przeglądarkowym. Nie wolno oznaczyć WebGL jako naprawionego na podstawie samych testów TypeScript.

## 6. Projekt naprawy

### Wariant A — tylko obrona frontendu

Zachować cache przy `202/204`, nie zmieniać mapy requestów po chwilowym braku katalogu i poprawić propagację błędu.

**Zaleta:** mały i szybki diff.
**Wada:** maskuje niespójny kontrakt backendu; inne klienty nadal widzą oscylację i sprzeczne `materialized + carriers=[]`.

### Wariant B — tylko naprawa publikacji backendu

Ustabilizować `/data/fields` i atomowo publikować payload, nośnik oraz stan materializacji. Nie zmieniać cache klienta.

**Zaleta:** naprawa u źródła.
**Wada:** pojedyncze legalne przejściowe `204` albo przyszła regresja nadal wyczyści widok; frontend pozostaje kruchy.

### Wariant C — naprawa kontraktu plus obrona last-good (rekomendowany)

1. Backend: katalog pola ma stabilnie reprezentować resolved provider registry; materializacja i carriers są stanem wpisu, a nie warunkiem istnienia wpisu.
2. Backend/publisher: nie publikować `stale_complete/materialized` bez adoptowalnego carrier; zachować poprzedni poprawny bundle do chwili atomowej adopcji nowego.
3. Frontend: `204` dla tej samej tożsamości sesji/domeny nie może kasować last-good; ma przełączyć zasób na jawny stan unavailable/stale. Cache wolno usunąć dopiero przy zmianie session epoch, generation/carrier mismatch albo jawnej invalidacji domeny.
4. Frontend Airbox: capability bierze z `/data/quantities`, a bieżącą gotowość/nośnik z `/data/fields` lub target availability; chwilowy brak materializacji nie usuwa tożsamości żądania.
5. Diagnostyka: `ResourcePartialLoadError` propaguje status/reason code i listę request IDs; oczekiwane `202` jest stanem oczekiwania, nie powiadomieniem awarii przy każdym refetchu.
6. Planar: użyć tego samego kontraktu last-good/pending i nie emitować powtarzalnego `404` jako ogólnego błędu, jeśli quantity jest wspierane i materializacja trwa.
7. Planar Prism6: wybrać jawnie jeden z dwóch zakresów:
   - **C1, stabilność bez nowej metody numerycznej:** capability/availability blokuje request planarnego FEM dla Prism6 i pokazuje jedno precyzyjne `unsupported_element_order`; brak pętli żądań, ale brak rastra;
   - **C2, pełna funkcjonalność (rekomendowany dla bieżącej sesji):** dodać poprawne próbkowanie liniowych pryzmatów Prism6 wraz z testami funkcji kształtu, selekcji części, maski magnetycznej i granic elementu.

**Zaleta:** usuwa przyczynę i wzmacnia klienta bez ukrywania zmiany domeny.
**Wada:** wymaga zmian w API/CLI publisherze i frontendzie oraz szerszej regresji.

## 7. Testy regresyjne wymagane przed implementacją produkcyjną

1. **API/router:** przy niezmienionej generation i sekwencji `m ready -> inny quantity pending -> m stale_complete` dokładny endpoint `m` pozostaje `200` z poprzednim bundle albo jawnie `202`; nigdy `204` przy deklaracji `materialized`.
2. **API catalog:** wszystkie ilości wspierane przez resolved provider registry pozostają w `/data/fields`; zmieniają się ich stany, nie członkostwo katalogu.
3. **Publisher/session:** przeplatane runtime frames i field frames nie usuwają wcześniej opublikowanych quantity payloads/carriers; test obejmuje konkurencyjne clear/replace/merge.
4. **Frontend binary cache:** `ready -> 204` nie kasuje zgodnego last-good; zmiana session epoch lub generation usuwa go.
5. **Frontend part collection:** `200 -> 204/202 -> 200` zachowuje wektory i oznacza je jako stale/pending, bez pustego `ready`.
6. **Frontend Airbox:** chwilowy brak `H_demag` w katalogu materializacji nie zmienia request collection na `none`, jeśli capability nadal jest supported.
7. **Diagnostyka:** błąd częściowy pokazuje `202 field_materialization_pending` i request ID zamiast `Status unknown`.
8. **Klasyfikacja publikacji:** jednopolowa paczka cadence z dodatnim timestampem nie ustawia `replace_latest_fields`; wyłącznie jawnie oznaczona kompletna publikacja terminalna może zastąpić generację.
9. **Planar:** sekwencja oczekiwania materializacji nie powoduje powtarzalnego ogólnego `404` ani utraty ostatniego poprawnego rastra.
10. **Planar Prism6:** dla C1 nie jest wysyłany nieobsługiwany request i UI pokazuje jeden trwały stan capability; dla C2 testy interpolacji odtwarzają stałe i liniowe pola na pryzmacie oraz odrzucają punkty poza elementem.
11. **Browser/WebGL:** realny smoke potwierdza widoczny canvas, `gl.isContextLost() === false`, drawing buffer większy od zera oraz stabilne wektory przez co najmniej dwa pełne cykle materializera.

## 8. Kryteria akceptacji

- 60-sekundowe próbkowanie identycznych URL-i nie zawiera `204` po pierwszym poprawnym `200`, o ile session epoch i domain generation się nie zmieniły.
- `m` i `H_demag` nie znikają z katalogu wspieranych pól podczas cyklu materializera.
- Wektory części i Airbox nie znikają podczas `pending/stale_complete`.
- Brak powtarzalnych `resource:load-failed` dla oczekiwanego `202`.
- Planarny `m` nie generuje pętli `404` przy działającym solverze; w C2 zwraca poprawny raster dla Prism6, a w C1 nie jest żądany i pokazuje jednoznaczny brak capability.
- Canvas pozostaje widoczny, WebGL nie jest utracony, drawing buffer jest niezerowy.
- HTTP v2 pozostaje źródłem prawdy; websocket wyłącznie unieważnia zasoby.
- Brak bezpośrednich `fetch()` w komponentach i brak ręcznie budowanych ścieżek v2 poza centralnym transportem.

## 9. Zakres zmian proponowany do zatwierdzenia

Rekomendowany jest wariant C2: naprawa atomowości i last-good oraz pełne próbkowanie Prism6. C1 jest mniejszym zakresem, ale pozostawia brak danych planarnych dla aktualnej domeny i dlatego nie spełnia pełnego celu „dostęp do danych działa”. Najpierw powstaną testy RED na poziomie CLI publishera, API/session i `viewport3dResources`; osobny test numeryczny obejmie Prism6. Potem nastąpi minimalna naprawa publishera/katalogu/cache i próbkowania, a na końcu testy kontraktowe, typecheck, zarządzany test runtime oraz realny browser smoke.

OpenAPI v2 i wygenerowane typy/transport zostaną zmienione tylko wtedy, gdy implementacja wymusi doprecyzowanie semantyki odpowiedzi lub schematu błędu. Preferowany projekt zachowuje istniejące kształty i poprawia spójność stanów. C2 dotyka metody numerycznej FEM, więc przed kodem wymaga uzupełnienia publikacyjnej dokumentacji fizyczno-numerycznej i przejścia bramek `physics-publication`, `scientific-documentation-contract` oraz `fem-native-backend-architecture`.

## 10. Audyt natężenia requestów i invalidacji

### 10.1. Zakres i sposób liczenia

Przeanalizowano eksport diagnostyki transportu obejmujący okres:

```text
2026-08-26T22:51:50.685Z .. 2026-08-26T22:52:05.212Z
czas okna: 14 527 ms
liczba zapisanych wpisów: 60
```

`60` nie jest liczbą rzeczywistych operacji. `RequestDiagnosticsController` scala identyczne wpisy w oknie 5 s i zapisuje krotność w `detail`, np. `attempt 1 (x5 over 3046ms)`. Po rozwinięciu wszystkich `xN` eksport reprezentuje około 55 wysłanych requestów HTTP oraz 35 odebranych komunikatów WebSocket. Współczynniki poniżej są projekcją krótkiego okna do jednej minuty, a nie zastępstwem kontrolowanego 60-sekundowego smoke testu.

| Metryka | Liczba w 14,527 s | Projekcja / min | Budżet repo | Ocena |
|---|---:|---:|---:|---|
| wszystkie session HTTP TX | 55 | 227,2 | 30 | FAIL, 7,6 razy ponad budżet |
| field-vector HTTP TX | 11 | 45,4 | 45 | FAIL na granicy; praktycznie większość bez payloadu |
| `fields:samples` WS | 13 | 53,7 | 45 | FAIL, 19% ponad budżet |
| `scalar.sample` WS | 14 | 57,8 | 360 | PASS |
| heartbeat WS | 1 | 4,1 | interwał 15 s | zgodne |

Rozkład 55 requestów HTTP TX:

| Zasób | Liczba |
|---|---:|
| `/data/fields` | 13 |
| `/data/quantities` | 13 |
| `m/availability` dla obiektu | 13 |
| `m/meta` dla części | 5 |
| `m/samples/vector` dla części lub full | 11 |

Odpowiedzi HTTP zakończone w oknie: `46 x 200`, `3 x 202`, `5 x 204`. Dla samego wektora pola tylko dwie odpowiedzi dostarczyły binarny payload; trzy były `202`, pięć `204`, a ostatni request nie zdążył zakończyć się przed końcem eksportu. Dwa przyjęte bufory miały łącznie około 1,48 MB. Oznacza to, że problemem nie jest tylko liczba requestów, ale bardzo niski udział użytecznych odpowiedzi ciężkiej ścieżki danych.

### FDI-008 — błędne snapshoty terminalne omijają QoS `fields:samples`

**Priorytet:** P0
**Status:** CONFIRMED

Repo definiuje `field_sample_publish_ms = 2000`, a `RealtimeQosLane::FieldSamples` powinien scalać invalidacje próbek pola przez 2 s. Wszystkie trzynaście zdarzeń pola w analizowanym logu miało jednak `immediate window=0ms`.

Przyczyna jest bezpośrednio połączona z FDI-000:

1. jednopolowa paczka zostaje błędnie oznaczona `replace_latest_fields=true`;
2. API ustawia `atomic_terminal_field_publish=true`;
3. `sync_current_live_frame_update()` wybiera `publish_current_live_realtime_resource_changes_unsplit(..., false, 0)`;
4. cała paczka omija `split_realtime_changes_for_qos()` i 2-sekundowe okno pola.

**Kod:**

- `crates/fullmag-api/src/main.rs`, `sync_current_live_snapshot()`, `sync_current_live_frame_update()` i gałąź `atomic_terminal_field_publish`;
- `crates/fullmag-api/src/main.rs`, `realtime_qos_lane()` oraz `split_realtime_changes_for_qos()`;
- `crates/fullmag-session/src/communication_policy.rs`, `LIVE_REALTIME_FIELD_SAMPLE_COALESCE_WINDOW_MS = 2000`.

**Skutek:** każdy ukończony element kolejki materializera natychmiast uruchamia invalidacje i refetche, zamiast wejść do ograniczonego kanału bieżących próbek.

### FDI-009 — zmiana członkostwa katalogu wywołuje trzy równoległe refetche kontrolne

**Priorytet:** P0
**Status:** CONFIRMED

Każda błędna zamiana pola usuwa poprzednie źródło i dodaje nowe. `apply_effective_field_source_delta()` wykrywa zmianę `Some <-> None`, podbija `field_catalog_revision`, a realtime publikuje `fields:catalog`. Frontend po takim zdarzeniu:

1. odświeża `/data/fields`;
2. jawnie odświeża także `/data/quantities`;
3. przebudowa zależności viewportu powoduje odświeżenie targetowego `m/availability`.

W logu wszystkie trzy zasoby zostały pobrane po 13 razy, dokładnie tyle samo razy, ile wystąpiło natychmiastowych zdarzeń pola.

**Kod:**

- `crates/fullmag-api/src/session.rs`, `apply_effective_field_source_delta()`;
- `apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.ts`, specjalna zależność `DATA_FIELDS_PATH -> DATA_QUANTITIES_PATH`;
- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`, konsumenci katalogu i availability.

**Ocena:** pojedynczy refetch zmienionego zasobu po prawdziwej zmianie członkostwa jest prawidłowy. Trzynaście zmian członkostwa w czternaście sekund przy stałej sesji i domenie jest nieprawidłowe. Po naprawie FDI-000 katalog nie powinien zmieniać rewizji przy zwykłej aktualizacji wartości istniejącego pola, więc ta grupa requestów powinna niemal zniknąć.

### FDI-010 — invalidacja planarna jest zawsze szeroka i obejmuje wszystkie quantity

**Priorytet:** P1
**Status:** CONFIRMED

Każde zdarzenie pola zawierało:

```text
planar_fields:field[H_ani,H_demag,H_eff,H_ex,eden_ani,
eden_demag,eden_ex,eden_total,m,torque]:broad
```

`current_live_realtime_changes_since()` zawęża `quantity_ids` do faktycznie zmienionych wielkości wyłącznie dla `Fields/samples`. Analogiczna zmiana `PlanarFields/field` pozostaje z listą wszystkich kluczy `field_quantity_revisions` i `broad=true`. Ponadto `realtime_qos_lane()` nie klasyfikuje planarnego pola jako `FieldSamples`, więc po usunięciu błędnej ścieżki terminalnej nadal trafi ono do szybszego lifecycle QoS (250 ms), a nie do limitu 2 s.

**Kod:**

- `crates/fullmag-api/src/main.rs`, `current_live_realtime_changes()`;
- `crates/fullmag-api/src/main.rs`, `current_live_realtime_changes_since()`;
- `crates/fullmag-api/src/main.rs`, `realtime_qos_lane()`;
- `apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.ts`, obsługa `planarFieldChange`.

**Skutek:** każdy zamontowany monitor planarny dowolnej quantity może być unieważniany przez aktualizację innej quantity. W tym eksporcie nie widać odpowiadających requestów planarnych, prawdopodobnie dlatego, że zasób nie był w tym oknie aktywnym subskrybentem, ale payload potwierdza latentną burzę po otwarciu widoku 2D.

### FDI-011 — retry ciężkiego pola pracuje na błędnym stanie źródła

**Priorytet:** P1
**Status:** CONFIRMED

Viewport używa dla pola polityki `maxAttempts=5`, `retryAfterMs=250`, `deadlineMs=5000` oraz dodatkowego minimalnego odstępu 2 s między stabilnymi refetchami. Retry `202` jest legalne, ale w logu miesza się z:

- kolejnymi invalidacjami realtime;
- zmianami request collection wywołanymi znikaniem wpisów katalogu;
- `204`, które jest traktowane jako udany `null` i kasuje cache;
- `abortStaleInflight=true`, które restartuje pracę po zmianie rewizji.

W efekcie 11 prób wektora dało tylko dwa bufory. Sama liczba około 45/min mieści się praktycznie na granicy obecnego budżetu, lecz ten budżet nie uzasadnia wielokrotnego pobierania nieadoptowalnego zasobu. Po naprawie źródła retry powinien występować wyłącznie od pierwszego `202` do jednego późniejszego `200`, bez przejścia przez `204` i bez resetowania kolekcji.

### FDI-012 — panel diagnostyczny zaniża rzeczywistą liczbę operacji

**Priorytet:** P1
**Status:** CONFIRMED

`RequestDiagnosticsController` przechowuje krotność agregatu tylko w tekście `detail`; typ `RequestDiagnosticEntry` nie ma pola `count`. `buildTransportTrafficSummary()` liczy `entries.length` oraz zwiększa liczniki endpointów o jeden na wpis. Dlatego podsumowanie stopki traktuje `x5` jak jedną operację.

Dodatkowo `FooterModule.transportEntriesSignature()` składa sygnaturę wyłącznie z `entry.id`. Aktualizacja istniejącego agregatu zachowuje ten sam identyfikator, więc snapshot może zachować tę samą referencję i stopka nie musi odświeżyć czasu, liczby i detail aż do pojawienia się nowego identyfikatora.

**Kod:**

- `apps/control-room/src/kernel/api/RequestDiagnosticsController.ts`, `AggregatedTransportDiagnostic` i `aggregateDiagnosticDetail()`;
- `apps/control-room/src/modules/footer/footerModel.ts`, `buildTransportTrafficSummary()`;
- `apps/control-room/src/modules/footer/FooterModule.tsx`, `transportEntriesSignature()`.

**Skutek:** ręczna ocena panelu systematycznie zaniża natężenie i może ukryć przekroczenie budżetu. Dedykowany smoke Playwright liczy surowe requesty i nie ma tego błędu.

### 10.2. Co jest prawidłowe

- jeden heartbeat w analizowanym oknie odpowiada konfiguracji 15 s;
- około 58 `scalar.sample`/min jest daleko poniżej limitu 360/min;
- architektura `WebSocket invalidates -> HTTP fetches truth` jest zachowana;
- deduplikacja in-flight istnieje, więc nie widać równoległych duplikatów tego samego ciężkiego requestu w tej samej chwili;
- `meta` i binarny vector idą przez centralny facade/resource hook, nie przez bezpośredni komponentowy `fetch()`.

### 10.3. Dodatkowe kryteria naprawy i kwalifikacji

1. Kontrolowany 60-sekundowy `smoke-realtime-communication-budget` przechodzi bez podnoszenia limitów.
2. Bieżące publikacje pola są `coalesced window=2000ms`; `immediate window=0ms` jest zarezerwowane dla rzeczywistej kompletnej publikacji terminalnej i lifecycle commands.
3. Zmiana wartości istniejącej quantity nie podbija `field_catalog_revision` i nie pobiera ponownie `/data/quantities`.
4. `PlanarFields/field` publikuje wyłącznie rzeczywiście zmienione `quantity_ids`, nie `broad`, i korzysta z field-sample QoS.
5. Dla stabilnej sesji pojedynczy aktywny carrier ma co najwyżej sekwencję `202 -> 200`; brak `204` po pierwszym przyjętym `200`.
6. Stopka i eksport posiadają jawne `occurrenceCount`; `Events`, `Rate`, TX/RX i top endpoints używają sumy krotności, a zmiana agregatu odświeża snapshot.
7. Raport runtime zawiera osobno request count, bytes, cache hits, aborts, retry count, broad/exact invalidations, render reasons i `gl.isContextLost()`.

## 11. Zaimplementowana naprawa

### 11.1. Publikacja backendu i QoS realtime

- Terminalne zastąpienie generacji pól jest rozpoznawane wyłącznie przez jawny znacznik publikacji terminalnej albo zakończenie kroku. Częściowe paczki asynchronicznego materializera są scalane z istniejącą generacją, zamiast ją zastępować.
- Zdarzenia `PlanarFields/field` zostały zawężone do rzeczywiście zmienionych quantity i skierowane do tego samego kanału QoS co próbki pól. Nie publikują już szerokiej listy wszystkich wielkości przy każdej zmianie.
- HTTP v2 pozostaje źródłem prawdy. WebSocket nadal wyłącznie unieważnia zasoby; nie dodano drugiej ścieżki transportu danych.

### 11.2. Cache i invalidacja frontendu

- Binarny cache wektorów zachowuje ostatni zgodny bufor po przejściowym `204 not-applicable`. Zachowanie jest opt-in i dotyczy ścieżek field-vector; zasoby topologii nadal są czyszczone po `204`.
- Invalidacja katalogu pól odświeża dokładnie `/data/fields` oraz `/data/quantities`, bez kaskadowego unieważniania wszystkich zasobów potomnych. Eliminuje to zwielokrotnione refetche po jednej zmianie katalogu.
- Została zachowana granica centralnego facade/resource hook; komponenty nie otrzymały bezpośrednich wywołań `fetch()` ani ręcznie składanych adresów v2.

### 11.3. Diagnostyka liczby requestów

- `RequestDiagnosticEntry` ma jawne `firstTimestampMs` i `occurrenceCount`.
- Stopka sumuje rzeczywiste wystąpienia agregatu, a nie liczbę widocznych wierszy. Dotyczy to TX/RX, kanałów, szybkości i rankingu endpointów.
- Aktualizacja istniejącego agregatu podbija wersję store i wymusza odświeżenie stopki mimo niezmienionego `entry.id`.

### 11.4. Pełne próbkowanie Prism6

- Sampler FEM obsługuje natywne elementy Tet4 i Prism6 bez ukrytej dekompozycji pryzmatu na tetraedry.
- Interpolacja Prism6 używa izoparametrycznej bazy triangle-P1 × interval-P1 i odwrotnego mapowania Newtona w przestrzeni referencyjnej.
- Plane, slab, depth/volume, surface oraz overlay używają natywnej geometrii Prism6, w tym dwóch ścian trójkątnych i trzech czworokątnych.
- Domyślny target planarny jest zależny od dziedziny quantity: `magnetic_only`, w tym `m`, wybiera domenę magnetyczną zamiast pełnego airboxu.
- Pyramid5, Hex8, nieciągłe i niekompletne nośniki pozostają jawnie odrzucane; zakres capability nie został rozszerzony bez pokrycia numerycznego.

## 12. Wyniki weryfikacji

| Bramka | Wynik | Status |
|---|---|---|
| testy publikacji terminalnej i scalania częściowych paczek | regresje przechodzą | PASS |
| `cargo test -p fullmag-api realtime_change_tests` | 15/15 | PASS |
| `cargo test -p fullmag-api planar_sampling:: --no-fail-fast` | 53/53 | PASS |
| zarządzany `just verify-planar-sampling-prism6-contract` w profilu `fem-gpu` | oba zestawy Prism6/planar zakończone kodem 0; pełny zestaw planarny 53/53 | PASS |
| testy frontendowe cache, realtime, diagnostyki i lifecycle stopki | 118/118 | PASS |
| `pnpm --dir apps/control-room typecheck` | bez błędów | PASS |
| React Doctor 0.9.12 na Node 24.19 | 100/100, brak diagnostyk | PASS |
| walidator publikacyjnej dokumentacji naukowej | walidator i 28 testów walidatora przechodzą | PASS |
| rzeczywisty smoke otwartej przeglądarki/WebGL | klient in-app browser odrzuca inicjalizację: `sandboxCwd is not a local file URI` | BLOCKED |

## 13. Stan końcowy i pozostałe ryzyko

Naprawione są wszystkie potwierdzone przyczyny rotacji pól, kasowania last-good, nadmiarowych invalidacji, zaniżania liczników oraz stałego `422` dla Prism6. Z testów kontraktowych wynika, że częściowe wyniki materializera nie mogą już usuwać wcześniej opublikowanych pól, a przejściowy brak payloadu nie usuwa widocznego bufora wektorów.

Nie można jeszcze oznaczyć `THREE.WebGLRenderer: Context Lost` jako naprawionego ani nieszkodliwego. Dwie próby połączenia z dokładnie wskazaną przeglądarką aplikacji zakończyły się przed dostępem do strony tym samym błędem infrastruktury narzędziowej. Po przywróceniu połączenia wymagana jest jedna końcowa sesja runtime: co najmniej 60 s, dwa pełne cykle materializera, niezmienna tożsamość canvasu, `gl.isContextLost() === false`, niezerowy drawing buffer, stabilne glyphy oraz pomiar surowych requestów względem budżetu. Jest to brak dowodu przeglądarkowego, a nie znana luka w zaimplementowanym kontrakcie danych.

Pełny przebieg całego pakietu frontendowego nie jest obecnie zielony: poza zakresem tej naprawy istnieje pięć niepowiązanych niepowodzeń oraz trzy pliki bez wykrytego suite. Jedyny ujawniony błąd związany z tym zadaniem — nieaktualny mock diagnostyki w teście lifecycle Quick Chart — został naprawiony i wszedł do powyższego zestawu 118/118. Pozostałych awarii nie maskowano ani nie przypisano tej zmianie.
