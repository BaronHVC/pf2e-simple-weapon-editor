import {
  MODULE_ID,
  i18n,
  labelFor,
  escHTML,
  targetName,
  dealtNote,
  GATE_MULT,
  HITCOND_EXCLUDED,
  isValuedCondition,
  actorMatchesCrit,
  isSoleExecutor,
  withHealQueue,
  applyTypedDamage,
  resolveTarget,
  rollSilentSave,
  applyConditionValue,
  postEngineSummary,
  RIDER_OPT,
  registerReactor,
  registerCritGate
} from "./main.js";
import { USES_FLAG, FORT_RUNE_DC, readDefense, armorMatchesCrit, isGearActive, activeRunesOf } from "./armor.js";

/* -------------------------------------------------------------------------- */
/*  Armor and shield reaction engine                                          */
/*                                                                            */
/*  What worn gear does while play happens: the editor's reaction cards       */
/*  (thorns, conditions, temporary HP, Shield Block retaliation), turn-start  */
/*  temporary HP with dice, and the property runes PF2e leaves inert because  */
/*  they answer an event - Fortification, Dread, Unnerving, Bitter and        */
/*  Advancing. PF2e has no "you were hit" hook, so the engine reads the chat  */
/*  messages the system already posts. main.js keeps the single               */
/*  createChatMessage dispatcher (the hero-point reroll carry has to land     */
/*  before anyone reads a mark) and calls the reactors registered here.       */
/*                                                                            */
/*  Everything that changes a document runs on the one active GM, like the    */
/*  weapon engines. Three small pieces run on every client because only that  */
/*  client knows the fact: the Shield Block stamp (the toggle lives on the    */
/*  client that applies the damage), the Critical button lock on a fortified  */
/*  card, and the daily frequency reset (the rest hook fires where the rest   */
/*  was taken). Each client also learns how far its clock is from the         */
/*  server's, which the Critical lock measures with.                          */
/*                                                                            */
/*  It reads the editor's flag through armor.js and writes only its own       */
/*  frequency stamps (reactUses) and marks on chat messages; the editor       */
/*  ignores both.                                                             */
/* -------------------------------------------------------------------------- */

// Rides on every damage the engine deals. The "damaged" trigger skips it, so
// two thorn wearers never trade blows forever.
const REACT_OPT = "swe-react";
// Stamped by the applyDamage wrapper on the client that applied the damage.
const BLOCK_OPT = "swe-dmg:shield-block";
const OUTCOME_OPT = "swe-dmg:outcome:";
// Reactions run once per attack, like the weapon riders. The mark holds the
// attack's d20 and total because the reroll memo copies every module mark to
// the rerolled card: a mark that does not match the dice is about another roll.
const ARMOR_DONE = "armorDone";
const FORT_FLAG = "fort";
// The card's flavor before fortification rewrote it, so a hero-point reroll
// of the flat check can put the critical hit back.
const FORT_FLAVOR = "fortFlavor";
const FORT_ID = "swe-fort:";
// A crit card with no verdict yet is locked for this long; past it the GM is
// taken to be gone and the table plays the crit.
const FORT_PENDING_MS = 20000;
// How long a Critical click waits for a verdict still being rolled.
const FORT_WAIT_MS = 3000;
// A Critical click on the sheet looks back this far for its attack.
const SHEET_CRIT_MS = 60000;
// Dread runes: the save DC and the value frightened cannot drop below on a
// failed save (greater: it does not drop at all).
const DREAD_RUNES = {
  lesserDread: { dc: 20, floor: 1 },
  moderateDread: { dc: 29, floor: 2 },
  greaterDread: { dc: 38, floor: Infinity }
};
const DREAD_HOLD = "swe-dread-hold";
const DREAD_RANGE = 30;
// The rune's traits. Bravery's predicate reads item:trait:fear, and saves
// against magic read item:magical, so the item forms go along as options.
const DREAD_TRAITS = ["emotion", "fear", "mental", "visual"];
const DREAD_OPTIONS = [...DREAD_TRAITS, "magical"].map((t) => `item:trait:${t}`).concat("item:magical");
// Conditions that stop a dread wearer from being seen.
const UNSEEN = ["invisible", "hidden", "undetected", "unnoticed"];
const FRIGHTENED_UUID = "Compendium.pf2e.conditionitems.Item.TBSHQspnbcqxsmjL";
const ENGULF_SLUG = "effect-engulf-and-swallow-whole";
const BLOCK_TRIGGERS = ["block", "blockHurt", "blockZero"];
const HP_PATHS = ["system.attributes.hp.value", "system.attributes.hp.temp", "system.attributes.hp.sp.value"];
const REACH_RE = /^item:trait:reach(-\d+)?$/;

function fmt(key, data) {
  return game.i18n.format(`SWE.${key}`, data);
}

/* ---------------------------------------------------------------- helpers */

function sameActor(a, b) {
  return !!a && !!b && (a === b || (!!a.uuid && a.uuid === b.uuid));
}

function armorsOf(actor) {
  return actor?.itemTypes?.armor ?? (actor?.items?.filter?.((i) => i.type === "armor") ?? []);
}

function gearOf(actor) {
  if (!actor) return [];
  if (actor.itemTypes) return [...(actor.itemTypes.armor ?? []), ...(actor.itemTypes.shield ?? [])];
  return actor.items?.filter?.((i) => i.type === "armor" || i.type === "shield") ?? [];
}

function runeLabel(slug) {
  const key = `PF2E.ArmorPropertyRune${slug.charAt(0).toUpperCase()}${slug.slice(1)}`;
  return game.i18n.has(key) ? game.i18n.localize(key) : slug;
}

function hasRune(actor, slug) {
  return armorsOf(actor).find((item) => isGearActive(item) && activeRunesOf(item).includes(slug)) ?? null;
}

// The attack roll's identity: its d20 and total.
function rollSig(message) {
  const roll = message?.rolls?.[0];
  if (!roll) return { d20: null, total: null };
  const die = roll.dice?.find?.((d) => d.faces === 20);
  const kept = die?.results?.find?.((r) => r.active && !r.discarded)?.result ?? die?.total ?? null;
  const total = Number(roll.total);
  return { d20: kept ?? null, total: Number.isFinite(total) ? total : null };
}

function sameSig(mark, sig) {
  return !!mark && typeof mark === "object" && mark.d20 === sig.d20 && mark.total === sig.total;
}

function isHidden(message) {
  return !!message?.blind || (message?.whisper?.length ?? 0) > 0;
}

// A token for an actor that has none of its own (a linked actor): first on
// the scene the event happened in, then wherever the canvas is.
function tokenOf(actor, scene = null) {
  if (!actor) return null;
  if (actor.token) return actor.token;
  const onScene = scene?.tokens?.find?.((t) => t.actorLink && t.actorId === actor.id);
  if (onScene) return onScene;
  return actor.getActiveTokens?.(true, true)?.[0] ?? null;
}

async function actorFromUuid(uuid) {
  if (!uuid) return null;
  return (await resolveTarget({ actor: uuid }))?.actor ?? null;
}

function gmIds() {
  return game.users.filter((u) => u.isGM).map((u) => u.id);
}

async function whisper(userIds, title, text, speaker) {
  if (!userIds.length) return null;
  try {
    return await ChatMessage.create({
      speaker,
      whisper: userIds,
      content: `<p><strong>${title}</strong></p><p>${text}</p>`
    });
  } catch (err) {
    console.error(`${MODULE_ID} | could not whisper a notice`, err);
    return null;
  }
}

// PF2e reads alliances; a world without them (or another actor type) falls
// back to token dispositions.
function areEnemies(a, b, aTok = null, bTok = null) {
  if (typeof a?.isEnemyOf === "function") return a.isEnemyOf(b);
  const D = CONST.TOKEN_DISPOSITIONS;
  const da = aTok?.disposition;
  const db = bTok?.disposition;
  return (da === D.FRIENDLY && db === D.HOSTILE) || (da === D.HOSTILE && db === D.FRIENDLY);
}

function combatOf(actor) {
  if (!actor) return null;
  for (const combat of game.combats ?? []) {
    if (!combat.started) continue;
    if (combat.combatants.some((c) => sameActor(c.actor, actor))) return combat;
  }
  return null;
}

function turnKey(combat) {
  return `${combat.id}:${combat.round}:${combat.turn}`;
}

function saveText(save, dc) {
  return `${escHTML(save.statLabel)} ${save.total ?? "?"} vs ${dc} (${i18n(`Dos${save.degree}`)})`;
}

function resultText(res) {
  if (res === "applied") return i18n("Applied");
  if (res === "already") return i18n("AlreadyHas");
  if (res === "immune") return i18n("Immune");
  return i18n("EngFailed");
}

function lossOf(applied, paths) {
  return (applied?.updates ?? [])
    .filter((u) => paths.includes(u?.path))
    .reduce((sum, u) => sum + Math.max(0, Number(u.value) || 0), 0);
}

function distanceFrom(options) {
  const opt = options.find((o) => o.startsWith("target:distance:"));
  const n = opt === undefined ? NaN : Number(opt.slice("target:distance:".length));
  return Number.isFinite(n) ? n : null;
}

