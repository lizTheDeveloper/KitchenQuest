// GENERATED copies of shipped content for src/ tests, which can't read files (no Node types in src/).
// packages/core/test/quests-content.test.ts pins every value here to the shipped file, so a content edit fails it
// until the copy here is updated to match.
import type { TechniqueNode } from '../toolkit/techniques';
import type { Quest } from './types';

export const SHIPPED_QUESTS: Quest[] = [
  {
    "id": "leela-tempering",
    "cook": "leela",
    "title": "The Tempering Order",
    "unlock": {
      "requires": [],
      "trust": 0
    },
    "steps": [
      {
        "type": "talk",
        "lines": [
          "Today you learn parippu. The dal is easy. The tempering is where people go wrong, and it is also where the flavour lives.",
          "But first, help me with the tempering. My hands know the order. Let us see if yours can learn it.",
          "We need shallots. I have three. That is enough for me, and not enough for me and you, because you will slice one badly."
        ]
      },
      {
        "type": "errand",
        "stall": "wen",
        "item": "shallot",
        "lines": [
          "Go to Old Wen's stall and bring back shallots. The small ones, firm, with dry papery skins. If they are soft at the neck or sprouting green, leave them for someone with less patience.",
          "If Wen has only big shallots, that is fine. If Wen has no shallots, a small red onion will do. Do not tell my aunt.",
          "Ah. Good ones. Heavy, dry, tight. Wen likes you. Wen does not like everyone. Wen did not like my cousin."
        ]
      },
      {
        "type": "drill",
        "skill": "knife",
        "prompt": "Slice the shallots thin and even: top and tail, peel, halve from root to tip, then slice across into half-moons about 2 mm thick, keeping your fingers curled into a claw.",
        "lines": [
          "Thin, and all the same. Not because I am fussy. Because they must turn golden together. If one is thick and one is thin, the thin one burns while the thick one is still thinking.",
          "Fingertips tucked under, knuckles forward. The knife rests on your knuckles. It cannot cut what is not in front of it.",
          "Slower is fine. Nobody is timing you except the cat, and she does not care.",
          "Good. Those will brown like a family: together, and with only a little arguing."
        ]
      },
      {
        "type": "riddle",
        "prompt": "The coconut oil is hot in the small pan. Which goes in FIRST?",
        "options": [
          {
            "text": "Mustard seeds, and wait for them to pop",
            "correct": true,
            "reaction": "Yes. Mustard seeds first, until they crackle like a small applause. Then shallots and chillies, then curry leaves last — they need only a moment."
          },
          {
            "text": "Curry leaves",
            "correct": false,
            "reaction": "Ah — then they are crisp and black before the seeds have even woken up. Curry leaves need seconds, not minutes. They go last. Try again."
          },
          {
            "text": "The shallots",
            "correct": false,
            "reaction": "The shallots would cool the oil, and the mustard seeds would never pop — they would sit there bitter and sulking. Seeds first, child."
          },
          {
            "text": "A splash of water, for luck",
            "correct": false,
            "reaction": "Water in hot oil? Luck is exactly what you would need. Your pan just flinched, and it is not even on the stove."
          }
        ],
        "explain": "Mustard seeds need the hottest oil to pop and release their flavour; shallots go in next to turn golden, and curry leaves need only a few seconds, so they go last or they burn."
      },
      {
        "type": "recognize",
        "technique": "patience",
        "lines": [],
        "otherwise": []
      },
      {
        "type": "cook",
        "recipe": "india/kerala/parippu"
      }
    ],
    "rewards": {
      "xp": 40,
      "trust": 1,
      "skills": {
        "tempering": 10,
        "legumes": 10,
        "knife": 5
      }
    }
  },
  {
    "id": "marisol-salt-question",
    "cook": "marisol",
    "title": "The Salt Question",
    "unlock": {
      "requires": [
        "leela-tempering"
      ],
      "trust": 0
    },
    "steps": [
      {
        "type": "talk",
        "lines": [
          "Before we cook, we sort. Spread the beans on a tray and look. Little stones, broken beans, the shrivelled ones — out. Beans come from fields, and fields have opinions.",
          "First, a question my neighbour's son got wrong for three years. Let's see about you."
        ]
      },
      {
        "type": "riddle",
        "prompt": "When do you add the salt to a pot of beans?",
        "options": [
          {
            "text": "At the end, once the beans are completely soft",
            "correct": true,
            "reaction": "Exactly. Some say early salt toughens the skins — my abuela did, the scientists argue. But this I know for sure: the broth cooks down for hours. Salt at the start, and you've salted twice."
          },
          {
            "text": "At the very start, all of it",
            "correct": false,
            "reaction": "And then two hours later the broth has cooked down and it tastes like the sea. You can always add salt. You cannot un-add it."
          },
          {
            "text": "Never — beans are naturally salty",
            "correct": false,
            "reaction": "Beans are many things, corazón. Salty is not one of them. Try again."
          },
          {
            "text": "Whenever the beans look like they want it",
            "correct": false,
            "reaction": "Beans don't ask. They wait. Like a good guest. Think about the broth — what happens to it over two hours?"
          }
        ],
        "explain": "The broth reduces over a long simmer, so salt added at the start concentrates; salting once the beans are soft lets you season the finished broth exactly."
      },
      {
        "type": "errand",
        "stall": "okafor-sato",
        "item": "black_bean",
        "lines": [
          "I want you to see how to buy beans when you're far from here. Go to Okafor-Sato and bring me a bag of dried black beans.",
          "Look for beans that are glossy and the same size, with few broken ones. Buy from a shop that sells a lot of them; old beans can take forever to soften, and some never do.",
          "Good. These are young — well, young for a dried bean. Okafor-Sato chose well, or you did. Probably both."
        ]
      },
      {
        "type": "drill",
        "skill": "heat-control",
        "prompt": "Bring the pot to a boil, then turn it down to the gentlest simmer: small bubbles lazily breaking the surface now and then, not a rolling boil. Keep it partly covered.",
        "lines": [
          "Look at the pot. If it's jumping, it's too hot; the beans will knock into each other and split, and the broth will cloud and run away.",
          "A few slow bubbles. Like the pot is thinking. That's the speed of good beans.",
          "When the water dips below the beans, add hot water from the kettle. Never cold. Cold stops everything and the beans take offence.",
          "Now we wait. In this house, waiting is a skill. You'll get points for it from the Bureau. You'll get beans from me, which are better."
        ]
      },
      {
        "type": "recognize",
        "technique": "tempering",
        "lines": [],
        "otherwise": []
      },
      {
        "type": "cook",
        "recipe": "mexico/oaxaca/frijoles-de-olla"
      }
    ],
    "rewards": {
      "xp": 45,
      "trust": 1,
      "skills": {
        "legumes": 10,
        "heat-control": 10,
        "patience": 10
      }
    }
  },
  {
    "id": "haruka-gluey-rice",
    "cook": "haruka",
    "title": "The Gluey Rice",
    "unlock": {
      "requires": [
        "marisol-salt-question"
      ],
      "trust": 0
    },
    "steps": [
      {
        "type": "talk",
        "lines": [
          "My shop makes three hundred a morning. Each one I press only three or four times. Any more and you are not making onigiri, you are making a brick.",
          "Now: my new helper made this batch. The rice is gluey. It sticks to everything, including my patience. Why?"
        ]
      },
      {
        "type": "riddle",
        "prompt": "The rice is gluey. What went wrong?",
        "options": [
          {
            "text": "It wasn't rinsed, and there was too much water",
            "correct": true,
            "reaction": "Yes! The loose starch on the grains turns to paste, and extra water finishes the job. Rinse until the water is only a little cloudy, and measure the water."
          },
          {
            "text": "Not enough soy sauce",
            "correct": false,
            "reaction": "Soy sauce fixes many things. Not this. Also, please never put soy sauce in my rice pot."
          },
          {
            "text": "The rice was sad",
            "correct": false,
            "reaction": "The rice is fine. It's my helper who is sad now. Think about what's on the surface of the grains."
          },
          {
            "text": "It was pressed too gently",
            "correct": false,
            "reaction": "Too gentle makes it fall apart. Too sticky is a different problem — it starts before the pot."
          }
        ],
        "explain": "Unrinsed rice carries loose surface starch that turns to paste when cooked, and too much water makes it worse; rinse until the water is only slightly cloudy and measure the water."
      },
      {
        "type": "errand",
        "stall": "okafor-sato",
        "item": "rice",
        "lines": [
          "My helper is now very sorry and also out of rice. Go to Okafor-Sato and buy Japanese short-grain rice. Short, round grains. Not long-grain, not jasmine, not basmati. They are good rice. They are not this rice.",
          "If there's no Japanese rice, a medium-grain like Calrose is fine. It's what many people outside Japan use. Don't buy 'sushi rice seasoning'. We are not making sushi. Nobody is vinegaring my onigiri.",
          "Good. Short, round, shiny. Okafor-Sato gave you a nod? Then it is good rice. I don't argue with Okafor-Sato."
        ]
      },
      {
        "type": "drill",
        "skill": "shaping",
        "prompt": "Wet your hands, rub a pinch of salt over your palms, take about 100 g of warm rice, make a dent, add a little filling, close the rice over it, then cup one hand into a V and turn the ball into a triangle with three or four gentle presses.",
        "lines": [
          "Water first, so the rice doesn't stick to you. Then salt on your hands, not in the rice. The salt goes on the outside, where your tongue meets it first.",
          "Warm rice. Not hot — you will burn yourself and learn nothing. Not cold — cold rice won't hold. Warm, like a bath you could stay in.",
          "One hand is the roof, one hand is the corner. Press, turn, press, turn. Three times. Four if you must. Stop.",
          "Firm enough to hold, soft enough that the grains are still grains. If you squeeze the air out, it becomes a stone with a filling. Customers do not want a stone.",
          "Again. Wet hands. Every single one. Not most. Every."
        ]
      },
      {
        "type": "recognize",
        "technique": "patience",
        "lines": [],
        "otherwise": []
      },
      {
        "type": "cook",
        "recipe": "japan/osaka/onigiri"
      }
    ],
    "rewards": {
      "xp": 50,
      "trust": 1,
      "skills": {
        "grains": 10,
        "shaping": 15,
        "heat-control": 5
      }
    }
  }
];

