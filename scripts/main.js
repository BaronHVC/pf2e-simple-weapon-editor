const MODULE_ID = "pf2e-simple-weapon-editor";
const DIES = ["d4", "d6", "d8", "d10", "d12"];

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

class SimpleWeaponEditor extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  constructor(item, options = {}) {
    super(options);
    this.item = item;
    this.data = SimpleWeaponEditor.extract(item);
  }

  static extract(item) {
    const src = item._source.system ?? {};
    const per = src.damage?.persistent;
    return {
      name: item._source.name,
      img: item._source.img,
      level: src.level?.value ?? 0,
      priceGp: src.price?.value?.gp ?? 0,
      damage: {
        dice: src.damage?.dice ?? 1,
        die: src.damage?.die ?? "d4",
        damageType: src.damage?.damageType ?? "slashing"
      },
      persistent: {
        enabled: !!per,
        number: per?.number ?? 1,
        faces: per?.faces ?? "d6",
        type: per?.type ?? "bleed"
      },
      runes: {
        potency: src.runes?.potency ?? 0,
        striking: src.runes?.striking ?? 0,
        property: [...(src.runes?.property ?? [])]
      },
      traits: [...(src.traits?.value ?? [])],
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
      sweAddRune: SimpleWeaponEditor.actAddRune,
      sweRemoveRune: SimpleWeaponEditor.actRemoveRune,
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

  async _prepareContext() {
    const d = this.data;
    const cfg = CONFIG.PF2E ?? {};
    const striking = Number(d.runes.striking) || 0;
    const potency = Number(d.runes.potency) || 0;
    const totalDice = (Number(d.damage.dice) || 1) + striking;
    const typeLabel = labelFor(cfg.damageTypes, d.damage.damageType);
    const overLimit = d.runes.property.length > potency;
    const preview = `${potency > 0 ? `+${potency} ` : ""}${totalDice}${d.damage.die} ${typeLabel}`;
    return {
      data: d,
      img: this.item.img,
      dies: DIES,
      damageTypes: locRecord(cfg.damageTypes),
      weaponTraits: locRecord(cfg.weaponTraits),
      propertyRunes: locRecord(cfg.weaponPropertyRunes),
      potencyOptions: [0, 1, 2, 3, 4],
      strikingOptions: [
        { value: 0, label: "—" },
        { value: 1, label: i18n("Striking1") },
        { value: 2, label: i18n("Striking2") },
        { value: 3, label: i18n("Striking3") }
      ],
      runesResolved: d.runes.property.map((slug) => ({
        slug,
        label: labelFor(cfg.weaponPropertyRunes, slug)
      })),
      traitsResolved: d.traits.map((slug) => ({
        slug,
        label: labelFor(cfg.weaponTraits, slug)
      })),
      preview,
      overLimit,
      potency,
      propCount: d.runes.property.length
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const form = this.element;
    for (const el of form.querySelectorAll("select, input[type=checkbox], input[type=number]")) {
      if (el.name === "runeToAdd" || el.name === "traitToAdd") continue;
      el.addEventListener("change", () => {
        this.syncFromForm();
        this.render();
      });
    }
  }

  syncFromForm() {
    const FDE = foundry.applications.ux?.FormDataExtended ?? FormDataExtended;
    const o = new FDE(this.element).object;
    delete o.runeToAdd;
    delete o.traitToAdd;
    const d = this.data;
    if (o.name !== undefined) d.name = String(o.name);
    if (o.level !== undefined) d.level = Number(o.level) || 0;
    if (o.priceGp !== undefined) d.priceGp = Number(o.priceGp) || 0;
    if (o.damage) {
      if (o.damage.dice !== undefined) d.damage.dice = Number(o.damage.dice) || 1;
      if (o.damage.die !== undefined) d.damage.die = String(o.damage.die);
      if (o.damage.damageType !== undefined) d.damage.damageType = String(o.damage.damageType);
    }
    if (o.persistent) {
      d.persistent.enabled = !!o.persistent.enabled;
      if (o.persistent.number !== undefined) d.persistent.number = Number(o.persistent.number) || 1;
      if (o.persistent.faces !== undefined) d.persistent.faces = o.persistent.faces || null;
      if (o.persistent.type !== undefined) d.persistent.type = String(o.persistent.type);
    }
    if (o.runes) {
      if (o.runes.potency !== undefined) d.runes.potency = Number(o.runes.potency) || 0;
      if (o.runes.striking !== undefined) d.runes.striking = Number(o.runes.striking) || 0;
    }
    d.freeMode = !!o.freeMode;
  }

  static actAddRune(event, target) {
    this.syncFromForm();
    const sel = this.element.querySelector('[name="runeToAdd"]');
    const slug = sel?.value;
    if (slug && !this.data.runes.property.includes(slug)) {
      this.data.runes.property.push(slug);
    }
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
    if (d.runes.property.length > (Number(d.runes.potency) || 0) && !d.freeMode) {
      ui.notifications.warn(i18n("OverLimitBlocked"));
      return;
    }
    const persistent = d.persistent.enabled
      ? {
          number: Number(d.persistent.number) || 1,
          faces: d.persistent.faces || null,
          type: d.persistent.type || "bleed"
        }
      : null;
    const update = {
      name: d.name || this.item.name,
      "system.level.value": Number(d.level) || 0,
      "system.price.value.gp": Number(d.priceGp) || 0,
      "system.damage.dice": Number(d.damage.dice) || 1,
      "system.damage.die": d.damage.die,
      "system.damage.damageType": d.damage.damageType,
      "system.damage.persistent": persistent,
      "system.runes.potency": Number(d.runes.potency) || 0,
      "system.runes.striking": Number(d.runes.striking) || 0,
      "system.runes.property": [...d.runes.property],
      "system.traits.value": [...d.traits]
    };
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
      new SimpleWeaponEditor(item).render(true);
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
  if (mod) mod.api = { open: (item) => new SimpleWeaponEditor(item).render(true) };
  console.log(`${MODULE_ID} | ready`);
});

Hooks.on("renderItemSheet", (app) => injectButton(app));
Hooks.on("renderItemSheetPF2e", (app) => injectButton(app));
