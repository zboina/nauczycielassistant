<?php

declare(strict_types=1);

namespace App\Form;

use App\Entity\Literature;
use Symfony\Bridge\Doctrine\Form\Type\EntityType;
use Symfony\Component\Form\AbstractType;
use Symfony\Component\Form\Extension\Core\Type\ChoiceType;
use Symfony\Component\Form\Extension\Core\Type\TextareaType;
use Symfony\Component\Form\Extension\Core\Type\TextType;
use Symfony\Component\Form\FormBuilderInterface;
use Symfony\Component\OptionsResolver\OptionsResolver;
use Symfony\Component\Validator\Constraints\NotBlank;

class LessonPlanType extends AbstractType
{
    public function buildForm(FormBuilderInterface $builder, array $options): void
    {
        $builder
            ->add('literature', EntityType::class, [
                'class' => Literature::class,
                'label' => 'Lektura',
                'choice_label' => function (Literature $lit): string {
                    return $lit->getTitle() . ' — ' . $lit->getAuthor() . ' (kl. ' . $lit->getClassLevel() . ')';
                },
                'placeholder' => 'Wybierz lekturę...',
                'constraints' => [new NotBlank(message: 'Wybierz lekturę')],
                'group_by' => function (Literature $lit): string {
                    return 'Klasa ' . $lit->getClassLevel();
                },
            ])
            ->add('classLevel', TextType::class, [
                'label' => 'Klasa',
                'attr' => ['placeholder' => 'np. 7A, 8B'],
                'constraints' => [new NotBlank(message: 'Podaj klasę')],
            ])
            ->add('lessonTopic', TextType::class, [
                'label' => 'Temat lekcji',
                'attr' => ['placeholder' => 'np. "Analiza postaci Małego Księcia"'],
                'constraints' => [new NotBlank(message: 'Podaj temat lekcji')],
            ])
            ->add('duration', ChoiceType::class, [
                'label' => 'Czas trwania',
                'choices' => [
                    '45 min (1 lekcja)' => 45,
                    '90 min (2 lekcje)' => 90,
                ],
            ])
            ->add('focus', ChoiceType::class, [
                'label' => 'Główny nacisk',
                'choices' => [
                    'Analiza i interpretacja tekstu' => 'analiza i interpretacja tekstu literackiego',
                    'Charakterystyka bohaterów' => 'charakterystyka bohaterów',
                    'Problematyka i przesłanie utworu' => 'problematyka i przesłanie utworu',
                    'Kontekst historyczny i kulturowy' => 'kontekst historyczny i kulturowy',
                    'Język i środki stylistyczne' => 'analiza języka i środków stylistycznych',
                    'Dyskusja i argumentowanie' => 'rozwijanie umiejętności dyskusji i argumentowania',
                    'Twórcze pisanie' => 'twórcze pisanie inspirowane lekturą',
                    'Powtórzenie / utrwalenie' => 'powtórzenie i utrwalenie wiadomości o lekturze',
                ],
            ])
            ->add('notes', TextareaType::class, [
                'label' => 'Dodatkowe wskazówki',
                'required' => false,
                'attr' => [
                    'placeholder' => 'np. "uwzględnij pracę w grupach", "klasa jest słaba, uprość język"',
                    'rows' => 3,
                ],
            ]);
    }

    public function configureOptions(OptionsResolver $resolver): void
    {
        $resolver->setDefaults([]);
    }
}
