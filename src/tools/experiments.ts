import { z } from "zod";
import { tool } from "./registry.js";

/**
 * Product Page Optimization — A/B experiments (appStoreVersionExperiments v2). Run up to 3 treatments
 * against the baseline product page, splitting a chosen percentage of traffic, to test alternate
 * screenshots, previews, and app icons.
 *
 * Lifecycle: create the experiment (app-level, name + platform + trafficProportion) → add treatments
 * (each can carry an alternate app icon) → add a per-locale treatment localization → attach that
 * treatment's screenshots/previews via the screenshot/preview set tools (pass
 * experimentTreatmentLocalizationId) → asc_update_experiment with started=true to launch.
 *
 * Shapes confirmed against the App Store Connect OpenAPI spec. v2 is the current app-level model.
 */

const PLATFORMS = ["IOS", "MAC_OS", "TV_OS", "VISION_OS"] as const;

export const listExperimentsTool = tool({
  name: "asc_list_experiments",
  description: "List an app's Product Page Optimization experiments (id, name, state, trafficProportion, start/end dates).",
  inputSchema: z.object({ appId: z.string() }).strict(),
  handler: async (input, { client }) => {
    const experiments = await client.list(`/v1/apps/${input.appId}/appStoreVersionExperimentsV2`, {
      limit: 200,
      "fields[appStoreVersionExperiments]": "name,state,trafficProportion,startDate,endDate,reviewRequired",
    });
    return experiments.map((e) => ({ id: e.id, ...e.attributes }));
  },
});

export const createExperimentTool = tool({
  name: "asc_create_experiment",
  description:
    "Create a Product Page Optimization experiment. trafficProportion is the percent of eligible traffic (1–100) split " +
    "across the treatments. After creating, add treatments with asc_create_experiment_treatment, then launch with " +
    "asc_update_experiment (started=true).",
  inputSchema: z.object({
    appId: z.string(),
    name: z.string().describe("Experiment name (internal)."),
    platform: z.enum(PLATFORMS).default("IOS"),
    trafficProportion: z.number().int().min(1).max(100).describe("Percent of eligible traffic in the experiment (1–100)."),
  }).strict(),
  handler: async (input, { client }) => {
    const res = await client.post<{ data: { id: string; attributes?: Record<string, unknown> } }>("/v2/appStoreVersionExperiments", {
      data: {
        type: "appStoreVersionExperiments",
        attributes: { name: input.name, platform: input.platform, trafficProportion: input.trafficProportion },
        relationships: { app: { data: { type: "apps", id: input.appId } } },
      },
    });
    return { ok: true, experimentId: res.data.id, ...res.data.attributes };
  },
});

export const getExperimentTool = tool({
  name: "asc_get_experiment",
  description: "Read an experiment with its treatments (state, trafficProportion, start/end dates, treatment ids + names).",
  inputSchema: z.object({ experimentId: z.string() }).strict(),
  handler: async (input, { client }) => {
    const id = input.experimentId;
    const exp = await client.getOne<Record<string, unknown>>(`/v2/appStoreVersionExperiments/${id}`, {
      "fields[appStoreVersionExperiments]": "name,state,trafficProportion,startDate,endDate,reviewRequired",
    });
    const treatments = await client
      .list<{ name?: string; appIconName?: string }>(`/v2/appStoreVersionExperiments/${id}/appStoreVersionExperimentTreatments`, {
        limit: 50,
        "fields[appStoreVersionExperimentTreatments]": "name,appIconName,promotedDate",
      })
      .then((ts) => ts.map((t) => ({ id: t.id, ...t.attributes })))
      .catch(() => []);
    return { id, ...exp.attributes, treatments };
  },
});

export const updateExperimentTool = tool({
  name: "asc_update_experiment",
  description:
    "Update an experiment. Pass started=true to launch it (or false to stop), or change name / trafficProportion. " +
    "Only the fields you pass change. Launching requires each treatment to have its localizations + visuals set.",
  inputSchema: z.object({
    experimentId: z.string(),
    name: z.string().optional(),
    trafficProportion: z.number().int().min(1).max(100).optional(),
    started: z.boolean().optional().describe("true launches the experiment; false stops it."),
  }).strict(),
  handler: async (input, { client }) => {
    const attributes: Record<string, unknown> = {};
    for (const k of ["name", "trafficProportion", "started"] as const) {
      if (input[k] !== undefined) attributes[k] = input[k];
    }
    if (Object.keys(attributes).length === 0) throw new Error("Pass at least one field to update (name, trafficProportion, or started).");
    const res = await client.patch<{ data: { id: string; attributes?: Record<string, unknown> } }>(`/v2/appStoreVersionExperiments/${input.experimentId}`, {
      data: { type: "appStoreVersionExperiments", id: input.experimentId, attributes },
    });
    return { ok: true, experimentId: input.experimentId, ...res.data.attributes };
  },
});

