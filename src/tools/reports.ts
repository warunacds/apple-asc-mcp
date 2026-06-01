import { z } from "zod";
import { gunzipSync } from "node:zlib";
import { tool } from "./registry.js";

/**
 * Reporting: Sales, Finance, and Analytics reports.
 *
 * Unlike the rest of the API, Sales/Finance reports return a **gzipped TSV** body (not JSON:API) — we
 * fetch raw bytes via client.getRaw with `Accept: application/a-gzip`, gunzip, and parse the TSV.
 * Analytics reports are asynchronous: you POST a request, then poll for generated report instances.
 *
 * Requires a key with the ACCESS_TO_REPORTS role (or Admin/Finance). Not validated against live Apple
 * traffic; filter names and the analytics flow are inferred and marked [VERIFY].
 */

function parseTsv(buf: Buffer, maxRows: number) {
  let text: string;
  try {
    text = gunzipSync(buf).toString("utf8");
  } catch {
    text = buf.toString("utf8"); // some responses may already be plain text
  }
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (!lines.length) return { columns: [], rowCount: 0, rows: [] as Record<string, string>[] };
  const columns = lines[0]!.split("\t");
  const rows = lines.slice(1, 1 + maxRows).map((line) => {
    const cells = line.split("\t");
    const row: Record<string, string> = {};
    columns.forEach((c, i) => { row[c] = cells[i] ?? ""; });
    return row;
  });
  return { columns, rowCount: lines.length - 1, rows };
}

export const getSalesReportTool = tool({
  name: "asc_get_sales_report",
  description:
    "Download a Sales and Trends report (gzipped TSV, parsed to rows). Common: reportType=SALES, reportSubType=SUMMARY, " +
    "frequency=DAILY, reportDate=YYYY-MM-DD. vendorNumber is your numeric vendor id (Payments and Financial Reports). " +
    "Returns parsed columns + the first `maxRows` rows + total rowCount.",
  inputSchema: z.object({
    vendorNumber: z.string().describe("Numeric vendor number from App Store Connect."),
    reportType: z.string().default("SALES").describe("SALES, SUBSCRIPTION, SUBSCRIPTION_EVENT, SUBSCRIBER, NEWSSTAND, …"),
    reportSubType: z.string().default("SUMMARY"),
    frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]).default("DAILY"),
    reportDate: z.string().optional().describe("YYYY-MM-DD (or YYYY-MM / YYYY depending on frequency)."),
    version: z.string().optional().describe("Report version, e.g. \"1_1\" — required for some report types."),
    maxRows: z.number().int().min(1).max(1000).default(100).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const query: Record<string, string> = {
      "filter[vendorNumber]": input.vendorNumber,
      "filter[reportType]": input.reportType,
      "filter[reportSubType]": input.reportSubType,
      "filter[frequency]": input.frequency,
    };
    if (input.reportDate) query["filter[reportDate]"] = input.reportDate;
    if (input.version) query["filter[version]"] = input.version;
    const buf = await client.getRaw("/v1/salesReports", query, { Accept: "application/a-gzip" });
    return { reportType: input.reportType, frequency: input.frequency, reportDate: input.reportDate, ...parseTsv(buf, input.maxRows ?? 100) };
  },
});

export const getFinanceReportTool = tool({
  name: "asc_get_finance_report",
  description:
    "Download a Finance report (gzipped TSV, parsed to rows). regionCode is the financial region (e.g. ZZ for the " +
    "consolidated report, US, EU, …); reportDate is the fiscal period YYYY-MM. Requires Finance/Admin access.",
  inputSchema: z.object({
    vendorNumber: z.string(),
    regionCode: z.string().describe("Financial region code, e.g. ZZ (all), US, EU, JP."),
    reportDate: z.string().describe("Fiscal period, YYYY-MM."),
    reportType: z.string().default("FINANCIAL").describe("FINANCIAL or FINANCE_DETAIL."),
    maxRows: z.number().int().min(1).max(1000).default(100).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const buf = await client.getRaw("/v1/financeReports", {
      "filter[vendorNumber]": input.vendorNumber,
      "filter[regionCode]": input.regionCode,
      "filter[reportDate]": input.reportDate,
      "filter[reportType]": input.reportType,
    }, { Accept: "application/a-gzip" });
    return { regionCode: input.regionCode, reportDate: input.reportDate, ...parseTsv(buf, input.maxRows ?? 100) };
  },
});

export const requestAnalyticsReportTool = tool({
  name: "asc_request_analytics_report",
  description:
    "Request an App Store analytics report set for an app (asynchronous). accessType ONE_TIME_SNAPSHOT for a point-in-time " +
    "pull, or ONGOING for recurring. Returns the request id — poll asc_list_analytics_reports for generated reports.",
  inputSchema: z.object({
    appId: z.string(),
    accessType: z.enum(["ONE_TIME_SNAPSHOT", "ONGOING"]).default("ONE_TIME_SNAPSHOT"),
  }).strict(),
  handler: async (input, { client }) => {
    const res = await client.post<{ data: { id: string; attributes?: Record<string, unknown> } }>("/v1/analyticsReportRequests", {
      data: {
        type: "analyticsReportRequests",
        attributes: { accessType: input.accessType },
        relationships: { app: { data: { type: "apps", id: input.appId } } },
      },
    });
    return { ok: true, requestId: res.data.id, note: "Reports generate asynchronously — poll asc_list_analytics_reports with this requestId.", ...res.data.attributes };
  },
});

export const listAnalyticsReportsTool = tool({
  name: "asc_list_analytics_reports",
  description: "List the analytics reports generated for a request (id, name, category). Each report has dated instances/segments with download URLs.",
  inputSchema: z.object({
    requestId: z.string(),
    limit: z.number().int().min(1).max(200).default(100).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const reports = await client.list(`/v1/analyticsReportRequests/${input.requestId}/reports`, {
      limit: input.limit ?? 100,
      "fields[analyticsReports]": "name,category",
    });
    return reports.map((r) => ({ id: r.id, ...r.attributes }));
  },
});
