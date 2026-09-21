# Porównanie audytów synchronizacji: Codex i Claude

Data: 2026-09-11. Zakres: porównanie wniosków i zaleceń oraz rozstrzygnięcie istotnych rozbieżności na wspólnej bazie kodu. Nie wykonano implementacji.

## 1. Werdykt

**Raporty uzupełniają się, ale nie mają równoważnej podstawy dowodowej.** Raport Codex jest szerszą mapą przepływu end-to-end na konkretnym commicie master. Raport Claude dokładniej wskazuje niektóre mechanizmy renderowania 3D, których pierwszy raport nie rozwinął dostatecznie. Jednocześnie Claude miejscami przedstawia możliwy mechanizm jako potwierdzoną przyczynę obserwowanego migania oraz podaje niezmierzone zyski jako pewne.

Najlepsza baza dalszej pracy to **ustalenia obu raportów ponownie sprawdzone na jednym SHA**, z testem klatek pośrednich. Nie należy wdrażać żadnego z planów bez rozróżnienia retencji poprawnej próbki od wyświetlania pola niezgodnego z nową domeną, quantity lub snapshotem.

## 2. Porównywane dokumenty i wersje

| Cecha | Codex | Claude |
|---|---|---|
| Dokument | `2026-09-11-active-simulation-render-synchronization-audit.md` | `2026-09-11-viewport-3d-live-refresh-flicker-audit.md` |
| Baza | `master`, pełny SHA `fe10f8be750474025fb3c677aa6134c505a9d45d` | Według §2 raportu: drzewo robocze `fix/viewport-3d-audit-s18-s19-upload-20260910`, częściowo snapshot `f565821` z 2026-09-02 |
| Powtarzalność odczytu kodu | Niezmienny eksport przez `git archive` | Mieszanka wersji; sam autor opisuje ograniczenie dostępu do plików |
| Zakres | CLI/runner→API→browser, 3D, 2D, live-charts i opublikowane analizy | Głównie viewport 3D oraz publiczny data plane API |
| Wykonanie | Izolowane probe funkcji źródłowych; bez React/WebGL | Analiza statyczna i wcześniejsze audyty |
| Dowód konkretnego flashu w runtime | Brak | Brak |

Raport Claude odczytano z głównego checkoutu: `/mnt/c/git/fullmag/fullmag/docs/audits/2026-09-11-viewport-3d-live-refresh-flicker-audit.md`; nie ma go w bieżącym worktree. Raport Codex znajduje się w tym worktree. Zachowano oba dokumenty bez zmian.

SHA-256 odczytanych dokumentów:

```text
Codex:  b8a06b79ca35ce2032bc885a2056d0c7cebe79bd62c89ecc57291190540c99ee
Claude: b03ebdae40109ae746571832867ac3649802b11d8c4d4c8fe86bcedd252df7a2
```

W porównaniu sprawdzano kod z eksportu `master fe10f8be…`, nie późniejsze zmiany drzewa roboczego Claude. Bieżący lokalny master nadal wskazywał ten commit. Nie wykonywano fetch/pull ani kwalifikacji zdalnego master.

## 3. Wspólne ustalenia

Oba raporty poprawnie rozpoznają:

- Wskaźnik „następna synchronizacja” szacuje odstęp na podstawie wcześniejszych dostaw; sam nie steruje pollingiem.
- Publiczna ścieżka pól korzysta z FMVP, typed arrays i workera; WebSocket przenosi lekkie zdarzenia, nie masywne pola.
- `ResourceRuntimeStore` zachowuje poprzednie dane podczas refetchu. Sam stan `stale` nie oznacza wyczyszczenia cache.
- Produkcyjny scalar pipeline ma retencję i rozdziela wariant materiału od jego danych; canvas działa demand-driven.
- Anulowanie uploadu i przejściowa niedostępność danych wymagają testów ciągłości, a nie tylko screenshotu po zakończeniu ładowania.
- Zmniejszenie częstotliwości synchronizacji nie usuwa przyczyny błędnych przejść.

Te punkty nie uzasadniają przepisywania UI, zamiany rendererów ani przenoszenia ciężkich payloadów do WebSocket.

## 4. Porównanie ustaleń o renderowaniu

