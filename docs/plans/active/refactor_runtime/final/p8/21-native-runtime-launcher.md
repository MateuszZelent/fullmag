# P7-C / P8 — niezależny start i ponowne podłączenie usługi

Data: 03.10.2026. Kontynuacja [klienta](20-native-runtime-client.md).

CLI `fullmag runtime service-ensure --config <absolute-json-path>` dołącza do
zgodnej usługi albo uruchamia raz sibling `fullmag-runtime-service`. Wspólny
typ konfiguracji i walidator są w fullmag-session. Status usługi zwraca jej
konfigurację z pamięci; launcher porównuje wszystkie zasoby i timeouty, oprócz
tożsamości builda/ownera/pul sprawdzanych w poprzednim etapie.

## Własność i błędy

- Native LAUNCH.lock serializuje równoległe decyzje start/attach. OWNER.lock
  nadal należy do długowiecznej usługi, nie launchera.
- Trwały LAUNCH.json zapisuje intent przed spawn i PID po spawn. Nieznany
  wcześniejszy start bez terminalnego ownera wymaga kontrolowanego recovery;
  brak OWNER.json nie pozwala na ponowne uruchomienie procesu.
- Konfiguracja wejściowa jest kopiowana przez create_new do unikalnej,
  zsynchronizowanej kopii przy logach próby. Proces nie odczytuje ponownie
  zmiennego pliku operatora. Żądana i obserwowana konfiguracja muszą być zgodne.
- Usługa ma jeden deadline startup dla otwarcia store, publisherów, boot i
  ready. Launcher daje dodatkowe 10 sekund na utworzenie/załadowanie procesu.
- Timeout albo nieznana obserwacja zachowuje proces i zapis próby; brak kill,
  retry ani takeover. Tylko potwierdzony exit jest terminalnym wynikiem próby.
- Windows używa CREATE_NO_WINDOW, Unix setsid; brak zależności od konsoli UI.
  Zamknięcie uchwytu Child nie zatrzymuje usługi.

## Weryfikacja i kolejne kroki

Parser/format źródeł i scoped diff check PASS. Regresje Rust zapisano dla
wyłączności launch lock, zachowania nieznanego intentu po zwolnieniu locka
oraz exact configuration mismatch. Unit tests nie kompilowano i nie
uruchomiono zgodnie z zakazem operatora. Typecheck i proces Windows są
NOT VERIFIED; source review nie zastępuje wykonania start/drain/reconnect.
Niezależny re-review po poprawkach: brak P0/P1. Pozostają do sprawdzenia
trwałość wpisu kopii konfiguracji po awarii hosta oraz Windows Job Objects:
CREATE_NO_WINDOW sam nie odłącza usługi od ewentualnego joba rodzica.

UI jeszcze nie wywołuje ensure. Integracja musi współdzielić resolver
AppState.submit_store_root: packaged state_root/runs/session-store albo
kanoniczne FULLMAG_RUNS_ROOT/session-store. Nie wolno użyć store bieżącego
workspace local-live/session-store. Czysta instalacja wymaga inicjalizacji
accepted store przed ensure; obecne polecenie wymaga istniejącego store.
Desktopowy sidecar również wymaga tej samej integracji.

Instancja 3104, aktywne zadania i cudze zmiany pozostały zachowane. Cały plan
i kwalifikacja natywnego produktu Windows pozostają otwarte.
