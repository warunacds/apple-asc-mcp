import { z } from "zod";
import { tool } from "./registry.js";

/**
 * Xcode Cloud (CI/CD): products, workflows, and build runs. Not validated against live Apple traffic;
 * relationship/attribute shapes inferred and marked [VERIFY].
 */

export const listCiProductsTool = tool({
  name: "asc_list_ci_products",
  description: "List Xcode Cloud products (one per app/framework set up for CI). Returns id, name, productType, createdDate.",
  inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(100).optional() }).strict(),
  handler: async (input, { client }) => {
    const products = await client.list("/v1/ciProducts", {
      limit: input.limit ?? 100,
      "fields[ciProducts]": "name,productType,createdDate",
    });
    return products.map((p) => ({ id: p.id, ...p.attributes }));
  },
});

export const listCiWorkflowsTool = tool({
  name: "asc_list_ci_workflows",
  description: "List the Xcode Cloud workflows for a CI product (id, name, description, isEnabled).",
  inputSchema: z.object({
    ciProductId: z.string(),
    limit: z.number().int().min(1).max(200).default(100).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const workflows = await client.list(`/v1/ciProducts/${input.ciProductId}/workflows`, {
      limit: input.limit ?? 100,
      "fields[ciWorkflows]": "name,description,isEnabled,lastModifiedDate",
    });
    return workflows.map((w) => ({ id: w.id, ...w.attributes }));
  },
});

export const getCiWorkflowTool = tool({
  name: "asc_get_ci_workflow",
  description: "Get a single Xcode Cloud workflow with its repository and product sideloaded.",
  inputSchema: z.object({ workflowId: z.string() }).strict(),
  handler: async (input, { client }) => {
    return await client.get(`/v1/ciWorkflows/${input.workflowId}`, {
      query: { include: "repository,product", "fields[ciWorkflows]": "name,description,isEnabled,lastModifiedDate" },
    });
  },
});

export const startCiBuildTool = tool({
  name: "asc_start_ci_build",
  description:
    "Start an Xcode Cloud build run for a workflow. Optionally target a specific git reference (branch/tag) via " +
    "sourceBranchOrTagId (a scmGitReference id from the workflow's repository).",
  inputSchema: z.object({
    workflowId: z.string(),
    sourceBranchOrTagId: z.string().optional().describe("scmGitReference id to build; omit to use the workflow default."),
  }).strict(),
  handler: async (input, { client }) => {
    const relationships: Record<string, unknown> = {
      workflow: { data: { type: "ciWorkflows", id: input.workflowId } },
    };
    // [VERIFY] the git-reference relationship name on ciBuildRuns.
    if (input.sourceBranchOrTagId) {
      relationships.sourceBranchOrTag = { data: { type: "scmGitReferences", id: input.sourceBranchOrTagId } };
    }
    const res = await client.post<{ data: { id: string; attributes?: Record<string, unknown> } }>("/v1/ciBuildRuns", {
      data: { type: "ciBuildRuns", relationships },
    });
    return { ok: true, buildRunId: res.data.id, ...res.data.attributes };
  },
});

export const listCiBuildRunsTool = tool({
  name: "asc_list_ci_build_runs",
  description: "List recent build runs for an Xcode Cloud workflow (number, executionProgress, completionStatus, dates).",
  inputSchema: z.object({
    workflowId: z.string(),
    limit: z.number().int().min(1).max(200).default(50).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const runs = await client.list(`/v1/ciWorkflows/${input.workflowId}/buildRuns`, {
      limit: input.limit ?? 50,
      sort: "-number",
      "fields[ciBuildRuns]": "number,executionProgress,completionStatus,startedDate,finishedDate,isPullRequestBuild",
    });
    return runs.map((r) => ({ id: r.id, ...r.attributes }));
  },
});

export const getCiBuildRunTool = tool({
  name: "asc_get_ci_build_run",
  description: "Get a single Xcode Cloud build run (status/progress) with its build actions sideloaded.",
  inputSchema: z.object({ buildRunId: z.string() }).strict(),
  handler: async (input, { client }) => {
    return await client.get(`/v1/ciBuildRuns/${input.buildRunId}`, {
      query: { include: "actions", "fields[ciBuildRuns]": "number,executionProgress,completionStatus,startedDate,finishedDate" },
    });
  },
});
