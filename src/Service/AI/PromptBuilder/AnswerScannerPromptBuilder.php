<?php

declare(strict_types=1);

namespace App\Service\AI\PromptBuilder;

class AnswerScannerPromptBuilder
{
    public const SYSTEM_PROMPT = <<<'PROMPT'
Jesteś ekspertem OCR specjalizującym się w odczytywaniu kart odpowiedzi z egzaminów szkolnych.
Analizujesz zdjęcia kart odpowiedzi — nawet niewyraźne, krzywe, słabo oświetlone lub z cieniami.

MUSISZ odpowiedzieć WYŁĄCZNIE poprawnym JSON-em (bez markdown, bez ```json, bez komentarzy).

Struktura JSON:
{
  "examCode": "T-42",
  "studentName": "Jan Kowalski",
  "answers": {
    "1": "B",
    "2": "A",
    "3": "D",
    "4": "C",
    "5": "B",
    "6": null,
    "7": "A"
  },
  "confidence": "wysoka",
  "notes": "Pytanie 6 — brak zaznaczenia lub nieczytelne."
}

KRYTYCZNE zasady odczytywania:
- Odczytaj KOD SPRAWDZIANU z karty (np. "T-42" lub "E-15") — szukaj w prawym górnym rogu, w ramce, przy etykiecie "Kod sprawdzianu" / "Kod arkusza" / "Kod:". Jeśli nie widać kodu, wpisz null.
- Odczytaj IMIĘ I NAZWISKO ucznia (pole na górze karty po "Imię i nazwisko:")
- Karta ma TABELĘ z kolumnami: Nr | A | B | C | D
- W każdym wierszu jest JEDEN zaznaczony kwadrat (X, ✓, wypełnienie, zakreślenie)

JAK ROZPOZNAĆ ZAZNACZENIE:
- X w kratce = zaznaczone
- Wypełniony/zaczerniony kwadrat = zaznaczone
- Zakreślona litera lub kółko wokół litery = zaznaczone
- Ptaszek (✓) w kratce = zaznaczone
- Dowolny ślad w kratce, który WYRAŹNIE różni się od pustych kratek = zaznaczone
- Pusty kwadrat = niezaznaczony
- Lekkie zabrudzenie lub cień = NIE jest zaznaczeniem (ignoruj)

OBSŁUGA NIEWYRAŹNYCH ZDJĘĆ:
- Jeśli zdjęcie jest krzywe — i tak odczytaj (tabela może być pod kątem)
- Jeśli jest ciemne/jasne — szukaj kontrastów (ciemniejsze kratki = zaznaczone)
- Jeśli jest rozmazane — staraj się odczytać, a w notes opisz problem
- Jeśli nie jesteś pewien JEDNEJ odpowiedzi — podaj najlepsze przypuszczenie i opisz w notes
- Podaj null TYLKO gdy naprawdę NIE DA SIĘ odczytać
- Staraj się ZAWSZE podać odpowiedź — nawet przy niskiej pewności

KOLEJNOŚĆ ODCZYTU:
1. Najpierw znajdź kod sprawdzianu (prawy górny róg)
2. Potem imię i nazwisko
3. Potem kolejno każdy wiersz tabeli od nr 1 w dół
4. Sprawdź, ile wierszy ma tabela i odczytaj WSZYSTKIE

- "confidence": "wysoka" (>90% pewności), "średnia" (60-90%), "niska" (<60%)
- Odpowiadaj TYLKO JSON-em
PROMPT;

    public function buildUserPrompt(int $questionCount = 0, ?array $answerKey = null): string
    {
        $prompt = "Odczytaj odpowiedzi z karty odpowiedzi na załączonym zdjęciu.\n";

        if ($questionCount > 0) {
            $prompt .= "Karta zawiera {$questionCount} pytań zamkniętych (ABCD).\n";
        } else {
            $prompt .= "Odczytaj WSZYSTKIE pytania widoczne na karcie.\n";
        }

        $prompt .= "WAŻNE: Odczytaj też KOD SPRAWDZIANU (np. T-42 lub E-15) — jest w prawym górnym rogu karty.\n";

        if ($answerKey) {
            $prompt .= "Numery pytań: " . implode(', ', array_keys($answerKey)) . "\n";
        }

        $prompt .= "\nOdpowiedz WYŁĄCZNIE poprawnym JSON-em.";

        return $prompt;
    }

    public static function parseResponse(string $response): ?array
    {
        $json = trim($response);
        $json = preg_replace('/^```(?:json)?\s*/i', '', $json);
        $json = preg_replace('/\s*```$/', '', $json);
        $json = trim($json);

        $data = json_decode($json, true);
        if (!$data || !isset($data['answers'])) {
            return null;
        }

        return $data;
    }

    /**
     * Compare scanned answers with answer key and calculate score.
     */
    public static function gradeAnswers(array $scannedAnswers, array $answerKey): array
    {
        $correct = 0;
        $incorrect = 0;
        $unanswered = 0;
        $details = [];

        foreach ($answerKey as $qNum => $correctAnswer) {
            $studentAnswer = $scannedAnswers[(string) $qNum] ?? null;

            if ($studentAnswer === null) {
                $status = 'brak';
                $unanswered++;
            } elseif (strtoupper($studentAnswer) === strtoupper($correctAnswer)) {
                $status = 'poprawna';
                $correct++;
            } else {
                $status = 'błędna';
                $incorrect++;
            }

            $details[] = [
                'number' => $qNum,
                'correct' => $correctAnswer,
                'student' => $studentAnswer,
                'status' => $status,
            ];
        }

        return [
            'correct' => $correct,
            'incorrect' => $incorrect,
            'unanswered' => $unanswered,
            'total' => count($answerKey),
            'percent' => count($answerKey) > 0 ? round($correct / count($answerKey) * 100, 0) : 0,
            'details' => $details,
        ];
    }
}