export const SHIPPED_TECHNIQUES: TechniqueNode[] = [
  {
    "id": "legumes",
    "name": "Legumes",
    "adjacent": [
      "tempering"
    ],
    "prereqs": []
  },
  {
    "id": "heat-control",
    "name": "Heat control",
    "adjacent": [
      "tempering",
      "stir-fry",
      "quick-sauce"
    ],
    "prereqs": []
  },
  {
    "id": "tempering",
    "name": "Tempering",
    "adjacent": [
      "quick-sauce"
    ],
    "prereqs": [
      "heat-control"
    ]
  },
  {
    "id": "grains",
    "name": "Grains",
    "adjacent": [
      "shaping",
      "stir-fry"
    ],
    "prereqs": []
  },
  {
    "id": "shaping",
    "name": "Shaping",
    "adjacent": [
      "knife"
    ],
    "prereqs": [
      "grains"
    ]
  },
  {
    "id": "patience",
    "name": "Patience",
    "adjacent": [
      "emulsion"
    ],
    "prereqs": []
  },
  {
    "id": "knife",
    "name": "Knife skills",
    "adjacent": [
      "emulsion"
    ],
    "prereqs": []
  },
  {
    "id": "stir-fry",
    "name": "Stir-frying",
    "adjacent": [],
    "prereqs": [
      "heat-control",
      "grains"
    ]
  },
  {
    "id": "emulsion",
    "name": "Emulsions",
    "adjacent": [],
    "prereqs": [
      "knife"
    ]
  },
  {
    "id": "quick-sauce",
    "name": "Quick sauces",
    "adjacent": [],
    "prereqs": [
      "heat-control"
    ]
  }
];

