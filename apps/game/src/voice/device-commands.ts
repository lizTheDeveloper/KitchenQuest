// M7 Ruling 9: §19's on-device fixed commands for Family Table ("next step", "timer stop", …) are designed in here and
// built in M13, after counsel (C-45). There is deliberately no implementation: in M7 Family Table has no microphone.
// The commands themselves are core's `cookCommand`.
import type { CookCommand } from '@kitchenquest/core/engine';

export interface DeviceCommandRecognizer {
  start(onCommand: (c: CookCommand) => void): void;
  stop(): void;
}
