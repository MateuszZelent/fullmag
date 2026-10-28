# ADR 0069 — zakładki sesji w Control Room jako instancje

Status: decyzja użytkownika przyjęta 23.10.2026 („Tab = instancja”).
Data: 2026-10-23.
Powiązane: ADR 0067 (niezależne grupy DEV, automatyczny port),
ADR 0068 (tryb live DSL, sesja wspólna ze skryptem Python).

## Kontekst

Użytkownik chce w Control Room układu jak w przeglądarce: stała zakładka Home
i osobna zakładka dla każdej sesji. Backend utrzymuje jedną sesję live na
proces API (`AppState.current_live_state`); wszystkie trasy sesji mają postać
`/v2/sessions/current/...`. Każda grupa DEV (i każda instancja runtime)
publikuje frontend Next.js na własnym porcie loopback, a frontend przekazuje
`/v2/*` do swojego API. Jeden port to więc jedna instancja: UI, API i sesja
w zgodnych wersjach. Skrypt Python łączy się z tym samym adresem
(`fm.connect("http://127.0.0.1:<port>")`).

Rozważone warianty:

1. zakładka = instancja (wybrany),
2. wiele sesji w jednym API (`/v2/sessions/{id}/...`; przebudowa stanu API
   i setek tras),
3. jedna sesja live i zakładki historii tylko do odczytu.

## Decyzja

1. **Tożsamość zakładki.** Zakładka to port instancji; zapisywany jest tylko
   port. Port wyznacza origin `http://<host strony>:<port>`; nazwa hosta jest
   brana z bieżącej strony, więc `localhost` i `127.0.0.1` nie mieszają się.
   Etykieta zakładki zawsze pokazuje bieżącą sesję instancji z wykrywania,
   a nie zapamiętaną. Jeśli po zatrzymaniu grupy jej port przejmie inny
   checkout (rotacja z ADR 0067 dotyczy tylko nowych grup), zakładka pokazuje
   nazwę sesji tej nowej instancji; nie udaje poprzedniej. Wariant (port,
   `session_id`) wróci razem z wieloma sesjami w jednym API (wariant 2).

2. **Wykrywanie instancji w backendzie.** `GET /v2/platform/instances`
   sprawdza ograniczone okno portów loopback i zwraca instancje Fullmag,
   które odpowiedziały poprawną listą sesji:
   - okno domyślne `3197-3260` (port preferowany i 64 porty rotacji launchera
     z ADR 0067); zmienna `FULLMAG_INSTANCE_DISCOVERY_PORTS=<od>-<do>`,
     najwyżej 256 portów;
   - host: `FULLMAG_INSTANCE_DISCOVERY_HOST`, a bez niej `host.docker.internal`,
     gdy ta nazwa się rozwiązuje (kontener Docker Desktop), w przeciwnym razie
     `127.0.0.1`;
   - każda sonda to jedno żądanie `GET /v2/sessions HTTP/1.0` bez poświadczeń,
     z limitem połączenia 300 ms, limitem całości 1,5 s i limitem odpowiedzi
     256 KiB; brak przekierowań;
   - instancją Fullmag jest tylko odpowiedź 200 z nagłówkiem
     `x-fullmag-api-instance` i treścią `SessionListResource`; port z inną
     odpowiedzią (np. frontend z zatrzymanym backendem albo obca usługa) nie
     jest instancją;
   - własna instancja jest rozpoznawana po identyfikatorze procesu API
     (`x-fullmag-api-instance`) i oznaczona `self: true`;
   - jedno przejście sond obsługuje wszystkie żądania w ciągu 2 s
     (single-flight z krótkim cache), więc kilku przeglądających nie mnoży
     sond.

   Wykrywanie robi backend, a nie przeglądarka, bo sondy z przeglądarki do
   zamkniętych portów zapisują błędy `ERR_CONNECTION_REFUSED` w konsoli, którą
   sprawdzają testy przeglądarkowe.