| Finding Claude | Zestawienie z raportem Codex i rozstrzygnięcie |
|---|---|
| VPF-001: reset staged reveal | Uzupełnia R5. Klucz zawiera nie tylko tożsamość sceny/topologii, lecz również flagi dostępności warstw FDM. Zmiana klucza ustawia efektywny etap 0. Potwierdzony mechanizm, ale nie potwierdzona przyczyna każdego ticku. |
| VPF-002: `publish(null)` w scalar upload | Uzupełnia R1/R3. Cztery gałęzie istnieją na master, lecz publikacja null nie oznacza bezwarunkowego usunięcia widocznych kolorów: konsumenci mają własną retencję. Wymaga sprawdzenia całego łańcucha. |
| VPF-003: niesprawiedliwa kolejka i abort bez rollbacku | Abort pokrywa się z R3. Brak rotacji pierwszego hosta jest trafnym nowym findingiem Claude, potwierdzonym również na master, mimo starszej bazy jego analizy. |
| VPF-004: szeroka invalidacja i dodatkowe meta | Trafne uzupełnienie, ale deklarowane liczby GET-ów i renderów nie wynikają z samego kodu; szczegóły w §5. |
| VPF-005: fallback tworzy materiał zależnie od kolorów | Kod potwierdza mechanizm, lecz nie znaleziono produkcyjnego konsumenta tej warstwy. Nie traktować jako przyczyny aktywnego viewportu bez dowodu wykonania. |
| VPF-006: HUD i przejście `vertexColors` | Rozdzielić kosmetykę wskaźnika od utraty warstwy. Zmiana wariantu materiału jest istotna wtedy, gdy odrzucenie retencji rzeczywiście ją wywołuje; sam interwał HUD tego nie dowodzi. |

### 4.1. Reset etapów: korekta mojego R5

W `modules/viewport-3d/layers/Viewport3DScene.tsx:722–747` klucz uwzględnia m.in. `fdmNativeLayerViews.length > 0` i flagi `fdmTargetViews`. Nierówność klucza daje etap 0 (`:761`), a pola stają się dostępne od etapu 2 (`:672–688`). Kolejne etapy uruchamia RAF (`:768–794`); etapowanie czyści przekazywane pola, kolory i segmenty FDM (`:1212–1241`). To jest mocniejszy i dokładniejszy opis niż moje sprowadzenie ryzyka głównie do zmiany topologii.

Nie wynika z niego jednak, że zwykła nowa rewizja pola musi opróżnić kolekcje. Klucz topologii FDM nie zawiera rewizji pola (`useViewport3DSceneModel.ts:4786`), stan budowy zachowuje zgodny poprzedni model (`fdmCuboidBuildState.ts:45–55,76–87`), a puste target views mają konkretne warunki (`viewport3DFdmTargetViews.ts:131–152`). Brak layout/generation również może opróżnić native views (`useViewport3DSceneModel.ts:5599–5606`). Potrzebny jest trace, który pokaże, który warunek zachodzi podczas zgłoszonej synchronizacji.

Przeliczenie klucza z nowych referencji nie jest samo w sobie resetem: porównywana jest wartość stringa. Jej stabilność przy identycznych składnikach jest deterministyczna, nie przypadkowa. Samo przeniesienie resetu do efektu lub opóźnienie o 150 ms nie usuwa błędnej tożsamości i może chwilowo pokazać dane niezgodne z nową domeną. Usunięcie flag gotowości wymaga sprawdzenia scenariuszy inicjalizacji i rzeczywistej zmiany geometrii. Crossfade jest opcją prezentacji, nie naprawą spójności danych.

### 4.2. Null i bezpieczna retencja

Na badanym master `useViewport3DScalarColorUpload.ts` publikuje null w liniach 219, 243, 398 i 432. Trzeba je czytać razem z warunkiem retencji (`:82–104`), committed fallback w `MeshPartLayer.tsx:908–912` i zachowaniem atrybutów w `viewport3dGeometryColors.ts:50–75`. Finding Claude opisuje realne miejsce ryzyka, ale nie dowodzi, że każde wywołanie null zeruje GPU lub znika z ekranu.

Nie przyjmować proponowanego domyślnego `retentionKey = geometry + vertexCount` jako kompletnej tożsamości. Taka sama geometria i liczba wierzchołków mogą dotyczyć innej quantity, jednostki, snapshotu lub etapu. Poprzednią klatkę można zachować podczas pobierania zgodnego następcy, z jawną informacją o wyświetlanej rewizji. Nie wolno jej po cichu przypisać nowej semantyce.

### 4.3. Sprawiedliwość uploadu i fallback

