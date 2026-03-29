# Raport: opoznienia przy przelaczaniu preview `m` / `H_ex` / `H_demag` / `H_eff`

Data: 2026-03-29

## Cel

Wyjasnic, dlaczego zmiana aktywnego pola preview w control roomie trwa zauwazalnie dlugo, szczegolnie przy przelaczaniu miedzy `m`, `H_ex`, `H_demag` i podobnymi polami wektorowymi, oraz wskazac konkretne miejsca do optymalizacji.

## Krotkie podsumowanie

Opoznienie nie ma jednej przyczyny. To suma kilku warstw:

1. Zmiana preview jest zwiazana z cyklem solvera, a nie z natychmiastowym lokalnym przelaczeniem danych.
2. CLI pobiera konfiguracje preview przez polling co 200 ms.
3. Runner generuje nowe preview dopiero przy nastepnym kroku solvera, a potem wykonuje synchronizowany zrzut/downsampling pola.
4. API serializuje i wysyla caly snapshot sesji przez WebSocket, zamiast malego delta-update.
5. To samo pole preview jest duplikowane w payloadzie i w pamieci API.
6. Frontend robi kilka dodatkowych kopii duzych tablic.
7. Renderer 3D przebudowuje wszystkie instancje od zera przy kazdej zmianie pola.

W praktyce oznacza to, ze "czas przelaczenia pola" jest czesciowo:

- czasem oczekiwania na next solver step,
- czasem pobrania preview config przez CLI,
- czasem wygenerowania preview po stronie backendu,
- czasem serializacji i parsowania duzego JSON-a,
- czasem przebudowy renderu 3D/2D po stronie klienta.

## Jak przebiega zmiana pola dzisiaj

1. UI wywoluje `requestPreviewQuantity(...)` w `apps/web/components/runs/control-room/ControlRoomContext.tsx:837`.
2. To robi `POST /v1/live/current/preview/quantity`.
3. API inkrementuje `preview_config.revision`, probuje zbudowac nowy `preview`, serializuje caly `SessionStateResponse` i rozglasza go przez WS:
   - `crates/fullmag-api/src/main.rs:1046-1062`
   - `crates/fullmag-api/src/main.rs:882-895`
4. CLI nie dostaje tej zmiany push-em. Zamiast tego osobny worker odpytuje `GET /v1/live/current/preview/config` co 200 ms:
   - `crates/fullmag-cli/src/main.rs:2773-2780`
   - `crates/fullmag-cli/src/main.rs:2822-2831`
5. Runner sprawdza preview request przy kolejnych krokach solvera. Nowy preview powstaje, gdy zmienil sie `revision` albo nadszedl krok `every_n`:
   - `crates/fullmag-runner/src/dispatch.rs:840-866`
6. Dla FDM native generowanie preview wywoluje `copy_live_preview_field(...)`, ktore:
   - planuje preview grid,
   - wykonuje downsampling,
   - kopiuje wynik do hosta:
   - `crates/fullmag-runner/src/native_fdm.rs:518-582`
   - `native/backends/fdm/src/context.cu:873-1018`
7. API znow buduje top-level `preview`, serializuje caly snapshot i wysyla wszystko do klienta:
   - `crates/fullmag-api/src/main.rs:601-624`
8. Frontend parsuje caly JSON, normalizuje duze tablice, tworzy kolejne kopie i przebudowuje viewport:
   - `apps/web/lib/useSessionStream.ts:351-380`
   - `apps/web/lib/useSessionStream.ts:525-540`
   - `apps/web/components/runs/control-room/ControlRoomContext.tsx:933-938`
   - `apps/web/components/preview/r3f/FdmInstances.tsx:171-320`

## Najwazniejsze przyczyny opoznien

### 1. Preview jest sprzezone z krokiem solvera

To najwiekszy czynnik odczuwalnego laga.

Runner nie przelicza preview natychmiast po zmianie UI. Nowy preview powstaje dopiero wtedy, gdy solver dojdzie do miejsca, w ktorym sprawdza request preview:

- `crates/fullmag-runner/src/dispatch.rs:840-866`

To oznacza:

- jezeli jeden krok solvera trwa dlugo, UI czeka co najmniej tyle,
- jezeli demag/exchange sa drogie dla danego problemu, przelaczenie na te pola dziedziczy ten koszt,
- jezeli solver jest wstrzymany, nowy preview moze w ogole nie nadejsc.

