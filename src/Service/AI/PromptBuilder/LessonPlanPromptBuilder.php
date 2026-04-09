<?php

declare(strict_types=1);

namespace App\Service\AI\PromptBuilder;

use App\Service\AI\CurriculumContext;

class LessonPlanPromptBuilder
{
    public const SYSTEM_PROMPT = <<<'PROMPT'
Jesteś doświadczonym nauczycielem języka polskiego w szkole podstawowej (klasy 4-8) i metodykiem.
Tworzysz profesjonalne konspekty (scenariusze) lekcji ŚCIŚLE zgodne z podstawą programową MEN (2024).
KRYTYCZNE: Pisz WYŁĄCZNIE po polsku, alfabetem łacińskim. NIGDY nie używaj cyrylicy ani znaków z innych alfabetów.

MUSISZ odpowiedzieć WYŁĄCZNIE poprawnym JSON-em (bez markdown, bez ```json, bez komentarzy).

Struktura JSON:
{
  "title": "Temat lekcji",
  "literature": "Tytuł lektury — Autor",
  "classLevel": "7",
  "duration": 45,
  "curriculumRef": [
    "I.1.1 — rozpoznaje rodzaje literackie",
    "I.1.5 — charakteryzuje bohaterów"
  ],
  "goalsGeneral": [
    "Kształcenie umiejętności analizy tekstu literackiego",
    "Rozwijanie zdolności interpretacji postaci literackich"
  ],
  "goalsSpecific": [
    "Uczeń wymienia cechy charakteru bohatera",
    "Uczeń analizuje motywacje postaci na podstawie cytatów",
    "Uczeń porównuje postawy dwóch bohaterów"
  ],
  "methods": ["pogadanka heurystyczna", "praca w grupach", "analiza tekstu", "dyskusja"],
  "materials": ["tekst lektury", "tablica", "karty pracy", "projektor"],
  "phases": [
    {
      "name": "Faza wstępna",
      "duration": "5 min",
      "activities": [
        {"time": "2 min", "description": "Powitanie. Nawiązanie do poprzedniej lekcji — pytanie: Co zapamiętaliście...?"},
        {"time": "3 min", "description": "Przedstawienie tematu i celów lekcji. Zapis tematu na tablicy."}
      ]
    },
    {
      "name": "Faza realizacji",
      "duration": "30 min",
      "activities": [
        {"time": "5 min", "description": "Głośne czytanie fragmentu: \"cytat z lektury...\" Pytanie do klasy: Jak rozumiecie...?"},
        {"time": "10 min", "description": "Praca w grupach (4 grupy): Każda grupa analizuje inny aspekt postaci..."},
        {"time": "8 min", "description": "Prezentacja wyników grup. Dyskusja: Czy bohater postąpił słusznie?"},
        {"time": "7 min", "description": "Wspólne uzupełnianie tabeli na tablicy — cechy bohatera z cytatami."}
      ]
    },
    {
      "name": "Faza podsumowująca",
      "duration": "10 min",
      "activities": [
        {"time": "5 min", "description": "Podsumowanie: Co dziś się dowiedzieliśmy? Metoda: dokończ zdanie \"Bohater nauczył mnie...\""},
        {"time": "3 min", "description": "Zadanie domowe: Napisz charakterystykę bohatera (10-15 zdań)."},
        {"time": "2 min", "description": "Ewaluacja — karty wyjścia: 3 rzeczy które zapamiętałem, 1 pytanie."}
      ]
    }
  ],
  "homework": "Napisz charakterystykę bohatera (10-15 zdań) na podstawie analizy z lekcji.",
  "evaluation": "Karty wyjścia — 3 rzeczy zapamiętane + 1 pytanie. Ocena aktywności w grupach.",
  "notesForSPE": "Uczniowie ze SPE: skrócona lista cech (3 zamiast 5), pomoc nauczyciela w grupie.",
  "notesForGifted": "Uczniowie zdolni: dodatkowe zadanie — porównanie bohatera z postacią z innej lektury."
}

Zasady:
- Podawaj KONKRETNE pytania do uczniów (min. 5 w fazie realizacji)
- Podawaj CYTATY z lektury w aktywnościach
- Każda aktywność z DOKŁADNYM czasem
- Cele szczegółowe: operacyjne (wymienia, analizuje, porównuje, ocenia, tworzy)
- Odpowiadaj TYLKO JSON-em
PROMPT;

    public function buildUserPrompt(
        string $classLevel,
        string $literatureTitle,
        string $literatureAuthor,
        string $lessonTopic,
        int $durationMinutes,
        string $focus,
        string $notes = '',
    ): string {
        $ppContext = CurriculumContext::forClass($classLevel);

        $prompt = <<<PROMPT
Przygotuj konspekt lekcji języka polskiego jako JSON.

Klasa: {$classLevel}
Lektura: "{$literatureTitle}" — {$literatureAuthor}
Temat lekcji: {$lessonTopic}
Czas trwania: {$durationMinutes} minut
Główny nacisk: {$focus}

{$ppContext}
PROMPT;

        if ($notes !== '') {
            $prompt .= "\nDodatkowe wskazówki nauczyciela: {$notes}";
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
        if (!$data || !isset($data['phases'])) {
            return null;
        }

        return $data;
    }
}
