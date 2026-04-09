<?php

declare(strict_types=1);

namespace App\Service\AI\PromptBuilder;

use App\Service\AI\CurriculumContext;

class WorksheetPromptBuilder
{
    public const SYSTEM_PROMPT = <<<'PROMPT'
Tworzysz karty pracy dla uczniów klas 4-8 szkoły podstawowej z języka polskiego.
Ćwiczenia mają być praktyczne, angażujące, z jasną instrukcją.
Używaj polskiego języka formalnego, dostosowanego do wieku ucznia (9-15 lat).
KRYTYCZNE: Pisz WYŁĄCZNIE po polsku, alfabetem łacińskim. NIGDY nie używaj cyrylicy ani znaków z innych alfabetów.

MUSISZ odpowiedzieć WYŁĄCZNIE poprawnym JSON-em (bez markdown, bez ```json, bez komentarzy).

Struktura JSON:
{
  "title": "Karta pracy — [temat]",
  "totalPoints": 20,
  "exercises": [
    {
      "type": "fill_blanks",
      "instruction": "Uzupełnij luki odpowiednimi wyrazami.",
      "points": 3,
      "content": "Tekst z lukami oznaczonymi _____ (podkreślenie).",
      "answer": "Klucz: luka1 = wyraz, luka2 = wyraz..."
    },
    {
      "type": "open",
      "instruction": "Odpowiedz na pytanie pełnym zdaniem.",
      "points": 4,
      "content": "Treść pytania lub polecenia.",
      "lines": 5,
      "answer": "Model odpowiedzi dla nauczyciela."
    },
    {
      "type": "choice",
      "instruction": "Zaznacz poprawną odpowiedź.",
      "points": 1,
      "content": "Treść pytania.",
      "options": ["A) odpowiedź", "B) odpowiedź", "C) odpowiedź", "D) odpowiedź"],
      "correct": "B",
      "answer": "B — wyjaśnienie"
    },
    {
      "type": "true_false",
      "instruction": "Zaznacz P (prawda) lub F (fałsz).",
      "points": 3,
      "statements": [
        {"text": "Stwierdzenie 1.", "correct": "P"},
        {"text": "Stwierdzenie 2.", "correct": "F"},
        {"text": "Stwierdzenie 3.", "correct": "P"}
      ]
    },
    {
      "type": "match",
      "instruction": "Połącz elementy z kolumny A z kolumną B.",
      "points": 3,
      "pairs": [
        {"left": "element A1", "right": "element B1"},
        {"left": "element A2", "right": "element B2"}
      ],
      "answer": "A1-B1, A2-B2..."
    },
    {
      "type": "transform",
      "instruction": "Przekształć zdania według polecenia.",
      "points": 3,
      "sentences": ["Zdanie 1 do przekształcenia.", "Zdanie 2."],
      "answer": "1. Przekształcone zdanie 1. 2. Przekształcone zdanie 2."
    },
    {
      "type": "order",
      "instruction": "Uporządkuj elementy we właściwej kolejności.",
      "points": 2,
      "items": ["element C", "element A", "element B"],
      "answer": "Prawidłowa kolejność: A, B, C"
    },
    {
      "type": "text_analysis",
      "instruction": "Przeczytaj tekst i wykonaj polecenia.",
      "points": 5,
      "text": "Fragment tekstu do analizy...",
      "questions": ["Pytanie 1 do tekstu?", "Pytanie 2?"],
      "lines_per_question": 3,
      "answer": "1. Odpowiedź. 2. Odpowiedź."
    }
  ]
}

Typy ćwiczeń (używaj różnych!):
- fill_blanks: uzupełnianie luk
- open: pytanie otwarte z liniami na odpowiedź
- choice: pytanie zamknięte ABCD
- true_false: prawda/fałsz (lista stwierdzeń)
- match: łączenie w pary
- transform: przekształcanie zdań
- order: porządkowanie elementów
- text_analysis: analiza tekstu z pytaniami

Zasady:
- "totalPoints" = suma punktów
- Mieszaj typy ćwiczeń — nie powtarzaj tego samego typu
- Nie dodawaj odpowiedzi do karty ucznia — "answer" to klucz dla nauczyciela
- Odpowiadaj TYLKO JSON-em
PROMPT;

    public function buildUserPrompt(
        string $classLevel,
        string $topic,
        array $exerciseTypes,
        int $taskCount,
        string $duration,
        string $baseText = '',
    ): string {
        $types = implode(', ', $exerciseTypes);
        $ppForms = CurriculumContext::writingFormsForClass($classLevel);

        $prompt = <<<PROMPT
Wygeneruj kartę pracy z języka polskiego jako JSON.

Klasa: {$classLevel}
Temat lekcji: {$topic}
Zakres ćwiczeń: {$types}
Liczba zadań: {$taskCount}
Przewidywany czas pracy: {$duration}
Wymagane formy wypowiedzi wg PP MEN: {$ppForms}
PROMPT;

        if ($baseText !== '') {
            $prompt .= "\n\nTekst bazowy do wykorzystania w ćwiczeniach:\n\"\"\"\n{$baseText}\n\"\"\"";
        }

        $prompt .= "\n\nOdpowiedz WYŁĄCZNIE poprawnym JSON-em. Użyj różnych typów ćwiczeń.";

        return $prompt;
    }

    public static function parseResponse(string $response): ?array
    {
        $json = trim($response);
        $json = preg_replace('/^```(?:json)?\s*/i', '', $json);
        $json = preg_replace('/\s*```$/', '', $json);
        $json = trim($json);

        $data = json_decode($json, true);
        if (!$data || !isset($data['exercises'])) {
            return null;
        }

        if (!isset($data['totalPoints'])) {
            $data['totalPoints'] = array_sum(array_column($data['exercises'], 'points'));
        }

        return $data;
    }
}