### 2. Dodatkowy lag przez polling configu co 200 ms

CLI aktualizuje lokalny `LivePreviewRequest` przez polling HTTP:

- `crates/fullmag-cli/src/main.rs:2773-2780`

To doklada srednio ~100 ms, a w najgorszym przypadku ~200 ms, zanim runner w ogole zobaczy zmiane.

To nie jest najwiekszy koszt, ale jest stale odczuwalnym skladnikiem opoznienia.

### 3. Synchronous preview extraction z backendu

Po stronie FDM native preview nie korzysta z delta-update na juz gotowym buforze HTTP/UI. Runner wywoluje synchronizowany zrzut pola:

- `crates/fullmag-runner/src/native_fdm.rs:518-582`

W CUDA dzieje sie:

- kernel downsamplujacy preview,
- potem `cudaMemcpy` device-to-host:
  - `native/backends/fdm/src/context.cu:969-1018`

To jest poprawne funkcjonalnie, ale nadal kosztowne, zwlaszcza gdy:

- grid jest duzy,
- `max_points` jest wysokie,
- pole jest aktualizowane czesto,
- solver i preview walcza o ten sam budzet GPU/CPU.

### 4. Pelny snapshot sesji jest serializowany i wysylany przy kazdej zmianie

To bardzo kosztowna decyzja architektoniczna.

API po zmianie preview i po kazdym publish:

- sklada `SessionStateResponse`,
- serializuje caly stan do JSON,
- wysyla go przez WS jako tekst:
  - `crates/fullmag-api/src/main.rs:601-624`
  - `crates/fullmag-api/src/main.rs:1046-1062`
  - `crates/fullmag-api/src/main.rs:882-895`

W tym snapshotcie sa nie tylko dane preview, ale rowniez:

- `scalar_rows`,
- `engine_log`,
- `artifacts`,
- metadata,
- run/session manifest,
- live state.

Im dluzszy run, tym wiekszy payload, nawet jesli user zmienil tylko pole preview.

### 5. To samo preview jest duplikowane w API i w payloadzie

To szczegolnie nieefektywne.

Najpierw runner przesyla `live_state.latest_step.preview_field`.
Potem API buduje z tego osobne top-level `preview`, kopiujac `vector_field_values`:

- `crates/fullmag-api/src/main.rs:1086-1099`
- `crates/fullmag-api/src/main.rs:1295-1325`

Skutek:

- jedna duza tablica z wektorami siedzi w `live_state.latest_step.preview_field`,
- druga taka sama tablica siedzi w `preview`,
- obie sa serializowane do JSON,
- obie zajmuja pamiec po stronie serwera.

Przy 3D preview i `max_points = 65_536` (`crates/fullmag-runner/src/types.rs:135-147`) oznacza to do `196_608` liczb dla samego pola wektorowego. W JSON to juz sa megabajty danych. Po podwojeniu robi sie bardzo kosztowne.

### 6. Frontend robi dodatkowe kopie duzych tablic

Po odebraniu snapshotu klient wykonuje kolejne kopie:

1. `normalizeSessionState(...)` materializuje `preview.vector_field_values`:
   - `apps/web/lib/useSessionStream.ts:394-408`
2. `ControlRoomContext` robi `new Float64Array(...)`:
   - `apps/web/components/runs/control-room/ControlRoomContext.tsx:933-938`
3. Dla FEM dodatkowo budowane sa kolejne tablice `x/y/z`.

To oznacza, ze jedna zmiana pola to nie tylko transfer, ale tez kilka kosztownych alokacji i kopiowan w JS.

### 7. Renderer 3D przebudowuje wszystkie instancje od zera

`MagnetizationView3D` dostaje `ctx.previewGrid`, wiec nie renderuje pelnego solver gridu:

- `apps/web/components/runs/control-room/ViewportPanels.tsx:390-406`

To jest akurat dobre.

Ale sam `FdmInstances` przy kazdej zmianie `vectors`:

- skanuje cala tablice, zeby policzyc `maxMagnitude`,
- przechodzi drugi raz po wszystkich punktach,
- aktualizuje `instanceMatrix` i `instanceColor` dla kazdej instancji:
  - `apps/web/components/preview/r3f/FdmInstances.tsx:171-320`

To daje koszt O(N) przy kazdym przelaczeniu, nawet jesli zmiana dotyczy tylko koloru i orientacji instancji.

### 8. 2D preview tez przelicza cale pole po stronie klienta

