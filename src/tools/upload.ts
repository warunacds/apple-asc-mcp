import { z } from "zod";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { tool } from "./registry.js";
import { runUpload } from "../upload.js";
import { altoolUploadOrValidate } from "../xcode.js";
import { dirname } from "node:path";
import type { BuildAttrs, BuildUploadAttrs, BuildUploadFileAttrs } from "../types.js";
import { log } from "../log.js";

/**
 * Upload an .ipa to App Store Connect.
 *
 * Default path: REST `/v1/buildUploads` (WWDC25). Cross-platform — works on macOS or Linux.
 * Fallback path: `xcrun altool --upload-package` (macOS-only, requires Xcode).
 */
export const uploadIpaTool = tool({
  name: "asc_upload_ipa",
  description:
    "Upload a built .ipa to App Store Connect. By default uses the REST /v1/buildUploads flow (WWDC25, cross-platform). " +
    "Set method=\"altool\" to use xcrun altool (macOS only). Returns the buildUpload id (REST) or altool output.",
  inputSchema: z.object({
    ipaPath: z.string().describe("Absolute path to the .ipa file."),
    platform: z.enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]).default("IOS"),
    bundleVersion: z.string().describe("CFBundleVersion, e.g. \"42\". Read from the IPA's Info.plist by your build step."),
    method: z.enum(["rest", "altool"]).optional().describe("Override the default. \"rest\" uses /v1/buildUploads; \"altool\" uses xcrun altool."),
    appleId: z.string().optional().describe("(altool only) numeric App Store ID, makes errors more legible."),
    bundleId: z.string().optional().describe("(altool only) reverse-DNS bundle id."),
    bundleShortVersionString: z.string().optional().describe("(altool only) marketing version string."),
  }).strict(),
  handler: async (input, { client, config }) => {
    const method = input.method ?? (config.preferRestUpload ? "rest" : "altool");
    if (method === "rest") {
      return await uploadViaRest(input.ipaPath, input.platform, input.bundleVersion, client);
    }
    const result = await altoolUploadOrValidate({
      ipaPath: input.ipaPath,
      type: input.platform === "MAC_OS" ? "macos" : input.platform === "TV_OS" ? "appletvos" : input.platform === "VISION_OS" ? "visionos" : "ios",
      apiKey: config.keyId,
      apiIssuer: config.issuerId,
      apiKeyDir: config.privateKeyPath ? dirname(config.privateKeyPath) : undefined,
      appleId: input.appleId,
      bundleId: input.bundleId,
      bundleShortVersionString: input.bundleShortVersionString,
      bundleVersion: input.bundleVersion,
      validateOnly: false,
    });
    return { method: "altool", ok: true, json: result.json };
  },
});

export const validateIpaTool = tool({
  name: "asc_validate_ipa",
  description: "Run xcrun altool --validate-app on an IPA before upload (macOS only). Catches signing/entitlement/ITMS errors fast.",
  inputSchema: z.object({
    ipaPath: z.string(),
    platform: z.enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]).default("IOS"),
    appleId: z.string().optional(),
    bundleId: z.string().optional(),
    bundleVersion: z.string().optional(),
    bundleShortVersionString: z.string().optional(),
  }).strict(),
  handler: async (input, { config }) => {
    const result = await altoolUploadOrValidate({
      ipaPath: input.ipaPath,
      type: input.platform === "MAC_OS" ? "macos" : input.platform === "TV_OS" ? "appletvos" : input.platform === "VISION_OS" ? "visionos" : "ios",
      apiKey: config.keyId,
      apiIssuer: config.issuerId,
      apiKeyDir: config.privateKeyPath ? dirname(config.privateKeyPath) : undefined,
      appleId: input.appleId,
      bundleId: input.bundleId,
      bundleVersion: input.bundleVersion,
      bundleShortVersionString: input.bundleShortVersionString,
      validateOnly: true,
    });
    return { ok: true, json: result.json };
  },
});