3. **Treść zakładki.** Sesja własnej instancji to istniejący workspace (bez
   ramki). Zakładka innej instancji osadza jej własne UI w `iframe` z jej
   originu, więc UI zawsze pasuje do wersji API tej instancji. Ramka ma
   nazwę `fullmag-instance-tab`; osadzone UI sprawdza `window.name` i tylko
   wtedy nie rysuje własnego paska zakładek ani sekcji innych instancji.
   Inne osadzenia (np. podgląd w IDE) zachowują pełną powłokę.

   To jest jawny wyjątek od zasady „jeden workspace, jeden viewport” z
   `.agents/instructions/frontend.md`: strona hosta nadal ma jeden workspace
   i jeden viewport, a każda ramka to osobny dokument innej instancji z jej
   własnym klientem API, nie drugi workspace tej samej aplikacji.

4. **Nagłówki ramek.** CSP `frame-ancestors` i `frame-src` dopuszczają
   `'self'` oraz dokładnie originy `http://127.0.0.1:<port>` i
   `http://localhost:<port>` dla portów okna wykrywania (ta sama zmienna
   `FULLMAG_INSTANCE_DISCOVERY_PORTS`), bez `https` i bez wieloznacznych
   portów. Nagłówek `X-Frame-Options` jest usunięty, bo nie wyraża listy
   originów, a przy `frame-ancestors` przeglądarki go pomijają.

   **Ryzyko do akceptacji przez użytkownika.** Control Room nie ma
   uwierzytelnienia i udostępnia komendy niszczące. Każdy serwer lokalny,
   który nasłuchuje na porcie z okna wykrywania (np. inny serwer
   deweloperski), może osadzić Control Room i próbować clickjackingu.
   Strony zdalne i porty spoza okna pozostają zablokowane.

5. **Cykl życia zakładek.** Zamknięcie zakładki usuwa ramkę i nigdy nie
   zatrzymuje sesji ani instancji. Nieaktywne ramki pozostają zamontowane
   (ukryte przez `visibility`), aby zachować stan widoku i kontekst WebGL,
   ale najwyżej 3 ostatnio używane (LRU). Starsza ramka jest odmontowywana i
   ładuje się od nowa przy powrocie. Razem z viewportem hosta daje to
   najwyżej 4 konteksty WebGL na stronę, wyraźnie poniżej limitu
   przeglądarki (zwykle 16 aktywnych na stronę).

   **Wstrzymanie ukrytej ramki.** Ramkę ukrywa CSS hosta, więc w ramce
   `document.visibilityState` pozostaje `visible`. Dlatego host sam mówi
   ramce, czy jej zakładka jest na wierzchu. Obie strony wysyłają
   `postMessage` z jawnym `targetOrigin` (originem drugiej strony), nigdy
   z `*`:
   - host → ramka: `{type: "fullmag.instance-tab.visibility", visible}`.
     Host wysyła go przy aktywacji i dezaktywacji zakładki, po zdarzeniu
     `load` ramki i w odpowiedzi na `ready`. `targetOrigin` to origin
     instancji ramki.
   - ramka → host: `{type: "fullmag.instance-tab.ready"}`, gdy ramka zacznie
     nasłuchiwać. Skrypty ramki mogą ruszyć dopiero po jej `load`, więc
     komunikat wysłany przy `load` może przepaść. Origin hosta ramka bierze
     z `location.ancestorOrigins`, a bez niego (Firefox) z
     `document.referrer`. Wysyła `ready` tylko wtedy, gdy ten origin
     przechodzi tę samą kontrolę co komunikaty hosta. Host odpowiada tylko
     zamontowanej ramce, której okno (`event.source`) i origin się zgadzają.

   Osadzone UI przyjmuje komunikat widoczności tylko wtedy, gdy spełnione
   są wszystkie warunki:
   - `window.name === "fullmag-instance-tab"`;
   - `event.source === window.parent`;
   - `event.origin` to `http://127.0.0.1:<port>` albo
     `http://localhost:<port>` z portem z okna wykrywania.

   Okno pochodzi z tej samej zmiennej `FULLMAG_INSTANCE_DISCOVERY_PORTS` co
   CSP (decyzja 4). `next.config.ts` przekazuje je klientowi jako
   `FULLMAG_INSTANCE_TAB_PORTS` w postaci `<od>-<do>`. Bez tej wartości UI
   nie ufa żadnemu hostowi i ramka nie wstrzymuje pracy.

   Gdy zakładka jest ukryta, osadzone UI:
   - przełącza pętlę renderowania viewportu R3F z `demand` na `never`.
     Korzeń R3F, kontekst WebGL i stan widoku zostają. Powrót do `demand`
     unieważnia widok i rysuje klatkę bez ponownego montowania;
   - wstrzymuje wszystkie ładowania zasobów (`ResourceRuntimeStore`).
     Zmiany z realtime i odświeżanie z timerów zapisują tylko ostatnie
     żądanie każdego zasobu, a po powrocie każdy zasób ładuje się raz;
   - zatrzymuje lokalną animację fazy nakładki analizy, tak jak przy
     ukrytej karcie przeglądarki.

   Sesja, run i WebSocket realtime działają dalej. Po powrocie widok
   nadrabia zmiany z zapisanych żądań, bez pełnej resynchronizacji.

   Lista otwartych zakładek jest wygodą przeglądającego:
   trzymana w `localStorage` originu strony, odczyt i zapis w `try/catch`,
   bez wpływu na poprawność przy braku magazynu. Zakładka instancji, której
   wykrywanie nie zwraca, pokazuje stan „niedostępna” i nie znika sama.

