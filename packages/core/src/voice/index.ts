// M7 live voice: everything the device, the API and the voice service must agree on. Browser-safe: no I/O, no
// recipe parser. Contracts for later steps are on `heardCheck` (heard.ts), `HeardCheck.tooLong` (heard-types.ts),
// `parseServerMsg` (protocol.ts) and `parseUpstreamServerMsg` (upstream.ts). The public surface is exactly the Step 1 interface (pinned by index.test.ts).
export * from './constants';
export * from './protocol';
export * from './upstream';
export { phoneticKey, KNOWN_CONFUSIONS, soundAlikes, isRuleTermId } from './phonetic';
export { heardCheck, tryHeardChoice, applyHeardChoice, heardConfirmed } from './heard';
export type { HeardTerm, HeardCheck, HeardChoiceRefusal } from './heard';
export * from './speech';
export { cookCommand, type CookCommand } from './commands';
export * from './filler';
