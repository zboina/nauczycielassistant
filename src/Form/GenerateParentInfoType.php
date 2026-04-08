<?php

declare(strict_types=1);

namespace App\Form;

use Symfony\Component\Form\AbstractType;
use Symfony\Component\Form\Extension\Core\Type\ChoiceType;
use Symfony\Component\Form\Extension\Core\Type\TextareaType;
use Symfony\Component\Form\FormBuilderInterface;
use Symfony\Component\OptionsResolver\OptionsResolver;
use Symfony\Component\Validator\Constraints\NotBlank;

class GenerateParentInfoType extends AbstractType
{
    public function buildForm(FormBuilderInterface $builder, array $options): void
    {
        $builder
            ->add('infoType', ChoiceType::class, [
                'label' => 'Typ informacji',
                'choices' => [
                    'Wycieczka' => 'Wycieczka',
                    'Zmiana planu lekcji' => 'Zmiana planu lekcji',
                    'Zebranie / wywiadówka' => 'Zebranie / wywiadówka',
                    'Wydarzenie szkolne' => 'Wydarzenie szkolne',
                    'Prośba o podpisanie dokumentu' => 'Prośba o podpisanie dokumentu',
                    'Inne' => 'Inne',
                ],
            ])
            ->add('details', TextareaType::class, [
                'label' => 'Szczegóły',
                'attr' => [
                    'placeholder' => 'Co, kiedy, gdzie, ile kosztuje, co zabrać itp.',
                    'rows' => 5,
                ],
                'constraints' => [new NotBlank(message: 'Podaj szczegóły')],
            ])
            ->add('tone', ChoiceType::class, [
                'label' => 'Ton',
                'choices' => [
                    'Formalny' => 'formalny',
                    'Przyjazny' => 'przyjazny',
                ],
                'expanded' => true,
            ]);
    }

    public function configureOptions(OptionsResolver $resolver): void
    {
        $resolver->setDefaults([
            'data' => ['tone' => 'formalny'],
        ]);
    }
}
