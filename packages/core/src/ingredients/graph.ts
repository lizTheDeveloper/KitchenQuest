import type { IngredientData, IngredientNode } from './types';

/** How the graph compares names: trimmed, lower-cased, runs of whitespace collapsed to one space. */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function edgesOf(node: IngredientNode): string[] {
  return [...(node.isA ?? []), ...(node.contains ?? [])];
}

/**
 * A frozen deep copy, so callers can't change safety data after it has been validated. Node
 * fields are primitives, string arrays, or a flat record (per100g), so one level down is deep.
 */
function frozenCopy(node: IngredientNode): IngredientNode {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    copy[key] = Array.isArray(value)
      ? Object.freeze([...(value as unknown[])])
      : typeof value === 'object' && value !== null
        ? Object.freeze({ ...value })
        : value;
  }
  return Object.freeze(copy) as unknown as IngredientNode;
}

export class IngredientGraph {
  private constructor(
    private readonly nodes: Map<string, IngredientNode>,
    private readonly names: Map<string, string>,
    private readonly subkinds: Map<string, readonly string[]>,
  ) {}

  static fromData(data: IngredientData): IngredientGraph {
    const nodes = new Map<string, IngredientNode>();
    for (const node of data.ingredients) {
      if (nodes.has(node.id)) throw new Error(`Ingredient graph: duplicate id "${node.id}"`);
      nodes.set(node.id, frozenCopy(node));
    }

    for (const node of nodes.values()) {
      for (const ref of [...edgesOf(node), ...(node.unsafeFor ?? [])]) {
        if (!nodes.has(ref)) {
          throw new Error(`Ingredient graph: "${node.id}" references unknown ingredient "${ref}"`);
        }
      }
    }

    const names = new Map<string, string>();
    for (const node of nodes.values()) {
      for (const label of [node.name, ...(node.aliases ?? [])]) {
        const key = normalizeName(label);
        const owner = names.get(key);
        if (owner !== undefined && owner !== node.id) {
          throw new Error(
            `Ingredient graph: name or alias "${key}" is used by both "${owner}" and "${node.id}"`,
          );
        }
        names.set(key, node.id);
      }
    }

    for (const [key, id] of names) {
      for (const stripped of IngredientGraph.pluralStrips(key)) {
        const other = names.get(stripped);
        if (other !== undefined && other !== id) {
          throw new Error(
            `Ingredient graph: "${key}" (${id}) would also resolve as "${stripped}" (${other}); ambiguous`,
          );
        }
      }
    }

    IngredientGraph.assertAcyclic(nodes);
    return new IngredientGraph(nodes, names, IngredientGraph.allDescendants(nodes));
  }

  /** For each id, every id that reaches it over isA edges alone (its kinds, transitively). */
  private static allDescendants(nodes: Map<string, IngredientNode>): Map<string, readonly string[]> {
    const children = new Map<string, string[]>([...nodes.keys()].map((id) => [id, []]));
    for (const node of nodes.values()) for (const parent of node.isA ?? []) children.get(parent)!.push(node.id);
    const out = new Map<string, readonly string[]>();
    for (const id of nodes.keys()) {
      const seen = new Set<string>();
      const queue = [...children.get(id)!];
      for (let i = 0; i < queue.length; i++) {
        const cur = queue[i];
        if (seen.has(cur)) continue;
        seen.add(cur);
        queue.push(...children.get(cur)!);
      }
      out.set(id, Object.freeze([...seen]));
    }
    return out;
  }

  private static pluralStrips(key: string): string[] {
    const out: string[] = [];
    if (key.endsWith('es')) out.push(key.slice(0, -2));
    if (key.endsWith('s')) out.push(key.slice(0, -1));
    return out;
  }

  private static assertAcyclic(nodes: Map<string, IngredientNode>): void {
    const done = new Set<string>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    const visit = (id: string): void => {
      if (onStack.has(id)) {
        const loop = [...stack.slice(stack.indexOf(id)), id];
        throw new Error(`Ingredient graph: cycle ${loop.join(' -> ')}`);
      }
      if (done.has(id)) return;
      stack.push(id);
      onStack.add(id);
      for (const next of edgesOf(nodes.get(id)!)) visit(next);
      stack.pop();
      onStack.delete(id);
      done.add(id);
    };
    for (const id of nodes.keys()) visit(id);
  }

  resolve(name: string): string | null {
    const key = normalizeName(name);
    if (key === '') return null;
    for (const candidate of [key, ...IngredientGraph.pluralStrips(key)]) {
      const id = this.names.get(candidate);
      if (id !== undefined) return id;
    }
    return null;
  }

  get(id: string): IngredientNode {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Ingredient graph: unknown ingredient id "${id}"`);
    return node;
  }

  /**
   * Every ingredient that is a kind of `id`, through isA edges only (reverse contains is not
   * followed: worcestershire contains anchovy, but "anchovy" on a recipe can't be worcestershire).
   * A recipe line naming a category ("nuts") could be any of these.
   */
  descendants(id: string): string[] {
    this.get(id);
    return [...this.subkinds.get(id)!];
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  /** Every ingredient `id` is a kind of, through isA edges only (the reverse of `descendants`). */
  ancestors(id: string): string[] {
    this.get(id);
    return [...this.subkinds].filter(([, kinds]) => kinds.includes(id)).map(([ancestor]) => ancestor);
  }

  /** Every normalised name and alias the graph resolves, each once. */
  labels(): string[] {
    return [...this.names.keys()];
  }

  /**
   * Ingredients whose name or an alias matches `query` (normalized like `resolve`), at most
   * `limit` of them, each once. Prefix matches come before substring matches, then by name, so
   * the order is deterministic. `matched` is the label that matched: the name when it matches as
   * well as an alias does, else the first matching alias. An empty query matches nothing.
   */
  search(query: string, limit = 10): { id: string; name: string; matched: string }[] {
    const q = normalizeName(query);
    if (q === '' || !(limit > 0)) return [];
    const hits: { id: string; name: string; matched: string; tier: number }[] = [];
    for (const node of this.nodes.values()) {
      let best: { matched: string; tier: number } | null = null;
      for (const label of [node.name, ...(node.aliases ?? [])]) {
        const key = normalizeName(label);
        const tier = key.startsWith(q) ? 0 : key.includes(q) ? 1 : -1;
        if (tier >= 0 && (best === null || tier < best.tier)) best = { matched: label, tier };
      }
      if (best) hits.push({ id: node.id, name: node.name, ...best });
    }
    const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    hits.sort((a, b) => a.tier - b.tier || byText(a.name, b.name) || byText(a.id, b.id));
    return hits.slice(0, limit).map(({ id, name, matched }) => ({ id, name, matched }));
  }

  pathTo(fromId: string, targetId: string): string[] | null {
    this.get(fromId);
    this.get(targetId);
    const prev = new Map<string, string | null>([[fromId, null]]);
    const queue = [fromId];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      if (id === targetId) {
        const path: string[] = [];
        for (let cur: string | null = id; cur !== null; cur = prev.get(cur) ?? null) path.unshift(cur);
        return path;
      }
      for (const next of edgesOf(this.nodes.get(id)!)) {
        if (!prev.has(next)) {
          prev.set(next, id);
          queue.push(next);
        }
      }
    }
    return null;
  }
}