`viewport3dGpuUploadManager.ts:362–396` planuje pracę przez `activeHosts[0]`, a każda nowa klatka zaczyna iterację od indeksu 0. Jeżeli pierwszy host stale zużywa cały budżet, późniejsi mogą długo nie dostać czasu. Brak rotacji jest potwierdzony; rzeczywiste bezterminowe zagłodzenie nie było mierzone. To osobny problem od abortu, który przywraca stan tylko dla statusu `failed` (`:252–269`). Test powinien kontrolować ograniczony czas obsługi wielu hostów i stan częściowo zmodyfikowanych atrybutów po anulowaniu.

`FallbackTopologyMeshLayer.tsx:278–298` rzeczywiście uzależnia nowy `ShaderMaterial` od referencji widocznych kolorów, a wywołania hooka (`:226–263`) nie podają `retentionKey`. Wyszukiwanie wykazało definicję i referencje testowe, bez produkcyjnego użycia. Claude trafnie wskazuje dług techniczny, ale literalne „brak importów poza plikiem” pomija testy. Priorytet niższy niż aktywne ścieżki.

## 5. Invalidacja i liczba requestów: VPF-004

**Trafne nowe ustalenie Claude:** `queueFieldSampleQuantityInvalidation` dopasowuje szeroką rodzinę quantity (`RealtimeInvalidationBridge.ts:736–756`). Po uzyskaniu wektora `invalidateViewport3DFieldMetaResources` dodatkowo invaliduje meta (`viewport3dResources.ts:674–684,1426–1431`). Wywołania po fetchu nie korzystają bezpośrednio z kolejki flush bridge. Mój pierwszy raport powinien był wyraźniej wyróżnić tę potencjalną kaskadę jako osobny punkt wydajnościowy.

**Korekta:** liczba invalidacji nie jest równa liczbie GET-ów ani commitów React. Na master:

1. `invalidateMatching` przechodzi tylko po kluczach z aktywnymi subskrypcjami (`ResourceInvalidationController.ts:83–95`). `invalidatePrefix` zapamiętuje rewizję prefiksu, lecz powiadamia istniejące subskrypcje (`:58–80`). Zależny zasób bez konsumenta nie zaczyna przez to automatycznie pobierania.
2. Identyczna rewizja jest deduplikowana (`:39–43`). ETag różnych scopes może być różny, więc pozostaje realne ryzyko wielu invalidacji, ale nie jest to bezwarunkowe N→N.
3. Runtime ma deduplikację in-flight i koalescencję pending requests. React także może grupować powiadomienia. Bez trace nie wolno deklarować konkretnej liczby renderów lub GET-ów.
4. Samo umieszczenie callbacków w RAF nie zapewni jednego cyklu dla odpowiedzi docierających w różnych klatkach. Do silniejszej gwarancji potrzebny jest wspólny identyfikator publikacji lub świadomie określone okno grupowania.

Probe kontrolera wykonany w tym porównaniu potwierdził: zero invalidacji matching bez subskrypcji; jedno powiadomienie dla dwóch identycznych rewizji; kolejne powiadomienie dla innej rewizji. Nie mierzył HTTP.

**Wniosek:** przyjąć finding o kaskadzie, ale odrzucić jako nieudowodnione „N dodatkowych GET-ów”, „10–15 GET-ów” i „2 ACK na rewizję”. Najpierw zmierzyć request graph. Zawężenie do `/samples/` wymaga testów meta/ranges, materializacji, availability i mapy Default; nie wolno usunąć ich jedynej działającej invalidacji. Zbiorczy endpoint to opcja po pomiarze, nie konieczny pierwszy krok.

## 6. Transport: zgodność i korekty zaleceń Claude

