<?php

declare(strict_types=1);

namespace App\Form;

use Symfony\Component\Form\AbstractType;
use Symfony\Component\Form\Extension\Core\Type\ChoiceType;
use Symfony\Component\Form\Extension\Core\Type\TextareaType;
use Symfony\Component\Form\Extension\Core\Type\TextType;
use Symfony\Component\Form\FormBuilderInterface;
use Symfony\Component\OptionsResolver\OptionsResolver;
use Symfony\Component\Validator\Constraints\NotBlank;

class GenerateTestType extends AbstractType
{
    public function buildForm(FormBuilderInterface $builder, array $options): void
    {
        $builder
            ->add('classLevel', TextType::class, [
                'label' => 'Klasa',
                'attr' => ['placeholder' => 'np. 6A, 7B, 8C'],
                'constraints' => [new NotBlank(message: 'Podaj klasę')],
            ])
            ->add('subject', TextType::class, [
                'label' => 'Lektura / Temat',
                'attr' => ['placeholder' => 'np. "Mały Książę" lub "Części mowy"'],
                'constraints' => [new NotBlank(message: 'Podaj temat sprawdzianu')],
            ])
            ->add('questionTypes', ChoiceType::class, [
                'label' => 'Typy pytań',
                'choices' => [
                    'Zamknięte (ABCD)' => 'zamknięte (ABCD)',
                    'Otwarte krótkie' => 'otwarte krótkie',
                    'Prawda / Fałsz' => 'prawda/fałsz',
                ],
                'expanded' => true,
                'multiple' => true,
                'constraints' => [new NotBlank(message: 'Wybierz przynajmniej jeden typ pytań')],
            ])
            ->add('questionCount', ChoiceType::class, [
                'label' => 'Liczba pytań',
                'choices' => [
                    '5' => 5,
                    '10' => 10,
                    '15' => 15,
                    '20' => 20,
                ],
            ])
            ->add('difficulty', ChoiceType::class, [
                'label' => 'Poziom trudności',
                'choices' => [
                    'Podstawowy' => 'podstawowy',
                    'Rozszerzony' => 'rozszerzony',
                    'Mieszany' => 'mieszany',
                ],
            ])
            ->add('notes', TextareaType::class, [
                'label' => 'Uwagi dodatkowe',
                'required' => false,
                'attr' => [
                    'placeholder' => 'np. "skup się na rozdziale 3" lub "uwzględnij cytaty"',
                    'rows' => 3,
                ],
            ]);
    }

    public function configureOptions(OptionsResolver $resolver): void
    {
        $resolver->setDefaults([]);
    }
}