// Foundry v14 ships a deletion operator; v13 still reads the "-=" key form.
function deletion(path) {
  if (globalThis._del !== undefined) return { [path]: globalThis._del };
  const i = path.lastIndexOf(".");
  return { [`${path.slice(0, i)}.-=${path.slice(i + 1)}`]: null };
}

/* ------------------------------------------------------------ temporary HP */

function currentTemp(actor) {
  return Math.max(0, Number(actor?._source?.system?.attributes?.hp?.temp) || 0);
}

// Temporary HP never stacks: a new amount replaces the old one only when it
// is higher. Read from the source, so a pending in-memory value cannot fake it.
async function setTempNow(actor, amount) {
  const update = { "system.attributes.hp.temp": amount };
  // A TempHP rule element zeroes temporary HP when its effect goes away, as
  // long as it is still named as their source; the engine's higher amount
  // must not vanish with an older effect.
  if (actor._source?.system?.attributes?.hp?.tempsource) {
    Object.assign(update, deletion("system.attributes.hp.tempsource"));
  }
  try {
    await actor.update(update);
    return true;
  } catch (err) {
    console.error(`${MODULE_ID} | could not grant temporary HP`, err);
    return false;
  }
}

// Queued with the healing of the same actor: both engines answer the same
// turn start, and two writes racing on the old HP lose one of them.
function grantTempHP(actor, amount) {
  return withHealQueue(actor, async () => {
    const before = currentTemp(actor);
    if (!(amount > before)) return { granted: false, before };
    return { granted: await setTempNow(actor, amount), before };
  });
}

async function tempAmount(temp, actor) {
  if (temp?.die) {
    const roll = await new Roll(`${temp.value}${temp.die}`).evaluate();
    return { amount: Math.max(0, Math.trunc(Number(roll.total) || 0)), text: `${temp.value}${temp.die}` };
  }
  const level = Math.max(0, Number(actor?.level) || 0);
  const n =
    temp?.scale === "level" ? level : temp?.scale === "halfLevel" ? Math.max(1, Math.floor(level / 2)) : Number(temp?.value) || 0;
  return { amount: n, text: String(n) };
}

/* -------------------------------------------------------------- frequency */

// Stamps in flight on this client. A stamp is staked the moment a card is
// chosen, before anything is awaited, so two events landing together cannot
// both pass the same "once per turn"; it is dropped once the flag holds it.
const _usesLocal = new Map();

function useKey(item, id) {
  return `${item.uuid}#${id}`;
}

function useStamp(item, id) {
  return _usesLocal.get(useKey(item, id)) ?? item._source?.flags?.[MODULE_ID]?.[USES_FLAG]?.[id] ?? null;
}

// Seconds of world time since a stamp, or null when it holds none: a rest for
// the night clears the time (eight hours pass that the clock never sees).
function stampAge(s) {
  const at = s?.at;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  return game.time.worldTime - at;
}

// Per turn and per round mean nothing outside combat, so they are always
// allowed there. "Round" is the reaction's sense: once until the wearer's
// next turn starts. Minute and hour follow the world clock, which only moves
// in combat or when the GM moves it, and come back with a rest for the night.
// A day ends with a rest for the night for a character; PF2e rests nobody
// else, so any other wearer gets the use back after 24 hours of world time.
function freqAllows(item, r, wearer) {
  if (r.freq === "always") return true;
  const s = useStamp(item, r.id);
  if (!s) return true;
  const combat = combatOf(wearer);
  if (r.freq === "turn") return !combat || s.turn !== turnKey(combat);
  // A round stamp left over from another encounter does not count here.
  if (r.freq === "round") return !combat || !s.roundUsed || !String(s.turn ?? "").startsWith(`${combat.id}:`);
  if (r.freq === "minute" || r.freq === "hour") {
    const age = stampAge(s);
    // A clock wound back past the stamp cannot say the use is still spent.
    return age === null || age < 0 || age >= (r.freq === "minute" ? 60 : 3600);
  }
  if (r.freq === "day") {
    if (!s.day) return true;
    if (wearer?.type === "character") return false;
    const age = stampAge(s);
    return age === null || age < 0 || age >= 86400;
  }
  return true;
}

function stampFor(r, wearer) {
  const combat = combatOf(wearer);
  return {
    turn: combat ? turnKey(combat) : "",
    roundUsed: r.freq === "round" && !!combat,
    at: game.time.worldTime,
    day: r.freq === "day"
  };
}

// What each stamp field reads once it is cleared: the flags go false, the
// time goes null (freqAllows reads a stamp without one as available).
const USE_RESET = { day: false, roundUsed: false, at: null };

// One write per item for all the fields named. A field already cleared is
// skipped; anything else is cleared, a time of 0 included.
async function clearUses(actor, fields, { ownedOnly = false } = {}) {
  const names = (Array.isArray(fields) ? fields : [fields]).filter((f) => f in USE_RESET);
  if (!names.length) return;
  for (const item of gearOf(actor)) {
    if (ownedOnly && !item.isOwner) continue;
    const uses = item._source?.flags?.[MODULE_ID]?.[USES_FLAG];
    if (!uses || typeof uses !== "object") continue;
    const update = {};
    for (const [id, s] of Object.entries(uses)) {
      if (!s || typeof s !== "object") continue;
      for (const field of names) {
        const v = s[field];
        if (v === undefined || v === null || v === false) continue;
        update[`flags.${MODULE_ID}.${USES_FLAG}.${id}.${field}`] = USE_RESET[field];
      }
    }
    if (!Object.keys(update).length) continue;
    try {
      await item.update(update);
    } catch (err) {
      console.error(`${MODULE_ID} | could not reset reaction uses`, err);
    }
  }
}

/* -------------------------------------------------------- reaction cards */

// An event is what one chat message says happened to the wearer W: who did
// it, which triggers fired, and what the attack's options tell the filters.
function attackMatches(attack, ev) {
  if (attack === "any") return true;
  if (attack === "strike") return ev.isStrike;
  const melee = ev.options.includes("item:melee");
  if (attack === "melee") return melee;
  if (attack === "meleeNoReach") return melee && !ev.options.some((o) => REACH_RE.test(o));
  if (attack === "adjacent") return isAdjacent(ev);
  return false;
}

// Adjacency read off the token documents, for when the GM running the engine
// has the canvas off or on another scene and the placeables do not exist: the
// two footprints touch (no square between them) at a similar height. Square
// footprints on any grid, so it is an approximation of the system's measure.
function docAdjacent(a, b) {
  const scene = a?.parent;
  if (!a || !b || !scene || b.parent !== scene) return false;
  const gs = Number(scene.grid?.size) || Number(scene.dimensions?.size) || 100;
  const gapX = Math.max(0, b.x - (a.x + a.width * gs), a.x - (b.x + b.width * gs));
  const gapY = Math.max(0, b.y - (a.y + a.height * gs), a.y - (b.y + b.height * gs));
  if (Math.max(gapX, gapY) >= gs / 2) return false;
  return Math.abs((Number(a.elevation) || 0) - (Number(b.elevation) || 0)) <= (Number(scene.grid?.distance) || 5);
}

// The damage roll records the distance to its target; damage applied later
// does not, so the tokens are asked instead: PF2e's own measure when they are
// drawn, their documents' positions when they are not.
function isAdjacent(ev) {
  if (Number.isFinite(ev.distance)) return ev.distance <= 5;
  const a = ev.atkTok?.object;
  const b = ev.wTok?.object;
  try {
    if (!a || !b) return docAdjacent(ev.atkTok, ev.wTok);
    return !!a.isAdjacentTo?.(b);
  } catch (err) {
    console.warn(`${MODULE_ID} | adjacency test failed`, err);
    return false;
  }
}

function shieldOf(actor) {
  return actor?.attributes?.shield ?? actor?.system?.attributes?.shield ?? null;
}

// Only the shield the wearer holds up is "raised"; a second shield is not.
function shieldRaised(wearer, item) {
  const s = shieldOf(wearer);
  return s?.itemId === item.id && !!s.raised;
}

function shieldHardness(wearer, item) {
  const s = shieldOf(wearer);
  if (s?.itemId === item.id && Number.isFinite(Number(s.hardness))) return Math.max(0, Number(s.hardness));
  return Math.max(0, Number(item.system?.hardness) || 0);
}

// "The attacker suffers X" is checked on the attacker the engine holds; every
// other requirement is the wearer's, as for turn-start healing.
function criteriaMet(r, ev) {
  return r.criteria.every((k) =>
    k.filter === "originCondition"
      ? !!ev.attacker && actorMatchesCrit(ev.attacker, { ...k, filter: "selfCondition" })
      : armorMatchesCrit(ev.W, k)
  );
}

function collectCards(ev) {
  const out = [];
  for (const item of gearOf(ev.W)) {
    if (!isGearActive(item)) continue;
    const isShield = item.type === "shield";
    for (const r of readDefense(item).reacts ?? []) {
      if (!ev.triggers.has(r.trigger)) continue;
      // A block answers with the shield that blocked, not any shield worn.
      if (BLOCK_TRIGGERS.includes(r.trigger) && (!isShield || ev.blockShieldId !== item.id)) continue;
      if (!attackMatches(r.attack, ev)) continue;
      if (isShield && r.raised && !shieldRaised(ev.W, item)) continue;
      if (!criteriaMet(r, ev)) continue;
      if (!freqAllows(item, r, ev.W)) continue;
      let key = null;
      if (r.freq !== "always") {
        key = useKey(item, r.id);
        _usesLocal.set(key, stampFor(r, ev.W));
      }
      out.push({ item, r, key });
    }
  }
  return out;
}

