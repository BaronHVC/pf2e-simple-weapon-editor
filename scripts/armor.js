import {
  MODULE_ID,
  i18n,
  clampInt,
  locRecord,
  labelFor,
  resolveLabel,
  canEdit,
  BONUS_TYPES,
  guardClicks,
  releaseClickGuard,
  renderSoon,
  condChoices,
  critPredicateTerm,
  condLabel,
  resolveCritInput,
  isValuedCondition,
  actorMatchesCrit,
  rollHealing,
  isSoleExecutor,
  HITCOND_EXCLUDED
} from "./main.js";
import { RUNE_AUTOMATION } from "./armor-runes.js";
import { enrichHTML, formDataClass, injectSheetButton, packIndex } from "./baron-core.js";

/* -------------------------------------------------------------------------- */
/*  Armor and shield editor                                                   */
/*                                                                            */
/*  A sibling of the weapon editor rather than a mode of it: armor plays the  */
/*  other side of a strike, so its analogue of extra damage is resistance and */
/*  its modifiers target the wearer's AC and saves. The weapon code is only   */
/*  imported from, never changed, so shipped weapon behavior cannot regress.  */
/*                                                                            */
/*  Its own data lives in one module flag (the source of truth); the rule     */
/*  elements it emits are output, marked by a "swe-a-" slug, regenerated on   */
/*  every save and never parsed back.                                         */
/* -------------------------------------------------------------------------- */

const DEF_FLAG = "defense";
// Frequency stamps the reaction engine writes. They live beside the defense
// flag, not inside it: the editor saves the whole defense object, so a stamp
// kept in there would be overwritten by any save made while it was open.
const USES_FLAG = "reactUses";
const DEF_SLUG = "swe-a-";
const DIE_SIZES = ["d4", "d6", "d8", "d10", "d12"];
const DEF_KINDS = ["resistance", "weakness", "immunity"];
const DEF_RULE_KEY = { resistance: "Resistance", weakness: "Weakness", immunity: "Immunity" };
const DEF_SCALES = ["fixed", "level", "halfLevel"];
const DEF_SCALE_FORMULA = { level: "@actor.level", halfLevel: "max(1,floor(@actor.level/2))" };
const MOD_TARGETS = [
  "ac",
  "saving-throw",
  "fortitude",
  "reflex",
  "will",
  "perception",
  "skill-check",
  "land-speed",
  "all-speeds"
];
const AGAINST = ["any", "melee", "ranged", "spell"];
// Only AC and saves are checked against an incoming attack or effect; Speed,
// Perception and skills never see the attacker's options, so an "against"
// filter there could never match.
const AGAINST_TARGETS = ["ac", "saving-throw", "fortitude", "reflex", "will"];
// Options the incoming attack or effect carries when the wearer's AC or save
// is checked against it.
const AGAINST_PREDICATE = {
  melee: ["item:melee"],
  ranged: ["item:ranged"],
  spell: [{ or: ["item:type:spell", "item:from-spell"] }]
};
const RAISED_OPTION = "self:shield:raised";
// Armor Expertise grants resistance by armor group, for medium and heavy armor
// only (values read from the class feature's own rule elements).
const SPECIALIZATION = {
  composite: { type: "piercing", medium: 1, heavy: 2 },
  leather: { type: "bludgeoning", medium: 1, heavy: 2 },
  plate: { type: "slashing", medium: 1, heavy: 2 },
  skeletal: { type: "precision", medium: 3, heavy: 5 },
  chain: { type: "critical-hits", medium: 4, heavy: 6 }
};
const ARMOR_FREQ_TRAITS = ["bulwark", "comfort", "flexible", "hindering", "laminar", "noisy", "ponderous"];
const SHIELD_FREQ_TRAITS = ["hefty-2", "deflecting-physical-ranged", "foldaway", "harnessed", "shield-throw-20"];

// Wearer conditionals: the weapon editor's criteria, plus one only armor has a
// use for - the ATTACKER suffering a condition. An attack against the wearer
// checks AC with the attacker's options as origin:condition:<slug> (verified:
// +2 AC vs a frightened attacker raised the DC from 16 to 18).
const ACOND_FILTERS = ["ancestry", "heritage", "class", "feat", "selfCondition", "originCondition"];
const ACOND_STATE = ["selfCondition", "originCondition"];
const ACOND_EFFECTS = ["mod", "resist", "healTurn", "tempTurn"];

// Reactions: event-driven cards the reaction engine (armor-engine.js) resolves
// in play. Unlike the conditionals they compile into no rule element - PF2e has
// none that acts when its holder is hit - so the flag is all there is.
const REACT_TRIGGERS = ["hit", "crit", "damaged", "block", "blockHurt", "blockZero"];
// Only a shield can Shield Block; armor offers the first three.
const SHIELD_TRIGGERS = ["block", "blockHurt", "blockZero"];
const REACT_ATTACKS = ["any", "strike", "melee", "meleeNoReach", "adjacent"];
const REACT_EFFECTS = ["damage", "condition", "tempHp"];
const REACT_FREQS = ["always", "turn", "round", "minute", "hour", "day"];
const REACT_SAVES = ["fortitude", "reflex", "will"];
// A basic save halves damage or stops all of it; a condition lands on a failed
// save or only on a critical failure, as with the weapon's hit conditions.
const REACT_SAVE_OUTS = { damage: ["half", "none"], condition: ["fail", "critFail"] };
// Same outcomes and multipliers as the weapon's gated saves, so same words.
const SAVE_OUT_LABEL = { half: "SaveHalf", none: "SaveNone", fail: "HitWhen_fail", critFail: "HitWhen_critFail" };
// The rune DCs the engine uses (the rune text's own flat checks).
const FORT_RUNE_DC = { fortification: 17, greaterFortification: 14 };
// The Reactions tab says when each rune that asks the wearer posts its prompt.
// The Swallow-Spike grades share a trigger, so they share one line.
const ASK_WHEN_KEY = { greaterSwallowSpike: "swallowSpike", majorSwallowSpike: "swallowSpike" };

// Cards are colored by effect. Temporary HP gets its own blue-violet, in both
// tabs, so it never reads as the green of healing.
const ACOND_LOOK = {
  mod: { kind: "attack", icon: "fa-shield-halved" },
  resist: { kind: "def", icon: "fa-shield" },
  healTurn: { kind: "heal", icon: "fa-heart" },
  tempTurn: { kind: "temp", icon: "fa-shield-heart" }
};
const REACT_LOOK = {
  damage: { kind: "damage", icon: "fa-burst" },
  condition: { kind: "rcond", icon: "fa-bolt" },
  tempHp: { kind: "temp", icon: "fa-shield-heart" }
};

function isTruthy(v) {
  return v === true || v === "true" || v === "on";
}

function normalizeACrit(crit) {
  const filter = ACOND_FILTERS.includes(crit?.filter) ? crit.filter : "ancestry";
  const out = { filter, slug: String(crit?.slug ?? "").trim() };
  if (ACOND_STATE.includes(filter)) out.min = clampInt(crit?.min, 0, 20, 0);
  return out;
}

// Temporary HP is a fixed amount, one that follows the level, or dice. Dice
// leave no room for a level scale (the engine rolls them as they are), so a
// die always comes with "fixed" and the stored shape cannot say two things.
function normalizeTemp(t) {
  const die = DIE_SIZES.includes(t?.die) ? t.die : "";
  return {
    value: clampInt(t?.value, 1, 99, 5),
    die,
    scale: die ? "fixed" : DEF_SCALES.includes(t?.scale) ? t.scale : "fixed"
  };
}

// The editor shows the die and the scale as one choice ("fixed", a die, or
// "= level"); the form hands it back as temp.mode.
function tempMode(t) {
  return t.die || t.scale;
}

function tempFromForm(prev, raw) {
  const t = { ...(prev ?? {}), ...(raw ?? {}) };
  const mode = t.mode;
  delete t.mode;
  if (DIE_SIZES.includes(mode)) Object.assign(t, { die: mode, scale: "fixed" });
  else if (DEF_SCALES.includes(mode)) Object.assign(t, { die: "", scale: mode });
  return t;
}

function tempModeOptions() {
  return [
    { value: "fixed", label: i18n("Fixed") },
    ...DIE_SIZES.map((d) => ({ value: d, label: d })),
    { value: "level", label: i18n("ArmScale_level") },
    { value: "halfLevel", label: i18n("ArmScale_halfLevel") }
  ];
}

function normalizeACond(c) {
  const effect = ACOND_EFFECTS.includes(c?.effect) ? c.effect : "mod";
  // Every payload is kept whatever the effect, so switching the effect back
  // and forth does not lose what was typed.
  return {
    effect,
    criteria: (Array.isArray(c?.criteria) ? c.criteria : []).map(normalizeACrit),
    mod: normalizeMod(c?.mod ?? { target: "ac", type: "circumstance", value: 1 }),
    def: normalizeDefense(c?.def ?? { kind: "resistance", type: "fire", value: 5 }),
    heal: { value: clampInt(c?.heal?.value, 1, 99, 1), die: DIE_SIZES.includes(c?.heal?.die) ? c.heal.die : "" },
    temp: normalizeTemp(c?.temp),
    src: String(c?.src ?? "").trim()
  };
}

function validConditionSlug(slug) {
  const s = String(slug ?? "").trim();
  if (!s || HITCOND_EXCLUDED.has(s)) return false;
  const record = CONFIG.PF2E?.conditionTypes;
  return !record || s in record;
}

function validDamageType(type) {
  const t = String(type ?? "").trim();
  if (!t) return false;
  const record = CONFIG.PF2E?.damageTypes;
  return !record || t in record;
}