W 2D `MagnetizationSlice2D` buduje `points` od zera dla calej warstwy:

- `apps/web/components/preview/MagnetizationSlice2D.tsx:136-191`

Potem aktualizuje caly chart ECharts.

To zwykle jest tansze niz sciezka 3D, ale przy duzych preview gridach tez dorzuca opoznienie.

### 9. Domyslny budzet preview jest duzy

Domyslnie:

- `every_n = 10`
- `max_points = 65_536`

zdefiniowane w:

- `crates/fullmag-runner/src/types.rs:131-147`

`65_536` punktow dla 3D to duzo jak na interaktywny podglad, szczegolnie gdy kazdy punkt ma 3 skladowe, przechodzi przez JSON i potem przez instancing w przegladarce.

### 10. Zmiana pola w pauzie ma slaby fallback

API potrafi zbudowac preview z `live_state.latest_step.preview_field` tylko wtedy, gdy zgadza sie revision i quantity:

- `crates/fullmag-api/src/main.rs:1086-1090`

Dla `m` jest fallback do `live_state.latest_step.magnetization`, ale dla `H_ex`, `H_demag`, `H_eff` API oczekuje `latest_fields.*`, ktorych aktualny live publish nie dostarcza:

- `crates/fullmag-api/src/main.rs:1457-1483`
- `crates/fullmag-api/src/main.rs:1843-1935`

W praktyce oznacza to, ze przy wstrzymanym solverze zmiana na `H_ex` lub `H_demag` moze wygladac jak "nic sie nie dzieje", bo backend nie ma od razu z czego zbudowac nowego preview.

## Co jest najbardziej prawdopodobnym glownym winowajca

Jesli user czuje, ze przelaczenie pola trwa "strasznie dlugo", to najbardziej prawdopodobna kombinacja jest taka:

1. UI wysyla zmiane.
2. CLI widzi ja dopiero po pollingu.
3. Runner czeka do nastepnego kosztownego kroku solvera.
4. Runner robi preview copy + D2H.
5. API kopiuje preview drugi raz.
6. API serializuje ogromny JSON snapshot.
7. Frontend parsuje i kopiuje duze tablice.
8. R3F przebudowuje wszystkie instancje.

Najwiekszy realny wplyw maja:

- gating na solver step,
- pelny snapshot JSON,
- duplikacja preview danych,
- frontendowe kopie i O(N) rebuild renderu.

## Rekomendowane optymalizacje

### Priorytet A: najwiekszy zysk / najmniejsze ryzyko

1. Nie duplikowac preview wektora w `live_state.latest_step.preview_field` i `preview`.
   Zamiast tego:
   - trzymac tylko `preview_field` jako source of truth,
   - a top-level `preview` ograniczyc do lekkiego metadata albo w ogole usunac.

2. Przestac wysylac pelny `SessionStateResponse` przy kazdej zmianie preview.
   Lepiej:
   - osobny kanal/delta message dla preview,
   - osobny kanal dla scalar rows,
   - osobny kanal dla engine log.

3. Obnizyc domyslne `max_points` dla 3D.
   Propozycja:
   - 3D: `16_384` albo `24_576`
   - 2D: zostawic wyzej

4. Usunac niepotrzebne kopie po stronie klienta.
   Konkretnie:
   - nie robic `flatMap` dla `vector_field_values`,
   - nie robić `new Float64Array(...)` jesli nie trzeba,
   - przechowywac juz zmaterializowany typed array w stanie.

### Priorytet B: duzy zysk architektoniczny

5. Zastapic polling preview config push-em.
   Dzisiaj:
   - `crates/fullmag-cli/src/main.rs:2773-2780`
   Docelowo:
   - event-driven update,
   - albo reuse istniejacego command queue,
   - albo osobny lightweight ws/subscription.

6. Rozlaczyc preview od cadence solvera.
   Docelowo zmiana pola powinna uruchamiac "preview refresh" niezalezny od `every_n`.
   `every_n` moze zostac tylko dla cyklicznych aktualizacji podczas biegu.

7. Dodac obsluge preview refresh w stanie pause/awaiting_command.
   To mozna zrobic przez:
   - bezposredni call do backend snapshot API,
   - albo komendę "refresh_preview" wykonywana bez kroku solvera.

### Priorytet C: sredni zysk, ale warto

