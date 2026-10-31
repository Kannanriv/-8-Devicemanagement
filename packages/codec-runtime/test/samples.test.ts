import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runVectors, createCodec } from "../src";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../samples/specs");
const files = ["acme.tracker-gt200.json", "voltix.energy-em3.json", "envio.th-sense.json"];

describe("sample specs", () => {
  it("all three seed specs exist", () => {
    const present = readdirSync(dir);
    for (const f of files) expect(present).toContain(f);
  });
  for (const f of files) {
    describe(f, () => {
      const spec = JSON.parse(readFileSync(join(dir, f), "utf8"));
      it("is a valid DCS whose id matches the file name", () => expect(createCodec(spec).spec.id + ".json").toBe(f));
      it("has >= 6 vectors covering every message", () => {
        const vs = spec.vectors as { message?: string; direction?: string }[];
        expect(vs.length).toBeGreaterThanOrEqual(6);
        const covered = new Set(vs.map((v) => v.message));
        for (const m of [...spec.uplink, ...(spec.downlink ?? [])]) expect(covered).toContain(m.name);
      });
      it("passes all vectors", () => {
        const res = runVectors(spec);
        const failed = res.filter((r) => !r.pass);
        expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
      });
    });
  }
});
