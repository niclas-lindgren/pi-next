#!/usr/bin/env node

import { runSkillsCli } from "./sync.ts";

const result = await runSkillsCli(process.argv.slice(2));
console.log(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
