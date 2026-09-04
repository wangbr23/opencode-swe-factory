#!/usr/bin/env bun

import { createCoreContext } from "../core/index.js";

export function getCliHelp(): string {
  return `${createCoreContext().packageName} CLI scaffold`;
}

export function main(args: ReadonlyArray<string> = Bun.argv.slice(2)): number {
  if (args.includes("--help") || args.length === 0) {
    console.log(getCliHelp());
    return 0;
  }

  console.error("Unknown command.");
  return 1;
}

if (import.meta.main) {
  process.exit(main());
}