// Ids key the engine's frequency stamps, which live in a flag object: only
// characters that are safe in a flag path are kept.
function reactId(id) {
  return String(id ?? "").replace(/[^A-Za-z0-9_-]/g, "") || foundry.utils.randomID(8);
}

// kind is the item type when known. Armor has no Shield Block and no shield
// Hardness, so those settings fall back to what armor can use; without a kind
// nothing is coerced.
function normalizeReact(r, kind = null) {
  const isArmor = kind === "armor";
  let trigger = REACT_TRIGGERS.includes(r?.trigger) ? r.trigger : "hit";
  if (isArmor && SHIELD_TRIGGERS.includes(trigger)) trigger = "hit";
  const effect = REACT_EFFECTS.includes(r?.effect) ? r.effect : "damage";
  // Each effect keeps its own save outcome, so trying another effect and
  // coming back finds the one chosen before. Data saved with a single "out"
  // seeds whichever list it belongs to.
  const dmgOuts = REACT_SAVE_OUTS.damage;
  const condOuts = REACT_SAVE_OUTS.condition;
  const outDmg = dmgOuts.includes(r?.save?.outDmg) ? r.save.outDmg : dmgOuts.includes(r?.save?.out) ? r.save.out : dmgOuts[0];
  const outCond = condOuts.includes(r?.save?.outCond) ? r.save.outCond : condOuts.includes(r?.save?.out) ? r.save.out : condOuts[0];
  // Every payload is kept whatever the effect, as in the conditionals, so
  // switching the effect back and forth does not lose what was typed. The
  // recipient too: only a condition reads it (damage always goes to the
  // attacker and temporary HP to the wearer).
  return {
    id: reactId(r?.id),
    trigger,
    attack: REACT_ATTACKS.includes(r?.attack) ? r.attack : "any",
    raised: !isArmor && isTruthy(r?.raised),
    criteria: (Array.isArray(r?.criteria) ? r.criteria : []).map(normalizeACrit),
    effect,
    to: r?.to === "wearer" ? "wearer" : "attacker",
    damage: {
      value: clampInt(r?.damage?.value, 1, 20, 1),
      die: DIE_SIZES.includes(r?.damage?.die) ? r.damage.die : "",
      bonus: clampInt(r?.damage?.bonus, 0, 99, 0),
      type: validDamageType(r?.damage?.type) ? String(r.damage.type).trim() : "piercing",
      persistent: isTruthy(r?.damage?.persistent),
      amount: !isArmor && r?.damage?.amount === "hardness" ? "hardness" : "roll"
    },
    cond: {
      slug: validConditionSlug(r?.cond?.slug) ? String(r.cond.slug).trim() : "frightened",
      value: clampInt(r?.cond?.value, 1, 99, 1)
    },
    temp: normalizeTemp(r?.temp),
    save: {
      type: REACT_SAVES.includes(r?.save?.type) ? r.save.type : "",
      dc: clampInt(r?.save?.dc, 1, 60, 15),
      // "auto" is the higher of the wearer's class and spell DC, read when the
      // reaction resolves; the fixed DC stays as the fallback for a wearer
      // with neither.
      mode: r?.save?.mode === "auto" ? "auto" : "fixed",
      outDmg,
      outCond,
      // The outcome of the effect shown, the one field the engine reads.
      // Temporary HP rolls no save; it reads as damage's, never used.
      out: effect === "condition" ? outCond : outDmg
    },
    freq: REACT_FREQS.includes(r?.freq) ? r.freq : "always",
    // Off unless ticked: the card then waits in chat for the wearer's owner
    // or the GM to click Use instead of resolving on its own. Cards saved
    // before the option existed read false, so they keep resolving as before.
    ask: isTruthy(r?.ask),
    src: String(r?.src ?? "").trim()
  };
}

// 0 means no generic fortification; the runes bring their own DCs.
function normalizeFort(f) {
  return { dc: clampInt(f?.dc, 0, 20, 0) };
}

// The attacker's options only exist while an attack or effect is checked
// against the wearer: a resistance is settled when the actor is prepared,
// turn-start healing has no attacker at all, and Speed is never checked
// against anyone. AC, saves, Perception and skill DCs can be.
const ATTACKER_BLIND_TARGETS = ["land-speed", "all-speeds"];
function acritInert(c, crit) {
  if (crit.filter !== "originCondition") return false;
  return c.effect !== "mod" || ATTACKER_BLIND_TARGETS.includes(c.mod.target);
}

// A card with a requirement that can never be checked never applies. Dropping
// just that requirement applied a resistance to every attacker instead, while
// the healing engine treated the same card as never met.
function acondInert(c) {
  return c.criteria.some((k) => acritInert(c, k));
}

// Cards resolved by an engine at turn start instead of a rule element: no
// rule element rolls healing, and PF2e's TempHP rule only takes a number, so
// temporary HP with a die is rolled by the reaction engine.
function acondByEngine(c) {
  return c.effect === "healTurn" || (c.effect === "tempTurn" && !!c.temp.die);
}

function acritTerm(crit) {
  if (crit.filter === "originCondition") {
    const base = `origin:condition:${crit.slug}`;
    return Number(crit.min) > 1 ? { gte: [base, Number(crit.min)] } : { or: [base] };
  }
  return critPredicateTerm(crit);
}

function armorMatchesCrit(actor, crit) {
  if (crit.filter === "originCondition") return false;
  return actorMatchesCrit(actor, crit);
}

function acondChoices(choices) {
  return { ...choices, originCondition: choices?.selfCondition ?? [] };
}

function normalizeDefense(e) {
  const kind = DEF_KINDS.includes(e?.kind) ? e.kind : "resistance";
  return {
    kind,
    type: String(e?.type ?? "").trim(),
    value: clampInt(e?.value, 1, 99, 5),
    scale: DEF_SCALES.includes(e?.scale) ? e.scale : "fixed",
    except: String(e?.except ?? "").trim(),
    raised: isTruthy(e?.raised),
    src: String(e?.src ?? "").trim()
  };
}

function normalizeMod(m) {
  const target = String(m?.target ?? "ac");
  return {
    target: MOD_TARGETS.includes(target) || target.startsWith("skill:") ? target : "ac",
    type: BONUS_TYPES.includes(m?.type) ? m.type : "circumstance",
    // A modifier can be a penalty, never zero.
    value: clampInt(m?.value, -99, 99, 1) || 1,
    against: AGAINST.includes(m?.against) && AGAINST_TARGETS.includes(target) ? m.against : "any",
    raised: isTruthy(m?.raised),
    src: String(m?.src ?? "").trim()
  };
}

function readDefense(item) {
  const raw = item?._source?.flags?.[MODULE_ID]?.[DEF_FLAG] ?? {};
  return {
    defenses: (Array.isArray(raw.defenses) ? raw.defenses : []).map(normalizeDefense).filter((d) => d.type),
    mods: (Array.isArray(raw.mods) ? raw.mods : []).map(normalizeMod),
    conds: (Array.isArray(raw.conds) ? raw.conds : [])
      .map(normalizeACond)
      .map((c) => ({ ...c, criteria: c.criteria.filter((k) => k.slug) }))
      .filter((c) => c.criteria.length),
    // A reaction with no requirements fires on every matching event, so an
    // empty requirement is dropped but the card is kept.
    reacts: (Array.isArray(raw.reacts) ? raw.reacts : [])
      .map((r) => normalizeReact(r, item?.type))
      .map((r) => ({ ...r, criteria: r.criteria.filter((k) => k.slug) })),
    fort: normalizeFort(item?.type === "armor" ? raw.fort : null),
    runeOff: Array.isArray(raw.runeOff) ? raw.runeOff.map(String) : [],
    toggles: raw.toggles && typeof raw.toggles === "object" ? raw.toggles : {}
  };
}

// Worn gear counts only while equipped and, when it can be, invested: the same
// requirement the system puts on the item's own rule elements.
function isGearActive(item) {
  return !!item?.isEquipped && item.isInvested !== false;
}

// The property runes the engine may act on: the armor as prepared (the system
// already drops runes past the slot limit) minus those whose automation was
// switched off in the editor. Shields carry no property runes.
function activeRunesOf(item) {
  if (item?.type !== "armor") return [];
  const off = item._source?.flags?.[MODULE_ID]?.[DEF_FLAG]?.runeOff;
  const offList = Array.isArray(off) ? off.map(String) : [];
  return [...new Set(item.system?.runes?.property ?? [])].filter((slug) => !offList.includes(slug));
}

// A toggleable RollOption stores the player's choice (on/off, the picked
// suboption) inside its own rule source; regenerating the rules would reset it
// on every save. The state is matched by the slug past the item id - a copy of
// the armor (a duplicate, a drag onto an actor) gets a new id while its rules
// keep the old one - and is also kept in the flag, so a rune whose automation
// is switched off and on again gets its state back.
function toggleKey(slug) {
  return String(slug).replace(/^swe-a-(?:armor|shield)-[a-z0-9]*-/, "");
}

function toggleStates(rules, stored = {}) {
  const out = { ...stored };
  for (const r of rules) {
    if (r?.key !== "RollOption" || !r.toggleable || !isDefenseRule(r)) continue;
    const state = {};
    if ("value" in r) state.value = r.value;
    if ("selection" in r) state.selection = r.selection;
    out[toggleKey(r.slug)] = state;
  }
  return out;
}

function withToggleState(rules, states) {
  return rules.map((r) => {
    if (r.key !== "RollOption" || !r.toggleable) return r;
    const state = states[toggleKey(r.slug)];
    return state ? { ...r, ...state } : r;
  });
}

function isDefenseRule(r) {
  return typeof r?.slug === "string" && r.slug.startsWith(DEF_SLUG);
}

