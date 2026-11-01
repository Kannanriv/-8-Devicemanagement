import { readFileSync } from "node:fs";
import path from "node:path";
import { runVectors } from "@hash8/codec-runtime";
import { safeParseSpec } from "@hash8/dcs-schema";
import { extractFromWorkbook } from "../src";

const root = path.resolve(import.meta.dirname, "../../..");
const pairs: [string, string][] = [
  ["Envio_TH-Sense_Payload_Spec.xlsx", "envio.th-sense.json"],
  ["Voltix_EM3_Modbus-MQTT_Map.xlsx", "voltix.energy-em3.json"],
  ["Acme_GT200_Protocol_v2.3.xlsx", "acme.tracker-gt200.json"],
];
for (const [x, j] of pairs) {
  const r = await extractFromWorkbook(readFileSync(path.join(root, "samples/excel", x)), { fileName: x });
  const spec = JSON.parse(readFileSync(path.join(root, "samples/specs", j), "utf8"));
  const v = safeParseSpec(r.draft);
  console.log(`\n=== ${x}: valid=${v.success} conf=${r.confidence} msgs=${[...r.draft.uplink, ...(r.draft.downlink ?? [])].map((m) => m.name).join(",")} fields=${Object.keys(r.trace).length} vectors=${r.draft.vectors?.length} examples=${r.examples.length}`);
  if (!v.success) console.log(v.error.issues.slice(0, 5));
  console.log("issues:\n  " + r.issues.join("\n  "));
  const own = runVectors(r.draft);
  console.log("own vectors:", own.map((o) => `${o.pass ? "PASS" : "FAIL"} ${o.name} ${(o.diff ?? []).slice(0, 2).join("; ")}`));
  const theirs = runVectors({ ...r.draft, vectors: spec.vectors });
  console.log("spec vectors:", theirs.filter((o) => o.pass).length, "/", theirs.length);
  for (const o of theirs.filter((o) => !o.pass)) console.log("  FAIL", o.name, (o.diff ?? []).slice(0, 3).join("; "));
  if (process.argv[2] === x) console.log(JSON.stringify(r.draft.uplink, (k, val) => (k === "source" ? undefined : val), 1));
}
