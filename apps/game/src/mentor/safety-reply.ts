// The device's fixed safety replies (M4; M7 Step 10 fix round 4: its own module, so the over-long transcript scan in
// voice-turn.ts can share it without an import cycle through outage.ts and scripted.ts).
import { emergencyRuleAsks, emergencyStatesRule, type IngredientGraph } from '@kitchenquest/core/engine';
import type { ChildFlag } from './child-flag';
import type { Dialogue } from './dialogue';
import type { PanItem, PanReply } from './reply';

/**
 * The device's fixed safety reply for `intent` (an emergency, a child, a medical question), or null for any other.
 * M7 Step 10 fix round 4: shared with the over-long transcript scan (voice-turn.ts `overLongSafety`), which reads the
 * whole text itself, so a too-long utterance gets the same reply a typed one does.
 */
export function safetyReply(intent: string, raw: string, deps: { dialogue: Dialogue; graph: IngredientGraph; child: ChildFlag }): PanReply | null {
  const { dialogue, graph, child } = deps;
  const say = (trigger: string, vars: Record<string, string> = {}): PanItem => ({ kind: 'said', said: dialogue.say(trigger, vars) });
  let items: PanItem[];
  if (intent === 'emergency') {
    items = [say('rule.emergency')];
    if (!child.on && emergencyStatesRule(raw, graph)) {
      // I-2: every allergen named gets its ask (it ends with rule.ask_keep_off when nothing is named), as on the server.
      for (const ask of emergencyRuleAsks(raw, [], graph)) items.push(say(ask.trigger, ask.vars));
    }
  } else if (intent === 'child' || child.on) {
    child.set();
    items = [say('child.grownup')];
  } else if (intent === 'medical') {
    items = [say('rule.medical_deflect')];
  } else {
    return null;
  }
  return { items, cards: [], intents: [], actions: [], notice: null };
}
