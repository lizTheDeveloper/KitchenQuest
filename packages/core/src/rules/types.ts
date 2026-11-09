export type Severity = 'anaphylactic' | 'allergy' | 'intolerance' | 'preference';

export interface Rule {
  id: string;
  target: { kind: 'ingredient' | 'category' | 'component'; ids: string[] };
  type: 'avoid' | 'limit' | 'prefer';
  severity: Severity;
  limit?: { amount: number; unit: string; per: 'serving' | 'day' };
  phase?: { start: string; end?: string; journeyId?: string };
  note?: string;
}

export const SEVERE: ReadonlySet<Severity> = new Set<Severity>(['anaphylactic', 'allergy']);
