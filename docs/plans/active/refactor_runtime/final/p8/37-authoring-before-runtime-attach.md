# P8-37 — otwarcie authoringu przed gotowością runtime

## Przyczyna i zachowanie

CLI `main.rs` i Tauri `api_sidecar.rs` wykonywały
`ensure_for_application(...)?` przed otwarciem okna. Jawna konfiguracja
compute mogła zablokować startup aż do timeoutu lub przerwać go błędem.
Nowa granica read-only sprawdza API build/UUID i accepted-store binding,
otwiera okno, a następnie rozpoczyna posiadany background attach.

Config parsing, zgodność service store, brak executable i niegotowa usługa
pozostają błędami obliczeń raportowanymi w logu/statusie, bez zamykania UI.
Niezgodność API nie staje się dostępnością compute ani cichym fallbackiem.
Brak jawnej konfiguracji nie tworzy store, wątku ani resource offers.
Brak canonical accepted-store wyłącza compute attach z jawnym powodem.
Reuse zgodnego API dopuszcza authoring, ale nie uruchamia przy nim native
service bez własności tego API. Nie aktywowano domyślnej konfiguracji
pakietu; nadal wymaga własnego odbioru.

## Własność i shutdown

Ścieżka konfiguracji jest przechwycona przed oknem; typed config snapshot
powstaje przy rzeczywistym attach w tle i nie jest ponownie czytany w ensure.
Wątek przechwytuje pin API; powtarza zgodność instancji/store
przed config write, przed nowym startem i po attach. Cancellation jest
sprawdzana przed gate/start i w pętlach oczekiwania. UI guard joinuje wątek
przed końcem API. Nie zabija ani nie drainuje persistent native ownera.
Spawned marker/PID pozostaje po anulowaniu obserwacji, bez synthetic
failed/drained, takeover i automatycznego retry. Operacje sieciowe zachowują
obecne bounded deadlines; lokalny FS wymaga kwalifikacji platformy.

## Dowody i dalsze bramki

Kontrole nowego modułu/client/Tauri Rustfmt, parsera CLI oraz nowych
linków checkpointu: PASS. Niezależny finalny source review po poprawkach
nie wykazał P0/P1. Przygotowano 9 regresji Rust (7 attach + 2 client),
dotyczących szybkiego startu wątku, cancellation+join, błędu
taska, braku konfiguracji/store, niewłasnego API i zatrzymania przed launch. Rust tests nie były
kompilowane ani uruchamiane zgodnie z aktualnym zakazem AGENTS.md.

Build aktualnego SHA, Windows/Tauri bez Docker/WSL, CLI UI, błędny config,
missing binary, slow startup, API replacement, zamknięcie okna podczas
attach i dalsze działanie zaakceptowanego runu pozostają NOT VERIFIED.
Generated runtime-service client oraz diagnostyka UI także czekają na
managed export. P8 ani cały plan nie są zamknięte tym przyrostem.

## Przypięty build 215

Źródła przyrostu zapisano i wysłano jako
`7b5248c515eeee788c62050073b05d3affe6ddcb`. Po zewnętrznym restarcie runnera
odczyt potwierdził worker_alive=true, accepting_jobs=true, stop_requested=false
oraz działający wcześniejszy build 214. Nie wykonywano restartu/resume.

Zlecono centralny production build `fdm-cpu-release`, operation=build:

- sequence: 215; job: `901bf4779f5848ebaf9900311dd4b9bd`; status odbioru: queued;
- source mode: commit; request key: `p8-37-authoring-7b5248c515eeee78`;
- capture: `eae1a1199aac4b1e823deb08f56d89ec`;
- capsule digest: `9245d639bfff13bf511653fa59ce5bf61dba01164179e43a63001920726c50ae`;
- native snapshot: `d612ebfff5e40a7e190874348ef9af934bde37d9d9c1946552a3b61cfdf2981c`;
- source_snapshot_dirty=false; kapsuła nie przyjmuje obcych zmian checkoutu.

Queued nie jest dowodem kompilacji, HTTP, solvera, Tauri ani Windows.
Po terminalnym sukcesie trzeba odebrać aktualny required-output receipt,
hashe i raw OpenAPI z właściwego API binary, potem dopiero generować klienta.
Build 214 pozostaje osobnym wcześniejszym source pinem; nie zastępuje 215.
