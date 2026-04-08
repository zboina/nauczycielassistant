<?php

declare(strict_types=1);

namespace App\Service;

use PhpOffice\PhpWord\PhpWord;
use PhpOffice\PhpWord\IOFactory;
use PhpOffice\PhpWord\SimpleType\Jc;
use PhpOffice\PhpWord\Style\ListItem;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpFoundation\StreamedResponse;

class DocxGenerator
{
    private const FONT = 'Calibri';
    private const SIZE_TITLE = 16;
    private const SIZE_H2 = 13;
    private const SIZE_H3 = 11;
    private const SIZE_BODY = 10;
    private const SIZE_SMALL = 8;

    public function generateTestDocx(array $testData, string $subject, string $classLevel, bool $includeAnswers = false): PhpWord
    {
        $word = new PhpWord();
        $word->setDefaultFontName(self::FONT);
        $word->setDefaultFontSize(self::SIZE_BODY);

        $section = $word->addSection(['marginTop' => 600, 'marginBottom' => 600, 'marginLeft' => 900, 'marginRight' => 900]);

        // Header
        $section->addText($testData['title'] ?? 'Sprawdzian — ' . $subject, ['bold' => true, 'size' => self::SIZE_TITLE], ['alignment' => Jc::CENTER]);
        $section->addText('Imię i nazwisko: ................................    Klasa: ..........    Data: ................', ['size' => self::SIZE_BODY]);
        $section->addText('Suma punktów: ......... / ' . ($testData['totalPoints'] ?? '?') . ' pkt', ['size' => self::SIZE_BODY, 'bold' => true], ['alignment' => Jc::END]);
        $section->addTextBreak();

        // Questions
        $letters = ['A', 'B', 'C', 'D'];
        foreach ($testData['questions'] ?? [] as $i => $q) {
            $section->addText('Zadanie ' . ($i + 1) . '. (' . ($q['points'] ?? 1) . ' pkt)', ['bold' => true, 'size' => self::SIZE_BODY]);
            $this->addHtmlText($section, $q['text'] ?? '');

            if ($q['type'] === 'closed' && isset($q['options'])) {
                foreach ($q['options'] as $k => $opt) {
                    $prefix = $letters[$k] . '. ';
                    $section->addText($prefix . strip_tags($opt), ['size' => self::SIZE_BODY]);
                }
                $section->addText('Odpowiedź zaznacz na karcie odpowiedzi.', ['size' => self::SIZE_SMALL, 'italic' => true, 'color' => '888888']);
            } elseif ($q['type'] === 'true_false') {
                $section->addText('☐ PRAWDA          ☐ FAŁSZ', ['size' => self::SIZE_BODY]);
            } elseif ($q['type'] === 'open') {
                for ($l = 0; $l < ($q['lines'] ?? 3); $l++) {
                    $section->addText('......................................................................................................................................................', ['size' => self::SIZE_BODY, 'color' => '999999']);
                }
            }
            $section->addTextBreak();
        }

        // Answer key
        if ($includeAnswers) {
            $section->addPageBreak();
            $section->addText('KLUCZ ODPOWIEDZI', ['bold' => true, 'size' => self::SIZE_H2], ['alignment' => Jc::CENTER]);
            $section->addTextBreak();
            foreach ($testData['questions'] ?? [] as $i => $q) {
                $answer = '';
                if ($q['type'] === 'closed') {
                    $answer = $q['correct'] ?? '?';
                } elseif ($q['type'] === 'true_false') {
                    $answer = ($q['correct'] ?? '') === 'P' ? 'PRAWDA' : 'FAŁSZ';
                } elseif ($q['type'] === 'open') {
                    $answer = $q['answer'] ?? '';
                }
                $section->addText(($i + 1) . '. ' . strip_tags($answer), ['size' => self::SIZE_BODY]);
            }
        }

        // Answer card
        $closedQ = [];
        foreach ($testData['questions'] ?? [] as $i => $q) {
            if ($q['type'] === 'closed') {
                $closedQ[] = ['num' => $i + 1, 'correct' => $q['correct'] ?? null];
            }
        }

        if (!empty($closedQ)) {
            $section->addPageBreak();
            $section->addText('KARTA ODPOWIEDZI', ['bold' => true, 'size' => self::SIZE_H2], ['alignment' => Jc::CENTER]);
            $section->addText('Zaznacz wybraną odpowiedź stawiając X w kratce.', ['size' => self::SIZE_SMALL, 'italic' => true], ['alignment' => Jc::CENTER]);
            $section->addText('Imię i nazwisko: ................................    Klasa: ..........', ['size' => self::SIZE_BODY]);
            $section->addTextBreak();

            $table = $section->addTable(['borderSize' => 6, 'borderColor' => '000000', 'cellMargin' => 60]);
            $headerStyle = ['bold' => true, 'size' => self::SIZE_BODY];
            $cellStyle = ['alignment' => Jc::CENTER, 'valign' => 'center'];

            $table->addRow();
            $table->addCell(800, $cellStyle)->addText('Nr', $headerStyle, ['alignment' => Jc::CENTER]);
            foreach ($letters as $l) {
                $table->addCell(1200, $cellStyle)->addText($l, $headerStyle, ['alignment' => Jc::CENTER]);
            }

            foreach ($closedQ as $cq) {
                $table->addRow(400);
                $table->addCell(800)->addText((string) $cq['num'], ['bold' => true, 'size' => self::SIZE_BODY], ['alignment' => Jc::CENTER]);
                foreach ($letters as $l) {
                    $cell = $table->addCell(1200);
                    if ($includeAnswers && $cq['correct'] === $l) {
                        $cell->addText('■', ['bold' => true, 'size' => 14], ['alignment' => Jc::CENTER]);
                    } else {
                        $cell->addText('☐', ['size' => 14], ['alignment' => Jc::CENTER]);
                    }
                }
            }
        }

        return $word;
    }

