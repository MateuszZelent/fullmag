# Recovery kwalifikacji regionów po admission bez Prepare

Kontynuacja autoryzowanego cyklu regionów, bez zgody na nowe Solve, zmianę
ownerów, ręczne edycje lease ani usuwanie wyników.

## Przyczyna i zachowany stan

Próba `regional_adaptive_capture_a4` przyjęła dwa Run jako v4. Pierwszy zakończył
się poprawnie. Scheduler ponownie rozwiązywał wejście drugiego etapu i porównał
pełny `ResolvedInput` z projekcją katalogu pozbawioną typed binding. To odrzuciło
niezmieniony artefakt. Owner zakończył się jako Failed; drugi task ma immutable
admission, aktywny lease i Pending worker permit, bez genesis/Prepare/Start.
Wyniki pierwszego etapu i surowa odmowa są zachowane na ext4.

## Kolejność i granice

1. Resolver porównuje identity/digest, zachowuje już przypięte typed binding
   i ponownie wymusza jego dokładną zgodność z kanonicznym manifestem kodeka.
   Obcy artefakt, digest lub kodek nadal powoduje odmowę.
2. Istniejący collector i recovery-build otrzymują osobny typ
   `fullmag.pending-admission-build-pin.v1`. Failed pozostaje Failed. Dopuszczalna
   jest jedna dokładnie przypięta Committed/Pending rezerwacja, jedna aktywna
   lease, zgodne niezmienne admission i katalog oraz brak execution evidence
   tego taska, worker process i supervisor slot. Zamek owner/startup/launch oraz
   store/ledger writer pozostają trzymane podczas buildu. Build/promotion nie
   jest dowodem zwolnienia zasobów i nie uruchamia runtime.
3. Native failed/no-spawn operator odtwarza wyłącznie brakujące genesis z
   immutable admission, zgodnie z istniejącą procedurą schedulera. Nie publikuje
   Prepare ani Start. Potem stosuje istniejące Stop/Cancelled/WorkerNoSpawn i
   proof zwolnienia dokładnej rezerwacji. Zachowuje odmowę przy zużytym permit,
   Started, procesie worker albo rozbieżności dowodów. Replay z istniejącym
   genesis korzysta ze zwykłej walidacji łańcucha.
4. Dopiero po dowodzie cancellation/release: kwalifikowane zatrzymanie naszej
   grupy, oficjalne wznowienie, nowa odrębna próba fizyczna z wcześniejszymi
   progami. A4 nie jest powtarzana ani oznaczana jako poprawna.
5. Końcowe CI/review i dalszy cykl PR/merge/master/retencja pozostają wymagane.

## Bramka odbioru

- [ ] Regresja typed input po podwójnym rozwiązaniu i odmowa podmiany metadanych.
- [x] Testy Python przypiętego Pending admission oraz odmów zużytego permit,
  dodatkowej rezerwacji, zmienionej lease/admission i niekanonicznej ścieżki.
- [x] Test rozróżnienia terminalnego Failed od Unknown, bez zmiany descriptorów.
- [ ] Native regresja genesis z admission, stale claim, brak Prepare/Start,
  idempotencja genesis i istniejąca ścieżka Stop.
- [x] Managed build/promotion z dowodem niezmienności aktualnego admission.
- [x] Native cancellation/release i kontrolowany drain, bez ręcznych markerów.
- [x] Nowa próba ciągłości RK45 przechodzi niezmienione progi fizyczne (A5).

Zatrzymanie po cancellation używa jawnego `just docker-dev-stop-failed … true`
(`--terminal-only`). Jest to istniejący wariant dowodu `observe_store`: wymaga
terminalności wszystkich tasków, zwolnienia wszystkich lease i zachowuje
piny katalogów/CAS oraz blokady. Nie czyta payloadów wyników przy zamykaniu
usług. Domyślny tryb z dowodem held-manual pozostaje zgodny; flagi nie wolno
ignorować w innej klasie awarii. Ta operacja nie usuwa wyników ani cache.