| Finding Claude | Rozstrzygnięcie |
|---|---|
| VPD-001: f64 jako jedyny typ FMVP | Potwierdzone. f32 zmniejsza **sekcję wartości** o połowę, nie cały payload ani automatycznie czas decode o połowę. Nowy kind wymaga jawnego uzgodnienia formatu — dotychczasowy dekoder odrzuca inne kind. |
| VPD-002: brak kompresji HTTP | W sprawdzonym routerze Rust nie znaleziono warstwy kompresji odpowiedzi. Nie dowodzi to braku kompresji na każdej ścieżce wdrożenia; potrzebne rzeczywiste nagłówki i pomiar wire bytes. Zyski 2–4× i „pomijalny CPU” nie zostały zmierzone. |
| VPD-003: zawsze wymuszać `max_samples` | Nie przyjmować globalnie. Budżet glyphów i próbki do kolorowania pełnej powierzchni mają różne wymagania. Uniwersalne próbkowanie może obniżyć jakość, zmienić indeksowanie albo pozbawić shader wartości dla części geometrii. |
| VPD-004: uruchomić ETag / rozważyć delty | ETag **już działa w kodzie live**. Delty są opcją badawczą, nie wykazanym dużym zyskiem: mała zmiana wartości nie oznacza małej liczby zmienionych komórek. |
| VPD-005: pojedynczy worker i trwały fallback | Potwierdzony modułowy worker i zapamiętanie `null` po błędzie konstruktora. Warto dodać jawny stan degradacji i ograniczony retry. Pula 2–4 workerów wymaga benchmarku; może zwiększyć szczytową pamięć i konkurencję. |
| VPD-006: sprzątanie `proto/` | Nie jest naprawą migania. Nie weryfikowano w tym porównaniu kompletnej polityki wykorzystania protobufa; nie włączać usuwania do naprawy viewportu na podstawie samego braku importu. |

### 6.1. ETag jest już podłączony

Ścieżka jest kompletna na poziomie kodu:

```text
loadCachedBinaryResource: request(cached?.etag, signal)
  → api.data.fields.vector(..., { etag })
  → ControlRoomApi: headers["if-none-match"] = options.etag
  → odpowiedź 304
  → zwrot cached.data bez nowego dekodowania
```

Dowody: `viewport3dResources.ts:854,877–887,1410–1414`; `ControlRoomApi.ts:3450,3504–3505`. Zalecenie Claude, by dopiero podłączyć ETag, jest nieaktualne wobec tego master. Nadal potrzebny jest pomiar skuteczności i kosztu przygotowania odpowiedzi 304. Mój raport oddziela te kwestie w T3 i opisuje inną lukę: cache mapy 2D indeksowany pełną rewizją.

### 6.2. F32 i kompresja nie są bezkosztową zmianą

`fieldVectorCodec.ts:45–49,100–115` wymaga f64 i tworzy widok na buforze. Utworzenie takiego widoku nie kosztuje tyle co parsowanie każdego elementu JSON, więc deklaracja „−50% czasu dekodowania” nie wynika z rozmiaru elementu.

F32 może być dobrym osobnym formatem prezentacyjnym, ale należy zachować f64 dla właścicieli danych naukowych i określić błąd kwantyzacji, zakresy, wyprowadzone składowe oraz eksport. To, że końcowy atrybut GPU jest f32, nie dowodzi, że wszystkie operacje poprzedzające upload mogą bezwarunkowo przejść na f32. Nie nazywać takiej zmiany „bez zmiany kontraktu”.

Włączenie kompresji wymaga testu negocjacji kodowania, kompatybilności klienta, kosztu CPU oraz cache/proxy. Brak middleware w Rust jest findingiem źródłowym; stopień kompresji konkretnych tablic jest wynikiem benchmarku. Wyszukiwanie na master znajduje również słowo `compression` w persistence, więc dosłowne twierdzenie Claude „zero wystąpień w całym src” jest za szerokie — nie zmienia to braku znalezionej kompresji HTTP w routerze.

### 6.3. Mój raport obejmuje dodatkową granicę transportu

Claude ocenia głównie browser↔API. Mój T1 wskazuje rzeczywiste `.json(...)` w CLI/runner→API (`crates/fullmag-cli/src/control_room.rs:1624–1638,1719–1729`) i istniejący osobny publisher z koalescencją. Zatem „transport już jest binarny” jest poprawne dla publicznych pól, ale nie dla całego łańcucha. Miganie i koszt dużego JSON wewnętrznego to osobne zadania.

## 7. Co mój raport wnosi poza zakresem Claude

| Ustalenie Codex | Dlaczego pozostaje potrzebne |
|---|---|
| R1: `ready + identity mismatch` pomija zgodny previous envelope | Konkretna granica, na której retencja może przestać działać; probe wykonano w pierwszym audycie |
| R2: globalny chunked build key nie uwzględnia nowego pola | Błąd aktualności kolorów; może istnieć równolegle z miganiem |
| R4: niepełna tożsamość snapshot/stage/phase/view | Granica bezpieczeństwa retencji; szczególnie ważna wobec zalecenia Claude, aby ją domyślnie poluzować |
| S1: możliwe ciągłe anulowanie HTTP przy nowych rewizjach | Dotyczy pobierania, a VPF-003 dotyczy późniejszego uploadu; nie są duplikatami |
| S4: ukrycie refresh error przy last-good payload | UI może wyglądać na stale synchronizujące mimo zakończonego błędu |
| D1/D2: odmontowanie canvasu mapy 2D i brak wspólnego commit warstw | Bezpośrednia ścieżka zaniku obrazu 2D; nie dowodzi przyczyny zgłoszonego 3D |
| Live-charts vs przypięte analysis datasets | Odróżnia zamierzone zamrożenie wyniku analizy od wadliwego odświeżania |
| T1–T3: JSON wewnętrzny, snapshot admission, locki i przygotowanie cache | Uzupełnia audyt transportu oraz publikacji przed dotarciem do UI |