function cardLabel(item, r) {
  return escHTML(r.src || item.name);
}

async function rollCardSave(r, roller, origin, wearer) {
  // The wearer's DC when asked for; a wearer without one would make every
  // save succeed silently, so the card's fixed DC stays the fallback.
  const dc =
    r.save.mode === "auto" ? Number(wearer.system?.attributes?.classOrSpellDC?.value) || r.save.dc : r.save.dc;
  const save = await rollSilentSave(roller, r.save.type, dc, { origin });
  return { save, dc };
}

function reactOptions(item, wearer) {
  const opts = [];
  try {
    opts.push(...item.getRollOptions("item"), ...(wearer.getSelfRollOptions?.("origin") ?? []));
  } catch (err) {
    console.warn(`${MODULE_ID} | reaction roll options`, err);
  }
  return [...opts, REACT_OPT];
}

// A persistent rider has no meaningful half: a failed save (or no save)
// applies the condition, as for the weapon's gated persistent entries.
async function addPersistent(actor, formula, type) {
  const src = game.pf2e?.ConditionManager?.getCondition("persistent-damage")?.toObject();
  if (!src) return "failed";
  src.system.persistent = { formula, damageType: type, dc: 15 };
  try {
    const created = await actor.createEmbeddedDocuments("Item", [src]);
    return created?.length ? "applied" : "immune";
  } catch (err) {
    console.error(`${MODULE_ID} | persistent reaction damage failed`, err);
    return "failed";
  }
}

async function resolveDamageCard(ev, item, r) {
  const label = cardLabel(item, r);
  const d = r.damage;
  const hardness = d.amount === "hardness" ? shieldHardness(ev.W, item) : null;
  const formula =
    hardness !== null ? String(hardness) : d.die ? `${d.value}${d.die}${d.bonus ? `+${d.bonus}` : ""}` : String(d.value + d.bonus);
  const amountText = hardness !== null ? `${i18n("EngHardness")} (${hardness})` : formula;
  const what = `${amountText} ${escHTML(labelFor(CONFIG.PF2E?.damageTypes, d.type))}${d.persistent ? ` ${i18n("PersistentShort")}` : ""}`;
  if (!ev.attacker) return { line: `${label}: ${what} → ${i18n("EngNoAttacker")}`, used: false };
  const rname = targetName(ev.attacker, ev.atkTok);
  // PF2e builds the damage card from the token and fails without one; a
  // persistent condition is only an item and needs none.
  if (!ev.atkTok && !d.persistent) return { line: `${label}: ${what} → ${rname}: ${i18n("EngNoToken")}`, used: false };
  let save = null;
  let dc = null;
  if (r.save.type) {
    ({ save, dc } = await rollCardSave(r, ev.attacker, ev.W, ev.W));
    if (!save) return { line: `${label}: ${what} → ${rname}: ${i18n("NoStatistic")}`, used: true };
  }
  const saveInfo = save ? ` · ${saveText(save, dc)}` : "";
  if (d.persistent) {
    if (save && save.degree >= 2) return { line: `${label}: ${what} → ${rname}${saveInfo} → ${i18n("Resisted")}`, used: true };
    const res = await addPersistent(ev.attacker, formula, d.type);
    return { line: `${label}: ${what} → ${rname}${saveInfo} → ${resultText(res)}`, used: true };
  }
  const mult = save ? (GATE_MULT[r.save.out === "none" ? "none" : "half"][save.degree] ?? 1) : 1;
  if (mult === 0) return { line: `${label}: ${what} → ${rname}${saveInfo} → ${i18n("Resisted")}`, used: true };
  const amount = hardness ?? Math.max(0, Math.trunc(Number((await new Roll(formula).evaluate()).total) || 0));
  const final = Math.floor(amount * mult);
  if (!(final > 0)) return { line: `${label}: ${what} → ${rname}${saveInfo} → 0`, used: true };
  // Typed through the armor as the item: IWR applies, the card names the
  // armor as the source, and the queue keeps it from racing a weapon heal on
  // the attacker from the same blow.
  const dealt = await withHealQueue(ev.attacker, () =>
    applyTypedDamage(ev.attacker, ev.atkTok, final, d.type, item, reactOptions(item, ev.W))
  );
  const notes = `${mult === 0.5 ? ` (${i18n("SaveHalf")})` : ""}${mult === 2 ? " (x2)" : ""}`;
  return {
    line: `${label}: ${what} → ${rname}${saveInfo} → ${final} ${i18n("Applied")}${notes}${dealtNote(final, dealt)}`,
    used: true
  };
}

async function resolveConditionCard(ev, item, r) {
  const label = cardLabel(item, r);
  const slug = r.cond.slug;
  const valued = isValuedCondition(slug);
  const clabel = `${escHTML(labelFor(CONFIG.PF2E?.conditionTypes, slug))}${valued ? ` ${r.cond.value}` : ""}`;
  const toWearer = r.to === "wearer";
  const recipient = toWearer ? ev.W : ev.attacker;
  if (!recipient) return { line: `${label}: ${clabel} → ${i18n("EngNoAttacker")}`, used: false };
  if (HITCOND_EXCLUDED.has(slug)) return { line: `${label}: ${clabel} → ${i18n("EngFailed")}`, used: false };
  const rname = toWearer ? targetName(ev.W, ev.wTok) : targetName(ev.attacker, ev.atkTok);
  let saveInfo = "";
  if (r.save.type) {
    const { save, dc } = await rollCardSave(r, recipient, toWearer ? ev.attacker : ev.W, ev.W);
    if (!save) return { line: `${label}: ${clabel} → ${rname}: ${i18n("NoStatistic")}`, used: true };
    saveInfo = ` · ${saveText(save, dc)}`;
    const lands = r.save.out === "critFail" ? save.degree === 0 : save.degree <= 1;
    if (!lands) return { line: `${label}: ${clabel} → ${rname}${saveInfo} → ${i18n("Resisted")}`, used: true };
  }
  const res = await applyConditionValue(recipient, slug, valued ? r.cond.value : null);
  return { line: `${label}: ${clabel} → ${rname}${saveInfo} → ${resultText(res)}`, used: true };
}

async function resolveTempCard(ev, item, r) {
  const label = cardLabel(item, r);
  const { amount, text } = await tempAmount(r.temp, ev.W);
  const what = `${text} ${i18n("EngTempHp")}`;
  const wname = targetName(ev.W, ev.wTok);
  if (!(amount > 0)) return { line: `${label}: ${what} → ${wname} → 0`, used: true };
  const res = await grantTempHP(ev.W, amount);
  const outcome = res.granted ? `${amount} ${i18n("Applied")}` : fmt("EngTempNotHigher", { current: res.before });
  return { line: `${label}: ${what} → ${wname} → ${outcome}`, used: true };
}

function resolveCard(ev, item, r) {
  if (r.effect === "tempHp") return resolveTempCard(ev, item, r);
  if (r.effect === "condition") return resolveConditionCard(ev, item, r);
  return resolveDamageCard(ev, item, r);
}

// Resolves the chosen cards one after another and records the uses. A card
// that could not act (no attacker, no token) keeps its use.
async function runCards(ev, cards) {
  const lines = [];
  const writes = new Map();
  try {
    for (const card of cards) {
      let res;
      try {
        res = await resolveCard(ev, card.item, card.r);
      } catch (err) {
        console.error(`${MODULE_ID} | reaction failed`, err);
        res = { line: `${cardLabel(card.item, card.r)}: ${i18n("EngFailed")}`, used: false };
      }
      if (res?.line) lines.push(res.line);
      if (card.key && res?.used) {
        const update = writes.get(card.item) ?? {};
        update[`flags.${MODULE_ID}.${USES_FLAG}.${card.r.id}`] = _usesLocal.get(card.key);
        writes.set(card.item, update);
      }
    }
    for (const [item, update] of writes) {
      try {
        await item.update(update);
      } catch (err) {
        console.error(`${MODULE_ID} | could not record a reaction's use`, err);
      }
    }
  } finally {
    for (const card of cards) if (card.key) _usesLocal.delete(card.key);
  }
  return lines;
}

async function postReactions(ev, lines) {
  const title = ev.attacker ? `${i18n("EngReactTitle")} · ${targetName(ev.attacker, ev.atkTok)}` : i18n("EngReactTitle");
  await postEngineSummary({ actor: ev.W, token: ev.wTok, title, lines, sourceMessage: ev.sourceMessage });
}

async function markDone(doc, sig) {
  try {
    await doc.update({ [`flags.${MODULE_ID}.${ARMOR_DONE}`]: sig });
  } catch (err) {
    console.warn(`${MODULE_ID} | could not mark the reaction as done`, err);
  }
}

