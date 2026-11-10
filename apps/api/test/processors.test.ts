// C-7: Step 7's export lists processors from docs/compliance/processors.json.
// N-9 / P-11: every outbound host the API names is a registered processor, and
// only the DPA-gated AI client may name one.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const file = new URL('../../../docs/compliance/processors.json', import.meta.url);
const SRC = fileURLToPath(new URL('../src', import.meta.url));

/** Outbound hosts the API may name, and the processor each one is. Extend with the register. */
const HOST_PROCESSORS: Record<string, string> = { 'openrouter.ai': 'openrouter' };
/** The one module allowed to name a host without calling the gate: its provider is built only behind the config gate. */
const GATED_CLIENTS = ['ai/openrouter.ts'];

type Processor = Record<string, unknown>;
const doc = JSON.parse(readFileSync(file, 'utf8')) as { version: number; processors: Processor[] };

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.ts$/.test(p) && !/\.test\.ts$/.test(p) ? [p] : [];
  });
}

/** Hosts of `https://` string literals in a source file. */
export function outboundHosts(text: string): string[] {
  return [...text.matchAll(/['"`]https:\/\/([^/:'"`\s]+)/g)].map((m) => m[1].toLowerCase());
}

describe('processors.json', () => {
  it('gives every processor the fields the export needs (name, purpose, country, contact)', () => {
    expect(doc.version).toEqual(expect.any(Number));
    expect(doc.processors.length).toBeGreaterThan(0);
    for (const p of doc.processors) {
      for (const f of ['id', 'name', 'purpose', 'country', 'contact', 'status']) {
        expect(typeof p[f] === 'string' && p[f].length > 0, `${String(p.id)}.${f}`).toBe(true);
      }
    }
  });

  it('gives every processor non-empty data_categories and a known dpa_status (N-9)', () => {
    for (const p of doc.processors) {
      const cats = p.data_categories;
      expect(Array.isArray(cats) && cats.length > 0 && cats.every((c) => typeof c === 'string' && c.length > 0), `${String(p.id)}.data_categories`).toBe(true);
      expect(['unknown', 'needed', 'signed'], `${String(p.id)}.dpa_status`).toContain(p.dpa_status);
    }
  });

  it('has unique ids', () => {
    const ids = doc.processors.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('pins the OpenRouter policy the code sends (C-14)', () => {
    const or = doc.processors.find((p) => p.id === 'openrouter')!;
    expect(or.retention).toMatch(/zdr: true/);
    expect(or.training_use).toMatch(/data_collection: "deny"/);
  });
});

describe('outbound hosts (N-9)', () => {
  const files = sourceFiles(SRC).map((f) => ({ rel: relative(SRC, f).split('\\').join('/'), text: readFileSync(f, 'utf8') }));

  it('finds https literals', () => {
    expect(outboundHosts(`const a = 'https://openrouter.ai/api'; const b = "https://Example.com:443/x";`)).toEqual(['openrouter.ai', 'example.com']);
  });

  it('maps every outbound host in src to a registered processor', () => {
    const ids = new Set(doc.processors.map((p) => p.id));
    const seen: string[] = [];
    for (const { rel, text } of files) {
      for (const host of outboundHosts(text)) {
        seen.push(host);
        expect(HOST_PROCESSORS[host], `${rel} names ${host}, which is not an allowed processor host`).toBeDefined();
        expect(ids.has(HOST_PROCESSORS[host]), `${host} → ${HOST_PROCESSORS[host]} is not in processors.json`).toBe(true);
      }
    }
    expect(seen).toContain('openrouter.ai');
  });

  it('lets only the gated AI client, or a module that checks the gate, name a host', () => {
    for (const { rel, text } of files) {
      if (outboundHosts(text).length === 0 || GATED_CLIENTS.includes(rel)) continue;
      expect(/\bprocessorsNotReady\b/.test(text) && /import[^;]*processors(\.js)?['"]/.test(text), `${rel} names an outbound host without the P-11 gate`).toBe(true);
    }
  });
});
