export function reducedMotion(setting: 'system' | 'on' | 'off', mql: { matches: boolean }): boolean {
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  return mql.matches;
}
