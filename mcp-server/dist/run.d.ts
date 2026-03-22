export type RunMode = "stdio" | "http" | "http-tunnel";
export declare function parseArgs(argv: string[]): {
    mode: RunMode;
    mcpHttpPort: number;
};
export declare function main(): Promise<void>;
//# sourceMappingURL=run.d.ts.map