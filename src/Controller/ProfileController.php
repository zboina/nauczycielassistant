<?php

declare(strict_types=1);

namespace App\Controller;

use Doctrine\ORM\EntityManagerInterface;
use Endroid\QrCode\Builder\Builder;
use Endroid\QrCode\Encoding\Encoding;
use Endroid\QrCode\Writer\PngWriter;
use Scheb\TwoFactorBundle\Security\TwoFactor\Provider\Totp\TotpAuthenticatorInterface;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\PasswordHasher\Hasher\UserPasswordHasherInterface;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/profile')]
class ProfileController extends AbstractController
{
    public function __construct(
        private readonly EntityManagerInterface $em,
    ) {}

    #[Route('', name: 'app_profile')]
    public function index(): Response
    {
        return $this->render('profile/index.html.twig');
    }

    #[Route('/edit', name: 'app_profile_edit', methods: ['POST'])]
    public function edit(Request $request): Response
    {
        $user = $this->getUser();
        $user->setFullName($request->request->get('fullName', $user->getFullName()));
        $user->setSchoolName($request->request->get('schoolName') ?: null);
        $user->setCity($request->request->get('city') ?: null);
        $this->em->flush();

        $this->addFlash('success', 'Profil zaktualizowany.');
        return $this->redirectToRoute('app_profile');
    }

    #[Route('/change-password', name: 'app_profile_change_password', methods: ['POST'])]
    public function changePassword(Request $request, UserPasswordHasherInterface $hasher): Response
    {
        $user = $this->getUser();
        $current = $request->request->get('currentPassword', '');
        $new = $request->request->get('newPassword', '');
        $confirm = $request->request->get('confirmPassword', '');

        if (!$hasher->isPasswordValid($user, $current)) {
            $this->addFlash('error', 'Obecne hasło jest niepoprawne.');
            return $this->redirectToRoute('app_profile');
        }

        if (strlen($new) < 6) {
            $this->addFlash('error', 'Nowe hasło musi mieć min. 6 znaków.');
            return $this->redirectToRoute('app_profile');
        }

        if ($new !== $confirm) {
            $this->addFlash('error', 'Nowe hasła nie są identyczne.');
            return $this->redirectToRoute('app_profile');
        }

        $user->setPassword($hasher->hashPassword($user, $new));
        $this->em->flush();

        $this->addFlash('success', 'Hasło zmienione.');
        return $this->redirectToRoute('app_profile');
    }

    #[Route('/2fa/enable', name: 'app_profile_2fa_enable')]
    public function enable2fa(TotpAuthenticatorInterface $totp): Response
    {
        $user = $this->getUser();

        if (!$user->getTotpSecret()) {
            $user->setTotpSecret($totp->generateSecret());
            $this->em->flush();
        }

        // Generate QR code
        $otpauthUrl = $totp->getQRContent($user);
        $qrResult = Builder::create()
            ->writer(new PngWriter())
            ->data($otpauthUrl)
            ->encoding(new Encoding('UTF-8'))
            ->size(250)
            ->build();

        return $this->render('profile/2fa_enable.html.twig', [
            'qrCode' => base64_encode($qrResult->getString()),
            'secret' => $user->getTotpSecret(),
        ]);
    }

    #[Route('/2fa/confirm', name: 'app_profile_2fa_confirm', methods: ['POST'])]
    public function confirm2fa(Request $request, TotpAuthenticatorInterface $totp): Response
    {
        $user = $this->getUser();
        $code = $request->request->get('code', '');

        if ($totp->checkCode($user, $code)) {
            $this->addFlash('success', '2FA włączone! Od następnego logowania będziesz potrzebować kodu z aplikacji.');
            return $this->redirectToRoute('app_profile');
        }

        $this->addFlash('error', 'Niepoprawny kod. Spróbuj ponownie.');
        return $this->redirectToRoute('app_profile_2fa_enable');
    }

    #[Route('/2fa/disable', name: 'app_profile_2fa_disable', methods: ['POST'])]
    public function disable2fa(): Response
    {
        $user = $this->getUser();
        $user->setTotpSecret(null);
        $this->em->flush();

        $this->addFlash('success', '2FA wyłączone.');
        return $this->redirectToRoute('app_profile');
    }
}
