# Lokalny runner kontenerowy — wdrożenie etapowe

Status: **zaimplementowany wykonawca diagnostyczny `verify-source`**.
Nie jest to jeszcze wykonawca buildu Fullmaga ani kwalifikowany runner FEM.
Pełny zakres pozostaje w [zatwierdzonym projekcie](../superpowers/plans/2026-09-11-local-container-runner-design.md).

## Obecny kontrakt

Host Windows wybiera zarejestrowany worktree i storage przez istniejący resolver.
Klient tworzy kapsułę `tree/` + `manifest.json`; kolejka przechowuje jej digest,
nie obietnicę uruchomienia późniejszego stanu katalogu. Jeden aktywny job zajmuje
slot także po awarii obserwatora. Nie odbieramy lease na podstawie wieku.

Wykonawca korzysta wyłącznie z lokalnego endpointu Docker Desktop `desktop-linux`.
Operator osobno rejestruje niezmienny image ID; job nie wybiera obrazu, mountów,
polecenia powłoki ani endpointu. Kontener działa jako użytkownik nieuprzywilejowany,
bez sieci, socketu Dockera, dodatkowych capabilities i zapisu do źródeł/builda.
Zapisywalne są wyłącznie artefakty konkretnego joba i ograniczony `/tmp`.

To interfejs **zaufanego lokalnego użytkownika**, nie uwierzytelniony serwer dla
niezaufanych agentów/GitHuba. Osoba mogąca modyfikować pliki koordynatora, konfigurację
lub bazę jako ten sam użytkownik OS pozostaje wewnątrz granicy zaufania. Pole `owner`
nie zastępuje ACL, osobnego konta usługi ani uwierzytelnienia zewnętrznych żądań.

## Użycie diagnostyczne

Z wybranego worktree:

```sh
just runner-image
# Odczytaj pełne Id z docker image inspect fullmag/local-runner-source:development.
just runner-configure sha256:<pelny-image-id>
just runner-doctor
just runner-submit commit <pelny-commit-sha>
just runner-once
just runner-status <job-id>
just runner-logs <job-id>
just runner-wait <job-id> 30
```

`runner-submit snapshot` uwzględnia bieżące pliki śledzone i usunięcia. Nowe pliki
wymagają jawnego `--include-untracked` w kliencie Python. Przykładowy układ argumentów:
`python scripts/local_runner_cli.py --worktree <absolutny-worktree> submit --source snapshot --include-untracked <sciezka-wzgledna>`.
Na czas capture trzeba wstrzymać edycję źródeł; kontrola przed/po wykrywa wiele wyścigów,
ale nie ustanawia atomowej migawki dowolnego aktywnego edytora.

Polityka kapsuły wyklucza administracyjne metadane narzędzi, `.env` i rozpoznane pliki
poświadczeń; nie jest skanerem gwarantującym wykrycie sekretów wpisanych w zwykły kod.
Sześć jawnie wymienionych gitlinków `external_solvers` jest odnotowanych wraz z pinem,
bez materializacji zewnętrznych solverów. Taka kapsuła nie może kwalifikować operacji,
która potrzebuje tych źródeł. Pozostałe submoduły, LFS i nieobsługiwane dowiązania
muszą zostać odrzucone, nie pominięte bez informacji.

Powtórzenie `--request-key` z tym samym digestem zwraca ten sam job. Nowa kapsuła
kontrolna utworzona podczas retry pozostaje w storage; brak automatycznego prune.
Zmiana źródeł przy tym samym kluczu jest konfliktem, a nie cichą podmianą zadania.

## Anulowanie i awarie

`runner-cancel` anuluje oczekujący job albo zapisuje żądanie dla działającego.
Koordynator sprawdza pełny ID i etykiety przed zatrzymaniem własnego kontenera.
Timeout `runner-wait` nie anuluje joba. Oczekiwanie nie trzyma blokady worktree.

Po utracie obserwatora użyj `runner-reconcile <job-id>`. Reconciliacja potwierdza
persisted container ID, obraz i stan terminalny; może zrealizować już zapisane
anulowanie właściciela. Nie restartuje kontenera, nie usuwa go i nie przejmuje
lease wyłącznie na podstawie czasu. Brak zapisanego ID po niejednoznacznym create
wymaga osobnego ręcznego rozstrzygnięcia — nie wolno globalnie czyścić kolejki.

Dla udokumentowanego odrzucenia komendy **przed kontaktem z daemonem**, po
potwierdzeniu zakończenia procesu wysyłającego, operator może użyć klienta
`acknowledge-uncreated <job-id> --confirm-no-create-request-in-flight --reason <dowod>`.
Wymagane są brak persisted container ID oraz brak kontenera o dokładnej nazwie;
powód pozostaje w journalu. To jawne potwierdzenie operatora, nie automatyczny
mechanizm recovery dla niejednoznacznego timeoutu.

Kontenery zakończone, logi i kapsuły pozostają do audytowalnego cleanup. Nie używamy
`docker system prune` ani usuwania współdzielonych cache. Brak poprawnego receipt
oznacza failure nawet wtedy, gdy Docker zwrócił exit code 0.

## Jeszcze niekwalifikowane elementy

- Build/uruchomienie Fullmaga z prywatnej kopii kapsuły i jawnego execution context.
- Wspólne leases obejmujące istniejące launchery i ich kontenery po crashu procesu hosta.
- Adapter trwałego storage Desktop, dowód ext4/backing, limity i restart.
- Rozdzielenie istniejącego managed recipe na host orchestration i worker stage.
- Rzeczywista kwalifikacja FEM CPU/GPU, receipt nauki i artefakty.
- Uwierzytelniony ingress GitHub, ephemeral listener i ograniczenia zaufania PR.

Nie nadawaj temu wykonawcy etykiety `fem-managed` ani nie używaj diagnostycznego
receipt do zaliczenia CI/kwalifikacji solvera.
