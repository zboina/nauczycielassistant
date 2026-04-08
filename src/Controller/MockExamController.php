<?php

declare(strict_types=1);

namespace App\Controller;

use App\Entity\MockExam;
use App\Entity\MockExamResult;
use App\Repository\MockExamRepository;
use App\Service\AI\OpenRouterClient;
use App\Service\AI\PromptBuilder\MockExamPromptBuilder;
use App\Service\PdfGenerator;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/exam8')]
class MockExamController extends AbstractController
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly OpenRouterClient $ai,
        private readonly PdfGenerator $pdf,
    ) {}

    // ─── List all exams ─────────────────────────────────────

    #[Route('', name: 'app_exam8_index')]
    public function index(MockExamRepository $repo): Response
    {
        return $this->render('exam8/index.html.twig', [
            'exams' => $repo->findByOwner($this->getUser()),
        ]);
    }

    // ─── Generate new exam ──────────────────────────────────

    #[Route('/generate', name: 'app_exam8_generate')]
    public function generate(Request $request): Response
    {
        if ($request->isMethod('POST')) {
            $examType = $request->request->get('examType', 'full');
            $classLevel = $request->request->get('classLevel', '8');
            $notes = $request->request->get('notes', '');

            $builder = new MockExamPromptBuilder();
            $userPrompt = $builder->buildUserPrompt($examType, $classLevel, $notes);

            try {
                $result = $this->ai->generate(
                    userPrompt: $userPrompt,
                    systemPrompt: MockExamPromptBuilder::SYSTEM_PROMPT,
                    module: 'mock_exam_generator',
                    maxTokens: 8000,
                    owner: $this->getUser(),
                );

                $parsed = MockExamPromptBuilder::parseResponse($result);

                if ($parsed) {
                    // Build answer key from closed questions
                    $answerKey = [];
                    foreach ($parsed['parts'] ?? [] as $part) {
                        foreach ($part['questions'] ?? [] as $q) {
                            if ($q['type'] === 'closed' && isset($q['correct'])) {
                                $answerKey[(string) $q['number']] = $q['correct'];
                            }
                        }
                    }

                    $exam = new MockExam();
                    $exam->setTitle($parsed['title'] ?? 'Arkusz próbny ' . date('d.m.Y'));
                    $exam->setClassLevel($classLevel);
                    $exam->setExamType($examType);
                    $exam->setExamContent($parsed);
                    $exam->setAnswerKey($answerKey);
                    $exam->setPromptUsed($userPrompt);
                    $exam->setOwner($this->getUser());

                    $this->em->persist($exam);
                    $this->em->flush();

                    $this->addFlash('success', 'Arkusz próbny wygenerowany!');

                    return $this->redirectToRoute('app_exam8_show', ['id' => $exam->getId()]);
                } else {
                    $this->addFlash('warning', 'AI nie zwróciło poprawnego formatu. Spróbuj ponownie.');
                }
            } catch (\RuntimeException $e) {
                $this->addFlash('error', $e->getMessage());
            }

            return $this->redirectToRoute('app_exam8_generate');
        }

        return $this->render('exam8/generate.html.twig', [
            'examTypes' => MockExam::getExamTypeLabels(),
        ]);
    }

    // ─── Show exam with preview ─────────────────────────────

    #[Route('/{id}', name: 'app_exam8_show', requirements: ['id' => '\d+'])]
    public function show(MockExam $exam): Response
    {
        if ($exam->getOwner() !== $this->getUser()) {
            throw $this->createAccessDeniedException();
        }

        return $this->render('exam8/show.html.twig', [
            'exam' => $exam,
            'data' => $exam->getExamContent(),
        ]);
    }

    // ─── PDF export ─────────────────────────────────────────

    #[Route('/{id}/pdf', name: 'app_exam8_pdf', requirements: ['id' => '\d+'])]
    public function pdf(MockExam $exam, Request $request): Response
    {
        if ($exam->getOwner() !== $this->getUser()) {
            throw $this->createAccessDeniedException();
        }

        $showAnswers = $request->query->getBoolean('answers');

        return $this->pdf->generateResponse(
            'pdf/mock_exam.html.twig',
            ['exam' => $exam, 'data' => $exam->getExamContent(), 'showAnswers' => $showAnswers],
            'egzamin_probny_' . date('Y-m-d') . '.pdf',
        );
    }

    // ─── Enter results ──────────────────────────────────────

    #[Route('/{id}/results', name: 'app_exam8_results', requirements: ['id' => '\d+'])]
    public function results(Request $request, MockExam $exam): Response
    {
        if ($exam->getOwner() !== $this->getUser()) {
            throw $this->createAccessDeniedException();
        }

        if ($request->isMethod('POST')) {
            $action = $request->request->get('_action');

            if ($action === 'add') {
                $studentName = trim($request->request->get('studentName', ''));
                if ($studentName !== '') {
                    $scores = [];
                    foreach ($request->request->all('score') as $key => $val) {
                        $scores[$key] = (int) $val;
                    }

                    $result = new MockExamResult();
                    $result->setExam($exam);
                    $result->setStudentName($studentName);
                    $result->setScores($scores);
                    $result->setNotes($request->request->get('notes') ?: null);

                    $this->em->persist($result);
                    $this->em->flush();

                    $this->addFlash('success', 'Wynik dodany: ' . $studentName);
                }
            } elseif ($action === 'delete') {
                $resultId = $request->request->getInt('resultId');
                $resultEntity = $this->em->getRepository(MockExamResult::class)->find($resultId);
                if ($resultEntity && $resultEntity->getExam() === $exam) {
                    $this->em->remove($resultEntity);
                    $this->em->flush();
                    $this->addFlash('success', 'Wynik usunięty.');
                }
            }

            return $this->redirectToRoute('app_exam8_results', ['id' => $exam->getId()]);
        }

        // Build scoring categories from exam content
        $categories = $this->buildScoringCategories($exam);

        return $this->render('exam8/results.html.twig', [
            'exam' => $exam,
            'categories' => $categories,
        ]);
    }

    // ─── Analysis ───────────────────────────────────────────

    #[Route('/{id}/analysis', name: 'app_exam8_analysis', requirements: ['id' => '\d+'])]
    public function analysis(MockExam $exam): Response
    {
        if ($exam->getOwner() !== $this->getUser()) {
            throw $this->createAccessDeniedException();
        }

        $categories = $this->buildScoringCategories($exam);
        $results = $exam->getResults()->toArray();

        // Calculate per-category averages
        $categoryStats = [];
        foreach ($categories as $key => $cat) {
            $scores = array_map(fn($r) => $r->getScores()[$key] ?? 0, $results);
            $categoryStats[$key] = [
                'label' => $cat['label'],
                'max' => $cat['max'],
                'avg' => count($scores) > 0 ? round(array_sum($scores) / count($scores), 1) : 0,
                'pct' => count($scores) > 0 && $cat['max'] > 0
                    ? round(array_sum($scores) / count($scores) / $cat['max'] * 100, 0)
                    : 0,
            ];
        }

        // Sort by weakest
        $weakest = $categoryStats;
        uasort($weakest, fn($a, $b) => $a['pct'] <=> $b['pct']);

        // Score distribution (buckets: 0-19%, 20-39%, 40-59%, 60-79%, 80-100%)
        $distribution = [0, 0, 0, 0, 0];
        foreach ($results as $r) {
            $pct = $r->getPercent();
            $bucket = min(4, (int) floor($pct / 20));
            $distribution[$bucket]++;
        }

        return $this->render('exam8/analysis.html.twig', [
            'exam' => $exam,
            'results' => $results,
            'categoryStats' => $categoryStats,
            'weakest' => array_slice($weakest, 0, 5, true),
            'distribution' => $distribution,
        ]);
    }

    // ─── Delete exam ────────────────────────────────────────

    #[Route('/{id}/delete', name: 'app_exam8_delete', requirements: ['id' => '\d+'], methods: ['POST'])]
    public function delete(MockExam $exam): Response
    {
        if ($exam->getOwner() !== $this->getUser()) {
            throw $this->createAccessDeniedException();
        }

        $this->em->remove($exam);
        $this->em->flush();

        $this->addFlash('success', 'Arkusz usunięty.');

        return $this->redirectToRoute('app_exam8_index');
    }

    // ─── Helpers ────────────────────────────────────────────

    private function buildScoringCategories(MockExam $exam): array
    {
        $content = $exam->getExamContent();
        $categories = [];

        // Reading parts
        foreach ($content['parts'] ?? [] as $i => $part) {
            $partPoints = array_sum(array_column($part['questions'] ?? [], 'points'));
            $key = 'czytanie_' . ($i + 1);
            $categories[$key] = [
                'label' => $part['name'] ?? ('Część ' . ($i + 1)),
                'max' => $partPoints,
            ];
        }

        // Essay criteria
        if (isset($content['essayCriteria'])) {
            foreach ($content['essayCriteria'] as $key => $crit) {
                $categories['wypr_' . $key] = [
                    'label' => 'Wypr.: ' . $crit['label'],
                    'max' => $crit['max'],
                ];
            }
        } elseif (isset($content['essayTopics'])) {
            // Fallback default CKE criteria
            $categories['wypr_tresc'] = ['label' => 'Wypr.: Treść', 'max' => 4];
            $categories['wypr_forma'] = ['label' => 'Wypr.: Forma', 'max' => 4];
            $categories['wypr_kompozycja'] = ['label' => 'Wypr.: Kompozycja', 'max' => 3];
            $categories['wypr_jezyk'] = ['label' => 'Wypr.: Język', 'max' => 3];
            $categories['wypr_ortografia'] = ['label' => 'Wypr.: Ortografia', 'max' => 2];
            $categories['wypr_interpunkcja'] = ['label' => 'Wypr.: Interpunkcja', 'max' => 2];
            $categories['wypr_bogactwo'] = ['label' => 'Wypr.: Bogactwo', 'max' => 2];
        }

        return $categories;
    }
}
