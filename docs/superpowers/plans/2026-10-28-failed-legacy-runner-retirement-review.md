# Wycofanie niesprawnego dawnego koordynatora — przegląd operacji

Status: użytkownik zatwierdził procedurę. Próba łagodnego zatrzymania nie zakończyła kontenera; usunięcia nie wykonano.

## Zakres i przyczyna

Wyłącznie `Fullmag_build_runner`, pełny ID
`40d38a163682598d362b21257a84d3179158762f145e3d10fe08c3abd0db5656`, obraz
`sha256:625695928cd2828be2114450c43c242635b92bec524a5c2956aecc2bca3f43bc`.
Jest to dawny koordynator; build DEV instancji 3203 musi odbywać się w jej
własnym stałym kontenerze backend, a nie przez ten runner.

Po zatwierdzonym usunięciu sześciu zakończonych kontenerów jego bind
`D:\git\fullmag\storage` blokuje pełny preflight recovery v5. Natywna
kontrola topologii przekroczyła limit 15 s przy 57251 wpisach; nie zmieniono
limitu i nie pominięto kontroli. Alternatywą wobec wycofania jest oddzielna,
wersjonowana rozbudowa dowodu izolacji dużych drzew Windows.

## Dowody obecnego stanu

- API health: `worker_alive=false`, `worker_state=failed`,
  `accepting_jobs=false`, `active_jobs=[]`, retencja nieaktywna.
- Błąd usługi: nie można odczytać `local-runner-service.json`. Niezależny
  odczyt hosta wykazał 638 bajtów zerowych, SHA256
  `72e5b1f5ddd379c04a98a022643ab85ff0c27dbd474f02d88dd2dcae138d0786`.
- API jobs zwraca 500. Bazę `runner-jobs.sqlite` odczytano bez zapisu:
  58 succeeded, 19 failed, 11 cancelled, 4 blocked, 1 interrupted.
  Nie ma running/queued/leased ani innych stanów poza wymienionymi.
  Zablokowane i przerwane wpisy pozostają nierozstrzygnięte; nie wolno
  zmieniać ich statusów ani traktować jako zakończonych.
- Aktualny Docker ps pokazał ten runner i dwa kontenery BuildKit;
  brak kontenerów wykonujących buildy runnera. BuildKit pozostaje poza zakresem.

Metadane, końcowe logi i obserwacje zachowano w wolumenie kontrolnym grupy
anteny pod `verification/recovery-v5-20261028/`: `failed-runner-inspect.json`,
`failed-runner-tail.log`, `remaining-runner-activity.json`,
`remaining-runner-queue-readonly.json`, `remaining-runner-native-isolation.json`.

## Procedura po zgodzie

1. Ponownie porównać pełne ID, obraz, konfigurację i mounty z zachowanym
   inspect. Ponownie odczytać health i bazę kolejki. Zmiana tożsamości,
   aktywny worker, przyjmowanie zadań, aktywna retencja albo stan kolejki
   poza terminal/blocked/interrupted oznacza odmowę operacji.
2. Potwierdzić brak kontenerów wykonujących zadania runnera. Nie zatrzymywać
   BuildKit, własnych usług WSL ani cudzych kontenerów.
3. Wysłać wyłącznie SIGTERM do wskazanego runnera. Poczekać maksymalnie 30 s;
   jeżeli nie zakończy się, zachować kontener i zgłosić niepowodzenie.
   Nie używać SIGKILL ani wymuszonego usunięcia.
4. Dopiero po potwierdzonym zakończeniu usunąć dokładnie ten kontener przez
   docker rm, bez force i bez volumes. Zarchiwizować końcowy stan i logi.
5. Potwierdzić zachowanie obrazów, wolumenów i danych bind mountów, a następnie
   powtórzyć pełny preflight recovery. Nie naprawiać pliku stanu ani bazy,
   nie ponawiać żadnego zadania i nie uruchamiać Solve.

## Skutek i odtworzenie

Zniknie endpoint dawnego runnera na 48765. Kolejka, konfiguracja, token,
archiwalne wyniki, obrazy i wolumeny pozostaną. **Warstwa zapisu kontenera
zostanie usunięta i nie jest zarchiwizowana.** Nie twierdzimy, że jest pusta.
Zachowany inspect oraz obraz umożliwiają przygotowanie osobnego odtworzenia,
ale nie gwarantują zdrowej usługi: uszkodzony plik stanu nadal wymagałby
niezależnego recovery. Ta operacja go nie naprawia ani nie odtwarza runnera.

Wymóg decyzji: AGENTS.md, „Ochrona pracy i uprawnienia” — „Pozostałe usuwanie
danych, force-push i wiadomości zewnętrzne wymagają odrębnej autoryzacji.”
Pierwotny zakres dodatkowo zabrania zatrzymywania cudzych kontenerów.

## Wynik zatwierdzonej próby — 28.10.2026

Ponowny preflight potwierdził tożsamość runnera, brak aktywnych zadań
i zachowanie warunków zgody. Zapisano go w wolumenie kontrolnym jako
`verification/recovery-v5-20261028/failed-runner-retirement-preflight.json`.
Wywołano `docker stop --timeout -1` dla pełnego ID, aby nie dopuścić
do automatycznego SIGKILL. Obserwacja zakończyła się po 30 s błędem
`ControlOutcomeUnknown`; nie jest to potwierdzenie zatrzymania.

Następny inspect potwierdził `running=true`, PID 818, ten sam obraz
i ten sam StartedAt. Odczyt procesów pokazał jeden proces `python3`.
Zgodnie z punktem 3 procedury pozostawiono kontener. Nie wykonano
SIGKILL, wymuszonego usunięcia ani zmian kolejki. Wycofanie pozostaje
nieukończone; wymuszone zakończenie wymaga nowej, konkretnej zgody.

### Diagnoza braku reakcji na SIGTERM

Odczyt `/proc/1/status` w dokładnie wskazanym kontenerze wykazał
proces Python jako PID 1, jeden wątek oraz `SigCgt=0000000100000002`.
Bit SIGTERM (14, numer sygnału 15) nie jest ustawiony: proces nie
rejestruje jego obsługi. Entrypoint to `python3 -m local_runner.container_main`.
To wyjaśnia brak zakończenia: Linux specjalnie traktuje PID 1 i ignoruje
sygnały z domyślną akcją zakończenia, jeśli proces nie ma ich handlera.
Źródło: https://docs.docker.com/reference/cli/docker/container/run
Żadnego dodatkowego sygnału nie wysłano. Dalsze czekanie samo nie
naprawia braku obsługi sygnału. Prośba o zgodę na SIGKILL pozostaje otwarta.