export const createExperimentTreatmentTool = tool({
  name: "asc_create_experiment_treatment",
  description:
    "Add a treatment (a variant) to an experiment. name is internal; appIconName optionally points the treatment at an " +
    "alternate app icon. Then add a localization with asc_set_experiment_treatment_localization and attach its visuals " +
    "via the screenshot/preview set tools (experimentTreatmentLocalizationId).",
  inputSchema: z.object({
    experimentId: z.string(),
    name: z.string().describe("Treatment name (internal)."),
    appIconName: z.string().optional().describe("Name of an alternate app icon to use for this treatment."),
  }).strict(),
  handler: async (input, { client }) => {
    const attributes: Record<string, unknown> = { name: input.name };
    if (input.appIconName !== undefined) attributes.appIconName = input.appIconName;
    const res = await client.post<{ data: { id: string; attributes?: Record<string, unknown> } }>("/v1/appStoreVersionExperimentTreatments", {
      data: {
        type: "appStoreVersionExperimentTreatments",
        attributes,
        // v2 experiments reference the treatment's parent as appStoreVersionExperimentV2.
        relationships: { appStoreVersionExperimentV2: { data: { type: "appStoreVersionExperiments", id: input.experimentId } } },
      },
    });
    return { ok: true, treatmentId: res.data.id, ...res.data.attributes };
  },
});

export const setExperimentTreatmentLocalizationTool = tool({
  name: "asc_set_experiment_treatment_localization",
  description:
    "Get (or create) the treatment localization for a locale. Returns its id — pass that as " +
    "experimentTreatmentLocalizationId to asc_find_or_create_screenshot_set / asc_find_or_create_preview_set to set the " +
    "treatment's screenshots/previews. (A treatment localization carries only the locale; the variant is its visuals + icon.)",
  inputSchema: z.object({
    treatmentId: z.string(),
    locale: z.string().describe("e.g. en-US, ja, de-DE."),
  }).strict(),
  handler: async (input, { client }) => {
    const existing = await client.list<{ locale?: string }>(
      `/v1/appStoreVersionExperimentTreatments/${input.treatmentId}/appStoreVersionExperimentTreatmentLocalizations`,
      { limit: 200, "fields[appStoreVersionExperimentTreatmentLocalizations]": "locale" },
    );
    const match = existing.find((l) => l.attributes?.locale === input.locale);
    if (match) return { id: match.id, locale: input.locale, action: "found" };
    const res = await client.post<{ data: { id: string } }>("/v1/appStoreVersionExperimentTreatmentLocalizations", {
      data: {
        type: "appStoreVersionExperimentTreatmentLocalizations",
        attributes: { locale: input.locale },
        relationships: { appStoreVersionExperimentTreatment: { data: { type: "appStoreVersionExperimentTreatments", id: input.treatmentId } } },
      },
    });
    return { id: res.data.id, locale: input.locale, action: "created" };
  },
});

export const deleteExperimentTreatmentTool = tool({
  name: "asc_delete_experiment_treatment",
  description: "Delete a treatment by id (DELETE /v1/appStoreVersionExperimentTreatments/{id}).",
  inputSchema: z.object({ treatmentId: z.string() }).strict(),
  handler: async (input, { client }) => {
    await client.delete(`/v1/appStoreVersionExperimentTreatments/${input.treatmentId}`);
    return { ok: true, deleted: input.treatmentId };
  },
});

export const deleteExperimentTool = tool({
  name: "asc_delete_experiment",
  description: "Delete an experiment by id (DELETE /v2/appStoreVersionExperiments/{id}). Find ids via asc_list_experiments.",
  inputSchema: z.object({ experimentId: z.string() }).strict(),
  handler: async (input, { client }) => {
    await client.delete(`/v2/appStoreVersionExperiments/${input.experimentId}`);
    return { ok: true, deleted: input.experimentId };
  },
});
