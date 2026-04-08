<?php

declare(strict_types=1);

namespace App\Service\AI;

/**
 * Provides short, targeted excerpts from the Polish national curriculum (podstawa programowa MEN)
 * for use in AI prompts. Keeps token usage low by returning only relevant fragments.
 */
class CurriculumContext
{
    /**
     * Key skills/requirements per class group, extracted from PP MEN 2024.
     * Short enough to include in prompts without blowing up token costs.
     */
    private const REQUIREMENTS = [
        '4-6' => [
            'literary' => 'Uczeń: rozpoznaje gatunki (baśń, legenda, mit, opowiadanie, nowela, powieść); zna figury stylistyczne (epitety, porównania, przenośnie, uosobienia); rozpoznaje wers, rym, strofę; charakteryzuje bohaterów; rozróżnia narrację 1-os. i 3-os.; określa tematykę i problematykę utworu.',
            'language' => 'Uczeń: rozpoznaje części mowy i ich funkcje; odmienia przez przypadki, liczby, osoby; rozpoznaje zdania pojedyncze i złożone; rozumie znaczenie dosłowne i przenośne; zna synonimy, antonimy; stosuje poprawną ortografię i interpunkcję.',
            'writing' => 'Uczeń tworzy: dialog, opowiadanie, opis, list, sprawozdanie, charakterystykę, tekst argumentacyjny. Rozróżnia argumenty faktyczne od emocjonalnych.',
            'forms' => 'Formy wypowiedzi: opowiadanie, opis, list, sprawozdanie, charakterystyka, tekst argumentacyjny, zaproszenie, ogłoszenie, życzenia, dedykacja.',
        ],
        '7-8' => [
            'literary' => 'Uczeń: rozpoznaje rodzaje literackie (epika, liryka, dramat); gatunki (komedia, fraszka, pieśń, tren, ballada, tragedia); elementy dramatu (akt, scena, didaskalia); rozpoznaje symbol, alegorię, ironię, komizm; określa problematykę egzystencjalną; wykorzystuje konteksty biograficzny, historyczny, kulturowy.',
            'language' => 'Uczeń: rozpoznaje wyrazy pochodne i złożone; imiesłowy; wypowiedzenia wielokrotnie złożone; rozumie style (potoczny, urzędowy, artystyczny, naukowy); rozpoznaje archaizmy, kolokwializmy; rozróżnia normę wzorcową i użytkową.',
            'writing' => 'Uczeń tworzy: recenzję, rozprawkę, podanie, CV, list motywacyjny, przemówienie, wywiad. Streszcza, parafrazuje, polemizuje. Stosuje tezy, hipotezy, argumenty.',
            'forms' => 'Formy wypowiedzi: rozprawka, recenzja, podanie, CV, list motywacyjny, przemówienie, wywiad, streszczenie, charakterystyka porównawcza.',
        ],
    ];

    /**
     * Returns a compact curriculum context for the given class level.
     * Suitable for embedding in AI prompts (~200-300 tokens).
     */
    public static function forClass(string $classLevel): string
    {
        $num = (int) preg_replace('/\D/', '', $classLevel);
        $key = $num <= 6 ? '4-6' : '7-8';
        $req = self::REQUIREMENTS[$key];

        $label = $num <= 6 ? 'IV-VI' : 'VII-VIII';

        return <<<CTX
[Podstawa programowa MEN 2024 — kl. {$label}]
Kształcenie literackie: {$req['literary']}
Kształcenie językowe: {$req['language']}
Tworzenie wypowiedzi: {$req['writing']}
Wymagane formy: {$req['forms']}
CTX;
    }

    /**
     * Returns just the writing forms relevant for worksheets/tests.
     */
    public static function writingFormsForClass(string $classLevel): string
    {
        $num = (int) preg_replace('/\D/', '', $classLevel);
        $key = $num <= 6 ? '4-6' : '7-8';
        return self::REQUIREMENTS[$key]['forms'];
    }
}