8. Uzyc binarnego transportu dla preview vectors.
   JSON dla duzych tablic liczb jest drogi.
   Lepsze opcje:
   - WebSocket binary frame,
   - MessagePack / CBOR,
   - osobny endpoint zwracajacy ArrayBuffer.

9. Uzyc async snapshot machinery dla FDM preview.
   Backend ma juz asynchroniczne snapshoty pol:
   - `crates/fullmag-runner/src/native_fdm.rs:493-517`
   - `native/backends/fdm/src/context.cu:1071-1252`

   Dzisiejszy preview path używa synchronicznego `copy_live_preview_field(...)`.
   Wartym rozwazenia kierunkiem jest:
   - async staging/copy,
   - overlap z dalsza praca solvera lub publikacji.

10. Zoptymalizowac render 3D.
   Potencjalne kierunki:
   - trzymac osobny indeks widocznych / samplowanych komorek,
   - nie iterowac po wszystkich punktach, jesli `sampling > 1`,
   - ograniczyc przebudowe do buforow koloru/orientacji,
   - w przyszlosci przeniesc preprocessing do web workera.

## Proponowana kolejnosc wdrozenia

### Etap 1: szybkie poprawki

1. Obnizyc domyslne `max_points`.
2. Usunac duplikacje `preview_field` -> `preview.vector_field_values`.
3. Zredukowac frontendowe kopie tablic.

Oczekiwany efekt:

- wyraznie mniejsze payloady,
- mniejsze peak memory,
- szybszy parse i repaint.

### Etap 2: poprawki transportu

4. Zmienic WS z full snapshot na delta updates.
5. Rozdzielic preview transport od scalar/log history.

Oczekiwany efekt:

- duzy spadek opoznien wraz z dlugoscia runu,
- lepsza skalowalnosc.

### Etap 3: poprawki backend runtime

6. Usunac polling 200 ms.
7. Dodac on-demand preview refresh poza cadence solvera.
8. Dodac obsluge paused preview dla `H_ex/H_demag/H_eff`.

Oczekiwany efekt:

- poprawa responsywnosci "na klik",
- brak wrazenia, ze UI "nie reaguje".

## Najbardziej praktyczna rekomendacja

Gdybym mial wdrozyc tylko trzy rzeczy najpierw, zrobilbym:

1. usuniecie duplikacji preview danych w API,
2. delta transport zamiast full snapshot JSON,
3. natychmiastowy preview refresh bez 200 ms pollingu i bez czekania na `every_n`.

To powinno dac najwieksza poprawę odczuwalna przez usera bez zmiany modelu fizycznego solvera.

## Dodatkowa uwaga

Obecna implementacja jest funkcjonalnie sensowna i prosta do utrzymania, ale jest zoptymalizowana bardziej pod "spojnosc stanu" niz pod "latencje interakcji". Dla control-room preview to jest glowny trade-off, ktory teraz zaczyna byc widoczny.

## Porownanie z amumax i BORIS

### Krotka odpowiedz

To, ze w `amumax` albo `BORIS` zmiana wyswietlanej wielkosci wyglada na "natychmiastowa", nie bierze sie z jednego magicznego kernela. Zwykle bierze sie z duzo lzejszej sciezki:

- mniej hopow miedzy UI i solverem,
- mniej serializacji i kopiowania danych,
- tanszy transport,
- mniej agresywnej przebudowy renderu po stronie klienta,
- lepszego rozdzielenia "zmiany tego, co ogladam" od "pelnego cyklu obliczeniowego i publikacji stanu".

W Fullmag dzisiaj klik preview idzie przez dluga sciezke `UI -> API -> CLI polling -> runner -> sync preview copy -> full WS JSON snapshot -> React/R3F rebuild`.

W `amumax` i `BORIS` ta sciezka jest krotsza.

### Co potwierdzaja oficjalne zrodla

#### amumax

Z publicznego repo `amumax` mozna potwierdzic trzy rzeczy:

1. To jest jeden binarny program z wbudowanym WebUI, a nie osobne `frontend -> API -> CLI -> runner` jak w Fullmag:
   - `main.go` uruchamia `cli.Entrypoint()`,
   - `src/api/echo.go` stawia WebUI i WebSocket oraz inicjalizuje wspolny `EngineState`.

2. Transport live-state jest binarny, nie tekstowy JSON:
   - backend robi `msgpack.Marshal(...)` i wysyla `websocket.BinaryMessage` w `src/api/websocket.go`,
   - frontend odbiera `ArrayBuffer`, robi `decode(...)` MessagePack i aktualizuje dedykowane store'y w `frontend/src/api/websocket.ts`.