    public function generateWorksheetDocx(array $wsData, string $topic, string $classLevel, bool $includeAnswers = false): PhpWord
    {
        $word = new PhpWord();
        $word->setDefaultFontName(self::FONT);
        $word->setDefaultFontSize(self::SIZE_BODY);

        $section = $word->addSection(['marginTop' => 600, 'marginBottom' => 600, 'marginLeft' => 900, 'marginRight' => 900]);

        $section->addText($wsData['title'] ?? 'Karta pracy — ' . $topic, ['bold' => true, 'size' => self::SIZE_TITLE], ['alignment' => Jc::CENTER]);
        $section->addText('Imię i nazwisko: ................................    Klasa: ..........    Data: ................', ['size' => self::SIZE_BODY]);
        $section->addText('Suma punktów: ......... / ' . ($wsData['totalPoints'] ?? '?') . ' pkt', ['size' => self::SIZE_BODY, 'bold' => true], ['alignment' => Jc::END]);
        $section->addTextBreak();

        foreach ($wsData['exercises'] ?? [] as $i => $ex) {
            $section->addText('Zadanie ' . ($i + 1) . '. (' . ($ex['points'] ?? 1) . ' pkt)', ['bold' => true, 'size' => self::SIZE_BODY]);
            $section->addText(strip_tags($ex['instruction'] ?? ''), ['italic' => true, 'size' => self::SIZE_BODY]);

            $type = $ex['type'] ?? '';
            if ($type === 'fill_blanks' || $type === 'open') {
                $this->addHtmlText($section, $ex['content'] ?? '');
                if ($type === 'open') {
                    for ($l = 0; $l < ($ex['lines'] ?? 3); $l++) {
                        $section->addText('......................................................................................................................................................', ['color' => '999999']);
                    }
                }
            } elseif ($type === 'choice' && isset($ex['options'])) {
                $this->addHtmlText($section, $ex['content'] ?? '');
                foreach ($ex['options'] as $opt) {
                    $section->addText('☐ ' . strip_tags($opt), ['size' => self::SIZE_BODY]);
                }
            } elseif ($type === 'true_false' && isset($ex['statements'])) {
                $table = $section->addTable(['borderSize' => 4, 'borderColor' => '999999', 'cellMargin' => 40]);
                $table->addRow();
                $table->addCell(6000)->addText('Stwierdzenie', ['bold' => true, 'size' => self::SIZE_SMALL]);
                $table->addCell(800)->addText('P', ['bold' => true, 'size' => self::SIZE_SMALL], ['alignment' => Jc::CENTER]);
                $table->addCell(800)->addText('F', ['bold' => true, 'size' => self::SIZE_SMALL], ['alignment' => Jc::CENTER]);
                foreach ($ex['statements'] as $st) {
                    $table->addRow();
                    $table->addCell(6000)->addText(strip_tags($st['text']), ['size' => self::SIZE_BODY]);
                    $table->addCell(800)->addText('☐', ['size' => 12], ['alignment' => Jc::CENTER]);
                    $table->addCell(800)->addText('☐', ['size' => 12], ['alignment' => Jc::CENTER]);
                }
            } elseif ($type === 'match' && isset($ex['pairs'])) {
                $table = $section->addTable(['borderSize' => 4, 'borderColor' => '999999', 'cellMargin' => 40]);
                foreach ($ex['pairs'] as $k => $p) {
                    $table->addRow();
                    $table->addCell(3500)->addText(($k + 1) . '. ' . strip_tags($p['left']), ['size' => self::SIZE_BODY]);
                    $table->addCell(1000)->addText('→', ['size' => self::SIZE_BODY], ['alignment' => Jc::CENTER]);
                    $letters = ['a','b','c','d','e','f','g','h'];
                    $table->addCell(3500)->addText(($letters[$k] ?? '') . '. ' . strip_tags($p['right']), ['size' => self::SIZE_BODY]);
                }
            } elseif ($type === 'transform' && isset($ex['sentences'])) {
                foreach ($ex['sentences'] as $k => $s) {
                    $section->addText(($k + 1) . '. ' . strip_tags($s), ['size' => self::SIZE_BODY]);
                    $section->addText('......................................................................................................................................................', ['color' => '999999']);
                }
            } elseif ($type === 'order' && isset($ex['items'])) {
                $section->addText(implode('    |    ', array_map('strip_tags', $ex['items'])), ['size' => self::SIZE_BODY, 'bold' => true]);
                $section->addText('Kolejność: 1. .........  2. .........  3. .........  4. .........  5. .........', ['size' => self::SIZE_BODY]);
            } elseif ($type === 'text_analysis') {
                if (isset($ex['text'])) {
                    $section->addText(strip_tags($ex['text']), ['italic' => true, 'size' => self::SIZE_BODY]);
                }
                foreach ($ex['questions'] ?? [] as $k => $q) {
                    $section->addText(($k + 1) . '. ' . strip_tags($q), ['bold' => true, 'size' => self::SIZE_BODY]);
                    for ($l = 0; $l < ($ex['lines_per_question'] ?? 3); $l++) {
                        $section->addText('......................................................................................................................................................', ['color' => '999999']);
                    }
                }
            } else {
                $this->addHtmlText($section, $ex['content'] ?? '');
            }
            $section->addTextBreak();
        }

        // Answer key
        if ($includeAnswers) {
            $section->addPageBreak();
            $section->addText('KLUCZ ODPOWIEDZI', ['bold' => true, 'size' => self::SIZE_H2], ['alignment' => Jc::CENTER]);
            $section->addTextBreak();
            foreach ($wsData['exercises'] ?? [] as $i => $ex) {
                $answer = strip_tags($ex['answer'] ?? '—');
                $section->addText(($i + 1) . '. ' . $answer, ['size' => self::SIZE_BODY]);
            }
        }

        return $word;
    }

