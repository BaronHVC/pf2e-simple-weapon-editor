const MODULE_ID = "pf2e-simple-weapon-editor";
const DIES = ["d4", "d6", "d8", "d10", "d12"];
const SWE_MARK = "SWE:";
const SWE_PERS = "SWE:P:";
const SWE_COND = "SWE:C:";
// Conditional rules are marked by slug rather than by a label prefix, so the
// label can stay clean in the damage panel. Their data lives in the flag, so
// nothing is lost by not encoding it in the label. SWE_COND is still recognised
// when reading, for weapons saved before this change.
const SWE_COND_SLUG = "swe-cond";

// Conditionals: "if the wielder is X, then Y".
// "map" is not an item criterion like the others: it is per-attack state
// (the wielder already attacked this turn). Its slug is the fixed sentinel
// "map" and it matches through roll options, never through actor items.
const COND_FILTERS = ["ancestry", "heritage", "class", "feat", "map", "selfCondition", "targetCondition"];
// Condition criteria test what the wielder or the target is suffering right
// now (frightened, clumsy...). Both strike rolls publish them as
// self:condition:<slug>[:<value>] and target:condition:<slug>[:<value>]
// (verified on attack AND damage messages), so unlike MAP they work in native
// rule predicates, thresholds included via gte.
const STATE_FILTERS = ["selfCondition", "targetCondition"];
const COND_EFFECTS = ["damage", "healTurn", "healHit", "attackBonus"];
// Typed so the system's own stacking applies: same-type bonuses do not stack
// with each other, untyped ones always do.
const BONUS_TYPES = ["circumstance", "status", "item", "untyped"];
const COND_FLAG = "conditionals";
const HITCOND_FLAG = "hitConds";
const COND_DONE_FLAG = "healed";
const SAVES_DONE_FLAG = "savesDone";

// PF2e is not uniform here: ancestry sets `self:ancestry:<slug>`, class sets
// `class:<slug>` with no `self:` prefix at all, and heritage sets the bare form
// plus a `self:` alias the system marks as transitional. Matching only one shape
// silently never fires, so every conditional tests both and the same helper
// feeds the rule predicates and the runtime fallback.
function critRollOptions(crit) {
  // The attack roll publishes map:increases:1 or :2 once the wielder is past
  // their first attack (verified live); either shape means "suffering MAP".
  if (crit.filter === "map") return ["map:increases:1", "map:increases:2"];
  if (STATE_FILTERS.includes(crit.filter)) return [`${statePrefix(crit)}:condition:${crit.slug}`];
  // A feat and a feature are both stored as feat items but announce themselves
  // under different prefixes, so a criterion pointing at either has to test both.
  const bases = crit.filter === "feat" ? ["feat", "feature"] : [crit.filter];
  const opts = bases.flatMap((b) => [`${b}:${crit.slug}`, `self:${b}:${crit.slug}`]);
  // An adopted ancestry never reaches the actor's roll options: the system only
  // records it in details.ancestry (verified against this world's own Adopted
  // Ancestry feat and the ancestry document source, which derives no option
  // from countsAs). The weapon publishes it as swe-adopted:<slug> through the
  // helper rule emitted on save, and ancestry criteria accept that shape too.
  if (crit.filter === "ancestry") opts.push(`swe-adopted:${crit.slug}`);
  return opts;
}

// Entries of a PF2e predicate are ANDed, so one {or:[...]} per criterion reads
// as "every criterion holds, each in whichever shape the system happens to use".
function condPredicate(c) {
  return c.criteria.map(critPredicateTerm);
}

function statePrefix(crit) {
  return crit.filter === "targetCondition" ? "target" : "self";
}

// A minimum value turns the plain option test into the predicate's numeric
// form: valued conditions publish <prefix>:condition:<slug>:<n>, which gte
// compares (verified: frightened 2 passed a >=2 rule and failed a >=3 one).
function critPredicateTerm(crit) {
  if (STATE_FILTERS.includes(crit.filter) && Number(crit.min) > 1) {
    return { gte: [`${statePrefix(crit)}:condition:${crit.slug}`, Number(crit.min)] };
  }
  return { or: critRollOptions(crit) };
}

// Highest value among a set of condition roll options, 1 for valueless ones.
function stateValueFromOptions(rollOpts, base) {
  if (!rollOpts.includes(base)) return 0;
  const vals = rollOpts
    .filter((o) => String(o).startsWith(`${base}:`))
    .map((o) => Number(String(o).slice(base.length + 1)))
    .filter(Number.isFinite);
  return vals.length ? Math.max(...vals) : 1;
}

// Rule elements are evaluated by PF2e itself. Our healing hooks are not, so they
// read the wielder's ancestry/heritage/class directly and only fall back to roll
// options when the actor does not expose them (NPCs, synthetic actors).
function actorMatchesCrit(actor, crit, rollOpts = []) {
  if (!actor || !crit?.slug || !COND_FILTERS.includes(crit.filter)) return false;
  // MAP is not a property of the actor: only the triggering roll knows it.
  // With no roll in hand (start of turn, sheet checks) it simply never holds.
  if (crit.filter === "map") {
    // A FIRST attack also publishes map:increases:0 (caught live), so the
    // option existing is not enough: only a positive count means MAP.
    return rollOpts.some((o) => {
      const s = String(o);
      return s.startsWith("map:increases:") && Number(s.split(":")[2]) > 0;
    });
  }
  if (STATE_FILTERS.includes(crit.filter)) {
    const min = Math.max(1, Number(crit.min) || 1);
    const base = `${statePrefix(crit)}:condition:${crit.slug}`;
    if (crit.filter === "targetCondition") {
      // There is no target outside a roll, so only the roll can answer.
      return stateValueFromOptions(rollOpts.map(String), base) >= min;
    }
    // The wielder's own conditions are read off the actor, so start-of-turn
    // healing can test them too; the roll's options are the fallback.
    const vals = (actor.itemTypes?.condition ?? [])
      .filter((c) => c.slug === crit.slug)
      .map((c) => Number(c.value) || 1);
    if (vals.length) return Math.max(...vals) >= min;
    return stateValueFromOptions(rollOpts.map(String), base) >= min;
  }
  if (crit.filter === "feat") {
    const feats = actor.itemTypes?.feat ?? [];
    if (feats.some((f) => (f.slug || slugOf(f.name)) === crit.slug)) return true;
  } else if (crit.filter === "ancestry") {
    // countsAs is the system's own "treat the actor as this ancestry" list: it
    // starts with the real ancestry and feats like Adopted Ancestry append to
    // it, so matching it covers adoption without caring how it was obtained.
    const det = actor.system?.details?.ancestry;
    if (actor.ancestry?.slug === crit.slug) return true;
    if (det?.adopted === crit.slug) return true;
    if (Array.isArray(det?.countsAs) && det.countsAs.includes(crit.slug)) return true;
  } else {
    const direct = { heritage: actor.heritage?.slug, class: actor.class?.slug }[crit.filter];
    if (direct === crit.slug) return true;
  }
  try {
    const opts = actor.getRollOptions?.() ?? [];
    return critRollOptions(crit).some((o) => opts.includes(o));
  } catch {
    return false;
  }
}

// Several criteria on one conditional are an AND, matching the predicate the
// rule elements get so both paths agree on what "this applies" means.
function actorMatchesCond(actor, c, rollOpts = []) {
  const crits = c?.criteria ?? [];
  if (!crits.length) return false;
  return crits.every((crit) => actorMatchesCrit(actor, crit, rollOpts));
}

// Damage and healing carry different payloads; keeping one flat shape meant a
// healing entry dragged a meaningless damage type around. Discriminate on effect.
function normalizeCrit(crit) {
  const filter = COND_FILTERS.includes(crit?.filter) ? crit.filter : "ancestry";
  const out = {
    filter,
    slug: filter === "map" ? "map" : String(crit?.slug ?? "").trim()
  };
  // 0 means "any value": just having the condition is enough.
  if (STATE_FILTERS.includes(filter)) out.min = clampInt(crit?.min, 0, 20, 0);
  return out;
}

function normalizeCond(c) {
  const effect = COND_EFFECTS.includes(c?.effect) ? c.effect : "damage";
  // Conditionals used to carry a single filter/slug pair directly; anything
  // saved back then is read as a one-criterion conditional.
  const rawCrits =
    Array.isArray(c?.criteria) && c.criteria.length
      ? c.criteria
      : [{ filter: c?.filter, slug: c?.slug }];
  const isAttack = effect === "attackBonus";
  const base = {
    criteria: rawCrits.map(normalizeCrit),
    effect,
    // An attack modifier can be a penalty, never zero; everything else is a
    // positive amount.
    value: isAttack ? clampInt(c?.value, -99, 99, 1) || 1 : clampInt(c?.value, 1, 99, 1),
    die: !isAttack && DIES.includes(c?.die) ? c.die : "",
    src: String(c?.src ?? "").trim()
  };
  if (effect === "damage") base.type = String(c?.type ?? "fire");
  if (isAttack) base.bonusType = BONUS_TYPES.includes(c?.bonusType) ? c.bonusType : "circumstance";
  return base;
}

// A damage entry can demand a save. The config rides on the entry's own rule
// as sweSave (verified: the system stores unknown keys and still applies the
// rule), and a companion Note rule renders the @Check button on damage cards.
function normalizeSave(e) {
  const type = String(e?.saveType ?? "").trim();
  if (!type) return { saveType: "", saveDc: 15, saveDcMode: "fixed", saveOut: "half" };
  return {
    saveType: type,
    saveDc: clampInt(e?.saveDc, 1, 60, 15),
    // "auto" resolves the wielder's spell-or-class DC at display time, so the
    // save follows whoever holds the weapon (verified: the system's inline
    // check accepts resolve() and classOrSpellDC falls back to class DC).
    saveDcMode: e?.saveDcMode === "auto" ? "auto" : "fixed",
    saveOut: e?.saveOut === "none" ? "none" : "half"
  };
}

// An extra marked "to choose" is asked about before every attack. Its stable
// key survives saves (it rides on the rule as swePick and in a hidden input),
// so the remembered choice keeps pointing at the same row.
function normalizePick(e) {
  return {
    pick: e?.pick === true || e?.pick === "true" || e?.pick === "on",
    pickKey: String(e?.pickKey || "") || foundry.utils.randomID(8)
  };
}

function condAmount(c) {
  return c.die ? `${c.value}${c.die}` : `${c.value}`;
}

// Conditionals live in a module flag, which is the single source of truth. The
// damage ones are additionally emitted as rule elements so PF2e computes them
// natively, but those are write-only output: they are regenerated from the flag
// on every save and never parsed back.
// Identical entries must collapse in BOTH the read and the save path. Deduping
// only on read let a duplicated row save two identical damage rules while the
// reopened editor showed a single one - the weapon dealt double until the next
// save, with nothing in the UI saying why (caught live in the sandbox).
function dedupeConds(list) {
  const seen = new Map();
  for (const c of list) seen.set(JSON.stringify(c), c);
  return [...seen.values()];
}

function readConds(item) {
  const raw = item?._source?.flags?.[MODULE_ID]?.[COND_FLAG];
  if (!Array.isArray(raw)) return [];
  const cleaned = [];
  for (const entry of raw) {
    const c = normalizeCond(entry);
    // A criterion with nothing selected would match nothing and, being ANDed,
    // would disable the whole conditional.
    c.criteria = c.criteria.filter((crit) => crit.slug);
    if (c.criteria.length) cleaned.push(c);
  }
  return dedupeConds(cleaned);
}

