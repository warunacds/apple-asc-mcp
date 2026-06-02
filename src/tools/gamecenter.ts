import { z } from "zod";
import { tool } from "./registry.js";

/**
 * Game Center: per-app detail, achievements, and leaderboards (with per-locale text). Scoped to the
 * core create/list operations; groups, leaderboard sets, images, and challenges are out of scope for
 * now. Create shapes cross-checked against the OpenAPI spec (round-4 audit): achievements require
 * showBeforeEarned + repeatable; leaderboards use scoreSortType (ASC/DESC), not a sortAscending boolean.
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
    "showBeforeEarned controls whether players see it before unlocking; repeatable lets it be earned more than once. " +
    "Add per-locale text with asc_set_achievement_localization.",
  inputSchema: z.object({
    gameCenterDetailId: z.string(),
    referenceName: z.string(),
    vendorIdentifier: z.string(),
    points: z.number().int().min(0).max(100),
    showBeforeEarned: z.boolean().default(true).describe("Whether the achievement is visible to players before it's earned."),
    repeatable: z.boolean().default(false).describe("Whether the achievement can be earned more than once."),
  }).strict(),
  handler: async (input, { client }) => {
    const attributes = {
      referenceName: input.referenceName,
      vendorIdentifier: input.vendorIdentifier,
      points: input.points,
      showBeforeEarned: input.showBeforeEarned,
      repeatable: input.repeatable,
    };
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
  description: "List Game Center leaderboards under a gameCenterDetail (referenceName, vendorIdentifier, submissionType, scoreSortType).",
  inputSchema: z.object({
    gameCenterDetailId: z.string(),
    limit: z.number().int().min(1).max(200).default(100).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const items = await client.list(`/v1/gameCenterDetails/${input.gameCenterDetailId}/gameCenterLeaderboards`, {
      limit: input.limit ?? 100,
      "fields[gameCenterLeaderboards]": "referenceName,vendorIdentifier,submissionType,scoreSortType,defaultFormatter,archived",
    });
    return items.map((l) => ({ id: l.id, ...l.attributes }));
  },
});

export const createLeaderboardTool = tool({
  name: "asc_create_leaderboard",
  description:
    "Create a Game Center leaderboard. submissionType BEST_SCORE or MOST_RECENT_SCORE; scoreSortType DESC for " +
    "higher-is-better (default) or ASC for lower-is-better. defaultFormatter controls score display (e.g. INTEGER, " +
    "ELAPSED_TIME_SECOND, MONEY_DOLLAR). Add per-locale names with asc_set_leaderboard_localization.",
  inputSchema: z.object({
    gameCenterDetailId: z.string(),
    referenceName: z.string(),
    vendorIdentifier: z.string(),
    submissionType: z.enum(["BEST_SCORE", "MOST_RECENT_SCORE"]).default("BEST_SCORE"),
    scoreSortType: z.enum(["ASC", "DESC"]).default("DESC").describe("DESC = higher score ranks first; ASC = lower score ranks first."),
    defaultFormatter: z.enum([
      "INTEGER", "DECIMAL_POINT_1_PLACE", "DECIMAL_POINT_2_PLACE", "DECIMAL_POINT_3_PLACE",
      "ELAPSED_TIME_CENTISECOND", "ELAPSED_TIME_MINUTE", "ELAPSED_TIME_SECOND",
      "MONEY_POUND_DECIMAL", "MONEY_POUND", "MONEY_DOLLAR_DECIMAL", "MONEY_DOLLAR",
      "MONEY_EURO_DECIMAL", "MONEY_EURO", "MONEY_FRANC_DECIMAL", "MONEY_FRANC",
      "MONEY_KRONER_DECIMAL", "MONEY_KRONER", "MONEY_YEN",
    ]).default("INTEGER").describe("How the score is displayed."),
  }).strict(),
  handler: async (input, { client }) => {
    const res = await client.post<{ data: { id: string; attributes?: Record<string, unknown> } }>("/v1/gameCenterLeaderboards", {
      data: {
        type: "gameCenterLeaderboards",
        attributes: {
          referenceName: input.referenceName,
          vendorIdentifier: input.vendorIdentifier,
          submissionType: input.submissionType,
          scoreSortType: input.scoreSortType,
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