3. Frontend preview aktualizuje dedykowany stan preview i moze zrobic lekki update renderu:
   - `frontend/src/api/incoming/preview.ts` ma osobny `previewState`,
   - `frontend/src/lib/preview/preview3D.ts` robi `update()` istniejacego `InstancedMesh`, jesli `refresh == false`,
   - `frontend/src/lib/preview/preview2D.ts` robi `chartInstance.setOption(...)` na istniejacym wykresie.

Do tego README `amumax` wprost deklaruje "improved WebUI" oraz zapis danych do `Zarr` przez `pyzfn`, z naciskiem na bardziej efektywne przetwarzanie wynikow. To nie jest dowod 1:1 na live-preview latency, ale jest spojnym sygnalem, ze architektura danych i UI byla tam projektowana pod lzejsza obsluge wynikow.

Uczciwe zastrzezenie: w publicznie przejrzanym przeze mnie fragmencie repo `amumax` widac tez periodyczny broadcast stanu po krokach solvera w `src/api/websocket.go`. Nie wyciagnalem natomiast w tej analizie konkretnego handlera backendowego `preview/quantity`, wiec nie twierdze, ze kazda zmiana quantity omija cadence solvera. Twierdze cos weziej i pewniej: ich sciezka UI/transport/render jest wyraznie lzejsza niz w Fullmag.

#### BORIS

Z publicznego repo `BORIS` mozna bezpiecznie potwierdzic:

1. To jest natywna aplikacja z wbudowanym GUI, uruchamiana jako `./BorisLin`.
2. GUI bylo pierwotnie napisane w `DirectX11`.
3. Nie jest to architektura przegladarka + osobny serwer + osobny CLI/runner, tylko zintegrowany program obliczeniowo-graficzny.

To bardzo zmienia koszt interakcji. Przy takim ukladzie zmiana wyswietlanej wielkosci jest zwykle blizsza:

- zmianie aktywnego widoku / bufora / warstwy renderu,
- lokalnemu odswiezeniu stanu GUI,
- ewentualnie lekkiej aktualizacji buforow,

a nie pelnemu round-tripowi przez HTTP, WebSocket tekstowy, serializacje JSON i przebudowe przegladarkowego renderera.

Uczciwe zastrzezenie: tutaj porownanie jest bardziej architektonicznym wnioskiem z oficjalnego README/manuala niz linia-po-linii z jednym konkretnym handlerem "change displayed quantity".

### Tabela porownawcza

| Aspekt | Fullmag | amumax | BORIS |
| --- | --- | --- | --- |
| Model aplikacji | przegladarka + API + osobny CLI + runner + backend native | jeden binarny program z WebUI i wspolnym `EngineState` | jeden natywny program z GUI i solverem |
| Sterowanie zmiana quantity | `POST` do API, potem CLI widzi to przez polling co 200 ms | `POST ./api/preview/...` do lokalnego API tego samego programu | lokalna akcja GUI w tej samej aplikacji |
| Dodatkowy hop kontrolny | tak: osobny CLI polling | brak dowodu na osobny zewnetrzny hop typu Fullmag CLI | nie |
| Transport live-state | tekstowy WS z pelnym snapshotem JSON | binarny WS z `msgpack` | brak przegladarkowego transportu; natywny stan procesu |
| Koszt payloadu | wysoki: preview + scalar rows + log + metadata | nizszy: binary msgpack + osobne store'y | najnizszy z tej trojki dla samego display switch |
| Duplikacja preview po stronie UI/API | tak, widoczna | nie widac podobnie ciezkiej duplikacji jak w Fullmag | nie dotyczy w ten sam sposob |
| Aktualizacja rendererow | React + kolejne kopie tablic + O(N) rebuild instancji | Svelte store + `preview3D.update()` / `preview2D.setOption(...)` | natywny renderer GUI |
| Czy zmiana jest sprzezona z kolejnym solver step | tak, mocno | nieudokumentowane w 100%, ale architektura UI/render jest lzejsza | zwykle slabiej sprzezona jako osobny round-trip |
| Dlaczego wyglada szybciej | bo tu jest najdluzsza sciezka i najwiecej kopii | krotsza sciezka, binary transport, in-place update renderu | brak web-stacka i brak serializacji przegladarkowej |