Nie każda pozycja jest równie ważna dla zgłoszonego objawu. Błędy replay, planar i mostu wewnętrznego nie powinny opóźniać małej, potwierdzonej naprawy migania 3D, jeśli nie są jej zależnościami.

## 8. Poprawiona kolejność dalszej pracy

1. Odtworzyć scenę użytkownika na zapisanym SHA i śledzić: stage key, reset reason, displayed/received revision, retention rejection reason, material variant, upload wait oraz widoczność klatek.
2. Ustalić, czy zwykła aktualizacja powoduje `ready↔empty` w kolekcjach FDM lub odrzucenie retencji. Naprawić właściciela identity/gotowości; zachować poprzednią zgodną klatkę bez timeoutów maskujących błąd.
3. Zweryfikować i poprawić sprawiedliwość kolejki uploadu oraz transakcję abort/commit. Nie utożsamiać rollbacku geometrii z rollbackiem mutowanej tablicy kolorów.
4. Uzupełnić regresje R1/R2/R4/S4 i request graph VPF-004 w odpowiednim zakresie. Przed optymalizacją cache upewnić się, że nowe dane nadal docierają i są widoczne.
5. Naprawić lifecycle mapy 2D jako osobny fragment, z testem rodzica przez pełne przejście rewizji.
6. Zmierzyć transfer, JSON mostu, kompresję i representation f32; wybrać zmiany według wyniku. Zachować domyślną jakość wizualizacji.

### Korekta kryteriów akceptacji

Przyjąć od Claude: brak resetu etapu przy samej zmianie pola, brak chwilowego zaniku zgodnej warstwy, pomiar czasu od przyjęcia rewizji do widoczności.

Nie przyjmować jako uniwersalnych bez benchmarku: dokładnie jeden commit React na rewizję, GET-y nie liczniejsze niż quantities, p95 upload ≤2 klatki, zero wszystkich abortów, decode main-thread zawsze 0%. Liczba scopes, rozmiar geometrii, recovery i jawne zmiany semantyki mogą uzasadniać inne wyniki. Należy mierzyć zbędną pracę i zagłodzenie, nie wymuszać arbitralnych liczb kosztem poprawności.

Oba raporty powinny zachować rozróżnienie: potwierdzony mechanizm w kodzie ≠ potwierdzona przyczyna konkretnego nagrania. Dotyczy to także zbyt skrótowego sformułowania „główny problem migania” w streszczeniu mojego pierwszego raportu.

## 9. Wykonane sprawdzenia i ograniczenia

- Odczytano oba raporty, utrwalono ich hashe i sprawdzono SHA lokalnego master.
- Sprawdzono istotne wskazania Claude na eksporcie master: stage/reset, retencja, scheduler, invalidacja, ETag, fallback layer i worker decode.
- Uruchomiono `node /tmp/fullmag-audit-comparison-probe.mjs`: **PASS, exit 0**. Probe wykonuje oryginalny `ResourceInvalidationController` po usunięciu typów przez Node; nie symuluje HTTP ani renderera. Node zgłasza ostrzeżenie o eksperymentalnej transformacji TypeScript.
- Nie powtarzano zielonych probe pierwszego audytu; ich ograniczony zakres pozostaje opisany w tamtym raporcie.
- Nie uruchamiano aplikacji, solvera, przeglądarki, benchmarków ani buildów. Przyczyna zgłoszonego migania w rzeczywistym scenariuszu pozostaje **NOT VERIFIED**.
- Zapisano wyłącznie porównanie; oba raporty źródłowe i kod aplikacji pozostały bez zmian.

Skrócone ścieżki `.ts/.tsx` są względne wobec `apps/control-room/src/`; pełne ścieżki `crates/...` względem repozytorium. Numery linii dotyczą `master fe10f8be…`.