function defTypeRecord(kind) {
  const cfg = CONFIG.PF2E ?? {};
  return kind === "immunity" ? cfg.immunityTypes : kind === "weakness" ? cfg.weaknessTypes : cfg.resistanceTypes;
}

// "custom" is a blank placeholder in the system's IWR records, not a type.
function iwrOptions(kind) {
  return locRecord(defTypeRecord(kind)).filter((o) => o.value !== "custom");
}

function modSelector(target) {
  return target.startsWith("skill:") ? target.slice("skill:".length) : target;
}

function modTargetLabel(target) {
  const cfg = CONFIG.PF2E ?? {};
  if (target.startsWith("skill:")) {
    const slug = target.slice("skill:".length);
    const v = cfg.skills?.[slug];
    return game.i18n.localize(v?.label ?? slug);
  }
  if (["fortitude", "reflex", "will"].includes(target)) return labelFor(cfg.saves, target);
  if (target === "perception") return game.i18n.localize("PF2E.PerceptionLabel");
  return i18n(`ArmTarget_${target}`);
}

function signed(n) {
  return n > 0 ? `+${n}` : `${n}`;
}

function defenseValueText(d) {
  if (d.kind === "immunity") return "";
  if (d.scale === "level") return ` ${i18n("ArmScale_level")}`;
  if (d.scale === "halfLevel") return ` ${i18n("ArmScale_halfLevel")}`;
  return ` ${d.value}`;
}

function defenseText(d) {
  const typeLabel = labelFor(defTypeRecord(d.kind), d.type);
  const except = d.except ? ` (${i18n("ArmExcept")} ${labelFor(CONFIG.PF2E?.resistanceTypes, d.except)})` : "";
  return `${i18n(`ArmDefKind_${d.kind}`)} ${typeLabel}${defenseValueText(d)}${except}`;
}

function modText(m) {
  const against = m.against !== "any" ? ` (${i18n(`ArmAgainst_${m.against}`)})` : "";
  return `${signed(m.value)} ${i18n(`Bonus_${m.type}`)} · ${modTargetLabel(m.target)}${against}`;
}

// Rule elements for the editor's defenses and modifiers. Armor keeps the
// system's default requiresEquipped (worn in its slot, and invested when it is
// magical) on purpose: armor in a backpack must not protect anyone.
// Slugs carry the item kind and id: PF2e dedupes modifiers by slug before
// stacking, so an armor and a shield both emitting "swe-a-m0" silently lost
// one of the two bonuses.
function defenseRules(data, itemId) {
  const rules = [];
  const tag = `${data.kind}-${String(itemId ?? "").toLowerCase()}`;
  data.defenses.forEach((d, i) => {
    const rule = {
      key: DEF_RULE_KEY[d.kind],
      slug: `${DEF_SLUG}${tag}-d${i}`,
      type: d.type,
      label: d.src || defenseText(d)
    };
    if (d.kind !== "immunity") rule.value = d.scale === "fixed" ? d.value : DEF_SCALE_FORMULA[d.scale];
    if (d.except) rule.exceptions = [d.except];
    if (data.kind === "shield" && d.raised) rule.predicate = [RAISED_OPTION];
    rules.push(rule);
  });
  data.mods.forEach((m, i) => {
    const predicate = AGAINST_TARGETS.includes(m.target) ? [...(AGAINST_PREDICATE[m.against] ?? [])] : [];
    if (data.kind === "shield" && m.raised) predicate.push(RAISED_OPTION);
    const rule = {
      key: "FlatModifier",
      slug: `${DEF_SLUG}${tag}-m${i}`,
      selector: modSelector(m.target),
      type: m.type,
      value: m.value,
      label: m.src || modText(m)
    };
    if (predicate.length) rule.predicate = predicate;
    rules.push(rule);
  });
  // Wearer conditionals become native rules gated on their criteria; healing
  // and rolled temporary HP have no rule element that rolls dice, so the
  // turn-start engines apply them.
  data.conds.forEach((c, i) => {
    if (acondByEngine(c) || acondInert(c)) return;
    const terms = c.criteria.map(acritTerm);
    if (!terms.length) return;
    if (c.effect === "tempTurn") {
      // The system's own rule: higher value only, granted in its turn-start
      // pipeline on the active GM. onCreate stays off, or dropping the armor
      // onto an actor would grant the temporary HP right there.
      const t = c.temp;
      rules.push({
        key: "TempHP",
        slug: `${DEF_SLUG}${tag}-c${i}`,
        // A key, not text: the label is localized when the actor is
        // prepared, so each reader sees it in their own language.
        label: c.src || "SWE.ArmTempTurn",
        value: t.scale === "fixed" ? t.value : DEF_SCALE_FORMULA[t.scale],
        events: { onCreate: false, onTurnStart: true },
        predicate: terms
      });
    } else if (c.effect === "mod") {
      const m = c.mod;
      const predicate = [...terms, ...(AGAINST_TARGETS.includes(m.target) ? AGAINST_PREDICATE[m.against] ?? [] : [])];
      rules.push({
        key: "FlatModifier",
        slug: `${DEF_SLUG}${tag}-c${i}`,
        selector: modSelector(m.target),
        type: m.type,
        value: m.value,
        label: c.src || modText(m),
        predicate
      });
    } else {
      const d = c.def;
      const rule = {
        key: DEF_RULE_KEY[d.kind],
        slug: `${DEF_SLUG}${tag}-c${i}`,
        type: d.type,
        label: c.src || defenseText(d),
        predicate: terms
      };
      if (d.kind !== "immunity") rule.value = d.scale === "fixed" ? d.value : DEF_SCALE_FORMULA[d.scale];
      if (d.except) rule.exceptions = [d.except];
      rules.push(rule);
    }
  });
  // An adopted ancestry never becomes a roll option on its own (same helper as
  // the weapon editor emits), so ancestry criteria need it published.
  if (data.conds.some((c) => !acondByEngine(c) && !acondInert(c) && c.criteria.some((k) => k.filter === "ancestry"))) {
    rules.push({
      key: "ActiveEffectLike",
      slug: `${DEF_SLUG}${tag}-adopted`,
      mode: "override",
      path: "flags.pf2e.rollOptions.all.swe-adopted:{actor|system.details.ancestry.adopted}",
      value: true,
      priority: 999,
      predicate: ["feat:adopted-ancestry"]
    });
  }
  // PF2e leaves armor property runes inert; the module adds the rules each
  // rune can honestly be expressed with. Each rule also requires its own rune
  // on the armor as prepared: the system trims runes past the slot limit
  // before publishing parent:rune:property:<rune>, so a rune removed on the
  // system's sheet, or left without a slot by a lower potency, switches its
  // rules off without waiting for a save here.
  // Slugs are keyed by the rune, not its position, so a rune keeps the state
  // of its sheet toggles (Energy Adaptive's type, Winged) when others are
  // added or removed; onSubmit carries that state across the regeneration.
  if (data.kind === "armor") {
    for (const slug of data.runes.property) {
      const spec = RUNE_AUTOMATION[slug];
      if (!spec?.rules?.length || data.runeOff.includes(slug)) continue;
      const present = `parent:rune:property:${runeOptionSlug(slug)}`;
      const label = runeLabelKey(slug);
      spec.rules.forEach((r, j) => {
        const rule = foundry.utils.deepClone(r);
        rule.predicate = [...(Array.isArray(rule.predicate) ? rule.predicate : []), present];
        rules.push({ ...rule, label, slug: `${DEF_SLUG}${tag}-r-${slug.toLowerCase()}-${j}` });
      });
    }
  }
  return rules;
}

