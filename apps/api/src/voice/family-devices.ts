// M7 Step 9 fix round 2 (controller ruling, option 2): which of a user's devices reported Family Table mode, so one
// device's `{ on: false }` never clears a block another device set (Ruling 17). In memory only, like the registry it
// feeds (`voice/registry.ts`, untouched: it is in the eval closure). A device id is a random per-install UUID the game
// keeps in its own storage: opaque, never personal data, never stored, logged or audited here. A restart clears it, as
// it clears the registry; a device in Family Table reports again at its next start, and refuses the microphone itself
// meanwhile.

/**
 * At most this many devices per user are remembered (abuse only). Past it, `on` still blocks, and (fix round 3, N-7)
 * the user is marked: an `off` never lifts the block while a device that reported on was not recorded; a restart does.
 */
export const MAX_FAMILY_DEVICES = 32;

class FamilyDevices {
  private readonly byUser = new Map<string, Set<string>>();
  private readonly overflow = new Set<string>();

  /** The device is in Family Table now. True when it is remembered (false only past MAX_FAMILY_DEVICES). */
  on(userId: string, deviceId: string): boolean {
    let set = this.byUser.get(userId);
    if (set === undefined) this.byUser.set(userId, (set = new Set()));
    if (!set.has(deviceId) && set.size >= MAX_FAMILY_DEVICES) { this.overflow.add(userId); return false; }
    set.add(deviceId);
    return true;
  }

  /**
   * The device left Family Table. True only when this removal emptied a set that held it: then, and only then, the
   * user's block may lift. A device that never reported `on` changes nothing (a no-op).
   */
  off(userId: string, deviceId: string): boolean {
    const set = this.byUser.get(userId);
    if (set === undefined || !set.delete(deviceId)) return false;
    if (set.size > 0) return false;
    this.byUser.delete(userId);
    return !this.overflow.has(userId);
  }

  /** Counts only, for tests. */
  count(userId: string): number {
    return this.byUser.get(userId)?.size ?? 0;
  }
}

/** The process's Family Table devices (Ruling 17, fix round 2). Only `family-routes.ts` uses it. */
export const familyDevices = new FamilyDevices();
