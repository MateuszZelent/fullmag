# Kontrolowany drain po odrzuceniu publikacji — 27.10.2026

Źródłem blokady był status API running po zakończeniu obu zadań native; poprawka manifestu wymagała nowego runtime. Domyślna reguła restartu nadal odmawia przerwania aktywnej sesji.

Dodano jawne opcje `restart-idle-volume --allow-terminal-catalog --stop-only`. Wyjątek dopuszcza wyłącznie wejście w istniejący authenticated drain: dokładne session/run/API identity, terminalny niepusty katalog tego runu, wszystkie rezerwacje released z dowodami, gotowy runtime, pusta kolejka i brak komend, ponowne odczyty oraz hashe katalogu/konfiguracji/rezerwacji. Odczyty są ograniczone, odrzucają symlinki i błędny kształt danych. Frontend musi być zatrzymany, prywatna sieć bez obcych konsumentów, grupa objęta lease. Nadal wymagane są exit 0 backendu i autentyczny process-drain receipt. Nie zmieniamy statusu API, katalogów, wyników ani lease.

9 testów Python PASS (nowa kontrola i istniejący idle stop), diff check PASS. Rzeczywisty preview wskazał run `68a54e1d…`, pustą kolejkę, 8 released rezerwacji oraz runtime ready. Operacja `2878d383a7cf48aca7b58d53d3213393` zakończyła się succeeded, backend zatrzymany po authenticated drain. Dowody znajdują się w jej katalogu control-volume: `terminal-session-preflight.json`, `backend-drain.json`, `terminal.json`.

Kolejny krok: managed fresh-state recreation zachowujący namespace oraz nowa symulacja z poprawionym manifestem. Sam drain nie stanowi odbioru wizualizacji nonzero-k.
