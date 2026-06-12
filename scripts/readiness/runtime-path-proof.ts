import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildRuntimePathProof,
  renderRuntimePathProofMarkdown,
  resolveRuntimePathProofOutputPath,
} from "@/readiness/runtime-path-proof";

const proof = buildRuntimePathProof();
const outputPath = resolveRuntimePathProofOutputPath();
mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${renderRuntimePathProofMarkdown(proof)}\n`);
console.log(outputPath);
if (proof.status !== "pass") process.exitCode = 1;