### Dlaczego u nich to jest "natychmiastowe"

Najuczciwiej byloby powiedziec tak:

- w `BORIS` to jest najblizej naprawde natychmiastowego lokalnego przelaczenia, bo GUI i solver zyja w jednym natywnym procesie;
- w `amumax` to jest raczej "natychmiastowe w odczuciu", bo nadal jest WebUI, ale ich sciezka jest duzo lzejsza niz w Fullmag;
- w Fullmag opoznienie jest sumowane przez kilka warstw naraz, wiec nawet jesli kazda pojedyncza warstwa nie jest tragiczna, razem daja duzy lag.

Innymi slowy: `amumax` i `BORIS` niekoniecznie "licza niczego mniej". One po prostu znacznie mniej placa za sama obsluge interakcji.

### Co z tego wynika dla Fullmag

Jesli celem jest UX blizszy `amumax` i `BORIS`, to Fullmag powinien dojsc przynajmniej do tego poziomu:

1. zero CLI pollingu dla preview config,
2. preview update jako dedykowany, lekki komunikat zamiast pelnego snapshotu sesji,
3. binary transport dla preview,
4. brak duplikacji preview vector data,
5. renderer aktualizowany in-place, a nie przez kosztowne kopie i przebudowy,
6. preview refresh niezalezny od cadence solvera,
7. sensowny cache ostatnich pol `H_ex/H_demag/H_eff`, zeby zmiana widoku byla "display switch", a nie "prosba o nowa publikacje calego stanu".

To jest w praktyce glowna roznica miedzy "viewer feels instant" a "viewer feels heavy".

## Zrodla zewnetrzne

- amumax README: https://github.com/MathieuMoalic/amumax/blob/main/README.md
- amumax frontend websocket: https://github.com/MathieuMoalic/amumax/blob/main/frontend/src/api/websocket.ts
- amumax backend websocket: https://github.com/MathieuMoalic/amumax/blob/main/src/api/websocket.go
- amumax preview store: https://github.com/MathieuMoalic/amumax/blob/main/frontend/src/api/incoming/preview.ts
- amumax preview 3D: https://github.com/MathieuMoalic/amumax/blob/main/frontend/src/lib/preview/preview3D.ts
- amumax preview 2D: https://github.com/MathieuMoalic/amumax/blob/main/frontend/src/lib/preview/preview2D.ts
- amumax app entry/API init: https://github.com/MathieuMoalic/amumax/blob/main/main.go
- amumax echo/webui init: https://github.com/MathieuMoalic/amumax/blob/main/src/api/echo.go
- BORIS README: https://github.com/SerbanL/Boris2/blob/master/README.md

## Status wdrozenia etapu 1

Stan na 2026-03-29:

W repo wdrozono juz pierwszy, niskiego ryzyka pakiet zmian pod preview latency:

1. `live_state.latest_step.preview_field` nie jest juz serializowany do klienta.
   To usuwa najciezszy oczywisty duplikat payloadu, bo frontend i tak korzysta z top-level `preview`.

2. Domyslny backendowy `max_points` zostal obnizony z `65_536` do `16_384`.
   To zrownuje backend z istniejacym frontendowym defaultem i redukuje koszt 3D preview out-of-the-box.

3. Frontend normalizuje pola wektorowe do `Float64Array` tylko raz, na etapie `normalizeSessionState(...)`.
   Dotyczy to:
   - `latest_fields.*`,
   - `live_state.latest_step.magnetization`,
   - `preview.vector_field_values`.

4. `ControlRoomContext` przestal robic kolejne kopie `new Float64Array(...)` przy wyborze aktualnie renderowanego pola.
   Viewer reuse'uje teraz juz zmaterializowane bufory.

To nie zamyka jeszcze calego etapu 1, bo nadal zostaje:

- full snapshot JSON zamiast lekkiego delta preview update,
- koszt O(N) render rebuild w `FdmInstances`,
- sprzezenie preview z cadence solvera i CLI pollingiem.

Ale ten pakiet juz zmniejsza:

- rozmiar payloadu,
- liczbe alokacji po stronie klienta,
- koszt domyslnego preview 3D.

## Status wdrozenia etapu 2

Stan na 2026-03-29:

W repo wdrozono tez pierwszy preview-delta path po websocketach:

