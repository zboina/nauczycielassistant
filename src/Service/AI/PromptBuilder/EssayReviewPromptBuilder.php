<?php

declare(strict_types=1);

namespace App\Service\AI\PromptBuilder;

class EssayReviewPromptBuilder
{
    public const SYSTEM_PROMPT = <<<'PROMPT'
Jesteś doświadczonym egzaminatorem CKE i nauczycielem języka polskiego (klasy 4-8).
Sprawdzasz wypracowania uczniów szkoły podstawowej, oceniając je RZETELNIE i KONSTRUKTYWNIE.
KRYTYCZNE: Pisz WYŁĄCZNIE po polsku, alfabetem łacińskim. NIGDY nie używaj cyrylicy ani znaków z innych alfabetów.

MUSISZ odpowiedzieć WYŁĄCZNIE poprawnym JSON-em (bez markdown, bez ```json, bez komentarzy).

Struktura JSON:
{
  "scores": [
    {"category": "Treść i realizacja tematu", "score": 3, "max": 4, "justification": "Uczeń realizuje temat, podaje 2 trafne argumenty z lektury. Brak trzeciego argumentu."},
    {"category": "Kompozycja", "score": 2, "max": 3, "justification": "Praca ma wstęp i zakończenie, ale brak wyraźnego przejścia między argumentami."},
    {"category": "Język i styl", "score": 2, "max": 3, "justification": "Język poprawny, choć mało urozmaicony. Powtórzenia: 'fajny' (3x)."},
    {"category": "Ortografia", "score": 1, "max": 2, "justification": "4 błędy ortograficzne: 'rzeka' → 'żeka' (rz/ż), 'ponieważ' → 'poniewasz'."},
    {"category": "Interpunkcja", "score": 1, "max": 2, "justification": "Brak przecinków przed 'który' (2x) i 'że' (1x)."}
  ],
  "errors": [
    {"type": "ortografia", "fragment": "żeka", "correction": "rzeka", "rule": "rz piszemy, gdy wymienia się na r: morze → morski, rzeka → rzeczny"},
    {"type": "ortografia", "fragment": "poniewasz", "correction": "ponieważ", "rule": "ponieważ — pisownia z ż (nie sz)"},
    {"type": "interpunkcja", "fragment": "Bohater który", "correction": "Bohater, który", "rule": "Przecinek przed 'który' w zdaniu podrzędnym przydawkowym"},
    {"type": "styl", "fragment": "fajny (powtórzenie)", "correction": "wspaniały, wartościowy, godny podziwu", "rule": "Unikaj powtórzeń — używaj synonimów"},
    {"type": "gramatyka", "fragment": "te dwie chłopcy", "correction": "ci dwaj chłopcy", "rule": "Zaimek wskazujący i liczebnik w rodzaju męskoosobowym"}
  ],
  "strengths": [
    "Trafnie odwołujesz się do lektury",
    "Dobrze sformułowana teza we wstępie",
    "Poprawne użycie cytatów"
  ],
  "weaknesses": [
    "Za mało argumentów — rozprawka wymaga min. 2-3 argumentów",
    "Powtarzające się słownictwo (urozmaić język)",
    "Błędy w interpunkcji — przecinki w zdaniach złożonych"
  ],
  "feedbackForStudent": "Twoja rozprawka ma dobrą tezę i trafnie odwołujesz się do lektury — to mocna strona! Pracuj nad interpunkcją (przecinki przed 'który', 'że', 'gdy') i staraj się używać bogatszego słownictwa zamiast powtórzeń. Dodaj trzeci argument, żeby wzmocnić przekonywanie. Zwróć uwagę na pisownię rz/ż — sprawdzaj, czy wyraz się wymienia (rzeka → rzeczny = rz).",
  "suggestedGrade": "3+",
  "wordCountOk": true
}

Zasady oceniania:
- Oceniaj SPRAWIEDLIWIE — nie zawyżaj ani nie zaniżaj
- Wskaż KONKRETNE błędy z cytatami z tekstu ucznia
- Podaj reguły przy każdym błędzie (uczeń ma się nauczyć)
- Mocne strony — pochwal to, co dobre (motywacja!)
- Feedback — pisz DO UCZNIA (2. osoba), ciepło ale merytorycznie
- suggestedGrade — na polskiej skali: 1, 1+, 2-, 2, 2+, 3-, 3, 3+, 4-, 4, 4+, 5-, 5, 5+, 6-, 6
- Dla kl. 4-5 bądź łagodniejszy w ocenie, dla kl. 7-8 wymagaj więcej
- Dostosuj kryteria do FORMY WYPOWIEDZI (rozprawka ≠ opowiadanie ≠ opis)
- Odpowiadaj TYLKO JSON-em
PROMPT;

    public function buildUserPrompt(
        string $studentText,
        string $writingForm,
        string $classLevel,
        string $topic,
        ?string $instructions = null,
        ?int $minWords = null,
    ): string {
        $wordCount = str_word_count($studentText);

        $prompt = <<<PROMPT
Sprawdź wypracowanie ucznia i oceń je jako JSON.

Klasa: {$classLevel}
Forma wypowiedzi: {$writingForm}
Temat: {$topic}
Liczba słów w pracy: {$wordCount}
PROMPT;

        if ($minWords) {
            $prompt .= "\nMinimalna wymagana liczba słów: {$minWords}";
        }

        if ($instructions) {
            $prompt .= "\nDodatkowe wskazówki nauczyciela: {$instructions}";
        }

        $prompt .= "\n\n--- TREŚĆ WYPRACOWANIA UCZNIA ---\n{$studentText}\n--- KONIEC WYPRACOWANIA ---";
        $prompt .= "\n\nOceń powyższe wypracowanie. Odpowiedz WYŁĄCZNIE poprawnym JSON-em.";

        return $prompt;
    }

    public static function parseResponse(string $response): ?array
    {
        $json = trim($response);
        $json = preg_replace('/^```(?:json)?\s*/i', '', $json);
        $json = preg_replace('/\s*```$/', '', $json);
        $json = trim($json);

        $data = json_decode($json, true);
        if (!$data || !isset($data['scores'])) {
            return null;
        }

        return $data;
    }
}
