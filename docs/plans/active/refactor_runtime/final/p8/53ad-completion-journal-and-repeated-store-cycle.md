# P8-53AD — dziennik completion i ponowny cykl magazynu

Data: 04.10.2026. Zakres: cold-store storage primitive, natywny Windows dev.
P8-53 i cały plan pozostają w realizacji.

## Zachowanie

SessionStore przyjmuje jawny pełny commit i tożsamość nowego API/session,
epoch 1, hash sceny, target build ID i rzeczywisty binding magazynu.
Nie wyprowadza dowodu exit ani odtworzenia sceny z metadanych. To obowiązek
koordynatora, który musi utrzymywać prywatne przejęcie nowego API.

Prepare utrzymuje rezerwacje launch → startup → WRITER, sprawdza dokładny
commit/fence, global idle i brak resident service. Publikuje trwały pending
`development/HANDOFF-COMPLETION.json` oraz niezmienną historię autoryzacji
`development/completion-authorizations/<handoff_id>.json`. Brak historii po
przerwaniu może zostać jawnie naprawiony tylko z dokładnego pending i przy
nadal zgodnym commit/fence. Istniejącej uszkodzonej historii nie nadpisuje.

Finish pod tymi samymi blokadami potwierdza i ponownie odczytuje pending
i historię przed pierwszym usunięciem. Usuwa tylko zgodny active commit
i fence; brak po wcześniejszym częściowym retirement jest dopuszczalny.
Pending znika ostatni. Wszystkie store admission gates i start service
odmawiają przy obecności pending lub commit, także uszkodzonych. Zwykły
abort i nowa akwizycja fence nie omijają pending.

Historia potwierdza autoryzację, nie aktualnie otwarte admission. Jawny replay
po zakończeniu wymaga zgodnej historii i braku active markers; potwierdza
barierę bez zmiany bajtów. Nowszy fence/commit blokuje stary finish.
Jeżeli ostatni unlink nastąpił, a bariera katalogu zawiodła, otwarcie jest
nieznane; nie ma automatycznego odtwarzania fence. Power-loss Windows nadal
NOT VERIFIED.

## Weryfikacja

`just windows-workspace-build dev dev 3197 auto`: produkcyjne EXE, exit 0.
Log `windows-native-fdm-cpu-dev/windows-runtime/completion-journal-final-build.log`.
Nie kompilowano testów jednostkowych.

`just verify-windows-development-backend-api`: **199 sprawdzeń, exit 0**,
60 zarejestrowanych procesów, wszystkie `waited=true`. Receipt:
`development-backend-api-checks/checks/4b0eff9bea35471cb28df392f9f5cbed/receipt.json`.
Backend source: `51932c26c75f30a7314b167b1dc6ea693f7350c82bc32d270071fd9f964e7bec`.
Snapshot: `48fd18444b6689c83df83ccbd912c8993bfcd9aebbeaaa4700852e6e1a73eb64`.
Ścieżki są względem `storage/builds/fullmag-0950f4dca4ffe38f`.

13 nowych sprawdzeń produkcyjnego primitive obejmuje:

- odmowę niezgodnej tożsamości replacement i zajętych launch/startup;
- blokadę admission, abort i nowego fence przez pending;
- odmowę obcego finish i zachowanie uszkodzonej historii;
- jawne odtworzenie brakującej historii;
- zachowanie blokady po usunięciu commit oraz przy samym pending po reopen;
- odmowę startu service i jawny finish częściowego retirement;
- replay bez zmiany historii oraz odmowę uszkodzonego pending;
- ochronę nowszego restartu i dwa pełne cykle tego samego magazynu.

Sonda zmieniała wyłącznie własne disposable fixture. Jej replacement pins są
syntetyczne: nie dowodzą live API completion. Dotychczasowe realne próby ACK,
lost-ACK i candidate prelisten restore także przeszły w tej bramce.
Review usunęło brak bariery przed retirement i rozbieżność starego komunikatu
sondy. UI użytkownika zachowano; końcowy odczyt na 3197 zwrócił HTTP 200.

## Pozostały zakres

Podłączyć prepare/finish do prywatnego koordynatora po potwierdzonym exit
starego API i przejęciu odtworzonej sceny w nowym. Dopiero to pozwoli sprawdzić
end-to-end ponowny restart i przyjęcie Compute. Warm service, szkice Inspectora,
hydration UI i browser z geometrią/regionami/materiałami pozostają otwarte.
`restart_available` pozostaje `false`; ten etap nie zamyka P8-C ani kwalifikacji.