    public function generateLessonPlanDocx(array $lpData, string $topic): PhpWord
    {
        $word = new PhpWord();
        $word->setDefaultFontName(self::FONT);
        $word->setDefaultFontSize(self::SIZE_BODY);

        $section = $word->addSection(['marginTop' => 600, 'marginBottom' => 600, 'marginLeft' => 900, 'marginRight' => 900]);

        $section->addText($lpData['title'] ?? $topic, ['bold' => true, 'size' => self::SIZE_TITLE], ['alignment' => Jc::CENTER]);

        $meta = 'Klasa ' . ($lpData['classLevel'] ?? '') . ' | ' . ($lpData['duration'] ?? 45) . ' min';
        if (isset($lpData['literature'])) $meta .= ' | ' . $lpData['literature'];
        $section->addText($meta, ['size' => self::SIZE_SMALL, 'color' => '555555'], ['alignment' => Jc::CENTER]);
        $section->addTextBreak();

        // Goals
        if (!empty($lpData['goalsGeneral'])) {
            $section->addText('CELE OGÓLNE', ['bold' => true, 'size' => self::SIZE_H3, 'color' => '1a56db']);
            foreach ($lpData['goalsGeneral'] as $g) {
                $section->addListItem(strip_tags($g), 0, ['size' => self::SIZE_BODY]);
            }
            $section->addTextBreak();
        }
        if (!empty($lpData['goalsSpecific'])) {
            $section->addText('CELE SZCZEGÓŁOWE', ['bold' => true, 'size' => self::SIZE_H3, 'color' => '1a56db']);
            foreach ($lpData['goalsSpecific'] as $g) {
                $section->addListItem(strip_tags($g), 0, ['size' => self::SIZE_BODY]);
            }
            $section->addTextBreak();
        }

        // Methods & Materials
        if (!empty($lpData['methods'])) {
            $section->addText('METODY: ' . implode(', ', $lpData['methods']), ['size' => self::SIZE_BODY]);
        }
        if (!empty($lpData['materials'])) {
            $section->addText('ŚRODKI DYDAKTYCZNE: ' . implode(', ', $lpData['materials']), ['size' => self::SIZE_BODY]);
        }
        $section->addTextBreak();

        // Phases
        foreach ($lpData['phases'] ?? [] as $phase) {
            $section->addText(strtoupper($phase['name'] ?? '') . ' (' . ($phase['duration'] ?? '') . ')', ['bold' => true, 'size' => self::SIZE_H3, 'color' => '1a56db']);

            $table = $section->addTable(['borderSize' => 4, 'borderColor' => 'cccccc', 'cellMargin' => 40]);
            foreach ($phase['activities'] ?? [] as $act) {
                $table->addRow();
                $table->addCell(1200)->addText($act['time'] ?? '', ['bold' => true, 'size' => self::SIZE_BODY, 'color' => '555555']);
                $table->addCell(7000)->addText(strip_tags($act['description'] ?? ''), ['size' => self::SIZE_BODY]);
            }
            $section->addTextBreak();
        }

        // Footer sections
        if (!empty($lpData['homework'])) {
            $section->addText('PRACA DOMOWA', ['bold' => true, 'size' => self::SIZE_H3]);
            $section->addText(strip_tags($lpData['homework']), ['size' => self::SIZE_BODY]);
        }
        if (!empty($lpData['evaluation'])) {
            $section->addText('EWALUACJA', ['bold' => true, 'size' => self::SIZE_H3]);
            $section->addText(strip_tags($lpData['evaluation']), ['size' => self::SIZE_BODY]);
        }
        if (!empty($lpData['notesForSPE'])) {
            $section->addText('SPE: ' . strip_tags($lpData['notesForSPE']), ['size' => self::SIZE_BODY, 'italic' => true]);
        }
        if (!empty($lpData['notesForGifted'])) {
            $section->addText('Zdolni: ' . strip_tags($lpData['notesForGifted']), ['size' => self::SIZE_BODY, 'italic' => true]);
        }

        return $word;
    }

