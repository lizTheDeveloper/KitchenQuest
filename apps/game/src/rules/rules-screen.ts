import {
  buildRuleCard, SEVERE, SEVERITY_WORDS, validateRules,
  type IngredientGraph, type Rule, type RuleCard, type RuleTerm,
} from '@kitchenquest/core/engine';
import { refreshAccount } from '../api/account';
import { content, graph } from '../content';
import type { BureauForm } from '../content/types';
import { getMentorServices } from '../mentor';
import { CLOSED_TEXT, closeCard, renderCard, setCardNote } from '../mentor/cards-view';
import { renderConsentCard } from '../mentor/consent-card';
import { DEVICE_ONLY_FOOTNOTE, NOT_SAVED_TEXT } from '../mentor/panel';
import type { LocalCardView, PanItem } from '../mentor/reply';
import { ACCOUNT_NOT_LOADED_MESSAGE, activeRules, RULES_INVALID_MESSAGE, RULES_UNREADABLE_MESSAGE } from '../recipes/rules';
import { registerScreen, type AppContext, type Screen } from '../shell/app';
import { reducedMotion } from '../shell/motion';
import type { PlayerState } from '../state/store';
import { showBureauForm } from '../ui/bureau-form';
import { contentText, h } from '../ui/dom';
import { mountRuleForm } from './rule-form';

/**
 * Your rules (`#/rules`, M4 Step 11): the form fallback for §7.5 and the place to clear `rulesUnreadable`. It
 * works with the AI off and signed out: nothing here talks to the Pan's AI, and a signed-out player's rules are
 * written to this device. A rule is added only through the same Form 27-B card the Pan shows, stamped by a tap
 * (`writer.confirm(…, 'tap')`); one is removed only through Form 27-B/VOID's own Remove tap.
 */
const BAD_RULE_TEXT = "This rule names an ingredient the ledger doesn't know any more.";
const UNREADABLE_CONFIRM = 'These are all my rules';
const NOT_REMOVED_TEXT = "That didn't go through, so nothing was removed. Try again in a moment.";
const RESTORED_TEXT = 'Put back. Dishes are checked for it again.';
const COPY_WARNING = "These rules are saved on this device but not on your account. While you're signed in, dishes are checked against your account's rules only.";
const CANT_COPY_TEXT = 'This one can be copied by telling the Pan about it.';
const CONSENT_DONE_TEXT = 'Permission filed. Tap the stamp button again to save the rule.';
const CONSENT_UNAVAILABLE_TEXT = "The permission form couldn't load just now. Nothing has changed.";

const sameIds = (a: readonly string[], b: readonly string[]) => {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((id, i) => id === y[i]);
};

/** The words a rule is shown with: a rule term's name ("vegetarian") or the ledger names of its targets. */
function ruleName(rule: Rule, ruleTerms: readonly RuleTerm[], g: IngredientGraph): string {
  const term = ruleTerms.find((t) => sameIds(t.ids, rule.target.ids));
  const names = rule.target.ids.map((id) => (g.has(id) ? g.get(id).name : id));
  return term ? `${term.name} (${names.join(', ')})` : names.join(', ');
}

/** A confirm card for an existing rule (copying a device rule to the account), or null when one can't be built exactly. */
function cardForRule(rule: Rule, ruleTerms: readonly RuleTerm[], g: IngredientGraph): RuleCard | null {
  if (validateRules([rule], g).length > 0) return null;
  const term = ruleTerms.find((t) => sameIds(t.ids, rule.target.ids));
  const name = term ? term.name : rule.target.ids.length === 1 ? g.get(rule.target.ids[0]).name : null;
  if (name === null) return null;
  const built = buildRuleCard({ term: name, severity: rule.severity }, g, ruleTerms);
  return built.ok && sameIds(built.card.rule.target.ids, rule.target.ids) ? built.card : null;
}

const rulesKey = (s: PlayerState) => JSON.stringify([s.account, s.localRules, s.accountRules, s.rulesUnreadable]);

