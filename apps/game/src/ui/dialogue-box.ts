import { contentText, h } from './dom';

const CHAR_MS = 22;

/**
 * Reveal `text` in `el` one character at a time. Returns `finish()`, which shows the rest at once.
 * The full text is always the element's accessible content: the typing is on a hidden-from-AT copy.
 */
export function typeInto(el: HTMLElement, text: string, instant: boolean, onDone?: () => void): { finish(): void; done(): boolean } {
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const full = h('span', { class: 'typed-full' }, text);
  el.replaceChildren(full);
  const complete = () => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    el.classList.remove('is-typing');
    typed.remove();
    onDone?.();
  };
  const typed = h('span', { class: 'typed-visible', 'aria-hidden': 'true' });
  if (instant || text.length === 0) {
    finished = true;
    onDone?.();
    return { finish() {}, done: () => true };
  }
  el.classList.add('is-typing');
  el.append(typed);
  const chars = Array.from(text);
  let i = 0;
  const step = () => {
    i += 1;
    typed.textContent = chars.slice(0, i).join('');
    if (i >= chars.length) complete(); else timer = setTimeout(step, CHAR_MS);
  };
  timer = setTimeout(step, CHAR_MS);
  return { finish: complete, done: () => finished };
}

/** A parchment box for intros and greetings: nameplate, 2x pixelated portrait, typed lines, Next. */
export function showDialogue(
  root: HTMLElement,
  opts: { speaker: string; portrait: string | null; lines: string[]; reducedMotion: boolean },
): Promise<void> {
  if (opts.lines.length === 0) return Promise.resolve();
  const doc = root.ownerDocument;
  const opener = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;

  return new Promise((resolve) => {
    let index = 0;
    let typer: ReturnType<typeof typeInto> | null = null;
    let settled = false;

    const text = h('p', { class: 'dialogue-text', 'aria-live': 'polite' });
    const next = h('button', { type: 'button', class: 'btn btn-primary dialogue-next' });
    const portrait = opts.portrait
      ? h('img', { class: 'dialogue-portrait', src: opts.portrait, alt: '' })
      : null;
    if (portrait) {
      // Integer 2x of the sprite's own size, kept crisp by image-rendering: pixelated.
      const size = () => { if (portrait.naturalWidth > 0) portrait.style.width = `${portrait.naturalWidth * 2}px`; };
      portrait.addEventListener('load', size);
      size();
    }
    const box = h('div', { class: 'dialogue', role: 'group', 'aria-label': opts.speaker },
      contentText('span', opts.speaker, { class: 'dialogue-name' }),
      h('div', { class: 'dialogue-body' }, portrait, text),
      next,
    );

    const show = () => {
      const last = index === opts.lines.length - 1;
      next.textContent = last ? 'Done' : 'Next';
      typer = typeInto(text, opts.lines[index], opts.reducedMotion);
      text.setAttribute('data-content', '');
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      box.remove();
      opener?.focus();
      resolve();
    };
    const advance = () => {
      if (typer && !typer.done()) { typer.finish(); return; }
      if (index >= opts.lines.length - 1) { finish(); return; }
      index += 1;
      show();
    };
    next.addEventListener('click', advance);
    box.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && ev.target !== next) { ev.preventDefault(); advance(); }
    });
    box.tabIndex = -1;
    text.addEventListener('click', () => { if (typer && !typer.done()) typer.finish(); });

    root.append(box);
    show();
    next.focus();
  });
}