6. **Home.** Home pokazuje sesje własnej instancji (ADR 0068) oraz sekcję
   innych instancji na tym komputerze z nazwą sesji, statusem i przyciskiem
   otwarcia w zakładce. Wykrywanie ładuje się przy starcie strony i po jej
   ponownym pokazaniu, a co 5 s tylko wtedy, gdy stan instancji jest na
   ekranie (Home albo otwarta zakładka instancji). Bezczynny workspace bez
   zakładek instancji nie wysyła żadnych zapytań, zgodnie z kontraktem ciszy
   sieciowej audytów przeglądarkowych.

7. **Adresy zakładek** (uzupełnienie 25.10.2026, decyzja użytkownika).
   Zakładka na wierzchu jest odzwierciedlona w adresie strony, więc
   przeładowanie, zakładka przeglądarki i Wstecz/Dalej prowadzą do tej
   samej zakładki:
   - `/home` — Home;
   - `/session/<slug>` — sesja własnej instancji; slug to nazwa sesji
     małymi literami, bez znaków diakrytycznych, z `-` między słowami;
   - `/session/<slug>?port=<port>` — zakładka innej instancji z jej bieżącą
     sesją; `/instance/<port>` — taka zakładka, gdy instancja nie ma sesji;
   - `/` i `/workspace` są aliasami rozwiązywanymi do zakładki na wierzchu
     (adres jest poprawiany przez `history.replaceState`).

   Wszystkie adresy serwują tę samą stronę workspace (rewrite w
   `next.config.ts`; w eksporcie statycznym serwer odpowiada stroną główną,
   która też renderuje workspace). Przełączenie zakładki zapisuje adres
   przez `history.pushState` i nigdy nie przeładowuje strony ani nie
   odmontowuje workspace. Nowy wpis historii powstaje tylko przy zmianie
   zakładki; zmiana nazwy sesji w tej samej zakładce, rozwiązanie aliasu
   i zamknięcie zakładki na wierzchu tylko poprawiają adres. Adres
   `/session/<slug>` bez portu wskazuje sesję własnej instancji, a gdy ta ma
   inną nazwę — instancję z wykrywania, której bieżąca sesja ma ten slug;
   gdy sesji nie ma nigdzie na tym komputerze, otwiera się Home. Tożsamością
   zakładki innej instancji pozostaje port (decyzja 1); slug jest etykietą
   i jest poprawiany na nazwę bieżącej sesji z wykrywania. Tytuł karty
   przeglądarki pokazuje nazwę zakładki na wierzchu. Osadzona instancja
   (ramka) nie zmienia adresu; jej ramka i „Open in window” nadal używają
   `/workspace`, które rozumie też instancja sprzed tej zmiany.

