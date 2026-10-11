import {
  MODULE_ID,
  i18n,
  labelFor,
  escHTML,
  targetName,
  dealtNote,
  GATE_MULT,
  DEGREE_OUTCOMES,
  HITCOND_EXCLUDED,
  isValuedCondition,
  actorMatchesCrit,
  isSoleExecutor,
  withHealQueue,
  applyTypedDamage,
  applyRollDamage,
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
/*                                                                            */
/*  A card marked "ask", and the runes whose use is the wearer's choice       */
/*  (Swallow-Spike, Deathless, Energy Adaptive, Spellwatch), are not          */
/*  resolved at the event: the event's card gets a row the wearer's owner or  */
/*  the GM answers. The click reaches the active GM through Foundry's user    */
/*  query, the GM checks everything again and resolves it with the same code  */
/*  as an automatic card. The GM is the only one who writes the card.         */
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
// The applyDamage wrapper names every damage type the blow carried (before
// IWR), so the GM can tell which energy the wearer just took.
const TYPE_OPT = "swe-dmg:type:";

// "Ask" prompts. The relay is Foundry's user query: no module socket, no
// manifest change, and the server names the sender.
const ASK_QUERY = `${MODULE_ID}.reactAsk`;
const ASK_FLAG = "ask";
// Out of combat a prompt lapses after this long; in combat, when the turn
// it was posted in ends.
const ASK_MS = 120000;
// The GM acknowledges before it rolls anything, so this only has to cover a
// round trip and a few lookups.
const ASK_TIMEOUT_MS = 10000;
// How many recent messages the GM's expiry sweep looks through.
const ASK_SCAN = 50;
// Row keys are random ids; anything else is never a row (they become flag
// paths, so a key with a dot must never reach an update).
const ASK_KEY_RE = /^[A-Za-z0-9]{1,32}$/;
const ASK_STATES = ["pending", "used", "declined", "expired", "spent", "gone", "failed"];
// What a click is told when the GM did not take the answer, by reason.
const ASK_REASONS = {
  answered: "EngAskErrAnswered",
  expired: "EngAskErrExpired",
  spent: "EngAskErrSpent",
  gone: "EngAskErrGone",
  effectGone: "EngAskErrSpellGone",
  notOwner: "EngAskErrOwner",
  notGM: "EngAskNoGM",
  busy: "EngAskErrBusy",
  target: "EngAskTarget",
  token: "EngAskErrToken",
  failed: "EngAskErrFailed"
};
// After these the row is settled, or never usable by this user: its buttons
// stay off. Anything else (busy, no target yet) can be tried again.
const ASK_FINAL = new Set(["answered", "expired", "spent", "gone", "notOwner"]);

// The player-choice runes.
const SAVE_TYPES = ["fortitude", "reflex", "will"];
const ADAPTIVE_TYPES = ["acid", "cold", "electricity", "fire"];
const DEATHLESS_SLUGS = ["doomed", "wounded"];
// "Grabbed, restrained, or otherwise held immobilized in a creature's grasp".
// Immobilized alone (nets, snares) is not a creature's grasp.
const GRAB_SLUGS = ["grabbed", "restrained"];
// Strongest first: a wearer with two armors uses the best tier.
const SWALLOW_TIERS = {
  majorSwallowSpike: { mod: 28, dice: 5, extra: 3 },
  greaterSwallowSpike: { mod: 22, dice: 3, extra: 2 },
  swallowSpike: { mod: 14, dice: 2, extra: 1 }
};
// The Engulf and Swallow Whole abilities whose text carries the Rupture value.
const RUPTURE_SLUGS = ["swallow-whole", "engulf"];

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

// Whose turn it is, by combatant: Foundry moves combat.turn (an index into
// the order) while the same creature keeps acting - a combatant added,
// deleted or rolling initiative mid-turn - and leaves it unchanged when the
// current combatant is deleted and the next one takes its place. A key on the
// index would end a turn that did not end and keep one that did.
function turnKey(combat) {
  return `${combat.id}:${combat.round}:${combat.combatant?.id ?? combat.turn}`;
}

// vs: the " vs <DC>" part as the card shows it. The cards' saves are against
// the wearer's own DC and show it; Spellwatch's are against an enemy
// caster's, which PF2e may keep from the players (gmSecret).
function saveText(save, dc, vs = ` vs ${dc}`) {
  return `${escHTML(save.statLabel)} ${save.total ?? "?"}${vs} (${i18n(`Dos${save.degree}`)})`;
}

// PF2e shows players the DC or AC of a creature only when a player owns it
// or the world's "show DCs" setting (metagame_showDC) is on; its own cards
// wrap the number for the GMs otherwise.
function dcVisible(owner) {
  return !!(game.pf2e?.settings?.metagame?.dcs || owner?.hasPlayerOwner);
}

// Such a number as a card shows it: wrapped for the GMs alone when the
// players may not see it (PF2e's chat render drops data-visibility="gm" for
// them). Decided when the line is written. A leading space stays outside the
// span: PF2e's visibility pass trims it, which glued "attack 20vs AC 5".
function gmSecret(html, owner) {
  if (dcVisible(owner)) return html;
  const lead = html.startsWith(" ") ? " " : "";
  return `${lead}<span data-visibility="gm">${html.slice(lead.length)}</span>`;
}

// An effect the GM keeps unidentified (an Alt-drop, the sheet's eye toggle):
// PF2e hides it from the players everywhere, so no card may name it to them.
function unidentified(effect) {
  return !!effect?.system?.unidentified || effect?.isIdentified === false;
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

function tempFixed(temp, actor) {
  const level = Math.max(0, Number(actor?.level) || 0);
  if (temp?.scale === "level") return level;
  if (temp?.scale === "halfLevel") return Math.max(1, Math.floor(level / 2));
  return Number(temp?.value) || 0;
}

// What a temporary HP card grants, as a prompt announces it before the roll.
function tempText(temp, actor) {
  return temp?.die ? `${temp.value}${temp.die}` : String(tempFixed(temp, actor));
}

async function tempAmount(temp, actor) {
  if (temp?.die) {
    const roll = await new Roll(`${temp.value}${temp.die}`).evaluate();
    return { amount: Math.max(0, Math.trunc(Number(roll.total) || 0)), text: `${temp.value}${temp.die}` };
  }
  const n = tempFixed(temp, actor);
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
      // A card that asks is staked when it is used, not while its prompt
      // waits: a prompt nobody answers must not hold the use. It still had to
      // pass freqAllows, so a spent card never prompts.
      if (r.freq !== "always" && !r.ask) {
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

// The wearer's DC when asked for; a wearer without one would make every
// save succeed silently, so the card's fixed DC stays the fallback.
function cardDC(r, wearer) {
  return r.save.mode === "auto" ? Number(wearer?.system?.attributes?.classOrSpellDC?.value) || r.save.dc : r.save.dc;
}

async function rollCardSave(r, roller, origin, wearer) {
  const dc = cardDC(r, wearer);
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

// The damage a card deals, as its result line and its prompt both name it.
function damageParts(ev, item, r) {
  const d = r.damage;
  const hardness = d.amount === "hardness" ? shieldHardness(ev.W, item) : null;
  const formula =
    hardness !== null ? String(hardness) : d.die ? `${d.value}${d.die}${d.bonus ? `+${d.bonus}` : ""}` : String(d.value + d.bonus);
  const amountText = hardness !== null ? `${i18n("EngHardness")} (${hardness})` : formula;
  const what = `${amountText} ${escHTML(labelFor(CONFIG.PF2E?.damageTypes, d.type))}${d.persistent ? ` ${i18n("PersistentShort")}` : ""}`;
  return { d, hardness, formula, what };
}

function condText(r) {
  const slug = r.cond.slug;
  return `${escHTML(labelFor(CONFIG.PF2E?.conditionTypes, slug))}${isValuedCondition(slug) ? ` ${r.cond.value}` : ""}`;
}

async function resolveDamageCard(ev, item, r) {
  const label = cardLabel(item, r);
  const { d, hardness, formula, what } = damageParts(ev, item, r);
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
  const clabel = condText(r);
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
    await recordUses(writes);
  } finally {
    for (const card of cards) if (card.key) _usesLocal.delete(card.key);
  }
  return lines;
}

// One write per item for the stamps a resolution earned: the cards' and the
// runes' alike.
async function recordUses(writes) {
  for (const [item, update] of writes) {
    try {
      await item.update(update);
    } catch (err) {
      console.error(`${MODULE_ID} | could not record a reaction's use`, err);
    }
  }
}

// The event's card: the automatic results, plus a row for each card that
// asks and each rune offer. Without rows it is exactly the phase 3 summary.
// The automatic results keep that summary's audience (public, or GM-only
// for a whispered or blind source) whatever joins them; a prompt has its own
// (askRecipients). When the two differ - an NPC wearer's prompt on a public
// event is GM-only, a secret event's prompt reaches the wearer's player -
// the results post on their own, unchanged, and the rows on a second card.
async function postReactions(ev, lines, asked = [], runeRows = []) {
  const title = ev.attacker ? `${i18n("EngReactTitle")} · ${targetName(ev.attacker, ev.atkTok)}` : i18n("EngReactTitle");
  const rows = [...asked.map((c) => cardRow(ev, c.item, c.r)), ...runeRows];
  const summary = () => postEngineSummary({ actor: ev.W, token: ev.wTok, title, lines, sourceMessage: ev.sourceMessage });
  if (!rows.length) {
    await summary();
    return;
  }
  let shared = lines;
  if (lines.length) {
    const auto = isHidden(ev.sourceMessage) ? gmIds() : null;
    const prompt = askRecipients(ev.W, isHidden(ev.sourceMessage) || !!ev.secret);
    if (!sameAudience(auto, prompt)) {
      await summary();
      shared = [];
    }
  }
  await postAskCard(ev, title, shared, rows);
}

// Two audiences as askRecipients gives them: null for the table, else the
// user ids a card is whispered to (postEngineSummary adds every GM to a list).
function sameAudience(a, b) {
  if (!a || !b) return !a && !b;
  const listed = (ids) => new Set([...gmIds(), ...ids]);
  const x = listed(a);
  const y = listed(b);
  return x.size === y.size && [...x].every((id) => y.has(id));
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

/* ------------------------------------------------------------ ask prompts */

// A row of the event's card that waits for the wearer's answer. Everything
// the GM needs to resolve it later is in the card's flag. The attack's
// options and distance are not kept: they only fed filters that already ran,
// and a reaction is judged at its trigger.
function pendingRow(fields) {
  return {
    kind: "rune",
    item: null,
    rid: null,
    trigger: null,
    rune: null,
    data: null,
    choices: null,
    label: "",
    offer: "",
    state: "pending",
    by: null,
    byName: null,
    at: null,
    result: null,
    ...fields
  };
}

// What Use will do, worded like the result line it becomes.
function cardOffer(ev, item, r) {
  const label = cardLabel(item, r);
  if (r.effect === "tempHp") return `${label}: ${tempText(r.temp, ev.W)} ${i18n("EngTempHp")} → ${targetName(ev.W, ev.wTok)}`;
  const toWearer = r.effect === "condition" && r.to === "wearer";
  const who = toWearer ? targetName(ev.W, ev.wTok) : ev.attacker ? targetName(ev.attacker, ev.atkTok) : "";
  const what = r.effect === "condition" ? condText(r) : damageParts(ev, item, r).what;
  const save = r.save.type
    ? ` · ${escHTML(labelFor(CONFIG.PF2E?.saves, r.save.type))} ${i18n("SaveDC")} ${cardDC(r, ev.W)}`
    : "";
  return `${label}: ${what}${who ? ` → ${who}` : ""}${save}`;
}

function cardRow(ev, item, r) {
  return pendingRow({
    kind: "card",
    item: item.uuid,
    rid: r.id,
    trigger: r.trigger,
    label: cardLabel(item, r),
    offer: cardOffer(ev, item, r)
  });
}

function askFlagOf(message) {
  const flag = message?.flags?.[MODULE_ID]?.[ASK_FLAG];
  return flag && typeof flag === "object" && flag.rows && typeof flag.rows === "object" ? flag : null;
}

function askRowOf(flag, key) {
  if (!flag || !ASK_KEY_RE.test(String(key ?? ""))) return null;
  return Object.prototype.hasOwnProperty.call(flag.rows, key) ? flag.rows[key] : null;
}

// The row as the card shows it. Offers and results are HTML the engine
// escaped when it built them; the answering user's name is escaped here.
// The buttons are never stored: each client draws its own (decorateAskCard).
function askRowHTML(key, row) {
  const state = ASK_STATES.includes(row?.state) ? row.state : "pending";
  const name = escHTML(row?.byName ?? "?");
  const offer = row?.offer ?? "";
  let text = offer;
  let note = "";
  if (state === "used") {
    text = row.result ?? offer;
    note = fmt("EngAskUsedBy", { name });
  } else if (state === "declined") {
    note = fmt("EngAskDeclined", { name });
  } else if (state === "expired") {
    note = i18n("EngAskExpired");
  } else if (state === "spent") {
    note = i18n("EngAskSpent");
  } else if (state === "gone") {
    text = row.result ?? offer;
    if (!row.result) note = i18n("EngAskGone");
  } else if (state === "failed") {
    text = row.result ?? `${row.label ?? ""}: ${i18n("EngFailed")}`;
  }
  const noteHTML = note ? ` <span class="swe-ask-note">(${note})</span>` : "";
  return (
    `<div class="swe-ask swe-ask-${state}" data-swe-ask-row="${key}">` +
    `<span class="swe-ask-text">${text}</span>${noteHTML}</div>`
  );
}

// The summary's own layout - the title, then the automatic results one per
// line - with a row below for each prompt. The GM rebuilds it from the flag
// after every answer.
function askCardHTML(flag) {
  const lines = flag.lines ?? [];
  const rows = Object.entries(flag.rows).map(([key, row]) => askRowHTML(key, row));
  return `<p><strong>${flag.title ?? ""}</strong></p>${lines.length ? `<p>${lines.join("<br>")}</p>` : ""}${rows.join("")}`;
}

// Who sees a prompt. A wearer no player owns is the GM's to answer, so its
// card goes to the GMs only. A secret event (a whispered or blind attack, a
// hidden token) still has to reach the wearer's player, who decides: every
// GM is listed too, since a whisper is invisible to anyone who is neither
// its author nor a recipient. null: the summary's own rule (public).
function askRecipients(W, hidden) {
  const players = game.users.filter((u) => !u.isGM && W.testUserPermission?.(u, "OWNER"));
  if (!players.length) return gmIds();
  if (!hidden) return null;
  return [...new Set([...gmIds(), ...players.map((u) => u.id)])];
}

// Posts the event's card with its rows; returns the message and the rows'
// keys in the order given.
async function postAskCard(ev, title, lines, rows) {
  const combat = combatOf(ev.W);
  const keys = [];
  while (keys.length < rows.length) {
    const key = foundry.utils.randomID(8);
    if (!keys.includes(key)) keys.push(key);
  }
  const flag = {
    v: 1,
    turn: combat ? turnKey(combat) : null,
    hidden: isHidden(ev.sourceMessage) || !!ev.secret,
    title,
    lines: [...lines],
    ev: {
      W: ev.W.uuid,
      wTok: ev.wTok?.uuid ?? null,
      attacker: ev.attacker?.uuid ?? null,
      atkTok: ev.atkTok?.uuid ?? null,
      triggers: [...(ev.triggers ?? [])],
      source: ev.sourceMessage?.id ?? null
    },
    rows: Object.fromEntries(rows.map((row, i) => [keys[i], row]))
  };
  // The rows are blocks below the results, so the card's whole content is
  // given; the lines still say the card is not empty.
  const args = {
    actor: ev.W,
    token: ev.wTok,
    title,
    lines: [...lines, ...Object.values(flag.rows).map((row) => row.offer)],
    content: askCardHTML(flag),
    sourceMessage: ev.sourceMessage ?? null,
    flags: { [MODULE_ID]: { [ASK_FLAG]: flag } }
  };
  const recipients = askRecipients(ev.W, flag.hidden);
  if (recipients) args.recipients = recipients;
  const message = await postEngineSummary(args);
  // Out of combat no turn change marks the moment a prompt lapses.
  if (message && !flag.turn) setTimeout(sweepAsks, ASK_MS + 1000);
  return { message, keys };
}

// Writes to one card run one after another on the GM: the content is rebuilt
// from the whole flag, so two answers written at once would each rebuild it
// without the other's row. `from` makes each change conditional on the row's
// state, read inside the queue. Resolves to the keys written.
const _askWrites = new Map();

function writeAsk(messageId, patches, { from = null } = {}) {
  const prev = _askWrites.get(messageId) ?? Promise.resolve();
  const run = prev.then(async () => {
    const message = game.messages.get(messageId);
    const flag = askFlagOf(message);
    if (!flag) return [];
    const next = foundry.utils.deepClone(flag);
    const update = {};
    const written = [];
    for (const [key, patch] of Object.entries(patches)) {
      const row = askRowOf(next, key);
      if (!row || (from && row.state !== from)) continue;
      Object.assign(row, patch);
      for (const [field, value] of Object.entries(patch)) {
        update[`flags.${MODULE_ID}.${ASK_FLAG}.rows.${key}.${field}`] = value;
      }
      written.push(key);
    }
    if (!written.length) return [];
    update.content = askCardHTML(next);
    await message.update(update);
    return written;
  });
  const tail = run.catch(() => {});
  _askWrites.set(messageId, tail);
  tail.then(() => {
    if (_askWrites.get(messageId) === tail) _askWrites.delete(messageId);
  });
  return run;
}

// Moves a pending row to its answer; false when it was no longer pending.
async function settleRow(messageId, key, patch) {
  return (await writeAsk(messageId, { [key]: patch }, { from: "pending" })).length > 0;
}

// In combat a prompt lasts until the turn it was posted in ends, or the
// combat does; out of combat, two minutes of the server's clock (a message's
// timestamp is the server's). Every client reads this to draw the buttons;
// the GM's answer has the final word.
function askExpired(message, flag = askFlagOf(message)) {
  if (!flag) return true;
  if (flag.turn) {
    const combat = game.combats?.get(String(flag.turn).split(":")[0]);
    return !combat?.started || turnKey(combat) !== flag.turn;
  }
  return serverNow() - (Number(message?.timestamp) || 0) > ASK_MS;
}

// The GM marks the lapsed prompts, so every client stops drawing buttons
// for them. Expired is final: anything later the GM resolves by hand.
async function sweepAsks() {
  if (!isSoleExecutor()) return;
  for (const message of game.messages.contents.slice(-ASK_SCAN)) {
    const flag = askFlagOf(message);
    if (!flag || !askExpired(message, flag)) continue;
    const keys = Object.keys(flag.rows).filter((k) => flag.rows[k]?.state === "pending");
    if (!keys.length) continue;
    try {
      await writeAsk(message.id, Object.fromEntries(keys.map((k) => [k, { state: "expired" }])), { from: "pending" });
    } catch (err) {
      console.error(`${MODULE_ID} | could not expire a reaction prompt`, err);
    }
  }
}

async function docFromUuid(uuid) {
  if (typeof uuid !== "string" || !uuid) return null;
  try {
    return await fromUuid(uuid);
  } catch (err) {
    console.warn(`${MODULE_ID} | could not resolve ${uuid}`, err);
    return null;
  }
}

// The event again, from the uuids the card kept.
async function askEvent(flag) {
  const e = flag.ev ?? {};
  const w = e.W ? await resolveTarget({ actor: e.W, token: e.wTok }) : null;
  const W = w?.actor ?? null;
  const wTok = w?.tokenDoc ?? tokenOf(W);
  const a = e.attacker ? await resolveTarget({ actor: e.attacker, token: e.atkTok }) : null;
  const attacker = a?.actor ?? null;
  return {
    W,
    wTok,
    attacker,
    atkTok: a?.tokenDoc ?? (attacker ? tokenOf(attacker, wTok?.parent) : null),
    triggers: new Set(Array.isArray(e.triggers) ? e.triggers : []),
    options: [],
    isStrike: false,
    distance: null,
    blockShieldId: null,
    sourceMessage: e.source ? (game.messages.get(e.source) ?? null) : null
  };
}

// A card row is resolved with the card as the GM holds it now: an edited
// number applies, a deleted or retargeted card does not resolve. The attack
// filters (adjacent, melee) are not checked again: they judged the trigger.
async function checkCardRow(ev, row, choice) {
  if (choice !== "use") return { ok: false, reason: "gone" };
  const item = await docFromUuid(row.item);
  const r = item ? readDefense(item).reacts.find((x) => x.id === row.rid) : null;
  if (!item || !sameActor(item.actor, ev.W) || !isGearActive(item) || !r || r.trigger !== row.trigger) {
    return { ok: false, reason: "gone", state: "gone" };
  }
  // Two prompts for one once-per-turn card: the second finds the use spent.
  if (!freqAllows(item, r, ev.W)) return { ok: false, reason: "spent", state: "spent" };
  return { ok: true, item, r, use: r };
}

async function checkRuneRow(ev, row, choice, data) {
  const handler = RUNE_ASKS[row.rune];
  if (!handler) return { ok: false, reason: "gone", state: "gone" };
  const choices = Array.isArray(row.choices) ? row.choices : [];
  if (choices.length ? !choices.some((c) => c?.id === choice) : choice !== "use") {
    // A Spellwatch button drawn before its spell was taken off the row: the
    // others may still be chosen.
    return { ok: false, reason: row.rune === "spellwatch" && choices.length ? "effectGone" : "gone" };
  }
  // Gone when the armor came off or lost its investment, or the rune was
  // removed, switched off in the editor or stripped by ABP.
  const item = await docFromUuid(row.item);
  if (
    !item ||
    item.type !== "armor" ||
    !sameActor(item.actor, ev.W) ||
    !isGearActive(item) ||
    !activeRunesOf(item).includes(row.rune)
  ) {
    return { ok: false, reason: "gone", state: "gone" };
  }
  const use = runeUse(row.rune);
  if (!freqAllows(item, use, ev.W)) return { ok: false, reason: "spent", state: "spent" };
  const extra = await handler.check(ev, row, choice, { item, target: data?.target ?? null });
  if (!extra?.ok) return extra ?? { ok: false, reason: "failed" };
  return { ...extra, ok: true, item, use };
}

// Answers taken right now on this (the GM's) client, by card and row.
const _askClaims = new Set();

// The active GM's answer to a click, local or relayed. It acknowledges as
// soon as the row is marked used and resolves afterwards, so rolls and 3D
// dice never hold the player's click past its timeout. Everything is read
// again here: the click only names the row and the choice.
async function answerAsk(data, user) {
  if (!isSoleExecutor()) return { ok: false, reason: "notGM" };
  const messageId = String(data?.messageId ?? "");
  const key = String(data?.key ?? "");
  const choice = String(data?.choice ?? "");
  if (!user || !ASK_KEY_RE.test(key)) return { ok: false, reason: "gone" };
  // Taken before anything is awaited: a player's and the GM's click arriving
  // together would otherwise both find the row pending.
  const claim = `${messageId}:${key}`;
  if (_askClaims.has(claim)) return { ok: false, reason: "busy" };
  _askClaims.add(claim);
  let stake = null;
  let job = null;
  try {
    const message = game.messages.get(messageId);
    const flag = askFlagOf(message);
    const row = askRowOf(flag, key);
    if (!row) return { ok: false, reason: "gone" };
    if (row.state !== "pending") return { ok: false, reason: "answered" };
    const ev = await askEvent(flag);
    if (!ev.W) {
      await settleRow(messageId, key, { state: "gone" });
      return { ok: false, reason: "gone" };
    }
    if (!(user.isGM || ev.W.testUserPermission?.(user, "OWNER"))) return { ok: false, reason: "notOwner" };
    if (askExpired(message, flag)) {
      await settleRow(messageId, key, { state: "expired" });
      return { ok: false, reason: "expired" };
    }
    const by = { by: user.id, byName: user.name, at: Date.now() };
    if (choice === "decline") {
      // Declining never spends a use.
      return (await settleRow(messageId, key, { state: "declined", ...by })) ? { ok: true } : { ok: false, reason: "answered" };
    }
    // Damage the table took back answers nothing.
    if (ev.sourceMessage?.flags?.pf2e?.appliedDamage?.isReverted) {
      await settleRow(messageId, key, { state: "gone" });
      return { ok: false, reason: "gone" };
    }
    const check = row.kind === "card" ? await checkCardRow(ev, row, choice) : await checkRuneRow(ev, row, choice, data);
    if (!check.ok) {
      // A final answer closes the row with its line; a patch changes a row
      // that stays open (a Spellwatch spell that ended loses its button).
      if (check.state) await settleRow(messageId, key, { state: check.state, result: check.line ?? null });
      else if (check.patch) await writeAsk(messageId, { [key]: check.patch }, { from: "pending" });
      return { ok: false, reason: check.reason ?? "failed" };
    }
    // Staked before "used" is written, as collectCards stakes an automatic
    // card: another event in the meantime finds the use taken.
    if (check.use.freq !== "always") {
      stake = useKey(check.item, check.use.id);
      _usesLocal.set(stake, stampFor(check.use, ev.W));
    }
    if (!(await settleRow(messageId, key, { state: "used", ...by }))) return { ok: false, reason: "answered" };
    check.whisper = [...(message.whisper ?? [])];
    job = { messageId, key, ev, row, choice, check, stake };
    return { ok: true };
  } catch (err) {
    console.error(`${MODULE_ID} | could not answer a reaction prompt`, err);
    return { ok: false, reason: "failed" };
  } finally {
    _askClaims.delete(claim);
    if (job) resolveAskRow(job);
    else if (stake) _usesLocal.delete(stake);
  }
}

// After the acknowledgement: "used" is already written, this adds the result
// line, and the stamp when the reaction actually acted.
async function resolveAskRow({ messageId, key, ev, row, choice, check, stake }) {
  let state = "used";
  let result = null;
  try {
    if (row.kind === "card") {
      // runCards stamps the use only when the card acted, and drops the stake.
      const lines = await runCards(ev, [{ item: check.item, r: check.r, key: stake }]);
      result = lines[0] ?? `${row.label}: ${i18n("EngFailed")}`;
    } else {
      const res = await RUNE_ASKS[row.rune].resolve(ev, row, choice, check);
      result = res?.line ?? `${row.label}: ${i18n("EngFailed")}`;
      if (stake && res?.used) {
        const update = { [`flags.${MODULE_ID}.${USES_FLAG}.${check.use.id}`]: _usesLocal.get(stake) };
        await recordUses(new Map([[check.item, update]]));
      }
    }
  } catch (err) {
    console.error(`${MODULE_ID} | reaction prompt failed`, err);
    state = "failed";
    result = `${row.label}: ${i18n("EngFailed")}`;
  } finally {
    if (stake) _usesLocal.delete(stake);
  }
  try {
    await writeAsk(messageId, { [key]: { state, result } });
  } catch (err) {
    console.error(`${MODULE_ID} | could not write a reaction's result`, err);
  }
}

/* --------------------------------------------------- ask prompts: clients */

// Clicks in flight on this client, and cards waiting for their prompt to
// lapse so each is redrawn once.
const _askClicks = new Set();
const _askTimers = new Set();

function setAskButtons(key, disabled) {
  for (const btn of document.querySelectorAll(`button[data-swe-ask="${key}"]`)) btn.disabled = disabled;
}

function appendAskNote(el, text, cls) {
  const span = document.createElement("span");
  span.className = `swe-ask-note ${cls}`;
  span.textContent = `(${text})`;
  el.append(" ", span);
}

function wearerNameSync(flag, W) {
  try {
    const tok = flag.ev?.wTok ? fromUuidSync(flag.ev.wTok) : null;
    return tok?.name ?? W?.name ?? "?";
  } catch (err) {
    console.warn(`${MODULE_ID} | could not read the wearer's token`, err);
    return W?.name ?? "?";
  }
}

// Buttons carry data-swe-ask, never data-action: PF2e binds every
// button[data-action] in a chat card with its own throttle and owner gate.
function askButtons(messageId, key, row) {
  const box = document.createElement("span");
  box.className = "swe-ask-buttons";
  const choices = Array.isArray(row.choices) && row.choices.length ? row.choices : [{ id: "use", label: i18n("EngAskUse") }];
  for (const c of [...choices, { id: "decline", label: i18n("EngAskDecline") }]) {
    const id = String(c?.id ?? "");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = id === "decline" ? "swe-ask-decline" : "swe-ask-use";
    btn.dataset.sweAsk = key;
    btn.dataset.choice = id;
    // A label may hold a name a user typed (a spell effect's): text, never HTML.
    // One that names an enemy caster's DC has a plain form for a player PF2e
    // keeps that DC from (dcVisible).
    const showDc = game.user.isGM || !!game.pf2e?.settings?.metagame?.dcs || !!c?.casterOwned;
    btn.textContent = String((c?.plain && !showDc ? c.plain : c?.label) ?? id);
    btn.addEventListener("click", (event) => onAskClick(event, messageId, key, id));
    box.append(btn);
  }
  // Swallow-Spike with no creature named, or one only guessed from a grapple
  // check: the clicker's target decides.
  const swallowHint = !SWALLOW_TIERS[row.rune]
    ? null
    : !row.data?.grabber
      ? "EngAskTarget"
      : row.data.from === "hint"
        ? "EngAskRetarget"
        : null;
  if (swallowHint) {
    const hint = document.createElement("span");
    hint.className = "swe-ask-hint";
    hint.textContent = i18n(swallowHint);
    box.append(" ", hint);
  }
  return box;
}

function scheduleAskRedraw(message) {
  if (_askTimers.has(message.id)) return;
  const wait = ASK_MS - (serverNow() - (Number(message.timestamp) || 0));
  if (!(wait > 0)) return;
  _askTimers.add(message.id);
  setTimeout(() => {
    _askTimers.delete(message.id);
    const m = game.messages.get(message.id);
    if (!m) return;
    try {
      ui.chat?.updateMessage?.(m);
    } catch (err) {
      console.warn(`${MODULE_ID} | could not redraw a reaction prompt`, err);
    }
  }, wait + 250);
}

// Runs on every client as each card is drawn: the buttons are drawn for the
// viewer - the wearer's owners and the GMs - and everyone else reads who the
// card waits for. A prompt past its time loses its buttons here at once; the
// GM's sweep then writes it.
function decorateAskCard(message, html) {
  const flag = askFlagOf(message);
  if (!flag) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root?.querySelector) return;
  const pending = Object.entries(flag.rows).filter(([key, row]) => row?.state === "pending" && ASK_KEY_RE.test(key));
  if (!pending.length) return;
  const expired = askExpired(message, flag);
  const W = targetActorSync({ actor: flag.ev?.W, token: flag.ev?.wTok });
  const canAnswer = game.user.isGM || !!W?.testUserPermission?.(game.user, "OWNER");
  for (const [key, row] of pending) {
    const el = root.querySelector(`[data-swe-ask-row="${key}"]`);
    if (!el || el.querySelector(".swe-ask-buttons, .swe-ask-wait")) continue;
    if (expired) {
      el.classList.replace("swe-ask-pending", "swe-ask-expired");
      appendAskNote(el, i18n("EngAskExpired"), "swe-ask-wait");
    } else if (!canAnswer) {
      el.classList.add("swe-ask-waiting");
      appendAskNote(el, fmt("EngAskWaiting", { name: wearerNameSync(flag, W) }), "swe-ask-wait");
    } else {
      el.append(" ", askButtons(message.id, key, row));
    }
  }
  if (!expired && !flag.turn) scheduleAskRedraw(message);
}

async function onAskClick(event, messageId, key, choice) {
  event.preventDefault();
  event.stopPropagation();
  const guard = `${messageId}:${key}`;
  if (_askClicks.has(guard)) return;
  const row = askRowOf(askFlagOf(game.messages.get(messageId)), key);
  if (row?.state !== "pending") return;
  // Swallow-Spike: the clicker's single target names the creature when the
  // trigger's origin could not (or the one it named is gone), and replaces
  // the creature guessed from a grapple check.
  let target = null;
  if (SWALLOW_TIERS[row.rune] && choice !== "decline") {
    const targets = [...(game.user.targets ?? [])];
    target = targets.length === 1 ? (targets[0]?.document?.uuid ?? null) : null;
    if (!target && !row.data?.grabber) {
      ui.notifications?.warn(i18n("EngAskTarget"));
      return;
    }
  }
  _askClicks.add(guard);
  setAskButtons(key, true);
  let settled = false;
  try {
    const data = { messageId, key, choice, target };
    let res;
    if (isSoleExecutor()) {
      res = await answerAsk(data, game.user);
    } else {
      const gm = game.users.activeGM;
      if (!gm) throw new Error(i18n("EngAskNoGM"));
      // Foundry without user queries, or a world that took QUERY_USER from
      // players: only a GM's click gets through.
      if (!CONFIG.queries?.[ASK_QUERY] || typeof gm.query !== "function" || !game.user.hasPermission?.("QUERY_USER")) {
        throw new Error(i18n("EngAskNoRelay"));
      }
      res = await gm.query(ASK_QUERY, data, { timeout: ASK_TIMEOUT_MS });
    }
    if (res?.ok) {
      settled = true;
    } else {
      // The card's state is what counts: anything but ok is reported, and the
      // GM's write (if any) redraws the row.
      const reason = String(res?.reason ?? "failed");
      ui.notifications?.warn(i18n(ASK_REASONS[reason] ?? "EngAskErrFailed"));
      settled = ASK_FINAL.has(reason);
    }
  } catch (err) {
    console.warn(`${MODULE_ID} | a reaction prompt answer did not reach the GM`, err);
    ui.notifications?.warn(err?.message || i18n("EngAskErrFailed"));
  } finally {
    _askClicks.delete(guard);
    if (!settled) setAskButtons(key, false);
  }
}

/* -------------------------------------------------- player-choice runes */

// A rune's frequency rides on the armor's reactUses stamps under a
// pseudo-card id: freqAllows and stampFor only read .id and .freq, and the
// rest and turn-start resets already cover them.
function runeUse(slug) {
  return { id: `rune-${slug}`, freq: RUNE_ASKS[slug]?.freq ?? "always" };
}

function runeRow(armor, slug, fields) {
  return pendingRow({ kind: "rune", item: armor.uuid, rune: slug, label: escHTML(runeLabel(slug)), ...fields });
}

// An effect's origin names the creature behind it - but it falls back to the
// bearer when the effect has no context, and is null for a compendium
// origin. Neither names anyone.
function originOf(doc, W) {
  try {
    const origin = doc?.origin ?? null;
    return origin && !sameActor(origin, W) ? origin : null;
  } catch (err) {
    console.warn(`${MODULE_ID} | could not read an effect's origin`, err);
    return null;
  }
}

function refNameSync(ref) {
  try {
    const tok = ref?.token ? fromUuidSync(ref.token) : null;
    const doc = tok?.actor ?? (ref?.actor ? fromUuidSync(ref.actor) : null);
    const name = tok?.name ?? doc?.name;
    return name ? escHTML(name) : null;
  } catch (err) {
    console.warn(`${MODULE_ID} | could not name a creature`, err);
    return null;
  }
}

function conditionValue(cond) {
  return Math.max(0, Number(cond?._source?.system?.value?.value ?? cond?.value) || 0);
}

async function showDice(roll, whisper = []) {
  if (!game.dice3d || !roll) return;
  try {
    await game.dice3d.showForRoll(roll, game.user, true, whisper?.length ? whisper : null);
  } catch (err) {
    console.warn(`${MODULE_ID} | 3D dice could not show the roll`, err);
  }
}

function attackResult(degree) {
  const key = `PF2E.Check.Result.Degree.Attack.${DEGREE_OUTCOMES[degree]}`;
  return game.i18n.has(key) ? game.i18n.localize(key) : i18n(`Dos${degree}`);
}

function runeEvent(W, wTok) {
  return {
    W,
    wTok,
    attacker: null,
    atkTok: null,
    triggers: new Set(),
    sourceMessage: null,
    // A token the GM keeps hidden must not show its prompt to the table.
    secret: !!wTok?.hidden
  };
}

// Rune offers born of an item being created, not of a chat message. One
// creation fires its createItem callbacks one after another without a pause,
// so rows gathered until the next microtask land in one card per wearer: a
// doomed and a wounded added together give one card with two rows.
const _runeBatches = new Map();

// secret: the offer names something the GM keeps from the table (a hidden
// grabber, a grapple check rolled in private); one such row makes the whole
// card secret, which sends it to the GMs and the wearer's owners only.
function queueRuneRow(W, row, onPosted = null, { secret = false } = {}) {
  const key = W.uuid;
  let batch = _runeBatches.get(key);
  if (!batch) {
    batch = { W, entries: [], secret: false };
    _runeBatches.set(key, batch);
    queueMicrotask(() => {
      _runeBatches.delete(key);
      postRuneBatch(batch);
    });
  }
  batch.secret ||= !!secret;
  batch.entries.push({ row, onPosted });
}

async function postRuneBatch({ W, entries, secret }) {
  let posted = null;
  try {
    const runes = new Set(entries.map((e) => e.row.rune));
    const title = runes.size === 1 ? entries[0].row.label : i18n("EngReactTitle");
    const ev = runeEvent(W, tokenOf(W));
    ev.secret ||= !!secret;
    posted = await postAskCard(ev, title, [], entries.map((e) => e.row));
  } catch (err) {
    console.error(`${MODULE_ID} | could not post a rune prompt`, err);
  }
  entries.forEach((e, i) => {
    try {
      e.onPosted?.(posted?.message ?? null, posted?.keys?.[i] ?? null);
    } catch (err) {
      console.warn(`${MODULE_ID} | rune prompt bookkeeping`, err);
    }
  });
}

// Called from the GM's createItem hook, before anything is awaited, so the
// rows of one creation are gathered together.
function detectRuneAsks(item) {
  const W = item?.actor;
  if (!W || item.pack || W.pack) return;
  if (item.type === "condition") detectDeathless(item, W);
  detectSwallow(item, W);
}

/* ------------------------------------------------- rune: Energy Adaptive */

// The type the armor's resistance is set to now; null when none is on.
function adaptiveSelection(armor) {
  const rule = (armor?._source?.system?.rules ?? []).find(
    (r) => r?.key === "RollOption" && r.option === "energy-adaptive" && r.toggleable
  );
  return rule?.value === true && typeof rule.selection === "string" ? rule.selection : null;
}

// The offer rides on the damage-taken event's card. The types are those the
// blow carried before IWR (the wrapper's stamps), so a type the wearer fully
// resisted is still offered - harmless, the wearer chooses. The type already
// on is left out: choosing it again would spend the hour for nothing.
function adaptiveRows(W, options, loss) {
  if (!(loss > 0)) return [];
  const armor = hasRune(W, "energyAdaptive");
  if (!armor || !freqAllows(armor, runeUse("energyAdaptive"), W)) return [];
  const taken = new Set(options.filter((o) => o.startsWith(TYPE_OPT)).map((o) => o.slice(TYPE_OPT.length)));
  const current = adaptiveSelection(armor);
  const types = ADAPTIVE_TYPES.filter((t) => taken.has(t) && t !== current && W.isAffectedBy?.(t) !== false);
  if (!types.length) return [];
  const names = types.map((t) => labelFor(CONFIG.PF2E?.damageTypes, t));
  const label = escHTML(runeLabel("energyAdaptive"));
  return [
    runeRow(armor, "energyAdaptive", {
      data: { types },
      choices: types.map((t, i) => ({ id: t, label: names[i] })),
      offer: fmt("EngAdaptiveOffer", { rune: label, types: names.map(escHTML).join(" / ") })
    })
  ];
}

async function checkAdaptive() {
  return { ok: true };
}

// The rune's toggle on the Actions tab: the module's RollOption rule with a
// suboption per type. The system writes value and selection into the armor's
// rules, the editor keeps that state on its next save, and the resistance
// rule reads it. It lands after the damage, so it never applies to the
// triggering damage.
async function resolveAdaptive(ev, row, choice, { item }) {
  const type = escHTML(labelFor(CONFIG.PF2E?.damageTypes, choice));
  if (adaptiveSelection(item) === choice) return { line: fmt("EngAdaptiveAlready", { rune: row.label, type }), used: false };
  const res = await ev.W.toggleRollOption("all", "energy-adaptive", item.id, true, choice);
  if (res !== true) return { line: `${row.label}: ${i18n("EngAdaptiveNoRule")}`, used: false };
  return { line: fmt("EngAdaptiveDone", { rune: row.label, type }), used: true };
}

/* ------------------------------------------------------- rune: Deathless */

// Only a condition that is new counts as gained (a rise in its value does
// not): PF2e never adds doomed or wounded by itself, and increaseCondition
// creates the item when there is none.
function detectDeathless(item, W) {
  if (!DEATHLESS_SLUGS.includes(item.slug)) return;
  const armor = hasRune(W, "deathless");
  if (!armor || !freqAllows(armor, runeUse("deathless"), W)) return;
  const value = conditionValue(item) || 1;
  // A condition another item keeps (a grant that restricts its removal) can
  // still go down from 2, but at 1 lowering it means removing it, which PF2e
  // refuses: there is nothing to offer.
  if (value <= 1 && lockedCondition(item)) return;
  const label = escHTML(runeLabel("deathless"));
  const clabel = escHTML(labelFor(CONFIG.PF2E?.conditionTypes, item.slug));
  let offer = fmt("EngDeathlessOffer", { rune: label, condition: clabel, from: value, to: value - 1 });
  // PF2e does not reliably drop the wearer unconscious before wounded lands,
  // so being unconscious is a warning for the table, not a bar.
  if (W.hasCondition?.("unconscious")) offer += ` · ${i18n("EngAskUnconscious")}`;
  queueRuneRow(W, runeRow(armor, "deathless", { data: { cond: item.id, slug: item.slug }, offer }));
}

async function checkDeathless(ev, row) {
  const cond = ev.W.items.get(row.data?.cond ?? "");
  if (cond?.type !== "condition" || cond.slug !== row.data?.slug) {
    const clabel = escHTML(labelFor(CONFIG.PF2E?.conditionTypes, row.data?.slug ?? ""));
    return { ok: false, reason: "gone", state: "gone", line: `${row.label}: ${clabel} → ${i18n("EngAskGone")}` };
  }
  return { ok: true };
}

function lockedCondition(cond) {
  try {
    return !!cond?.isLocked;
  } catch (err) {
    console.warn(`${MODULE_ID} | could not read whether a condition is locked`, err);
    return false;
  }
}

// The system's own decrease: one less on the stored value, the condition
// deleted at 0. The day is spent only when the value actually went down: a
// grant that restricts the condition's removal makes PF2e skip the deletion
// with nothing but a warning.
async function resolveDeathless(ev, row) {
  const cond = ev.W.items.get(row.data?.cond ?? "");
  const clabel = escHTML(labelFor(CONFIG.PF2E?.conditionTypes, row.data?.slug ?? ""));
  if (cond?.type !== "condition") return { line: `${row.label}: ${clabel} → ${i18n("EngAskGone")}`, used: false };
  const from = conditionValue(cond) || 1;
  await ev.W.decreaseCondition(cond);
  const left = ev.W.items.get(cond.id);
  const to = left ? conditionValue(left) : 0;
  if (!(to < from)) return { line: fmt("EngDeathlessKept", { rune: row.label, condition: clabel, value: from }), used: false };
  return { line: fmt("EngDeathlessDone", { rune: row.label, condition: clabel, from, to }), used: true };
}

/* --------------------------------------------------- rune: Swallow-Spike */

function swallowTierOf(W) {
  const armors = armorsOf(W).filter((a) => isGearActive(a));
  for (const slug of Object.keys(SWALLOW_TIERS)) {
    const armor = armors.find((a) => activeRunesOf(a).includes(slug));
    if (armor) return { armor, slug };
  }
  return null;
}

// The attack and damage bonus is the armor's potency rune; under ABP the
// level's defense potency, which takes the rune's place.
function swallowBonus(armor, W) {
  const ABP = game.pf2e?.variantRules?.AutomaticBonusProgression;
  try {
    if (ABP?.isEnabled?.(W)) return Math.max(0, Number(ABP.getDefensePotency?.(Number(W?.level) || 0)) || 0);
  } catch (err) {
    console.warn(`${MODULE_ID} | automatic bonus progression lookup failed`, err);
  }
  return Math.max(0, Number(armor?.system?.runes?.potency) || 0);
}

function swallowDamageText(tier, bonus, engulfed) {
  const piercing = `${tier.dice}d6${bonus ? `+${2 * bonus}` : ""} ${escHTML(labelFor(CONFIG.PF2E?.damageTypes, "piercing"))}`;
  if (!engulfed) return piercing;
  return `${piercing} + ${tier.extra}d6 ${escHTML(labelFor(CONFIG.PF2E?.damageTypes, "untyped"))}`;
}

// One DamageRoll, built the way PF2e writes its own: instances in braces, a
// critical hit doubled as "2 * (...)", or under the "double the dice"
// variant with "[doubled]" dice and "2 * " modifiers. Those shapes are how
// PF2e finds the half that immunity to critical hits takes back off. The
// untyped dice only while swallowed or engulfed.
function swallowFormula(tier, bonus, engulfed, crit) {
  let doubleDice = false;
  try {
    doubleDice = crit && game.settings.get("pf2e", "critRule") === "doubledice";
  } catch (err) {
    console.warn(`${MODULE_ID} | could not read the critical hit rule`, err);
  }
  const part = (dice, mod) => {
    if (doubleDice) return `(${dice * 2}d6[doubled]${mod ? ` + 2 * ${mod}` : ""})`;
    const body = mod ? `${dice}d6 + ${mod}` : `${dice}d6`;
    if (!crit) return `(${body})`;
    return mod ? `(2 * (${body}))` : `(2 * ${body})`;
  };
  const parts = [`${part(tier.dice, 2 * bonus)}[piercing]`];
  if (engulfed) parts.push(`${part(tier.extra, 0)}[untyped]`);
  return `{${parts.join(",")}}`;
}

// The grabbed condition never says who grabbed. The Grapple check that put
// it there does: its speaker is the grappler and its target the wearer. Only
// a recent success counts. It is a guess: the offer names the creature, and
// the clicker's single target replaces it (checkSwallow). hidden: the check
// was rolled in private or blind, or by a token the GM keeps hidden.
function latestGrapple(W) {
  const msgs = game.messages.contents;
  const now = serverNow();
  for (let i = msgs.length - 1, scanned = 0; i >= 0 && scanned < 30; i--, scanned++) {
    const m = msgs[i];
    if (now - (Number(m.timestamp) || 0) > ASK_MS) return null;
    const ctx = m.flags?.pf2e?.context;
    if (ctx?.type !== "skill-check" || !(ctx.options ?? []).includes("action:grapple")) continue;
    if (ctx.outcome !== "success" && ctx.outcome !== "criticalSuccess") continue;
    if (!sameActor(targetActorSync(ctx.target), W)) continue;
    const grappler = m.actor;
    if (!grappler || sameActor(grappler, W)) continue;
    return { ref: { actor: grappler.uuid, token: m.token?.uuid ?? null }, hidden: isHidden(m) || !!m.token?.hidden };
  }
  return null;
}

// A token the GM keeps hidden, by uuid.
function tokenHidden(uuid) {
  if (typeof uuid !== "string" || !uuid) return false;
  try {
    return !!fromUuidSync(uuid)?.hidden;
  } catch (err) {
    console.warn(`${MODULE_ID} | could not read a token's visibility`, err);
    return false;
  }
}

// One pending Swallow-Spike row per wearer: a second grab while the first
// prompt waits adds nothing. Staked the moment the trigger is seen (the
// card's reference arrives once it is posted) and dropped once that row is
// no longer pending.
const _swallowPending = new Map();

function swallowBusy(W) {
  const p = _swallowPending.get(W.uuid);
  if (!p) return false;
  if (!p.ref) {
    if (Date.now() - p.at < ASK_TIMEOUT_MS) return true;
  } else {
    const m = game.messages.get(p.ref.messageId);
    const flag = askFlagOf(m);
    if (askRowOf(flag, p.ref.key)?.state === "pending" && !askExpired(m, flag)) return true;
  }
  _swallowPending.delete(W.uuid);
  return false;
}

// Triggers: a grabbed or restrained condition of its own, or an effect whose
// creation leaves one granted by it (Engulf and Swallow Whole, a stored grant
// such as Impaling Chain). Foundry prepares the actor again before the
// createItem callbacks, so those grants are already there; a condition an
// effect granted is that effect's trigger, never a second one, and an effect
// that grants no hold (the engulf's own remaining-air effect) is none.
function detectSwallow(item, W) {
  let effect = null;
  if (item.type === "condition") {
    if (!GRAB_SLUGS.includes(item.slug) || item.flags?.pf2e?.grantedBy) return;
  } else if (item.type === "effect" || item.type === "affliction") {
    const holds =
      W.conditions?.filter?.((c) => GRAB_SLUGS.includes(c.slug) && c.flags?.pf2e?.grantedBy?.id === item.id) ?? [];
    if (!holds.length) return;
    effect = item;
  } else {
    return;
  }
  const tier = swallowTierOf(W);
  if (!tier || swallowBusy(W)) return;
  const wTok = tokenOf(W);
  const origin = originOf(item, W);
  let grabber = null;
  let from = null;
  let secret = false;
  if (origin) {
    const token = item.system?.context?.origin?.token ?? tokenOf(origin, wTok?.parent)?.uuid ?? null;
    grabber = { actor: origin.uuid, token };
    from = "origin";
  } else if (!effect) {
    // A Grapple check ends in a grabbed condition put on by hand. An effect
    // that holds (an engulf, a swallow, a chain) comes from no grapple check,
    // so an older check never names its creature: the clicker targets it.
    const hint = latestGrapple(W);
    if (hint) {
      grabber = hint.ref;
      from = "hint";
      secret = hint.hidden;
    }
  }
  // The offer names the creature, which a hidden token must not show the table.
  secret ||= tokenHidden(grabber?.token);
  const spec = SWALLOW_TIERS[tier.slug];
  const bonus = swallowBonus(tier.armor, W);
  const engulfed = effect?.slug === ENGULF_SLUG;
  const label = escHTML(runeLabel(tier.slug));
  const mod = `+${spec.mod + bonus}`;
  const damage = swallowDamageText(spec, bonus, engulfed);
  const name = grabber ? refNameSync(grabber) : null;
  const offer = name
    ? fmt("EngSwallowOffer", { rune: label, mod, target: name, damage })
    : fmt("EngSwallowOfferAny", { rune: label, mod, damage });
  _swallowPending.set(W.uuid, { ref: null, at: Date.now() });
  const row = runeRow(tier.armor, tier.slug, { data: { engulfed, effect: effect?.id ?? null, grabber, from }, offer });
  queueRuneRow(
    W,
    row,
    (message, key) => {
      if (message && key) _swallowPending.set(W.uuid, { ref: { messageId: message.id, key }, at: Date.now() });
      else _swallowPending.delete(W.uuid);
    },
    { secret }
  );
}

// The creature attacked, in this order: the one the trigger's origin names
// (the effect's or the condition's - a fact), else the clicker's single
// target on the wearer's scene, else the creature of the grapple check (a
// guess the target overrides; never for an effect, which no grapple check
// made). It needs a token on the wearer's scene, since PF2e builds the damage
// card from it. The result line names the creature actually attacked.
async function checkSwallow(ev, row, choice, { target }) {
  const W = ev.W;
  const data = row.data ?? {};
  const held = W.hasCondition?.("grabbed", "restrained") || (!!data.effect && W.items.has(data.effect));
  if (!held) return { ok: false, reason: "gone", state: "gone", line: fmt("EngSwallowNotHeld", { rune: row.label }) };
  // The token the trigger recorded may be on another scene; a linked
  // creature may also stand on the wearer's.
  const scene = ev.wTok?.parent ?? null;
  const onScene = (tok) => !!tok && (!scene || !tok.parent || tok.parent.id === scene.id);
  let grabber = null;
  let gTok = null;
  const take = async (ref) => {
    const found = ref?.actor ? await resolveTarget(ref) : null;
    if (found?.actor && !sameActor(found.actor, W)) {
      grabber = found.actor;
      gTok = found.tokenDoc ?? null;
    }
  };
  if (data.grabber && data.from !== "hint") await take(data.grabber);
  if (!grabber && typeof target === "string" && target) {
    const doc = await docFromUuid(target);
    if (doc?.documentName === "Token" && doc.actor && !sameActor(doc.actor, W) && onScene(doc)) {
      grabber = doc.actor;
      gTok = doc;
    }
  }
  if (!grabber && data.grabber && data.from === "hint" && !data.effect) await take(data.grabber);
  if (!grabber) return { ok: false, reason: "target" };
  if (!onScene(gTok)) gTok = tokenOf(grabber, scene);
  if (!onScene(gTok)) return { ok: false, reason: "token" };
  return { ok: true, grabber, gTok };
}

// The engulf effect that holds the wearer in this creature, if any.
function engulfOf(W, grabber, data) {
  const own = data?.effect ? W.items.get(data.effect) : null;
  if (own?.slug === ENGULF_SLUG) return own;
  return (
    (W.itemTypes?.effect ?? []).find((e) => {
      if (e.slug !== ENGULF_SLUG) return false;
      const origin = originOf(e, W);
      return !origin || sameActor(origin, grabber);
    }) ?? null
  );
}

// Rupture is plain text in the ability (Monster Core: "Rupture 20"). Another
// wording is not guessed at: the card then says to compare by hand.
function ruptureOf(actor) {
  for (const item of actor?.items ?? []) {
    const slug =
      item.slug ?? String(item.name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!RUPTURE_SLUGS.includes(slug)) continue;
    const text = String(item.system?.description?.value ?? "").replace(/<[^>]*>/g, " ");
    const m = /Rupture\s*(\d+)/i.exec(text);
    if (m) return Number(m[1]);
  }
  return null;
}

// taken: the damage the creature took after IWR (applyRollDamage), which the
// HP it had left does not cap.
async function ruptureNote(W, grabber, engulf, taken) {
  const value = ruptureOf(grabber);
  if (value === null) return i18n("EngSwallowRupture");
  if (!(taken >= value)) return fmt("EngSwallowNotFree", { value });
  if (W.items.has(engulf.id)) {
    try {
      // The effect takes the grabbed and slowed it grants with it.
      await W.deleteEmbeddedDocuments("Item", [engulf.id]);
    } catch (err) {
      console.error(`${MODULE_ID} | could not cut the wearer free`, err);
      return `${fmt("EngSwallowFree", { value })}: ${i18n("EngFailed")}`;
    }
  }
  return fmt("EngSwallowFree", { value });
}

// The armor's own melee attack: 1d20 + the tier's modifier + the bonus
// against the creature's AC, natural 20 and 1 included. A hit deals the
// tier's piercing dice + twice the bonus, a critical hit double. The
// one-action follow-up stays at the table.
async function resolveSwallow(ev, row, choice, { item: armor, grabber, gTok, whisper }) {
  const W = ev.W;
  const tier = SWALLOW_TIERS[row.rune];
  const bonus = swallowBonus(armor, W);
  const tname = targetName(grabber, gTok);
  const roll = await new Roll(`1d20 + ${tier.mod + bonus}`).evaluate();
  await showDice(roll, whisper);
  const total = Math.trunc(Number(roll.total) || 0);
  const d20 = roll.dice?.find?.((d) => d.faces === 20)?.total ?? null;
  const ac = Number(grabber.armorClass?.value ?? grabber.system?.attributes?.ac?.value);
  if (!Number.isFinite(ac)) {
    const rolled = fmt("EngSwallowRoll", { rune: row.label, target: tname, total });
    return { line: `${rolled} → ${i18n("EngSwallowNoAC")}`, used: true };
  }
  const degree = degreeAgainst(total, d20, ac);
  // The creature's AC, as PF2e shows it: only to the GMs unless a player owns
  // the creature or the table shows DCs.
  const vs = gmSecret(` ${fmt("EngVsAC", { ac })}`, grabber);
  const head = fmt("EngSwallowAttack", { rune: row.label, target: tname, total, vs, result: escHTML(attackResult(degree)) });
  if (degree < 2) return { line: head, used: true };
  const engulf = engulfOf(W, grabber, row.data);
  const crit = degree === 3;
  const formula = swallowFormula(tier, bonus, !!engulf, crit);
  // Through the armor as the item, with the engine's tag: IWR applies, and
  // the creature's own "when damaged" reactions do not answer it. The
  // outcome rides along as PF2e marks a Strike's damage, so immunity to
  // critical hits sees a critical one.
  const rollOpts = [...reactOptions(armor, W), `check:outcome:${crit ? "critical-success" : "success"}`];
  const dealt = await withHealQueue(grabber, () => applyRollDamage(grabber, gTok, formula, armor, rollOpts));
  if (!dealt) return { line: `${head} → ${i18n("EngFailed")}`, used: true };
  const amount = Math.max(0, Math.trunc(Number(dealt.roll?.total) || 0));
  // What the creature took after IWR, not capped by the HP it had left: a
  // killing blow of 24 against Rupture 20 still cuts the wearer free, and the
  // HP floor is not passed off as a resistance.
  const lost = Math.max(0, Number(dealt.lost) || 0);
  const taken = Math.max(lost, Math.trunc(Number(dealt.taken) || 0));
  let line = `${head} → ${amount} ${i18n("Applied")}${crit ? " (x2)" : ""}${dealtNote(amount, taken)}`;
  if (engulf) line += ` · ${await ruptureNote(W, grabber, engulf, taken)}`;
  return { line, used: true };
}

/* ------------------------------------------------------ rune: Spellwatch */

// The spell behind an effect, its save and its caster's current DC. Only an
// effect dragged from a spell's card knows its spell; scrolls, wands and
// deleted spells resolve nothing and are left to the GM.
function spellSaveOf(effect) {
  let spell = null;
  try {
    const uuid = effect?.system?.context?.origin?.item;
    spell = uuid ? fromUuidSync(uuid) : null;
  } catch (err) {
    console.warn(`${MODULE_ID} | could not read a spell effect's spell`, err);
  }
  if (!spell?.isOfType?.("spell")) return { spell: null, save: null, dc: null };
  const save = spell.system?.defense?.save?.statistic;
  let dc = NaN;
  try {
    dc = Number(spell.spellcasting?.statistic?.dc?.value);
  } catch (err) {
    console.warn(`${MODULE_ID} | could not read a spell's DC`, err);
  }
  return { spell, save: SAVE_TYPES.includes(save) ? save : null, dc: Number.isFinite(dc) && dc > 0 ? dc : null };
}

// "A hostile spell affecting you": an effect from a spell whose caster is an
// enemy. A spell applied as a bare condition, or an effect with no origin,
// cannot be seen. An effect the GM keeps unidentified is marked: it is named
// to the GMs alone and never offered.
function spellwatchEntries(W, wTok) {
  const out = [];
  for (const effect of W.itemTypes?.effect ?? []) {
    if (!effect.fromSpell) continue;
    const caster = originOf(effect, W);
    if (!caster || !areEnemies(caster, W, tokenOf(caster, wTok?.parent), wTok)) continue;
    out.push({ effect, caster, unidentified: unidentified(effect), ...spellSaveOf(effect) });
  }
  return out;
}

// Turns this client already offered, by wearer: one offer per turn.
const _spellwatchTurns = new Map();

// At the start of the wearer's turn, one button per hostile spell whose save
// can be rolled; the others are named for the GM. One retry per turn.
async function runSpellwatch(W, combatant) {
  const armor = hasRune(W, "spellwatch");
  if (!armor) return;
  const combat = combatOf(W);
  if (!combat) return;
  const turn = turnKey(combat);
  if (_spellwatchTurns.get(W.uuid) === turn) return;
  if (!freqAllows(armor, runeUse("spellwatch"), W)) return;
  const wTok = combatant?.token ?? tokenOf(W);
  const scene = wTok?.parent;
  const entries = spellwatchEntries(W, wTok);
  if (!entries.length) return;
  _spellwatchTurns.set(W.uuid, turn);
  const label = escHTML(runeLabel("spellwatch"));
  const named = (key, e) =>
    `${label}: ${fmt(key, { spell: escHTML(e.effect.name), caster: targetName(e.caster, tokenOf(e.caster, scene)) })}`;
  // A spell the GM keeps unidentified: no button, label, flag or table line
  // names it; the GMs read it here and run the retry by hand if it applies.
  const secretOnes = entries.filter((e) => e.unidentified);
  if (secretOnes.length) {
    await postEngineSummary({
      actor: W,
      token: wTok,
      title: label,
      lines: secretOnes.map((e) => named("EngSpellwatchSecret", e)),
      gmOnly: true
    });
  }
  const shown = entries.filter((e) => !e.unidentified);
  if (!shown.length) return;
  const ready = shown.filter((e) => e.save && e.dc);
  const lines = shown.filter((e) => !(e.save && e.dc)).map((e) => named("EngSpellwatchManual", e));
  const rows = ready.length
    ? [
        runeRow(armor, "spellwatch", {
          // Button labels: text, set with textContent. The enemy caster's DC
          // is in the label only for those PF2e shows it to (askButtons).
          choices: ready.map((e) => {
            const save = labelFor(CONFIG.PF2E?.saves, e.save);
            return {
              id: e.effect.id,
              label: fmt("EngSpellwatchChoice", { save, dc: e.dc, spell: e.effect.name }),
              plain: fmt("EngSpellwatchChoiceNoDC", { save, spell: e.effect.name }),
              casterOwned: !!e.caster?.hasPlayerOwner,
              save: e.save,
              dc: e.dc
            };
          }),
          offer: fmt("EngSpellwatchOffer", { rune: label })
        })
      ]
    : [];
  const ev = runeEvent(W, wTok);
  ev.secret ||= !!combatant?.hidden;
  // A caster the GM keeps hidden must not be named to the table either.
  ev.secret ||= shown.some((e) => !!tokenOf(e.caster, scene)?.hidden);
  // The prompt reaches the wearer's player even when secret, who decides;
  // the lines are the GM's to resolve, so a secret event's go to the GMs
  // alone, on their own card when the prompt's audience is wider.
  const promptTo = askRecipients(W, ev.secret);
  const linesTo = ev.secret ? gmIds() : promptTo;
  let shared = lines;
  if (lines.length && (!rows.length || !sameAudience(linesTo, promptTo))) {
    const args = { actor: W, token: wTok, title: label, lines };
    if (linesTo) args.recipients = linesTo;
    await postEngineSummary(args);
    shared = [];
  }
  if (rows.length) await postAskCard(ev, label, shared, rows);
}

// A listed spell the wearer can still retry: its effect is still on them,
// the GM has not hidden it since, and its save and DC can be read (the DC
// stored at the offer stands in for one the spell no longer gives).
function spellwatchChoice(W, c) {
  const effect = c?.id ? W.items.get(c.id) : null;
  if (effect?.type !== "effect" || unidentified(effect)) return null;
  const info = spellSaveOf(effect);
  const save = info.save ?? (SAVE_TYPES.includes(c.save) ? c.save : null);
  const dc = info.dc ?? (Number(c.dc) > 0 ? Number(c.dc) : null);
  return save && dc ? { effect, spell: info.spell, save, dc } : null;
}

// A spell that ended, was deleted or hidden, or whose save can no longer be
// read loses its button; the row stays for the others and closes, with a
// line, once no listed spell is left. A hidden one is never named.
async function checkSpellwatch(ev, row, choice) {
  const choices = Array.isArray(row.choices) ? row.choices : [];
  const picked = spellwatchChoice(ev.W, choices.find((c) => c?.id === choice));
  if (picked) return { ok: true, ...picked, caster: originOf(picked.effect, ev.W) };
  const left = choices.filter((c) => c?.id !== choice && spellwatchChoice(ev.W, c));
  if (!left.length) return { ok: false, reason: "gone", state: "gone", line: fmt("EngSpellwatchGone", { rune: row.label }) };
  return { ok: false, reason: "effectGone", patch: { choices: left } };
}

// The save against the spell, with its traits (a mental spell's save sees
// bonuses against mental effects). Success ends it for the wearer: the
// effect goes, and the conditions it granted with it. Ending it for other
// targets, or a sustained spell, stays with the table.
async function resolveSpellwatch(ev, row, choice, { effect, spell, save: type, dc, caster }) {
  const W = ev.W;
  const name = escHTML(effect.name);
  let traits = [];
  let extra = [];
  try {
    traits = (spell?.system?.traits?.value ?? []).map(String);
    extra = spell?.getRollOptions?.("item") ?? [];
  } catch (err) {
    console.warn(`${MODULE_ID} | spell roll options`, err);
  }
  const save = await rollSilentSave(W, type, dc, { origin: caster, traits, extraRollOptions: extra });
  if (!save) return { line: `${row.label}: ${name} → ${i18n("NoStatistic")}`, used: false };
  // The caster's DC as PF2e shows it: to the GMs alone for a creature no
  // player owns, unless the table shows DCs.
  const head = `${row.label}: ${name} · ${saveText(save, dc, gmSecret(` vs ${dc}`, caster))}`;
  if (save.degree < 2) return { line: `${head} → ${i18n("EngSpellwatchHolds")}`, used: true };
  if (W.items.has(effect.id)) {
    try {
      await W.deleteEmbeddedDocuments("Item", [effect.id]);
    } catch (err) {
      console.error(`${MODULE_ID} | could not end the spell`, err);
      return { line: `${head} → ${i18n("EngFailed")}`, used: true };
    }
  }
  return { line: `${head} → ${i18n("EngSpellwatchEnds")}`, used: true };
}

// The player-choice runes, by slug: how often (the pseudo-card's freq), what
// the GM checks before marking the row used, and how it resolves.
const SWALLOW_ASK = { freq: "always", check: checkSwallow, resolve: resolveSwallow };
const RUNE_ASKS = {
  energyAdaptive: { freq: "hour", check: checkAdaptive, resolve: resolveAdaptive },
  deathless: { freq: "day", check: checkDeathless, resolve: resolveDeathless },
  swallowSpike: SWALLOW_ASK,
  greaterSwallowSpike: SWALLOW_ASK,
  majorSwallowSpike: SWALLOW_ASK,
  spellwatch: { freq: "turn", check: checkSpellwatch, resolve: resolveSpellwatch }
};

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
    // Marked before anything is resolved or offered: the same blow never
    // prompts twice.
    await markDone(markOn, sig);
    const lines = await runCards(ev, cards.filter((c) => !c.r.ask));
    if (unnerving) lines.push(await applyUnnerving(ev, unnerving));
    await postReactions(ev, lines, cards.filter((c) => c.r.ask));
  } finally {
    _claims.delete(markOn.id);
  }
}

/* --------------------------------------------- damaged / Shield Block */

// answer: false for the engine's own damage, which no card answers; its
// rune offers (Energy Adaptive) still ride on the event's card.
async function reactToDamage(message, options, applied, W, source, loss, { answer = true, runeRows = [] } = {}) {
  const attacker = source && !sameActor(source, W) ? source : null;
  const blocked = options.includes(BLOCK_OPT);
  const triggers = new Set();
  if (answer) {
    // A weapon rider is part of the Strike whose own damage card fires
    // "damaged" once; counting each rider would answer one blow several times.
    if (loss > 0 && attacker && !options.includes(RIDER_OPT)) triggers.add("damaged");
    if (blocked) triggers.add("block");
    if ((Number(applied?.shield?.damage) || 0) > 0) triggers.add("blockHurt");
    if (blocked && loss === 0) triggers.add("blockZero");
  }
  if (!triggers.size && !runeRows.length) return false;
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
  if (!cards.length && !runeRows.length) return false;
  const lines = await runCards(ev, cards.filter((c) => !c.r.ask));
  await postReactions(ev, lines, cards.filter((c) => c.r.ask), runeRows);
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
    // The engine's own damage answers nothing (two thorn wearers would trade
    // blows forever), but fire thorns are still fire damage taken.
    const engineDealt = options.includes(REACT_OPT);
    let runeRows = [];
    try {
      runeRows = adaptiveRows(victim, options, loss);
    } catch (err) {
      console.error(`${MODULE_ID} | energy adaptive offer failed`, err);
    }
    let acted = false;
    try {
      acted = await reactToDamage(message, options, applied, victim, source, loss, { answer: !engineDealt, runeRows });
    } catch (err) {
      console.error(`${MODULE_ID} | damage reactions failed`, err);
    }
    if (!engineDealt && source && !sameActor(source, victim)) {
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

// Each damage type the roll carries, read off its instances before IWR (the
// wrapper runs first). A persistent rider not yet rolled totals 0 and is left
// out; a persistent tick is rolled and counts. Half and Double keep the
// types. A bare number (healing, an HP edit) carries none.
function damageTypeStamps(damage) {
  const instances = damage && typeof damage === "object" ? damage.instances : null;
  if (!Array.isArray(instances)) return [];
  const out = new Set();
  for (const inst of instances) {
    if (typeof inst?.type === "string" && inst.type && Number(inst.total) > 0) out.add(`${TYPE_OPT}${inst.type}`);
  }
  return [...out];
}

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
  extra.push(...damageTypeStamps(params.damage));
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

// Every client registers the answer handler; only the active GM is ever
// queried. A Foundry without user queries leaves the buttons to the GM.
Hooks.once("init", () => {
  if (!CONFIG.queries) return;
  CONFIG.queries[ASK_QUERY] = (data, { user } = {}) => answerAsk(data, user);
});

// Prompts that lapsed while no GM was here, or while this one was away.
Hooks.once("ready", () => {
  sweepAsks();
});

// Fire on every client; the sweep itself runs on the active GM only.
Hooks.on("combatTurnChange", () => {
  sweepAsks();
});
Hooks.on("deleteCombat", () => {
  sweepAsks();
});
// Deleting the current combatant when it was last in the order moves the turn
// back without a combatTurnChange. The hook fires before the combat takes the
// new turn, so the sweep waits for the deletion to finish.
Hooks.on("deleteCombatant", () => {
  setTimeout(() => sweepAsks(), 0);
});

Hooks.on("renderChatMessageHTML", (message, html) => {
  try {
    decorateFortCard(message, html);
  } catch (err) {
    console.warn(`${MODULE_ID} | fortified card`, err);
  }
  try {
    decorateAskCard(message, html);
  } catch (err) {
    console.warn(`${MODULE_ID} | reaction prompt card`, err);
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
    ["temporary HP", runTempTurnDice],
    ["spellwatch", (a) => runSpellwatch(a, combatant)]
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
  // Before anything is awaited: the rows one creation offers are gathered
  // into one card.
  try {
    detectRuneAsks(item);
  } catch (err) {
    console.error(`${MODULE_ID} | rune reactions failed`, err);
  }
  try {
    await runBitter(item);
  } catch (err) {
    console.error(`${MODULE_ID} | bitter rune failed`, err);
  }
});
