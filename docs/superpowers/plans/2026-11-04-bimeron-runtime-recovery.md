# Odzyskanie istniejącej grupy 3342

Cel: umożliwić dalszą pracę z FDM GPU warstwy rDMI i walca R50/H30 nm, szczelina 5 nm, wspólne projected_gradient_bb. Zachować wyniki i istniejącą grupę.

Właściciel: /root. Branch: codex/bimeron-runtime-recovery-20261104. Baza: c515f328fa5f565416e8116cc8064951b4cad530. Wykorzystano czysty istniejący worktree fullmag-console-20261104.

Grupa: fullmag-worktree-fullmag-cfc887ff26db7673. Źródła runtime: /home/kkingstoun/.codex/worktrees/frontend-refresh-reconcile-20261030/fullmag. Backend 664dd401d86a9ede196f5d142458434d02b748887329d67a9377d3fe22d3bd58. API po OOM nie działa, wszystkie 17 katalogów/runów ma stan terminalny, lease i rezerwacje są zwolnione.

Pierwszy stop eb203a9f63d745a5a88598837fb95d3c zakończył się failed-confirmed przed SIGTERM: porównanie obejmowało również zmienny snapshot statystyk. W trzech odczytach co 8 sekund readiness i digest pozostałych danych ledgeru były identyczne, zmieniały się wyłącznie snapshot_sha256 i raw ledger digest. Nie usunięto markerów ani nie ponowiono nieznanej mutacji.

Zmiana: przeniesienie sprawdzonej ścieżki Linux OOM stop z commitów 6f7383039 i 1454da9c4 bez eksperymentalnej fizyki FEM; stabilny digest pomija wyłącznie runtime_state.snapshot_sha256. Wszystkie pozostałe pola, rezerwacje, lease i store proofs pozostają przypięte. Surowe hashe oraz obie obserwacje są zapisywane w control volume.

Test regresji CAS przed poprawką: FAIL dla zmiany wyłącznie raw hashów przy niezmienionych stable pinach. Po poprawce: 54 testy stop-failed, 38 linux-supervision i 5 nowych regresji snapshotu PASS. Review źródeł nie zgłosiło pozostałego blokera. Runtime i nowy solve wymagają oddzielnego potwierdzenia.

Dalsze kroki: autentyczny native drain i stop obu usług; zachować stary branch oraz wyniki; przypiąć ten sam runtime checkout do mastera; managed fresh-state recreate w tej samej grupie z budżetem 64 GiB; potwierdzić provenance, API/UI i uruchomienie dokładnie jednego nowego przebiegu.
