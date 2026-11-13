// The heard check's types alone (no imports), so the mentor protocol can name them without an import cycle.

export interface HeardTerm {
  /** The words as heard: normalised (lower-cased, letters and digits), space-separated. */
  heard: string;
  /** `heard` spelled out by core `spell` (§7.6b.2: from code, never the model). */
  spelled: string;
  /**
   * What the heard words name, never corrected: a graph id, or for a rule term `term:<name>` (e.g. `term:vegan`),
   * which is NOT a graph id (`isRuleTermId`; never pass it to `IngredientGraph.get`). Null when they name nothing.
   */
  id: string | null;
  /**
   * Fix round 2 (N3): where the check heard it, as word indices (the first word of each occurrence) into the text's
   * letter-and-digit words. A choice rewrites these occurrences only, never another copy of the same word.
   */
  at: number[];
  /** What the words may have been instead, closest first, at most MAX_ALTERNATIVES. `id` as above: a graph id or `term:<name>`. */
  alternatives: { id: string; name: string; spelled: string }[];
}

export interface HeardCheck {
  /**
   * Fix round 1 (I2): the transcript is over MAX_TEXT once page events are stripped, so it was not read and `terms` is
   * empty. This check blocks: it is never confirmed, and the caller refuses the turn and asks the player to type.
   * Contract (N7): test `tooLong` FIRST. `terms.length === 0` never means "names nothing" (that is a null check).
   */
  tooLong: boolean;
  terms: HeardTerm[];
  /** Health wording is present (`hasHealthWording`): the card's spelling is spoken too (Ruling 4). */
  speakSpelling: boolean;
}