Odrzucony wariant 2 (wiele sesji w jednym API) wymaga zmiany decyzji D5
z ADR 0068 („jedna sesja na grupę”) i przebudowy stanu API: około 25 pól
`current_*` w `AppState` i setek tras `/v2/sessions/current/...`. Do tego
Docker DEV liczy jeden run naraz (`compute_max_concurrency == 1`), więc
wiele sesji w jednej grupie dałoby równoległą edycję, ale nie równoległe
obliczenia.

W ramce pozostaje Home osadzonej instancji (dostępny z jej menu). Pokazuje
on tylko tę instancję; sekcja innych instancji jest tam ukryta.

## Konsekwencje

- Backend bez zmian w modelu sesji; jedna nowa trasa tylko do odczytu.
- Awaria jednej instancji nie zamyka zakładek innych.
- Każda osadzona instancja ładuje własny bundle UI i własny kontekst WebGL;
  przy wielu zakładkach rośnie zużycie pamięci przeglądarki.
- Ukryta ramka nie rysuje i nie wysyła zapytań do swojego API. Jej
  WebSocket zostaje otwarty, więc dane wypychane przez realtime (np.
  próbki skalarne) nadal aktualizują stan React w ramce. Ten koszt CPU
  zostaje.
- Workspace hosta pod aktywną zakładką instancji jest tylko `inert` i nie
  jest wstrzymywany; ten sygnał dotyczy wyłącznie ramek.
- Ograniczenie: na silniku Docker bez Docker Desktop porty opublikowane na
  `127.0.0.1` hosta nie są osiągalne z kontenera przez bramę hosta; wtedy
  wykrywanie zwraca tylko własną instancję, chyba że
  `FULLMAG_INSTANCE_DISCOVERY_HOST` wskaże osiągalny adres.
- Osadzanie dopuszczone dla portów okna wykrywania zwiększa powierzchnię
  clickjackingu o lokalne serwery na tych portach (zob. decyzja 4).
- Okno portów wykrywania i CSP jest sprzężone z rotacją portów launchera
  (ADR 0067). Zmiana jednego wymaga zmiany drugiego albo ustawienia
  `FULLMAG_INSTANCE_DISCOVERY_PORTS`.

## Weryfikacja

- Testy jednostkowe Rust `instance_discovery::tests` (parsowanie okna
  portów, parsowanie odpowiedzi sondy, oznaczanie własnej instancji):
  **NOT VERIFIED lokalnie**, bo AGENTS.md zakazuje kompilacji testów
  jednostkowych na hoście. W CI job `rust-contracts` kompilował je razem z
  celem testowym binarki `fullmag-api`, ale do 25.10.2026 ich nie
  uruchamiał: wykonuje tylko wymienione filtry `cargo test`, a tego filtra
  brakowało. Uruchamia je krok „Run instance discovery contracts
  (ADR 0069)” w `.github/workflows/bootstrap.yml`.
- Testy vitest: magazyn zakładek (otwieranie, zamykanie, aktywacja, LRU
  ramek, rozpoznanie ramki po nazwie, odporność na brak `localStorage`),
  etykiety paska, sekcja Home, lista originów CSP.
