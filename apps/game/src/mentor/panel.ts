import { typeInto } from '../ui/dialogue-box';
import { h } from '../ui/dom';
import type { MentorBackend } from './backend';
import type { Dialogue, Said, Vars } from './dialogue';

/** The panel keeps the last this-many bubbles; older ones are removed so a long session can't grow without end. */
export const MAX_BUBBLES = 50;

export type MentorMode = 'standard' | 'familyTable';
export interface MentorPanel {
  readonly mode: MentorMode;
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** Add a scripted Pan bubble. Scenes call this in every mode. */
  say(id: string, vars?: Vars): Said;
}

export function mountMentorPanel(
  root: HTMLElement,
  opts: { mode: MentorMode; backend: MentorBackend; dialogue: Dialogue; reducedMotion: () => boolean },
): MentorPanel {
  // Spec §19: in Family Table mode children never reach the AI. Refuse before touching the DOM.
  if (opts.mode === 'familyTable' && opts.backend.kind !== 'scripted') {
    throw new Error('Family Table mode requires the scripted backend');
  }
  const { mode, backend, dialogue } = opts;
  const doc = root.ownerDocument;
  const opener = doc.getElementById('pan-button');
  const standard = mode === 'standard';

  const bubbles = h('ol', { class: 'bubbles', 'aria-live': 'polite' });
  const closeBtn = h('button', { type: 'button', class: 'btn btn-secondary pan-close' }, 'Close');
  const panel = h('aside', { id: 'pan-panel', class: 'pan-panel', role: 'dialog', 'aria-labelledby': 'pan-title', hidden: true },
    h('div', { class: 'pan-head' },
      h('span', { class: 'pan-portrait', 'aria-hidden': 'true' }, '🍳'),
      h('h2', { id: 'pan-title' }, 'The Pan'),
      closeBtn),
    bubbles,
  );

  let talkBtn: HTMLButtonElement | null = null;
  let textBox: HTMLTextAreaElement | null = null;
  let open = false;

  const typers = new WeakMap<Element, { finish(): void }>();
  const addBubble = (who: 'pan' | 'you', text: string): void => {
    const body = h('span', { class: 'bubble-text' });
    bubbles.append(h('li', { class: `bubble ${who}` }, body));
    while (bubbles.children.length > MAX_BUBBLES) bubbles.firstElementChild!.remove();
    if (who === 'pan') {
      body.setAttribute('data-content', '');
      typers.set(body, typeInto(body, text, opts.reducedMotion()));
    } else {
      body.textContent = text;
    }
    bubbles.scrollTop = bubbles.scrollHeight;
  };
  // Click a typing bubble to show the rest of it.
  bubbles.addEventListener('click', (ev) => {
    const body = (ev.target as Element).closest('.bubble-text');
    if (body) typers.get(body)?.finish();
  });

  const reply = async (input: Parameters<MentorBackend['reply']>[0]): Promise<void> => {
    let said: Said;
    try {
      said = await backend.reply(input);
    } catch (err) {
      console.error(err);
      said = dialogue.say('ai_unavailable');
    }
    addBubble('pan', said.text);
  };

  if (standard) {
    textBox = h('textarea', { id: 'pan-text', rows: 2, maxlength: 500, class: 'pan-text' });
    const form = h('form', { class: 'pan-form' },
      h('label', { for: 'pan-text' }, 'Say something to the Pan'),
      textBox,
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Send'),
    );
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const text = textBox!.value.trim();
      if (!text) return;
      textBox!.value = '';
      addBubble('you', text);
      void reply({ kind: 'text', text });
    });
    textBox.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); form.requestSubmit(); }
    });

    talkBtn = h('button', { id: 'pan-talk', type: 'button', class: 'btn btn-secondary', 'aria-pressed': 'false' }, 'Hold to talk');
    const talk = talkBtn;
    const press = () => {
      if (talk.getAttribute('aria-pressed') === 'true') return;
      talk.setAttribute('aria-pressed', 'true');
      talk.textContent = 'Listening…';
    };
    const release = () => {
      if (talk.getAttribute('aria-pressed') !== 'true') return;
      talk.setAttribute('aria-pressed', 'false');
      talk.textContent = 'Hold to talk';
      void reply({ kind: 'voice' });
    };
    talk.addEventListener('pointerdown', press);
    talk.addEventListener('pointerup', release);
    talk.addEventListener('pointerleave', release);
    talk.addEventListener('pointercancel', release);
    talk.addEventListener('blur', release);
    talk.addEventListener('keydown', (ev) => {
      if (ev.key !== ' ' && ev.key !== 'Enter') return;
      ev.preventDefault();
      if (!ev.repeat) press();
    });
    talk.addEventListener('keyup', (ev) => {
      if (ev.key !== ' ' && ev.key !== 'Enter') return;
      ev.preventDefault();
      release();
    });
    panel.append(form, h('div', { class: 'pan-talk-row' }, talkBtn));
  }

  const onDocKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') api.close(); };
  const api: MentorPanel = {
    mode,
    open() {
      if (open) return;
      open = true;
      panel.hidden = false;
      opener?.setAttribute('aria-expanded', 'true');
      doc.addEventListener('keydown', onDocKey);
      (textBox ?? closeBtn).focus();
    },
    close() {
      if (!open) return;
      open = false;
      panel.hidden = true;
      opener?.setAttribute('aria-expanded', 'false');
      doc.removeEventListener('keydown', onDocKey);
      opener?.focus();
    },
    isOpen: () => open,
    say(id, vars) {
      const said = dialogue.say(id, vars);
      addBubble('pan', said.text);
      return said;
    },
  };

  closeBtn.addEventListener('click', () => api.close());
  if (opener) {
    opener.setAttribute('aria-expanded', 'false');
    opener.setAttribute('aria-controls', 'pan-panel');
    opener.addEventListener('click', () => (open ? api.close() : api.open()));
  }
  root.append(panel);
  return api;
}
