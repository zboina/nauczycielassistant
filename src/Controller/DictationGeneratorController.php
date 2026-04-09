<?php

declare(strict_types=1);

namespace App\Controller;

use App\Entity\GeneratedMaterial;
use App\Repository\GeneratedMaterialRepository;
use App\Service\AI\OpenRouterClient;
use App\Service\AI\PromptBuilder\DictationPromptBuilder;
use App\Service\PdfGenerator;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/dictation-gen')]
class DictationGeneratorController extends AbstractController
{
    public function __construct(
        private readonly OpenRouterClient $ai,
        private readonly EntityManagerInterface $em,
        private readonly PdfGenerator $pdf,
    ) {}

    #[Route('', name: 'app_dictation_gen_index')]
    public function index(Request $request, GeneratedMaterialRepository $repo): Response
    {
        return $this->render('dictation_gen/index.html.twig', [
            'materials' => $repo->findByTypeAndOwner($this->getUser(), 'dictation', $request->query->get('class')),
            'currentClass' => $request->query->get('class'),
        ]);
    }

    #[Route('/generate', name: 'app_dictation_gen_generate')]
    public function generate(Request $request): Response
    {
        if ($request->isMethod('POST')) {
            $type = $request->request->get('type', 'classic');
            $classLevel = $request->request->get('classLevel', '6');
            $difficulty = $request->request->get('difficulty', 'średni');
            $wordCount = $request->request->getInt('wordCount', 100);
            $spellingFocus = $request->request->get('spellingFocus', 'all');

            $builder = new DictationPromptBuilder();
            $userPrompt = $builder->buildUserPrompt($type, $classLevel, $difficulty, $wordCount, $spellingFocus);

            try {
                $result = $this->ai->generate(
                    userPrompt: $userPrompt,
                    systemPrompt: DictationPromptBuilder::SYSTEM_PROMPT,
                    module: 'dictation_generator',
                    maxTokens: 4000,
                    owner: $this->getUser(),
                );

                $parsed = DictationPromptBuilder::parseResponse($result);

                if ($parsed) {
                    $request->getSession()->set('last_dictation', [
                        'parsed' => $parsed,
                        'classLevel' => $classLevel,
                        'type' => $type,
                        'difficulty' => $difficulty,
                        'spellingFocus' => $spellingFocus,
                    ]);
                } else {
                    $this->addFlash('warning', 'AI nie zwróciło poprawnego formatu. Spróbuj ponownie.');
                }
            } catch (\RuntimeException $e) {
                $this->addFlash('error', $e->getMessage());
            }

            return $this->redirectToRoute('app_dictation_gen_generate');
        }

        $sessionData = $request->getSession()->get('last_dictation');

        return $this->render('dictation_gen/generate.html.twig', [
            'data' => $sessionData['parsed'] ?? null,
            'sessionData' => $sessionData,
        ]);
    }

    #[Route('/save', name: 'app_dictation_gen_save', methods: ['POST'])]
    public function save(Request $request): Response
    {
        $sessionData = $request->getSession()->get('last_dictation');
        if (!$sessionData) {
            $this->addFlash('error', 'Brak danych do zapisania.');
            return $this->redirectToRoute('app_dictation_gen_generate');
        }

        $parsed = $sessionData['parsed'];
        $typeLabel = ($sessionData['type'] ?? 'classic') === 'quiz' ? 'testowe' : 'klasyczne';
        $diffLabel = $sessionData['difficulty'] ?? 'średni';
        $focusLabels = ['all' => 'wszystkie', 'ou' => 'ó/u', 'rzz' => 'rz/ż', 'chh' => 'ch/h', 'nie' => '"nie"', 'wielka' => 'wielka litera'];
        $focusLabel = $focusLabels[$sessionData['spellingFocus'] ?? 'all'] ?? 'wszystkie';

        $material = new GeneratedMaterial();
        $material->setType('dictation');
        $material->setTitle($parsed['title'] ?? 'Dyktando');
        $material->setClassLevel($sessionData['classLevel']);
        $material->setSubjectContext($typeLabel . ' | ' . $diffLabel . ' | ' . $focusLabel);
        $material->setContent(json_encode($parsed, JSON_UNESCAPED_UNICODE));
        $material->setOwner($this->getUser());

        $this->em->persist($material);
        $this->em->flush();

        $this->addFlash('success', 'Dyktando zapisane.');
        return $this->redirectToRoute('app_dictation_gen_index');
    }

    #[Route('/pdf', name: 'app_dictation_gen_pdf')]
    public function pdf(Request $request): Response
    {
        $sessionData = $request->getSession()->get('last_dictation');
        if (!$sessionData || !($sessionData['parsed'] ?? null)) {
            $this->addFlash('error', 'Brak danych.');
            return $this->redirectToRoute('app_dictation_gen_generate');
        }

        return $this->pdf->generateResponse(
            'pdf/dictation.html.twig',
            ['data' => $sessionData['parsed'], 'showAnswers' => $request->query->getBoolean('answers')],
            'dyktando_' . date('Y-m-d') . '.pdf',
        );
    }
}
