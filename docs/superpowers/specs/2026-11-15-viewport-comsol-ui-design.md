# Inspektor i pasek narzędzi widoku 3D

## Cel i uzgodnienie

Użytkownik odrzucił nieintuicyjny pasek i długi modal ustawień, wskazując COMSOL-a jako wzorzec. Po omówieniu inspektora widoku 3D polecił wdrożyć ten wariant profesjonalnie zgodnie z Modern Web Guidance. Implementacja wykorzystuje bieżące wspólne komponenty i istniejącą strefę inspektora; nie dodaje kolejnej kolumny ani drugiego renderera.

## Rozważone podejścia

1. Wybrany: kompaktowy pasek akcji + niemodalny inspektor widoku, umożliwiający równoczesną obserwację sceny.
2. Odrzucony: duży modal z nawigacją kategorii. Uporządkowałby formularz, ale nadal zasłaniał scenę.

## Zachowanie

- Pasek zawiera prawdziwe akcje: dopasowanie sceny, kierunek widoku (izometryczny i osie), projekcję, inspekcję wartości, nakładki, jakość, eksport PNG i otwarcie ustawień. Wykorzystuje rejestr poleceń, nazwane grupy, tooltipy i nawigację klawiaturą.
- Nazwa wielkości, zaznaczenie, liczebności, gotowość i szczegóły renderowania są oddzielną informacją o stanie. Nie wyglądają jak przyciski sterujące; błędy i nieaktualne dane nadal pozostają jawne.
- Obecna strefa Inspector otrzymuje konteksty Selection / 3D View. Zmiana kontekstu nie zmienia zaznaczenia i nie odmontowuje edytowanego inspektora obiektu ani nie usuwa jego draftów.
- Ustawienia mają cztery zakładki: View, Appearance, Quality, Export. Krótkie opisy, jawne etykiety i wartości liczbowe; zaawansowane parametry są grupowane zamiast tworzyć jeden długi formularz.
- View obejmuje kamerę i siatkę/osie. Edycja kamery korzysta z dotychczasowego właściciela aktualnego lub zapisanego widoku i walidacji. Nie zapisuje historycznej kamery do żywej sesji. Draft kamery ma jawne Apply i walidację oraz jest związany z tożsamością źródła.
- Appearance obejmuje tło i oświetlenie oraz tryb naukowy/prezentacyjny. Quality obejmuje cztery istniejące profile, AA/AO/cienie/bloom i czytelne przyczyny niedostępności. Export obejmuje PNG1/2/4x, tło i adnotacje.
- Na wąskim widoku etykiety paska mogą ustępować ikonom z nazwami dostępnymi. Akcje pozostają osiągalne i nie przykrywają sceny. Inspektor używa istniejącego układu paneli.
- Polecenia otwierania starych ustawień/kamery otwierają właściwą sekcję inspektora, bez kaskady modali. Reset dotyczy wyraźnie nazwanej sekcji.

## Granice i właściciele

Silnik, jakość domyślna, kolory ilościowe, bufory, topologia i API pozostają przy dotychczasowych właścicielach. Brak nowych zależności, endpointów, równoległych resource hooks i zduplikowanego canvasa. Komponent ustawień należy do viewport-3d, a Inspector korzysta wyłącznie z publicznego komponentu/adaptora UI. Adapter edytora kamery jest związany z zamontowanym właścicielem widoku i zwalniany przy jego zmianie/unmount; nie staje się źródłem prawdy danych serwera.

## Kryteria odbioru

Jedna scena WebGL zachowuje kontekst i drawing buffer podczas otwierania/przełączania ustawień. Zaznaczenie, draft, focus i scroll inspektora obiektu przetrwają zmianę kontekstu. Ustawienia nie pobierają pól ani topologii, nie generują ciągłych klatek w idle, zachowują zapisy preferencji i ochronę kolorów danych. Kamera i PNG działają przez istniejące ścieżki. Wymagane: testy komponentów/kontraktów, typecheck, lint0, pełna seria Control Room, architecture gate, React Doctor i browser/WebGL w grupie Docker zadania.

## Źródła projektu

Opis użytkownika oraz oficjalne COMSOL Graphics Toolbar / Using the Graphics Window. Lokalne załączniki ze ścieżek Windows nie były dostępne w tym środowisku. Modern Web Guidance: dialog, accessibility, toolbar, forms; odczytane w całości przez bounded guidance audit. Zachowujemy wspólne prymitywy aplikacji, bez wymiany globalnego Radix Dialog. Pasek używa istniejącego useToolbarRovingFocus jako fallbacku zamiast polegać na niewspieranym powszechnie focusgroup.