// Messages being handled right now on this client. The flag mark lands after
// an await, so two damage rolls for one attack arriving together would both
// pass it without this.
const _claims = new Set();

/* -------------------------------------------------------------- unnerving */

// "Before the end of your next turn": the effect counts the wearer's turns
// (its origin is the wearer, so it starts at the wearer's initiative). 0
// rounds if the wearer still acts this round, 1 if its turn is past or now.
function unnervingRounds(wearer) {
  const combat = combatOf(wearer);
  if (!combat) return 1;
  const idx = combat.turns.findIndex((c) => sameActor(c.actor, wearer));
  return idx > (combat.turn ?? -1) ? 0 : 1;
}

async function applyUnnerving(ev, armor) {
  const { W, attacker } = ev;
  const name = runeLabel("unnerving");
  const wKey = String(W.token?.id ?? W.id).toLowerCase();
  const slug = `swe-unnerved-${wKey}`;
  // A copy left by an earlier hit is replaced, never updated: the attacker's
  // own Strike may be deleting it at this very moment (removeAfterRoll).
  const stale = (attacker.itemTypes?.effect ?? []).filter(
    (e) => e.slug === slug || e.flags?.[MODULE_ID]?.unnervedBy === W.uuid
  );
  if (stale.length) {
    try {
      await attacker.deleteEmbeddedDocuments("Item", stale.map((e) => e.id));
    } catch (err) {
      console.warn(`${MODULE_ID} | could not remove an old unnerving effect`, err);
    }
  }
  const wname = targetName(W, ev.wTok);
  const source = {
    type: "effect",
    // The token's name, as the description: the actor's may be a secret the
    // token hides. Raw, since an item name is plain text, not HTML.
    name: fmt("EngUnnervedName", { wearer: ev.wTok?.name || W.name }),
    img: armor.img,
    system: {
      slug,
      description: { value: `<p>${fmt("EngUnnervedDesc", { wearer: wname })}</p>` },
      duration: { value: unnervingRounds(W), unit: "rounds", expiry: "turn-end", sustained: false },
      tokenIcon: { show: true },
      context: {
        origin: { actor: W.uuid, token: ev.wTok?.uuid ?? null, item: armor.uuid, spellcasting: null, rollOptions: [] },
        target: { actor: attacker.uuid, token: ev.atkTok?.uuid ?? null },
        roll: null
      },
      // Only melee Strikes against this wearer see the penalty, and the
      // system deletes the effect after the first Strike it actually hit.
      rules: [
        {
          key: "FlatModifier",
          slug: "swe-unnerving",
          selector: "melee-strike-attack-roll",
          type: "circumstance",
          value: -1,
          label: "PF2E.ArmorPropertyRuneUnnerving",
          predicate: [`target:signature:${W.signature}`],
          removeAfterRoll: "if-enabled"
        }
      ]
    },
    flags: { [MODULE_ID]: { unnervedBy: W.uuid } }
  };
  try {
    const created = await attacker.createEmbeddedDocuments("Item", [source]);
    if (!created?.length) return `${name}: ${targetName(attacker, ev.atkTok)} → ${i18n("Immune")}`;
  } catch (err) {
    console.error(`${MODULE_ID} | unnerving effect failed`, err);
    return `${name}: ${i18n("EngFailed")}`;
  }
  return `${name}: ${fmt("EngUnnervingLine", { attacker: targetName(attacker, ev.atkTok), wearer: wname })}`;
}

/* ------------------------------------------------ hit / crit (damage roll) */

// Damage rolled against a card that fortification turned into a hit: the
// table's Critical click (the GM's choice) is honoured, anyone else's is
// flagged so the GM applies it as a hit.
async function warnFortifiedCrit(message, ctx, origin) {
  if (ctx.outcome !== "criticalSuccess" || !origin) return;
  if (validFort(origin)?.result !== "success") return;
  if (message.author?.isGM) return;
  const target = await resolveTarget(origin.flags?.pf2e?.context?.target);
  const text = fmt("EngFortCritRolled", {
    actor: targetName(message.actor, message.token),
    target: target ? targetName(target.actor, target.tokenDoc) : "?"
  });
  await whisper(gmIds(), i18n("EngFortLabel"), text, ChatMessage.getSpeaker({ actor: message.actor, token: message.token }));
}

// The "damageRollPre" reactor, run before the weapon riders: a damage roll
// that beat the GM's flat check waits for the verdict, since both the riders
// (a fortified crit doubles nothing) and the reactions read it.
async function awaitFortVerdict(message, ctx, origin) {
  const pending = origin ? _fortPending.get(origin.id) : null;
  if (pending) await pending;
}

// "When hit" resolves when the attacker rolls damage against the wearer, the
// weapon riders' own timing: rerolls of the attack are settled by then, and
// a blow whose damage is never rolled fires nothing. Whether it hit (or
// crit) is read off the attack, after fortification had its say.
async function onDamageRoll(message, ctx, origin) {
  if (ctx?.type !== "damage-roll" || ctx.sourceType !== "attack") return;
  // A quick click can roll damage while the GM's flat check is still out;
  // the verdict decides what this damage was. awaitFortVerdict already waited
  // before the weapon riders, so this normally finds nothing pending.
  const pending = origin ? _fortPending.get(origin.id) : null;
  if (pending) await pending;
  await warnFortifiedCrit(message, ctx, origin);
  const outcome = origin?.flags?.pf2e?.context?.outcome ?? ctx.outcome;
  if (outcome !== "success" && outcome !== "criticalSuccess") return;
  if (!ctx.target?.actor) return;
  const target = await resolveTarget(ctx.target);
  const W = target?.actor;
  if (!W) return;
  const attacker = message.actor ?? null;
  if (attacker && sameActor(attacker, W)) return;
  const markOn = origin ?? message;
  const sig = origin ? rollSig(origin) : { d20: null, total: rollSig(message).total };
  if (sameSig(markOn.flags?.[MODULE_ID]?.[ARMOR_DONE], sig)) return;
  if (_claims.has(markOn.id)) return;
  _claims.add(markOn.id);
  try {
    const options = (ctx.options ?? []).map(String);
    const domains = (ctx.domains ?? []).map(String);
    const ev = {
      W,
      wTok: target.tokenDoc ?? tokenOf(W),
      attacker,
      atkTok: message.token ?? tokenOf(attacker),
      triggers: new Set(outcome === "criticalSuccess" ? ["hit", "crit"] : ["hit"]),
      options,
      isStrike: domains.includes("strike-damage"),
      distance: distanceFrom(options),
      blockShieldId: null,
      sourceMessage: message
    };
    const unnerving = attacker && domains.includes("melee-strike-damage") ? hasRune(W, "unnerving") : null;
    const cards = collectCards(ev);
    if (!cards.length && !unnerving) return;
    await markDone(markOn, sig);
    const lines = await runCards(ev, cards);
    if (unnerving) lines.push(await applyUnnerving(ev, unnerving));
    await postReactions(ev, lines);
  } finally {
    _claims.delete(markOn.id);
  }
}

/* --------------------------------------------- damaged / Shield Block */

async function reactToDamage(message, options, applied, W, source, loss) {
  const attacker = source && !sameActor(source, W) ? source : null;
  const blocked = options.includes(BLOCK_OPT);
  const triggers = new Set();
  // A weapon rider is part of the Strike whose own damage card fires
  // "damaged" once; counting each rider would answer one blow several times.
  if (loss > 0 && attacker && !options.includes(RIDER_OPT)) triggers.add("damaged");
  if (blocked) triggers.add("block");
  if ((Number(applied?.shield?.damage) || 0) > 0) triggers.add("blockHurt");
  if (blocked && loss === 0) triggers.add("blockZero");
  if (!triggers.size) return false;
  const wTok = message.token ?? tokenOf(W);
  const ev = {
    W,
    wTok,
    attacker,
    atkTok: attacker ? tokenOf(attacker, wTok?.parent) : null,
    triggers,
    options,
    // Applied damage keeps the item's options but not the roll's domains.
    isStrike: options.includes("item:type:weapon") || options.includes("item:type:melee"),
    distance: null,
    blockShieldId: applied?.shield?.id || shieldOf(W)?.itemId || null,
    sourceMessage: message
  };
  const cards = collectCards(ev);
  if (!cards.length) return false;
  const lines = await runCards(ev, cards);
  await postReactions(ev, lines);
  return true;
}

// Advancing is an activation the wearer chooses, so the engine only reminds
// them when their own damage drops an enemy to 0 HP.
async function remindAdvancing(message, W, victim, loss) {
  if (!(loss > 0)) return false;
  const hp = Number(victim.system?.attributes?.hp?.value);
  if (!Number.isFinite(hp) || hp > 0) return false;
  if (!areEnemies(W, victim, tokenOf(W, message.token?.parent), message.token)) return false;
  const armor = hasRune(W, "greaterAdvancing") ?? hasRune(W, "advancing");
  if (!armor) return false;
  const rune = activeRunesOf(armor).includes("greaterAdvancing") ? "greaterAdvancing" : "advancing";
  const recipients = game.users
    .filter((u) => u.isGM || W.testUserPermission?.(u, "OWNER"))
    .map((u) => u.id);
  const text = fmt("EngAdvancing", {
    wearer: escHTML(W.name),
    foe: targetName(victim, message.token),
    rune: runeLabel(rune),
    distance: i18n(rune === "greaterAdvancing" ? "EngAdvancingSpeed" : "EngAdvancing15")
  });
  await whisper(recipients, runeLabel(rune), text, ChatMessage.getSpeaker({ actor: W }));
  return true;
}

