// M7 Step 8: the game's voice client, a lazy library with no UI. Reached only by `import('../voice')`, so first paint
// never carries it (B8). Step 9 puts it in the Pan's panel and Settings; Step 10 in cook mode.
export { createVoiceController, RAISED_DB, type HandsFreeOff, type VoiceController, type VoiceOffReason, type VoicePhase, type VoiceProblem } from './controller';
export { devBrowserProvider, handsFreeBuild, providerKind, serviceProvider, type ProviderEvent, type Speech, type Utterance, type VoiceProvider } from './providers';
export { speakPlan, CHECK_SCREEN } from './speak-plan';
export { sizzle } from './earcon';
export type { DeviceCommandRecognizer } from './device-commands';
