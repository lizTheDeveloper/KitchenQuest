import type { ProgressEvent, RewardGrant } from '@kitchenquest/core/engine';
import { content, techniqueName } from '../content';
import type { ClientContent } from '../content/types';

/** A Pan line to say: a trigger in content/dialogue/pan.yaml and its variables. */
export interface GrantLine { trigger: string; vars: Record<string, string> }

/** At most this many lines for one event (Step 9), in the order level → trust → certificate → stamp. */
const MAX_LINES_PER_EVENT = 2;
/** The trust level whose letter introduces the cook's friend (Ruling 3). */
const INTRODUCTION_TRUST = 3;

/**
 * The cook `cookId` introduces (Ruling 3): the cook whose quest's `unlock.requires` names `cookId`'s quest, or null.
 * Leela writes to Marisol, Marisol to Haruka; Haruka's friend in Lisbon is not in the game yet.
 */
export function friendOf(cookId: string, c: ClientContent = content): string | null {
  if (!Object.hasOwn(c.cooks, cookId)) return null;
  const quest = c.cooks[cookId].quest.id;
  const friend = Object.keys(c.cooks).sort().find((id) => id !== cookId && c.cooks[id].quest.unlock.requires.includes(quest));
  return friend ?? null;
}

/** The cooks introduced (Ruling 3): a cook whose quest needs no other is expecting you from the start; a friend once the introducer's trust reaches 3. */
export function introduced(trust: Readonly<Record<string, number>>, c: ClientContent = content): Set<string> {
  const out = new Set<string>();
  for (const [id, cook] of Object.entries(c.cooks)) if (cook.quest.unlock.requires.length === 0) out.add(id);
  for (const id of Object.keys(c.cooks)) {
    const friend = friendOf(id, c);
    if (friend !== null && Object.hasOwn(trust, id) && trust[id] >= INTRODUCTION_TRUST) out.add(friend);
  }
  return out;
}

const cookName = (id: string, c: ClientContent) => (Object.hasOwn(c.cooks, id) ? c.cooks[id].name : id);

/**
 * The Pan's lines for one event's grants, from grants only (never a guess on the client):
 * `level` → `levelup`; `trust` → `trust_up`, or at level 3 the introduction letter (`introduction_received`, the
 * friend's pin then reads "expecting you"); `certificate` → `certificate.technique`; `stamp` → `stamp_earned`, named
 * from `bureau.stamp_names` (C13). At most two lines, in that order. Nourishment earns no line (audit R4): a meal-log
 * event says nothing at all, whatever it earned, and XP alone is never announced.
 */
function linesForEvent(event: ProgressEvent | undefined, grants: readonly RewardGrant[], c: ClientContent = content): GrantLine[] {
  if (event?.kind === 'meal_logged' || grants.some((g) => g.kind === 'xp' && g.reason === 'nourishment')) return [];
  const out: GrantLine[] = [];
  const level = grants.filter((g) => g.kind === 'level').sort((a, b) => b.level - a.level).at(0);
  if (level) out.push({ trigger: 'levelup', vars: { level: String(level.level) } });
  for (const g of grants) {
    if (g.kind !== 'trust') continue;
    const friend = g.level === INTRODUCTION_TRUST ? friendOf(g.cook, c) : null;
    if (friend !== null) {
      const f = c.cooks[friend];
      out.push({ trigger: 'introduction_received', vars: { cook: cookName(g.cook, c), friend: f.name, place: f.place } });
    } else out.push({ trigger: 'trust_up', vars: { cook: cookName(g.cook, c) } });
  }
  for (const g of grants) if (g.kind === 'certificate') out.push({ trigger: 'certificate.technique', vars: { technique: techniqueName(g.technique) } });
  const stamp = grants.find((g) => g.kind === 'stamp');
  if (stamp) {
    const names = c.bureau.stamp_names;
    out.push({ trigger: 'stamp_earned', vars: { stamp: Object.hasOwn(names, stamp.stamp) ? names[stamp.stamp] : stamp.stamp } });
  }
  return out.slice(0, MAX_LINES_PER_EVENT);
}

/** Every line for a batch of grants, event by event in the order the events were recorded. */
export function grantLines(grants: readonly RewardGrant[], events: readonly ProgressEvent[], c: ClientContent = content): GrantLine[] {
  const byEvent = new Map<string, RewardGrant[]>();
  for (const g of grants) byEvent.set(g.eventId, [...(byEvent.get(g.eventId) ?? []), g]);
  const order = [...events.map((e) => e.id), ...[...byEvent.keys()].filter((id) => !events.some((e) => e.id === id))];
  return [...new Set(order)].flatMap((id) => linesForEvent(events.find((e) => e.id === id), byEvent.get(id) ?? [], c));
}

/** How a line reaches the player: the Pan says it (its panel) and a toast shows it briefly (announced politely). */
export interface Announcer { say(trigger: string, vars: Record<string, string>): string; toast(text: string): void }

/** Say each line for these grants and toast it. Returns the texts said. */
export function announceGrants(grants: readonly RewardGrant[], events: readonly ProgressEvent[], to: Announcer): string[] {
  return grantLines(grants, events).map((l) => {
    const text = to.say(l.trigger, l.vars);
    to.toast(text);
    return text;
  });
}

const TOAST_MS = 6_000;

/**
 * A short visual toast in the overlay root. It is `aria-hidden`: the same words reach screen readers once, through
 * the shared polite live region (`#announcer`), never twice.
 */
export function showToast(doc: Document, text: string, announce: (msg: string) => void): void {
  const root = doc.getElementById('overlay-root') ?? doc.body;
  let shelf = doc.getElementById('progress-toasts');
  if (!shelf) {
    shelf = doc.createElement('div');
    shelf.id = 'progress-toasts';
    shelf.className = 'progress-toasts';
    shelf.setAttribute('aria-hidden', 'true');
    root.append(shelf);
  }
  const t = doc.createElement('p');
  t.className = 'progress-toast';
  t.setAttribute('data-content', '');
  t.textContent = text;
  shelf.append(t);
  announce(text);
  setTimeout(() => t.remove(), TOAST_MS);
}