async function onDamageTaken(message, ctx) {
  if (ctx?.type !== "damage-taken") return;
  const options = (ctx.options ?? []).map(String);
  if (options.includes(REACT_OPT)) return;
  // Healing, and a heal at full health whose block toggle was left on.
  if (!(ctx.domains ?? []).includes("damage-received")) return;
  const applied = message.flags?.pf2e?.appliedDamage ?? null;
  if (applied?.isHealing || applied?.isReverted) return;
  if (message.flags?.[MODULE_ID]?.[ARMOR_DONE]) return;
  if (_claims.has(message.id)) return;
  _claims.add(message.id);
  try {
    // A block that absorbed everything leaves appliedDamage empty; the card's
    // speaker is still the wearer.
    const victim = (await actorFromUuid(applied?.uuid)) ?? message.actor ?? null;
    if (!victim) return;
    // Persistent damage names the sufferer as its own origin.
    const source = await actorFromUuid(message.flags?.pf2e?.origin?.actor);
    const loss = lossOf(applied, HP_PATHS);
    let acted = false;
    try {
      acted = await reactToDamage(message, options, applied, victim, source, loss);
    } catch (err) {
      console.error(`${MODULE_ID} | damage reactions failed`, err);
    }
    if (source && !sameActor(source, victim)) {
      try {
        acted = (await remindAdvancing(message, source, victim, loss)) || acted;
      } catch (err) {
        console.error(`${MODULE_ID} | advancing reminder failed`, err);
      }
    }
    if (acted) await markDone(message, { d20: null, total: loss });
  } finally {
    _claims.delete(message.id);
  }
}

/* ------------------------------------------------------ Shield Block stamp */

// The Shield Block toggle is client-local and consumed inside applyDamage:
// only the client applying the damage knows a block was asked for. The
// wrapper writes that fact into the damage-taken card's options, which reach
// the GM; it never acts on its own.
function stampDamageParams(actor, params) {
  if (!params || typeof params !== "object") return params;
  const extra = [];
  const shield = actor?.isOfType?.("character", "npc") ? shieldOf(actor) : null;
  // The same test applyDamage makes before letting the shield absorb.
  if (params.shieldBlockRequest && !params.final && shield?.raised && !shield.broken && !shield.destroyed) {
    extra.push(BLOCK_OPT);
  }
  if (typeof params.outcome === "string" && params.outcome) extra.push(`${OUTCOME_OPT}${params.outcome}`);
  if (!extra.length) return params;
  return { ...params, rollOptions: new Set([...(params.rollOptions ?? []), ...extra]) };
}

// Installed on whichever prototype owns applyDamage (ActorPF2e today), so
// every actor type and the contextual clones the chat buttons use go through
// it. Marked on the prototype, so a second call - or another module wrapping
// on top - never wraps twice.
function installShieldBlockStamp() {
  let proto = CONFIG.PF2E?.Actor?.documentClasses?.character?.prototype ?? null;
  while (proto && !Object.prototype.hasOwnProperty.call(proto, "applyDamage")) proto = Object.getPrototypeOf(proto);
  if (!proto || typeof proto.applyDamage !== "function" || proto._sweBlockStamped) return;
  const orig = proto.applyDamage;
  proto.applyDamage = function (params, ...rest) {
    let next = params;
    try {
      next = stampDamageParams(this, params);
    } catch (err) {
      console.warn(`${MODULE_ID} | shield block stamp`, err);
    }
    return orig.call(this, next, ...rest);
  };
  proto._sweBlockStamped = true;
}

/* ---------------------------------------------------------- fortification */

// Verdicts being rolled on this (the GM's) client, by attack message id.
const _fortPending = new Map();
// Cards waiting for their pending lock to lapse, so each is redrawn once.
const _fortTimers = new Set();

// The best fortification the wearer has on: the runes' DCs and the editor's
// generic DC, lowest wins - one flat check per critical hit.
function fortificationOf(actor) {
  let best = null;
  for (const item of armorsOf(actor)) {
    if (!isGearActive(item)) continue;
    const runes = activeRunesOf(item);
    const sources = Object.entries(FORT_RUNE_DC)
      .filter(([slug]) => runes.includes(slug))
      .map(([slug, dc]) => ({ dc, label: runeLabel(slug) }));
    const own = Number(readDefense(item).fort?.dc) || 0;
    if (own >= 1 && own <= 20) sources.push({ dc: own, label: i18n("EngFortLabel") });
    for (const s of sources) if (!best || s.dc < best.dc) best = s;
  }
  return best;
}

// A verdict counts only for the dice it was rolled for (the reroll memo
// copies it onto a rerolled card). A "success" also only stands on the card
// it rewrote: a reroll that kept a new die equal to the old one comes back
// from PF2e as a crit that was never checked - the rule main.js's
// isFortifiedHit applies. The module never writes a success beside a crit
// outcome (the rewrite sets both in one update), so nothing real is lost.
function validFort(message) {
  const fort = message?.flags?.[MODULE_ID]?.[FORT_FLAG];
  if (!fort || !sameSig(fort, rollSig(message))) return null;
  if (fort.result === "success" && message.flags?.pf2e?.context?.outcome === "criticalSuccess") return null;
  return fort;
}

function isSpellAttack(message, ctx) {
  return (ctx?.domains ?? []).includes("spell-attack-roll") || message.item?.type === "spell";
}

// The system's own "adjusted" result line, as a degree-of-success adjustment
// draws it: the crit kept as the unadjusted result, the hit beside it with the
// reason as its tooltip. Crit-only notes go, as the system's reroll drops
// notes for a degree no longer reached; notes for a plain hit were filtered
// out when the attack was rolled and cannot be brought back.
function hitFlavor(flavor, label, notes) {
  if (typeof flavor !== "string" || !flavor) return null;
  const wrap = document.createElement("div");
  wrap.innerHTML = flavor;
  const hitText = game.i18n.localize("PF2E.Check.Result.Degree.Attack.success");
  const result = wrap.querySelector(".target-dc-result .result") ?? wrap;
  let changed = false;
  const adjusted = result.querySelector("span.criticalSuccess.adjusted");
  if (adjusted) {
    adjusted.classList.replace("criticalSuccess", "success");
    adjusted.textContent = hitText;
    adjusted.dataset.tooltip = label;
    changed = true;
  } else {
    const crit = result.querySelector("span.criticalSuccess");
    if (crit) {
      crit.classList.replace("criticalSuccess", "unadjusted");
      const hit = document.createElement("span");
      hit.classList.add("success", "adjusted");
      hit.dataset.tooltip = label;
      if (crit.dataset.visibility) hit.dataset.visibility = crit.dataset.visibility;
      hit.textContent = hitText;
      crit.after(" ", hit);
      changed = true;
    }
  }
  // The card lists the notes in the order the context stores them; anything
  // else is left alone rather than guessed at.
  const list = wrap.querySelector("ul.notes");
  const items = list ? [...list.children].filter((el) => el.matches("li.roll-note")) : [];
  if (list && Array.isArray(notes) && items.length && items.length === notes.length) {
    items.forEach((li, i) => {
      const outcomes = notes[i]?.outcome ?? [];
      if (outcomes.length && !outcomes.includes("success")) {
        li.remove();
        changed = true;
      }
    });
    if (!list.querySelector("li")) list.remove();
  }
  return changed ? wrap.innerHTML : null;
}

// The card becomes a hit for everything that reads it: the damage cue moves
// to the Damage button, the result line reads "Hit (adjusted)", and the
// system, other modules and the weapon riders all see "success". Foundry
// redraws the buttons from the rolls only on a card with no content of its
// own; a hero-point reroll card keeps static content, so decorateFortCard
// moves its cue when the card is drawn.
async function rewriteAsHit(message, verdict) {
  const ctx = message.flags?.pf2e?.context ?? {};
  const rolls = message.rolls.map((r) => {
    const json = r.toJSON();
    json.options = { ...(json.options ?? {}), degreeOfSuccess: 2 };
    return json;
  });
  const update = {
    rolls,
    "flags.pf2e.context.outcome": "success",
    [`flags.${MODULE_ID}.${FORT_FLAG}`]: verdict
  };
  const flavor = hitFlavor(message.flavor, verdict.label, ctx.notes);
  if (flavor !== null) {
    update.flavor = flavor;
    update[`flags.${MODULE_ID}.${FORT_FLAVOR}`] = message.flavor;
  }
  await message.update(update);
}

async function revertToCrit(message, verdict) {
  const rolls = message.rolls.map((r) => {
    const json = r.toJSON();
    json.options = { ...(json.options ?? {}), degreeOfSuccess: 3 };
    return json;
  });
  const update = {
    rolls,
    "flags.pf2e.context.outcome": "criticalSuccess",
    [`flags.${MODULE_ID}.${FORT_FLAG}`]: verdict,
    [`flags.${MODULE_ID}.${FORT_FLAVOR}`]: null
  };
  const original = message.flags?.[MODULE_ID]?.[FORT_FLAVOR];
  if (typeof original === "string") update.flavor = original;
  await message.update(update);
}

