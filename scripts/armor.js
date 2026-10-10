import {
  MODULE_ID,
  i18n,
  clampInt,
  locRecord,
  labelFor,
  resolveLabel,
  canEdit,
  BONUS_TYPES
} from "./main.js";

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
const DEF_SLUG = "swe-a-";
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

function isTruthy(v) {
  return v === true || v === "true" || v === "on";
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
    mods: (Array.isArray(raw.mods) ? raw.mods : []).map(normalizeMod)
  };
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
  return rules;
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

let _equipIndex = null;
async function equipmentIndex() {
  if (!_equipIndex) {
    _equipIndex = (async () => {
      const pack = game.packs.get("pf2e.equipment-srd");
      if (!pack) return [];
      return pack.getIndex({ fields: ["system.slug", "type"] });
    })();
  }
  return _equipIndex;
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
        const TE = foundry.applications.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
        info.descHTML = await TE.enrichHTML(desc, { async: true });
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
      sweRemoveTrait: SimpleArmorEditor.actRemoveTrait
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
      runesResolved = d.runes.property.map((slug, i) => ({
        slug,
        label: labelFor(armorRuneRecord(), slug),
        level: infos[i]?.level ?? null,
        price: infos[i]?.price ?? null,
        descHTML: infos[i]?.descHTML ?? null,
        over: i >= slots,
        selected: slug === this.selectedRune
      }));
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
      propCount: isArmor ? d.runes.property.length : 0,
      overLimit: isArmor && d.runes.property.length > slots,
      abp: isArmor && abpFor(this.item.actor),
      traitsResolved: d.traits.map((slug) => ({ slug, label: labelFor(this.traitRecord, slug) })),
      freqTraits: freq.slice(0, 7),
      // Ids unique per window: two editors open at once used to share one
      // datalist id, so the shield's trait search offered armor traits.
      datalists: [
        { id: `swe-dl-${this.id}-arune`, options: runeOpts },
        { id: `swe-dl-${this.id}-atrait`, options: traitOpts }
      ]
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const form = this.element;
    const body = form.querySelector(".swe-body");
    if (body && this._sweScrollTop) body.scrollTop = this._sweScrollTop;
    for (const el of form.querySelectorAll("select, input[type=checkbox], input[type=number]")) {
      if (el.name === "runeToAdd" || el.name === "traitToAdd") continue;
      el.addEventListener("change", () => {
        this.syncFromForm();
        this.render();
      });
    }
  }

  syncFromForm() {
    const FDE = foundry.applications.ux?.FormDataExtended ?? globalThis.FormDataExtended;
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
    d.freeMode = !!o.freeMode;
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
    const update = {
      // The displayed name can be generated ("+1 Breastplate") or mystified;
      // an emptied field falls back to the stored one, not the displayed one.
      name: String(d.name ?? "").trim() || this.item._source.name,
      "system.level.value": d.level,
      "system.traits.value": [...d.traits],
      "system.speedPenalty": d.speedPenalty,
      "system.acBonus": d.acBonus,
      "system.rules": [...keep, ...defenseRules(d, this.item.id)],
      [`flags.${MODULE_ID}.${DEF_FLAG}`]: { defenses: d.defenses, mods: d.mods }
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

function injectArmorButton(sheet) {
  try {
    const item = sheet.item ?? sheet.document;
    if (!item || (item.type !== "armor" && item.type !== "shield")) return;
    if (item.pack) return;
    if (!canEdit(item)) return;
    const el = sheet.element instanceof HTMLElement ? sheet.element : sheet.element?.[0];
    const header = el?.querySelector(".window-header");
    if (!header || header.querySelector(".swe-open")) return;
    const btn = document.createElement("a");
    btn.className = "swe-open";
    btn.innerHTML = `<i class="fa-solid fa-shield-halved"></i><span>${i18n("Open")}</span>`;
    btn.setAttribute("role", "button");
    btn.title = i18n(item.type === "shield" ? "ShTitle" : "ArmTitle");
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      SimpleArmorEditor.open(item);
    });
    const closeBtn = header.querySelector('[data-action="close"], .header-button.close, .close');
    header.insertBefore(btn, closeBtn ?? null);
  } catch (err) {
    console.error(`${MODULE_ID} | armor header button`, err);
  }
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
  [`flags.${MODULE_ID}.${DEF_FLAG}`, ["defenses", "mods"]]
];

Hooks.on("updateItem", (doc, changes) => {
  const app = SimpleArmorEditor.instances.get(doc.uuid ?? doc.id);
  if (!app?.rendered) return;
  app.syncFromForm();
  const keys = Object.keys(foundry.utils.flattenObject(changes ?? {}));
  const touched = (p) => keys.some((k) => k === p || k.startsWith(`${p}.`) || p.startsWith(`${k}.`));
  const fresh = SimpleArmorEditor.extract(doc);
  for (const [path, fields] of EXTERNAL_FIELDS) {
    if (!touched(path)) continue;
    for (const f of fields) if (f in fresh) app.data[f] = foundry.utils.deepClone(fresh[f]);
  }
  if (touched("system.price")) app.data.totalGp = undefined;
  app.render();
});

Hooks.once("ready", () => {
  const mod = game.modules.get(MODULE_ID);
  if (mod?.api) mod.api.openDefense = (item) => SimpleArmorEditor.open(item);
});
