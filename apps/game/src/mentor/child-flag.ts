/**
 * The conversation's child flag (§19, P-9; M4 final m-4): ONE per panel conversation, read by the local safety check
 * (outage.ts), the scripted engine and the intake. Once a child turn is seen, every later turn of the conversation is
 * answered with `child.grownup`, and nothing is offered or written (no card of any kind): only an emergency still gets
 * the emergency line, with no ask. In memory only; a new conversation (clearConversation) forgets it.
 */
export interface ChildFlag {
  readonly on: boolean;
  set(): void;
  reset(): void;
}

export function createChildFlag(): ChildFlag {
  let on = false;
  return {
    get on() { return on; },
    set() { on = true; },
    reset() { on = false; },
  };
}
