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
        $sourceType = $request->request->get('sourceType'); // 'test' or 'exam'
        $sourceId = $request->request->getInt('sourceId');
        $file = $request->files->get('photo');

        if (!$file) {
            $this->addFlash('error', 'Nie przesłano zdjęcia.');
            return $this->redirectToRoute('app_scanner_index');
        }

        // Build answer key from source
        $answerKey = [];
        $sourceTitle = '';

        if ($sourceType === 'test' && $sourceId) {
            $material = $this->em->getRepository(GeneratedMaterial::class)->find($sourceId);
            if (!$material || $material->getOwner() !== $this->getUser()) {
                throw $this->createAccessDeniedException();
            }
            $parsed = TestPromptBuilder::parseResponse($material->getContent());
            if ($parsed && isset($parsed['questions'])) {
                foreach ($parsed['questions'] as $i => $q) {
                    if ($q['type'] === 'closed' && isset($q['correct'])) {
                        $answerKey[(string) ($i + 1)] = $q['correct'];
                    }
                }
            }
            $sourceTitle = $material->getTitle();
        } elseif ($sourceType === 'exam' && $sourceId) {
            $exam = $this->em->getRepository(MockExam::class)->find($sourceId);
            if (!$exam || $exam->getOwner() !== $this->getUser()) {
                throw $this->createAccessDeniedException();
            }
            $answerKey = $exam->getAnswerKey() ?? [];
            $sourceTitle = $exam->getTitle();
        }

        if (empty($answerKey)) {
            $this->addFlash('error', 'Wybrany materiał nie zawiera pytań zamkniętych z kluczem odpowiedzi.');
            return $this->redirectToRoute('app_scanner_index');
        }

        // Read and encode image
        $imageData = file_get_contents($file->getPathname());
        $mimeType = $file->getMimeType() ?: 'image/jpeg';
        $base64 = 'data:' . $mimeType . ';base64,' . base64_encode($imageData);

        // Call AI vision
        $builder = new AnswerScannerPromptBuilder();
        $userPrompt = $builder->buildUserPrompt(count($answerKey), $answerKey);

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

            // Grade answers
            $grading = AnswerScannerPromptBuilder::gradeAnswers($scanned['answers'], $answerKey);

            // Store in session for display
            $request->getSession()->set('scanner_result', [
                'scanned' => $scanned,
                'grading' => $grading,
                'sourceTitle' => $sourceTitle,
                'answerKey' => $answerKey,
                'imageData' => $base64,
            ]);

            return $this->redirectToRoute('app_scanner_result');

        } catch (\RuntimeException $e) {
            $this->addFlash('error', $e->getMessage());
            return $this->redirectToRoute('app_scanner_index');
        }
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
}