1. `crates/fullmag-api` nie wysyla juz zmiany preview jako pelnego `SessionStateResponse`.
   WebSocket i SSE uzywaja teraz envelope:
   - `kind = "snapshot"` dla pelnych publikacji stanu,
   - `kind = "preview"` dla lekkiej zmiany `preview_config` + `preview`.

2. Endpointy od zmiany preview (`quantity`, `component`, `layer`, `max_points`, itd.) rozglaszaja juz tylko event `preview`.
   Pelny snapshot zostaje dla bootstrapu i dla zmian rzeczywistego stanu sesji, np. nowego kroku solvera lub importu assetu.

3. Frontend `useSessionStream` umie teraz:
   - rozpakowac event `snapshot`,
   - zmergowac event `preview` bez wymiany calego `SessionState`,
   - zachowac kompatybilnosc wstecz z legacy payloadem bez pola `kind`.

4. Solver publish path zostal dodatkowo odchudzony po wykryciu timeoutow `POST /v1/live/current/publish`.
   API nie serializuje juz top-level `preview` do kazdego solverowego snapshotu.
   Zamiast tego:
   - zwykly publish wysyla lzejszy `snapshot` bez `preview`,
   - swiezy preview z backendu leci osobnym eventem `preview`,
   - przebudowa top-level `preview` odbywa sie tylko wtedy, gdy solver faktycznie dostarczyl nowe `preview_field`.

Efekt praktyczny:

- klikniecie `m -> H_demag -> H_ex` nie powinno juz kopiowac przez WS:
  - scalar rows,
  - engine log,
  - artifacts,
  - latest fields,
  - pozostale pola sesji niezwiazane z preview.

To usuwa najciezszy narzut transportowy z samego przelaczenia preview, ale nadal nie rozwiazuje jeszcze:

- CLI pollingu co 200 ms,
- oczekiwania na kolejny solver step, jesli backend nie ma juz gotowego preview,
- O(N) rebuildu instancji po stronie `FdmInstances`.

## Status wdrozenia etapu 3

Stan na 2026-03-29:

CLI nie opiera sie juz na stalych requestach `GET /preview/config` co 200 ms.

Wdrozone zmiany:

1. `fullmag-api` utrzymuje teraz kanal zmian `current_preview_config` i wystawia endpoint wait:
   `GET /v1/live/current/preview/config/wait?afterRevision=...&timeoutMs=...`

2. Zmiana preview (`quantity`, `component`, `layer`, `max_points`, itd.) budzi oczekujacego klienta natychmiast, zamiast czekac na nastepny tick pollera.

3. `fullmag-cli` trzyma ostatni `revision` i blokujaco czeka na nastepna zmiane configu.
   Dopiero gdy wait endpoint zwroci timeout albo API jest chwilowo niedostepne, uruchamiany jest lekki fallback.

Efekt praktyczny:

- znika stale lokalne odpytywanie API co 200 ms,
- preview config dochodzi do runnera od razu po zmianie,
- idle workspace nie generuje juz pustego ruchu request/response.

To nie usuwa jeszcze samego kosztu generacji preview w solverze, ale usuwa zbedny control-plane latency i szum.

## Status wdrozenia etapu 4

Stan na 2026-03-29:

Sciezka renderu `FdmInstances` zostala odchudzona po stronie React/R3F:

1. `MagnetizationView3D` przekazuje do rendererow odroczone `vectors` i `settings` przez `useDeferredValue(...)`.
   Toolbar i interakcje pozostaja responsywne, nawet gdy aktualizacja instancji jest ciezka.

2. `FdmInstances` jest memoizowany i aktualizuje instancje przez bezposredni zapis do `mesh.instanceMatrix.array`, bez `setMatrixAt(...)` w kazdej iteracji.

3. Tryb glyph nie wykonuje juz pelnego skanu `maxMagnitude`, ktory byl potrzebny tylko dla voxelowego strength scaling.

4. Dla voxel/geometry path macierze translacji i skali sa skladane bez kosztu `Object3D.updateMatrix()` na kazdej komorce.

Efekt praktyczny:

- mniejszy koszt CPU przy przelaczaniu pola preview,
- mniejszy koszt dragowania suwakow 3D,
- mniej worku na glownym watku przy rebuildu siatki instancji.

Najwieksze pozostale ograniczenie to nadal O(N) przeliczenie instancji przy rzeczywistej zmianie pola wektorowego.
To jest juz jednak koszt zwiazany z realna zmiana danych, a nie zbedny narzut transportu i plumbingu.
