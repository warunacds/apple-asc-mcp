import { z } from "zod";
import { tool } from "./registry.js";

/**
 * Game Center: per-app detail, achievements, and leaderboards (with per-locale text). Scoped to the
 * core create/list operations; groups, leaderboard sets, images, and challenges are out of scope for
 * now. Not validated against live Apple traffic; shapes inferred and marked [VERIFY].
 */

export const getGameCenterDetailTool = tool({
  name: "asc_get_game_center_detail",
  description: "Get the Game Center detail for an app. The id anchors achievements and leaderboards.",
  inputSchema: z.object({ appId: z.string() }).strict(),
  handler: async (input, { client }) => {
    // No fields filter — `challengeEnabled` is not a valid field on gameCenterDetails (confirmed live).
    return await client.get(`/v1/apps/${input.appId}/gameCenterDetail`).catch(() => ({ data: null }));
  },
});

export const listAchievementsTool = tool({
  name: "asc_list_achievements",
  description: "List Game Center achievements under a gameCenterDetail (referenceName, vendorIdentifier, points, archived).",
  inputSchema: z.object({
    gameCenterDetailId: z.string(),
    limit: z.number().int().min(1).max(200).default(100).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const items = await client.list(`/v1/gameCenterDetails/${input.gameCenterDetailId}/gameCenterAchievements`, {
      limit: input.limit ?? 100,
      "fields[gameCenterAchievements]": "referenceName,vendorIdentifier,points,showBeforeEarned,repeatable,archived",
    });
    return items.map((a) => ({ id: a.id, ...a.attributes }));
  },
});

export const createAchievementTool = tool({
  name: "asc_create_achievement",
  description:
    "Create a Game Center achievement. vendorIdentifier is your developer-defined id; points 0–100 (≤1000 total per app). " +
    "Add per-locale text with asc_set_achievement_localization.",
  inputSchema: z.object({
    gameCenterDetailId: z.string(),
    referenceName: z.string(),
    vendorIdentifier: z.string(),
    points: z.number().int().min(0).max(100),
    showBeforeEarned: z.boolean().optional(),
    repeatable: z.boolean().optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const attributes: Record<string, unknown> = {
      referenceName: input.referenceName,
      vendorIdentifier: input.vendorIdentifier,
      points: input.points,
    };
    if (input.showBeforeEarned !== undefined) attributes.showBeforeEarned = input.showBeforeEarned;
    if (input.repeatable !== undefined) attributes.repeatable = input.repeatable;
    const res = await client.post<{ data: { id: string; attributes?: Record<string, unknown> } }>("/v1/gameCenterAchievements", {
      data: { type: "gameCenterAchievements", attributes, relationships: { gameCenterDetail: { data: { type: "gameCenterDetails", id: input.gameCenterDetailId } } } },
    });
    return { ok: true, achievementId: res.data.id, ...res.data.attributes };
  },
});

export const setAchievementLocalizationTool = tool({
  name: "asc_set_achievement_localization",
  description: "Add a per-locale name + before/after-earned descriptions to a Game Center achievement.",
  inputSchema: z.object({
    achievementId: z.string(),
    locale: z.string(),
    name: z.string(),
    beforeEarnedDescription: z.string(),
    afterEarnedDescription: z.string(),
  }).strict(),
  handler: async (input, { client }) => {
    const res = await client.post<{ data: { id: string } }>("/v1/gameCenterAchievementLocalizations", {
      data: {
        type: "gameCenterAchievementLocalizations",
        attributes: { locale: input.locale, name: input.name, beforeEarnedDescription: input.beforeEarnedDescription, afterEarnedDescription: input.afterEarnedDescription },
        relationships: { gameCenterAchievement: { data: { type: "gameCenterAchievements", id: input.achievementId } } },
      },
    });
    return { ok: true, localizationId: res.data.id, locale: input.locale };
  },
});

export const listLeaderboardsTool = tool({
  name: "asc_list_leaderboards",
  description: "List Game Center leaderboards under a gameCenterDetail (referenceName, vendorIdentifier, submissionType, sortAscending).",
  inputSchema: z.object({
    gameCenterDetailId: z.string(),
    limit: z.number().int().min(1).max(200).default(100).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const items = await client.list(`/v1/gameCenterDetails/${input.gameCenterDetailId}/gameCenterLeaderboards`, {
      limit: input.limit ?? 100,
      "fields[gameCenterLeaderboards]": "referenceName,vendorIdentifier,submissionType,sortAscending,defaultFormatter,archived",
    });
    return items.map((l) => ({ id: l.id, ...l.attributes }));
  },
});

export const createLeaderboardTool = tool({
  name: "asc_create_leaderboard",
  description:
    "Create a Game Center leaderboard. submissionType BEST_SCORE or MOST_RECENT_SCORE; sortAscending=true for " +
    "lower-is-better. defaultFormatter controls score display (e.g. INTEGER, ELAPSED_TIME_MILLISECOND). Add per-locale " +
    "names with asc_set_leaderboard_localization.",
  inputSchema: z.object({
    gameCenterDetailId: z.string(),
    referenceName: z.string(),
    vendorIdentifier: z.string(),
    submissionType: z.enum(["BEST_SCORE", "MOST_RECENT_SCORE"]).default("BEST_SCORE"),
    sortAscending: z.boolean().default(false),
    defaultFormatter: z.string().default("INTEGER").describe("Score formatter, e.g. INTEGER, DECIMAL_POINT_*, ELAPSED_TIME_*."),
  }).strict(),
  handler: async (input, { client }) => {
    const res = await client.post<{ data: { id: string; attributes?: Record<string, unknown> } }>("/v1/gameCenterLeaderboards", {
      data: {
        type: "gameCenterLeaderboards",
        attributes: {
          referenceName: input.referenceName,
          vendorIdentifier: input.vendorIdentifier,
          submissionType: input.submissionType,
          sortAscending: input.sortAscending,
          defaultFormatter: input.defaultFormatter,
        },
        relationships: { gameCenterDetail: { data: { type: "gameCenterDetails", id: input.gameCenterDetailId } } },
      },
    });
    return { ok: true, leaderboardId: res.data.id, ...res.data.attributes };
  },
});

export const setLeaderboardLocalizationTool = tool({
  name: "asc_set_leaderboard_localization",
  description: "Add a per-locale name to a Game Center leaderboard.",
  inputSchema: z.object({
    leaderboardId: z.string(),
    locale: z.string(),
    name: z.string(),
  }).strict(),
  handler: async (input, { client }) => {
    const res = await client.post<{ data: { id: string } }>("/v1/gameCenterLeaderboardLocalizations", {
      data: {
        type: "gameCenterLeaderboardLocalizations",
        attributes: { locale: input.locale, name: input.name },
        relationships: { gameCenterLeaderboard: { data: { type: "gameCenterLeaderboards", id: input.leaderboardId } } },
      },
    });
    return { ok: true, localizationId: res.data.id, locale: input.locale };
  },
});