// The rune as the system writes it in roll options (fireResistant ->
// fire-resistant), with the system's own sluggify when it is reachable.
function runeOptionSlug(slug) {
  const sluggify = game.pf2e?.system?.sluggify;
  if (typeof sluggify === "function") return sluggify(slug);
  return slug.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

// Rule labels are localized when the actor is prepared, so the system's key
// shows the rune's name in each reader's language; localized text would stay
// in the language of whoever saved.
function runeLabelKey(slug) {
  const key = `PF2E.ArmorPropertyRune${slug.charAt(0).toUpperCase()}${slug.slice(1)}`;
  return game.i18n.has(key) ? key : labelFor(armorRuneRecord(), slug);
}

/* ------------------------------------------------------------------ runes */

let _armorRuneRecord = null;
// The system keeps its armor property rune table internal; the names live in
// flat i18n keys PF2E.ArmorPropertyRune<Name>, and the data stores the same
// name in camelCase (fireResistant, greaterFortification).
function armorRuneRecord() {
  if (_armorRuneRecord) return _armorRuneRecord;
  const out = {};
  for (const scope of ["translations", "_fallback"]) {
    const tr = foundry.utils.getProperty(game.i18n, `${scope}.PF2E`) ?? {};
    for (const [k, v] of Object.entries(tr)) {
      const m = /^ArmorPropertyRune(.+)$/.exec(k);
      if (!m || typeof v !== "string") continue;
      const slug = m[1].charAt(0).toLowerCase() + m[1].slice(1);
      out[slug] ??= v;
    }
  }
  if (Object.keys(out).length) _armorRuneRecord = out;
  return out;
}

// Same pack and fields as the weapon editor's rune index: one shared,
// memoized getIndex through baron-core.
async function equipmentIndex() {
  return packIndex("pf2e.equipment-srd", ["system.slug", "type"]);
}

const _armorRuneInfo = new Map();
// Level, price and description come from the rune's compendium item. Its slug
// puts the grade last (slick-greater) and the energy runes share one item
// (energy-resistant), so several candidates are tried.
async function armorRuneInfo(slug) {
  if (_armorRuneInfo.has(slug)) return _armorRuneInfo.get(slug);
  const info = { slug, label: labelFor(armorRuneRecord(), slug), level: null, price: null, descHTML: null };
  const base = slug.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  const parts = base.split("-");
  const grades = ["greater", "major", "true", "lesser", "moderate", "minor", "supreme"];
  const grade = grades.includes(parts[0]) && parts.length > 1 ? parts[0] : null;
  const core = grade ? parts.slice(1).join("-") : base;
  const cands = [base];
  if (grade) cands.push(`${core}-${grade}`);
  if (/^(acid|cold|electricity|fire|sonic)-resistant$/.test(core)) {
    cands.push(grade ? `energy-resistant-${grade}` : "energy-resistant");
  }
  try {
    const index = await equipmentIndex();
    const pack = game.packs.get("pf2e.equipment-srd");
    let entry = null;
    for (const c of cands) {
      entry = index.find((e) => e.system?.slug === c);
      if (entry) break;
    }
    if (entry && pack) {
      const doc = await pack.getDocument(entry._id);
      info.level = doc?.system?.level?.value ?? null;
      info.price = doc?.system?.price?.value?.gp ?? null;
      const desc = doc?.system?.description?.value ?? "";
      if (desc) {
        info.descHTML = await enrichHTML(desc, { async: true });
      }
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | armor rune info`, err);
  }
  _armorRuneInfo.set(slug, info);
  return info;
}

function abpFor(actor) {
  const ABP = game.pf2e?.variantRules?.AutomaticBonusProgression;
  try {
    if (ABP?.isEnabled) return !!ABP.isEnabled(actor ?? null);
  } catch {}
  try {
    const v = game.settings.get("pf2e", "automaticBonusVariant");
    return !!v && v !== "noABP";
  } catch {
    return false;
  }
}

// "ABP: Disallow Property Runes": the system empties system.runes.property
// while preparing the armor, so neither the rune rules (predicated on the
// rune being there) nor the engine (activeRunesOf reads the prepared runes)
// see any rune at all.
function abpStripsRunes(actor) {
  if (!abpFor(actor)) return false;
  let variant = game.pf2e?.settings?.variants?.abp;
  if (variant === undefined) {
    try {
      variant = game.settings.get("pf2e", "automaticBonusVariant");
    } catch {
      return false;
    }
  }
  return variant === "ABPRulesAsWritten";
}

// The system's ABP check on a modifier rule: an item bonus from equipment
// that is not a penalty.
function abpSuppresses(rule) {
  return rule.key === "FlatModifier" && rule.type === "item" && !(Number(rule.value) < 0);
}

// The class word the rune table starts its summaries with, which the badge
// beside it already shows.
const AUTO_PREFIX = /^(Automated|Automatizado|Manual|Engine|Motor|Not automated|Sin automatizar):\s*/;

// Mirrors the system's slot count: graded (Starfinder) armor has none, ABP
// replaces potency with the level-based defense potency, orichalcum adds one.
function armorPropertySlots(item, potency) {
  const src = item._source.system ?? {};
  if (src.grade) return 0;
  let base = Number(potency) || 0;
  const ABP = game.pf2e?.variantRules?.AutomaticBonusProgression;
  try {
    if (abpFor(item.actor)) base = ABP?.getDefensePotency?.(item.actor?.level ?? 20) ?? base;
  } catch {}
  return base + (src.material?.type === "orichalcum" ? 1 : 0);
}

// PF2e prices a non-specific item with runes or a precious material from
// those alone and ignores its base price, so there is no base to edit then.
function basePriceIgnored(item) {
  if (item.isSpecific) return false;
  const src = item._source.system ?? {};
  if (src.material?.type && src.material?.grade) return true;
  if (item.type !== "armor") return false;
  const r = src.runes ?? {};
  return (Number(r.potency) || 0) > 0 || (Number(r.resilient) || 0) > 0 || (r.property?.length ?? 0) > 0;
}

/* ----------------------------------------------------------------- editor */

class SimpleArmorEditor extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  constructor(item, options = {}) {
    super(options);
    this.item = item;
    this.data = SimpleArmorEditor.extract(item);
    this.selectedRune = null;
    this._sweTab = "defense";
  }

  static instances = new Map();

  static open(item) {
    if (item?.type !== "armor" && item?.type !== "shield") {
      ui.notifications.warn(i18n("ArmNotDefense"));
      return null;
    }
    const key = item.uuid ?? item.id;
    const existing = SimpleArmorEditor.instances.get(key);
    if (existing) {
      existing.render(true);
      existing.bringToFront?.();
      return existing;
    }
    const app = new SimpleArmorEditor(item);
    SimpleArmorEditor.instances.set(key, app);
    app.render(true);
    return app;
  }

  async close(options) {
    SimpleArmorEditor.instances.delete(this.item.uuid ?? this.item.id);
    releaseClickGuard(this);
    return super.close(options);
  }

  static extract(item) {
    const s = item._source.system ?? {};
    const def = readDefense(item);
    const data = {
      kind: item.type,
      name: item._source.name,
      level: clampInt(s.level?.value, 0, 30, 0),
      traits: [...new Set(s.traits?.value ?? [])],
      defenses: def.defenses,
      mods: def.mods,
      conds: def.conds,
      reacts: def.reacts,
      fort: def.fort,
      runeOff: def.runeOff,
      freeMode: false
    };
    if (item.type === "armor") {
      Object.assign(data, {
        category: s.category ?? "light",
        group: s.group ?? "",
        acBonus: clampInt(s.acBonus, 0, 20, 0),
        dexCap: clampInt(s.dexCap, 0, 10, 5),
        checkPenalty: clampInt(s.checkPenalty, -10, 0, 0),
        speedPenalty: clampInt(s.speedPenalty, -30, 0, 0),
        strength: typeof s.strength === "number" ? s.strength : "",
        runes: {
          potency: clampInt(s.runes?.potency, 0, 4, 0),
          resilient: clampInt(s.runes?.resilient, 0, 4, 0),
          property: [...new Set(s.runes?.property ?? [])]
        }
      });
    } else {
      Object.assign(data, {
        acBonus: clampInt(s.acBonus, 0, 10, 2),
        hardness: clampInt(s.hardness, 0, 50, 0),
        hpMax: clampInt(s.hp?.max, 0, 999, 0),
        speedPenalty: clampInt(s.speedPenalty, -30, 0, 0),
        reinforcing: clampInt(s.runes?.reinforcing, 0, 6, 0)
      });
    }
    return data;
  }

  static DEFAULT_OPTIONS = {
    classes: ["swe-editor", "swe-armor-editor"],
    tag: "form",
    position: { width: 920, height: 700 },
    window: { icon: "fa-solid fa-shield-halved", resizable: true },
    form: {
      handler: SimpleArmorEditor.onSubmit,
      submitOnChange: false,
      closeOnSubmit: false
    },
    actions: {
      sweTab: SimpleArmorEditor.actTab,
      sweRevert: SimpleArmorEditor.actRevert,
      sweAddDefense: SimpleArmorEditor.actAddDefense,
      sweRemoveDefense: SimpleArmorEditor.actRemoveDefense,
      sweAddMod: SimpleArmorEditor.actAddMod,
      sweRemoveMod: SimpleArmorEditor.actRemoveMod,
      sweAddRune: SimpleArmorEditor.actAddRune,
      sweRemoveRune: SimpleArmorEditor.actRemoveRune,
      sweShowRune: SimpleArmorEditor.actShowRune,
      sweAddTrait: SimpleArmorEditor.actAddTrait,
      sweQuickTrait: SimpleArmorEditor.actQuickTrait,
      sweRemoveTrait: SimpleArmorEditor.actRemoveTrait,
      sweAddACond: SimpleArmorEditor.actAddACond,
      sweRemoveACond: SimpleArmorEditor.actRemoveACond,
      sweAddACrit: SimpleArmorEditor.actAddACrit,
      sweRemoveACrit: SimpleArmorEditor.actRemoveACrit,
      sweAddReact: SimpleArmorEditor.actAddReact,
      sweRemoveReact: SimpleArmorEditor.actRemoveReact,
      sweAddRCrit: SimpleArmorEditor.actAddRCrit,
      sweRemoveRCrit: SimpleArmorEditor.actRemoveRCrit
    }
  };

  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/armor.hbs` }
  };

  get title() {
    return `${i18n(this.item.type === "shield" ? "ShTitle" : "ArmTitle")}: ${this.item.name}`;
  }

  async render(options = {}, _options) {
    const body = this.element?.querySelector?.(".swe-body");
    if (body) this._sweScrollTop = body.scrollTop;
    return super.render(options, _options);
  }

  get traitRecord() {
    const cfg = CONFIG.PF2E ?? {};
    return this.data.kind === "shield" ? cfg.shieldTraits : cfg.armorTraits;
  }

  async _prepareContext() {
    const d = this.data;
    const cfg = CONFIG.PF2E ?? {};
    const isArmor = d.kind === "armor";
    const preview = [];
    const notes = [];
    let runesResolved = [];
    let slots = 0;
    // Read by the rune cards and by the fortification lines of the Reactions
    // tab: under this ABP variant the armor has no property runes at all.
    const abpNoRunes = isArmor && abpStripsRunes(this.item.actor);
    if (isArmor) {
      const potency = Number(d.runes.potency) || 0;
      const str = d.strength === "" ? null : Number(d.strength);
      preview.push(`${i18n("ArmPreviewAC")} +${d.acBonus + potency}${potency ? ` (${d.acBonus} + ${potency} ${i18n("ArmPotencyShort")})` : ""}`);
      preview.push(`${i18n("ArmPreviewDex")} +${d.dexCap}`);
      if (d.checkPenalty < 0) {
        preview.push(`${d.checkPenalty} ${i18n("ArmPreviewChecks")}${str !== null ? ` (0 ${i18n("ArmWithStr")} +${str})` : ""}`);
        if (str === null) notes.push(i18n("ArmNoStrengthWarn"));
      }
      if (d.speedPenalty < 0) {
        const eased = Math.min(0, d.speedPenalty + 5);
        preview.push(`${d.speedPenalty} ${i18n("ArmPreviewFeet")}${str !== null ? ` (${eased} ${i18n("ArmWithStr")} +${str})` : ""}`);
      }
      if (d.runes.resilient > 0) preview.push(`+${d.runes.resilient} ${i18n("ArmPreviewSaves")}`);
      const spec = SPECIALIZATION[d.group];
      if (spec && (d.category === "medium" || d.category === "heavy")) {
        const n = spec[d.category] + potency;
        notes.push(`${i18n("ArmSpecialization")}: ${i18n("ArmDefKind_resistance")} ${labelFor(cfg.resistanceTypes, spec.type)} ${n}`);
      }
      const infos = await Promise.all(d.runes.property.map((slug) => armorRuneInfo(slug)));
      slots = armorPropertySlots(this.item, potency);
      const es = game.i18n.lang === "es";
      const abp = abpFor(this.item.actor);
      runesResolved = d.runes.property.map((slug, i) => {
        const spec = RUNE_AUTOMATION[slug];
        const specRules = spec?.rules ?? [];
        // A rune the reaction engine resolves can be switched off like one
        // made of rules: the engine skips runes listed in runeOff.
        const automatable = specRules.length > 0 || spec?.engine === true;
        const autoOn = !d.runeOff.includes(slug);
        const over = i >= slots;
        // Under ABP the system drops every item bonus that comes from gear,
        // so a rune made only of those does nothing there. What the engine
        // does for a rune is not an item bonus, so that alone never silences
        // it - but the "Disallow Property Runes" variant removes the runes
        // themselves, and then nothing of any rune applies.
        const abpDropped = abp ? specRules.filter(abpSuppresses).length : 0;
        let cls = spec?.cls ?? "manual";
        if (automatable && (!autoOn || over)) cls = "off";
        else if (automatable && abpNoRunes) cls = "abp";
        else if (specRules.length && abpDropped === specRules.length && !spec?.engine) cls = "abp";
        // The badge already says how much is automated; the summary keeps the
        // rest of the sentence.
        let summary = spec ? (es ? spec.es : spec.en).replace(AUTO_PREFIX, "") : "";
        summary = summary.charAt(0).toUpperCase() + summary.slice(1);
        if (cls !== "off" && cls !== "abp" && abpDropped) summary += ` ${i18n("ArmRuneAbpPartial")}`;
        return {
          slug,
          label: labelFor(armorRuneRecord(), slug),
          level: infos[i]?.level ?? null,
          price: infos[i]?.price ?? null,
          descHTML: infos[i]?.descHTML ?? null,
          over,
          selected: slug === this.selectedRune,
          autoCls: cls,
          autoLabel: i18n(`ArmRuneAuto_${cls}`),
          autoSummary: summary,
          summaryDim: cls === "off" || cls === "abp",
          // A rune that is a choice never acts on its own: the engine posts a
          // Use button for the wearer instead. Only said while it can act.
          asks: !!spec?.ask && cls !== "off" && cls !== "abp",
          automatable,
          autoOn
        };
      });
    } else {
      preview.push(`${i18n("ArmPreviewAC")} +${d.acBonus} (${i18n("ShRaisedNote")})`);
      preview.push(`${i18n("ShHardness")} ${d.hardness}`);
      preview.push(`${i18n("ShHp")} ${d.hpMax} (${i18n("ShBT")} ${Math.floor(d.hpMax / 2)})`);
      if (d.speedPenalty < 0) preview.push(`${d.speedPenalty} ${i18n("ArmPreviewFeet")}`);
      // A reinforcing rune or a precious material changes the effective
      // Hardness and HP (a material even replaces the base values), so the
      // values the system actually uses are shown whenever they differ.
      const sys = this.item.system ?? {};
      const src = this.item._source.system ?? {};
      if (sys.hardness !== src.hardness || sys.hp?.max !== src.hp?.max) {
        notes.push(`${i18n("ShEffective")}: ${i18n("ShHardness")} ${sys.hardness} · ${i18n("ShHp")} ${sys.hp?.max} (${i18n("ShBT")} ${sys.hp?.brokenThreshold})`);
      }
      if (src.material?.type && src.material?.grade) notes.push(i18n("ShMaterialHint"));
    }
    for (const def of d.defenses) preview.push(defenseText(def));
    const choices = await condChoices();
    this._condChoices = acondChoices(choices);
    const acondsIndexed = d.conds.map((c, i) => ({
      ...c,
      index: i,
      isMod: c.effect === "mod",
      isResist: c.effect === "resist",
      isHeal: c.effect === "healTurn",
      isTemp: c.effect === "tempTurn",
      ...ACOND_LOOK[c.effect],
      modAgainstApplies: AGAINST_TARGETS.includes(c.mod.target),
      defIsImmunity: c.def.kind === "immunity",
      defTypeOptions: iwrOptions(c.def.kind),
      defExceptOptions: [{ value: "", label: "\u2014" }, ...iwrOptions(c.def.kind)],
      tempMode: tempMode(c.temp),
      tempShowValue: c.temp.scale === "fixed",
      criteria: c.criteria.map((crit, j) => ({
        ...this.critView(crit, j),
        condIndex: i,
        inert: acritInert(c, crit)
      }))
    }));
    // The attacker criterion needs no inert warning on a reaction: the engine
    // holds the attacker when the reaction resolves.
    const reactsIndexed = d.reacts.map((r, i) => ({
      ...r,
      index: i,
      ...REACT_LOOK[r.effect],
      isDamage: r.effect === "damage",
      isCond: r.effect === "condition",
      isTemp: r.effect === "tempHp",
      // Damage only ever goes to the attacker and temporary HP to the
      // wearer, so the recipient is shown, not asked (the condition's stored
      // choice waits for a switch back).
      toLocked: r.effect !== "condition",
      toLabel: i18n(`ArmReactTo_${r.effect === "damage" ? "attacker" : r.effect === "tempHp" ? "wearer" : r.to}`),
      dmgRolled: r.damage.amount !== "hardness",
      condValued: isValuedCondition(r.cond.slug),
      tempMode: tempMode(r.temp),
      tempShowValue: r.temp.scale === "fixed",
      hasSave: r.effect !== "tempHp",
      saveAuto: r.save.mode === "auto",
      saveOutOptions: (REACT_SAVE_OUTS[r.effect] ?? []).map((o) => ({ value: o, label: i18n(SAVE_OUT_LABEL[o]) })),
      // Named after the effect it belongs to: the form posted when the effect
      // select changes still holds the old effect's outcome, which must land
      // in that effect's own slot.
      saveOutField: r.effect === "condition" ? "outCond" : "outDmg",
      // A card that asks on every trigger posts a prompt for every hit.
      askEveryTime: r.ask && r.freq === "always",
      criteria: r.criteria.map((crit, j) => ({ ...this.critView(crit, j), reactIndex: i }))
    }));
    // The fortification runes' own DCs, shown under the generic field so the
    // DC the engine will use (the lowest) can be read at a glance.
    const fortRunes = isArmor
      ? d.runes.property
          .map((slug, i) => ({ slug, i }))
          .filter(({ slug }) => slug in FORT_RUNE_DC)
          .map(({ slug, i }) => ({
            text: game.i18n.format("SWE.ArmFortRune", { rune: labelFor(armorRuneRecord(), slug), dc: FORT_RUNE_DC[slug] }),
            off: abpNoRunes || d.runeOff.includes(slug) || i >= slots
          }))
      : [];
    // The runes that are the wearer's choice post their own prompts; they are
    // not cards and cannot be edited here, so they are only listed, dimmed
    // the same way when they cannot act.
    const askRunes = isArmor
      ? d.runes.property
          .map((slug, i) => ({ slug, i }))
          .filter(({ slug }) => RUNE_AUTOMATION[slug]?.ask === true)
          .map(({ slug, i }) => ({
            text: game.i18n.format("SWE.ArmAskRuneLine", {
              rune: labelFor(armorRuneRecord(), slug),
              when: i18n(`ArmRuneAskWhen_${ASK_WHEN_KEY[slug] ?? slug}`)
            }),
            off: abpNoRunes || d.runeOff.includes(slug) || i >= slots
          }))
      : [];
    const derivedGp = Number(this.item.system?.price?.value?.gp ?? 0);
    const baseGp = Number(this.item._source.system?.price?.value?.gp ?? 0);
    const priceLocked = basePriceIgnored(this.item);
    const runesGp = priceLocked ? derivedGp : Math.max(0, derivedGp - baseGp);
    const traitOpts = locRecord(this.traitRecord);
    const runeOpts = locRecord(armorRuneRecord());
    const freq = (isArmor ? ARMOR_FREQ_TRAITS : SHIELD_FREQ_TRAITS)
      .map((slug) => traitOpts.find((o) => o.value === slug))
      .filter((o) => o && !d.traits.includes(o.value));
    const skills = Object.entries(cfg.skills ?? {}).map(([k, v]) => ({
      value: `skill:${k}`,
      label: game.i18n.localize(v?.label ?? k)
    }));
    const targetOptions = [...MOD_TARGETS.map((t) => ({ value: t, label: modTargetLabel(t) })), ...skills];
    return {
      data: d,
      isArmor,
      isShield: !isArmor,
      img: this.item.img,
      // What the user typed survives a re-render until it is saved.
      totalGp: d.totalGp ?? derivedGp,
      priceLocked,
      runesGp,
      dlRune: `swe-dl-${this.id}-arune`,
      dlTrait: `swe-dl-${this.id}-atrait`,
      activeTab: this._sweTab ?? "defense",
      preview,
      notes,
      categoryOptions: locRecord(cfg.armorCategories),
      groupOptions: [{ value: "", label: "—" }, ...locRecord(cfg.armorGroups)],
      potencyOptions: [0, 1, 2, 3, 4],
      resilientOptions: [0, 1, 2, 3, 4].map((n) => ({ value: n, label: n ? i18n(`ArmResilient${n}`) : "—" })),
      reinforcingOptions: [0, 1, 2, 3, 4, 5, 6].map((n) => ({ value: n, label: n ? i18n(`ShReinf${n}`) : "—" })),
      defensesIndexed: d.defenses.map((def, i) => ({
        ...def,
        index: i,
        isImmunity: def.kind === "immunity",
        typeOptions: iwrOptions(def.kind),
        // The system validates an exception against the rule's own kind
        // (immunity exceptions against immunity types, and so on).
        exceptOptions: [{ value: "", label: "\u2014" }, ...iwrOptions(def.kind)]
      })),
      defKindOptions: DEF_KINDS.map((k) => ({ value: k, label: i18n(`ArmDefKind_${k}`) })),
      scaleOptions: DEF_SCALES.map((s) => ({ value: s, label: i18n(`ArmScale_${s}`) })),
      modsIndexed: d.mods.map((m, i) => ({
        ...m,
        index: i,
        againstApplies: AGAINST_TARGETS.includes(m.target),
        itemOnAc: m.type === "item" && m.target === "ac",
        circOnShieldAc: !isArmor && m.type === "circumstance" && m.target === "ac"
      })),
      targetOptions,
      bonusTypeOptions: BONUS_TYPES.map((t) => ({ value: t, label: i18n(`Bonus_${t}`) })),
      againstOptions: AGAINST.map((a) => ({ value: a, label: i18n(`ArmAgainst_${a}`) })),
      runesResolved,
      slots,
      acondsIndexed,
      acondEffectOptions: ACOND_EFFECTS.map((e) => ({ value: e, label: i18n(`ArmEffect_${e}`) })),
      acondFilterOptions: ACOND_FILTERS.map((f) => ({
        value: f,
        label: i18n(`ArmFilter_${f}`)
      })),
      tempModeOptions: tempModeOptions(),
      reactsIndexed,
      fortRunes,
      askRunes,
      reactTriggerOptions: REACT_TRIGGERS.filter((t) => !isArmor || !SHIELD_TRIGGERS.includes(t)).map((t) => ({
        value: t,
        label: i18n(`ArmReactTrigger_${t}`)
      })),
      reactAttackOptions: REACT_ATTACKS.map((a) => ({ value: a, label: i18n(`ArmReactAttack_${a}`) })),
      reactEffectOptions: REACT_EFFECTS.map((e) => ({ value: e, label: i18n(`ArmReactEffect_${e}`) })),
      reactToOptions: ["attacker", "wearer"].map((t) => ({ value: t, label: i18n(`ArmReactTo_${t}`) })),
      reactFreqOptions: REACT_FREQS.map((f) => ({ value: f, label: i18n(`ArmReactFreq_${f}`) })),
      reactSaveOptions: REACT_SAVES.map((s) => ({ value: s, label: labelFor(cfg.saves, s) })),
      damageTypeOptions: locRecord(cfg.damageTypes),
      conditionOptions: locRecord(cfg.conditionTypes).filter((o) => !HITCOND_EXCLUDED.has(o.value)),
      dies: DIE_SIZES,
      propCount: isArmor ? d.runes.property.length : 0,
      overLimit: isArmor && d.runes.property.length > slots,
      abp: isArmor && abpFor(this.item.actor),
      traitsResolved: d.traits.map((slug) => ({ slug, label: labelFor(this.traitRecord, slug) })),
      freqTraits: freq.slice(0, 7),
      // Ids unique per window: two editors open at once used to share one
      // datalist id, so the shield's trait search offered armor traits.
      datalists: [
        { id: `swe-dl-${this.id}-arune`, options: runeOpts },
        { id: `swe-dl-${this.id}-atrait`, options: traitOpts },
        ...["ancestry", "heritage", "class", "selfCondition", "originCondition"].map((k) => ({
          id: `swe-dl-${this.id}-${k}`,
          options: this._condChoices[k] ?? []
        })),
        { id: `swe-dl-${this.id}-feat`, options: [] }
      ]
    };
  }

  // One requirement as the conditional and reaction cards both show it.
  critView(crit, j) {
    const resolved = condLabel(this._condChoices, crit);
    return {
      ...crit,
      index: j,
      first: j === 0,
      showMin: ACOND_STATE.includes(crit.filter) && (!crit.slug || isValuedCondition(crit.slug)),
      minVal: Number(crit.min) > 0 ? crit.min : "",
      display: resolved ?? crit.slug,
      dl: `swe-dl-${this.id}-${crit.filter}`,
      unknown: !!crit.slug && !resolved
    };
  }

  // The card list a requirement field belongs to: "aconds" or "reacts".
  cardsOf(list) {
    return list === "reacts" ? this.data.reacts : this.data.conds;
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    guardClicks(this);
    const form = this.element;
    const body = form.querySelector(".swe-body");
    if (body && this._sweScrollTop) body.scrollTop = this._sweScrollTop;
    const isCritFilter = (el) => /^(?:aconds|reacts)\.\d+\.criteria\.\d+\.filter$/.test(el.name ?? "");
    const isCritTarget = (el) => /^(?:aconds|reacts)\.\d+\.criteria\.\d+\.slugInput$/.test(el.name ?? "");
    for (const el of form.querySelectorAll("select, input[type=checkbox], input[type=number]")) {
      if (el.name === "runeToAdd" || el.name === "traitToAdd") continue;
      if (isCritFilter(el)) continue;
      el.addEventListener("change", () => {
        this.syncFromForm();
        renderSoon(this);
      });
    }
    for (const el of form.querySelectorAll("input[type=text]")) {
      if (!isCritTarget(el)) continue;
      el.addEventListener("change", () => {
        this.syncFromForm();
        renderSoon(this);
      });
    }
    // The feat list is in the thousands: its datalist is filled with the top
    // matches of whatever the focused search holds, as in the weapon editor.
    const featList = form.querySelector(`#swe-dl-${this.id}-feat`);
    if (featList) {
      const fill = (q) => {
        const all = this._condChoices?.feat ?? [];
        const t = q.trim().toLowerCase();
        const hits = t.length < 2 ? [] : all.filter((o) => o.label.toLowerCase().includes(t)).slice(0, 50);
        featList.replaceChildren(...hits.map((o) => Object.assign(document.createElement("option"), { value: o.label })));
      };
      for (const el of form.querySelectorAll(`input[list="swe-dl-${this.id}-feat"]`)) {
        el.addEventListener("input", () => fill(el.value));
      }
    }
    for (const el of form.querySelectorAll("select")) {
      if (!isCritFilter(el)) continue;
      el.addEventListener("change", () => {
        const [list, ci, , j] = el.name.split(".");
        const prev = this.cardsOf(list)[Number(ci)]?.criteria?.[Number(j)]?.filter;
        this.syncFromForm();
        const crit = this.cardsOf(list)[Number(ci)]?.criteria?.[Number(j)];
        if (crit) {
          // Wearer and attacker condition criteria share one list.
          const keep = ACOND_STATE.includes(prev) && ACOND_STATE.includes(el.value);
          crit.filter = el.value;
          if (!keep) crit.slug = "";
          Object.assign(crit, normalizeACrit(crit));
        }
        renderSoon(this);
      });
    }
  }

  syncFromForm() {
    const FDE = formDataClass();
    const o = foundry.utils.expandObject(new FDE(this.element).object);
    const d = this.data;
    if (o.name !== undefined) d.name = String(o.name);
    if (o.level !== undefined) d.level = clampInt(o.level, 0, 30, 0);
    if (o.totalGp !== undefined) d.totalGp = o.totalGp === null ? "" : String(o.totalGp).trim();
    const b = o.base ?? {};
    if (d.kind === "armor") {
      if (b.category !== undefined) d.category = String(b.category);
      if (b.group !== undefined) d.group = String(b.group ?? "");
      if (b.acBonus !== undefined) d.acBonus = clampInt(b.acBonus, 0, 20, 0);
      if (b.dexCap !== undefined) d.dexCap = clampInt(b.dexCap, 0, 10, 5);
      if (b.checkPenalty !== undefined) d.checkPenalty = clampInt(b.checkPenalty, -10, 0, 0);
      if (b.speedPenalty !== undefined) d.speedPenalty = clampInt(b.speedPenalty, -30, 0, 0);
      // An emptied field means "no Strength requirement", which PF2e stores as null.
      if ("strength" in b) d.strength = b.strength === null || b.strength === "" ? "" : clampInt(b.strength, -5, 10, 0);
      if (o.runes) {
        if (o.runes.potency !== undefined) d.runes.potency = clampInt(o.runes.potency, 0, 4, 0);
        if (o.runes.resilient !== undefined) d.runes.resilient = clampInt(o.runes.resilient, 0, 4, 0);
      }
    } else {
      if (b.acBonus !== undefined) d.acBonus = clampInt(b.acBonus, 0, 10, 2);
      if (b.hardness !== undefined) d.hardness = clampInt(b.hardness, 0, 50, 0);
      if (b.hpMax !== undefined) d.hpMax = clampInt(b.hpMax, 0, 999, 0);
      if (b.speedPenalty !== undefined) d.speedPenalty = clampInt(b.speedPenalty, -30, 0, 0);
      if (o.runes?.reinforcing !== undefined) d.reinforcing = clampInt(o.runes.reinforcing, 0, 6, 0);
    }
    const byIndex = (a, c) => Number(a) - Number(c);
    if (o.defs) {
      d.defenses = Object.keys(o.defs)
        .sort(byIndex)
        .map((k) => {
          // Fields whose inputs are hidden (the value of an "= level" row, the
          // scale of an immunity) are not in the form; the previous row keeps
          // them, so toggling back does not reset them to defaults.
          const def = normalizeDefense({ ...(d.defenses[Number(k)] ?? {}), ...o.defs[k] });
          // A kind change can leave a type or exception its new list lacks.
          const valid = iwrOptions(def.kind).map((x) => x.value);
          if (!valid.includes(def.type)) def.type = valid.includes("fire") ? "fire" : (valid[0] ?? "");
          if (def.except && !valid.includes(def.except)) def.except = "";
          return def;
        });
    }
    if (o.mods) {
      d.mods = Object.keys(o.mods)
        .sort(byIndex)
        .map((k) => normalizeMod({ ...(d.mods[Number(k)] ?? {}), ...o.mods[k] }));
    }
    // Requirement rows hand back the label typed in their search; it is
    // resolved to a slug here, and a card whose rows are not in the form keeps
    // the ones it had.
    const critsFrom = (raw, prev) =>
      raw
        ? Object.keys(raw)
            .sort(byIndex)
            .map((ck) => {
              const e = raw[ck] ?? {};
              const slug = e.slugInput !== undefined ? resolveCritInput(this._condChoices, e.filter, e.slugInput) : e.slug;
              return { ...(prev?.[Number(ck)] ?? {}), filter: e.filter, slug, min: e.min };
            })
        : prev ?? [];
    if (o.aconds) {
      d.conds = Object.keys(o.aconds)
        .sort(byIndex)
        .map((k) => {
          const prev = d.conds[Number(k)] ?? {};
          const raw = o.aconds[k] ?? {};
          const c = normalizeACond({
            ...prev,
            ...raw,
            criteria: critsFrom(raw.criteria, prev.criteria),
            mod: { ...(prev.mod ?? {}), ...(raw.mod ?? {}) },
            def: { ...(prev.def ?? {}), ...(raw.def ?? {}) },
            heal: { ...(prev.heal ?? {}), ...(raw.heal ?? {}) },
            temp: tempFromForm(prev.temp, raw.temp)
          });
          const valid = iwrOptions(c.def.kind).map((x) => x.value);
          if (!valid.includes(c.def.type)) c.def.type = valid.includes("fire") ? "fire" : (valid[0] ?? "");
          if (c.def.except && !valid.includes(c.def.except)) c.def.except = "";
          return c;
        });
    }
    if (o.reacts) {
      // Payloads merge with the previous card, as in the conditionals: the
      // inputs of an effect that is not shown are not in the form.
      d.reacts = Object.keys(o.reacts)
        .sort(byIndex)
        .map((k) => {
          const prev = d.reacts[Number(k)] ?? {};
          const raw = o.reacts[k] ?? {};
          return normalizeReact(
            {
              ...prev,
              ...raw,
              criteria: critsFrom(raw.criteria, prev.criteria),
              damage: { ...(prev.damage ?? {}), ...(raw.damage ?? {}) },
              cond: { ...(prev.cond ?? {}), ...(raw.cond ?? {}) },
              temp: tempFromForm(prev.temp, raw.temp),
              save: { ...(prev.save ?? {}), ...(raw.save ?? {}) }
            },
            d.kind
          );
        });
    }
    if (o.fort && d.kind === "armor") d.fort = normalizeFort({ ...d.fort, ...o.fort });
    if (o.runeOn && d.kind === "armor") {
      d.runeOff = Object.entries(o.runeOn)
        .filter(([, v]) => v === false)
        .map(([k]) => k);
    }
    d.freeMode = !!o.freeMode;
  }

  static actAddACond() {
    this.syncFromForm();
    this.data.conds.push(normalizeACond({ effect: "mod", criteria: [{ filter: "ancestry", slug: "" }] }));
    this.render();
  }

  static actRemoveACond(event, target) {
    this.syncFromForm();
    const idx = Number(target?.dataset?.index);
    this.data.conds = this.data.conds.filter((x, i) => i !== idx);
    this.render();
  }

  static actAddACrit(event, target) {
    this.syncFromForm();
    const ci = Number(target?.dataset?.cond);
    this.data.conds[ci]?.criteria.push(normalizeACrit({ filter: "ancestry", slug: "" }));
    this.render();
  }

  static actRemoveACrit(event, target) {
    this.syncFromForm();
    const ci = Number(target?.dataset?.cond);
    const idx = Number(target?.dataset?.index);
    const cond = this.data.conds[ci];
    if (!cond) return;
    // A conditional with no criteria would apply to everyone; removing the
    // last one deletes the card instead, as in the weapon editor.
    if (cond.criteria.length <= 1) this.data.conds = this.data.conds.filter((x, i) => i !== ci);
    else cond.criteria = cond.criteria.filter((x, j) => j !== idx);
    this.render();
  }

  // The id is minted once, when the card is added, and then travels with it
  // (a hidden field): the engine's frequency stamps are keyed by it.
  static actAddReact() {
    this.syncFromForm();
    this.data.reacts.push(
      normalizeReact(
        {
          id: foundry.utils.randomID(8),
          trigger: "hit",
          attack: "melee",
          effect: "damage",
          damage: { value: 1, die: "d6", bonus: 0, type: "piercing", amount: "roll" },
          cond: { slug: "frightened", value: 1 },
          temp: { value: 5, die: "", scale: "fixed" },
          save: { type: "", dc: 15, mode: "fixed", out: "half" },
          freq: "always"
        },
        this.data.kind
      )
    );
    renderSoon(this);
  }

  static actRemoveReact(event, target) {
    this.syncFromForm();
    const idx = Number(target?.dataset?.index);
    this.data.reacts = this.data.reacts.filter((x, i) => i !== idx);
    renderSoon(this);
  }

  static actAddRCrit(event, target) {
    this.syncFromForm();
    const ri = Number(target?.dataset?.react);
    this.data.reacts[ri]?.criteria.push(normalizeACrit({ filter: "ancestry", slug: "" }));
    renderSoon(this);
  }

  // Unlike a conditional, a reaction with no requirements is meaningful (it
  // always fires), so removing the last one keeps the card.
  static actRemoveRCrit(event, target) {
    this.syncFromForm();
    const ri = Number(target?.dataset?.react);
    const idx = Number(target?.dataset?.index);
    const react = this.data.reacts[ri];
    if (react) react.criteria = react.criteria.filter((x, j) => j !== idx);
    renderSoon(this);
  }

  static actTab(event, target) {
    this.syncFromForm();
    this._sweTab = target?.dataset?.tab ?? "defense";
    this.render();
  }

  static actRevert() {
    this.data = SimpleArmorEditor.extract(this.item);
    this.render();
    ui.notifications.info(i18n("Reverted"));
  }

  static actAddDefense() {
    this.syncFromForm();
    this.data.defenses.push(normalizeDefense({ kind: "resistance", type: "fire", value: 5 }));
    this.render();
  }

  static actRemoveDefense(event, target) {
    this.syncFromForm();
    const idx = Number(target?.dataset?.index);
    this.data.defenses = this.data.defenses.filter((x, i) => i !== idx);
    this.render();
  }

  static actAddMod() {
    this.syncFromForm();
    this.data.mods.push(normalizeMod({ target: "ac", type: "circumstance", value: 1 }));
    this.render();
  }

  static actRemoveMod(event, target) {
    this.syncFromForm();
    const idx = Number(target?.dataset?.index);
    this.data.mods = this.data.mods.filter((x, i) => i !== idx);
    this.render();
  }

  static actAddRune() {
    this.syncFromForm();
    const input = this.element.querySelector('[name="runeToAdd"]');
    const opts = locRecord(armorRuneRecord());
    const slug = resolveLabel(opts, input?.value);
    if (!slug || !opts.some((x) => x.value === slug)) {
      if (input?.value) ui.notifications.warn(i18n("PickRune"));
      this.render();
      return;
    }
    if (!this.data.runes.property.includes(slug)) {
      this.data.runes.property.push(slug);
      this.selectedRune = slug;
    }
    this.render();
  }

  static actShowRune(event, target) {
    this.syncFromForm();
    const slug = target?.dataset?.slug ?? null;
    this.selectedRune = this.selectedRune === slug ? null : slug;
    this.render();
  }

  static actRemoveRune(event, target) {
    this.syncFromForm();
    const slug = target?.dataset?.slug;
    this.data.runes.property = this.data.runes.property.filter((r) => r !== slug);
    this.render();
  }

  static actAddTrait() {
    this.syncFromForm();
    const input = this.element.querySelector('[name="traitToAdd"]');
    const slug = resolveLabel(locRecord(this.traitRecord), input?.value);
    if (slug && !this.data.traits.includes(slug)) {
      this.data.traits.push(slug);
      this.data.traits.sort();
    }
    this.render();
  }

  static actQuickTrait(event, target) {
    this.syncFromForm();
    const slug = target?.dataset?.slug;
    if (slug && !this.data.traits.includes(slug)) {
      this.data.traits.push(slug);
      this.data.traits.sort();
    }
    this.render();
  }

  static actRemoveTrait(event, target) {
    this.syncFromForm();
    const slug = target?.dataset?.slug;
    this.data.traits = this.data.traits.filter((t) => t !== slug);
    this.render();
  }

  static async onSubmit() {
    this.syncFromForm();
    const d = this.data;
    const src = this.item._source.system ?? {};
    if (d.kind === "armor") {
      const slots = armorPropertySlots(this.item, d.runes.potency);
      if (d.runes.property.length > slots && !d.freeMode) {
        ui.notifications.warn(i18n("OverLimitBlocked"));
        return;
      }
    }
    const keep = (src.rules ?? []).filter((r) => !isDefenseRule(r));
    const toggles = toggleStates(src.rules ?? [], readDefense(this.item).toggles);
    const conds = d.conds
      .map((c) => ({ ...c, criteria: c.criteria.filter((k) => k.slug) }))
      .filter((c) => c.criteria.length);
    if (conds.length < d.conds.length) ui.notifications.warn(`${i18n("CondNoTarget")} (${d.conds.length - conds.length})`);
    d.conds = conds;
    // A reaction keeps its card when an empty requirement is dropped, so the
    // warning says the card now fires with fewer requirements than shown.
    let droppedReqs = 0;
    const seenIds = new Set();
    const reacts = d.reacts.map((r) => {
      const criteria = r.criteria.filter((k) => k.slug);
      droppedReqs += r.criteria.length - criteria.length;
      // Two cards sharing an id would share one frequency stamp.
      let id = r.id;
      while (!id || seenIds.has(id)) id = foundry.utils.randomID(8);
      seenIds.add(id);
      return { ...r, id, criteria };
    });
    if (droppedReqs) ui.notifications.warn(`${i18n("ArmReactReqDropped")} (${droppedReqs})`);
    d.reacts = reacts;
    const fort = normalizeFort(d.kind === "armor" ? d.fort : null);
    const update = {
      // The displayed name can be generated ("+1 Breastplate") or mystified;
      // an emptied field falls back to the stored one, not the displayed one.
      name: String(d.name ?? "").trim() || this.item._source.name,
      "system.level.value": d.level,
      "system.traits.value": [...d.traits],
      "system.speedPenalty": d.speedPenalty,
      "system.acBonus": d.acBonus,
      "system.rules": [...keep, ...withToggleState(defenseRules(d, this.item.id), toggles)],
      [`flags.${MODULE_ID}.${DEF_FLAG}`]: {
        defenses: d.defenses,
        mods: d.mods,
        conds: d.conds,
        reacts: d.reacts,
        fort,
        runeOff: d.runeOff,
        toggles
      }
    };
    if (d.kind === "armor") {
      Object.assign(update, {
        "system.category": d.category,
        "system.group": d.group || null,
        "system.dexCap": d.dexCap,
        "system.checkPenalty": d.checkPenalty,
        "system.strength": d.strength === "" ? null : Number(d.strength),
        "system.runes.potency": d.runes.potency,
        "system.runes.resilient": d.runes.resilient,
        "system.runes.property": [...d.runes.property]
      });
    } else {
      // Current HP is left to the system: its update hook re-derives it from
      // the change in the effective maximum (runes, caps and material
      // included), the same way the native sheet does.
      Object.assign(update, {
        "system.hardness": d.hardness,
        "system.hp.max": d.hpMax,
        "system.runes.reinforcing": d.reinforcing
      });
    }
    // The price is only written when the user changed it, and only when the
    // system actually uses a base price: rewriting the displayed total on every
    // save halved a shoddy item's price each time.
    const derivedGp = Number(this.item.system?.price?.value?.gp ?? 0);
    if (d.totalGp !== undefined && !basePriceIgnored(this.item) && String(d.totalGp) !== String(derivedGp)) {
      const baseGp = Number(src.price?.value?.gp ?? 0);
      const runesGp = Math.max(0, derivedGp - baseGp);
      if (d.totalGp === "") {
        update["system.price.value.gp"] = 0;
      } else {
        const total = Number(d.totalGp);
        if (Number.isFinite(total)) {
          if (total < runesGp) ui.notifications.warn(`${i18n("PriceFloor")}: ${runesGp} gp`);
          update["system.price.value.gp"] = Math.max(0, Math.round(total - runesGp));
        }
      }
    }
    try {
      await this.item.update(update);
      d.totalGp = undefined;
      ui.notifications.info(i18n("ArmSaved"));
      this.render();
    } catch (err) {
      console.error(`${MODULE_ID} | armor save failed`, err);
      ui.notifications.error(`${i18n("SaveFailed")}: ${err.message}`);
    }
  }
}

/* ------------------------------------------------------------------ hooks */

// Keyed apart from the weapon button, so each editor's button is added once
// per sheet even though both render hooks fire.
function injectArmorButton(sheet) {
  injectSheetButton(sheet, {
    key: `${MODULE_ID}:armor`,
    match: (item) => item.type === "armor" || item.type === "shield",
    canShow: canEdit,
    cssClass: "swe-open",
    icon: "fa-solid fa-shield-halved",
    label: () => i18n("Open"),
    title: (item) => i18n(item.type === "shield" ? "ShTitle" : "ArmTitle"),
    onClick: (item) => SimpleArmorEditor.open(item),
    logPrefix: `${MODULE_ID} | armor header button`
  });
}

Hooks.on("renderItemSheet", (app) => injectArmorButton(app));
Hooks.on("renderItemSheetPF2e", (app) => injectArmorButton(app));

// Fields changed elsewhere (the PF2e sheet, another GM) replace the editor's
// copy, so a later save does not write stale values back; everything else
// keeps whatever the user has typed and not saved yet.
const EXTERNAL_FIELDS = [
  ["name", ["name"]],
  ["system.level", ["level"]],
  ["system.traits", ["traits"]],
  ["system.category", ["category"]],
  ["system.group", ["group"]],
  ["system.acBonus", ["acBonus"]],
  ["system.dexCap", ["dexCap"]],
  ["system.checkPenalty", ["checkPenalty"]],
  ["system.speedPenalty", ["speedPenalty"]],
  ["system.strength", ["strength"]],
  ["system.hardness", ["hardness"]],
  ["system.hp.max", ["hpMax"]],
  ["system.runes", ["runes", "reinforcing"]],
  [`flags.${MODULE_ID}.${DEF_FLAG}`, ["defenses", "mods", "conds", "reacts", "fort", "runeOff"]]
];

// The reaction engine's frequency stamps, in any of the forms an update can
// carry them (a value, a deletion of one stamp, or of the whole flag).
const USES_PATH = `flags.${MODULE_ID}.${USES_FLAG}`;
const USES_WHOLE = [USES_PATH, `flags.${MODULE_ID}.-=${USES_FLAG}`, `flags.${MODULE_ID}.==${USES_FLAG}`];
function isUsesKey(k) {
  return USES_WHOLE.includes(k) || k.startsWith(`${USES_PATH}.`);
}

Hooks.on("updateItem", (doc, changes) => {
  const app = SimpleArmorEditor.instances.get(doc.uuid ?? doc.id);
  if (!app?.rendered) return;
  const keys = Object.keys(foundry.utils.flattenObject(changes ?? {})).filter(
    (k) => k !== "_id" && !k.startsWith("_stats")
  );
  // A player flipping a rune toggle (Energy Adaptive's type, Winged) rewrites
  // system.rules, which the editor never shows; re-rendering for it threw
  // away whatever the GM had typed and not saved yet. The engine stamping a
  // reaction's use mid-combat is just as invisible to the editor.
  if (keys.every((k) => k === "system.rules" || k.startsWith("system.rules.") || isUsesKey(k))) return;
  app.syncFromForm();
  const touched = (p) => keys.some((k) => k === p || k.startsWith(`${p}.`) || p.startsWith(`${k}.`));
  const fresh = SimpleArmorEditor.extract(doc);
  for (const [path, fields] of EXTERNAL_FIELDS) {
    if (!touched(path)) continue;
    for (const f of fields) if (f in fresh) app.data[f] = foundry.utils.deepClone(fresh[f]);
  }
  if (touched("system.price")) app.data.totalGp = undefined;
  renderSoon(app);
});

Hooks.once("ready", () => {
  const mod = game.modules.get(MODULE_ID);
  if (mod?.api) mod.api.openDefense = (item) => SimpleArmorEditor.open(item);
});

// Turn-start healing from armor and shield conditionals, mirroring the weapon
// engine: active GM only, one combined real roll, nothing when already at
// full health. Gear must be equipped and, when investable, invested - the same
// requirement the system puts on the item's rule elements.
async function runArmorHealing(actor) {
  if (!isSoleExecutor()) return;
  if (!actor?.system?.attributes?.hp) return;
  const entries = [];
  for (const item of actor.items ?? []) {
    if (item.type !== "armor" && item.type !== "shield") continue;
    if (!isGearActive(item)) continue;
    for (const c of readDefense(item).conds) {
      if (c.effect !== "healTurn") continue;
      if (c.criteria.every((k) => armorMatchesCrit(actor, k))) entries.push({ item, c });
    }
  }
  if (!entries.length) return;
  try {
    const formula = entries.map(({ c }) => (c.heal.die ? `${c.heal.value}${c.heal.die}` : `${c.heal.value}`)).join(" + ");
    const names = [...new Set(entries.map(({ item, c }) => c.src || item.name))];
    // Queued with the weapon engine's heal for the same turn start, so the
    // full-health check sees whichever heal landed first.
    await rollHealing(actor, formula, `${i18n("ArmHealTurn")} \u00b7 ${names.join(" \u00b7 ")}`);
  } catch (err) {
    console.error(`${MODULE_ID} | armor healing failed`, err);
  }
}

Hooks.on("pf2e.startTurn", (combatant) => {
  const actor = combatant?.actor;
  if (actor) runArmorHealing(actor);
});

// Shared with the reaction engine (scripts/armor-engine.js), which reads the
// cards this editor writes instead of parsing the flag on its own.
export {
  DEF_FLAG,
  USES_FLAG,
  FORT_RUNE_DC,
  readDefense,
  normalizeReact,
  armorMatchesCrit,
  isGearActive,
  activeRunesOf
};