// Spell damage is rolled from the spell, always as a hit, and the table
// doubles it by hand on a crit: rewriting the card cannot reach it.
async function noteSpellFortified(message, W, wTok) {
  const text = fmt("EngFortSpellX1", { item: escHTML(message.item?.name ?? ""), target: targetName(W, wTok) });
  await whisper(gmIds(), i18n("EngFortLabel"), text, ChatMessage.getSpeaker({ actor: W, token: wTok }));
}

// The connected player who plays the actor: the one whose character it is,
// else any other non-GM owner online.
function activePlayerOf(actor) {
  if (!actor) return null;
  const players = game.users.filter((u) => u.active && !u.isGM && actor.testUserPermission?.(u, "OWNER"));
  return players.find((u) => u.character?.id === actor.id) ?? players[0] ?? null;
}

async function rollFortification(message, ctx, W, wTok, fort) {
  const sig = rollSig(message);
  // A secret attack keeps its secret: the check goes to the GM only.
  const hidden = isHidden(message);
  // PF2e offers the hero-point reroll only to the card's author
  // (isRerollable), so a public check is posted as the wearer's player, who
  // could reroll their own flat check at the table. A secret one stays the
  // GM's: an author always sees their own card. The speaker is W either way.
  const author = hidden ? null : activePlayerOf(W);
  let flatMsg = null;
  let flatData = null;
  const flat = await game.pf2e.Check.roll(
    new game.pf2e.CheckModifier(fort.label, { modifiers: [] }),
    {
      actor: W,
      token: wTok ?? null,
      type: "flat-check",
      dc: { value: fort.dc, visible: true },
      identifier: `${FORT_ID}${message.id}`,
      skipDialog: true,
      traits: [],
      messageMode: hidden ? "gm" : "public",
      rollMode: hidden ? "gmroll" : "publicroll",
      createMessage: !author
    },
    null,
    // Without a message PF2e hands the callback an unsaved one built from the
    // roll's message data, its visibility already applied.
    (roll, outcome, msg) => {
      if (author) flatData = msg?.toObject?.() ?? null;
      else flatMsg = msg ?? null;
    }
  );
  if (!flat) return null;
  if (flatData) {
    // A GM may create a message under another user's name.
    flatData.author = author.id;
    try {
      flatMsg = await ChatMessage.implementation.create(flatData);
    } catch (err) {
      console.error(`${MODULE_ID} | could not post the fortification check`, err);
    }
  }
  const degree = Number(flat.degreeOfSuccess ?? flat.options?.degreeOfSuccess);
  const verdict = {
    result: degree >= 2 ? "success" : "failure",
    dc: fort.dc,
    d20: sig.d20,
    total: sig.total,
    flatMsg: flatMsg?.id ?? null,
    flat: Number(flat.total),
    label: fort.label
  };
  if (verdict.result === "success") {
    await rewriteAsHit(message, verdict);
    if (isSpellAttack(message, ctx)) await noteSpellFortified(message, W, wTok);
  } else {
    await message.update({ [`flags.${MODULE_ID}.${FORT_FLAG}`]: verdict });
  }
  return verdict.result;
}

// The "attack" reactor: every critical attack roll against a wearer with
// fortification gets its flat check, before anything reads the outcome.
async function onAttackRoll(message, ctx) {
  if (ctx?.type !== "attack-roll") return;
  const stored = message.flags?.[MODULE_ID]?.[FORT_FLAG];
  if (stored && validFort(message)) return;
  // Worked out and staked before anything is awaited: a damage roll that
  // arrives meanwhile waits for the verdict instead of reading the crit.
  const W = ctx.outcome === "criticalSuccess" ? targetActorSync(ctx.target) : null;
  const fort = W ? fortificationOf(W) : null;
  let settle = null;
  if (fort) {
    _fortPending.set(message.id, new Promise((resolve) => {
      settle = resolve;
    }));
  }
  let verdict = null;
  try {
    if (stored) {
      // Carried over from the card this reroll replaced: it judged other dice,
      // or it is a "success" on a crit PF2e drew again with the same dice.
      try {
        await message.update({ [`flags.${MODULE_ID}.${FORT_FLAG}`]: null, [`flags.${MODULE_ID}.${FORT_FLAVOR}`]: null });
      } catch (err) {
        console.warn(`${MODULE_ID} | could not clear a stale fortification mark`, err);
      }
    }
    if (!fort) return;
    const target = await resolveTarget(ctx.target);
    verdict = await rollFortification(message, ctx, target?.actor ?? W, target?.tokenDoc ?? null, fort);
  } catch (err) {
    console.error(`${MODULE_ID} | fortification failed`, err);
  } finally {
    if (settle) {
      _fortPending.delete(message.id);
      settle(verdict);
    }
  }
}

// A hero-point reroll of the flat check posts a new check with the same
// identifier: the card follows the new verdict either way.
async function onFlatCheckReroll(message) {
  const ctx = message?.flags?.pf2e?.context;
  if (ctx?.type !== "flat-check" || !ctx.isReroll) return;
  const id = String(ctx.identifier ?? "");
  if (!id.startsWith(FORT_ID)) return;
  const attack = game.messages.get(id.slice(FORT_ID.length));
  const fort = attack ? validFort(attack) : null;
  if (!fort) return;
  const success = ctx.outcome === "success" || ctx.outcome === "criticalSuccess";
  const verdict = {
    ...fort,
    result: success ? "success" : "failure",
    flatMsg: message.id,
    flat: Number(message.rolls?.[0]?.total)
  };
  verdict.label ??= i18n("EngFortLabel");
  if (success && fort.result !== "success") {
    await rewriteAsHit(attack, verdict);
    if (isSpellAttack(attack, attack.flags?.pf2e?.context)) {
      const target = await resolveTarget(attack.flags?.pf2e?.context?.target);
      if (target) await noteSpellFortified(attack, target.actor, target.tokenDoc);
    }
  } else if (!success && fort.result === "success") {
    await revertToCrit(attack, verdict);
  } else {
    await attack.update({ [`flags.${MODULE_ID}.${FORT_FLAG}`]: verdict });
  }
}

function targetActorSync(ref) {
  if (!ref) return null;
  try {
    const tok = ref.token ? fromUuidSync(ref.token) : null;
    if (tok?.actor) return tok.actor;
    const doc = ref.actor ? fromUuidSync(ref.actor) : null;
    return doc?.actor ?? doc ?? null;
  } catch (err) {
    console.warn(`${MODULE_ID} | could not resolve the attack's target`, err);
    return null;
  }
}

// A message's timestamp is the server's clock (epoch ms, stamped at
// creation), and this client's own clock may be off by any amount.
// game.time.serverTime cannot stand in for it: since v14 it counts from the
// world's launch, not from the epoch. So the offset is learned from the
// server stamp on each new message. A sample reads low by the trip's
// latency, so the highest of the last few is kept - which also keeps one
// message created with an old timestamp of its own from dragging it down.
// Until the first message arrives the offset is 0: the client's clock.
const _clockSkews = [];
const CLOCK_SAMPLES = 5;

