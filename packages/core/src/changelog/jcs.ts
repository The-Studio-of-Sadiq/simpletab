/**
 * RFC 8785 (JSON Canonicalization Scheme) for hashing and signing. This is the single
 * canonical-JSON implementation in core; crypto/ re-exports it.
 */

/** Thrown for values JSON cannot represent exactly (non-finite numbers, bigint, functions, cycles). */
export class CanonicalJsonError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function serialize(value: unknown, seen: WeakSet<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(`Cannot canonicalize non-finite number: ${String(value)}`);
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "undefined":
      throw new CanonicalJsonError("Cannot canonicalize undefined");
    case "bigint":
      throw new CanonicalJsonError("Cannot canonicalize bigint");
    case "function":
      throw new CanonicalJsonError("Cannot canonicalize function");
    case "symbol":
      throw new CanonicalJsonError("Cannot canonicalize symbol");
    case "object": {
      // Like JSON.stringify, use an object's toJSON() (e.g. Date → ISO string) before serialising.
      const withToJson = value as { toJSON?: unknown };
      if (typeof withToJson.toJSON === "function") {
        return serialize((withToJson.toJSON as () => unknown).call(value), seen);
      }
      if (seen.has(value)) {
        throw new CanonicalJsonError("Cannot canonicalize circular structure");
      }
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          const items: string[] = [];
          for (let i = 0; i < value.length; i++) {
            const element: unknown = value[i];
            items.push(element === undefined ? "null" : serialize(element, seen));
          }
          return `[${items.join(",")}]`;
        }

        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).sort(compareUtf16);
        const members: string[] = [];
        for (const key of keys) {
          const memberValue = record[key];
          if (memberValue === undefined) {
            continue;
          }
          members.push(`${JSON.stringify(key)}:${serialize(memberValue, seen)}`);
        }
        return `{${members.join(",")}}`;
      } finally {
        seen.delete(value);
      }
    }
    default:
      throw new CanonicalJsonError(`Unsupported value type: ${typeof value}`);
  }
}

/**
 * Serializes a JSON-compatible value according to RFC 8785 (JSON Canonicalization Scheme).
 */
export function canonicalize(value: unknown): string {
  return serialize(value, new WeakSet<object>());
}
