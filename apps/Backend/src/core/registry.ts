import type { Performer, ConnectionStatus } from "../types.js";

/**
 * ConnectionRegistry — single roster view of live connections.
 *
 * Absorbs the module-level `members[]` array and the diff-prone conductor
 * bookkeeping that used to live inside the socket handlers:
 *   - performers join the roster on connect (names re-seed per boot, exactly
 *     like the old counter);
 *   - the single-conductor rule is enforced in one place;
 *   - `roster()` snapshots feed the Conductor UI's ConnectionsTable.
 *
 * Latency data is NOT owned here — SyncService measures it; /api/state merges.
 */
export class ConnectionRegistry {
  private performers: Performer[] = [];
  private counter = 0;
  private conductor: Performer | null = null;

  /** Add a performer connection, assigning the next auto name (Performer #N). */
  addPerformer(id: string): Performer {
    this.counter += 1;
    const performer: Performer = {
      id,
      name: `Performer #${this.counter}`,
      status: "Disconnected",
      latencies: [],
    };
    this.performers.push(performer);
    return performer;
  }

  /** Remove by socket id. Returns the removed record, or null when unknown. */
  removePerformer(id: string): Performer | null {
    const index = this.performers.findIndex((p) => p.id === id);
    if (index === -1) return null;
    const [removed] = this.performers.splice(index, 1);
    return removed ?? null;
  }

  /** Find a current performer record by socket id. */
  getPerformer(id: string): Performer | null {
    return this.performers.find((p) => p.id === id) ?? null;
  }

  setPerformerStatus(id: string, status: ConnectionStatus): void {
    const performer = this.getPerformer(id);
    if (performer) performer.status = status;
  }

  /** Snapshot for UI updates (order = join order, same as the old members array). */
  roster(): Performer[] {
    return [...this.performers];
  }

  /**
   * Enforce the single-conductor rule. Returns true when the conductor id
   * holds the seat (claims it, or already owns it).
   */
  claimConductor(id: string): boolean {
    if (this.conductor === null) {
      this.conductor = { id, name: "Conductor", status: "Disconnected", latencies: [] };
      return true;
    }
    return this.conductor.id === id;
  }

  /** Release the conductor seat (idempotent; no-op for other ids). */
  releaseConductor(id: string): void {
    if (this.conductor?.id === id) this.conductor = null;
  }

  get conductorId(): string | null {
    return this.conductor?.id ?? null;
  }
}
