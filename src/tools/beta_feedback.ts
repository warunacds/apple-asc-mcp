import { z } from "zod";
import { gunzipSync } from "node:zlib";
import { tool } from "./registry.js";

/**
 * TestFlight beta feedback — crash submissions and screenshot submissions, plus crash-log download.
 *
 * These use Apple's **current** (post-2023) feedback resources: `betaFeedbackCrashSubmissions` and
 * `betaFeedbackScreenshotSubmissions`, scoped per app. The older single `betaFeedbacks` collection is
 * intentionally omitted — it is superseded by these two and not exposed here.
 *
 * PII handling: a crash/screenshot submission carries tester-supplied `comment` and the tester's
 * `email`. List reads default to dropping that PII (`includePii=false`); single-resource reads default
 * to keeping it (`includePii=true`). Apple does not appear to offer a server-side PII toggle, so the
 * stripping is done in the handler by removing `email`/`comment` from attributes. [VERIFY] both the
 * field names that count as PII and whether Apple already omits them.
 *
 * Crash logs are downloaded as a raw body (gzipped plaintext per the reference implementation) and
 * gunzipped client-side with a plain-utf8 fallback, mirroring src/tools/reports.ts. [VERIFY] the
 * transport: whether the body is gzipped vs plain and whether `getRaw` needs a special Accept header.
 *
 * Not validated against live Apple traffic; response shapes are inferred and marked [VERIFY].
 */

/** App-platform / device-platform enum shared by both feedback list tools. */
const platformEnum = z.enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]);

/** Filters common to both feedback collections; all optional. Keys map to Apple's exact filter names. */
const feedbackFilters = {
  buildId: z.string().optional().describe("filter[build] — restrict to one build."),
  preReleaseVersionId: z.string().optional().describe("filter[build.preReleaseVersion]."),
  testerId: z.string().optional().describe("filter[tester] — restrict to one tester."),
  deviceModel: z.string().optional().describe("filter[deviceModel], e.g. iPhone14,2."),
  osVersion: z.string().optional().describe("filter[osVersion], e.g. 17.4."),
  appPlatform: platformEnum.optional().describe("filter[appPlatform]."),
  devicePlatform: platformEnum.optional().describe("filter[devicePlatform]."),
  sort: z.enum(["-createdDate", "createdDate"]).default("-createdDate"),
  includeRelated: z.boolean().default(false).describe("Sideload the build and tester (include=build,tester)."),
  includePii: z.boolean().default(false).describe("Keep tester email/comment in the result (off by default on lists)."),
  limit: z.number().int().min(1).max(200).default(100).optional(),
};

/** Build the JSON:API query for a feedback list from the shared filter inputs. */
function feedbackQuery(input: {
  buildId?: string; preReleaseVersionId?: string; testerId?: string; deviceModel?: string;
  osVersion?: string; appPlatform?: string; devicePlatform?: string; sort: string;
  includeRelated: boolean; limit?: number;
}): Record<string, string | number | undefined> {
  const q: Record<string, string | number | undefined> = { sort: input.sort, limit: input.limit ?? 100 };
  if (input.buildId) q["filter[build]"] = input.buildId;
  if (input.preReleaseVersionId) q["filter[build.preReleaseVersion]"] = input.preReleaseVersionId;
  if (input.testerId) q["filter[tester]"] = input.testerId;
  if (input.deviceModel) q["filter[deviceModel]"] = input.deviceModel;
  if (input.osVersion) q["filter[osVersion]"] = input.osVersion;
  if (input.appPlatform) q["filter[appPlatform]"] = input.appPlatform;
  if (input.devicePlatform) q["filter[devicePlatform]"] = input.devicePlatform;
  if (input.includeRelated) q.include = "build,tester";
  return q;
}

/** Drop tester PII from a submission's attribute object. [VERIFY] field names that count as PII. */
function stripPii(attributes: Record<string, unknown>): Record<string, unknown> {
  const { email, comment, ...rest } = attributes;
  void email; void comment;
  return rest;
}

/** Default and ceiling for crash-log truncation. */
const MAX_LOG_CHARS_DEFAULT = 100_000;

/**
 * Download a crash log body and return it truncated to `maxChars`. The body is gunzipped if it is
 * gzip, otherwise read as utf8 (reports.ts fallback). `totalCharacters`/`returnedCharacters`/
 * `truncated` describe the full text vs what is returned.
 */
async function readCrashLog(
  client: { getRaw: (path: string) => Promise<Buffer> },
  path: string,
  maxChars: number,
) {
  const buf = await client.getRaw(path);
  let text: string;
  try {
    text = gunzipSync(buf).toString("utf8");
  } catch {
    text = buf.toString("utf8"); // body may already be plain text
  }
  const totalCharacters = text.length;
  const truncated = totalCharacters > maxChars;
  const logText = truncated ? text.slice(0, maxChars) : text;
  return { totalCharacters, returnedCharacters: logText.length, truncated, logText };
}

export const listBetaFeedbackCrashesTool = tool({
  name: "asc_list_beta_feedback_crashes",
  description:
    "List TestFlight crash feedback submissions for an app. Filter by build, pre-release version, tester, device " +
    "model, OS version, or platform; sort by createdDate (newest first by default). Tester email/comment are dropped " +
    "unless includePii=true.",
  inputSchema: z.object({ appId: z.string(), ...feedbackFilters }).strict(),
  handler: async (input, { client }) => {
    const rows = await client.list<Record<string, unknown>>(
      `/v1/apps/${input.appId}/betaFeedbackCrashSubmissions`,
      feedbackQuery(input),
    );
    return rows.map((r) => ({
      id: r.id,
      ...(input.includePii ? r.attributes : stripPii(r.attributes ?? {})),
    }));
  },
});

