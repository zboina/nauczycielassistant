<?php

declare(strict_types=1);

namespace App\Controller;

use App\Repository\AppSettingRepository;
use App\Service\AI\ModelResolver;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/settings')]
class SettingsController extends AbstractController
{
    #[Route('', name: 'app_settings')]
    public function index(ModelResolver $resolver): Response
    {
        $this->denyAccessUnlessGranted('ROLE_ADMIN');

        return $this->render('settings/index.html.twig', [
            'moduleSettings' => $resolver->getModelSettings(),
            'availableModels' => ModelResolver::AVAILABLE_MODELS,
            'modules' => ModelResolver::MODULES,
        ]);
    }

    #[Route('/save', name: 'app_settings_save', methods: ['POST'])]
    public function save(Request $request, AppSettingRepository $repo): Response
    {
        $this->denyAccessUnlessGranted('ROLE_ADMIN');

        foreach ($request->request->all('model') as $module => $modelId) {
            $key = 'model_' . $module;
            if ($modelId === '') {
                // Empty = use default
                $existing = $repo->find($key);
                if ($existing) {
                    $repo->getEntityManager()->remove($existing);
                }
            } else {
                $repo->set($key, $modelId);
            }
        }
        $repo->getEntityManager()->flush();

        $this->addFlash('success', 'Ustawienia modeli zapisane.');
        return $this->redirectToRoute('app_settings');
    }
}
