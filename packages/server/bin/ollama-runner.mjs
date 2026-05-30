#!/usr/bin/env node
import { parseRunnerArgs, runOllama } from "../dist/adapters/ollama-runner.js";

const args = parseRunnerArgs(process.argv.slice(2));
try {
  await runOllama(args);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
