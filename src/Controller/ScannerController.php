<?php

declare(strict_types=1);

namespace App\Controller;

use App\Entity\GeneratedMaterial;
use App\Entity\MockExam;
use App\Service\AI\OpenRouterClient;
use App\Service\AI\PromptBuilder\AnswerScannerPromptBuilder;
use App\Service\AI\PromptBuilder\TestPromptBuilder;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/scanner')]
class ScannerController extends AbstractController
{
    public function __construct(
        private readonly OpenRouterClient $ai,
        private readonly EntityManagerInterface $em,
    ) {}

    #[Route('', name: 'app_scanner_index')]
    public function index(): Response
    {
        // Get available tests and exams with answer keys
        $tests = $this->em->getRepository(GeneratedMaterial::class)->findBy(
            ['owner' => $this->getUser(), 'type' => 'test'],
            ['createdAt' => 'DESC'],
            30,
        );

        $exams = $this->em->getRepository(MockExam::class)->findBy(
            ['owner' => $this->getUser()],
            ['createdAt' => 'DESC'],
            20,
        );

        return $this->render('scanner/index.html.twig', [
            'tests' => $tests,
            'exams' => $exams,
        ]);
    }

    #[Route('/scan', name: 'app_scanner_scan', methods: ['POST'])]
    public function scan(Request $request): Response
    {
        $sourceType = $request->request->get('sourceType'); // 'test', 'exam', or 'auto'
        $sourceId = $request->request->getInt('sourceId');
        $file = $request->files->get('photo');

        if (!$file) {
            $this->addFlash('error', 'Nie przesłano zdjęcia.');
            return $this->redirectToRoute('app_scanner_index');
        }

        // Read and encode image
        $imageData = file_get_contents($file->getPathname());
        $mimeType = $file->getMimeType() ?: 'image/jpeg';
        $base64 = 'data:' . $mimeType . ';base64,' . base64_encode($imageData);

        // Call AI vision — always scan first, then match
        $builder = new AnswerScannerPromptBuilder();
        $userPrompt = $builder->buildUserPrompt(0); // 0 = unknown count, AI reads from card

        try {
            $result = $this->ai->generate(
                userPrompt: $userPrompt,
                systemPrompt: AnswerScannerPromptBuilder::SYSTEM_PROMPT,
                module: 'answer_scanner',
                maxTokens: 2000,
                owner: $this->getUser(),
                imageBase64: $base64,
            );

            $scanned = AnswerScannerPromptBuilder::parseResponse($result);

            if (!$scanned) {
                $this->addFlash('warning', 'AI nie mogło odczytać karty. Spróbuj zrobić wyraźniejsze zdjęcie.');
                return $this->redirectToRoute('app_scanner_index');
            }

            // Resolve source — auto-detect from code or use manual selection
            $answerKey = [];
            $sourceTitle = '';

            if ($sourceType === 'auto' && isset($scanned['examCode']) && $scanned['examCode']) {
                [$sourceType, $sourceId] = $this->resolveExamCode($scanned['examCode']);
            }

            if ($sourceType === 'test' && $sourceId) {
                $material = $this->em->getRepository(GeneratedMaterial::class)->find($sourceId);
                if ($material && $material->getOwner() === $this->getUser()) {
                    $parsed = TestPromptBuilder::parseResponse($material->getContent());
                    if ($parsed && isset($parsed['questions'])) {
                        foreach ($parsed['questions'] as $i => $q) {
                            if ($q['type'] === 'closed' && isset($q['correct'])) {
                                $answerKey[(string) ($i + 1)] = $q['correct'];
                            }
                        }
                    }
                    $sourceTitle = $material->getTitle();
                }
            } elseif ($sourceType === 'exam' && $sourceId) {
                $exam = $this->em->getRepository(MockExam::class)->find($sourceId);
                if ($exam && $exam->getOwner() === $this->getUser()) {
                    $answerKey = $exam->getAnswerKey() ?? [];
                    $sourceTitle = $exam->getTitle();
                }
            }

            if (empty($answerKey)) {
                $this->addFlash('warning', 'Nie znaleziono sprawdzianu z kodem "' . ($scanned['examCode'] ?? '?') . '".');
            }

            // Store scanned data — go to correction screen
            $request->getSession()->set('scanner_data', [
                'scanned' => $scanned,
                'sourceTitle' => $sourceTitle,
                'answerKey' => $answerKey,
                'imageData' => $base64,
            ]);

            return $this->redirectToRoute('app_scanner_correct');

        } catch (\RuntimeException $e) {
            $this->addFlash('error', $e->getMessage());
            return $this->redirectToRoute('app_scanner_index');
        }
    }

    /**
     * Parse exam code like "T-42" or "E-15" into [sourceType, sourceId].
     * @return array{string, int}
     */
    private function resolveExamCode(string $code): array
    {
        if (preg_match('/^T-(\d+)$/i', $code, $m)) {
            return ['test', (int) $m[1]];
        }
        if (preg_match('/^E-(\d+)$/i', $code, $m)) {
            return ['exam', (int) $m[1]];
        }
        return ['', 0];
    }

    #[Route('/result', name: 'app_scanner_result')]
    public function result(Request $request): Response
    {
        $data = $request->getSession()->get('scanner_result');
        if (!$data) {
            return $this->redirectToRoute('app_scanner_index');
        }

        return $this->render('scanner/result.html.twig', [
            'scanned' => $data['scanned'],
            'grading' => $data['grading'],
            'sourceTitle' => $data['sourceTitle'],
            'answerKey' => $data['answerKey'],
            'imageData' => $data['imageData'],
        ]);
    }

    // ─── Correction screen ──────────────────────────────

    #[Route('/correct', name: 'app_scanner_correct')]
    public function correct(Request $request): Response
    {
        $data = $request->getSession()->get('scanner_data');
        if (!$data) {
            return $this->redirectToRoute('app_scanner_index');
        }

        return $this->render('scanner/correct.html.twig', [
            'scanned' => $data['scanned'],
            'answerKey' => $data['answerKey'],
            'sourceTitle' => $data['sourceTitle'],
            'imageData' => $data['imageData'],
        ]);
    }

    // ─── Grade after correction ─────────────────────────

    #[Route('/grade', name: 'app_scanner_grade', methods: ['POST'])]
    public function grade(Request $request): Response
    {
        $data = $request->getSession()->get('scanner_data');
        if (!$data) {
            return $this->redirectToRoute('app_scanner_index');
        }

        // Get corrected answers from form
        $correctedAnswers = [];
        foreach ($request->request->all('answer') as $qNum => $value) {
            $correctedAnswers[(string) $qNum] = $value ?: null;
        }

        $answerKey = $data['answerKey'];
        $grading = !empty($answerKey)
            ? AnswerScannerPromptBuilder::gradeAnswers($correctedAnswers, $answerKey)
            : null;

        $request->getSession()->set('scanner_result', [
            'scanned' => array_merge($data['scanned'], ['answers' => $correctedAnswers]),
            'grading' => $grading,
            'sourceTitle' => $data['sourceTitle'],
            'answerKey' => $answerKey,
            'imageData' => $data['imageData'],
        ]);

        return $this->redirectToRoute('app_scanner_result');
    }
}