export const getBetaFeedbackCrashTool = tool({
  name: "asc_get_beta_feedback_crash",
  description:
    "Get a single TestFlight crash feedback submission, including tester email/comment by default (set " +
    "includePii=false to drop them). Use includeRelated=true to sideload the build and tester.",
  inputSchema: z.object({
    submissionId: z.string(),
    includeRelated: z.boolean().default(false),
    includePii: z.boolean().default(true),
  }).strict(),
  handler: async (input, { client }) => {
    const query: Record<string, string> = {};
    if (input.includeRelated) query.include = "build,tester";
    const res = await client.get<{ data: { attributes?: Record<string, unknown> } }>(
      `/v1/betaFeedbackCrashSubmissions/${input.submissionId}`,
      { query },
    );
    if (!input.includePii && res?.data?.attributes) {
      res.data.attributes = stripPii(res.data.attributes);
    }
    return res;
  },
});

export const getBetaFeedbackCrashLogTool = tool({
  name: "asc_get_beta_feedback_crash_log",
  description:
    "Download the crash log text for a crash feedback submission, truncated to maxLogChars. Returns " +
    "totalCharacters, returnedCharacters, truncated, and logText.",
  inputSchema: z.object({
    submissionId: z.string(),
    maxLogChars: z.number().int().min(1).max(500_000).default(MAX_LOG_CHARS_DEFAULT).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    // [VERIFY] crashLog returns the log body directly (gzip vs plain) — see file header.
    return readCrashLog(client, `/v1/betaFeedbackCrashSubmissions/${input.submissionId}/crashLog`, input.maxLogChars ?? MAX_LOG_CHARS_DEFAULT);
  },
});

export const getBetaCrashLogByIdTool = tool({
  name: "asc_get_beta_crash_log_by_id",
  description:
    "Download a crash log directly by its betaCrashLogs id (from a submission's relationships.crashLog.data.id), " +
    "truncated to maxLogChars. Returns totalCharacters, returnedCharacters, truncated, and logText.",
  inputSchema: z.object({
    crashLogId: z.string(),
    maxLogChars: z.number().int().min(1).max(500_000).default(MAX_LOG_CHARS_DEFAULT).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    // [VERIFY] /v1/betaCrashLogs/:id returns the log body directly (gzip vs plain) — see file header.
    return readCrashLog(client, `/v1/betaCrashLogs/${input.crashLogId}`, input.maxLogChars ?? MAX_LOG_CHARS_DEFAULT);
  },
});

export const deleteBetaFeedbackCrashTool = tool({
  name: "asc_delete_beta_feedback_crash",
  description: "Delete a TestFlight crash feedback submission by id.",
  inputSchema: z.object({ submissionId: z.string() }).strict(),
  handler: async (input, { client }) => {
    await client.delete(`/v1/betaFeedbackCrashSubmissions/${input.submissionId}`);
    return { ok: true, submissionId: input.submissionId };
  },
});

export const listBetaFeedbackScreenshotsTool = tool({
  name: "asc_list_beta_feedback_screenshots",
  description:
    "List TestFlight screenshot feedback submissions for an app. Same filters as crash feedback. Each submission " +
    "carries a screenshots array (url, width, height, expirationDate). Tester email/comment are dropped unless " +
    "includePii=true.",
  inputSchema: z.object({ appId: z.string(), ...feedbackFilters }).strict(),
  handler: async (input, { client }) => {
    const rows = await client.list<Record<string, unknown>>(
      `/v1/apps/${input.appId}/betaFeedbackScreenshotSubmissions`,
      feedbackQuery(input),
    );
    return rows.map((r) => ({
      id: r.id,
      ...(input.includePii ? r.attributes : stripPii(r.attributes ?? {})),
    }));
  },
});

export const getBetaFeedbackScreenshotTool = tool({
  name: "asc_get_beta_feedback_screenshot",
  description:
    "Get a single TestFlight screenshot feedback submission, including tester email/comment by default (set " +
    "includePii=false to drop them). Use includeRelated=true to sideload the build and tester. Screenshot URLs " +
    "carry an expirationDate.",
  inputSchema: z.object({
    submissionId: z.string(),
    includeRelated: z.boolean().default(false),
    includePii: z.boolean().default(true),
  }).strict(),
  handler: async (input, { client }) => {
    const query: Record<string, string> = {};
    if (input.includeRelated) query.include = "build,tester";
    const res = await client.get<{ data: { attributes?: Record<string, unknown> } }>(
      `/v1/betaFeedbackScreenshotSubmissions/${input.submissionId}`,
      { query },
    );
    if (!input.includePii && res?.data?.attributes) {
      res.data.attributes = stripPii(res.data.attributes);
    }
    return res;
  },
});

export const deleteBetaFeedbackScreenshotTool = tool({
  name: "asc_delete_beta_feedback_screenshot",
  description: "Delete a TestFlight screenshot feedback submission by id.",
  inputSchema: z.object({ submissionId: z.string() }).strict(),
  handler: async (input, { client }) => {
    await client.delete(`/v1/betaFeedbackScreenshotSubmissions/${input.submissionId}`);
    return { ok: true, submissionId: input.submissionId };
  },
});