- Testy vitest wstrzymania ramki (`instanceTabVisibility.test.tsx`,
  `hiddenInstanceTabResourcePolicy.test.ts`,
  `Viewport3DCanvas.lifecycle.test.tsx`,
  `AnalysisFieldOverlayPhaseAnimation.test.ts`, `next.config.test.ts`):
  - walidacja komunikatu (nazwa ramki, `source`, origin, okno portów,
    kształt danych);
  - `ready` i jego odpowiedź;
  - magazyn widoczności z renderem SSR;
  - wstrzymanie i wznowienie zasobów (jedno ładowanie najnowszego
    żądania);
  - pętla `demand` → `never` → `demand` na tym samym korzeniu R3F;
  - zgodność okna klienta z CSP.
- Dowód runtime: zob. niżej. **NOT VERIFIED:** viewport 3D w ramce po
  przełączeniu zakładek (canvas, `isContextLost()`, bufor rysowania)
  oraz brak renderowania i zapytań w ukrytej ramce. Szczegóły w
  „Dowód runtime (26.10.2026)”.

### Dowód runtime (26.10.2026, grupy DEV 3221 i 3223)

Dwie grupy z kodem `ecac0fff9`: host 3221 (worktree zadania) i ramka
3223 (osobny worktree w tym samym commicie, sesja
`fdm_cpu_relax_smoke`).

Sprawdzone:
- `GET /v2/platform/instances` z 3221 zwrócił 3223 z jej sesją.
- Strona `http://localhost:3221` otworzyła zakładkę 3223. Ramka ma nazwę
  `fullmag-instance-tab`, `src` `http://localhost:3223/workspace`, jest
  aktywna i `visibility: visible`.
- Żądania ramki są widoczne w logu sieci strony hosta, więc tym samym
  logiem da się sprawdzić ciszę ukrytej ramki.
- `next.config.test.ts` w grupie 3223 (świeży seed z nowym
  `next.config.ts`): test zgodności okna klienta z CSP przechodzi.

Nie sprawdzono (**NOT VERIFIED**):
- Ani strona hosta, ani ramka nie skończyły hydratacji. Na hoście
  działało wtedy 11 frontendów DEV na checkoutach Windows z odpytywaniem
  9p. Serwer Next podawał 17–20 MB `app/workspace/page.js` z prędkością
  50–60 KB/s (89–390 s), także wewnątrz kontenera. Webpack przerywa
  ładowanie chunka po 120 s (`ChunkLoadError`).
- Dlatego brak dowodu z przeglądarki dla wymiany `ready` i komunikatu
  widoczności, wstrzymania pętli R3F i zapytań w ukrytej ramce oraz
  canvas, `gl.isContextLost() === false` i niezerowego bufora rysowania
  po powrocie.
- Wariant z wejściem na 3223 bezpośrednio (z `window.name` ramki)
  potrzebuje tego samego pakietu, więc też nie był wykonalny.

### Dowód runtime (24.10.2026, grupa DEV 3199)

- `GET /v2/platform/instances` z grupy 3199 zwrócił siebie (`is_self: true`)
  i grupę 3206 z jej sesją `fullmag-python-live` (`awaiting_command`).
- Strona `http://localhost:3199` osadziła `http://127.0.0.1:3199/workspace`
  (inny origin) bez błędów CSP; nagłówki zawierają `frame-src` i
  `frame-ancestors` dla originów loopback (pierwsza wersja z
  wieloznacznymi portami; zawężona do okna wykrywania po recenzji).
- Zakładka instancji: ramka widoczna, osadzone UI rysuje workspace bez
  własnego paska zakładek, workspace hosta jest `inert`. Powrót do Home
  ukrywa ramkę (`visibility: hidden`) bez odmontowania; ponowne otwarcie
  pokazuje tę samą ramkę. Zamknięcie usuwa ramkę i wpis w `localStorage`.
- Instancja sprzed tej zmiany (3206) odmawia osadzenia (`frame-ancestors
  'self'`); pasek oferuje wtedy „Open in window”.
- Nie sprawdzono: dwóch odrębnych procesów API z nowym kodem naraz (druga
  grupa nie przeszła progu 32 GiB wolnego miejsca na dysku hosta).
