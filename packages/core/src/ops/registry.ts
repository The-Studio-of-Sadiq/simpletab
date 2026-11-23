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
  for (const op of SETUP_OPS) {
    registry.register(op);
  }
  return registry;
}