function learnClockSkew(message) {
  const ts = Number(message?.timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return;
  _clockSkews.push(ts - Date.now());
  if (_clockSkews.length > CLOCK_SAMPLES) _clockSkews.shift();
}

function serverNow() {
  return Date.now() + (_clockSkews.length ? Math.max(..._clockSkews) : 0);
}

// How much longer a crit card stays locked waiting for its verdict (0: not
// waiting). Every client works it out from data it already has - the
// wearer's armor - so a fast click cannot beat the GM's update.
function fortPendingMs(message) {
  const ctx = message?.flags?.pf2e?.context;
  if (ctx?.type !== "attack-roll" || ctx.outcome !== "criticalSuccess") return 0;
  if (!game.users?.activeGM) return 0;
  const age = serverNow() - (Number(message.timestamp) || 0);
  if (!(age < FORT_PENDING_MS)) return 0;
  const W = targetActorSync(ctx.target);
  if (!W || !fortificationOf(W)) return 0;
  return FORT_PENDING_MS - Math.max(0, age);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The card's verdict, waiting up to maxMs while it is still being rolled.
async function fortVerdict(message, maxMs) {
  const id = message.id;
  const current = () => validFort(game.messages.get(id) ?? message);
  const now = current();
  if (now || !fortPendingMs(message)) return now;
  const local = _fortPending.get(id);
  if (local) {
    await Promise.race([local, sleep(maxMs)]);
    return current();
  }
  return new Promise((resolve) => {
    let timer = null;
    let hookId = null;
    const done = () => {
      clearTimeout(timer);
      Hooks.off("updateChatMessage", hookId);
      resolve(current());
    };
    hookId = Hooks.on("updateChatMessage", (m) => {
      if (m.id === id && validFort(m)) done();
    });
    timer = setTimeout(done, maxMs);
  });
}

function latestAttack(item) {
  const actor = item?.actor;
  if (!actor) return null;
  const msgs = game.messages.contents;
  const now = serverNow();
  for (let i = msgs.length - 1, scanned = 0; i >= 0 && scanned < 40; i--, scanned++) {
    const m = msgs[i];
    if (m.flags?.pf2e?.context?.type !== "attack-roll") continue;
    if (now - (Number(m.timestamp) || 0) > SHEET_CRIT_MS) return null;
    if (sameActor(m.actor, actor) && m.item?.id === item.id) return m;
  }
  return null;
}

// The Critical click on a character's Strike. A fortified attack rolls a
// hit's damage instead. The GM was told the card's Critical button forces
// the crit, so a GM click on the card is let through.
async function fortCritGate({ strike, originId }) {
  const message = originId ? game.messages.get(originId) : latestAttack(strike?.item);
  if (message?.flags?.pf2e?.context?.type !== "attack-roll") return false;
  if (originId && game.user.isGM) return false;
  const fort = await fortVerdict(message, FORT_WAIT_MS);
  if (fort?.result !== "success") return false;
  ui.notifications?.info(i18n("EngFortDowngraded"));
  return true;
}

function markButton(btn, icon, tooltip) {
  btn.dataset.tooltip = tooltip;
  btn.setAttribute("aria-label", tooltip);
  if (btn.querySelector(".swe-fort-icon")) return;
  const i = document.createElement("i");
  i.className = `fa-solid ${icon} swe-fort-icon`;
  btn.append(" ", i);
}

// Runs on every client as each card is drawn, before PF2e wires its buttons.
function decorateFortCard(message, html) {
  const ctx = message?.flags?.pf2e?.context;
  if (ctx?.type !== "attack-roll") return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  const btn = root?.querySelector?.('.message-buttons button[data-outcome="critical-success"]');
  if (!btn) return;
  const fort = validFort(message);
  if (fort?.result === "success") {
    // A reroll card's buttons are static content drawn for the crit, so its
    // cue still sits on Critical; a first-roll card was redrawn as a hit and
    // has none there. Moved here, before PF2e sorts out who sees the cue.
    const cue = btn.querySelector(".cue");
    const hitBtn = btn.closest(".message-buttons")?.querySelector('button[data-outcome="success"]');
    if (cue && hitBtn && !hitBtn.querySelector(".cue")) hitBtn.append(cue);
    if (game.user.isGM) {
      btn.classList.add("swe-fort-force");
      markButton(btn, "fa-shield-halved", i18n("EngFortGmForce"));
    } else {
      btn.disabled = true;
      markButton(btn, "fa-shield-halved", i18n("EngFortBlocked"));
    }
    return;
  }
  if (fort) return;
  const wait = fortPendingMs(message);
  if (!(wait > 0)) return;
  btn.disabled = true;
  markButton(btn, "fa-hourglass-half", i18n("EngFortPending"));
  // Redrawn once the wait lapses, in case the GM never answers.
  if (_fortTimers.has(message.id)) return;
  _fortTimers.add(message.id);
  setTimeout(() => {
    _fortTimers.delete(message.id);
    const m = game.messages.get(message.id);
    if (!m) return;
    try {
      ui.chat?.updateMessage?.(m);
    } catch (err) {
      console.warn(`${MODULE_ID} | could not redraw a fortified card`, err);
    }
  }, wait + 250);
}

/* ------------------------------------------------------------------ dread */

function dreadTierOf(actor) {
  let best = null;
  for (const item of armorsOf(actor)) {
    if (!isGearActive(item)) continue;
    for (const slug of activeRunesOf(item)) {
      const spec = DREAD_RUNES[slug];
      if (spec && (!best || spec.dc > best.dc)) best = { slug, ...spec };
    }
  }
  return best;
}

// The creature's own frightened, without the in-memory copy the hold grants.
function realFrightened(actor) {
  const stored = actor?.conditions?.stored ?? actor?.itemTypes?.condition ?? [];
  const vals = [...stored]
    .filter((c) => c.slug === "frightened" && actor.items?.has?.(c.id))
    .map((c) => Number(c.value) || 1);
  return vals.length ? Math.max(...vals) : 0;
}

function dreadHoldOf(actor) {
  return (actor?.itemTypes?.effect ?? []).find((e) => e.slug === DREAD_HOLD) ?? null;
}

function holdValueOf(effect) {
  const rule = (effect?._source?.system?.rules ?? []).find((r) => r?.key === "GrantItem");
  const alt = (rule?.alterations ?? []).find((a) => a?.property === "badge-value");
  return Math.max(0, Number(alt?.value) || 0);
}

function frightenedUuid() {
  const uuid = game.pf2e?.ConditionManager?.getCondition?.("frightened")?.uuid;
  return typeof uuid === "string" && uuid.startsWith("Compendium.") ? uuid : FRIGHTENED_UUID;
}

// The system's Spiral of Horrors pattern: an in-memory frightened at the held
// value. The effective value is the higher of it and the real condition, and
// lowering frightened by hand cannot touch the in-memory copy - so it holds
// whoever lowers frightened, and whenever.
function holdRule(value) {
  return {
    key: "GrantItem",
    uuid: frightenedUuid(),
    inMemoryOnly: true,
    alterations: [{ mode: "override", property: "badge-value", value }]
  };
}

async function deleteHold(actor, hold) {
  try {
    await actor.deleteEmbeddedDocuments("Item", [hold.id]);
  } catch (err) {
    console.warn(`${MODULE_ID} | could not remove the dread hold`, err);
  }
}

// The table lowers frightened by hand at the end of the turn, before or
// after this runs. The hold keeps the effective value at `value` through that
// decrement, so it is needed whenever `value` is not below the real
// condition (which is about to drop by one). Returns whether a hold binds.
async function setHold(actor, hold, real, value) {
  if (!(value > 0) || value < real) {
    if (hold) await deleteHold(actor, hold);
    return false;
  }
  if (hold) {
    if (holdValueOf(hold) !== value) await hold.update({ "system.rules": [holdRule(value)] });
    return true;
  }
  await actor.createEmbeddedDocuments("Item", [
    {
      type: "effect",
      name: i18n("EngDreadHoldName"),
      img: game.pf2e?.ConditionManager?.getCondition?.("frightened")?.img ?? "icons/svg/terror.svg",
      system: {
        slug: DREAD_HOLD,
        description: { value: `<p>${i18n("EngDreadHoldDesc")}</p>` },
        duration: { value: -1, unit: "encounter" },
        tokenIcon: { show: true },
        rules: [holdRule(value)]
      },
      flags: { [MODULE_ID]: { dreadHold: true } }
    }
  ]);
  return true;
}

function dreadCandidates(X, xTok, scene) {
  const out = [];
  for (const tok of scene?.tokens ?? []) {
    const W = tok.actor;
    if (!W || tok === xTok || sameActor(W, X)) continue;
    const tier = dreadTierOf(W);
    if (!tier || !areEnemies(W, X, tok, xTok)) continue;
    out.push({ actor: W, tok, tier });
  }
  return out;
}

// "Within 30 feet that can see you", approximated: PF2e's own distance, sight
// walls, a blinded creature, and a wearer unseen by everyone. Lighting and
// per-observer senses are not modelled.
function dreadReaches(c, X, xTok) {
  const a = c.tok.object;
  const b = xTok?.object;
  if (!a || !b || c.tok.hidden) return false;
  if (!(a.distanceTo(b) <= DREAD_RANGE)) return false;
  if (X.hasCondition?.("blinded")) return false;
  if (UNSEEN.some((s) => c.actor.hasCondition?.(s))) return false;
  try {
    const backend = CONFIG.Canvas?.polygonBackends?.sight;
    const from = { x: b.center.x, y: b.center.y, elevation: xTok.elevation ?? 0 };
    const to = { x: a.center.x, y: a.center.y, elevation: c.tok.elevation ?? 0 };
    if (backend?.testCollision(from, to, { type: "sight", mode: "any" })) return false;
  } catch (err) {
    console.warn(`${MODULE_ID} | dread sight test failed; treating the wearer as seen`, err);
  }
  return true;
}

// The highest degree a save total reaches against a DC, nat 20 and nat 1
// included.
function degreeAgainst(total, d20, dc) {
  let deg = total >= dc + 10 ? 3 : total >= dc ? 2 : total <= dc - 10 ? 0 : 1;
  if (d20 === 20) deg += 1;
  else if (d20 === 1) deg -= 1;
  return Math.max(0, Math.min(3, deg));
}

// PF2e never lowers frightened by itself; the table does it at the end of
// the creature's turn. The rune only says how far it may drop, so the engine
// rolls the save and holds the value - it never lowers frightened itself.
async function runDread(combatant) {
  const X = combatant?.actor;
  if (!X) return;
  const xTok = combatant.token ?? tokenOf(X);
  const real = realFrightened(X);
  const hold = dreadHoldOf(X);
  const V = Math.max(real, hold ? holdValueOf(hold) : 0);
  if (V <= 0) {
    if (hold) await deleteHold(X, hold);
    return;
  }
  const scene = xTok?.parent ?? combatant.parent?.scene ?? null;
  // A creature the GM keeps hidden must not show up in a public card.
  const secret = !!(combatant.hidden || xTok?.hidden);
  const candidates = dreadCandidates(X, xTok, scene);
  if (!candidates.length) {
    if (hold) await setHold(X, hold, real, V - 1);
    return;
  }
  // Range and sight need the tokens drawn; guessing them from another scene
  // would hold or release frightened at random. A skipped save is never a
  // failed one: a hold from an earlier turn steps down as with no wearer
  // near, so frightened decreases as usual. Every GM is told - a co-GM may be
  // running the fight - and the notice names the client that skipped it.
  if (!canvas?.ready || canvas.scene?.id !== scene?.id) {
    if (hold) await setHold(X, hold, real, V - 1);
    await whisper(
      gmIds(),
      i18n("EngDreadTitle"),
      fmt(canvas?.ready ? "EngDreadOtherScene" : "EngDreadNoCanvas", {
        name: targetName(X, xTok),
        gm: escHTML(game.user.name),
        scene: escHTML(scene?.name ?? "?")
      }),
      ChatMessage.getSpeaker({ actor: X, token: xTok })
    );
    return;
  }
  // A linked wearer with several tokens counts once.
  const wearers = [];
  for (const c of candidates) {
    if (wearers.some((w) => sameActor(w.actor, c.actor))) continue;
    if (dreadReaches(c, X, xTok)) wearers.push(c);
  }
  if (!wearers.length) {
    if (hold) await setHold(X, hold, real, V - 1);
    return;
  }
  wearers.sort((a, b) => b.tier.dc - a.tier.dc);
  const top = wearers[0];
  // One Will save, compared with every wearer's DC.
  const save = await rollSilentSave(X, "will", top.tier.dc, {
    origin: top.actor,
    traits: DREAD_TRAITS,
    extraRollOptions: DREAD_OPTIONS
  });
  const title = `${i18n("EngDreadTitle")} · ${targetName(X, xTok)}`;
  if (!save) {
    await postEngineSummary({ actor: X, token: xTok, title, lines: [i18n("NoStatistic")], gmOnly: secret });
    return;
  }
  const lines = [`${escHTML(save.statLabel)} ${save.total ?? "?"}`];
  let floor = 0;
  for (const w of wearers) {
    // The save was rolled against the highest DC: a lower DC is never harder,
    // and adjustments such as Bravery are only known for that one.
    const degree = w === top ? save.degree : Math.max(save.degree, degreeAgainst(save.total, save.d20, w.tier.dc));
    if (degree <= 1) floor = Math.max(floor, Math.min(V, w.tier.floor));
    lines.push(
      fmt("EngDreadWearer", {
        wearer: targetName(w.actor, w.tok),
        rune: runeLabel(w.tier.slug),
        dc: w.tier.dc,
        result: i18n(`Dos${degree}`)
      })
    );
  }
  const D = Math.max(V - 1, floor);
  const held = await setHold(X, hold, real, D);
  lines.push(held ? fmt("EngDreadHeld", { value: D }) : fmt("EngDreadDrops", { value: Math.max(0, V - 1) }));
  await postEngineSummary({ actor: X, token: xTok, title, lines, gmOnly: secret });
}

// At the creature's next turn the hold is spent once the real condition is
// at least as high (nobody lowered it).
async function releaseDreadHold(actor) {
  const hold = dreadHoldOf(actor);
  if (hold && holdValueOf(hold) <= realFrightened(actor)) await deleteHold(actor, hold);
}

/* ------------------------------------------------- turn-start temporary HP */

// Dice are the one thing PF2e's TempHP rule cannot take, so the editor emits
// a native rule for fixed amounts and leaves dice to this. Several cards do
// not stack: each is rolled, and the best one counts.
async function runTempTurnDice(actor) {
  const cards = [];
  for (const item of gearOf(actor)) {
    if (!isGearActive(item)) continue;
    for (const c of readDefense(item).conds) {
      if (c.effect !== "tempTurn" || !c.temp?.die) continue;
      if (c.criteria.every((k) => armorMatchesCrit(actor, k))) cards.push({ item, c });
    }
  }
  if (!cards.length) return;
  await withHealQueue(actor, async () => {
    const rolled = [];
    for (const { item, c } of cards) {
      const roll = await new Roll(`${c.temp.value}${c.temp.die}`).evaluate();
      rolled.push({ name: c.src || item.name, roll, total: Math.max(0, Math.trunc(Number(roll.total) || 0)) });
    }
    const best = rolled.reduce((a, b) => (b.total > a.total ? b : a));
    const before = currentTemp(actor);
    const granted = best.total > before ? await setTempNow(actor, best.total) : false;
    const now = granted ? best.total : before;
    const speaker = ChatMessage.getSpeaker({ actor });
    // Whispered to the actor's owners, GMs included, as PF2e's own TempHP rule
    // announces it: an NPC's gear and temporary HP stay the GM's. The "gm"
    // mode keeps a whisper list that is not empty.
    const owners = game.users.filter((u) => actor.testUserPermission(u, "OWNER")).map((u) => u.id);
    for (const r of rolled) {
      const result =
        granted && r === best ? fmt("EngTempGranted", { value: r.total }) : fmt("EngTempNotHigher", { current: now });
      await r.roll.toMessage(
        { speaker, flavor: `${i18n("ArmTempTurn")} · ${escHTML(r.name)} → ${result}`, whisper: owners },
        { messageMode: "gm" }
      );
    }
  });
}

/* ------------------------------------------------------------------ bitter */

// Engulf and Swallow Whole hand the victim one effect whose origin is the
// engulfer (when dragged from the monster's card). Sickened 1 lands only if
// the engulfer is not sickened already: raising an existing value would make
// it worse than the rune says.
async function runBitter(effect) {
  if (effect?.type !== "effect" || effect.slug !== ENGULF_SLUG) return;
  const W = effect.actor;
  if (!W || !hasRune(W, "bitter")) return;
  const wTok = tokenOf(W);
  const title = runeLabel("bitter");
  let engulfer = null;
  try {
    engulfer = effect.origin ?? null;
  } catch (err) {
    console.warn(`${MODULE_ID} | could not read the engulfer`, err);
  }
  if (!engulfer || sameActor(engulfer, W)) {
    await whisper(gmIds(), title, fmt("EngBitterNoOrigin", { wearer: targetName(W, wTok) }), ChatMessage.getSpeaker({ actor: W, token: wTok }));
    return;
  }
  const res = await applyConditionValue(engulfer, "sickened", 1);
  const clabel = escHTML(labelFor(CONFIG.PF2E?.conditionTypes, "sickened"));
  await postEngineSummary({
    actor: W,
    token: wTok,
    title,
    lines: [`${targetName(engulfer, tokenOf(engulfer, wTok?.parent))}: ${clabel} 1 → ${resultText(res)}`]
  });
}

/* ------------------------------------------------------------------- hooks */

registerReactor("attack", onAttackRoll);
registerReactor("damageRollPre", awaitFortVerdict);
registerReactor("damageRoll", onDamageRoll);
registerReactor("damageTaken", onDamageTaken);
registerCritGate(fortCritGate);

// Every client: the stamp must be on the client that applies the damage.
Hooks.once("init", installShieldBlockStamp);
Hooks.once("ready", installShieldBlockStamp);

Hooks.on("renderChatMessageHTML", (message, html) => {
  try {
    decorateFortCard(message, html);
  } catch (err) {
    console.warn(`${MODULE_ID} | fortified card`, err);
  }
});

Hooks.on("createChatMessage", async (message) => {
  // Every client: each one keeps its own clock offset for the pending lock.
  learnClockSkew(message);
  if (!isSoleExecutor()) return;
  try {
    await onFlatCheckReroll(message);
  } catch (err) {
    console.error(`${MODULE_ID} | fortification reroll failed`, err);
  }
});

Hooks.on("pf2e.endTurn", async (combatant) => {
  if (!isSoleExecutor()) return;
  try {
    await runDread(combatant);
  } catch (err) {
    console.error(`${MODULE_ID} | dread failed`, err);
  }
});

Hooks.on("pf2e.startTurn", async (combatant) => {
  if (!isSoleExecutor()) return;
  const actor = combatant?.actor;
  if (!actor) return;
  const steps = [
    ["dread hold", releaseDreadHold],
    ["round uses", (a) => clearUses(a, ["roundUsed"])],
    ["temporary HP", runTempTurnDice]
  ];
  for (const [what, step] of steps) {
    try {
      await step(actor);
    } catch (err) {
      console.error(`${MODULE_ID} | turn start (${what}) failed`, err);
    }
  }
});

// Fires only on the client that rested - often a player's - so it is not
// gated on the GM; it writes only gear that client owns. Eight hours pass in
// a night's rest, so once per minute and per hour come back too (as PF2e's
// own daily recharge refills every frequency up to eight hours).
Hooks.on("pf2e.restForTheNight", async (actor) => {
  try {
    await clearUses(actor, ["day", "at"], { ownedOnly: true });
  } catch (err) {
    console.error(`${MODULE_ID} | daily reaction reset failed`, err);
  }
});

Hooks.on("createItem", async (item) => {
  if (!isSoleExecutor()) return;
  try {
    await runBitter(item);
  } catch (err) {
    console.error(`${MODULE_ID} | bitter rune failed`, err);
  }
});