async function uploadViaRest(ipaPath: string, platform: string, bundleVersion: string, client: import("../client.js").AscClient) {
  const st = await stat(ipaPath);
  const fileName = basename(ipaPath);

  // [VERIFY] WWDC25 introduced /v1/buildUploads. Two details are inferred from sibling APIs and
  // could need adjustment when surfaced in real responses:
  //   1. `platform` — we use the standard Platform enum (IOS / MAC_OS / TV_OS / VISION_OS) used
  //      everywhere else in the API. The session transcript used a generic placeholder.
  //   2. `assetType: "BUILD"` for the main IPA/PKG. Other values may exist for accompanying
  //      assets (dSYMs, etc.) but Apple has not publicly enumerated them as of this writing.
  // If you hit a 400 from either step, set APP_STORE_CONNECT_PREFER_REST_UPLOAD=false to fall
  // back to `xcrun altool --upload-package` and please file an issue with the JSON:API error.
  log.info("REST upload step 1/3: create buildUpload", { fileName, fileSize: st.size, platform, bundleVersion });
  const created = await client.post<{ data: { id: string; attributes: BuildUploadAttrs } }>("/v1/buildUploads", {
    data: { type: "buildUploads", attributes: { bundleVersion, platform } },
  });
  const buildUploadId = created.data.id;

  log.info("REST upload step 2/3: create buildUploadFile reservation", { buildUploadId });
  const reservation = await client.post<{ data: { id: string; attributes: BuildUploadFileAttrs } }>("/v1/buildUploadFiles", {
    data: {
      type: "buildUploadFiles",
      attributes: { fileName, fileSize: st.size, assetType: "BUILD" },
      relationships: { buildUpload: { data: { type: "buildUploads", id: buildUploadId } } },
    },
  });
  const fileId = reservation.data.id;
  const ops = reservation.data.attributes?.uploadOperations ?? [];
  if (!ops.length) throw new Error("App Store Connect returned no uploadOperations for the buildUploadFile reservation.");

  const checksum = await runUpload(ipaPath, ops, {
    onProgress: (uploaded, total) => {
      if (uploaded === total || uploaded % (32 * 1024 * 1024) === 0) {
        log.info("upload progress", { uploaded, total, pct: Math.round((uploaded / total) * 100) });
      }
    },
  });

  log.info("REST upload step 3a: commit buildUploadFile", { fileId, checksum });
  await client.patch(`/v1/buildUploadFiles/${fileId}`, {
    data: { type: "buildUploadFiles", id: fileId, attributes: { uploaded: true, sourceFileChecksum: checksum } },
  });

  log.info("REST upload step 3b: commit buildUpload (uploaded:true)", { buildUploadId });
  const final = await client.patch<{ data: { id: string; attributes: BuildUploadAttrs } }>(`/v1/buildUploads/${buildUploadId}`, {
    data: { type: "buildUploads", id: buildUploadId, attributes: { uploaded: true } },
  });

  return {
    method: "rest",
    ok: true,
    buildUploadId,
    fileId,
    fileName,
    fileSize: st.size,
    state: final.data.attributes?.state ?? "UPLOADED",
    note: "Build is now uploaded. Apple will move it through PROCESSING — use asc_wait_for_build_processing or poll asc_list_builds.",
  };
}

export const waitForBuildTool = tool({
  name: "asc_wait_for_build_processing",
  description:
    "Poll App Store Connect until a build matching (appId, bundleVersion) finishes processing (state=VALID), fails (INVALID/FAILED), or times out. " +
    "Use this after asc_upload_ipa. Default poll interval 30s, default total wait 45m.",
  inputSchema: z.object({
    appId: z.string(),
    bundleVersion: z.string().describe("CFBundleVersion you uploaded."),
    preReleaseVersion: z.string().optional().describe("Marketing version (e.g. 1.4.0) to disambiguate when multiple bundleVersions overlap."),
    pollIntervalSeconds: z.number().int().min(10).max(300).default(30),
    timeoutMinutes: z.number().int().min(1).max(180).default(45),
  }).strict(),
  handler: async (input, { client }) => {
    const start = Date.now();
    const deadline = start + input.timeoutMinutes * 60_000;
    let attempt = 0;
    while (Date.now() < deadline) {
      attempt++;
      const q: Record<string, string | number | undefined> = {
        "filter[app]": input.appId,
        "filter[version]": input.bundleVersion,
        sort: "-uploadedDate",
        limit: 5,
        "fields[builds]": "version,uploadedDate,processingState,expired,buildAudienceType",
      };
      if (input.preReleaseVersion) q["filter[preReleaseVersion.version]"] = input.preReleaseVersion;
      const builds = await client.list<BuildAttrs>("/v1/builds", q);
      const candidate = builds[0];
      if (candidate) {
        const state = candidate.attributes?.processingState;
        log.info(`wait_for_build attempt ${attempt}`, { state, buildId: candidate.id });
        if (state === "VALID") {
          return {
            ok: true,
            buildId: candidate.id,
            state,
            elapsedSeconds: Math.round((Date.now() - start) / 1000),
            attributes: candidate.attributes,
          };
        }
        if (state === "INVALID" || state === "FAILED") {
          return {
            ok: false,
            buildId: candidate.id,
            state,
            elapsedSeconds: Math.round((Date.now() - start) / 1000),
            message: `Build processing terminated with state=${state}. Inspect the build in App Store Connect for the rejection reason.`,
          };
        }
      }
      await new Promise((r) => setTimeout(r, input.pollIntervalSeconds * 1000));
    }
    return {
      ok: false,
      state: "TIMEOUT",
      elapsedSeconds: Math.round((Date.now() - start) / 1000),
      message: `Build did not reach VALID within ${input.timeoutMinutes} minutes. It may still be processing — check App Store Connect.`,
    };
  },
});
