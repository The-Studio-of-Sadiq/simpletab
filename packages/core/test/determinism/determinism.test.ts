import { beforeAll, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import committedHashes from "./draw-hashes.json";
import { drawHash } from "./hash";
import { scenarios } from "./scenarios";

interface ScenarioHashes {
  first: string;
  second: string;
}

const expectedHashes: Record<string, string> = committedHashes;
const hashesByScenario = new Map<string, ScenarioHashes>();
const updateHashes = process.env.UPDATE_DRAW_HASHES === "1";

beforeAll(async (): Promise<void> => {
  const generated = await Promise.all(
    scenarios.map(async (scenario): Promise<[string, ScenarioHashes]> => {
      const first = await drawHash(scenario.generate());
      const second = await drawHash(scenario.generate());
      return [scenario.name, { first, second }];
    }),
  );
  for (const [name, hashes] of generated) hashesByScenario.set(name, hashes);

  if (updateHashes) {
    const nextHashes = Object.fromEntries(generated.map(([name, hashes]) => [name, hashes.first]));
    const changed = generated.filter(([name, hashes]) => expectedHashes[name] !== hashes.first);
    const hashPath = fileURLToPath(new URL("./draw-hashes.json", import.meta.url));
    await writeFile(hashPath, `${JSON.stringify(nextHashes, null, 2)}\n`, "utf8");
    if (changed.length === 0) {
      process.stdout.write("Draw hashes are unchanged.\n");
    } else {
      const report = changed
        .map(([name, hashes]) => `  ${name}: ${expectedHashes[name] ?? "<missing>"} -> ${hashes.first}`)
        .join("\n");
      process.stdout.write(`Updated draw hashes:\n${report}\n`);
    }
  }
});

describe("draw determinism hashes", () => {
  for (const scenario of scenarios) {
    it(`${scenario.name} is stable and matches the committed hash`, () => {
      const hashes = hashesByScenario.get(scenario.name);
      expect(hashes).toBeDefined();
      expect(hashes!.second).toBe(hashes!.first);
      if (!updateHashes) expect(hashes!.first).toBe(expectedHashes[scenario.name]);
    });
  }
});
