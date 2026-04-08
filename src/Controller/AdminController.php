<?php

declare(strict_types=1);

namespace App\Controller;

use App\Entity\User;
use App\Repository\UserRepository;
use Doctrine\ORM\EntityManagerInterface;
use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\PasswordHasher\Hasher\UserPasswordHasherInterface;
use Symfony\Component\Routing\Attribute\Route;

#[Route('/admin')]
class AdminController extends AbstractController
{
    public function __construct(
        private readonly EntityManagerInterface $em,
    ) {}

    #[Route('', name: 'app_admin_index')]
    public function index(UserRepository $repo): Response
    {
        return $this->render('admin/index.html.twig', [
            'users' => $repo->findBy([], ['createdAt' => 'DESC']),
        ]);
    }

    #[Route('/user/create', name: 'app_admin_user_create')]
    public function createUser(Request $request, UserPasswordHasherInterface $hasher): Response
    {
        if ($request->isMethod('POST')) {
            $email = trim($request->request->get('email', ''));
            $existing = $this->em->getRepository(User::class)->findOneBy(['email' => $email]);
            if ($existing) {
                $this->addFlash('error', 'Użytkownik z tym emailem już istnieje.');
                return $this->redirectToRoute('app_admin_user_create');
            }

            $user = new User();
            $user->setEmail($email);
            $user->setFullName($request->request->get('fullName', ''));
            $user->setSchoolName($request->request->get('schoolName') ?: null);
            $user->setCity($request->request->get('city') ?: null);
            $user->setPassword($hasher->hashPassword($user, $request->request->get('password', '')));
            $user->setIsActive((bool) $request->request->get('isActive', true));

            if ($request->request->get('isAdmin')) {
                $user->setRoles(['ROLE_ADMIN']);
            }

            $this->em->persist($user);
            $this->em->flush();

            $this->addFlash('success', 'Użytkownik ' . $user->getFullName() . ' utworzony.');
            return $this->redirectToRoute('app_admin_index');
        }

        return $this->render('admin/create.html.twig');
    }

    #[Route('/user/{id}/edit', name: 'app_admin_user_edit', requirements: ['id' => '\d+'])]
    public function editUser(Request $request, User $user, UserPasswordHasherInterface $hasher): Response
    {
        if ($request->isMethod('POST')) {
            $user->setFullName($request->request->get('fullName', $user->getFullName()));
            $user->setEmail($request->request->get('email', $user->getEmail()));
            $user->setSchoolName($request->request->get('schoolName') ?: null);
            $user->setCity($request->request->get('city') ?: null);
            $user->setIsActive((bool) $request->request->get('isActive'));

            if ($user !== $this->getUser()) {
                if ($request->request->get('isAdmin')) {
                    if (!in_array('ROLE_ADMIN', $user->getRoles())) {
                        $user->setRoles(array_merge($user->getRoles(), ['ROLE_ADMIN']));
                    }
                } else {
                    $user->setRoles(array_values(array_diff($user->getRoles(), ['ROLE_ADMIN'])));
                }
            }

            $newPassword = $request->request->get('newPassword', '');
            if ($newPassword !== '') {
                $user->setPassword($hasher->hashPassword($user, $newPassword));
            }

            if ($request->request->get('reset2fa')) {
                $user->setTotpSecret(null);
            }

            $this->em->flush();

            $this->addFlash('success', 'Użytkownik ' . $user->getFullName() . ' zaktualizowany.');
            return $this->redirectToRoute('app_admin_index');
        }

        return $this->render('admin/edit.html.twig', [
            'user' => $user,
        ]);
    }

    #[Route('/user/{id}/toggle', name: 'app_admin_user_toggle', requirements: ['id' => '\d+'], methods: ['POST'])]
    public function toggleActive(User $user): Response
    {
        if ($user === $this->getUser()) {
            $this->addFlash('error', 'Nie możesz dezaktywować siebie.');
            return $this->redirectToRoute('app_admin_index');
        }
        $user->setIsActive(!$user->isActive());
        $this->em->flush();
        $this->addFlash('success', $user->isActive() ? 'Użytkownik aktywowany.' : 'Użytkownik dezaktywowany.');
        return $this->redirectToRoute('app_admin_index');
    }

    #[Route('/user/{id}/role', name: 'app_admin_user_role', requirements: ['id' => '\d+'], methods: ['POST'])]
    public function toggleAdmin(Request $request, User $user): Response
    {
        if ($user === $this->getUser()) {
            $this->addFlash('error', 'Nie możesz zmienić własnej roli.');
            return $this->redirectToRoute('app_admin_index');
        }
        $roles = $user->getRoles();
        if (in_array('ROLE_ADMIN', $roles)) {
            $user->setRoles(array_values(array_diff($user->getRoles(), ['ROLE_ADMIN'])));
        } else {
            $user->setRoles(array_merge($user->getRoles(), ['ROLE_ADMIN']));
        }
        $this->em->flush();
        $this->addFlash('success', 'Rola zmieniona.');
        return $this->redirectToRoute('app_admin_index');
    }

    #[Route('/user/{id}/reset-password', name: 'app_admin_user_reset_password', requirements: ['id' => '\d+'], methods: ['POST'])]
    public function resetPassword(User $user, UserPasswordHasherInterface $hasher): Response
    {
        $tempPassword = bin2hex(random_bytes(4));
        $user->setPassword($hasher->hashPassword($user, $tempPassword));
        $user->setTotpSecret(null); // reset 2FA too
        $this->em->flush();

        $this->addFlash('success', 'Hasło zresetowane dla ' . $user->getFullName() . '. Tymczasowe hasło: ' . $tempPassword);
        return $this->redirectToRoute('app_admin_index');
    }

    #[Route('/user/{id}/delete', name: 'app_admin_user_delete', requirements: ['id' => '\d+'], methods: ['POST'])]
    public function deleteUser(User $user): Response
    {
        if ($user === $this->getUser()) {
            $this->addFlash('error', 'Nie możesz usunąć siebie.');
            return $this->redirectToRoute('app_admin_index');
        }
        $name = $user->getFullName();
        $this->em->remove($user);
        $this->em->flush();
        $this->addFlash('success', 'Użytkownik ' . $name . ' usunięty.');
        return $this->redirectToRoute('app_admin_index');
    }
}
