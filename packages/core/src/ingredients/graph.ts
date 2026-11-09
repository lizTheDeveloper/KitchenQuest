import type { IngredientData, IngredientNode } from './types';

function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function edgesOf(node: IngredientNode): string[] {
  return [...(node.isA ?? []), ...(node.contains ?? [])];
}

export class IngredientGraph {
  private constructor(
    private readonly nodes: Map<string, IngredientNode>,
    private readonly names: Map<string, string>,
  ) {}

  static fromData(data: IngredientData): IngredientGraph {
    const nodes = new Map<string, IngredientNode>();
    for (const node of data.ingredients) {
      if (nodes.has(node.id)) throw new Error(`Ingredient graph: duplicate id "${node.id}"`);
      nodes.set(node.id, node);
    }

    for (const node of nodes.values()) {
      for (const ref of edgesOf(node)) {
        if (!nodes.has(ref)) {
          throw new Error(`Ingredient graph: "${node.id}" references unknown ingredient "${ref}"`);
        }
      }
    }

    const names = new Map<string, string>();
    for (const node of nodes.values()) {
      for (const label of [node.name, ...(node.aliases ?? [])]) {
        const key = normalize(label);
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
    return new IngredientGraph(nodes, names);
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
    const key = normalize(name);
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

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  pathTo(fromId: string, targetId: string): string[] | null {
    this.get(fromId);
    this.get(targetId);
    const prev = new Map<string, string | null>([[fromId, null]]);
    const queue = [fromId];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]!;
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
