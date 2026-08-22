import { DependencySetupFailure } from "./types.js";

export class BootstrapError extends Error {
  readonly code: string;

  constructor(message: string, code = "BOOTSTRAP_FAILED") {
    super(message);
    this.name = "BootstrapError";
    this.code = code;
  }
}

export class BootstrapSetupError extends BootstrapError implements DependencySetupFailure {
  readonly code = "DEPENDENCY_SETUP_FAILED" as const;

  constructor(message: string) {
    super(message, "DEPENDENCY_SETUP_FAILED");
    this.name = "BootstrapSetupError";
  }
}