// Conditions applied on a hit (frightened, clumsy, quickened...) have no rule
// element home - PF2e has no "apply a condition on strike" rule - so they live
// in their own module flag, like the wielder conditionals, and the engine
// applies them when the damage is rolled. Either side can receive one, and a
// save can gate it: it then lands on a failed save, or only on a critical one.
function normalizeHitCond(h) {
  return {
    condition: String(h?.condition ?? "").trim(),
    value: clampInt(h?.value, 1, 99, 1),
    who: h?.who === "wielder" ? "wielder" : "target",
    ...normalizeSave(h),
    saveOut: h?.saveOut === "critFail" ? "critFail" : "fail"
  };
}

function readHitConds(item) {
  const raw = item?._source?.flags?.[MODULE_ID]?.[HITCOND_FLAG];
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeHitCond).filter((h) => h.condition);
}

function slugOf(name) {
  if (typeof name !== "string") return "";
  return (
    name.slugify?.({ strict: true }) ??
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  );
}

// Scanned from whatever packs the world actually has rather than hardcoded, so
// homebrew and add-on content (this world also ships Starfinder 2e ancestries)
// show up on their own. Only ever called while the editor is open.
let _condChoiceCache = null;
async function condChoices() {
  if (_condChoiceCache) return _condChoiceCache;
  // Feats and features are both stored as items of type "feat", so ancestry
  // feats, class feats and ancestry features all land in the same bucket.
  // "map" keeps an empty bucket: it is state, not something a pack can offer,
  // but the dedupe/sort loop below walks every COND_FILTERS entry.
  const out = { ancestry: [], heritage: [], class: [], feat: [], map: [], selfCondition: [], targetCondition: [] };
  // Conditions come from the system's own record, not from packs.
  const condOpts = locRecord(CONFIG.PF2E?.conditionTypes);
  out.selfCondition = [...condOpts];
  out.targetCondition = [...condOpts];
  for (const pack of game.packs ?? []) {
    if (pack.documentName !== "Item") continue;
    let index;
    try {
      index = await pack.getIndex({ fields: ["system.slug", "type"] });
    } catch (err) {
      console.warn(`${MODULE_ID} | cannot index ${pack.collection}`, err);
      continue;
    }
    for (const entry of index) {
      if (!COND_FILTERS.includes(entry.type)) continue;
      const slug = entry.system?.slug || slugOf(entry.name);
      if (!slug) continue;
      out[entry.type].push({ value: slug, label: entry.name });
    }
  }
  for (const filter of COND_FILTERS) {
    const seen = new Map();
    for (const opt of out[filter]) if (!seen.has(opt.value)) seen.set(opt.value, opt);
    out[filter] = [...seen.values()].sort((a, b) =>
      a.label.localeCompare(b.label, game.i18n.lang)
    );
  }
  _condChoiceCache = out;
  return out;
}

// A weapon can reference an ancestry from a pack that is no longer installed.
// Surfacing that as "unknown" beats showing a slug and pretending it resolves.
// One criterion as a person reads it: "target: Frightened >= 2".
function critText(choices, crit) {
  if (crit.filter === "map") return i18n("MapShort");
  const label = condLabel(choices, crit) ?? crit.slug;
  if (!STATE_FILTERS.includes(crit.filter)) return label;
  const who = i18n(crit.filter === "targetCondition" ? "WhoTarget" : "WhoSelf");
  return `${who}: ${label}${Number(crit.min) > 1 ? ` \u2265${crit.min}` : ""}`;
}

function condLabel(choices, crit) {
  if (crit.filter === "map") return i18n("MapShort");
  const hit = (choices?.[crit.filter] ?? []).find((o) => o.value === crit.slug);
  return hit ? hit.label : null;
}

// Search inputs backed by datalists hand the form a label, not a slug. An exact
// label match (accent-insensitive, for the es locale) resolves to its value;
// anything else comes back slugified so callers can flag it instead of silently
// dropping what was typed.
function resolveLabel(options, text) {
  const t = String(text ?? "").trim();
  if (!t) return "";
  const norm = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const hit = (options ?? []).find((o) => norm(o.label) === norm(t));
  return hit ? hit.value : slugOf(t);
}

function resolveCritInput(choices, filter, text) {
  return resolveLabel(choices?.[filter], text);
}

// One accent color per damage type, for the dots next to type selects and the
// colored preview segments. Physical types stay neutral on purpose.
const DMG_COLORS = {
  fire: "#d4813a", cold: "#7fb0d4", acid: "#5fbe7e", electricity: "#d8b95e",
  poison: "#9a7fc0", bleed: "#c25b5b", mental: "#c07fb0", sonic: "#7fc0b8",
  force: "#8fa0e0", vitality: "#8fd4a0", void: "#8f7fa8", spirit: "#a8c0e8", precision: "#d8c66a"
};
function dotFor(type) {
  return DMG_COLORS[type] ?? "#b8b8c2";
}

// Font Awesome glyph per damage type (Foundry ships FA solid). Anything not
// listed - homebrew types included - falls back to a generic asterisk.
const DMG_ICONS = {
  fire: "fa-fire", cold: "fa-snowflake", acid: "fa-flask", electricity: "fa-bolt",
  poison: "fa-skull-crossbones", bleed: "fa-droplet", mental: "fa-brain",
  sonic: "fa-volume-high", force: "fa-burst", vitality: "fa-sun", void: "fa-moon",
  spirit: "fa-ghost", slashing: "fa-slash", piercing: "fa-syringe",
  bludgeoning: "fa-hammer", precision: "fa-crosshairs"
};
function iconFor(type) {
  return DMG_ICONS[type] ?? "fa-asterisk";
}

// The same type color at different strengths, for tinting a card header and
// its icon badge without one CSS rule per damage type.
function tintFor(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function i18n(key) {
  return game.i18n.localize(`SWE.${key}`);
}

function locRecord(record) {
  const out = [];
  for (const [k, v] of Object.entries(record ?? {})) {
    const raw = typeof v === "string" ? v : (v?.name ?? String(k));
    let label = game.i18n.localize(raw);
    if (label === raw && raw.includes(".")) label = k;
    out.push({ value: k, label });
  }
  out.sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));
  return out;
}

// Precision is a damage CATEGORY in PF2e, not a type: it folds into the
// weapon's base damage type and precision-immune creatures ignore it (verified
// in the sandbox: a precision d8 lands inside the slashing group). The editor
// still offers it where a type would go, because that is how people think of
// it, and maps it to the category on save.
function damageTypeLabel(cfg, t) {
  return t === "precision" ? i18n("Precision") : labelFor(cfg.damageTypes, t);
}

function labelFor(record, slug) {
  const v = (record ?? {})[slug];
  if (v === undefined) return slug;
  const raw = typeof v === "string" ? v : (v?.name ?? slug);
  const label = game.i18n.localize(raw);
  return label === raw && raw.includes(".") ? slug : label;
}

let _runeRecordCache = null;
function propertyRuneRecord() {
  if (_runeRecordCache) return _runeRecordCache;
  const cfg = CONFIG.PF2E ?? {};
  let rec = cfg.weaponPropertyRunes ?? cfg.runes?.weapon?.property;
  if (rec && Object.keys(rec).length) {
    _runeRecordCache = rec;
    return rec;
  }
  const trans =
    foundry.utils.getProperty(game.i18n, "translations.PF2E.WeaponPropertyRune") ??
    foundry.utils.getProperty(game.i18n, "_fallback.PF2E.WeaponPropertyRune") ??
    {};
  const out = {};
  for (const [k, v] of Object.entries(trans)) {
    const name = v && typeof v === "object" ? (v.Name ?? k) : String(v);
    out[k] = name;
  }
  if (Object.keys(out).length) _runeRecordCache = out;
  return out;
}

const AUTO_LABEL_RE = /^\+\d+(d\d+)?\s/;

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function isCondRule(r) {
  if (typeof r?.slug === "string" && r.slug.startsWith(SWE_COND_SLUG)) return true;
  return typeof r?.label === "string" && r.label.startsWith(SWE_COND);
}

function isSweRule(r) {
  if (isCondRule(r)) return true;
  return typeof r?.label === "string" && r.label.startsWith(SWE_MARK);
}

