import { z } from "zod";
import { tool } from "./registry.js";

/**
 * Custom Product Pages (appCustomProductPages): alternate versions of the product page — own promo text,
 * screenshots, and previews — each reachable by its own URL for use in marketing campaigns.
 *
 * A page owns versions (appCustomProductPageVersions); you edit the draft (PREPARE_FOR_SUBMISSION) version.
 * Each version has per-locale appCustomProductPageLocalizations, and screenshots/previews attach to those
 * via the shared screenshot/preview set tools (pass customProductPageLocalizationId). Submit a finished
 * version via asc_submit_for_review with {type:"appCustomProductPageVersion", id}.
 *
 * Shapes confirmed against the App Store Connect OpenAPI spec.
 */

/** Resolve the editable (PREPARE_FOR_SUBMISSION) version of a page, creating one if none exists. */
async function resolveDraftVersion(client: import("../client.js").AscClient, pageId: string): Promise<string> {
  const versions = await client.list<{ state?: string }>(`/v1/appCustomProductPages/${pageId}/appCustomProductPageVersions`, {
    limit: 50,
    "fields[appCustomProductPageVersions]": "state,version",
  });
  const editable = versions.find((v) => v.attributes?.state === "PREPARE_FOR_SUBMISSION") ?? versions[0];
  if (editable) return editable.id;
  const created = await client.post<{ data: { id: string } }>("/v1/appCustomProductPageVersions", {
    data: { type: "appCustomProductPageVersions", relationships: { appCustomProductPage: { data: { type: "appCustomProductPages", id: pageId } } } },
  });
  return created.data.id;
}

export const listCustomProductPagesTool = tool({
  name: "asc_list_custom_product_pages",
  description: "List an app's Custom Product Pages (id, name, the shareable url, and whether it's visible/live).",
  inputSchema: z.object({ appId: z.string() }).strict(),
  handler: async (input, { client }) => {
    const pages = await client.list(`/v1/apps/${input.appId}/appCustomProductPages`, {
      limit: 200,
      "fields[appCustomProductPages]": "name,url,visible",
    });
    return pages.map((p) => ({ id: p.id, ...p.attributes }));
  },
});

export const createCustomProductPageTool = tool({
  name: "asc_create_custom_product_page",
  description:
    "Create a Custom Product Page. name is the internal reference. Returns the page id plus its draft versionId — " +
    "use that versionId with asc_set_custom_product_page_localization, then attach screenshots/previews via " +
    "asc_find_or_create_screenshot_set / asc_find_or_create_preview_set (pass customProductPageLocalizationId).",
  inputSchema: z.object({
    appId: z.string(),
    name: z.string().describe("Internal reference name for the page."),
  }).strict(),
  handler: async (input, { client }) => {
    const res = await client.post<{ data: { id: string; attributes?: Record<string, unknown> } }>("/v1/appCustomProductPages", {
      data: { type: "appCustomProductPages", attributes: { name: input.name }, relationships: { app: { data: { type: "apps", id: input.appId } } } },
    });
    const pageId = res.data.id;
    const versionId = await resolveDraftVersion(client, pageId);
    return { ok: true, customProductPageId: pageId, versionId, ...res.data.attributes };
  },
});

export const getCustomProductPageTool = tool({
  name: "asc_get_custom_product_page",
  description:
    "Read a Custom Product Page: its shareable url + visibility, its draft version id, and that version's " +
    "localizations. Use the version id to add localizations and the localization ids to attach screenshots.",
  inputSchema: z.object({ customProductPageId: z.string() }).strict(),
  handler: async (input, { client }) => {
    const id = input.customProductPageId;
    const page = await client.getOne<{ name?: string; url?: string; visible?: boolean }>(`/v1/appCustomProductPages/${id}`, {
      "fields[appCustomProductPages]": "name,url,visible",
    });
    const versions = await client
      .list<{ state?: string; version?: string }>(`/v1/appCustomProductPages/${id}/appCustomProductPageVersions`, {
        limit: 50,
        "fields[appCustomProductPageVersions]": "state,version",
      })
      .then((vs) => vs.map((v) => ({ id: v.id, ...v.attributes })))
      .catch(() => []);
    const draft = versions.find((v) => v.state === "PREPARE_FOR_SUBMISSION") ?? versions[0];
    const localizations = draft
      ? await client
          .list<{ locale?: string; promotionalText?: string }>(`/v1/appCustomProductPageVersions/${draft.id}/appCustomProductPageLocalizations`, {
            limit: 200,
            "fields[appCustomProductPageLocalizations]": "locale,promotionalText",
          })
          .then((ls) => ls.map((l) => ({ id: l.id, ...l.attributes })))
          .catch(() => [])
      : [];
    return { id, ...page.attributes, draftVersionId: draft?.id, versions, localizations };
  },
});

export const setCustomProductPageLocalizationTool = tool({
  name: "asc_set_custom_product_page_localization",
  description:
    "Upsert a Custom Product Page localization on a version: locale + promotionalText. Creates it if missing, otherwise " +
    "PATCHes it. Get the versionId from asc_create_custom_product_page / asc_get_custom_product_page; the returned " +
    "localization id is what you pass as customProductPageLocalizationId to the screenshot/preview set tools.",
  inputSchema: z.object({
    versionId: z.string().describe("appCustomProductPageVersion id (the draft version)."),
    locale: z.string().describe("e.g. en-US, ja, de-DE."),
    promotionalText: z.string().optional().describe("Promotional text shown on this variant page."),
  }).strict(),
  handler: async (input, { client }) => {
    const existing = await client.list<{ locale?: string }>(
      `/v1/appCustomProductPageVersions/${input.versionId}/appCustomProductPageLocalizations`,
      { limit: 200, "fields[appCustomProductPageLocalizations]": "locale" },
    );
    const match = existing.find((l) => l.attributes?.locale === input.locale);
    const attributes: Record<string, unknown> = {};
    if (input.promotionalText !== undefined) attributes.promotionalText = input.promotionalText;
    if (match) {
      const res = await client.patch<{ data: { id: string; attributes?: Record<string, unknown> } }>(
        `/v1/appCustomProductPageLocalizations/${match.id}`,
        { data: { type: "appCustomProductPageLocalizations", id: match.id, attributes } },
      );
      return { id: match.id, action: "updated", ...res.data.attributes };
    }
    const res = await client.post<{ data: { id: string; attributes?: Record<string, unknown> } }>("/v1/appCustomProductPageLocalizations", {
      data: {
        type: "appCustomProductPageLocalizations",
        attributes: { locale: input.locale, ...attributes },
        relationships: { appCustomProductPageVersion: { data: { type: "appCustomProductPageVersions", id: input.versionId } } },
      },
    });
    return { id: res.data.id, action: "created", ...res.data.attributes };
  },
});

export const deleteCustomProductPageTool = tool({
  name: "asc_delete_custom_product_page",
  description: "Delete a Custom Product Page by id (DELETE /v1/appCustomProductPages/{id}). Find ids via asc_list_custom_product_pages.",
  inputSchema: z.object({ customProductPageId: z.string() }).strict(),
  handler: async (input, { client }) => {
    await client.delete(`/v1/appCustomProductPages/${input.customProductPageId}`);
    return { ok: true, deleted: input.customProductPageId };
  },
});
