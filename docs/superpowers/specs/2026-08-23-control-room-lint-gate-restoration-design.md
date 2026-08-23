# Projekt przywrócenia pełnej bramki lintowania Control Room w PR #56

**Status:** zatwierdzony projekt do przeglądu

**Data:** 2026-08-23

## Kontekst

Workflow bootstrap w PR #56 uruchamia pełne `eslint . --max-warnings=0` dla
`apps/control-room`. Po usunięciu wcześniejszego błędu TypeScript pełna bramka
ujawniła jeden błąd i cztery ostrzeżenia w czterech plikach obecnych także na
`origin/master`. Ograniczenie lintowania do plików zmienionych osłabiłoby
kontrakt CI, a osobny PR wymagałby dodatkowego scalenia i ponownego oparcia #56.
Dlatego naprawy zostaną włączone bezpośrednio do #56 jako mały, samodzielny
zestaw przywracający istniejącą bramkę.

## Cel i kryteria powodzenia

Zmiana ma spełnić wszystkie poniższe warunki:

1. pełne `eslint . --max-warnings=0` kończy się bez błędów i ostrzeżeń;
2. pole liczbowe selekcji nadal dopuszcza przejściowy, niepoprawny szkic,
   zachowuje walidację i resetuje szkic po rzeczywistej zmianie wartości
   kanonicznej;
3. synchronizacja wartości pola nie używa `useEffect + setState`, nie wymienia
   elementu `<input>` i nie zrywa fokusu;
4. efekt rejestrujący ACK reaguje na każdą zmianę prymitywnej tożsamości bufora,
   ale nie uruchamia się ponownie wyłącznie dlatego, że rodzic utworzył nową
   referencję obiektu o tych samych polach;
5. semantyka ACK, publiczne typy, OpenAPI v2, wygenerowany transport i ścieżki
   zasobów pozostają bez zmian;
6. zmiana nie przebudowuje topologii, nie dodaje klatek renderowania i nie
   zmienia własności zasobów WebGL.

## Rozważone warianty

### 1. Minimalne naprawy bezpośrednio w #56 — wybrany

Usuwamy martwy kod, zastępujemy efekt synchronizujący szkic warunkową korektą
stanu podczas renderu oraz zależymy od stabilnych pól tożsamości bufora. Ten
wariant przywraca pełną bramkę w jednym cyklu CI i nie osłabia jej zakresu.

### 2. Osobny PR bazowy

Zakres #56 byłby węższy, ale #56 pozostałby zablokowany do czasu scalenia,
ponownego oparcia i kolejnego cyklu CI. Cztery naprawy są zbyt małe i zbyt
bezpośrednio związane z uruchamianą bramką, aby uzasadnić ten koszt.

### 3. Lintowanie wyłącznie plików zmienionych

Ten wariant ukrywałby znane błędy pełnej aplikacji i zmieniał znaczenie bramki.
Jest odrzucony jako sprzeczny z celem PR #56.

## Zakres zmian

### `frozenSpinsResources.ts`

Nieosiągalna funkcja `revisionedKey` zostanie usunięta. Nie zmieniamy kluczy
zasobów, dekodera binarnego ani subskrypcji rewizji.

### `useVisualizationClientAck.ts`

Niepotrzebne lokalne wiązanie `resourceKey` zostanie usunięte z destrukturyzacji
wejścia koordynatora. Opcjonalne pole wejściowe i obecna walidacja
`dataIdentity`/`renderCommit` pozostaną bez zmian, więc nie zmieni się kontrakt
wywołań ani zawartość żądania ACK.

### `SelectionExpressionBuilder.tsx`

`NumberField` zachowa jeden lokalny obiekt szkicu zawierający:

- ostatnią kanoniczną wartość źródłową;
- tekst widoczny w polu;
- lokalny błąd walidacji.

Gdy `value` rzeczywiście zmieni się względem zapisanej wartości źródłowej,
komponent warunkowo skoryguje ten lokalny stan podczas renderu. Jest to wzorzec
przewidziany przez React dla korekty części stanu po zmianie właściwości i nie
wymaga pasywnego efektu. Element wejściowy zachowa tę samą tożsamość DOM;
celowo nie używamy `key={value}`, ponieważ remount przy każdej zaakceptowanej
liczbie mógłby odebrać fokus.

Obsługa pustego tekstu, liczb niefinitywnych, `min`, `max`, błędu zewnętrznego
i wywołania `onChange` po poprawnym parsowaniu pozostanie taka sama.

### `Viewport3DModule.tsx`

Efekt rejestrujący rewizję wizualizacji będzie czytał osobno stabilne pola
prymitywne `bufferId`, `fieldRevision`, `resourceKey`, `sessionEpoch` i
`sessionId`. Wszystkie użyte pola trafią do listy zależności. Nie umieszczamy w
niej całego `fullFieldBufferIdentity`, ponieważ obecny model sceny tworzy nowy
obiekt przy renderze i prowadziłoby to do zbędnych ponowień efektu.

Z listy zależności callbacku zatwierdzającego klatkę zostanie usunięte
`sessionIdentity.sessionId`, którego callback nie odczytuje. Pozostałe
zależności i klucz deduplikacji ACK nie zmienią się.

## Przepływ danych i obsługa błędów

Szkic pola liczbowego nadal jest stanem modułowym Inspektora. Poprawna wartość
przepływa przez istniejące `onChange` do nadrzędnego wyrażenia selekcji;
niepoprawny tekst pozostaje lokalny i nie nadpisuje wartości kanonicznej.
Zmiana wartości kanonicznej resetuje tekst i błąd przed zatwierdzeniem DOM,
bez renderowania dzieci ze starym szkicem.

ACK nadal powstaje z rewizji wizualizacji i kompletnej tożsamości danych.
Brak `resourceKey`, epoki lub sesji nadal daje `dataIdentity = null`, a
koordynator zachowuje obecne zachowanie fail-closed. Zmiana nie dodaje nowego
transportu, fallbacku ani stanu zasobowego w React.

## Weryfikacja test-first

1. Zachować bieżący pełny lint jako dowód RED: dokładnie jeden błąd i cztery
   ostrzeżenia w opisanych miejscach.
2. Dodać test DOM dla pola liczbowego, który potwierdza zachowanie tej samej
   instancji `<input>` i fokusu po zmianie wartości nadrzędnej oraz reset tekstu
   i błędu lokalnego.
3. Uruchomić test charakterystyki przed zmianą produkcyjną, a następnie ponownie
   po zmianie.
4. Wprowadzać minimalne poprawki plik po pliku i po każdej uruchamiać
   skierowany ESLint.
5. Uruchomić testy `SelectionExpressionBuilder`, koordynatora ACK i odpowiednie
   testy viewportu, pełny typecheck oraz pełny lint z zerowym limitem ostrzeżeń.
6. Uruchomić React Doctor dla zmienionych linii oraz istniejący browser smoke
   viewportu, który potwierdza widoczny canvas, nieutracony kontekst WebGL i
   niezerowy drawing buffer.
7. Uruchomić bramki API/architektury odpowiednie dla frontend-only zmiany i
   potwierdzić brak zmian w OpenAPI oraz plikach generowanych.

## Poza zakresem

- zmiana workflow na lintowanie przyrostowe;
- refaktoryzacja modelu sceny lub stabilizacja wszystkich jego obiektów;
- zmiana schematu ACK lub API wizualizacji;
- zmiana semantyki selekcji, walidacji numerycznej albo wyglądu Inspektora;
- naprawianie lokalnych, windowsowych niezgodności zakończeń linii w pełnym
  zestawie Vitest.
