import { z } from "zod";
import { tool } from "./registry.js";

/**
 * Users & Access — team members and pending invitations. Sensitive: requires an Admin (or Account
 * Holder) API key; lower roles get 403. Not validated against live Apple traffic; the role enum and
 * visible-apps relationship are inferred and marked [VERIFY].
 *
 * Common roles: ADMIN, FINANCE, SALES, MARKETING, APP_MANAGER, DEVELOPER, ACCESS_TO_REPORTS,
 * CUSTOMER_SUPPORT, CREATE_APPS. (Account Holder is assigned, not granted via the API.)
 */

export const listUsersTool = tool({
  name: "asc_list_users",
  description: "List team members (id, username, name, roles, allAppsVisible, provisioningAllowed). Requires an Admin key.",
  inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(100).optional() }).strict(),
  handler: async (input, { client }) => {
    const users = await client.list("/v1/users", {
      limit: input.limit ?? 100,
      "fields[users]": "username,firstName,lastName,roles,allAppsVisible,provisioningAllowed",
    });
    return users.map((u) => ({ id: u.id, ...u.attributes }));
  },
});

export const getUserTool = tool({
  name: "asc_get_user",
  description: "Get a single team member with their visible apps sideloaded.",
  inputSchema: z.object({ userId: z.string() }).strict(),
  handler: async (input, { client }) => {
    return await client.get(`/v1/users/${input.userId}`, {
      query: { include: "visibleApps", "fields[users]": "username,firstName,lastName,roles,allAppsVisible,provisioningAllowed" },
    });
  },
});

export const updateUserTool = tool({
  name: "asc_update_user",
  description:
    "Update a team member's roles and/or app visibility. Pass allAppsVisible=false with visibleAppIds to scope them " +
    "to specific apps. Only the fields you pass change.",
  inputSchema: z.object({
    userId: z.string(),
    roles: z.array(z.string()).optional().describe("Full set of roles to assign (replaces existing)."),
    allAppsVisible: z.boolean().optional(),
    provisioningAllowed: z.boolean().optional(),
    visibleAppIds: z.array(z.string()).optional().describe("App ids the user can see (use with allAppsVisible=false)."),
  }).strict(),
  handler: async (input, { client }) => {
    const attributes: Record<string, unknown> = {};
    for (const k of ["roles", "allAppsVisible", "provisioningAllowed"] as const) {
      if (input[k] !== undefined) attributes[k] = input[k];
    }
    const data: Record<string, unknown> = { type: "users", id: input.userId, attributes };
    if (input.visibleAppIds) {
      data.relationships = { visibleApps: { data: input.visibleAppIds.map((id) => ({ type: "apps", id })) } };
    }
    return await client.patch(`/v1/users/${input.userId}`, { data });
  },
});

export const listUserInvitationsTool = tool({
  name: "asc_list_user_invitations",
  description: "List pending team invitations (email, name, roles).",
  inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(100).optional() }).strict(),
  handler: async (input, { client }) => {
    const invites = await client.list("/v1/userInvitations", {
      limit: input.limit ?? 100,
      "fields[userInvitations]": "email,firstName,lastName,roles,allAppsVisible,expirationDate",
    });
    return invites.map((i) => ({ id: i.id, ...i.attributes }));
  },
});

export const inviteUserTool = tool({
  name: "asc_invite_user",
  description:
    "Invite a new team member by email with a set of roles. Pass allAppsVisible=false with visibleAppIds to scope " +
    "them to specific apps. Requires an Admin key.",
  inputSchema: z.object({
    email: z.string().email(),
    firstName: z.string(),
    lastName: z.string(),
    roles: z.array(z.string()).min(1),
    allAppsVisible: z.boolean().default(true),
    provisioningAllowed: z.boolean().optional(),
    visibleAppIds: z.array(z.string()).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const attributes: Record<string, unknown> = {
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      roles: input.roles,
      allAppsVisible: input.allAppsVisible,
    };
    if (input.provisioningAllowed !== undefined) attributes.provisioningAllowed = input.provisioningAllowed;
    const data: Record<string, unknown> = { type: "userInvitations", attributes };
    if (input.visibleAppIds) {
      data.relationships = { visibleApps: { data: input.visibleAppIds.map((id) => ({ type: "apps", id })) } };
    }
    const res = await client.post<{ data: { id: string; attributes?: Record<string, unknown> } }>("/v1/userInvitations", { data });
    return { ok: true, invitationId: res.data.id, ...res.data.attributes };
  },
});

export const cancelUserInvitationTool = tool({
  name: "asc_cancel_user_invitation",
  description: "Cancel a pending team invitation by id.",
  inputSchema: z.object({ invitationId: z.string() }).strict(),
  handler: async (input, { client }) => {
    await client.delete(`/v1/userInvitations/${input.invitationId}`);
    return { ok: true, invitationId: input.invitationId };
  },
});
