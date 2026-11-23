import { ALLOCATION_OPS } from "./allocation";
import { BALLOT_OPS } from "./ballots";
import { BREAK_OPS } from "./breaks";
import { DEVICE_OPS } from "./devices";
import { DRAW_OPS } from "./draw";
import { FEEDBACK_OPS } from "./feedback";
import { LINKS_OPS } from "./links";
import { MOTION_OPS } from "./motions";
import { PROPOSAL_OPS } from "./proposals";
import { REGISTRATION_OPS } from "./registration";
import { RELEASE_OPS } from "./releases";
import { SETUP_OPS } from "./setup";
import type { OpDef, OpRegistryLookup } from "./types";

export class Registry implements OpRegistryLookup {
  private readonly ops = new Map<string, OpDef<unknown>>();

  register<P>(def: OpDef<P>): this {
    if (this.ops.has(def.type)) {
      throw new Error(`Duplicate operation registration: ${def.type}`);
    }
    this.ops.set(def.type, def as unknown as OpDef<unknown>);
    return this;
  }

  get(type: string): OpDef<unknown> | undefined {
    return this.ops.get(type);
  }

  has(type: string): boolean {
    return this.ops.has(type);
  }

  list(): OpDef<unknown>[] {
    return [...this.ops.values()];
  }

  types(): string[] {
    return [...this.ops.keys()];
  }
}

export function defaultRegistry(): Registry {
  const registry = new Registry();
  for (const op of [
    ...SETUP_OPS,
    ...DRAW_OPS,
    ...ALLOCATION_OPS,
    ...MOTION_OPS,
    ...BALLOT_OPS,
    ...FEEDBACK_OPS,
    ...BREAK_OPS,
    ...RELEASE_OPS,
    ...LINKS_OPS,
    ...REGISTRATION_OPS,
    ...DEVICE_OPS,
    ...PROPOSAL_OPS,
  ]) {
    registry.register(op);
  }
  return registry;
}
