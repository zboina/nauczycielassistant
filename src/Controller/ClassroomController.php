<?php

declare(strict_types=1);

namespace App\Controller;

use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/classroom')]
class ClassroomController extends AbstractController
{
    #[Route('/dictation', name: 'app_classroom_dictation')]
    public function dictation(): Response
    {
        return $this->render('classroom/dictation.html.twig');
    }

    #[Route('/timer', name: 'app_classroom_timer')]
    public function timer(): Response
    {
        return $this->render('classroom/timer.html.twig');
    }

    #[Route('/random', name: 'app_classroom_random')]
    public function random(): Response
    {
        return $this->render('classroom/random.html.twig');
    }
}
