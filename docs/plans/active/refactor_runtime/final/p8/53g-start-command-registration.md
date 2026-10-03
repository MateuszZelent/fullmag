# P8-53G — naprawa uruchomienia ekranu startowego w trybie dev

Data: 03.10.2026. Zakres: rejestracja komend modułu Start Screen.

## Przyczyna i poprawka

`just windows-ui dev` poprawnie uruchamiał backend i Next.js na 3197,
ale `/workspace` zwracał HTTP 500. `createKernel` rejestrował
`start.section.home` dwukrotnie: najpierw przez `SHELL_COMMANDS`, następnie
przez `startScreenManifest.contributes.commands`.

Usunięto import i rozpakowanie `START_COMMANDS` w `shellCommands.ts`.
Jedynym właścicielem wkładu komend pozostaje manifest modułu. Rejestr
nadal odrzuca duplikaty; poprawka nie ukrywa kolizji identyfikatorów.

## Dowody

- Przed poprawką: błąd rejestracji odtworzony w Chrome, zgodny z logiem użytkownika.
- Po poprawce: HMR przywrócił ekran `Welcome to Fullmag` bez restartu backendu.
- Kliknięcie `Templates` pokazało właściwą sekcję; `Home` przywróciło ekran główny.
- Po tych przejściach brak nowych wpisów poziomu error w obserwowanej konsoli.
- Żądanie HTTP do `http://localhost:3197/workspace` zwróciło 200.
- Procesy listenerów pozostały te same: API 8081/PID 194240, UI 3197/PID 63268.
- Build użytkownika `windows-native-fdm-cpu-dev` zakończył się exit 0;
  receipt wskazuje 18:22:15–18:25:40 UTC. To build poprzedzający poprawkę frontendu.

Kontrole przez profil `windows-control-room-source-check` zakończyły się
exit 0 i miały niezmieniony digest źródeł
`01a14f2b6aeca0ac887c11cea2ee09bc65aabdd7d874ad9b2cf19dfc29f52710`:

| Kontrola | Receipt | Wynik |
|---|---|---|
| Produkcyjny TypeScript | `66d3dcf619734a1d8219b584b3436cc0` | PASS |
| Pełny lint | `d823bd8f09f44310a68fb64a80260e4c` | PASS |
| Higiena API | `27c09d5b4dc54f49b94ac8ed8e43fe67` | PASS |
| React Doctor, zmiany względem HEAD | `65b3dcbd0ea642358eeedd9510f32f88` | 1 plik, brak zgłoszeń |

Receipty wskazują bazowy HEAD `f743e056815650c4ea2849b7b9122f4b3b503885`
i obejmują poprawkę w dirty source. Kontrole nie kompilowały testów.

Istniejący `startCommands.test.ts` rejestruje shell i komendy Start Screen
w jednym rejestrze, co pokrywa tę kolizję. Test pozostaje NOT COMPILED /
NOT RUN zgodnie z aktualnym zakazem kompilacji testów jednostkowych.

## Granice wyniku

Zweryfikowano uruchomienie i nawigację ekranu startowego. Nie jest to nowy
dowód utworzenia geometrii, wykonania solvera ani odtworzenia sceny po
kontrolowanym restarcie. P8-53 i cały plan pozostają w realizacji.
