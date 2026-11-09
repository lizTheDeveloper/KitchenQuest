import '../../src/styles/tokens.css';
import '../../src/styles/components.css';
import type { CheckStatus } from '@kitchenquest/core/engine';
import { showBureauForm } from '../../src/ui/bureau-form';
import { statusChip } from '../../src/ui/chips';

const chips = document.getElementById('chips')!;
for (const s of ['ok', 'swap', 'blocked', 'unverified'] as CheckStatus[]) {
  chips.append(statusChip(s), ' ');
}

const form = {
  number: '27-B/ALLERGEN', title: 'Declaration of an Allergy', safety: true,
  fields: [{ key: 'ingredient', label: 'Ingredient or group', hint: 'As you said it.' }],
  buttons: { confirm: 'Stamp it ✔', decline: 'Not quite' }, stamp: 'approved',
};
document.getElementById('open')!.addEventListener('click', () => {
  void showBureauForm(document.getElementById('overlay-root')!, {
    form, values: { ingredient: 'kiwi' }, reducedMotion: true, stamps: { approved: 'APPROVED' },
  }).then((r) => { document.getElementById('result')!.textContent = r; });
});