    public function generateMockExamDocx(array $data, int $maxPoints, bool $showAnswers = false): PhpWord
    {
        $word = new PhpWord();
        $word->setDefaultFontName(self::FONT);
        $word->setDefaultFontSize(self::SIZE_BODY);

        $section = $word->addSection(['marginTop' => 600, 'marginBottom' => 600, 'marginLeft' => 900, 'marginRight' => 900]);

        $section->addText($data['title'] ?? 'Arkusz próbny', ['bold' => true, 'size' => self::SIZE_TITLE], ['alignment' => Jc::CENTER]);
        $section->addText('Czas pracy: 180 minut | Maksymalna liczba punktów: ' . $maxPoints, ['size' => self::SIZE_SMALL, 'color' => '555555'], ['alignment' => Jc::CENTER]);
        $section->addTextBreak();
        $section->addText('Imię i nazwisko: ................................    Klasa: ..........    Data: ................', ['size' => self::SIZE_BODY]);
        $section->addTextBreak();
        $section->addText('INSTRUKCJA: Odpowiedzi do pytań zamkniętych zaznacz na karcie odpowiedzi. Odpowiedzi otwarte zapisz w wyznaczonych miejscach.', ['size' => self::SIZE_SMALL, 'italic' => true, 'bold' => true]);
        $section->addTextBreak();

        $letters = ['A','B','C','D'];
        foreach ($data['parts'] ?? [] as $part) {
            $section->addText(strtoupper($part['name'] ?? ''), ['bold' => true, 'size' => self::SIZE_H2, 'color' => '1a56db']);
            if (isset($part['text'])) {
                $section->addText(strip_tags($part['text']), ['italic' => true, 'size' => self::SIZE_BODY]);
                if (isset($part['textAuthor'])) {
                    $section->addText($part['textAuthor'], ['size' => self::SIZE_SMALL, 'color' => '555555'], ['alignment' => Jc::END]);
                }
            }
            $section->addTextBreak();

            foreach ($part['questions'] ?? [] as $q) {
                $section->addText('Zadanie ' . ($q['number'] ?? '') . '. (' . ($q['points'] ?? 1) . ' pkt)', ['bold' => true]);
                $section->addText(strip_tags($q['text'] ?? ''), ['size' => self::SIZE_BODY]);

                if ($q['type'] === 'closed' && isset($q['options'])) {
                    foreach ($q['options'] as $opt) {
                        $section->addText(strip_tags($opt), ['size' => self::SIZE_BODY]);
                    }
                    $section->addText('Odpowiedź zaznacz na karcie odpowiedzi.', ['size' => self::SIZE_SMALL, 'italic' => true, 'color' => '888888']);
                } else {
                    $lines = ($q['points'] ?? 1) <= 2 ? 3 : (($q['points'] ?? 1) <= 3 ? 5 : 8);
                    for ($l = 0; $l < $lines; $l++) {
                        $section->addText('......................................................................................................................................................', ['color' => '999999']);
                    }
                    if ($showAnswers && isset($q['answer'])) {
                        $section->addText('Odpowiedź: ' . strip_tags($q['answer']), ['size' => self::SIZE_SMALL, 'color' => '0066cc', 'bold' => true]);
                    }
                }
                $section->addTextBreak();
            }
        }

        // Essay topics
        if (isset($data['essayTopics'])) {
            $section->addText('CZĘŚĆ 3 — WYPRACOWANIE (' . ($data['essayMaxPoints'] ?? 20) . ' pkt)', ['bold' => true, 'size' => self::SIZE_H2, 'color' => '1a56db']);
            $section->addText('Wybierz jeden z poniższych tematów i napisz wypracowanie (min. ' . ($data['essayTopics'][0]['minWords'] ?? 200) . ' słów).', ['size' => self::SIZE_BODY]);
            foreach ($data['essayTopics'] as $k => $topic) {
                $section->addText('Temat ' . ($k + 1) . ' (' . ($topic['type'] ?? '') . '):', ['bold' => true, 'size' => self::SIZE_BODY]);
                $section->addText($topic['topic'] ?? '', ['size' => self::SIZE_BODY]);
                $section->addTextBreak();
            }
        }

        return $word;
    }

    public function generateResponse(PhpWord $word, string $filename): StreamedResponse
    {
        $response = new StreamedResponse(function () use ($word) {
            $writer = IOFactory::createWriter($word, 'Word2007');
            $writer->save('php://output');
        });

        $response->headers->set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        $response->headers->set('Content-Disposition', 'attachment; filename="' . $filename . '"');

        return $response;
    }

    private function addHtmlText($section, string $text): void
    {
        $text = strip_tags($text, '<b><i><u><strong><em>');
        // Simple: just strip remaining tags for DOCX
        $clean = strip_tags($text);
        if ($clean !== '') {
            $section->addText($clean, ['size' => self::SIZE_BODY]);
        }
    }
}
