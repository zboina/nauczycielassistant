<?php

declare(strict_types=1);

namespace App\Form;

use App\Entity\User;
use Symfony\Component\Form\AbstractType;
use Symfony\Component\Form\Extension\Core\Type\EmailType;
use Symfony\Component\Form\Extension\Core\Type\PasswordType;
use Symfony\Component\Form\Extension\Core\Type\RepeatedType;
use Symfony\Component\Form\Extension\Core\Type\TextType;
use Symfony\Component\Form\FormBuilderInterface;
use Symfony\Component\OptionsResolver\OptionsResolver;
use Symfony\Component\Validator\Constraints\Length;
use Symfony\Component\Validator\Constraints\NotBlank;

class RegistrationType extends AbstractType
{
    public function buildForm(FormBuilderInterface $builder, array $options): void
    {
        $builder
            ->add('fullName', TextType::class, [
                'label' => 'Imię i nazwisko',
                'attr' => ['placeholder' => 'Jan Kowalski'],
            ])
            ->add('email', EmailType::class, [
                'label' => 'Email',
                'attr' => ['placeholder' => 'nauczyciel@szkola.pl'],
            ])
            ->add('plainPassword', RepeatedType::class, [
                'type' => PasswordType::class,
                'mapped' => false,
                'first_options' => ['label' => 'Hasło'],
                'second_options' => ['label' => 'Powtórz hasło'],
                'constraints' => [
                    new NotBlank(message: 'Podaj hasło'),
                    new Length(min: 6, minMessage: 'Hasło musi mieć co najmniej {{ limit }} znaków'),
                ],
            ])
            ->add('schoolName', TextType::class, [
                'label' => 'Nazwa szkoły',
                'required' => false,
                'attr' => ['placeholder' => 'Szkoła Podstawowa nr X'],
            ])
            ->add('city', TextType::class, [
                'label' => 'Miejscowość',
                'required' => false,
                'attr' => ['placeholder' => 'Warszawa'],
            ]);
    }

    public function configureOptions(OptionsResolver $resolver): void
    {
        $resolver->setDefaults([
            'data_class' => User::class,
        ]);
    }
}