export const SHIPPED_RECIPE_SOURCES: Record<string, string> = {
  "india/kerala/parippu": "---\ntitle: Parippu Curry (Kerala dal with coconut)\ncountry: India\nregion: Kerala (Kochi)\ncredit: Drafted by Kitchen Quest editors from the home cooking of Kochi, Kerala — awaiting community review\ncook: leela\ndifficulty: 1\nskills: [legumes, heat-control, tempering]\nservings: 3\nlicense: CC-BY-SA-4.0\nstatus: draft\n---\n-- Draft until reviewed by a cook from this tradition.\nRinse @split moong dal{100%g} in a #bowl{} two or three times, until the water runs mostly clear.\n\nPut the dal in a #pot{} with @water{500%ml}, @turmeric{1/4%tsp} and @green chillies{2}, slit lengthways. Simmer, part-covered, until soft enough to crush against the side with a spoon. Add a splash more water if it gets thick. ~{20%minutes}\n\nWhile it cooks, grind @grated coconut{60%g} with @cumin seeds{1/2%tsp}, @garlic clove{1} and a splash of water in a #blender{} to a smooth, thick paste.\n\nMash the dal lightly with the back of a #ladle{}. Stir in the coconut paste and @salt{3/4%tsp}. Bring back to a gentle bubble — no hard boil now, or the coconut splits — and simmer. ~{5%minutes}\n\nFor the tempering, heat @coconut oil{1%tbsp} in a #small pan{} over medium heat. Add @mustard seeds{1/2%tsp} and wait until they pop. ~{30%seconds}\n\nAdd @shallots{3}, thinly sliced, and @dried red chillies{2}. Fry until the shallots turn golden. ~{3%minutes}\n\nAdd a @curry leaf sprig{1} — stand back, they spit — stir for a few seconds, then pour the sizzling tempering over the dal. Serve with hot rice, a spoon of @ghee{1%tsp} if you like, and fried or roasted @pappadam{3}.\n",
  "japan/osaka/onigiri": "---\ntitle: Onigiri (rice balls)\ncountry: Japan\nregion: Osaka (Kansai)\ncredit: Drafted by Kitchen Quest editors from the home cooking and onigiri shops of Osaka — awaiting community review\ncook: haruka\ndifficulty: 2\nskills: [grains, heat-control, shaping]\nservings: 6\nlicense: CC-BY-SA-4.0\nstatus: draft\n---\n-- Draft until reviewed by a cook from this tradition. 360 ml rice = 2 rice-cooker cups (about 300 g).\nMeasure @Japanese short-grain rice{360%ml} into a #bowl{}. Add cold water, swirl gently with your fingertips and pour it off quickly. Repeat three or four times, until the water is only slightly cloudy. Drain in a #sieve{}.\n\nPut the rice in a #heavy pot with a lid{} with @water{400%ml} and let it soak. ~{30%minutes}\n\nBring to a boil over medium-high heat with the lid on, then turn the heat to its lowest and cook without lifting the lid. ~{13%minutes}\n\nTurn off the heat and let the rice steam, lid still on. ~{10%minutes}\n\nMeanwhile, make okaka: mix @katsuobushi{5%g} (bonito flakes) with @soy sauce{1%tsp}. Pit @umeboshi{2} and tear them into pieces.\n\nFluff the rice with a wet #rice paddle{} and let it cool until you can hold it comfortably — warm, not hot. ~{5%minutes}\n\nWet your hands and rub a pinch of salt over your palms (@salt{1%tsp} in all). Take about 100 g of rice, press a dent in the middle, add a little filling, and close the rice over it.\n\nCup one hand into a V and turn the ball into a triangle with three or four gentle presses — firm enough to hold, never squashed. Wrap each in a strip of nori (@nori sheets{2}, cut in thirds) just before eating.\n",
  "mexico/oaxaca/frijoles-de-olla": "---\ntitle: Frijoles de Olla\ncountry: Mexico\nregion: Oaxaca\ncredit: Drafted by Kitchen Quest editors from the home cooking of Oaxaca — awaiting community review\ncook: marisol\ndifficulty: 1\nskills: [legumes, heat-control, patience]\nservings: 6\nlicense: CC-BY-SA-4.0\nstatus: draft\n---\n-- Draft until reviewed by a cook from this tradition. No soaking needed; older beans just take longer.\nSpread @dried black beans{500%g} on a #tray{} and pick out any small stones or shrivelled beans. Rinse them well in a #colander{}.\n\nPut the beans in an #olla{} or other heavy pot with @water{2.5%l}, @white onion{1/2}, @garlic cloves{2} and @lard{1%tbsp}. Bring to a boil. ~{10%minutes}\n\nTurn the heat down to the gentlest simmer and partly cover. Cook until the beans are soft and creamy inside. Check now and then: if the water dips below the beans, add hot water from a #kettle{}, never cold. ~{2%hours}\n\nTaste a few beans. When they are completely tender, add @salt{2%tsp} and @epazote sprigs{2}. Simmer so the broth takes the flavour. ~{20%minutes}\n\nFish out the onion and the epazote stalks. Taste the broth and adjust the salt. Serve the beans in their broth in a #bowl{}, with warm @corn tortillas{6} on the side.\n"
};
