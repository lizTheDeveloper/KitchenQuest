import { it } from 'vitest';
import { CooklangParser } from '@cooklang/cooklang';
it('dump', () => {
  const p = new CooklangParser();
  const [r] = p.parse('@a{3/4%tsp} @b{1/2}');
  console.log(JSON.stringify(r.ingredients, (_k, v) => v instanceof Map ? Object.fromEntries(v) : v));
});
