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

class GenerateWorksheetType extends AbstractType
{
    public function buildForm(FormBuilderInterface $builder, array $options): void
    {
        $builder
            ->add('classLevel', TextType::class, [
                'label' => 'Klasa',
                'attr' => ['placeholder' => 'np. 6A, 7B, 8C'],
                'constraints' => [new NotBlank(message: 'Podaj klasę')],
            ])
            ->add('topic', TextType::class, [
                'label' => 'Temat lekcji',
                'attr' => ['placeholder' => 'np. "Odmiana czasowników" lub "Analiza wiersza"'],
                'constraints' => [new NotBlank(message: 'Podaj temat')],
            ])
            ->add('exerciseTypes', ChoiceType::class, [
                'label' => 'Typy ćwiczeń',
                'choices' => [
                    'Ortografia' => 'ortografia',
                    'Gramatyka' => 'gramatyka',
                    'Analiza tekstu' => 'analiza tekstu',
                    'Słownictwo' => 'słownictwo',
                    'Interpunkcja' => 'interpunkcja',
                ],
                'expanded' => true,
                'multiple' => true,
                'constraints' => [new NotBlank(message: 'Wybierz przynajmniej jeden typ ćwiczeń')],
            ])
            ->add('taskCount', ChoiceType::class, [
                'label' => 'Liczba zadań',
                'choices' => [
                    '3' => 3,
                    '5' => 5,
                    '8' => 8,
                ],
            ])
            ->add('duration', ChoiceType::class, [
                'label' => 'Czas pracy',
                'choices' => [
                    '15 min' => '15 minut',
                    '30 min' => '30 minut',
                    '45 min' => '45 minut',
                ],
            ])
            ->add('baseText', TextareaType::class, [
                'label' => 'Tekst bazowy (opcjonalnie)',
                'required' => false,
                'attr' => [
                    'placeholder' => 'Wklej fragment tekstu jako podstawę ćwiczeń...',
                    'rows' => 5,
                ],
            ]);
    }

    public function configureOptions(OptionsResolver $resolver): void
    {
        $resolver->setDefaults([]);
    }
}
