// Rule elements that make PF2e's inert armor property runes work, generated
// from a mapping of each rune's text in which every rule element, selector and
// predicate option was checked against the PF2e 8.4.1 source by an independent
// verifier. "cls" says how much of the rune the rules cover (full, partial) or
// why none can (manual: an activation the GM resolves; engine: needs a
// chat-event engine, planned for a later phase).
export const RUNE_AUTOMATION = {
  "acidResistant": {
    "cls": "full",
    "en": "Automated: resistance 5 to acid while the armor is worn and invested.",
    "es": "Automatizado: resistencia 5 al ácido con la armadura puesta e investida.",
    "rules": [
      {
        "key": "Resistance",
        "label": "Acid-Resistant",
        "type": [
          "acid"
        ],
        "value": 5
      }
    ]
  },
  "advancing": {
    "cls": "manual",
    "en": "Manual: free-action Stride (15 ft) after you drop a foe to 0 HP; no reactions.",
    "es": "Manual: Zancada gratuita de 15 pies tras dejar a un enemigo a 0 PG; sin reacciones.",
    "rules": []
  },
  "aimAiding": {
    "cls": "manual",
    "en": "Manual: you don't give enemies cover against your allies' ranged attacks.",
    "es": "Manual: no das cobertura a enemigos contra ataques a distancia de tus aliados.",
    "rules": []
  },
  "antimagic": {
    "cls": "partial",
    "en": "+1 status bonus to saves vs magic automated; once-per-day counteract stays manual.",
    "es": "+1 bonificador de estado a salvaciones contra magia; contrarrestar 1/día es manual.",
    "rules": [
      {
        "key": "FlatModifier",
        "selector": "saving-throw",
        "type": "status",
        "value": 1,
        "predicate": [
          "item:magical"
        ],
        "label": "Antimagic"
      }
    ]
  },
  "assisting": {
    "cls": "full",
    "en": "Bulk limits +1 (encumbered at 6+Str, max 11+Str); supports are narrative.",
    "es": "Límites de Impedimenta +1 (sobrecargado a 6+Fue, máx. 11+Fue); soportes narrativos.",
    "rules": [
      {
        "key": "ActiveEffectLike",
        "label": "Assisting",
        "mode": "add",
        "path": "inventory.bulk.encumberedAfterAddend",
        "value": 1
      },
      {
        "key": "ActiveEffectLike",
        "label": "Assisting",
        "mode": "add",
        "path": "inventory.bulk.maxAddend",
        "value": 1
      }
    ]
  },
  "bitter": {
    "cls": "manual",
    "en": "Manual: a creature that Engulfs you or Swallows you Whole becomes sickened 1.",
    "es": "Manual: la criatura que te engulle o te traga entero queda indispuesta 1.",
    "rules": []
  },
  "coldResistant": {
    "cls": "full",
    "en": "Automated: resistance 5 to cold while the armor is worn and invested.",
    "es": "Automatizado: resistencia 5 al frío con la armadura puesta e investida.",
    "rules": [
      {
        "key": "Resistance",
        "label": "Cold-Resistant",
        "type": [
          "cold"
        ],
        "value": 5
      }
    ]
  },
  "convincing": {
    "cls": "full",
    "en": "+1 item bonus to Diplomacy to Make an Impression or Request, when rolled via the action.",
    "es": "+1 bonificador de objeto a Diplomacia para Causar impresión o Pedir, tirando la acción.",
    "rules": [
      {
        "key": "FlatModifier",
        "label": "Convincing",
        "selector": [
          "diplomacy"
        ],
        "type": "item",
        "value": 1,
        "predicate": [
          {
            "or": [
              "action:make-an-impression",
              "action:request"
            ]
          }
        ]
      }
    ]
  },
  "deathless": {
    "cls": "manual",
    "en": "Manual: 1/day reaction to lower a newly gained Doomed or Wounded by 1.",
    "es": "Manual: reacción 1/día para reducir en 1 condenado o herido recién obtenido.",
    "rules": []
  },
  "electricityResistant": {
    "cls": "full",
    "en": "Automated: resistance 5 to electricity while the armor is worn and invested.",
    "es": "Automatizado: resistencia 5 a la electricidad con la armadura puesta e investida.",
    "rules": [
      {
        "key": "Resistance",
        "label": "Electricity-Resistant",
        "type": [
          "electricity"
        ],
        "value": 5
      }
    ]
  },
  "energyAdaptive": {
    "cls": "partial",
    "en": "Actions-tab toggle picks the type: resistance 5. Reaction and 1/hour stay manual.",
    "es": "Interruptor en Acciones elige el tipo: resistencia 5. Reacción y 1/hora: manuales.",
    "rules": [
      {
        "key": "RollOption",
        "label": "Energy Adaptive",
        "domain": "all",
        "option": "energy-adaptive",
        "toggleable": true,
        "value": false,
        "suboptions": [
          {
            "label": "PF2E.TraitAcid",
            "value": "acid"
          },
          {
            "label": "PF2E.TraitCold",
            "value": "cold"
          },
          {
            "label": "PF2E.TraitElectricity",
            "value": "electricity"
          },
          {
            "label": "PF2E.TraitFire",
            "value": "fire"
          }
        ]
      },
      {
        "key": "Resistance",
        "label": "Energy Adaptive",
        "predicate": [
          "energy-adaptive:acid"
        ],
        "type": [
          "acid"
        ],
        "value": 5
      },
      {
        "key": "Resistance",
        "label": "Energy Adaptive",
        "predicate": [
          "energy-adaptive:cold"
        ],
        "type": [
          "cold"
        ],
        "value": 5
      },
      {
        "key": "Resistance",
        "label": "Energy Adaptive",
        "predicate": [
          "energy-adaptive:electricity"
        ],
        "type": [
          "electricity"
        ],
        "value": 5
      },
      {
        "key": "Resistance",
        "label": "Energy Adaptive",
        "predicate": [
          "energy-adaptive:fire"
        ],
        "type": [
          "fire"
        ],
        "value": 5
      }
    ]
  },
  "ethereal": {
    "cls": "manual",
    "en": "Not automated: 1/day activation grants Ethereal Jaunt for 10 min; GM resolves it.",
    "es": "Sin automatizar: activación 1/día da Ethereal Jaunt por 10 min; la resuelve el DJ.",
    "rules": []
  },
  "fireResistant": {
    "cls": "full",
    "en": "Automated: resistance 5 to fire while the armor is worn and invested.",
    "es": "Automatizado: resistencia 5 al fuego con la armadura puesta e investida.",
    "rules": [
      {
        "key": "Resistance",
        "label": "Fire-Resistant",
        "type": [
          "fire"
        ],
        "value": 5
      }
    ]
  },
  "fortification": {
    "cls": "engine",
    "en": "Engine: each crit taken prompts a DC 17 flat check to downgrade it. Bulk/Str +1 manual.",
    "es": "Motor: crítico recibido pide prueba plana CD 17; éxito = impacto. Imped./Fue +1 manual.",
    "rules": []
  },
  "glamered": {
    "cls": "manual",
    "en": "Manual: cosmetic illusion (armor looks like clothing); nothing mechanical to automate.",
    "es": "Manual: ilusión cosmética (la armadura parece ropa); no hay mecánica que automatizar.",
    "rules": []
  },
  "gliding": {
    "cls": "manual",
    "en": "Manual: 1-action glide, 5 ft down and 25 ft forward per action.",
    "es": "Manual: planeo de 1 acción, 5 pies abajo y 25 pies adelante por acción.",
    "rules": []
  },
  "greaterAcidResistant": {
    "cls": "full",
    "en": "Automated: resistance 10 to acid while the armor is worn and invested.",
    "es": "Automatizado: resistencia 10 al ácido con la armadura puesta e investida.",
    "rules": [
      {
        "key": "Resistance",
        "label": "Greater Acid-Resistant",
        "type": [
          "acid"
        ],
        "value": 10
      }
    ]
  },
  "greaterAdvancing": {
    "cls": "manual",
    "en": "Manual: free-action Stride up to your Speed after you drop a foe to 0 HP.",
    "es": "Manual: Zancada gratuita hasta tu Velocidad tras dejar a un enemigo a 0 PG.",
    "rules": []
  },
  "greaterColdResistant": {
    "cls": "full",
    "en": "Automated: resistance 10 to cold while the armor is worn and invested.",
    "es": "Automatizado: resistencia 10 al frío con la armadura puesta e investida.",
    "rules": [
      {
        "key": "Resistance",
        "label": "Greater Cold-Resistant",
        "type": [
          "cold"
        ],
        "value": 10
      }
    ]
  },
  "greaterConvincing": {
    "cls": "full",
    "en": "+2 item bonus to Diplomacy to Make an Impression or Request, when rolled via the action.",
    "es": "+2 bonificador de objeto a Diplomacia para Causar impresión o Pedir, tirando la acción.",
    "rules": [
      {
        "key": "FlatModifier",
        "label": "Greater Convincing",
        "selector": [
          "diplomacy"
        ],
        "type": "item",
        "value": 2,
        "predicate": [
          {
            "or": [
              "action:make-an-impression",
              "action:request"
            ]
          }
        ]
      }
    ]
  },
  "greaterDread": {
    "cls": "engine",
    "en": "Engine: frightened foes in 30 ft save Will DC 38 at turn end or frightened doesn't drop.",
    "es": "Motor: asustados a 30 pies salvan Voluntad CD 38 al fin de turno o su asustado no baja.",
    "rules": []
  },
  "greaterElectricityResistant": {
    "cls": "full",
    "en": "Automated: resistance 10 to electricity while the armor is worn and invested.",
    "es": "Automatizado: resistencia 10 a la electricidad con la armadura puesta e investida.",
    "rules": [
      {
        "key": "Resistance",
        "label": "Greater Electricity-Resistant",
        "type": [
          "electricity"
        ],
        "value": 10
      }
    ]
  },
  "greaterFireResistant": {
    "cls": "full",
    "en": "Automated: resistance 10 to fire while the armor is worn and invested.",
    "es": "Automatizado: resistencia 10 al fuego con la armadura puesta e investida.",
    "rules": [
      {
        "key": "Resistance",
        "label": "Greater Fire-Resistant",
        "type": [
          "fire"
        ],
        "value": 10
      }
    ]
  },
  "greaterFortification": {
    "cls": "engine",
    "en": "Engine: each crit taken prompts a DC 14 flat check to downgrade it. Bulk/Str +1 manual.",
    "es": "Motor: crítico recibido pide prueba plana CD 14; éxito = impacto. Imped./Fue +1 manual.",
    "rules": []
  },
  "greaterInvisibility": {
    "cls": "manual",
    "en": "Not automated: 3/day activation makes you invisible 1 min (2nd-rank Invisibility).",
    "es": "Sin automatizar: activación 3/día te vuelve invisible 1 min (Invisibilidad rango 2).",
    "rules": []
  },
  "greaterMoonweave": {
    "cls": "partial",
    "en": "+5 HP to magical heals from chat. GM: 1st heal per effect only; fast healing manual.",
    "es": "+5 PG a curación mágica del chat. DJ: solo 1.ª por efecto; curación rápida a mano.",
    "rules": [
      {
        "key": "FlatModifier",
        "label": "Greater Moonweave",
        "selector": "healing-received",
        "value": 5,
        "predicate": [
          {
            "or": [
              "item:magical",
              "origin:action:trait:magical",
              "origin:action:trait:arcane",
              "origin:action:trait:divine",
              "origin:action:trait:occult",
              "origin:action:trait:primal"
            ]
          }
        ]
      }
    ]
  },
  "greaterQuenching": {
    "cls": "partial",
    "en": "Recovery DC vs persistent acid/fire: 15->10 auto. Assisted (DC 5): GM sets it.",
    "es": "CD de recuperación de ácido/fuego persistente 15->10 auto. Con ayuda (CD 5): a mano.",
    "rules": [
      {
        "key": "ItemAlteration",
        "label": "Greater Quenching",
        "itemType": "condition",
        "mode": "downgrade",
        "property": "pd-recovery-dc",
        "value": 10,
        "predicate": [
          {
            "or": [
              "item:damage:type:acid",
              "item:damage:type:fire"
            ]
          }
        ]
      }
    ]
  },
  "greaterReady": {
    "cls": "manual",
    "en": "Manual: don this armor as a single action.",
    "es": "Manual: ponerte esta armadura con una sola acción.",
    "rules": []
  },
  "greaterShadow": {
    "cls": "full",
    "en": "+2 item bonus to Stealth checks; fully automated.",
    "es": "+2 bonificador de objeto a Sigilo; automático.",
    "rules": [
      {
        "key": "FlatModifier",
        "label": "Greater Shadow",
        "selector": [
          "stealth"
        ],
        "type": "item",
        "value": 2
      }
    ]
  },
  "greaterSlick": {
    "cls": "full",
    "en": "+2 item bonus to Acrobatics to Escape or Squeeze, when rolled via the action.",
    "es": "+2 bonificador de objeto a Acrobacias para Escapar o Escurrirse, tirando la acción.",
    "rules": [
      {
        "key": "FlatModifier",
        "label": "Greater Slick",
        "selector": [
          "acrobatics"
        ],
        "type": "item",
        "value": 2,
        "predicate": [
          {
            "or": [
              "action:escape",
              "action:squeeze"
            ]
          }
        ]
      }
    ]
  },
  "greaterStanching": {
    "cls": "partial",
    "en": "Recovery DC vs persistent bleed: 15->10 auto. Assisted (DC 5): GM sets it.",
    "es": "CD de recuperación de sangrado persistente 15->10 auto. Con ayuda (CD 5): a mano.",
    "rules": [
      {
        "key": "ItemAlteration",
        "label": "Greater Stanching",
        "itemType": "condition",
        "mode": "downgrade",
        "property": "pd-recovery-dc",
        "value": 10,
        "predicate": [
          "item:damage:type:bleed"
        ]
      }
    ]
  },
  "greaterSunweave": {
    "cls": "partial",
    "en": "+2 item bonus to Perception (and Perception initiative); Glint of Ambition is manual.",
    "es": "+2 bonificador de objeto a Percepción e iniciativa con ella; Destello de ambición: manual.",
    "rules": [
      {
        "key": "FlatModifier",
        "label": "Greater Sunweave",
        "selector": [
          "perception"
        ],
        "type": "item",
        "value": 2
      }
    ]
  },
  "greaterSwallowSpike": {
    "cls": "manual",
    "en": "Manual reaction when grabbed/held: armor attacks +22+potency for 3d6+2x potency piercing.",
    "es": "Reacción manual al quedar agarrado: ataque +22+potencia, 3d6+2x potencia perforante.",
    "rules": []
  },
  "greaterWinged": {
    "cls": "partial",
    "en": "Toggle grants fly Speed min(25, land) until dismissed; activation is manual.",
    "es": "Interruptor da Velocidad de vuelo mín(25, terrestre) hasta Descartar; activar a mano.",
    "rules": [
      {
        "key": "RollOption",
        "label": "Greater Winged",
        "domain": "all",
        "option": "armor-rune:greater-winged:take-to-the-skies",
        "toggleable": true,
        "value": false
      },
      {
        "key": "BaseSpeed",
        "label": "Greater Winged",
        "selector": "fly",
        "value": "min(25, @actor.system.movement.speeds.land.value)",
        "predicate": [
          "armor-rune:greater-winged:take-to-the-skies"
        ]
      }
    ]
  },
  "immovable": {
    "cls": "manual",
    "en": "Manual: 1/day apply Immobilized until dismissed; Force Open DC 40 to move you.",
    "es": "Manual: 1/día aplica inmovilizado hasta Descartar; Forzar apertura CD 40 para moverte.",
    "rules": []
  },
  "implacable": {
    "cls": "partial",
    "en": "Shows Quickened while grabbed or restrained; Step/Escape-only limit and others manual.",
    "es": "Acelerado automático si estás agarrado o neutralizado; límite Paso/Escapar es manual.",
    "rules": [
      {
        "key": "GrantItem",
        "uuid": "Compendium.pf2e.conditionitems.Item.nlCjDvLMf2EkV2dl",
        "inMemoryOnly": true,
        "predicate": [
          {
            "or": [
              "self:condition:grabbed",
              "self:condition:restrained"
            ]
          }
        ],
        "label": "Implacable"
      }
    ]
  },
  "invisibility": {
    "cls": "manual",
    "en": "Not automated: 1/day activation makes you invisible 1 min (2nd-rank Invisibility).",
    "es": "Sin automatizar: activación 1/día te vuelve invisible 1 min (Invisibilidad rango 2).",
    "rules": []
  },
  "lesserDread": {
    "cls": "engine",
    "en": "Engine: frightened foes within 30 ft save Will DC 20 at turn end or stay at least 1.",
    "es": "Motor: enemigos asustados a 30 pies salvan Voluntad CD 20 al fin de turno o siguen en 1+.",
    "rules": []
  },
  "magnetizing": {
    "cls": "manual",
    "en": "Manual: 1/hour, moving away from an adjacent metal target is difficult terrain.",
    "es": "Manual: 1/hora, alejarse de un objetivo metálico adyacente es terreno difícil.",
    "rules": []
  },
  "majorConvincing": {
    "cls": "full",
    "en": "+3 item bonus to Diplomacy to Make an Impression or Request, when rolled via the action.",
    "es": "+3 bonificador de objeto a Diplomacia para Causar impresión o Pedir, tirando la acción.",
    "rules": [
      {
        "key": "FlatModifier",
        "label": "Major Convincing",
        "selector": [
          "diplomacy"
        ],
        "type": "item",
        "value": 3,
        "predicate": [
          {
            "or": [
              "action:make-an-impression",
              "action:request"
            ]
          }
        ]
      }
    ]
  },
  "majorMoonweave": {
    "cls": "partial",
    "en": "+10 HP to magical heals from chat. GM: 1st heal per effect only; fast healing manual.",
    "es": "+10 PG a curación mágica del chat. DJ: solo 1.ª por efecto; curación rápida a mano.",
    "rules": [
      {
        "key": "FlatModifier",
        "label": "Major Moonweave",
        "selector": "healing-received",
        "value": 10,
        "predicate": [
          {
            "or": [
              "item:magical",
              "origin:action:trait:magical",
              "origin:action:trait:arcane",
              "origin:action:trait:divine",
              "origin:action:trait:occult",
              "origin:action:trait:primal"
            ]
          }
        ]
      }
    ]
  },
  "majorQuenching": {
    "cls": "partial",
    "en": "Recovery DC vs persistent acid/fire: 15->8 auto. Assisted (DC 3): GM sets it.",
    "es": "CD de recuperación de ácido/fuego persistente 15->8 auto. Con ayuda (CD 3): a mano.",
    "rules": [
      {
        "key": "ItemAlteration",
        "label": "Major Quenching",
        "itemType": "condition",
        "mode": "downgrade",
        "property": "pd-recovery-dc",
        "value": 8,
        "predicate": [
          {
            "or": [
              "item:damage:type:acid",
              "item:damage:type:fire"
            ]
          }
        ]
      }
    ]
  },
  "majorShadow": {
    "cls": "full",
    "en": "+3 item bonus to Stealth checks; fully automated.",
    "es": "+3 bonificador de objeto a Sigilo; automático.",
    "rules": [
      {
        "key": "FlatModifier",
        "label": "Major Shadow",
        "selector": [
          "stealth"
        ],
        "type": "item",
        "value": 3
      }
    ]
  },
  "majorSlick": {
    "cls": "full",
    "en": "+3 item bonus to Acrobatics to Escape or Squeeze, when rolled via the action.",
    "es": "+3 bonificador de objeto a Acrobacias para Escapar o Escurrirse, tirando la acción.",
    "rules": [
      {
        "key": "FlatModifier",
        "label": "Major Slick",
        "selector": [
          "acrobatics"
        ],
        "type": "item",
        "value": 3,
        "predicate": [
          {
            "or": [
              "action:escape",
              "action:squeeze"
            ]
          }
        ]
      }
    ]
  },
  "majorStanching": {
    "cls": "partial",
    "en": "Recovery DC vs persistent bleed: 15->8 auto. Assisted (DC 3): GM sets it.",
    "es": "CD de recuperación de sangrado persistente 15->8 auto. Con ayuda (CD 3): a mano.",
    "rules": [
      {
        "key": "ItemAlteration",
        "label": "Major Stanching",
        "itemType": "condition",
        "mode": "downgrade",
        "property": "pd-recovery-dc",
        "value": 8,
        "predicate": [
          "item:damage:type:bleed"
        ]
      }
    ]
  },
  "majorSunweave": {
    "cls": "partial",
    "en": "+3 item bonus to Perception (and Perception initiative); Glint of Ambition is manual.",
    "es": "+3 bonificador de objeto a Percepción e iniciativa con ella; Destello de ambición: manual.",
    "rules": [
      {
        "key": "FlatModifier",
        "label": "Major Sunweave",
        "selector": [
          "perception"
        ],
        "type": "item",
        "value": 3
      }
    ]
  },
  "majorSwallowSpike": {
    "cls": "manual",
    "en": "Manual reaction when grabbed/held: armor attacks +28+potency for 5d6+2x potency piercing.",
    "es": "Reacción manual al quedar agarrado: ataque +28+potencia, 5d6+2x potencia perforante.",
    "rules": []
  },
  "malleable": {
    "cls": "partial",
    "en": "Selector sets the armor group (specialization follows); rune suppression is manual.",
    "es": "Selector cambia el grupo de armadura (y su especialización); supresión de runas manual.",
    "rules": [
      {
        "key": "RollOption",
        "label": "Malleable",
        "domain": "all",
        "option": "armor-rune:malleable:group",
        "toggleable": true,
        "alwaysActive": true,
        "suboptions": [
          {
            "label": "SWE.ArmMalleableOriginal",
            "value": "original"
          },
          {
            "label": "PF2E.ArmorGroupChain",
            "value": "chain"
          },
          {
            "label": "PF2E.ArmorGroupCloth",
            "value": "cloth"
          },
          {
            "label": "PF2E.ArmorGroupComposite",
            "value": "composite"
          },
          {
            "label": "PF2E.ArmorGroupLeather",
            "value": "leather"
          },
          {
            "label": "PF2E.ArmorGroupPlate",
            "value": "plate"
          },
          {
            "label": "PF2E.ArmorGroupSkeletal",
            "value": "skeletal"
          },
          {
            "label": "PF2E.ArmorGroupWood",
            "value": "wood"
          }
        ]
      },
      {
        "key": "ItemAlteration",
        "label": "Malleable",
        "itemId": "{item|id}",
        "mode": "override",
        "property": "group",
        "value": "chain",
        "predicate": [
          "armor-rune:malleable:group:chain"
        ]
      },
      {
        "key": "ItemAlteration",
        "label": "Malleable",
        "itemId": "{item|id}",
        "mode": "override",
        "property": "group",
        "value": "cloth",
        "predicate": [
          "armor-rune:malleable:group:cloth"
        ]
      },
      {
        "key": "ItemAlteration",
        "label": "Malleable",
        "itemId": "{item|id}",
        "mode": "override",
        "property": "group",
        "value": "composite",
        "predicate": [
          "armor-rune:malleable:group:composite"
        ]
      },
      {
        "key": "ItemAlteration",
        "label": "Malleable",
        "itemId": "{item|id}",
        "mode": "override",
        "property": "group",
        "value": "leather",
        "predicate": [
          "armor-rune:malleable:group:leather"
        ]
      },
      {
        "key": "ItemAlteration",
        "label": "Malleable",
        "itemId": "{item|id}",
        "mode": "override",
        "property": "group",
        "value": "plate",
        "predicate": [
          "armor-rune:malleable:group:plate"
        ]
      },
      {
        "key": "ItemAlteration",
        "label": "Malleable",
        "itemId": "{item|id}",
        "mode": "override",
        "property": "group",
        "value": "skeletal",
        "predicate": [
          "armor-rune:malleable:group:skeletal"
        ]
      },
      {
        "key": "ItemAlteration",
        "label": "Malleable",
        "itemId": "{item|id}",
        "mode": "override",
        "property": "group",
        "value": "wood",
        "predicate": [
          "armor-rune:malleable:group:wood"
        ]
      }
    ]
  },
  "misleading": {
    "cls": "manual",
    "en": "Manual: flat check to target you while concealed is DC 6; mislead activation by hand.",
    "es": "Manual: la prueba plana para afectarte oculto es CD 6; activar mislead es a mano.",
    "rules": []
  },
  "mobile": {
    "cls": "manual",
    "en": "Manual: once per turn your Step can move 10 ft instead of 5 ft.",
    "es": "Manual: una vez por turno, tu Paso puede mover 10 pies en lugar de 5.",
    "rules": []
  },
  "moderateDread": {
    "cls": "engine",
    "en": "Engine: frightened foes within 30 ft save Will DC 29 at turn end or stay at least 2.",
    "es": "Motor: enemigos asustados a 30 pies salvan Voluntad CD 29 al fin de turno o siguen en 2+.",
    "rules": []
  },
  "moonweave": {
    "cls": "partial",
    "en": "+2 HP to magical heals from chat. GM: 1st heal per effect only; fast healing manual.",
    "es": "+2 PG a curación mágica del chat. DJ: solo 1.ª por efecto; curación rápida a mano.",
    "rules": [
      {
        "key": "FlatModifier",
        "label": "Moonweave",
        "selector": "healing-received",
        "value": 2,
        "predicate": [
          {
            "or": [
              "item:magical",
              "origin:action:trait:magical",
              "origin:action:trait:arcane",
              "origin:action:trait:divine",
              "origin:action:trait:occult",
              "origin:action:trait:primal"
            ]
          }
        ]
      }
    ]
  },
  "portable": {
    "cls": "manual",
    "en": "Manual: 3 actions fold the armor into a wearable trinket (not worn while folded).",
    "es": "Manual: 3 acciones la pliegan en un accesorio (plegada no cuenta como puesta).",
    "rules": []
  },
  "quenching": {
    "cls": "partial",
    "en": "Recovery DC vs persistent acid/fire: 15->12 auto. Assisted (DC 7): GM sets it.",
    "es": "CD de recuperación de ácido/fuego persistente 15->12 auto. Con ayuda (CD 7): a mano.",
    "rules": [
      {
        "key": "ItemAlteration",
        "label": "Quenching",
        "itemType": "condition",
        "mode": "downgrade",
        "property": "pd-recovery-dc",
        "value": 12,
        "predicate": [
          {
            "or": [
              "item:damage:type:acid",
              "item:damage:type:fire"
            ]
          }
        ]
      }
    ]
  },
  "raiment": {
    "cls": "manual",
    "en": "Manual: Costume Change disguises the armor as clothes; statistics are unchanged.",
    "es": "Manual: Cambio de vestuario disfraza la armadura como ropa; no cambia estadísticas.",
    "rules": []
  },
  "ready": {
    "cls": "manual",
    "en": "Manual: don light armor in 1 action, medium or heavy in 2 actions.",
    "es": "Manual: ponerte armadura ligera con 1 acción, media o pesada con 2.",
    "rules": []
  },
  "rockBraced": {
    "cls": "partial",
    "en": "+4 item bonus to Fortitude DC vs Shove/Reposition; moves with no check stay manual.",
    "es": "+4 bonificador de objeto a CD de Fortaleza vs Empujar/Reposicionar; sin prueba: manual.",
    "rules": [
      {
        "key": "FlatModifier",
        "selector": "fortitude-dc",
        "type": "item",
        "value": 4,
        "predicate": [
          {
            "or": [
              "action:reposition",
              "action:shove",
              "forced-movement"
            ]
          }
        ],
        "label": "Rock-Braced"
      }
    ]
  },
  "safeguarding": {
    "cls": "partial",
    "en": "Toggle grants resistance 5 (mental, poison or spirit); 1/day and 10 min stay manual.",
    "es": "Interruptor da resistencia 5 (mental, veneno o espíritu); 1/día y 10 min son manuales.",
    "rules": [
      {
        "key": "RollOption",
        "option": "safeguarding-adaptive-aegis",
        "toggleable": true,
        "label": "Safeguarding",
        "suboptions": [
          {
            "label": "PF2E.TraitMental",
            "value": "mental"
          },
          {
            "label": "PF2E.TraitPoison",
            "value": "poison"
          },
          {
            "label": "PF2E.TraitSpirit",
            "value": "spirit"
          }
        ]
      },
      {
        "key": "Resistance",
        "type": "mental",
        "value": 5,
        "predicate": [
          "safeguarding-adaptive-aegis:mental"
        ],
        "label": "Safeguarding"
      },
      {
        "key": "Resistance",
        "type": "poison",
        "value": 5,
        "predicate": [
          "safeguarding-adaptive-aegis:poison"
        ],
        "label": "Safeguarding"
      },
      {
        "key": "Resistance",
        "type": "spirit",
        "value": 5,
        "predicate": [
          "safeguarding-adaptive-aegis:spirit"
        ],
        "label": "Safeguarding"
      }
    ]
  },
  "selfSealing": {
    "cls": "manual",
    "en": "Manual: seals itself vs. environment; resistance 10 to environmental damage, 1 min air.",
    "es": "Manual: se sella ante el entorno; resistencia 10 a daño ambiental, 1 min de aire.",
    "rules": []
  },
  "shadow": {
    "cls": "full",
    "en": "+1 item bonus to Stealth checks; fully automated.",
    "es": "+1 bonificador de objeto a Sigilo; automático.",
    "rules": [
      {
        "key": "FlatModifier",
        "label": "Shadow",
        "selector": [
          "stealth"
        ],
        "type": "item",
        "value": 1
      }
    ]
  },
  "sidestepping": {
    "cls": "manual",
    "en": "Manual: 1/day phase through non-magical solids this turn; 6d6 if stuck inside.",
    "es": "Manual: 1/día atraviesa sólidos no mágicos este turno; 6d6 si acabas dentro.",
    "rules": []
  },
  "sinisterKnight": {
    "cls": "partial",
    "en": "+1 item bonus to Deception automated; the disguise activation and its effects are manual.",
    "es": "+1 bonificador de objeto a Engaño automático; el disfraz activable es manual.",
    "rules": [
      {
        "key": "FlatModifier",
        "selector": "deception",
        "type": "item",
        "value": 1,
        "label": "Sinister Knight"
      }
    ]
  },
  "sizeChanging": {
    "cls": "manual",
    "en": "Manual: 1/day the armor casts Enlarge or Shrink; apply the spell effect.",
    "es": "Manual: 1/día lanza Agrandar o Encoger; aplica el efecto del conjuro.",
    "rules": []
  },
  "slick": {
    "cls": "full",
    "en": "+1 item bonus to Acrobatics to Escape or Squeeze, when rolled via the action.",
    "es": "+1 bonificador de objeto a Acrobacias para Escapar o Escurrirse, tirando la acción.",
    "rules": [
      {
        "key": "FlatModifier",
        "label": "Slick",
        "selector": [
          "acrobatics"
        ],
        "type": "item",
        "value": 1,
        "predicate": [
          {
            "or": [
              "action:escape",
              "action:squeeze"
            ]
          }
        ]
      }
    ]
  },
  "soaring": {
    "cls": "partial",
    "en": "+10 ft item bonus to fly Speed; Gentle Landing and land-bonus overlap stay manual.",
    "es": "+10 pies de bonificador de objeto al vuelo; Aterrizaje suave y solape terrestre, manual.",
    "rules": [
      {
        "key": "FlatModifier",
        "label": "Soaring",
        "selector": "fly-speed",
        "type": "item",
        "value": 10
      }
    ]
  },
  "spellwatch": {
    "cls": "manual",
    "en": "Manual: at the start of your turn, retry a save against one hostile spell affecting you.",
    "es": "Manual: al iniciar tu turno, repite salvación contra un conjuro hostil que te afecte.",
    "rules": []
  },
  "stanching": {
    "cls": "partial",
    "en": "Recovery DC vs persistent bleed: 15->12 auto. Assisted (DC 7): GM sets it.",
    "es": "CD de recuperación de sangrado persistente 15->12 auto. Con ayuda (CD 7): a mano.",
    "rules": [
      {
        "key": "ItemAlteration",
        "label": "Stanching",
        "itemType": "condition",
        "mode": "downgrade",
        "property": "pd-recovery-dc",
        "value": 12,
        "predicate": [
          "item:damage:type:bleed"
        ]
      }
    ]
  },
  "sunweave": {
    "cls": "partial",
    "en": "+1 item bonus to Perception (and Perception initiative); Glint of Ambition is manual.",
    "es": "+1 bonificador de objeto a Percepción e iniciativa con ella; Destello de ambición: manual.",
    "rules": [
      {
        "key": "FlatModifier",
        "label": "Sunweave",
        "selector": [
          "perception"
        ],
        "type": "item",
        "value": 1
      }
    ]
  },
  "swallowSpike": {
    "cls": "manual",
    "en": "Manual reaction when grabbed/held: armor attacks +14+potency for 2d6+2x potency piercing.",
    "es": "Reacción manual al quedar agarrado: ataque +14+potencia, 2d6+2x potencia perforante.",
    "rules": []
  },
  "trueQuenching": {
    "cls": "partial",
    "en": "Recovery DC vs persistent acid/fire: 15->5 auto. Assisted: GM removes the condition.",
    "es": "CD de recuperación de ácido/fuego persistente 15->5 auto. Con ayuda: el DJ la retira.",
    "rules": [
      {
        "key": "ItemAlteration",
        "label": "True Quenching",
        "itemType": "condition",
        "mode": "downgrade",
        "property": "pd-recovery-dc",
        "value": 5,
        "predicate": [
          {
            "or": [
              "item:damage:type:acid",
              "item:damage:type:fire"
            ]
          }
        ]
      }
    ]
  },
  "trueStanching": {
    "cls": "partial",
    "en": "Recovery DC vs persistent bleed: 15->5 auto. Assisted: GM removes the condition.",
    "es": "CD de recuperación de sangrado persistente 15->5 auto. Con ayuda: el DJ lo retira.",
    "rules": [
      {
        "key": "ItemAlteration",
        "label": "True Stanching",
        "itemType": "condition",
        "mode": "downgrade",
        "property": "pd-recovery-dc",
        "value": 5,
        "predicate": [
          "item:damage:type:bleed"
        ]
      }
    ]
  },
  "unnerving": {
    "cls": "engine",
    "en": "Engine: whoever hits you in melee takes -1 circumstance on its next melee Strike vs you.",
    "es": "Motor: quien te impacte c/c sufre -1 por circunstancia a su siguiente Golpe c/c contra ti.",
    "rules": []
  },
  "winged": {
    "cls": "partial",
    "en": "Toggle grants fly Speed min(25, land); activation 1/hour and 5-min duration manual.",
    "es": "Interruptor da Velocidad de vuelo mín(25, terrestre); 1/hora y 5 min son manuales.",
    "rules": [
      {
        "key": "RollOption",
        "label": "Winged",
        "domain": "all",
        "option": "armor-rune:winged:take-to-the-skies",
        "toggleable": true,
        "value": false
      },
      {
        "key": "BaseSpeed",
        "label": "Winged",
        "selector": "fly",
        "value": "min(25, @actor.system.movement.speeds.land.value)",
        "predicate": [
          "armor-rune:winged:take-to-the-skies"
        ]
      }
    ]
  }
};
