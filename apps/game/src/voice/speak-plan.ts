// M7 Step 8: what the Pan says aloud is only what is on screen, named by id, never by text or variables (Ruling 15).
// The API renders every spoken line itself from server-held data.
import { MAX_SPEAK_ITEMS, type SpeakItem } from '@kitchenquest/core/engine';
import { content } from '../content';
import type { Said } from '../mentor/dialogue';
import type { CardView, PanItem } from '../mentor/reply';

/** "It's on the screen; read it there." The fallback for anything the Pan won't say aloud (var-free, pan.yaml). */
export const CHECK_SCREEN: Readonly<Extract<SpeakItem, { kind: 'line' }>> = Object.freeze({ kind: 'line', trigger: 'voice.check_screen', index: 0 });
/** core protocol.ts's trigger shape: a speak naming any other is refused whole. */
const TRIGGER = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/;
const VAR = /\{[A-Za-z_][A-Za-z0-9_]*\}/;

const checkScreenText = (): string => (Object.hasOwn(content.pan.triggers, CHECK_SCREEN.trigger) ? content.pan.triggers[CHECK_SCREEN.trigger].lines.at(0) ?? '' : '');

/** A line as a speak item: a server part by the reply's id; a var-free device line by trigger and index; else the fallback. */
function lineItem(s: Said, replyId: string | null): SpeakItem {
  if (s.part !== undefined && replyId !== null) return { kind: 'reply', replyId, part: s.part };
  const line = Object.hasOwn(content.pan.triggers, s.trigger) ? content.pan.triggers[s.trigger].lines[s.index] : undefined;
  if (line === undefined || VAR.test(line) || !TRIGGER.test(s.trigger)) return { ...CHECK_SCREEN };
  return { kind: 'line', trigger: s.trigger, index: s.index };
}

/**
 * The reply's speak items, in screen order, and the same lines' text for the browser stand-in only (`said`):
 * - server line parts → `{ kind: 'reply', replyId, part }`; server cards → `{ kind: 'card', proposalId }`;
 * - device-only lines: var-free → `{ kind: 'line', trigger, index }`, else `voice.check_screen`;
 * - local cards, consent cards and the rules notice → `voice.check_screen`;
 * - never a retry, quick-answer or choice label.
 * Repeats of `voice.check_screen` in a row are said once; past MAX_SPEAK_ITEMS the rest is `voice.check_screen`.
 */
export function speakPlan(items: readonly PanItem[], cards: readonly CardView[], reply: { replyId: string | null }): { items: SpeakItem[]; said: string[] } {
  const out: { item: SpeakItem; text: string }[] = [];
  const add = (item: SpeakItem, text: string) => {
    const last = out.at(-1);
    const isCheck = (i: SpeakItem) => i.kind === 'line' && i.trigger === CHECK_SCREEN.trigger;
    if (last !== undefined && isCheck(last.item) && isCheck(item)) return;
    out.push({ item, text });
  };
  const fallback = () => add({ ...CHECK_SCREEN }, checkScreenText());
  for (const i of items) {
    switch (i.kind) {
      case 'said':
      case 'go':
        add(lineItem(i.said, reply.replyId), i.said.text);
        break;
      case 'consent':
      case 'rules_error':
        fallback();
        break;
      case 'choices':
      case 'quick':
      case 'retry':
        break;
    }
  }
  for (const c of cards) {
    if (c.origin === 'server') add({ kind: 'card', proposalId: c.proposalId }, checkScreenText());
    else fallback();
  }
  if (out.length > MAX_SPEAK_ITEMS) {
    out.length = MAX_SPEAK_ITEMS - 1;
    fallback();
  }
  return { items: out.map((o) => o.item), said: out.map((o) => o.text) };
}
