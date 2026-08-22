import { resolve } from "node:path";

export * from "../src/bootstrap/index.js";
import { main } from "../src/bootstrap/cli.js";

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  });
}
