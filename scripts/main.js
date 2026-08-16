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
const COND_FILTERS = ["ancestry", "heritage", "class", "feat"];
const COND_EFFECTS = ["damage", "healTurn", "healHit"];
const COND_FLAG = "conditionals";
const COND_DONE_FLAG = "healed";

// PF2e is not uniform here: ancestry sets `self:ancestry:<slug>`, class sets
// `class:<slug>` with no `self:` prefix at all, and heritage sets the bare form
// plus a `self:` alias the system marks as transitional. Matching only one shape
// silently never fires, so every conditional tests both and the same helper
// feeds the rule predicates and the runtime fallback.
function critRollOptions(crit) {
  // A feat and a feature are both stored as feat items but announce themselves
  // under different prefixes, so a criterion pointing at either has to test both.
  const bases = crit.filter === "feat" ? ["feat", "feature"] : [crit.filter];
  return bases.flatMap((b) => [`${b}:${crit.slug}`, `self:${b}:${crit.slug}`]);
}

// Entries of a PF2e predicate are ANDed, so one {or:[...]} per criterion reads
// as "every criterion holds, each in whichever shape the system happens to use".
function condPredicate(c) {
  return c.criteria.map((crit) => ({ or: critRollOptions(crit) }));
}

// Rule elements are evaluated by PF2e itself. Our healing hooks are not, so they
// read the wielder's ancestry/heritage/class directly and only fall back to roll
// options when the actor does not expose them (NPCs, synthetic actors).
function actorMatchesCrit(actor, crit) {
  if (!actor || !crit?.slug || !COND_FILTERS.includes(crit.filter)) return false;
  if (crit.filter === "feat") {
    const feats = actor.itemTypes?.feat ?? [];
    if (feats.some((f) => (f.slug || slugOf(f.name)) === crit.slug)) return true;
  } else {
    const direct = {
      ancestry: actor.ancestry?.slug,
      heritage: actor.heritage?.slug,
      class: actor.class?.slug
    }[crit.filter];
    if (direct) return direct === crit.slug;
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
function actorMatchesCond(actor, c) {
  const crits = c?.criteria ?? [];
  if (!crits.length) return false;
  return crits.every((crit) => actorMatchesCrit(actor, crit));
}

// Damage and healing carry different payloads; keeping one flat shape meant a
// healing entry dragged a meaningless damage type around. Discriminate on effect.
function normalizeCrit(crit) {
  return {
    filter: COND_FILTERS.includes(crit?.filter) ? crit.filter : "ancestry",
    slug: String(crit?.slug ?? "").trim()
  };
}

function normalizeCond(c) {
  const effect = COND_EFFECTS.includes(c?.effect) ? c.effect : "damage";
  // Conditionals used to carry a single filter/slug pair directly; anything
  // saved back then is read as a one-criterion conditional.
  const rawCrits =
    Array.isArray(c?.criteria) && c.criteria.length
      ? c.criteria
      : [{ filter: c?.filter, slug: c?.slug }];
  const base = {
    criteria: rawCrits.map(normalizeCrit),
    effect,
    value: clampInt(c?.value, 1, 99, 1),
    die: DIES.includes(c?.die) ? c.die : "",
    src: String(c?.src ?? "").trim()
  };
  if (effect === "damage") base.type = String(c?.type ?? "fire");
  return base;
}

function condAmount(c) {
  return c.die ? `${c.value}${c.die}` : `${c.value}`;
}

// Conditionals live in a module flag, which is the single source of truth. The
// damage ones are additionally emitted as rule elements so PF2e computes them
// natively, but those are write-only output: they are regenerated from the flag
// on every save and never parsed back.
function readConds(item) {
  const raw = item?._source?.flags?.[MODULE_ID]?.[COND_FLAG];
  if (!Array.isArray(raw)) return [];
  const seen = new Map();
  for (const entry of raw) {
    const c = normalizeCond(entry);
    // A criterion with nothing selected would match nothing and, being ANDed,
    // would disable the whole conditional.
    c.criteria = c.criteria.filter((crit) => crit.slug);
    if (!c.criteria.length) continue;
    // Identical entries would otherwise be counted twice when healing.
    seen.set(JSON.stringify(c), c);
  }
  return [...seen.values()];
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
  const out = { ancestry: [], heritage: [], class: [], feat: [] };
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
function condLabel(choices, crit) {
  const hit = (choices?.[crit.filter] ?? []).find((o) => o.value === crit.slug);
  return hit ? hit.label : null;
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
  }

  static _runeIndexPromise = null;
  static instances = new Map();

  static open(item) {
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
    if (per) {
      const faces = Number(per.faces) || null;
      persistents.push({ value: per.number ?? 1, die: faces ? `d${faces}` : "", type: per.type ?? "bleed" });
    }
    for (const r of src.rules ?? []) {
      if (!isSweRule(r)) continue;
      // Must come before the persistent check, or a conditional would be read
      // back as plain extra damage and duplicated on the next save. Conditionals
      // are rebuilt from the flag, never from these rules.
      if (isCondRule(r)) continue;
      const isPers = r.label.startsWith(SWE_PERS);
      const bucket = isPers ? persistents : extras;
      const mark = isPers ? SWE_PERS : SWE_MARK;
      let srcLabel = r.label.slice(mark.length).trim();
      if (AUTO_LABEL_RE.test(srcLabel)) srcLabel = "";
      if (r.key === "DamageDice") {
        bucket.push({
          value: r.diceNumber ?? 1,
          die: r.dieSize ?? "d6",
          type: r.damageType ?? "fire",
          src: srcLabel
        });
      } else if (r.key === "FlatModifier") {
        bucket.push({
          value: r.value ?? 1,
          die: "",
          type: r.damageType ?? "fire",
          src: srcLabel
        });
      }
    }
    const rawDie = src.damage?.die ?? "d4";
    for (const e of extras) {
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
      extras,
      persistents,
      runes: {
        potency: clampInt(src.runes?.potency, 0, 4, 0),
        striking: clampInt(src.runes?.striking, 0, 3, 0),
        property: [...new Set(src.runes?.property ?? [])]
      },
      traits: [...new Set(src.traits?.value ?? [])],
      conditionals: readConds(item),
      freeMode: false
    };
  }

  static DEFAULT_OPTIONS = {
    classes: ["swe-editor"],
    tag: "form",
    position: { width: 620 },
    window: { icon: "fa-solid fa-wand-magic-sparkles", resizable: true },
    form: {
      handler: SimpleWeaponEditor.onSubmit,
      submitOnChange: false,
      closeOnSubmit: false
    },
    actions: {
      sweAddDamage: SimpleWeaponEditor.actAddDamage,
      sweRemoveDamage: SimpleWeaponEditor.actRemoveDamage,
      sweAddPersistent: SimpleWeaponEditor.actAddPersistent,
      sweRemovePersistent: SimpleWeaponEditor.actRemovePersistent,
      sweAddRune: SimpleWeaponEditor.actAddRune,
      sweRemoveRune: SimpleWeaponEditor.actRemoveRune,
      sweShowRune: SimpleWeaponEditor.actShowRune,
      sweAddTrait: SimpleWeaponEditor.actAddTrait,
      sweRemoveTrait: SimpleWeaponEditor.actRemoveTrait,
      sweAddCond: SimpleWeaponEditor.actAddCond,
      sweRemoveCond: SimpleWeaponEditor.actRemoveCond,
      sweAddCrit: SimpleWeaponEditor.actAddCrit,
      sweRemoveCrit: SimpleWeaponEditor.actRemoveCrit,
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
    const totalDice = (Number(d.damage.dice) || 1) + striking;
    const typeLabel = labelFor(cfg.damageTypes, d.damage.damageType);
    const overLimit = d.runes.property.length > potency;
    let preview = `${potency > 0 ? `+${potency} ` : ""}${totalDice}${d.damage.die} ${typeLabel}`;
    for (const e of d.extras) {
      const tl = labelFor(cfg.damageTypes, e.type);
      preview += e.die ? ` + ${e.value}${e.die} ${tl}` : ` + ${e.value} ${tl}`;
    }
    for (const p of d.persistents) {
      const pl = labelFor(cfg.damageTypes, p.type);
      const amount = p.die ? `${p.value}${p.die}` : `${p.value}`;
      preview += ` + ${amount} ${pl} ${i18n("PersistentShort")}`;
    }
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
    const condIndexed = d.conditionals.map((c, i) => ({
      ...c,
      index: i,
      isDamage: c.effect === "damage",
      amount: condAmount(c),
      onlyOneCrit: c.criteria.length <= 1,
      criteria: c.criteria.map((crit, j) => {
        const resolved = condLabel(choices, crit);
        return {
          ...crit,
          index: j,
          condIndex: i,
          first: j === 0,
          options: choices[crit.filter] ?? [],
          resolved,
          unknown: !!crit.slug && !resolved
        };
      })
    }));
    const derivedGp = Number(this.item.system?.price?.value?.gp ?? 0);
    const baseGp = Number(this.item._source.system?.price?.value?.gp ?? 0);
    const runesGp = Math.max(0, derivedGp - baseGp);
    return {
      data: d,
      img: this.item.img,
      totalGp: derivedGp,
      runesGp,
      dies: DIES,
      damageTypes: locRecord(cfg.damageTypes),
      weaponTraits: locRecord(cfg.weaponTraits),
      propertyRunes: locRecord(propertyRuneRecord()),
      potencyOptions: [0, 1, 2, 3, 4],
      strikingOptions: [
        { value: 0, label: "—" },
        { value: 1, label: i18n("Striking1") },
        { value: 2, label: i18n("Striking2") },
        { value: 3, label: i18n("Striking3") }
      ],
      extrasIndexed: d.extras.map((e, i) => ({ ...e, index: i })),
      persIndexed: d.persistents.map((e, i) => ({ ...e, index: i })),
      runesResolved: d.runes.property.map((slug) => ({
        slug,
        label: labelFor(propertyRuneRecord(), slug)
      })),
      traitsResolved: d.traits.map((slug) => ({
        slug,
        label: labelFor(cfg.weaponTraits, slug)
      })),
      condIndexed,
      filterOptions: COND_FILTERS.map((f) => ({
        value: f,
        label: i18n(`Filter_${f}`)
      })),
      effectOptions: COND_EFFECTS.map((e) => ({
        value: e,
        label: i18n(`Effect_${e}`)
      })),
      preview,
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
    const runeSel = form.querySelector('[name="runeToAdd"]');
    if (runeSel) {
      runeSel.addEventListener("change", () => {
        this.syncFromForm();
        this.selectedRune = runeSel.value || null;
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
          src: String(e.src ?? "").trim()
        });
      }
      d.extras = arr;
    }
    if (o.pers) {
      const arr = [];
      for (const k of Object.keys(o.pers).sort((a, b) => Number(a) - Number(b))) {
        const e = o.pers[k] ?? {};
        arr.push({
          value: Number(e.value) || 1,
          die: e.die ?? "",
          type: e.type ?? "bleed",
          src: String(e.src ?? "").trim()
        });
      }
      d.persistents = arr;
    }
    if (o.conds) {
      const byIndex = (a, b) => Number(a) - Number(b);
      const arr = [];
      for (const k of Object.keys(o.conds).sort(byIndex)) {
        const raw = o.conds[k] ?? {};
        const criteria = raw.criteria
          ? Object.keys(raw.criteria)
              .sort(byIndex)
              .map((ck) => raw.criteria[ck] ?? {})
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
    this.data.extras.push({ value: 1, die: "d6", type: "fire", src: "" });
    this.render();
  }

  static actRemoveDamage(event, target) {
    this.syncFromForm();
    const idx = Number(target?.dataset?.index);
    this.data.extras = this.data.extras.filter((e, i) => i !== idx);
    this.render();
  }

  static actAddPersistent(event, target) {
    this.syncFromForm();
    this.data.persistents.push({ value: 1, die: "", type: "bleed", src: "" });
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
    const slug = sel?.value;
    if (slug && !this.data.runes.property.includes(slug)) {
      this.data.runes.property.push(slug);
      this.selectedRune = slug;
    }
    this.render();
  }

  static actShowRune(event, target) {
    this.syncFromForm();
    this.selectedRune = target?.dataset?.slug ?? null;
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
    const slug = sel?.value;
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
    const persistent = firstPers
      ? {
          number: Number(firstPers.value) || 1,
          faces: firstPers.die ? Number(String(firstPers.die).replace("d", "")) || null : null,
          type: firstPers.type || "bleed"
        }
      : null;
    const keep = (this.item._source.system.rules ?? []).filter((r) => !isSweRule(r));
    const mkLabel = (mark, e, tl) => {
      const auto = e.die ? `+${Number(e.value) || 1}${e.die} ${tl}` : `+${Number(e.value) || 1} ${tl}`;
      return `${mark} ${e.src || auto}`;
    };
    const persRules = d.persistents.slice(1).map((e) => {
      const tl = labelFor(cfg.damageTypes, e.type);
      if (e.die) {
        return {
          key: "DamageDice",
          selector: "{item|id}-damage",
          diceNumber: Number(e.value) || 1,
          dieSize: e.die,
          damageType: e.type,
          category: "persistent",
          label: mkLabel(SWE_PERS, e, tl)
        };
      }
      return {
        key: "FlatModifier",
        selector: "{item|id}-damage",
        value: Number(e.value) || 1,
        damageType: e.type,
        damageCategory: "persistent",
        label: mkLabel(SWE_PERS, e, tl)
      };
    });
    const sweRules = d.extras.map((e) => {
      const tl = labelFor(cfg.damageTypes, e.type);
      if (e.die) {
        return {
          key: "DamageDice",
          selector: "{item|id}-damage",
          diceNumber: Number(e.value) || 1,
          dieSize: e.die,
          damageType: e.type,
          label: mkLabel(SWE_MARK, e, tl)
        };
      }
      return {
        key: "FlatModifier",
        selector: "{item|id}-damage",
        value: Number(e.value) || 1,
        damageType: e.type,
        label: mkLabel(SWE_MARK, e, tl)
      };
    });
    // A criterion with no target selected would emit a predicate that matches
    // nothing, and criteria are ANDed, so it would silently disable its whole
    // conditional. Drop the empties and say how many rather than save a rule
    // that never fires.
    const conds = d.conditionals
      .map((c) => ({ ...c, criteria: c.criteria.filter((crit) => crit.slug) }))
      .filter((c) => c.criteria.length);
    const droppedCrits =
      d.conditionals.reduce((n, c) => n + c.criteria.filter((x) => !x.slug).length, 0);
    const incomplete = d.conditionals.length - conds.length + droppedCrits;
    if (incomplete > 0) ui.notifications.warn(`${i18n("CondNoTarget")} (${incomplete})`);
    // Damage conditionals are mirrored as native rule elements so PF2e computes
    // them and shows them in the damage breakdown. They are output only: the flag
    // written below stays the source of truth and extract() never reads them back.
    const condRules = conds
      .filter((c) => c.effect === "damage")
      .map((c, i) => {
        const tl = labelFor(cfg.damageTypes, c.type);
        const who = c.criteria.map((crit) => crit.slug).join(" + ");
        const auto = `${condAmount(c)} ${tl} · ${who}`;
        const base = {
          slug: `${SWE_COND_SLUG}-${i}`,
          selector: "{item|id}-damage",
          damageType: c.type,
          predicate: condPredicate(c),
          // Without this PF2e still lists the conditional in the damage panel as a
          // struck-through toggle when the wielder does not match, which invites
          // switching on something the condition says should not apply.
          hideIfDisabled: true,
          // No marker prefix here: the slug above identifies the rule, so what the
          // player sees in the damage breakdown is just the effect.
          label: c.src || auto
        };
        return c.die
          ? { ...base, key: "DamageDice", diceNumber: Number(c.value) || 1, dieSize: c.die }
          : { ...base, key: "FlatModifier", value: Number(c.value) || 1 };
      });
    const update = {
      name: d.name || this.item.name,
      "system.level.value": Number(d.level) || 0,
      "system.damage.dice": Number(d.damage.dice) || 1,
      "system.damage.die": d.damage.die,
      "system.damage.damageType": d.damage.damageType,
      "system.damage.persistent": persistent,
      "system.runes.potency": Number(d.runes.potency) || 0,
      "system.runes.striking": Number(d.runes.striking) || 0,
      "system.runes.property": [...d.runes.property],
      "system.traits.value": [...d.traits],
      "system.rules": [...keep, ...sweRules, ...persRules, ...condRules],
      [`flags.${MODULE_ID}.${COND_FLAG}`]: conds
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

function healEntriesFor(actor, timing, onlyItemId = null) {
  const out = [];
  for (const item of actor?.items ?? []) {
    if (item.type !== "weapon") continue;
    if (onlyItemId && item.id !== onlyItemId) continue;
    if (!isCarried(item)) continue;
    for (const cond of readConds(item)) {
      if (cond.effect !== timing) continue;
      if (!actorMatchesCond(actor, cond)) continue;
      out.push({ item, cond });
    }
  }
  return out;
}

// Prefer the system's own application so the result respects max HP, temporary
// HP and the dying/wounded track. The clamped update is only a fallback.
async function applyHealing(actor, total) {
  if (!(total > 0)) return;
  try {
    if (typeof actor.applyDamage === "function") {
      await actor.applyDamage({ damage: -total, skipIWR: true });
      return;
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | applyDamage failed, using fallback`, err);
  }
  const hp = actor.system?.attributes?.hp;
  if (!hp) return;
  const next = Math.min(Number(hp.max) || 0, (Number(hp.value) || 0) + total);
  await actor.update({ "system.attributes.hp.value": next });
}

async function runHealing(actor, timing, { itemId = null } = {}) {
  if (!isSoleExecutor()) return;
  const entries = healEntriesFor(actor, timing, itemId);
  if (!entries.length) return;
  let total = 0;
  const parts = [];
  for (const { item, cond } of entries) {
    let amount = Number(cond.value) || 0;
    if (cond.die) {
      try {
        const roll = await new Roll(`${cond.value}${cond.die}`).evaluate();
        amount = Number(roll.total) || 0;
      } catch (err) {
        console.warn(`${MODULE_ID} | healing roll failed`, err);
        continue;
      }
    }
    if (amount > 0) {
      total += amount;
      parts.push(`${item.name}: +${amount}`);
    }
  }
  if (total <= 0) return;
  try {
    await applyHealing(actor, total);
    // One batched message: a weapon with several matching conditionals, or an
    // actor holding more than one, should not spam the log.
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<p><strong>${i18n(timing === "healTurn" ? "HealTurn" : "HealHit")}: +${total}</strong></p><p>${parts.join(" · ")}</p>`
    });
  } catch (err) {
    console.error(`${MODULE_ID} | healing failed`, err);
  }
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
  if (ctx?.type !== "attack-roll") return;
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
  await runHealing(actor, "healHit", { itemId });
});
