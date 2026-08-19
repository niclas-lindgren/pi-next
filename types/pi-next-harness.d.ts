/* The Pi runtime supplies these external types; the local app does not bundle the harness package. */
/* eslint-disable @typescript-eslint/no-explicit-any */

declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionSession extends ExtensionCommandContext {
    sendUserMessage(message: string, options?: { deliverAs?: "followUp" }): void;
  }
  export interface ExtensionCommandContext {
    cwd: string;
    isIdle(): boolean;
    waitForIdle(): Promise<void>;
    newSession(options: { withSession: (next: ExtensionSession) => unknown }): Promise<void>;
    ui: {
      notify(message: string, level: string): void;
      setStatus(key: string, text: string | undefined): void;
      /** Live above-editor widget content, or undefined to clear it (#614). */
      setWidget(
        key: string,
        content: string[] | undefined,
        options?: { placement?: "aboveEditor" | "belowEditor" },
      ): void;
      /** Minimal styling surface the live worker-display panel actually calls. */
      theme: {
        bold(text: string): string;
        fg(color: string, text: string): string;
      };
    };
    /** Whether dialog-capable UI is available (true in TUI/RPC modes). */
    hasUI: boolean;
    [key: string]: any;
  }
  export interface ExtensionAPI {
    registerEntryRenderer: <T = unknown>(
      customType: string,
      renderer: (entry: { data?: T }, options: unknown, theme: any) => any,
    ) => void;
    appendEntry: (...args: any[]) => void;
    sendUserMessage(message: string, options?: { deliverAs?: "followUp" }): void;
    registerCommand(name: string, config: {
      description?: string;
      getArgumentCompletions?: (prefix: string) => unknown;
      handler: (args: string, ctx: ExtensionCommandContext) => unknown;
    }): void;
    registerTool(config: {
      [key: string]: unknown;
      execute: (...args: any[]) => unknown;
    }): void;
    on(event: string, handler: (event: any, ctx: ExtensionCommandContext) => unknown): void;
  }
}

declare module "typebox" {
  export const Type: any;
}

declare module "@earendil-works/pi-tui" {
  export class Box {
    constructor(...args: any[]);
    addChild(child: any): void;
  }
  export class Text {
    constructor(...args: any[]);
  }
}
