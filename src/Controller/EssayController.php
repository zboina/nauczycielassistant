<?php

declare(strict_types=1);

namespace App\Controller;

use App\Entity\Essay;
use App\Entity\EssaySubmission;
use App\Repository\EssayRepository;
use App\Service\AI\OpenRouterClient;
use App\Service\AI\PromptBuilder\AiDetectionPromptBuilder;
use App\Service\AI\PromptBuilder\EssayReviewPromptBuilder;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/essays')]
class EssayController extends AbstractController
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly OpenRouterClient $ai,
    ) {}

    // ─── Teacher: list all essays ───────────────────────────

    #[Route('', name: 'app_essay_index')]
    public function index(Request $request, EssayRepository $repo): Response
    {
        $classLevel = $request->query->get('class');
        $essays = $repo->findByOwner($this->getUser(), $classLevel);

        return $this->render('essay/index.html.twig', [
            'essays' => $essays,
            'currentClass' => $classLevel,
        ]);
    }

    // ─── Teacher: create new essay assignment ───────────────

    #[Route('/create', name: 'app_essay_create')]
    public function create(Request $request): Response
    {
        if ($request->isMethod('POST')) {
            $essay = new Essay();
            $essay->setTopic($request->request->get('topic', ''));
            $essay->setWritingForm($request->request->get('writingForm', 'rozprawka'));
            $essay->setClassLevel($request->request->get('classLevel', '7'));
            $essay->setInstructions($request->request->get('instructions') ?: null);
            $essay->setCriteriaType($request->request->get('criteriaType', 'cke'));
            $essay->setMinWords($request->request->getInt('minWords') ?: null);
            $essay->setOwner($this->getUser());

            $deadlineStr = $request->request->get('deadline');
            if ($deadlineStr) {
                $essay->setDeadline(new \DateTimeImmutable($deadlineStr));
            }

            $this->em->persist($essay);
            $this->em->flush();

            $this->addFlash('success', 'Zadanie utworzone! Kod dostępu: ' . $essay->getAccessCode());

            return $this->redirectToRoute('app_essay_show', ['id' => $essay->getId()]);
        }

        return $this->render('essay/create.html.twig', [
            'writingForms' => Essay::getWritingFormLabels(),
        ]);
    }

    // ─── Teacher: view essay + submissions ──────────────────

    #[Route('/{id}', name: 'app_essay_show', requirements: ['id' => '\d+'])]
    public function show(Essay $essay): Response
    {
        if ($essay->getOwner() !== $this->getUser()) {
            throw $this->createAccessDeniedException();
        }

        return $this->render('essay/show.html.twig', [
            'essay' => $essay,
        ]);
    }

    // ─── Teacher: toggle active ─────────────────────────────

    #[Route('/{id}/toggle', name: 'app_essay_toggle', requirements: ['id' => '\d+'], methods: ['POST'])]
    public function toggle(Essay $essay): Response
    {
        if ($essay->getOwner() !== $this->getUser()) {
            throw $this->createAccessDeniedException();
        }

        $essay->setIsActive(!$essay->isActive());
        $this->em->flush();

        return $this->redirectToRoute('app_essay_show', ['id' => $essay->getId()]);
    }

    // ─── Teacher: delete essay ──────────────────────────────

    #[Route('/{id}/delete', name: 'app_essay_delete', requirements: ['id' => '\d+'], methods: ['POST'])]
    public function delete(Essay $essay): Response
    {
        if ($essay->getOwner() !== $this->getUser()) {
            throw $this->createAccessDeniedException();
        }

        $this->em->remove($essay);
        $this->em->flush();

        $this->addFlash('success', 'Zadanie usunięte.');

        return $this->redirectToRoute('app_essay_index');
    }

    // ─── Teacher: AI review submission ──────────────────────

    #[Route('/submission/{id}/ai-review', name: 'app_essay_ai_review', requirements: ['id' => '\d+'], methods: ['POST'])]
    public function aiReview(EssaySubmission $submission): Response
    {
        $essay = $submission->getEssay();
        if ($essay->getOwner() !== $this->getUser()) {
            throw $this->createAccessDeniedException();
        }

        $builder = new EssayReviewPromptBuilder();
        $userPrompt = $builder->buildUserPrompt(
            studentText: $submission->getContent(),
            writingForm: $essay->getWritingFormLabel(),
            classLevel: $essay->getClassLevel(),
            topic: $essay->getTopic(),
            instructions: $essay->getInstructions(),
            minWords: $essay->getMinWords(),
        );

        try {
            $result = $this->ai->generate(
                userPrompt: $userPrompt,
                systemPrompt: EssayReviewPromptBuilder::SYSTEM_PROMPT,
                module: 'essay_review',
                maxTokens: 4000,
                owner: $this->getUser(),
            );

            $parsed = EssayReviewPromptBuilder::parseResponse($result);

            if ($parsed) {
                $submission->setAiAnalysis($parsed);
                $submission->setStatus('ai_reviewed');
                $this->em->flush();
                $this->addFlash('success', 'Analiza AI zakończona!');
            } else {
                $this->addFlash('warning', 'AI nie zwróciło poprawnego formatu. Spróbuj ponownie.');
            }
        } catch (\RuntimeException $e) {
            $this->addFlash('error', $e->getMessage());
        }

        return $this->redirectToRoute('app_essay_review', ['id' => $submission->getId()]);
    }

    // ─── Teacher: AI detection ──────────────────────────────

    #[Route('/submission/{id}/ai-detect', name: 'app_essay_ai_detect', requirements: ['id' => '\d+'], methods: ['POST'])]
    public function aiDetect(EssaySubmission $submission): Response
    {
        $essay = $submission->getEssay();
        if ($essay->getOwner() !== $this->getUser()) {
            throw $this->createAccessDeniedException();
        }

        $builder = new AiDetectionPromptBuilder();
        $userPrompt = $builder->buildUserPrompt(
            studentText: $submission->getContent(),
            writingForm: $essay->getWritingFormLabel(),
            classLevel: $essay->getClassLevel(),
            topic: $essay->getTopic(),
        );

        try {
            $result = $this->ai->generate(
                userPrompt: $userPrompt,
                systemPrompt: AiDetectionPromptBuilder::SYSTEM_PROMPT,
                module: 'ai_detection',
                maxTokens: 3000,
                owner: $this->getUser(),
            );

            $parsed = AiDetectionPromptBuilder::parseResponse($result);

            if ($parsed) {
                $submission->setAiDetection($parsed);
                $this->em->flush();
                $this->addFlash('success', 'Analiza autentyczności zakończona.');
            } else {
                $this->addFlash('warning', 'AI nie zwróciło poprawnego formatu. Spróbuj ponownie.');
            }
        } catch (\RuntimeException $e) {
            $this->addFlash('error', $e->getMessage());
        }

        return $this->redirectToRoute('app_essay_review', ['id' => $submission->getId()]);
    }

    // ─── Teacher: review submission (view + save scores) ────

    #[Route('/submission/{id}/review', name: 'app_essay_review', requirements: ['id' => '\d+'])]
    public function review(Request $request, EssaySubmission $submission): Response
    {
        $essay = $submission->getEssay();
        if ($essay->getOwner() !== $this->getUser()) {
            throw $this->createAccessDeniedException();
        }

        if ($request->isMethod('POST')) {
            $scores = [];
            foreach ($request->request->all('score') as $category => $value) {
                $scores[$category] = (int) $value;
            }
            $submission->setTeacherScores($scores);
            $submission->setTeacherComment($request->request->get('teacherComment') ?: null);
            $submission->setStatus('approved');
            $this->em->flush();

            $this->addFlash('success', 'Ocena zatwierdzona!');

            return $this->redirectToRoute('app_essay_show', ['id' => $essay->getId()]);
        }

        return $this->render('essay/review.html.twig', [
            'essay' => $essay,
            'submission' => $submission,
        ]);
    }

    // ─── Public: student submit form ────────────────────────

    #[Route('/submit/{code}', name: 'app_essay_submit')]
    public function submit(string $code, Request $request, EssayRepository $repo): Response
    {
        $essay = $repo->findByAccessCode($code);

        if (!$essay) {
            return $this->render('essay/submit_error.html.twig', [
                'message' => 'Nie znaleziono zadania o podanym kodzie.',
            ]);
        }

        if (!$essay->isAccepting()) {
            return $this->render('essay/submit_error.html.twig', [
                'message' => $essay->isExpired()
                    ? 'Termin oddania pracy minął (' . $essay->getDeadline()->format('d.m.Y H:i') . ').'
                    : 'Nauczyciel zamknął przyjmowanie prac.',
            ]);
        }

        $submitted = false;

        if ($request->isMethod('POST')) {
            $studentName = trim($request->request->get('studentName', ''));
            $content = trim($request->request->get('content', ''));

            if ($studentName === '' || $content === '') {
                $this->addFlash('error', 'Wpisz imię i nazwisko oraz treść pracy.');
            } else {
                $submission = new EssaySubmission();
                $submission->setEssay($essay);
                $submission->setStudentName($studentName);
                $submission->setContent($content);

                $this->em->persist($submission);
                $this->em->flush();

                $submitted = true;
            }
        }

        return $this->render('essay/submit.html.twig', [
            'essay' => $essay,
            'submitted' => $submitted,
        ]);
    }

    // ─── Public: enter code page ────────────────────────────

    #[Route('/join', name: 'app_essay_join')]
    public function join(Request $request): Response
    {
        $code = strtoupper(trim($request->query->get('code', '')));

        if ($code !== '') {
            return $this->redirectToRoute('app_essay_submit', ['code' => $code]);
        }

        return $this->render('essay/join.html.twig');
    }
}