function rulesScreen(): Screen {
  let stops: (() => void)[] = [];
  let leaving: AbortController | null = null;
  return {
    title: 'Your rules',
    mount(el, _route, ctx: AppContext) {
      const { client, writer, dialogue } = getMentorServices();
      const forms = content.bureau.forms;
      const ruleTerms = content.ruleTerms;
      const store = ctx.store;
      const doc = el.ownerDocument;
      const win = doc.defaultView!;
      const mql = win.matchMedia('(prefers-reduced-motion: reduce)');
      leaving = new AbortController();
      const signal = leaving.signal;

      const status = h('div', { class: 'rules-status', role: 'status', id: 'rules-status' });
      const banner = h('div', { class: 'rules-banner' });
      const listBox = h('div', { class: 'rules-list-box' });
      const copyBox = h('div', { class: 'rules-copy-box' });
      const addBox = h('div', { class: 'rules-add-box' });
      const addBtn = h('button', { type: 'button', class: 'btn btn-primary', id: 'rules-add' }, 'Add a rule');

      const tell = (...nodes: Node[]) => { status.replaceChildren(...nodes); };
      const saidNodes = (items: readonly PanItem[]): Node[] => items.flatMap((i): Node[] => {
        if (i.kind === 'said') return [contentText('p', i.said.text)];
        if (i.kind === 'rules_error') return [h('p', null, i.message)];
        return [];
      });

      // --- A card, stamped by its own tap ----------------------------------------------------------------------
      /** Shows a Form 27-B card for `card` in `slot`; a tap writes it through the panel's writer. */
      function showCard(slot: HTMLElement, card: RuleCard, onDone: () => void): void {
        // issuedTurn 0: a typed yes in the panel can never reach this card.
        const view: LocalCardView = { origin: 'local', localId: crypto.randomUUID(), card, issuedTurn: 0 };
        const signedOut = store.get().account === null;
        const readback = card.readback.map((l) => contentText('p', dialogue.say(l.trigger, l.vars).text, { class: 'rules-readback' }));
        const extra = h('div', { class: 'rules-card-extra' });
        const cardEl = renderCard(view, {
          forms, now: ctx.now, ...(signedOut ? { footnote: DEVICE_ONLY_FOOTNOTE } : {}),
          onConfirm: async (edits) => {
            const out = await writer.confirm(view, 'tap', edits).catch((err: unknown) => {
              console.error(err);
              return { ok: false as const, reason: 'network' as const, items: [] };
            });
            if (out.ok) {
              box.replaceChildren(h('p', { class: 'rules-stamped' }, `✔ Stamped: ${out.trail.summary}`));
              tell(...saidNodes(out.items));
              onDone();
              return;
            }
            switch (out.reason) {
              case 'consent_required':
                extra.replaceChildren(...saidNodes(out.items));
                showConsent(extra);
                return;
              case 'network':
                setCardNote(cardEl, NOT_SAVED_TEXT);
                return;
              case 'tap_required':
                return;
              case 'invalid':
              case 'closed':
              case 'needs_account':
                closeCard(cardEl, CLOSED_TEXT);
                extra.replaceChildren(...saidNodes(out.items));
                return;
            }
          },
          onReject: () => {
            void writer.reject(view);
            box.remove();
            tell(h('p', null, 'Nothing was saved.'));
            onDone();
          },
        });
        const box = h('div', { class: 'rules-card' }, ...readback, cardEl, extra);
        slot.replaceChildren(box);
        cardEl.querySelector<HTMLElement>('h3')?.setAttribute('tabindex', '-1');
        cardEl.querySelector<HTMLElement>('h3')?.focus();
      }

      /** The health_data card (Form 3-C), by tap only (C-17, P-4). */
      function showConsent(slot: HTMLElement): void {
        void client.consents().then((r) => {
          const notice = r.ok ? r.data.notices.health_data : undefined;
          const form = forms.consent_health as BureauForm | undefined;
          if (notice === undefined || form === undefined) { slot.append(h('p', { role: 'status' }, CONSENT_UNAVAILABLE_TEXT)); return; }
          const card = renderConsentCard('health_data', {
            form, notice,
            onAgree: async () => {
              const g = await client.grantConsent('health_data', notice.version);
              if (g.ok) card.replaceWith(h('p', { role: 'status' }, CONSENT_DONE_TEXT));
              else setCardNote(card, "That didn't go through. Nothing has changed.");
            },
            onDecline: () => { card.remove(); },
          });
          slot.append(card);
        });
      }

      // --- Removing ----------------------------------------------------------------------------------------------
      async function removeRule(rule: Rule): Promise<void> {
        const name = ruleName(rule, ruleTerms, graph);
        const severe = SEVERE.has(rule.severity);
        const answer = await showBureauForm(doc.getElementById('overlay-root') ?? doc.body, {
          form: forms.rule_void,
          values: { ingredient: name, severity: SEVERITY_WORDS[rule.severity], effect: 'Dishes will no longer be checked for this.' },
          ...(severe ? { lead: dialogue.say('rule.void_confirm', { ingredient: name }).text } : {}),
          reducedMotion: reducedMotion(store.get().settings.reducedMotion, mql),
          stamps: content.bureau.stamps,
          signal,
        });
        if (answer !== 'confirm') return;
        const email = store.get().account?.email;
        if (email !== undefined) {
          const r = await client.deleteRule(rule.id);
          if (!r.ok && r.status !== 404) { tell(h('p', null, NOT_REMOVED_TEXT)); return; }
          store.update((s) => (s.account?.email !== email || s.accountRules === null ? s : { ...s, accountRules: s.accountRules.filter((x) => x.id !== rule.id) }));
          void refreshAccount(client, store);
        } else {
          store.update((s) => ({ ...s, localRules: s.localRules.filter((x) => x.id !== rule.id) }));
        }
        const undo = h('button', { type: 'button', class: 'btn btn-secondary rules-undo' }, 'Undo');
        undo.addEventListener('click', () => { void restore(rule, email); });
        tell(contentText('p', dialogue.say('rule.voided', { ingredient: name }).text), undo);
        doc.getElementById('rules-heading')?.focus();
      }

      /** Undo a removal: the same rule back, where it was. */
      async function restore(rule: Rule, email: string | undefined): Promise<void> {
        if (email === undefined) {
          store.update((s) => (s.localRules.some((x) => x.id === rule.id) ? s : { ...s, localRules: [...s.localRules, rule] }));
          tell(h('p', null, RESTORED_TEXT));
          return;
        }
        const { id: _id, ...body } = rule;
        const r = await client.createRule(body, true);
        if (!r.ok) { tell(h('p', null, NOT_SAVED_TEXT)); return; }
        const saved = r.data.rule;
        store.update((s) => (s.account?.email !== email || s.accountRules === null ? s : { ...s, accountRules: [...s.accountRules.filter((x) => x.id !== saved.id), saved] }));
        void refreshAccount(client, store);
        tell(h('p', null, RESTORED_TEXT));
      }

      // --- Drawing -----------------------------------------------------------------------------------------------
      function drawBanner(s: PlayerState): void {
        if (!s.rulesUnreadable) { banner.replaceChildren(); return; }
        const confirm = h('button', { type: 'button', class: 'btn btn-primary', id: 'rules-confirm-all' }, UNREADABLE_CONFIRM);
        confirm.addEventListener('click', () => {
          store.confirmRules(store.get().localRules);
          tell(h('p', null, 'Thank you. Dishes are checked against these rules again.'));
          doc.getElementById('rules-heading')?.focus();
        });
        banner.replaceChildren(h('div', { class: 'notice rules-unreadable', role: 'note' }, h('p', null, RULES_UNREADABLE_MESSAGE), confirm));
      }

      function drawList(s: PlayerState): void {
        const state = activeRules(s, graph);
        const signedIn = s.account !== null;
        if (state.status === 'error' && state.reason === 'account_not_loaded') {
          listBox.replaceChildren(h('p', { class: 'notice' }, ACCOUNT_NOT_LOADED_MESSAGE));
          return;
        }
        const rules = signedIn ? s.accountRules ?? [] : s.localRules;
        const where = signedIn ? 'on your account' : 'on this device';
        const items = rules.map((rule) => {
          const bad = validateRules([rule], graph).length > 0;
          const remove = h('button', { type: 'button', class: 'btn btn-secondary rules-remove' }, 'Remove');
          remove.addEventListener('click', () => { void removeRule(rule); });
          const label = ruleName(rule, ruleTerms, graph);
          return h('li', { class: `rules-item${bad ? ' is-bad' : ''}`, 'data-rule': rule.id },
            h('p', { class: 'rules-name' }, h('strong', null, label)),
            h('p', { class: 'rules-meta' }, `${SEVERE.has(rule.severity) ? '⚠ ' : ''}${SEVERITY_WORDS[rule.severity]}, ${where}`),
            bad ? h('p', { class: 'rules-bad' }, BAD_RULE_TEXT) : null,
            h('div', { class: 'button-row' }, remove));
        });
        listBox.replaceChildren(
          state.status === 'error' && state.reason === 'invalid' ? h('p', { class: 'notice' }, RULES_INVALID_MESSAGE) : '',
          rules.length === 0
            ? h('p', null, signedIn ? 'Your account has no rules yet.' : 'No rules are saved on this device yet.')
            : h('ul', { class: 'rules-list', 'aria-label': 'Your rules' }, ...items),
        );
      }

      /** Carry from Step 9: device rules the signed-in account lacks are named, and each can be copied through a confirm card. */
      function drawCopy(s: PlayerState): void {
        if (s.account === null || s.accountRules === null) { copyBox.replaceChildren(); return; }
        const account = s.accountRules;
        const missing = s.localRules.filter((l) => !account.some((a) => a.type === l.type && sameIds(a.target.ids, l.target.ids)));
        if (missing.length === 0) { copyBox.replaceChildren(); return; }
        copyBox.replaceChildren(
          h('section', { class: 'panel rules-copy', 'aria-labelledby': 'rules-copy-title' },
            h('h2', { id: 'rules-copy-title' }, 'On this device only'),
            h('p', { class: 'notice' }, COPY_WARNING),
            h('ul', { class: 'rules-list' }, ...missing.map((rule) => {
              const slot = h('div', { class: 'rules-copy-slot' });
              const card = cardForRule(rule, ruleTerms, graph);
              const copy = h('button', { type: 'button', class: 'btn btn-secondary rules-copy-btn' }, 'Copy to my account');
              copy.addEventListener('click', () => { if (card) showCard(slot, card, () => undefined); });
              return h('li', { class: 'rules-item' },
                h('p', { class: 'rules-name' }, h('strong', null, ruleName(rule, ruleTerms, graph))),
                h('p', { class: 'rules-meta' }, `${SEVERITY_WORDS[rule.severity]}, on this device`),
                card ? h('div', { class: 'button-row' }, copy) : h('p', null, CANT_COPY_TEXT),
                slot);
            }))));
      }

      let key = '';
      const draw = () => {
        const s = store.get();
        const k = rulesKey(s);
        if (k === key) return;
        key = k;
        drawBanner(s);
        drawList(s);
        drawCopy(s);
      };
      draw();
      stops = [store.subscribe(draw)];

      let stopForm: (() => void) | null = null;
      addBtn.addEventListener('click', () => {
        stopForm?.();
        addBox.replaceChildren();
        addBtn.hidden = true;
        const formSlot = h('div');
        addBox.append(formSlot);
        stopForm = mountRuleForm(formSlot, { graph, ruleTerms, onCard: (card) => {
          stopForm?.();
          stopForm = null;
          showCard(addBox, card, () => { addBtn.hidden = false; });
        } });
        formSlot.querySelector<HTMLElement>('#rule-search')?.focus();
      });

      el.append(
        h('h1', { id: 'rules-heading', tabindex: -1 }, 'Your rules'),
        h('p', null, 'The allergies, intolerances and diet rules dishes are checked against. Every rule is read back and stamped before it counts.'),
        banner,
        status,
        listBox,
        copyBox,
        h('section', { class: 'panel', 'aria-labelledby': 'rules-add-title' },
          h('h2', { id: 'rules-add-title' }, 'Add a rule'),
          h('p', null, 'Choose an ingredient or a diet rule, say how serious it is, and stamp the form.'),
          addBox,
          addBtn),
      );
    },
    unmount() {
      leaving?.abort();
      for (const stop of stops) stop();
      stops = [];
    },
  };
}

export function registerRulesScreen(): void { registerScreen('rules', rulesScreen); }
