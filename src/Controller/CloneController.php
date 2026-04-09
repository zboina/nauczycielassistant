<?php

declare(strict_types=1);

namespace App\Controller;

use App\Entity\GeneratedMaterial;
use App\Entity\LessonPlan;
use App\Entity\MockExam;
use App\Entity\User;
use App\Repository\UserRepository;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/clone')]
class CloneController extends AbstractController
{
    public function __construct(
        private readonly EntityManagerInterface $em,
        private readonly UserRepository $userRepo,
    ) {}

    #[Route('/material/{id}', name: 'app_clone_material', requirements: ['id' => '\d+'], methods: ['POST'])]
    public function cloneMaterial(Request $request, GeneratedMaterial $material): Response
    {
        $this->checkOwner($material->getOwner());
        $targetUser = $this->getTargetUser($request);
        if (!$targetUser) {
            $this->addFlash('error', 'Nie znaleziono użytkownika.');
            return $this->redirect($request->headers->get('referer', '/'));
        }

        $clone = new GeneratedMaterial();
        $clone->setType($material->getType());
        $clone->setTitle($material->getTitle() . ' [udostępniony od ' . $this->getUser()->getFullName() . ']');
        $clone->setClassLevel($material->getClassLevel());
        $clone->setSubjectContext($material->getSubjectContext());
        $clone->setPromptUsed($material->getPromptUsed());
        $clone->setContent($material->getContent());
        $clone->setOwner($targetUser);

        $this->em->persist($clone);
        $this->em->flush();

        $this->addFlash('success', 'Sklonowano "' . $material->getTitle() . '" dla ' . $targetUser->getFullName());
        return $this->redirect($request->headers->get('referer', '/'));
    }

    #[Route('/lesson-plan/{id}', name: 'app_clone_lesson_plan', requirements: ['id' => '\d+'], methods: ['POST'])]
    public function cloneLessonPlan(Request $request, LessonPlan $plan): Response
    {
        $this->checkOwner($plan->getOwner());
        $targetUser = $this->getTargetUser($request);
        if (!$targetUser) {
            $this->addFlash('error', 'Nie znaleziono użytkownika.');
            return $this->redirect($request->headers->get('referer', '/'));
        }

        $clone = new LessonPlan();
        $clone->setTitle($plan->getTitle() . ' [udostępniony od ' . $this->getUser()->getFullName() . ']');
        $clone->setClassLevel($plan->getClassLevel());
        $clone->setLessonTopic($plan->getLessonTopic());
        $clone->setContent($plan->getContent());
        $clone->setDurationMinutes($plan->getDurationMinutes());
        $clone->setOwner($targetUser);

        $this->em->persist($clone);
        $this->em->flush();

        $this->addFlash('success', 'Sklonowano konspekt dla ' . $targetUser->getFullName());
        return $this->redirect($request->headers->get('referer', '/'));
    }

    #[Route('/exam/{id}', name: 'app_clone_exam', requirements: ['id' => '\d+'], methods: ['POST'])]
    public function cloneExam(Request $request, MockExam $exam): Response
    {
        $this->checkOwner($exam->getOwner());
        $targetUser = $this->getTargetUser($request);
        if (!$targetUser) {
            $this->addFlash('error', 'Nie znaleziono użytkownika.');
            return $this->redirect($request->headers->get('referer', '/'));
        }

        $clone = new MockExam();
        $clone->setTitle($exam->getTitle() . ' [udostępniony od ' . $this->getUser()->getFullName() . ']');
        $clone->setClassLevel($exam->getClassLevel());
        $clone->setExamType($exam->getExamType());
        $clone->setExamContent($exam->getExamContent());
        $clone->setAnswerKey($exam->getAnswerKey());
        $clone->setOwner($targetUser);

        $this->em->persist($clone);
        $this->em->flush();

        $this->addFlash('success', 'Sklonowano arkusz dla ' . $targetUser->getFullName());
        return $this->redirect($request->headers->get('referer', '/'));
    }

    private function checkOwner(?User $owner): void
    {
        if ($owner !== $this->getUser()) {
            throw $this->createAccessDeniedException();
        }
    }

    private function getTargetUser(Request $request): ?User
    {
        $userId = $request->request->getInt('targetUserId');
        if (!$userId) return null;
        $user = $this->userRepo->find($userId);
        if (!$user || !$user->isActive()) return null;
        return $user;
    }
}
