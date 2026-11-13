import type { MentorInput, PanReply, TurnContext } from './reply';
import type { ScriptedEngine } from './scripted';

export type { MentorInput } from './reply';
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
  deliver?(input: MentorInput, ctx: TurnContext): void;
}

/** The path that always works: written lines and code-built cards, no network (M4 Step 9). */
export function createScriptedBackend(engine: ScriptedEngine): MentorBackend {
  return {
    kind: 'scripted',
    reply(input, ctx) {
      // Deferred so a throw from the engine still arrives as a rejection, as callers expect.
      // A transcript is read like typed text here: the device's heard gate (Step 9) runs before any backend.
      return Promise.resolve().then((): PanReply | Promise<PanReply> => engine.reply(input.text, ctx));
    },
  };
}
