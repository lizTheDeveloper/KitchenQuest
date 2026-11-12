// M7 Ruling 17 (P3): the per-user voice block, server-held and in memory only (§19: "Server speech-to-text is off" for
// children, whatever the device says). This file imports core types only: no Fastify, no mentor and no upstream code,
// so `mentor/turn.ts` can import it (Step 6) and the voice route stays out of the eval closure.
import type { VoiceCloseReason } from '@kitchenquest/core';

/**
 * How long a child flag blocks voice: the mentor's child-flag TTL (`mentor/constants.ts` MEMORY_TTL_MS, 30 minutes),
 * restated here because this file may not import the mentor; voice-block.test.ts pins the two equal.
 */
export const CHILD_BLOCK_TTL_MS = 30 * 60_000;

/** What the registry needs of a voice socket: a way to close it with a reason. */
export interface VoiceSocketHandle {
  close(reason: VoiceCloseReason): void;
}

class VoiceRegistry {
  private readonly sockets = new Map<string, Set<VoiceSocketHandle>>();
  /** userId → when a child flag was last set in any of the user's conversations. */
  private readonly child = new Map<string, number>();
  /** Users whose device reported Family Table mode (PUT /voice/family-table, or hello.familyTable: true). */
  private readonly familyTable = new Set<string>();

  /**
   * Adds the user's voice socket and returns its remover. A user has one voice socket per server: any older one is
   * closed first with `another_tab`.
   */
  add(userId: string, sock: VoiceSocketHandle): () => void {
    this.closeAll(userId, 'another_tab');
    let set = this.sockets.get(userId);
    if (set === undefined) this.sockets.set(userId, (set = new Set()));
    set.add(sock);
    return () => {
      const s = this.sockets.get(userId);
      if (s === undefined) return;
      s.delete(sock);
      if (s.size === 0) this.sockets.delete(userId);
    };
  }

  /** A child flag was set in one of the user's conversations: every voice socket of theirs closes with `child`. */
  childFlagged(userId: string, nowMs: number): void {
    this.child.set(userId, nowMs);
    this.closeAll(userId, 'child');
  }

  /** The device's Family Table report. On closes every voice socket of the user with `family_table`; off clears it. */
  setFamilyTable(userId: string, on: boolean): void {
    if (!on) {
      this.familyTable.delete(userId);
      return;
    }
    this.familyTable.add(userId);
    this.closeAll(userId, 'family_table');
  }

  /** Why the user may not use voice now: `child` (within CHILD_BLOCK_TTL_MS of the last flag), `family_table`, or null. */
  blocked(userId: string, nowMs: number): VoiceCloseReason | null {
    const at = this.child.get(userId);
    if (at !== undefined) {
      if (nowMs - at < CHILD_BLOCK_TTL_MS) return 'child';
      this.child.delete(userId);
    }
    return this.familyTable.has(userId) ? 'family_table' : null;
  }

  /** Drops expired child flags (app.ts sweeps every minute). */
  sweep(nowMs: number): void {
    for (const [userId, at] of [...this.child]) if (nowMs - at >= CHILD_BLOCK_TTL_MS) this.child.delete(userId);
  }

  /** Counts only, for tests. */
  openSockets(userId: string): number {
    return this.sockets.get(userId)?.size ?? 0;
  }

  private closeAll(userId: string, reason: VoiceCloseReason): void {
    for (const sock of [...(this.sockets.get(userId) ?? [])]) sock.close(reason);
  }
}

/** The process's voice registry (Ruling 17). Imported by the voice route and, from Step 6, the mentor turn. */
export const voiceRegistry = new VoiceRegistry();