class SimpleWeaponEditor extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  constructor(item, options = {}) {
    super(options);
    this.item = item;
    this.data = SimpleWeaponEditor.extract(item);
    this.selectedRune = null;
    this._sweTab = "damage";
  }

  static _runeIndexPromise = null;
  static instances = new Map();

  static open(item) {
    // The header button only ever appears on weapons, but the module API is
    // public: rendering the editor on anything else would let a save write
    // weapon fields onto it (found by probing the API in the sandbox).
    if (item?.type !== "weapon") {
      ui.notifications.warn(i18n("NotAWeapon"));
      return null;
    }
    const key = item.uuid ?? item.id;
    const existing = SimpleWeaponEditor.instances.get(key);
    if (existing) {
      existing.render(true);
      existing.bringToFront?.();
      existing.bringToTop?.();
      return existing;
    }
    const app = new SimpleWeaponEditor(item);
    SimpleWeaponEditor.instances.set(key, app);
    app.render(true);
    return app;
  }

  async close(options) {
    SimpleWeaponEditor.instances.delete(this.item.uuid ?? this.item.id);
    return super.close(options);
  }
  static _runeInfoCache = new Map();

  static async runeIndex() {
    if (!this._runeIndexPromise) {
      this._runeIndexPromise = (async () => {
        const pack = game.packs.get("pf2e.equipment-srd");
        if (!pack) return [];
        return await pack.getIndex({ fields: ["system.slug", "type"] });
      })();
    }
    return this._runeIndexPromise;
  }

  static async getRuneInfo(slug) {
    if (SimpleWeaponEditor._runeInfoCache.has(slug)) {
      return SimpleWeaponEditor._runeInfoCache.get(slug);
    }
    const cfg = CONFIG.PF2E ?? {};
    const runeRec = propertyRuneRecord();
    const raw = runeRec[slug];
    const info = { slug, label: labelFor(runeRec, slug), level: null, price: null, descHTML: null };
    if (raw && typeof raw === "object") {
      info.level = raw.level ?? null;
      const pr = raw.price;
      if (typeof pr === "number") info.price = pr;
      else if (pr && typeof pr === "object") info.price = pr.value?.gp ?? null;
    }
    const sluggify =
      game.pf2e?.system?.sluggify ??
      ((x) => String(x).replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase());
    const base = sluggify(slug);
    const cands = [base];
    const parts = base.split("-");
    if (["greater", "major", "true", "lesser", "moderate"].includes(parts[0]) && parts.length > 1) {
      cands.push([...parts.slice(1), parts[0]].join("-"));
    }
    try {
      const index = await SimpleWeaponEditor.runeIndex();
      const pack = game.packs.get("pf2e.equipment-srd");
      let entry = null;
      for (const c of cands) {
        entry = index.find((e) => e.system?.slug === c);
        if (entry) break;
      }
      if (entry && pack) {
        const doc = await pack.getDocument(entry._id);
        const desc = doc?.system?.description?.value ?? "";
        if (info.level === null) info.level = doc?.system?.level?.value ?? null;
        if (info.price === null) info.price = doc?.system?.price?.value?.gp ?? null;
        if (desc) {
          const TE = foundry.applications.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
          info.descHTML = await TE.enrichHTML(desc, { async: true });
          let plain = desc.replace(/<[^>]+>/g, " ");
          plain = plain
            .replace(/@UUID\[[^\]]+\]\{([^}]+)\}/g, "$1")
            .replace(/@UUID\[[^\]]+\]/g, "")
            .replace(/@Damage\[([^\[\]]+)\[([^\]]+)\]\]/g, "$1 $2")
            .replace(/@Damage\[([^\]]+)\]/g, "$1")
            .replace(/@Check\[([^\]|]+)\|dc:(\d+)[^\]]*\]/gi, "$1 DC $2")
            .replace(/@Check\[([^\]]+)\]/gi, "$1")
            .replace(/@Localize\[[^\]]+\]/g, "")
            .replace(/\s+/g, " ");
          const hit = plain.match(/additional\s+(\d+d\d+)\s+(\w+)\s+damage/i);
          if (hit) info.hit = { dice: hit[1], type: hit[2].toLowerCase() };
          const critDmg = plain.match(/(\d+d\d+)\s+persistent\s+(\w+)\s+damage[^.]*critical/i);
          if (critDmg) {
            info.crit = { dice: critDmg[1], type: critDmg[2].toLowerCase(), persistent: true };
          } else {
            const critNote = plain.match(/([^.]*critical (?:hit|success)[^.]*\.)/i);
            if (critNote) info.critNote = critNote[1].trim();
          }
        }
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | rune info`, err);
    }
    SimpleWeaponEditor._runeInfoCache.set(slug, info);
    return info;
  }

  static extract(item) {
    const src = item._source.system ?? {};
    const per = src.damage?.persistent;
    const extras = [];
    const persistents = [];
    const splashes = [];
    if (per) {
      const faces = Number(per.faces) || null;
      // The native persistent field cannot carry a save config, so the first
      // entry's lives in the module flag; rule-based entries carry their own.
      const ps = item._source.flags?.[MODULE_ID]?.persSave ?? {};
      persistents.push({
        value: per.number ?? 1,
        die: faces ? `d${faces}` : "",
        type: per.type ?? "bleed",
        ...normalizeSave({ saveType: ps.type, saveDc: ps.dc, saveDcMode: ps.mode, saveOut: ps.out })
      });
    }
    for (const r of src.rules ?? []) {
      if (!isSweRule(r)) continue;
      // Must come before the persistent check, or a conditional would be read
      // back as plain extra damage and duplicated on the next save. Conditionals
      // are rebuilt from the flag, never from these rules.
      if (isCondRule(r)) continue;
      // Companion notes are output only, regenerated from each entry's save
      // config on save; parsing them back would duplicate entries.
      if (r.key === "Note") continue;
      const isPers = r.label.startsWith(SWE_PERS);
      const bucket = isPers ? persistents : extras;
      const mark = isPers ? SWE_PERS : SWE_MARK;
      let srcLabel = r.label.slice(mark.length).trim();
      if (AUTO_LABEL_RE.test(srcLabel)) srcLabel = "";
      const isSplash = r.category === "splash" || r.damageCategory === "splash";
      const isPrecision = r.category === "precision" || r.damageCategory === "precision";
      const dest = isPers ? bucket : isSplash ? splashes : bucket;
      const save = normalizeSave({
        saveType: r.sweSave?.type,
        saveDc: r.sweSave?.dc,
        saveDcMode: r.sweSave?.mode,
        saveOut: r.sweSave?.out
      });
      const pick = normalizePick({ pick: !!r.swePick, pickKey: r.swePick });
      if (r.key === "DamageDice") {
        dest.push({
          value: r.diceNumber ?? 1,
          die: r.dieSize ?? "d6",
          type: isPrecision ? "precision" : (r.damageType ?? "fire"),
          src: srcLabel,
          ...save,
          ...pick
        });
      } else if (r.key === "FlatModifier") {
        dest.push({
          value: r.value ?? 1,
          die: "",
          type: isPrecision ? "precision" : (r.damageType ?? "fire"),
          src: srcLabel,
          ...save,
          ...pick
        });
      }
    }
    const rawDie = src.damage?.die ?? "d4";
    for (const e of [...extras, ...splashes]) {
      e.value = clampInt(e.value, 1, 99, 1);
      if (e.die && !DIES.includes(e.die)) e.die = "d6";
    }
    for (const e of persistents) {
      e.value = clampInt(e.value, 1, 99, 1);
      if (e.die && !DIES.includes(e.die)) e.die = "";
    }
    return {
      name: item._source.name,
      img: item._source.img,
      level: clampInt(src.level?.value, 0, 30, 0),
      priceGp: clampInt(src.price?.value?.gp, 0, 999999, 0),
      damage: {
        dice: clampInt(src.damage?.dice, 1, 12, 1),
        die: DIES.includes(rawDie) ? rawDie : "d4",
        damageType: src.damage?.damageType ?? "slashing"
      },
      splash: clampInt(src.splashDamage?.value, 0, 99, 0),
      extras,
      splashes,
      persistents,
      runes: {
        potency: clampInt(src.runes?.potency, 0, 4, 0),
        striking: clampInt(src.runes?.striking, 0, 3, 0),
        property: [...new Set(src.runes?.property ?? [])]
      },
      traits: [...new Set(src.traits?.value ?? [])],
      conditionals: readConds(item),
      hitConds: readHitConds(item),
      freeMode: false
    };
  }

  static DEFAULT_OPTIONS = {
    classes: ["swe-editor"],
    tag: "form",
    // Wide enough that the save controls fit without clipping, tall enough to
    // show a full tab on open; still resizable. Kept under Foundry's minimum
    // supported resolution (1366x768).
    position: { width: 920, height: 700 },
    window: { icon: "fa-solid fa-wand-magic-sparkles", resizable: true },
    form: {
      handler: SimpleWeaponEditor.onSubmit,
      submitOnChange: false,
      closeOnSubmit: false
    },
    actions: {
      sweAddDamage: SimpleWeaponEditor.actAddDamage,
      sweRemoveDamage: SimpleWeaponEditor.actRemoveDamage,
      sweAddSplash: SimpleWeaponEditor.actAddSplash,
      sweRemoveSplash: SimpleWeaponEditor.actRemoveSplash,
      sweAddPersistent: SimpleWeaponEditor.actAddPersistent,
      sweRemovePersistent: SimpleWeaponEditor.actRemovePersistent,
      sweAddHitCond: SimpleWeaponEditor.actAddHitCond,
      sweRemoveHitCond: SimpleWeaponEditor.actRemoveHitCond,
      sweAddRune: SimpleWeaponEditor.actAddRune,
      sweRemoveRune: SimpleWeaponEditor.actRemoveRune,
      sweShowRune: SimpleWeaponEditor.actShowRune,
      sweAddTrait: SimpleWeaponEditor.actAddTrait,
      sweQuickTrait: SimpleWeaponEditor.actQuickTrait,
      sweRemoveTrait: SimpleWeaponEditor.actRemoveTrait,
      sweAddCond: SimpleWeaponEditor.actAddCond,
      sweRemoveCond: SimpleWeaponEditor.actRemoveCond,
      sweAddCrit: SimpleWeaponEditor.actAddCrit,
      sweRemoveCrit: SimpleWeaponEditor.actRemoveCrit,
      sweTab: SimpleWeaponEditor.actTab,
      sweRevert: SimpleWeaponEditor.actRevert
    }
  };

  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/editor.hbs` }
  };

  get title() {
    return `${i18n("Title")}: ${this.item.name}`;
  }

  async render(options = {}, _options) {
    const body = this.element?.querySelector?.(".swe-body");
    if (body) this._sweScrollTop = body.scrollTop;
    return super.render(options, _options);
  }

  async _prepareContext() {
    const d = this.data;
    const cfg = CONFIG.PF2E ?? {};
    const striking = Number(d.runes.striking) || 0;
    const potency = Number(d.runes.potency) || 0;
    // Verified against the system by rolling: an authored dice count above 1
    // overrides striking entirely; only a 1-die weapon gets 1 + striking dice.
    const baseDice = Number(d.damage.dice) || 1;
    const totalDice = baseDice > 1 ? baseDice : 1 + striking;
    const typeLabel = labelFor(cfg.damageTypes, d.damage.damageType);
    const overLimit = d.runes.property.length > potency;
    const previewParts = [
      {
        text: `${potency > 0 ? `+${potency} ` : ""}${totalDice}${d.damage.die} ${typeLabel}`,
        color: dotFor(d.damage.damageType)
      }
    ];
    const gateMark = (e) => (e.saveType ? ` [${i18n("SaveShort")}]` : "");
    for (const e of d.extras) {
      const tl = damageTypeLabel(cfg, e.type);
      previewParts.push({
        text:
          (e.die ? ` + ${e.value}${e.die} ${tl}` : ` + ${e.value} ${tl}`) +
          gateMark(e) +
          (e.pick ? ` [${i18n("PickShort")}]` : ""),
        color: dotFor(e.type)
      });
    }
    for (const e of d.splashes) {
      const tl = labelFor(cfg.damageTypes, e.type);
      previewParts.push({
        text: ` + ${condAmount(e)} ${tl} ${i18n("Splash").toLowerCase()}` + gateMark(e),
        color: dotFor(e.type)
      });
    }
    for (const p of d.persistents) {
      const pl = labelFor(cfg.damageTypes, p.type);
      const amount = p.die ? `${p.value}${p.die}` : `${p.value}`;
      previewParts.push({
        text: ` + ${amount} ${pl} ${i18n("PersistentShort")}` + (p.saveType ? ` [${i18n("SaveShort")}]` : ""),
        color: dotFor(p.type)
      });
    }
    for (const h of d.hitConds) {
      if (!h.condition) continue;
      const who = i18n(h.who === "wielder" ? "HitWho_wielder" : "HitWho_target");
      previewParts.push({
        text: ` + ${labelFor(cfg.conditionTypes, h.condition)}${h.value > 1 ? ` ${h.value}` : ""} (${who})` + (h.saveType ? ` [${i18n("SaveShort")}]` : ""),
        color: "#c792ea"
      });
    }
    if (d.splash > 0) {
      previewParts.push({
        text: ` + ${d.splash} ${i18n("Splash").toLowerCase()}`,
        color: dotFor(d.damage.damageType)
      });
    }
    let preview = previewParts.map((x) => x.text).join("");
    const runeInfos = await Promise.all(
      d.runes.property.map((slug) => SimpleWeaponEditor.getRuneInfo(slug))
    );
    const critParts = [];
    for (const ri of runeInfos) {
      if (ri.hit) {
        preview += ` + ${ri.hit.dice} ${labelFor(cfg.damageTypes, ri.hit.type)} (${ri.label})`;
      }
      if (ri.crit) {
        critParts.push(`${ri.crit.dice} ${labelFor(cfg.damageTypes, ri.crit.type)} ${i18n("PersistentShort")} (${ri.label})`);
      } else if (ri.critNote) {
        critParts.push(`${ri.label}: ${ri.critNote}`);
      }
    }
    const critPreview = critParts.join(" · ");
    const choices = await condChoices();
    this._condChoices = choices;
    const condIndexed = d.conditionals.map((c, i) => ({
      ...c,
      index: i,
      isDamage: c.effect === "damage",
      isAttack: c.effect === "attackBonus",
      kind: c.effect === "damage" ? "damage" : c.effect === "attackBonus" ? "attack" : "heal",
      dot: dotFor(c.type),
      icon: iconFor(c.type),
      headBg: tintFor(dotFor(c.type), 0.10),
      iconBg: tintFor(dotFor(c.type), 0.16),
      iconBorder: tintFor(dotFor(c.type), 0.5),
      amount: condAmount(c),
      onlyOneCrit: c.criteria.length <= 1,
      criteria: c.criteria.map((crit, j) => {
        const resolved = condLabel(choices, crit);
        return {
          ...crit,
          index: j,
          condIndex: i,
          first: j === 0,
          isMap: crit.filter === "map",
          isState: STATE_FILTERS.includes(crit.filter),
          minVal: Number(crit.min) > 0 ? crit.min : "",
          display: resolved ?? crit.slug,
          resolved,
          unknown: crit.filter !== "map" && !!crit.slug && !resolved
        };
      })
    }));
    // The damage tab shows the complete picture: damage conditionals appear
    // there as locked rows with the reason they exist. They are edited in the
    // Conditions tab; the trash on the mirror removes the conditional itself.
    const dmgCondRows = d.conditionals
      .map((c, i) => ({ c, i }))
      .filter((x) => x.c.effect === "damage")
      .map(({ c, i }) => ({
        condIndex: i,
        amount: condAmount(c),
        typeLabel: damageTypeLabel(cfg, c.type),
        dot: dotFor(c.type),
        icon: iconFor(c.type),
        reason: c.src || c.criteria.map((cr) => critText(choices, cr)).join(" + ")
      }));
    const derivedGp = Number(this.item.system?.price?.value?.gp ?? 0);
    const baseGp = Number(this.item._source.system?.price?.value?.gp ?? 0);
    const runesGp = Math.max(0, derivedGp - baseGp);
    const traitOpts = locRecord(cfg.weaponTraits);
    const runeOpts = locRecord(propertyRuneRecord());
    // Quick-add chips for the traits tab: common picks that exist in this
    // system's record and are not already on the weapon.
    const freqTraits = ["agile", "finesse", "reach", "trip", "twin", "versatile-p", "versatile-s", "thrown-10"]
      .map((slug) => traitOpts.find((o) => o.value === slug))
      .filter((o) => o && !d.traits.includes(o.value))
      .slice(0, 6);
    return {
      data: d,
      img: this.item.img,
      totalGp: derivedGp,
      runesGp,
      dies: DIES,
      damageTypes: locRecord(cfg.damageTypes),
      damageTypesExt: [
        { value: "precision", label: i18n("Precision") },
        ...locRecord(cfg.damageTypes)
      ],
      weaponTraits: traitOpts,
      propertyRunes: runeOpts,
      potencyOptions: [0, 1, 2, 3, 4],
      strikingOptions: [
        { value: 0, label: "—" },
        { value: 1, label: i18n("Striking1") },
        { value: 2, label: i18n("Striking2") },
        { value: 3, label: i18n("Striking3") }
      ],
      extrasIndexed: d.extras.map((e, i) => ({ ...e, index: i, dot: dotFor(e.type), icon: iconFor(e.type) })),
      splashIndexed: d.splashes.map((e, i) => ({ ...e, index: i, dot: dotFor(e.type), icon: iconFor(e.type) })),
      saveOptions: [
        ...locRecord(cfg.saves),
        { value: "perception", label: game.i18n.localize("PF2E.PerceptionLabel") },
        ...Object.entries(cfg.skills ?? {}).map(([k, v]) => ({
          value: k,
          label: game.i18n.localize(v?.label ?? k)
        }))
      ],
      conditionOptions: locRecord(cfg.conditionTypes),
      hitCondsIndexed: d.hitConds.map((h, i) => ({
        ...h,
        index: i,
        label: labelFor(cfg.conditionTypes, h.condition)
      })),
      dmgCondRows,
      persIndexed: d.persistents.map((e, i) => ({ ...e, index: i, dot: dotFor(e.type), icon: iconFor(e.type) })),
      runesResolved: d.runes.property.map((slug, i) => {
        const ri = runeInfos[i] ?? {};
        return {
          slug,
          label: labelFor(propertyRuneRecord(), slug),
          level: ri.level ?? null,
          price: ri.price ?? null,
          descHTML: ri.descHTML ?? null,
          // Slots are potency: entries past that count are the ones the limit
          // warning is about, so they get marked card by card.
          over: i >= potency,
          selected: slug === this.selectedRune
        };
      }),
      traitsResolved: d.traits.map((slug) => ({
        slug,
        label: labelFor(cfg.weaponTraits, slug)
      })),
      activeTab: this._sweTab ?? "damage",
      condIndexed,
      // One shared datalist per filter type instead of options per row. The feat
      // list is in the thousands, so its datalist starts empty and is filled
      // with the top matches while the user types (see _onRender).
      datalists: [
        ...["ancestry", "heritage", "class", ...STATE_FILTERS].map((k) => ({ key: k, options: choices[k] ?? [] })),
        { key: "rune", options: runeOpts },
        { key: "trait", options: traitOpts }
      ],
      filterOptions: COND_FILTERS.map((f) => ({
        value: f,
        label: i18n(`Filter_${f}`)
      })),
      effectOptions: COND_EFFECTS.map((e) => ({
        value: e,
        label: i18n(`Effect_${e}`)
      })),
      bonusTypeOptions: BONUS_TYPES.map((t) => ({ value: t, label: i18n(`Bonus_${t}`) })),
      preview,
      previewParts,
      baseDot: dotFor(d.damage.damageType),
      baseIcon: iconFor(d.damage.damageType),
      baseNote: striking > 0 && baseDice === 1 ? `${totalDice}${d.damage.die}` : null,
      strikingIgnored: striking > 0 && baseDice > 1,
      freqTraits,
      critPreview,
      overLimit,
      potency,
      propCount: d.runes.property.length,
      selectedRune: this.selectedRune,
      runeInfo: this.selectedRune ? await SimpleWeaponEditor.getRuneInfo(this.selectedRune) : null
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const form = this.element;
    const body = form.querySelector(".swe-body");
    if (body && this._sweScrollTop) {
      body.scrollTop = this._sweScrollTop;
    }
    const isCondFilter = (el) => /^conds\.\d+\.criteria\.\d+\.filter$/.test(el.name ?? "");
    for (const el of form.querySelectorAll("select, input[type=checkbox], input[type=number]")) {
      if (el.name === "runeToAdd" || el.name === "traitToAdd") continue;
      if (isCondFilter(el)) continue;
      el.addEventListener("change", () => {
        this.syncFromForm();
        this.render();
      });
    }
    // Switching ancestry/heritage/class leaves the previously picked target
    // pointing at a list it no longer belongs to, so clear it on the way through.
    const isCritTarget = (el) => /^conds\.\d+\.criteria\.\d+\.slugInput$/.test(el.name ?? "");
    for (const el of form.querySelectorAll("input[type=text]")) {
      if (!isCritTarget(el)) continue;
      el.addEventListener("change", () => {
        this.syncFromForm();
        this.render();
      });
    }
    // The feat list is too large to render in full, so its shared datalist is
    // rebuilt with the top matches of whatever the focused input holds.
    const featList = form.querySelector("#swe-dl-feat");
    if (featList) {
      const fill = (q) => {
        const all = this._condChoices?.feat ?? [];
        const t = q.trim().toLowerCase();
        const hits =
          t.length < 2
            ? []
            : all.filter((o) => o.label.toLowerCase().includes(t)).slice(0, 50);
        featList.replaceChildren(
          ...hits.map((o) => {
            const opt = document.createElement("option");
            opt.value = o.label;
            return opt;
          })
        );
      };
      for (const el of form.querySelectorAll('input[list="swe-dl-feat"]')) {
        el.addEventListener("input", () => fill(el.value));
      }
    }
    for (const el of form.querySelectorAll("select")) {
      if (!isCondFilter(el)) continue;
      el.addEventListener("change", () => {
        const [, ci, , j] = el.name.split(".");
        this.syncFromForm();
        const crit = this.data.conditionals[Number(ci)]?.criteria?.[Number(j)];
        if (crit) {
          crit.filter = el.value;
          crit.slug = "";
        }
        this.render();
      });
    }
  }

  syncFromForm() {
    const FDE = foundry.applications.ux?.FormDataExtended ?? globalThis.FormDataExtended;
    const o = foundry.utils.expandObject(new FDE(this.element).object);
    delete o.runeToAdd;
    delete o.traitToAdd;
    const d = this.data;
    if (o.name !== undefined) d.name = String(o.name);
    if (o.level !== undefined) d.level = Number(o.level) || 0;
    if (o.totalGp !== undefined) d.totalGp = String(o.totalGp).trim();
    if (o.splash !== undefined) d.splash = clampInt(o.splash, 0, 99, 0);
    if (o.damage) {
      if (o.damage.dice !== undefined) d.damage.dice = Number(o.damage.dice) || 1;
      if (o.damage.die !== undefined) d.damage.die = String(o.damage.die);
      if (o.damage.damageType !== undefined) d.damage.damageType = String(o.damage.damageType);
    }
    if (o.extras) {
      const arr = [];
      for (const k of Object.keys(o.extras).sort((a, b) => Number(a) - Number(b))) {
        const e = o.extras[k] ?? {};
        arr.push({
          value: Number(e.value) || 1,
          die: e.die ?? "",
          type: e.type ?? "fire",
          src: String(e.src ?? "").trim(),
          ...normalizeSave(e),
          ...normalizePick(e)
        });
      }
      d.extras = arr;
    }
    if (o.splashes) {
      const arr = [];
      for (const k of Object.keys(o.splashes).sort((a, b) => Number(a) - Number(b))) {
        const e = o.splashes[k] ?? {};
        arr.push({
          value: Number(e.value) || 1,
          die: e.die ?? "",
          type: e.type ?? "fire",
          src: String(e.src ?? "").trim(),
          ...normalizeSave(e)
        });
      }
      d.splashes = arr;
    }
    if (o.pers) {
      const arr = [];
      for (const k of Object.keys(o.pers).sort((a, b) => Number(a) - Number(b))) {
        const e = o.pers[k] ?? {};
        arr.push({
          value: Number(e.value) || 1,
          die: e.die ?? "",
          type: e.type ?? "bleed",
          src: String(e.src ?? "").trim(),
          ...normalizeSave(e)
        });
      }
      d.persistents = arr;
    }
    if (o.hconds) {
      const arr = [];
      for (const k of Object.keys(o.hconds).sort((a, b) => Number(a) - Number(b))) {
        arr.push(normalizeHitCond(o.hconds[k] ?? {}));
      }
      d.hitConds = arr;
    }
    if (o.conds) {
      const byIndex = (a, b) => Number(a) - Number(b);
      const arr = [];
      for (const k of Object.keys(o.conds).sort(byIndex)) {
        const raw = o.conds[k] ?? {};
        const criteria = raw.criteria
          ? Object.keys(raw.criteria)
              .sort(byIndex)
              .map((ck) => {
                const e = raw.criteria[ck] ?? {};
                const slug =
                  e.slugInput !== undefined
                    ? resolveCritInput(this._condChoices, e.filter, e.slugInput)
                    : e.slug;
                return { filter: e.filter, slug, min: e.min };
              })
          : [];
        arr.push(normalizeCond({ ...raw, criteria }));
      }
      d.conditionals = arr;
    }
    if (o.runes) {
      if (o.runes.potency !== undefined) d.runes.potency = Number(o.runes.potency) || 0;
      if (o.runes.striking !== undefined) d.runes.striking = Number(o.runes.striking) || 0;
    }
    d.freeMode = !!o.freeMode;
  }

  static actAddDamage(event, target) {
    this.syncFromForm();
    this.data.extras.push({ value: 1, die: "d6", type: "fire", src: "", ...normalizeSave({}), ...normalizePick({}) });
    this.render();
  }

  static actRemoveDamage(event, target) {
    this.syncFromForm();
    const idx = Number(target?.dataset?.index);
    this.data.extras = this.data.extras.filter((e, i) => i !== idx);
    this.render();
  }

  static actAddSplash(event, target) {
    this.syncFromForm();
    this.data.splashes.push({ value: 1, die: "", type: "fire", src: "", ...normalizeSave({}) });
    this.render();
  }

  static actRemoveSplash(event, target) {
    this.syncFromForm();
    const idx = Number(target?.dataset?.index);
    this.data.splashes = this.data.splashes.filter((e, i) => i !== idx);
    this.render();
  }

  static actAddHitCond(event, target) {
    this.syncFromForm();
    this.data.hitConds.push(normalizeHitCond({ condition: "frightened" }));
    this.render();
  }

  static actRemoveHitCond(event, target) {
    this.syncFromForm();
    const idx = Number(target?.dataset?.index);
    this.data.hitConds = this.data.hitConds.filter((e, i) => i !== idx);
    this.render();
  }

  static actAddPersistent(event, target) {
    this.syncFromForm();
    this.data.persistents.push({ value: 1, die: "", type: "bleed", src: "", ...normalizeSave({}) });
    this.render();
  }

  static actRemovePersistent(event, target) {
    this.syncFromForm();
    const idx = Number(target?.dataset?.index);
    this.data.persistents = this.data.persistents.filter((e, i) => i !== idx);
    this.render();
  }

  static actAddRune(event, target) {
    this.syncFromForm();
    const sel = this.element.querySelector('[name="runeToAdd"]');
    const opts = locRecord(propertyRuneRecord());
    const slug = resolveLabel(opts, sel?.value);
    // Unlike traits, an invented rune slug means a rule the system cannot
    // price or apply, so only known runes get through.
    if (!slug || !opts.some((o) => o.value === slug)) {
      if (sel?.value) ui.notifications.warn(i18n("PickRune"));
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

  static actAddTrait(event, target) {
    this.syncFromForm();
    const sel = this.element.querySelector('[name="traitToAdd"]');
    const slug = resolveLabel(locRecord((CONFIG.PF2E ?? {}).weaponTraits), sel?.value);
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

  static actAddCond(event, target) {
    this.syncFromForm();
    this.data.conditionals.push(
      normalizeCond({
        criteria: [{ filter: "ancestry", slug: "" }],
        effect: "damage",
        value: 1,
        die: "d6",
        type: "fire"
      })
    );
    this.render();
  }

  static actRemoveCond(event, target) {
    this.syncFromForm();
    const idx = Number(target?.dataset?.index);
    this.data.conditionals = this.data.conditionals.filter((c, i) => i !== idx);
    this.render();
  }

  static actAddCrit(event, target) {
    this.syncFromForm();
    const ci = Number(target?.dataset?.cond);
    this.data.conditionals[ci]?.criteria.push({ filter: "ancestry", slug: "" });
    this.render();
  }

  static actRemoveCrit(event, target) {
    this.syncFromForm();
    const ci = Number(target?.dataset?.cond);
    const idx = Number(target?.dataset?.index);
    const cond = this.data.conditionals[ci];
    // A conditional with no criteria left would apply to everyone, which is the
    // opposite of what it is for; removing the last one deletes the row instead.
    if (!cond) return;
    if (cond.criteria.length <= 1) {
      this.data.conditionals = this.data.conditionals.filter((c, i) => i !== ci);
    } else {
      cond.criteria = cond.criteria.filter((c, j) => j !== idx);
    }
    this.render();
  }

  static actTab(event, target) {
    // Sync first so switching tabs never loses what was just typed.
    this.syncFromForm();
    this._sweTab = target?.dataset?.tab ?? "damage";
    this.render();
  }

  static actRevert(event, target) {
    this.data = SimpleWeaponEditor.extract(this.item);
    this.render();
    ui.notifications.info(i18n("Reverted"));
  }

  static async onSubmit(event, form, formData) {
    this.syncFromForm();
    const d = this.data;
    const cfg = CONFIG.PF2E ?? {};
    if (d.runes.property.length > (Number(d.runes.potency) || 0) && !d.freeMode) {
      ui.notifications.warn(i18n("OverLimitBlocked"));
      return;
    }
    const firstPers = d.persistents[0];
    // A save-gated entry cannot live in the native persistent field (its damage
    // must stay out of the main roll), so only a save-less first entry does.
    const nativePers = firstPers && !firstPers.saveType ? firstPers : null;
    const persistent = nativePers
      ? {
          number: Number(nativePers.value) || 1,
          faces: nativePers.die ? Number(String(nativePers.die).replace("d", "")) || null : null,
          type: nativePers.type || "bleed"
        }
      : null;
    const keep = (this.item._source.system.rules ?? []).filter((r) => !isSweRule(r));
    const mkLabel = (mark, e, tl) => {
      const auto = e.die ? `+${Number(e.value) || 1}${e.die} ${tl}` : `+${Number(e.value) || 1} ${tl}`;
      return `${mark} ${e.src || auto}`;
    };
    // Entries with a save emit a companion Note so the damage card carries the
    // system's clickable @Check; regenerated every save, never read back.
    const saveNotes = [];
    // Save-gated damage follows the spell pattern: it leaves the main roll and
    // the note carries the @Check AND its own @Damage button, so each target
    // resolves their save and applies that piece per their own outcome. The
    // system draws no link between a save result and a damage card (verified
    // by rolling both), so keeping gated damage in the main roll made "the
    // system knows they saved" impossible.
    const mkSaveNote = (e, tl, kind) => {
      if (!e.saveType) return;
      const basic = e.saveOut === "half" ? "|basic:true" : "";
      const clause = i18n(e.saveOut === "half" ? "NoteHalf" : "NoteNone");
      const dcPart =
        e.saveDcMode === "auto"
          ? "resolve(@actor.attributes.classOrSpellDC.value)"
          : e.saveDc;
      const roll = e.die ? `${e.value}${e.die}` : `${e.value}`;
      const dmgType = kind === "persistent" ? `persistent,${e.type}` : e.type;
      const dmgPart = e.type === "precision" ? `@Damage[(${roll})]` : `@Damage[(${roll})[${dmgType}]]`;
      const suffix = kind === "persistent" ? ` ${i18n("PersistentShort")}` : kind === "splash" ? ` ${i18n("Splash").toLowerCase()}` : "";
      saveNotes.push({
        key: "Note",
        selector: "{item|id}-damage",
        // Titled as separate on purpose: the note renders inside the damage
        // card, and without the marker it reads as part of that roll.
        title: `${i18n("Independent")} · ${condAmount(e)} ${tl}${suffix}${e.src ? ` · ${e.src}` : ""}`,
        text: `@Check[type:${e.saveType}|dc:${dcPart}${basic}] ${dmgPart} — ${clause}`,
        label: `${SWE_MARK}N:`
      });
    };
    const persRules = (nativePers ? d.persistents.slice(1) : d.persistents).map((e, i) => {
      const tl = labelFor(cfg.damageTypes, e.type);
      let rule;
      if (e.die) {
        rule = {
          key: "DamageDice",
          slug: `swe-p-${i}`,
          selector: "{item|id}-damage",
          diceNumber: Number(e.value) || 1,
          dieSize: e.die,
          damageType: e.type,
          category: "persistent",
          label: mkLabel(SWE_PERS, e, tl)
        };
      } else {
        rule = {
          key: "FlatModifier",
          slug: `swe-p-${i}`,
          selector: "{item|id}-damage",
          value: Number(e.value) || 1,
          damageType: e.type,
          damageCategory: "persistent",
          label: mkLabel(SWE_PERS, e, tl)
        };
      }
      if (e.saveType) {
        rule.sweSave = { type: e.saveType, dc: e.saveDc, mode: e.saveDcMode, out: e.saveOut };
        // Inert in the roll, invisible in the dialog: the rule only carries the
        // entry's data; the note's @Damage is what the table actually rolls.
        rule.predicate = ["swe-gated"];
        rule.hideIfDisabled = true;
        mkSaveNote(e, tl, "persistent");
      }
      return rule;
    });
    // Entries with a save also emit a companion Note: the damage card then
    // carries the system's own clickable @Check button, and the table applies
    // full, half or none with the card's standard buttons.
    // Every emitted damage rule gets its own slug. Without one the system
    // derives it from the label and dedupes modifiers by slug before testing
    // predicates, so two identical rows ("+5 Sonic" twice) silently collapsed
    // into one (verified: 5 sonic instead of 10).
    const mkDamageRule = (e, splash, i) => {
      const tl = damageTypeLabel(cfg, e.type);
      const precision = e.type === "precision";
      const slug = `swe-${splash ? "s" : "x"}-${i}`;
      let rule;
      if (e.die) {
        rule = {
          key: "DamageDice",
          slug,
          selector: "{item|id}-damage",
          diceNumber: Number(e.value) || 1,
          dieSize: e.die,
          label: mkLabel(SWE_MARK, e, tl)
        };
        if (!precision) rule.damageType = e.type;
        if (precision) rule.category = "precision";
        if (splash) rule.category = "splash";
      } else {
        rule = {
          key: "FlatModifier",
          slug,
          selector: "{item|id}-damage",
          value: Number(e.value) || 1,
          label: mkLabel(SWE_MARK, e, tl)
        };
        if (!precision) rule.damageType = e.type;
        if (precision) rule.damageCategory = "precision";
        if (splash) rule.damageCategory = "splash";
      }
      if (e.saveType) {
        rule.sweSave = { type: e.saveType, dc: e.saveDc, mode: e.saveDcMode, out: e.saveOut };
        rule.predicate = ["swe-gated"];
        rule.hideIfDisabled = true;
        mkSaveNote(e, tl, splash ? "splash" : "");
      }
      // A chosen extra only enters a roll whose options carry its key, which
      // the strike wrapper injects from the pre-attack dialog. A gated one
      // stays inert in the roll either way: the save engine checks the key.
      if (!splash && e.pick) {
        rule.swePick = e.pickKey;
        if (!e.saveType) {
          rule.predicate = [pickOption(e.pickKey)];
          rule.hideIfDisabled = true;
        }
      }
      return rule;
    };
    const sweRules = [
      ...d.extras.map((e, i) => mkDamageRule(e, false, i)),
      ...d.splashes.map((e, i) => mkDamageRule(e, true, i)),
      ...saveNotes
    ];
    // Splash without its trait does nothing, so setting an amount brings the
    // trait along; the trait alone is left to the user (it may be there for
    // other reasons, so clearing the amount never removes it).
    if ((Number(d.splash) || 0) > 0 && !d.traits.includes("splash")) {
      d.traits.push("splash");
      d.traits.sort();
    }
    // A criterion with no target selected would emit a predicate that matches
    // nothing, and criteria are ANDed, so it would silently disable its whole
    // conditional. Drop the empties and say how many rather than save a rule
    // that never fires.
    const conds = dedupeConds(
      d.conditionals
        .map((c) => ({ ...c, criteria: c.criteria.filter((crit) => crit.slug) }))
        .filter((c) => c.criteria.length)
    );
    const droppedCrits =
      d.conditionals.reduce((n, c) => n + c.criteria.filter((x) => !x.slug).length, 0);
    const incomplete = d.conditionals.length - conds.length + droppedCrits;
    if (incomplete > 0) ui.notifications.warn(`${i18n("CondNoTarget")} (${incomplete})`);
    // Damage conditionals are mirrored as native rule elements so PF2e computes
    // them and shows them in the damage breakdown. They are output only: the flag
    // written below stays the source of truth and extract() never reads them back.
    const condRules = conds
      // A native MAP predicate would be inconsistent on damage: rolled from the
      // attack card, the damage carries map:increases (the card forwards it),
      // but rolled from the sheet it does not (verified live). Conditionals
      // with a MAP criterion are therefore resolved by the module engine,
      // which reads the count off the damage message or the attack before it.
      .filter((c) => c.effect === "damage" && !c.criteria.some((k) => k.filter === "map"))
      .map((c, i) => {
        const tl = damageTypeLabel(cfg, c.type);
        const who = c.criteria.map((crit) => critText(this._condChoices, crit)).join(" + ");
        const auto = `${condAmount(c)} ${tl} · ${who}`;
        const base = {
          slug: `${SWE_COND_SLUG}-${i}`,
          selector: "{item|id}-damage",
          predicate: condPredicate(c),
          // Without this PF2e still lists the conditional in the damage panel as a
          // struck-through toggle when the wielder does not match, which invites
          // switching on something the condition says should not apply.
          hideIfDisabled: true,
          // No marker prefix here: the slug above identifies the rule, so what the
          // player sees in the damage breakdown is just the effect.
          label: c.src || auto
        };
        if (c.type === "precision") {
          if (c.die) base.category = "precision";
          else base.damageCategory = "precision";
        } else {
          base.damageType = c.type;
        }
        return c.die
          ? { ...base, key: "DamageDice", diceNumber: Number(c.value) || 1, dieSize: c.die }
          : { ...base, key: "FlatModifier", value: Number(c.value) || 1 };
      });
    // Damage predicates can only see roll options, and the system never turns an
    // adoption into one, so any weapon with an ancestry damage conditional also
    // carries a helper rule that publishes the wielder's adopted ancestry as
    // swe-adopted:<slug>. Gated on the feat so actors without it resolve nothing.
    // Attack modifiers are native rules too, so the attack roll's predicate
    // needs the published adoption just as much as the damage one does.
    const needsAdopted = conds.some(
      (c) =>
        (c.effect === "damage" || c.effect === "attackBonus") &&
        c.criteria.some((k) => k.filter === "ancestry")
    );
    // Attack modifiers live entirely in native FlatModifiers on this weapon's
    // attack selector: every criterion, MAP included, is visible to the attack
    // roll's predicate (verified - MAP is on the attack roll even though the
    // damage roll lacks it), so none of these need the module engine.
    const atkRules = conds
      .filter((c) => c.effect === "attackBonus")
      .map((c, i) => {
        const who = c.criteria.map((crit) => critText(this._condChoices, crit)).join(" + ");
        const signed = c.value > 0 ? `+${c.value}` : `${c.value}`;
        return {
          key: "FlatModifier",
          slug: `${SWE_COND_SLUG}-atk-${i}`,
          selector: "{item|id}-attack",
          type: c.bonusType,
          value: c.value,
          // Under Automatic Bonus Progression the system drops item-typed
          // modifiers that come from equipment; a bonus the GM configured on
          // purpose should not vanish silently.
          fromEquipment: false,
          predicate: condPredicate(c),
          hideIfDisabled: true,
          label: c.src || `${signed} ${i18n(`Bonus_${c.bonusType}`)} \u00b7 ${who}`
        };
      });
    const helperRules = needsAdopted
      ? [
          {
            key: "ActiveEffectLike",
            slug: `${SWE_COND_SLUG}-adopted`,
            mode: "override",
            path: "flags.pf2e.rollOptions.all.swe-adopted:{actor|system.details.ancestry.adopted}",
            value: true,
            // Very late on purpose. The adopted slot is overridden by every
            // "counts as" source in sequence, and resolving mid-chain captured
            // the wrong one (seen live: an actor whose final slot said android
            // published swe-adopted:dragon). At 999 the path resolves after
            // every override, i.e. the same value the sheet shows.
            priority: 999,
            predicate: ["feat:adopted-ancestry"]
          }
        ]
      : [];
    const update = {
      name: d.name || this.item.name,
      "system.level.value": Number(d.level) || 0,
      "system.damage.dice": Number(d.damage.dice) || 1,
      "system.damage.die": d.damage.die,
      "system.damage.damageType": d.damage.damageType,
      "system.damage.persistent": persistent,
      "system.splashDamage.value": Number(d.splash) || 0,
      [`flags.${MODULE_ID}.persSave`]: null,
      "system.runes.potency": Number(d.runes.potency) || 0,
      "system.runes.striking": Number(d.runes.striking) || 0,
      "system.runes.property": [...d.runes.property],
      "system.traits.value": [...d.traits],
      "system.rules": [...keep, ...sweRules, ...persRules, ...helperRules, ...condRules, ...atkRules],
      [`flags.${MODULE_ID}.${COND_FLAG}`]: conds,
      [`flags.${MODULE_ID}.${HITCOND_FLAG}`]: d.hitConds.filter((h) => h.condition)
    };
    if (d.totalGp !== undefined) {
      const derivedGp = Number(this.item.system?.price?.value?.gp ?? 0);
      const baseGp = Number(this.item._source.system?.price?.value?.gp ?? 0);
      const runesGp = Math.max(0, derivedGp - baseGp);
      if (d.totalGp === "") {
        update["system.price.value.gp"] = 0;
      } else {
        const total = Number(d.totalGp);
        if (Number.isFinite(total)) {
          const newBase = Math.max(0, Math.round(total - runesGp));
          if (total < runesGp) {
            ui.notifications.warn(`${i18n("PriceFloor")}: ${runesGp} gp`);
          }
          update["system.price.value.gp"] = newBase;
        }
      }
    }
    try {
      await this.item.update(update);
      ui.notifications.info(i18n("Saved"));
      this.render();
    } catch (err) {
      console.error(`${MODULE_ID} | save failed`, err);
      ui.notifications.error(`${i18n("SaveFailed")}: ${err.message}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Healing engine                                                             */
/*                                                                             */
/*  PF2e has no rule element for "heal when you hit", and FastHealing only     */
/*  takes a flat number, so healing is applied by the module itself. Hooks fire */
/*  on every connected client, so every entry point is gated on being the one   */
/*  active GM: without that guard the healing is multiplied by the number of    */
/*  people at the table, and non-owning players hit a permission error.         */
/* -------------------------------------------------------------------------- */

function isSoleExecutor() {
  return !!game.users?.activeGM && game.users.activeGM === game.user;
}

function isCarried(item) {
  const carry = item?.system?.equipped?.carryType;
  return carry === "held" || carry === "worn";
}

function healEntriesFor(actor, timing, onlyItemId = null, rollOpts = []) {
  const out = [];
  for (const item of actor?.items ?? []) {
    if (item.type !== "weapon") continue;
    if (onlyItemId && item.id !== onlyItemId) continue;
    if (!isCarried(item)) continue;
    for (const cond of readConds(item)) {
      if (cond.effect !== timing) continue;
      if (!actorMatchesCond(actor, cond, rollOpts)) continue;
      out.push({ item, cond });
    }
  }
  return out;
}

// Prefer the system's own application so the result respects max HP, temporary
// HP and the dying/wounded track. The clamped update is only a fallback.
async function applyHealing(actor, total) {
  if (!(total > 0)) return;
  // PF2e's applyDamage builds its own chat card from the token and crashes
  // without one (verified against 8.4.1: it reads the token's name), so it is
  // only used when the wielder has a linked token; anyone else gets the plain
  // clamped update below.
  const token = actor.getActiveTokens?.(true, true)?.[0] ?? null;
  if (token && typeof actor.applyDamage === "function") {
    try {
      await actor.applyDamage({ damage: -total, token, skipIWR: true });
      return;
    } catch (err) {
      console.warn(`${MODULE_ID} | applyDamage failed, using fallback`, err);
    }
  }
  const hp = actor.system?.attributes?.hp;
  if (!hp) return;
  const next = Math.min(Number(hp.max) || 0, (Number(hp.value) || 0) + total);
  await actor.update({ "system.attributes.hp.value": next });
}

async function runHealing(actor, timing, { itemId = null, rollOpts = [] } = {}) {
  if (!isSoleExecutor()) return;
  const entries = healEntriesFor(actor, timing, itemId, rollOpts);
  if (!entries.length) return;
  // Healing a full-health wielder posted a pointless roll plus the system's
  // "already at full health" card on every hit; stay quiet instead.
  const hpNow = actor.system?.attributes?.hp;
  if (hpNow && Number(hpNow.value) >= Number(hpNow.max)) return;
  // All matching entries roll together as one real roll message, so the dice
  // are seen being thrown (and 3D dice modules animate them). The system's own
  // "healed for X" card is the receipt, so no extra text message is posted.
  const parts = [];
  const names = new Set();
  for (const { item, cond } of entries) {
    parts.push(cond.die ? `${cond.value}${cond.die}` : `${cond.value}`);
    names.add(item.name);
  }
  try {
    const roll = await new Roll(parts.join(" + ")).evaluate();
    if (!(Number(roll.total) > 0)) return;
    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor }),
      flavor: `${i18n(timing === "healTurn" ? "HealTurn" : "HealHit")} · ${[...names].join(" · ")}`
    });
    await applyHealing(actor, Number(roll.total));
  } catch (err) {
    console.error(`${MODULE_ID} | healing failed`, err);
  }
}

/* -------------------------------------------------------------------------- */
/*  Save engine                                                                */
/*                                                                             */
/*  Gated damage resolves like a spell rider, but automatically: when a strike */
/*  hits, the TARGET's save is rolled for them, and the piece is applied per   */
/*  their degree of success - through applyDamage with IWR respected, so       */
/*  resistances count. Runs only on the active GM's client, like healing.      */
/* -------------------------------------------------------------------------- */

function readGatedEntries(item) {
  const out = [];
  for (const r of item?._source?.system?.rules ?? []) {
    if (!r?.sweSave?.type) continue;
    if (r.key !== "DamageDice" && r.key !== "FlatModifier") continue;
    if (isCondRule(r) || !isSweRule(r)) continue;
    const kind =
      typeof r.label === "string" && r.label.startsWith(SWE_PERS)
        ? "persistent"
        : r.category === "splash" || r.damageCategory === "splash"
          ? "splash"
          : "";
    out.push({
      value: r.key === "DamageDice" ? (r.diceNumber ?? 1) : (r.value ?? 1),
      die: r.key === "DamageDice" ? (r.dieSize ?? "d6") : "",
      type: r.category === "precision" || r.damageCategory === "precision" ? "precision" : (r.damageType ?? "fire"),
      pick: r.swePick ?? null,
      kind,
      save: {
        type: r.sweSave.type,
        dc: clampInt(r.sweSave.dc, 1, 60, 15),
        mode: r.sweSave.mode === "auto" ? "auto" : "fixed",
        out: r.sweSave.out === "none" ? "none" : "half"
      }
    });
  }
  return out;
}

// degreeOfSuccess: 0 critical failure, 1 failure, 2 success, 3 critical success
const GATE_MULT = {
  half: [2, 1, 0.5, 0],
  none: [1, 1, 0, 0]
};

async function runGatedSaves(attacker, item, message) {
  const entries = readGatedEntries(item);
  if (!entries.length) return;
  const targetRef = message.flags?.pf2e?.context?.target;
  if (!targetRef?.actor) return;
  let targetActor;
  let tokenDoc = null;
  try {
    const doc = await fromUuid(targetRef.actor);
    targetActor = doc?.actor ?? doc;
    tokenDoc = targetRef.token ? await fromUuid(targetRef.token) : null;
  } catch {
    return;
  }
  if (!targetActor) return;
  // A critical Strike doubles its damage, gated pieces included - the system
  // does the same with its own persistent partials on a crit. The save ladder
  // then applies on top of the doubled amount (a critically failed basic save
  // on a critical hit is the literal composition of both rules).
  const critHit = message.flags?.pf2e?.context?.outcome === "criticalSuccess";
  const cfg = CONFIG.PF2E ?? {};
  const lines = [];
  const ctxOpts = (message.flags?.pf2e?.context?.options ?? []).map(String);
  for (const e of entries) {
    // A chosen extra that was not picked for this attack never existed for it.
    if (e.pick && !ctxOpts.includes(pickOption(e.pick))) continue;
    const dc =
      e.save.mode === "auto"
        ? Number(attacker.system?.attributes?.classOrSpellDC?.value) || 0
        : e.save.dc;
    const stat = targetActor.getStatistic?.(e.save.type);
    const tl = damageTypeLabel(cfg, e.type);
    const what = `${condAmount(e)} ${tl}${e.kind === "persistent" ? ` ${i18n("PersistentShort")}` : ""}${e.kind === "splash" ? ` ${i18n("Splash").toLowerCase()}` : ""}`;
    if (!stat) {
      lines.push(`${what}: ${i18n("NoStatistic")}`);
      continue;
    }
    let dos;
    let rollTotal = null;
    try {
      // One strike was flooding the chat with a full card per save; the rolls
      // now stay silent and everything lands in the single summary below. 3D
      // dice still animate when that module is present.
      const roll = await stat.roll({ dc: { value: dc }, skipDialog: true, createMessage: false });
      dos = roll?.options?.degreeOfSuccess ?? roll?.degreeOfSuccess;
      rollTotal = roll?.total ?? null;
      if (game.dice3d && roll) {
        try { await game.dice3d.showForRoll(roll, game.user, true); } catch {}
      }
    } catch (err) {
      console.warn(`${MODULE_ID} | gated save roll failed`, err);
      continue;
    }
    if (typeof dos !== "number") continue;
    const saveInfo = `${stat.label} ${rollTotal ?? "?"} vs ${dc} (${i18n(`Dos${dos}`)})`;
    try {
      if (e.kind === "persistent") {
        // A recurring formula has no meaningful half: a failed save applies the
        // condition, a successful one resists it.
        if (dos <= 1) {
          const src = game.pf2e.ConditionManager.getCondition("persistent-damage").toObject();
          const base = e.die ? `${e.value}${e.die}` : String(e.value);
          src.system.persistent = {
            formula: critHit ? `(${base})*2` : base,
            damageType: e.type,
            dc: 15
          };
          await targetActor.createEmbeddedDocuments("Item", [src]);
          lines.push(`${what} · ${saveInfo} → ${i18n("Applied")}${critHit ? ` (${i18n("CritMark")})` : ""}`);
        } else {
          lines.push(`${what} · ${saveInfo} → ${i18n("Resisted")}`);
        }
      } else {
        const mult = GATE_MULT[e.save.out][dos] ?? 1;
        let amount = Number(e.value) || 0;
        if (e.die) {
          amount = Number((await new Roll(`${e.value}${e.die}`).evaluate()).total) || 0;
        }
        if (critHit) amount *= 2;
        const final = Math.floor(amount * mult);
        if (final > 0) {
          await targetActor.applyDamage({ damage: final, token: tokenDoc ?? undefined, skipIWR: false });
          lines.push(`${what} · ${saveInfo} → ${final} ${i18n("Applied")}${critHit ? ` (${i18n("CritMark")})` : ""}${mult === 0.5 ? ` (${i18n("SaveHalf")})` : ""}${mult === 2 ? " (x2)" : ""}`);
        } else {
          lines.push(`${what} · ${saveInfo} → ${i18n("Resisted")}`);
        }
      }
    } catch (err) {
      console.error(`${MODULE_ID} | gated damage apply failed`, err);
    }
  }
  if (lines.length) {
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: attacker }),
      content: `<p><strong>${i18n("AutoSaves")} · ${targetActor.name}</strong></p><p>${lines.join("<br>")}</p>`
    });
  }
}

// MAP count for a damage roll. Rolled from the attack card, the damage carries
// map:increases itself (most exact: right even when damage is rolled out of
// order). Rolled from the sheet it does not, so walk back to the latest
// attack-roll by the same actor with the same weapon.
function mapCountFromOptions(opts) {
  const opt = (opts ?? []).find((o) => String(o).startsWith("map:increases:"));
  // First attacks say map:increases:0, so the fallback must be 0, not 1: an
  // unparsable count treated as "has MAP" fired the rider on first attacks.
  return opt === undefined ? null : Number(String(opt).split(":")[2]) || 0;
}

function mapStateFor(message) {
  const own = mapCountFromOptions(message.flags?.pf2e?.context?.options);
  if (own !== null) return own;
  const itemId = message.item?.id;
  const actorId = message.actor?.id;
  if (!itemId || !actorId) return 0;
  const msgs = game.messages.contents;
  let start = msgs.indexOf(message);
  if (start === -1) start = msgs.length;
  let scanned = 0;
  for (let i = start - 1; i >= 0 && scanned < 40; i--, scanned++) {
    const m = msgs[i];
    const c = m.flags?.pf2e?.context;
    if (c?.type !== "attack-roll") continue;
    if (m.actor?.id !== actorId || m.item?.id !== itemId) continue;
    return mapCountFromOptions(c.options) ?? 0;
  }
  return 0;
}

// Damage conditionals gated on MAP are not native rules (see condRules), so the
// module applies them here: same timing as gated saves, same crit doubling,
// same IWR-respecting apply.
async function runMapConds(attacker, item, message) {
  const conds = readConds(item).filter(
    (c) => c.effect === "damage" && c.criteria.some((k) => k.filter === "map")
  );
  if (!conds.length) return;
  const mapN = mapStateFor(message);
  if (!(mapN > 0)) return;
  const targetRef = message.flags?.pf2e?.context?.target;
  if (!targetRef?.actor) return;
  let targetActor;
  let tokenDoc = null;
  try {
    const doc = await fromUuid(targetRef.actor);
    targetActor = doc?.actor ?? doc;
    tokenDoc = targetRef.token ? await fromUuid(targetRef.token) : null;
  } catch {
    return;
  }
  if (!targetActor) return;
  const critHit = message.flags?.pf2e?.context?.outcome === "criticalSuccess";
  const cfg = CONFIG.PF2E ?? {};
  const lines = [];
  for (const c of conds) {
    const others = c.criteria.filter((k) => k.filter !== "map");
    const ctxOpts = message.flags?.pf2e?.context?.options ?? [];
    if (!others.every((k) => actorMatchesCrit(attacker, k, ctxOpts))) continue;
    let amount = Number(c.value) || 0;
    try {
      if (c.die) {
        amount = Number((await new Roll(`${c.value}${c.die}`).evaluate()).total) || 0;
      }
      if (critHit) amount *= 2;
      if (!(amount > 0)) continue;
      await targetActor.applyDamage({ damage: amount, token: tokenDoc ?? undefined, skipIWR: false });
      const tl = damageTypeLabel(cfg, c.type);
      lines.push(
        `${condAmount(c)} ${tl}${c.src ? ` · ${c.src}` : ""} → ${amount} ${i18n("Applied")}${critHit ? ` (${i18n("CritMark")})` : ""}`
      );
    } catch (err) {
      console.error(`${MODULE_ID} | map conditional apply failed`, err);
    }
  }
  if (lines.length) {
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: attacker }),
      content: `<p><strong>${i18n("MapDamage")} (MAP ${mapN}) · ${targetActor.name}</strong></p><p>${lines.join("<br>")}</p>`
    });
  }
}

// Applies the on-hit conditions when damage is rolled: wielder entries land on
// the attacker, target entries on the strike's target. A save-gated entry rolls
// the RECIPIENT's statistic silently (auto DC = the wielder's spell-or-class
// DC) and applies on a failed save, or only on a critically failed one. Valued
// conditions (frightened 2) are created with their value; the rest as-is.
async function runHitConditions(attacker, item, message) {
  const entries = readHitConds(item);
  if (!entries.length) return;
  const targetRef = message.flags?.pf2e?.context?.target;
  let targetActor = null;
  try {
    if (targetRef?.actor) {
      const doc = await fromUuid(targetRef.actor);
      targetActor = doc?.actor ?? doc;
    }
  } catch {
    targetActor = null;
  }
  const cfg = CONFIG.PF2E ?? {};
  const lines = [];
  for (const h of entries) {
    const recipient = h.who === "wielder" ? attacker : targetActor;
    if (!recipient) continue;
    const clabel = labelFor(cfg.conditionTypes, h.condition);
    let apply = true;
    let saveInfo = "";
    if (h.saveType) {
      const dc =
        h.saveDcMode === "auto"
          ? Number(attacker.system?.attributes?.classOrSpellDC?.value) || 0
          : h.saveDc;
      const stat = recipient.getStatistic?.(h.saveType);
      if (!stat) {
        lines.push(`${clabel} → ${recipient.name}: ${i18n("NoStatistic")}`);
        continue;
      }
      let dos;
      let total = null;
      try {
        const roll = await stat.roll({ dc: { value: dc }, skipDialog: true, createMessage: false });
        dos = roll?.options?.degreeOfSuccess ?? roll?.degreeOfSuccess;
        total = roll?.total ?? null;
        if (game.dice3d && roll) {
          try { await game.dice3d.showForRoll(roll, game.user, true); } catch {}
        }
      } catch (err) {
        console.warn(`${MODULE_ID} | hit-condition save failed`, err);
        continue;
      }
      if (typeof dos !== "number") continue;
      apply = h.saveOut === "critFail" ? dos === 0 : dos <= 1;
      saveInfo = ` · ${stat.label} ${total ?? "?"} vs ${dc} (${i18n(`Dos${dos}`)})`;
    }
    try {
      if (apply) {
        const src = game.pf2e.ConditionManager.getCondition(h.condition)?.toObject();
        if (!src) continue;
        const valued = !!src.system?.value?.isValued;
        if (valued) src.system.value.value = h.value;
        await recipient.createEmbeddedDocuments("Item", [src]);
        lines.push(`${valued ? `${clabel} ${h.value}` : clabel} → ${recipient.name}${saveInfo} → ${i18n("Applied")}`);
      } else {
        lines.push(`${clabel} → ${recipient.name}${saveInfo} → ${i18n("Resisted")}`);
      }
    } catch (err) {
      console.error(`${MODULE_ID} | hit-condition apply failed`, err);
    }
  }
  if (lines.length) {
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor: attacker }),
      content: `<p><strong>${i18n("HitCondsHead")}</strong></p><p>${lines.join("<br>")}</p>`
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  Damage choice before each attack                                          */
/*                                                                            */
/*  PF2e has no hook before a strike (only pf2e.damageRoll, after the fact),  */
/*  so the module wraps CharacterPF2e#prepareStrike, which rebuilds every     */
/*  strike on each data prep, and replaces its attack and damage functions.   */
/*  The attack wrapper asks which "to choose" extras to add and passes them   */
/*  as roll options - the supported per-roll channel, which reaches the       */
/*  DamageDice predicates. The attack message stores those options, and the  */
/*  chat card hands them to the damage roll as checkContext but does NOT     */
/*  re-apply them (verified), so the damage wrapper re-injects them: each    */
/*  hit keeps its own choice even when damage is rolled out of order.        */
/* -------------------------------------------------------------------------- */

const PICK_MADE = "swe-pick-made";
const PICK_FLAG = "lastPicks";

function pickOption(key) {
  return `swe-pick:${key}`;
}

function pickableEntries(item) {
  const out = [];
  for (const r of item?._source?.system?.rules ?? []) {
    if (!r?.swePick || !isSweRule(r) || isCondRule(r)) continue;
    if (r.key !== "DamageDice" && r.key !== "FlatModifier") continue;
    let src = typeof r.label === "string" ? r.label.slice(SWE_MARK.length).trim() : "";
    if (AUTO_LABEL_RE.test(src)) src = "";
    out.push({
      key: r.swePick,
      value: r.key === "DamageDice" ? (r.diceNumber ?? 1) : (r.value ?? 1),
      die: r.key === "DamageDice" ? (r.dieSize ?? "d6") : "",
      type: r.category === "precision" || r.damageCategory === "precision" ? "precision" : (r.damageType ?? "fire"),
      src,
      gated: !!r.sweSave?.type
    });
  }
  return out;
}

function lastPicksOf(item, entries = pickableEntries(item)) {
  const raw = item?.flags?.[MODULE_ID]?.[PICK_FLAG];
  const keys = new Set(entries.map((e) => e.key));
  return Array.isArray(raw) ? raw.filter((k) => keys.has(k)) : [];
}

function escHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Resolves to the picked keys; anything else means the attack was called off.
async function askPicks(item, entries) {
  const last = new Set(lastPicksOf(item, entries));
  const cfg = CONFIG.PF2E ?? {};
  const rows = entries
    .map((e) => {
      const color = dotFor(e.type);
      const extra = [e.src ? escHTML(e.src) : "", e.gated ? i18n("SaveShort") : ""].filter(Boolean).join(" \u00b7 ");
      return `<label class="swe-pick-row">
        <input type="checkbox" name="${escHTML(e.key)}" ${last.has(e.key) ? "checked" : ""} />
        <i class="fa-solid ${iconFor(e.type)}" style="color: ${color}"></i>
        <span class="swe-pick-amount" style="color: ${color}">+${escHTML(condAmount(e))} ${escHTML(damageTypeLabel(cfg, e.type))}</span>
        ${extra ? `<span class="swe-pick-src">${extra}</span>` : ""}
      </label>`;
    })
    .join("");
  const DialogV2 = foundry.applications.api.DialogV2;
  return DialogV2.wait({
    window: { title: `${i18n("PickTitle")}: ${item.name}`, icon: "fa-solid fa-hand-pointer" },
    classes: ["swe-pick-dialog"],
    content: `<p class="swe-pick-hint">${i18n("PickHint")}</p><div class="swe-pick-list">${rows}</div>`,
    buttons: [
      {
        action: "attack",
        label: i18n("PickConfirm"),
        icon: "fa-solid fa-dice-d20",
        default: true,
        callback: (event, button) =>
          [...button.form.querySelectorAll('input[type="checkbox"]')].filter((i) => i.checked).map((i) => i.name)
      },
      { action: "cancel", label: i18n("PickCancel"), icon: "fa-solid fa-xmark", callback: () => null }
    ],
    rejectClose: false
  });
}

async function rememberPicks(item, picks) {
  const prev = lastPicksOf(item);
  if (prev.length === picks.length && prev.every((k) => picks.includes(k))) return;
  try {
    await item.setFlag(MODULE_ID, PICK_FLAG, picks);
  } catch (err) {
    console.warn(`${MODULE_ID} | could not remember the damage choice`, err);
  }
}

function withOptions(params, extra) {
  const base = params?.options instanceof Set ? [...params.options] : [...(params?.options ?? [])];
  return { ...params, options: [...base, ...extra] };
}

function decorateStrike(strike) {
  const item = strike?.item;
  if (!item || item.type !== "weapon" || strike._swePicks) return;
  if (!pickableEntries(item).length) return;
  strike._swePicks = true;
  for (const variant of strike.variants ?? []) {
    const orig = variant.roll;
    if (typeof orig !== "function") continue;
    variant.roll = async (params = {}) => {
      // Formula previews and other view-only calls must never open a dialog.
      if (params.getFormula) {
        return orig(withOptions(params, [PICK_MADE, ...lastPicksOf(item).map(pickOption)]));
      }
      const entries = pickableEntries(item);
      const picks = await askPicks(item, entries);
      // DialogV2 resolves to the button's action name when a callback returns
      // null ("cancel", caught live) and to null when the window is closed, so
      // anything but a list of keys aborts the attack.
      if (!Array.isArray(picks)) return null;
      await rememberPicks(item, picks);
      return orig(withOptions(params, [PICK_MADE, ...picks.map(pickOption)]));
    };
  }
  // The system aliases these to the first variant once, at build time.
  if (strike.variants?.[0]) strike.roll = strike.attack = strike.variants[0].roll;
  for (const key of ["damage", "critical"]) {
    const orig = strike[key];
    if (typeof orig !== "function") continue;
    strike[key] = async (params = {}) => {
      const ctx = [...(params.checkContext?.options ?? [])].map(String);
      const picks = ctx.includes(PICK_MADE)
        ? ctx.filter((o) => o.startsWith("swe-pick:"))
        : lastPicksOf(item).map(pickOption);
      return orig(withOptions(params, [PICK_MADE, ...picks]));
    };
  }
}

function installStrikeWrapper() {
  const proto = CONFIG.PF2E?.Actor?.documentClasses?.character?.prototype;
  if (!proto?.prepareStrike || proto._sweStrikeWrapped) return;
  const orig = proto.prepareStrike;
  proto.prepareStrike = function (...args) {
    const strike = orig.apply(this, args);
    try {
      decorateStrike(strike);
    } catch (err) {
      console.warn(`${MODULE_ID} | strike wrapper`, err);
    }
    return strike;
  };
  proto._sweStrikeWrapped = true;
}

function canEdit(item) {
  const gmOnly = game.settings.get(MODULE_ID, "gmOnly");
  if (gmOnly) return game.user.isGM;
  return game.user.isGM || item.isOwner;
}

function injectButton(sheet) {
  try {
    const item = sheet.item ?? sheet.document;
    if (!item || item.type !== "weapon") return;
    if (item.pack) return;
    if (!canEdit(item)) return;
    const el = sheet.element instanceof HTMLElement ? sheet.element : sheet.element?.[0];
    const header = el?.querySelector(".window-header");
    if (!header || header.querySelector(".swe-open")) return;
    const btn = document.createElement("a");
    btn.className = "swe-open";
    btn.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i><span>${i18n("Open")}</span>`;
    btn.setAttribute("role", "button");
    btn.title = i18n("Title");
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      SimpleWeaponEditor.open(item);
    });
    const closeBtn = header.querySelector('[data-action="close"], .header-button.close, .close');
    header.insertBefore(btn, closeBtn ?? null);
  } catch (err) {
    console.error(`${MODULE_ID} | header button`, err);
  }
}

Hooks.once("init", () => {
  installStrikeWrapper();
  game.settings.register(MODULE_ID, "gmOnly", {
    name: "SWE.SettingGmOnly",
    hint: "SWE.SettingGmOnlyHint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  Handlebars.registerHelper("sweEq", (a, b) => String(a) === String(b));
});

Hooks.once("ready", () => {
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = { open: (item) => SimpleWeaponEditor.open(item) };
  // Idempotent second chance in case CONFIG.PF2E was not ready at init.
  if (!CONFIG.PF2E?.Actor?.documentClasses?.character?.prototype?._sweStrikeWrapped) {
    installStrikeWrapper();
    for (const actor of game.actors ?? []) if (actor.type === "character") actor.reset();
  }
  console.log(`${MODULE_ID} | ready`);
});

Hooks.on("renderItemSheet", (app) => injectButton(app));
Hooks.on("renderItemSheetPF2e", (app) => injectButton(app));

Hooks.on("updateItem", (doc) => {
  const app = SimpleWeaponEditor.instances.get(doc.uuid ?? doc.id);
  if (app?.rendered) app.render();
});

Hooks.on("pf2e.startTurn", (combatant) => {
  const actor = combatant?.actor;
  if (actor) runHealing(actor, "healTurn");
});

// "On hit" deliberately watches the attack roll and not the damage roll: in PF2e
// damage is a separate button that can be rolled after a miss, so keying off
// damage would heal on blows that never landed.
Hooks.on("createChatMessage", async (message) => {
  if (!isSoleExecutor()) return;
  const ctx = message?.flags?.pf2e?.context;
  if (ctx?.type === "attack-roll") {
    if (ctx.outcome !== "success" && ctx.outcome !== "criticalSuccess") return;
    if (message.getFlag?.(MODULE_ID, COND_DONE_FLAG)) return;
    const actor = message.actor;
    const itemId = message.item?.id;
    if (!actor || !itemId) return;
    try {
      await message.setFlag(MODULE_ID, COND_DONE_FLAG, true);
    } catch (err) {
      console.warn(`${MODULE_ID} | could not mark message`, err);
    }
    await runHealing(actor, "healHit", { itemId, rollOpts: ctx.options ?? [] });
    return;
  }
  // Saves resolve when damage is actually rolled, not on the hit: if the table
  // never rolls the damage, no riders fire. The damage message carries the
  // target, the outcome and the item (verified), and rolling damage after a
  // miss keeps its failure outcome, which skips the saves.
  if (ctx?.type === "damage-roll") {
    if (ctx.outcome && ctx.outcome !== "success" && ctx.outcome !== "criticalSuccess") return;
    if (message.getFlag?.(MODULE_ID, SAVES_DONE_FLAG)) return;
    const actor = message.actor;
    const item = message.item;
    if (!actor || !item) return;
    try {
      await message.setFlag(MODULE_ID, SAVES_DONE_FLAG, true);
    } catch (err) {
      console.warn(`${MODULE_ID} | could not mark message`, err);
    }
    await runGatedSaves(actor, item, message);
    await runMapConds(actor, item, message);
    await runHitConditions(actor, item, message);
  }
});
