# Izolacja równoleg³ych instancji Fullmaga

## Kontrakt

Ka¿dy niezale¿ny interaktywny proces Fullmaga posiada w³asne API, frontend i identyfikator instancji. Domyœlna preferowana para to API 8081 / UI 3100. Jeœli którykolwiek port jest zajêty, launcher wybiera now¹ parê: zmienia oba porty, nie przejmuje dzia³aj¹cej us³ugi i nie zabija procesu wed³ug numeru portu. `--web-port 0` oznacza wybór automatyczny. Zadania headless bez jawnego API nie rezerwuj¹ portów HTTP.

Na Linuxie launcher zachowuje rzeczywiste listenery i przekazuje je dzieciom przez deskryptory. Dotyczy API, statycznego UI oraz Next w trybie developerskim. Zamkniêcie sondy przed startem us³ugi nie stanowi rezerwacji. Na Windows wspólna blokada inicjalizacji serializuje starty Fullmaga, a us³ugi potwierdzaj¹ w³asnoœæ nag³ówkiem `x-fullmag-instance-id`. Zewnêtrzny proces mo¿e wejœæ w krótkie okno miêdzy zwolnieniem socketu a bindem; taki start koñczy siê b³êdem i nie mo¿e zaakceptowaæ obcej us³ugi. Pe³ne automatyczne ponowienie tego przypadku w natywnym launcherze Windows pozostaje do dopracowania.

Stan kontrolny i discovery znajduj¹ siê w `instances/<instance_id>` pod rozwi¹zanym rootem runtime. Plik `instance.json` opisuje faktyczne porty, URL i PID launchera; jest publikowany dopiero po gotowoœci. Historyczny storage symulacji i wspólne cache zachowuj¹ dotychczasow¹ lokalizacjê. Zakoñczenie instancji zamyka wy³¹cznie jej w³asne procesy. Uruchomienie UI nie usuwa cache innych instancji.

Proces attached otrzymuje API, identyfikator i katalog stanu supervisora; nie tworzy kolejnego control plane. Jeden proces launchera obs³uguje jedn¹ niezale¿n¹ instancjê. Wiele instancji na wêŸle HPC to osobne procesy.

Port publiczny/tunel `FULLMAG_WEB_PUBLIC_PORT` jest mapowaniem operatora. Launcher odrzuca konfiguracjê, jeœli przesuniêcie listenera uniewa¿ni³o to mapowanie; nie rekonfiguruje zewnêtrznego tunelu. Statyczny frontend serwowany bezpoœrednio przez API publikuje port API. W oddzielnych kontenerach porty wewnêtrzne mog¹ siê powtarzaæ, publikowane porty hosta musz¹ byæ ró¿ne.

## Runner

Sam fakt dzia³ania UI nie blokuje ciê¿kiej kolejki. Wyj¹tek dotyczy wy³¹cznie rozpoznanej, ograniczonej konfiguracji managed browser: przypiêty image, dok³adny namespace Compose, readonly rootfs, brak uprawnieñ/GPU/socketu Docker i ograniczenia CPU/RAM/PID. Nieznane kontenery Fullmaga nadal blokuj¹ admission. Jest to wyj¹tek dla ograniczonego serwisu UI, a nie gwarancja, ¿e API nigdy nie uruchomi pracy CPU.

## Weryfikacja i pozosta³e bramki

- Testy Pythona sond par portów, konfiguracji browser i guardu runnera: 44 passed, 33 subtests.
- Rzeczywiste dwa procesy statycznego UI: ró¿ne nag³ówki instancji, prawid³owe niezale¿ne proxy API, odrzucenie zajêtego portu, zamkniêcie jednego procesu nie zamyka drugiego: passed.
- Kontrakty Windows: 57 passed, 1 skipped po korekcie historycznych oczekiwañ; fixture kompiluj¹cy Rust œwiadomie pominiêty na czas zakazu kompilacji testów.
- Node syntax: passed. Review wykry³ i usun¹³ powielone definicje oraz uzupe³ni³ statyczne discovery i obs³ugê b³êdu listen.
- Build binariów przez managed runner, uruchomienie nowego CLI/API, deskryptory Linux i Next dev: NOT VERIFIED. Wynik lekkiej regresji Node nie zastêpuje tych bramek.
- Integracja/PR/cleanup: oczekuj¹ na bramki. Worktree pozostaje aktywny; g³ówny checkout zawiera niezwi¹zane zmiany.

Aktywny koordynator obs³uguje runtime-v2, którego nie ma jeszcze w bazowym masterze tego worktree. Nie wolno zast¹piæ go obrazem z niepe³nym katalogiem profili. Wdro¿enie guardu musi zachowaæ dzia³aj¹ce profile, obrazy, kolejkê oraz dane.

## Checkpoint wdro¿enia runnera — 2026-10-02

Poprawka guardu zosta³a wdro¿ona jako narrow overlay obrazu koordynatora. Baza: `sha256:7753401fbbf748625b8ec2fda0fc244b07e8ef492426102102dd88bd22c6f901`; wynik: `sha256:0d5c960f7c24d6785c6c7af1a8c5e09116d9d96f7106825e69f65ebaa5c8161d`. Zmieniony zosta³ wy³¹cznie modu³ `local_runner/build_executor.py` (funkcje attestation i dwa miejsca guardu). Warstwy bazowe, entrypoint, env, u¿ytkownik i mounty zachowano. Dziesiêæ testów guardu przesz³o wewn¹trz nowego obrazu. Pierwsza próba pe³nego testu modu³u w readonly kontenerze nie mia³a zapisywalnego `/tmp`; nie jest dowodem pe³nej kwalifikacji modu³u live.

Po drain przy pustym aktywnym slocie wykonano zarz¹dzane replace i resume. Health: `worker_alive=true`, `accepting_jobs=true`, `worker_error=null`, `last_error=null`. Zachowano siedem profili, w tym runtime-v2. Nie zatrzymano dwóch istniej¹cych kontenerów UI ani nie usuwano danych buildów. Artefakty overlayu i preflight pozostaj¹ w kanonicznym build root zadania.
