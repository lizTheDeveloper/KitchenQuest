import type { Dialogue } from './dialogue';
import type { PanReply, TurnContext } from './reply';
import type { ScriptedEngine } from './scripted';

export type MentorInput = { kind: 'text'; text: string } | { kind: 'voice' };
export interface MentorBackend {
  readonly kind: 'scripted' | 'ai';
  reply(input: MentorInput, ctx: TurnContext): Promise<PanReply>;
  /** Replies that arrive after their turn (the AI backend's one retry, pre-flight C23). Returns the unsubscribe. */
  onLate?(fn: (reply: PanReply) => void): () => void;
  /** The backend is being replaced: cancel anything queued (a retry) and send nothing more. */
  dispose?(): void;
  /**
   * A text turn already answered on the device (emergency, medical or child), sent to the server in order with the
   * other turns so its child flag and turn counter advance. The server's reply is never shown. Same consent gate as a
   * normal turn: health text without `ai_health` is not sent (fix round 4).
   */
  deliver?(input: Extract<MentorInput, { kind: 'text' }>, ctx: TurnContext): void;
}

/** The path that always works: written lines and code-built cards, no network (M4 Step 9). */
export function createScriptedBackend(engine: ScriptedEngine, dialogue: Dialogue): MentorBackend {
  return {
    kind: 'scripted',
    reply(input, ctx) {
      // Deferred so a throw from the engine or dialogue.say still arrives as a rejection, as callers expect.
      return Promise.resolve().then((): PanReply =>
        input.kind === 'voice'
          ? { items: [{ kind: 'said', said: dialogue.say('voice.not_yet') }], cards: [], intents: [], actions: [], notice: null }
          : engine.reply(input.text, ctx));
    },
  };
}
