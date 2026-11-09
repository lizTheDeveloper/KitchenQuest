type Attr = string | number | boolean | null | undefined | ((ev: Event) => void);
export type Child = string | Node | null | undefined | false;

/** Build an element. Children are text nodes or elements: never HTML strings, so no innerHTML. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, Attr> | null = null, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, '').toLowerCase(), v);
    else if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

/** An element whose text comes from compiled content. Step 12's scan relies on `data-content`. */
export function contentText<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, attrs: Record<string, Attr> = {}): HTMLElementTagNameMap[K] {
  return h(tag, { ...attrs, 'data-content': '' }, text);
}
