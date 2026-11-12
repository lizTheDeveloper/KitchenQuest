import { normalizeTurn, parseRuleStatement, severityFromText, type IngredientGraph } from '@kitchenquest/core';

/** A record the game keeps for the player: profile, pantry, rules or meals. */
const RECORD =
  String.raw`(profile|market ?days?|shop(ping)? ?days?|meal ?(times?|windows?)|(breakfast|lunch|dinner|supper|tea) ?times?|meals? (a|per) week|region|country|pantry|cupboards?|fridge|larder|shel(f|ves)|(shopping )?list|rules?|allerg\w*|intoleran\w*|meals?|breakfast|brekkie|lunch|dinner|supper|snacks?)`;
/** A verb that asks for a change, anywhere in the sentence with a record ("set saturday as market day", "forget my rules"). */
const CHANGE_VERB = /\b(remember|save|set|change|update|log|note|record|file|stamp|switch|move|delete|clear|forget|wipe|erase|reset|scrap)\b/;
const RECORD_WORD = new RegExp(String.raw`\b${RECORD}\b`);
/** "make saturday my market day", "make my lunch time 12:30"; never "what should I make for dinner". */
const MAKE_MY = new RegExp(String.raw`\bmake\b(?! (for|with|me|us|some|a|an|it)\b)[^.!?;]{0,30}\b(my|our) ${RECORD}\b`);
/** "add milk to my pantry", "take milk off the list", "put rice in the cupboard". */
const MOVE_ITEM = new RegExp(String.raw`\b(add|remove|put|take|cross|tick)\b[^.!?;]{0,30}\b(to|from|off|out of|in|into|on|onto) (my|our|the) ${RECORD}\b`);

/**
 * M6 Step 8: ticking the market list, in any tense: "tick the shallots", "tick off the onion", "ticked the eggs",
 * "cross the dal off", "checked them all off". Fix round 1 (m4): never the animal, a health context ("a tick bite",
 * "bitten by a tick", "tick-borne", "ticks on the dog", "deer ticks"): "tick" after a determiner or a preposition, or
 * before bite/bit/borne/fever/on/in, is a noun; "off" must stand alone ("off-lead" is not it).
 */
export const TICK_PATTERN =
  /(?<!\b(?:a|an|the|one|two|some|any|no|those|these|that|this|deer|dog|by|for|of|from|with|my|your)\s+)\btick(?:s|ed|ing)?\b(?![\s-]+(?:bites?|bit|bitten|biting|borne|fever|disease|on|in|off (?:me|him|her|them|the dog|the cat))\b)|\b(?:check|cross)(?:es|ed|ing)?\b(?:\s+[^\s.!?;]+){0,4}\s+off(?![\w-])/i;

/**
 * The player's own words ask the game to change one of their records (fix round 4,
 * R9): a turn that made no card then says the scripted `write.not_done` line, so a
 * request is never met with silence or a made-up "done". Read per sentence. A change
 * verb with a rule statement or a severity cue counts too ("note that peanuts nearly killed me", fix round 5).
 */
export function isWriteRequest(text: string, graph: IngredientGraph): boolean {
  return normalizeTurn(text)
    .split(/[.!?;\n]+/)
    .some(
      (s) =>
        (CHANGE_VERB.test(s) && (RECORD_WORD.test(s) || severityFromText(s, graph) !== null || parseRuleStatement(s, graph) !== null)) ||
        MAKE_MY.test(s) ||
        MOVE_ITEM.test(s) ||
        TICK_PATTERN.test(s),
    );
}
