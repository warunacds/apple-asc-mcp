import { z } from "zod";
import { tool } from "./registry.js";
import { xcArchive, xcExportArchive } from "../xcode.js";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const XC_NOTE = "Requires macOS with Xcode installed. Will throw on other platforms.";

export const xcArchiveTool = tool({
  name: "xc_archive",
  description: `Run \`xcodebuild ... archive\` to produce an .xcarchive bundle. ${XC_NOTE} Either workspacePath or projectPath is required.`,
  inputSchema: z.object({
    workspacePath: z.string().optional(),
    projectPath: z.string().optional(),
    scheme: z.string(),
    configuration: z.string().default("Release").optional(),
    archivePath: z.string().describe("Where to write the .xcarchive bundle, e.g. build/MyApp.xcarchive"),
    platform: z.enum(["iOS", "macOS", "tvOS", "visionOS", "watchOS"]).default("iOS").optional(),
    destination: z.string().optional().describe("Override destination string (default: generic/platform=<platform>)."),
    allowProvisioningUpdates: z.boolean().default(true).optional(),
    extraBuildSettings: z.record(z.string()).optional().describe("Map of NAME=VALUE build settings (e.g. DEVELOPMENT_TEAM=ABCD123456)."),
    timeoutMinutes: z.number().int().min(1).max(180).default(30).optional(),
  }).strict().refine((v) => v.workspacePath || v.projectPath, { message: "workspacePath or projectPath required" }),
  handler: async (input, { config }) => {
    const result = await xcArchive({
      workspacePath: input.workspacePath,
      projectPath: input.projectPath,
      scheme: input.scheme,
      configuration: input.configuration ?? "Release",
      archivePath: input.archivePath,
      platformPreset: input.platform ?? "iOS",
      destination: input.destination,
      allowProvisioningUpdates: input.allowProvisioningUpdates ?? true,
      extraBuildSettings: input.extraBuildSettings,
      timeoutMs: (input.timeoutMinutes ?? 30) * 60_000,
      authenticationKeyPath: config.privateKeyPath,
      authenticationKeyId: config.keyId,
      authenticationKeyIssuerId: config.issuerId,
    });
    return {
      ok: true,
      archivePath: input.archivePath,
      stdoutTail: result.stdout.split("\n").slice(-15).join("\n"),
    };
  },
});

export const xcExportTool = tool({
  name: "xc_export_ipa",
  description: `Run \`xcodebuild -exportArchive\` to produce an .ipa from an .xcarchive. ${XC_NOTE}`,
  inputSchema: z.object({
    archivePath: z.string(),
    exportPath: z.string().describe("Output directory where the .ipa is written."),
    /** Either give the path to an existing plist, or pass exportOptions to have one materialized. */
    exportOptionsPlist: z.string().optional(),
    exportOptions: z.object({
      method: z.enum(["app-store-connect", "release-testing", "enterprise", "debugging", "developer-id", "mac-application", "validation", "package", "app-store"]).default("app-store-connect"),
      teamID: z.string().optional(),
      destination: z.enum(["export", "upload"]).default("export").optional(),
      signingStyle: z.enum(["manual", "automatic"]).optional(),
      signingCertificate: z.string().optional(),
      provisioningProfiles: z.record(z.string()).optional().describe("Map of bundleId → provisioning profile name/UUID."),
      uploadSymbols: z.boolean().default(true).optional(),
      stripSwiftSymbols: z.boolean().default(true).optional(),
      manageAppVersionAndBuildNumber: z.boolean().default(false).optional(),
    }).optional(),
    allowProvisioningUpdates: z.boolean().default(true).optional(),
    timeoutMinutes: z.number().int().min(1).max(60).default(15).optional(),
  }).strict(),
  handler: async (input, { config }) => {
    let plistPath = input.exportOptionsPlist;
    if (!plistPath) {
      if (!input.exportOptions) throw new Error("Either exportOptionsPlist or exportOptions is required.");
      const dir = await mkdtemp(join(tmpdir(), "asc-mcp-export-"));
      plistPath = join(dir, "ExportOptions.plist");
      await writeFile(plistPath, plistFromOptions(input.exportOptions), "utf8");
    }
    const result = await xcExportArchive({
      archivePath: input.archivePath,
      exportOptionsPlist: plistPath,
      exportPath: input.exportPath,
      allowProvisioningUpdates: input.allowProvisioningUpdates ?? true,
      timeoutMs: (input.timeoutMinutes ?? 15) * 60_000,
      authenticationKeyPath: config.privateKeyPath,
      authenticationKeyId: config.keyId,
      authenticationKeyIssuerId: config.issuerId,
    });
    return {
      ok: true,
      exportPath: input.exportPath,
      exportOptionsPlist: plistPath,
      stdoutTail: result.stdout.split("\n").slice(-15).join("\n"),
    };
  },
});

function plistFromOptions(opts: Record<string, unknown>): string {
  const entries: string[] = [];
  for (const [k, v] of Object.entries(opts)) {
    if (v === undefined) continue;
    entries.push(`  <key>${escapeXml(k)}</key>`);
    entries.push(plistValue(v, "  "));
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${entries.join("\n")}
</dict>
</plist>
`;
}

function plistValue(v: unknown, indent: string): string {
  if (typeof v === "string") return `${indent}<string>${escapeXml(v)}</string>`;
  if (typeof v === "boolean") return `${indent}<${v ? "true" : "false"}/>`;
  if (typeof v === "number") return `${indent}<integer>${v}</integer>`;
  if (Array.isArray(v)) return `${indent}<array>\n${v.map((x) => plistValue(x, indent + "  ")).join("\n")}\n${indent}</array>`;
  if (v && typeof v === "object") {
    const pairs: string[] = [];
    for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
      pairs.push(`${indent}  <key>${escapeXml(k)}</key>`);
      pairs.push(plistValue(vv, indent + "  "));
    }
    return `${indent}<dict>\n${pairs.join("\n")}\n${indent}</dict>`;
  }
  return `${indent}<string>${escapeXml(String(v))}</string>`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]!));
}
