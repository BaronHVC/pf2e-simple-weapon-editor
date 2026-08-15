const MODULE_ID = "pf2e-simple-weapon-editor";
const DIES = ["d4", "d6", "d8", "d10", "d12"];
const SWE_MARK = "SWE:";
const SWE_PERS = "SWE:P:";

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

function isSweRule(r) {
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
    for (const el of form.querySelectorAll("select, input[type=checkbox], input[type=number]")) {
      if (el.name === "runeToAdd" || el.name === "traitToAdd") continue;
      el.addEventListener("change", () => {
        this.syncFromForm();
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
      "system.rules": [...keep, ...sweRules, ...persRules]
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
