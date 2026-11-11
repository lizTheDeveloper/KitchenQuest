/**
 * One entry of data/techniques.yaml (C33). `adjacent` on technique H lists the techniques to suggest after H (it
 * need not be symmetric); `prereqs` lists the techniques a dish of H is best tried after. Both are advisory.
 */
export interface TechniqueNode {
  id: string;
  name: string;
  adjacent: string[];
  prereqs: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isIdList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0);

/** Every problem with the technique list: shape, duplicate ids, unknown or self references, a prereqs cycle. */
export function validateTechniques(nodes: unknown): string[] {
  if (!Array.isArray(nodes)) return ['techniques must be a list'];
  const p: string[] = [];
  const ids = new Set<string>();
  const good: TechniqueNode[] = [];
  nodes.forEach((n, i) => {
    if (!isObj(n) || typeof n.id !== 'string' || n.id.length === 0) {
      p.push(`technique ${i}: needs an id`);
      return;
    }
    const where = `technique "${n.id}"`;
    if (ids.has(n.id)) p.push(`${where}: duplicate id`);
    ids.add(n.id);
    if (typeof n.name !== 'string' || n.name.length === 0) p.push(`${where}: needs a name`);
    if (!isIdList(n.adjacent)) p.push(`${where}: adjacent must be a list of technique ids`);
    if (!isIdList(n.prereqs)) p.push(`${where}: prereqs must be a list of technique ids`);
    if (isIdList(n.adjacent) && isIdList(n.prereqs)) good.push(n as unknown as TechniqueNode);
  });
  for (const n of good) {
    for (const field of ['adjacent', 'prereqs'] as const) {
      for (const ref of n[field]) {
        if (ref === n.id) p.push(`technique "${n.id}": ${field} names itself`);
        else if (!ids.has(ref)) p.push(`technique "${n.id}": ${field} names unknown technique "${ref}"`);
      }
    }
  }
  // A prereqs cycle: depth-first search with a colour per node (0 new, 1 on the path, 2 done).
  const prereqs = new Map(good.map((n) => [n.id, n.prereqs.filter((r) => r !== n.id)]));
  const colour = new Map<string, number>();
  const visit = (id: string, path: string[]): void => {
    colour.set(id, 1);
    for (const next of prereqs.get(id) ?? []) {
      if (colour.get(next) === 1) {
        p.push(`prereqs cycle: ${[...path.slice(path.indexOf(next)), next].join(' → ')}`);
      } else if (!colour.has(next)) visit(next, [...path, next]);
    }
    colour.set(id, 2);
  };
  for (const id of prereqs.keys()) if (!colour.has(id)) visit(id, [id]);
  return p;
}
