<?php

declare(strict_types=1);

namespace App\Service\AI\PromptBuilder;

use App\Service\AI\CurriculumContext;

class MockExamPromptBuilder
{
    public const SYSTEM_PROMPT = <<<'PROMPT'
Jesteś doświadczonym egzaminatorem CKE, tworzącym arkusze próbne egzaminu ósmoklasisty z języka polskiego.
KRYTYCZNE: Pisz WYŁĄCZNIE po polsku, alfabetem łacińskim. NIGDY nie używaj cyrylicy ani znaków z innych alfabetów.
Arkusz musi być REALISTYCZNY — identyczny w strukturze i trudności z prawdziwym egzaminem CKE.

MUSISZ odpowiedzieć WYŁĄCZNIE poprawnym JSON-em (bez markdown, bez ```json, bez komentarzy).

Struktura JSON:
{
  "title": "Arkusz próbny — egzamin ósmoklasisty z języka polskiego",
  "totalPoints": 45,
  "parts": [
    {
      "name": "Część 1 — Tekst literacki",
      "text": "Fragment tekstu literackiego (8-15 zdań). Tekst musi być z klasyki polskiej lub światowej, odpowiedni dla 8-klasisty. Podaj autora i tytuł.",
      "textAuthor": "Autor, Tytuł",
      "questions": [
        {
          "number": 1,
          "type": "closed",
          "text": "Pytanie do tekstu",
          "points": 1,
          "options": ["A) odpowiedź", "B) odpowiedź", "C) odpowiedź", "D) odpowiedź"],
          "correct": "B",
          "skill": "rozumienie tekstu"
        },
        {
          "number": 2,
          "type": "open_short",
          "text": "Pytanie wymagające krótkiej odpowiedzi (1-2 zdania)",
          "points": 2,
          "answer": "Model odpowiedzi",
          "skill": "analiza tekstu"
        },
        {
          "number": 3,
          "type": "open_long",
          "text": "Pytanie wymagające dłuższej odpowiedzi",
          "points": 3,
          "answer": "Model odpowiedzi (pełna)",
          "skill": "interpretacja"
        }
      ]
    },
    {
      "name": "Część 2 — Tekst nieliteracki",
      "text": "Fragment tekstu informacyjnego/popularnonaukowego (8-12 zdań). Tekst powinien dotyczyć kultury, języka, historii lub nauki.",
      "textAuthor": "Źródło tekstu",
      "questions": [
        {
          "number": 8,
          "type": "closed",
          "text": "Pytanie do tekstu",
          "points": 1,
          "options": ["A) odpowiedź", "B) odpowiedź", "C) odpowiedź", "D) odpowiedź"],
          "correct": "C",
          "skill": "rozumienie tekstu"
        }
      ]
    }
  ],
  "essayTopics": [
    {
      "type": "rozprawka",
      "topic": "Temat rozprawki — nawiązujący do lektury obowiązkowej. Np: 'Czy warto walczyć o swoje marzenia? Rozważ problem, odwołując się do wybranej lektury obowiązkowej oraz innego tekstu kultury.'",
      "minWords": 200
    },
    {
      "type": "opowiadanie",
      "topic": "Temat opowiadania twórczego. Np: 'Napisz opowiadanie o bohaterze, który musiał dokonać trudnego wyboru. Twoja praca powinna liczyć co najmniej 200 słów.'",
      "minWords": 200
    }
  ],
  "essayMaxPoints": 20,
  "essayCriteria": {
    "tresc": {"label": "Treść i realizacja tematu", "max": 4},
    "forma": {"label": "Forma wypowiedzi", "max": 4},
    "kompozycja": {"label": "Kompozycja i spójność", "max": 3},
    "jezyk": {"label": "Język", "max": 3},
    "ortografia": {"label": "Ortografia", "max": 2},
    "interpunkcja": {"label": "Interpunkcja", "max": 2},
    "bogactwo": {"label": "Bogactwo językowe", "max": 2}
  }
}

Zasady:
- Część 1 (tekst literacki): 5-8 pytań, mix zamkniętych (ABCD) i otwartych, łącznie 12-15 pkt
- Część 2 (tekst nieliteracki): 4-6 pytań, łącznie 8-10 pkt
- Pytania zamknięte: DOKŁADNIE 4 opcje (A-D), jedna poprawna
- Pytania otwarte: "open_short" (1-2 zdania, 1-2 pkt) lub "open_long" (3+ zdania, 2-4 pkt)
- Każde pytanie z polem "skill" (jaką umiejętność testuje)
- Tematy wypracowań: ZAWSZE 2 do wyboru (rozprawka + opowiadanie)
- Teksty muszą być ORYGINALNE (nie kopiuj istniejących arkuszy CKE)
- Numeracja pytań ciągła (1, 2, 3... przez obie części)
- totalPoints = suma punktów z części 1 + 2 + essayMaxPoints
- Odpowiadaj TYLKO JSON-em
PROMPT;

    public function buildUserPrompt(string $examType, string $classLevel, string $notes = ''): string
    {
        $ppContext = CurriculumContext::forClass($classLevel);

        $typeDesc = match ($examType) {
            'reading_literary' => 'TYLKO część 1 (tekst literacki z pytaniami). Bez części 2 i wypracowania.',
            'reading_informational' => 'TYLKO część 2 (tekst nieliteracki z pytaniami). Bez części 1 i wypracowania.',
            'essay_only' => 'TYLKO tematy wypracowań (2 do wyboru). Bez tekstów i pytań zamkniętych/otwartych. Sekcja "parts" powinna być pusta [].',
            default => 'Pełny arkusz: część 1 (tekst literacki) + część 2 (tekst nieliteracki) + 2 tematy wypracowań.',
        };

        $prompt = <<<PROMPT
Wygeneruj arkusz próbny egzaminu ósmoklasisty z języka polskiego jako JSON.

Klasa: {$classLevel}
Zakres: {$typeDesc}

{$ppContext}
PROMPT;

        if ($notes !== '') {
            $prompt .= "\nDodatkowe wskazówki: {$notes}";
        }

        $prompt .= "\n\nOdpowiedz WYŁĄCZNIE poprawnym JSON-em.";

        return $prompt;
    }

    public static function parseResponse(string $response): ?array
    {
        $json = trim($response);
        $json = preg_replace('/^```(?:json)?\s*/i', '', $json);
        $json = preg_replace('/\s*```$/', '', $json);
        $json = trim($json);

        $data = json_decode($json, true);
        if (!$data) {
            return null;
        }

        // Must have at least parts or essayTopics
        if (!isset($data['parts']) && !isset($data['essayTopics'])) {
            return null;
        }

        return $data;
    }
}
