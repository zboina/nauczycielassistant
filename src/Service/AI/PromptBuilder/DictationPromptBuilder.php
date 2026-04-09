<?php

declare(strict_types=1);

namespace App\Service\AI\PromptBuilder;

class DictationPromptBuilder
{
    public const SYSTEM_PROMPT = <<<'PROMPT'
Jesteś doświadczonym nauczycielem języka polskiego w szkole podstawowej (klasy 4-8).
Tworzysz dyktanda ortograficzne zgodne z podstawą programową MEN.
KRYTYCZNE: Pisz WYŁĄCZNIE po polsku, alfabetem łacińskim. NIGDY nie używaj cyrylicy ani znaków z innych alfabetów.

MUSISZ odpowiedzieć WYŁĄCZNIE poprawnym JSON-em (bez markdown, bez ```json, bez komentarzy).

Gdy typ = "classic" (dyktando klasyczne):
{
  "title": "Dyktando — [temat]",
  "type": "classic",
  "text": "Pełny tekst dyktanda. Spójny, fabularny, ciekawy. Bez żadnych znaczników HTML.",
  "wordCount": 120,
  "difficultWords": [
    {"word": "góra", "rule": "ó wymienne na o: góra → gór"},
    {"word": "morze", "rule": "rz po spółgłosce: morze → morski (wymiana rz na r)"},
    {"word": "chrząszcz", "rule": "rz po ch + szcz — wyjątek, zapamiętaj"}
  ],
  "spellingCategories": ["ó/u", "rz/ż"],
  "hints": "Zwróć uwagę na pisownię ó/u i rz/ż."
}

Gdy typ = "quiz" (dyktando testowe):
{
  "title": "Dyktando testowe — [temat]",
  "type": "quiz",
  "questions": [
    {
      "optionA": "góra",
      "optionB": "gura",
      "correct": "A",
      "rule": "ó wymienne na o: góra → gór"
    },
    {
      "optionA": "może",
      "optionB": "morze",
      "correct": "B",
      "rule": "rz po spółgłosce: morze → morski"
    },
    {
      "optionA": "żółty",
      "optionB": "żułty",
      "correct": "A",
      "rule": "ó wymienne na o: żółty → żółć"
    },
    {
      "optionA": "chrząsz",
      "optionB": "chrząszcz",
      "correct": "B",
      "rule": "chrząszcz — pisownia rz po ch, szcz na końcu"
    }
  ],
  "totalQuestions": 20
}

Zasady dyktanda testowego:
- Każde pytanie to PARA: wyraz napisany POPRAWNIE i NIEPOPRAWNIE
- optionA i optionB — jeden poprawny, drugi z typowym błędem ortograficznym
- KRYTYCZNE: optionA i optionB MUSZĄ być RÓŻNE! Nigdy identyczne!
- KRYTYCZNE: Rozkład poprawnych odpowiedzi MUSI być mniej więcej 50/50!
  Czyli mniej więcej połowa pytań ma correct="A", połowa correct="B".
  NIE dawaj wszystkich poprawnych w A!
  Przykładowy rozkład dla 20 pytań: A,B,A,A,B,B,A,B,B,A,B,A,A,B,B,A,B,A,B,A
- correct = "A" lub "B" — wskazuje POPRAWNĄ pisownię
- Generuj 15-25 pytań (zależnie od wordCount)
- Błędy muszą być REALISTYCZNE — takie jakie uczniowie naprawdę popełniają
- Np: "rzeka" vs "żeka", "góra" vs "gura", "chrząszcz" vs "chrząsz", "niebieskie" vs "nie bieskie"
- KAŻDY wyraz musi mieć INNY błąd — nie powtarzaj tych samych par!

Zasady dyktanda klasycznego:
- Tekst dyktanda: spójny, fabularny, ciekawy — NIE lista zdań
- Dostosuj język do klasy (kl. 4 = prostszy, kl. 8 = bardziej literacki)
- difficultWords: 10-20 najtrudniejszych wyrazów z tekstu z regułą ortograficzną
- Odpowiadaj TYLKO JSON-em
PROMPT;

    public function buildUserPrompt(
        string $type,
        string $classLevel,
        string $difficulty,
        int $wordCount,
        string $spellingFocus,
    ): string {
        $focusDesc = match ($spellingFocus) {
            'ou' => 'pisownia ó/u (ó wymienne, u niewymienne)',
            'rzz' => 'pisownia rz/ż (rz po spółgłoskach, rz wymienne, ż wymienne)',
            'chh' => 'pisownia ch/h (ch w wyrazach rodzimych, h w obcych)',
            'nie' => 'pisownia "nie" z różnymi częściami mowy (łącznie/rozdzielnie)',
            'wielka' => 'wielka i mała litera (nazwy własne, geograficzne, święta)',
            'all' => 'wszystkie trudności ortograficzne (ó/u, rz/ż, ch/h, nie, wielka litera)',
            default => $spellingFocus,
        };

        $typeDesc = $type === 'quiz'
            ? 'Wygeneruj dyktando TESTOWE (typ "quiz") — pytania zamknięte z wyborem poprawnej/niepoprawnej pisowni.'
            : 'Wygeneruj dyktando KLASYCZNE (typ "classic") — spójny tekst do czytania przez nauczyciela.';

        return <<<PROMPT
{$typeDesc}

Klasa: {$classLevel}
Poziom trudności: {$difficulty}
Długość: ok. {$wordCount} słów
Zakres ortograficzny: {$focusDesc}

Odpowiedz WYŁĄCZNIE poprawnym JSON-em.
PROMPT;
    }

    public static function parseResponse(string $response): ?array
    {
        $json = trim($response);
        $json = preg_replace('/^```(?:json)?\s*/i', '', $json);
        $json = preg_replace('/\s*```$/', '', $json);
        $json = trim($json);

        $data = json_decode($json, true);
        if (!$data || (!isset($data['text']) && !isset($data['questions']))) {
            return null;
        }

        return $data;
    }
}
