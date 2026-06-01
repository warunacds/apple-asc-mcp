import { z } from "zod";
import { tool } from "./registry.js";

/**
 * Provisioning / code signing: bundle IDs, capabilities, certificates, devices, and profiles. These
 * live on the same auth/client as the rest of the API (research §14) and enable zero-to-one app setup
 * and signing automation.
 *
 * Enum spellings (CapabilityType / CertificateType / ProfileType) drift over time, so those inputs are
 * accepted as free strings with the common values documented — rather than a strict enum that would
 * reject newer values. Not validated against live Apple traffic; marked [VERIFY].
 */

const BUNDLE_ID_PLATFORM = ["IOS", "MAC_OS", "UNIVERSAL"] as const;

// ── Bundle IDs ───────────────────────────────────────────────────────────────

export const listBundleIdsTool = tool({
  name: "asc_list_bundle_ids",
  description: "List registered bundle IDs (id, name, identifier, platform, seedId). Filter by identifier or platform.",
  inputSchema: z.object({
    identifier: z.string().optional().describe("Filter by reverse-DNS identifier, e.g. com.example.app."),
    platform: z.enum(BUNDLE_ID_PLATFORM).optional(),
    limit: z.number().int().min(1).max(200).default(100).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const q: Record<string, string | number | undefined> = {
      limit: input.limit ?? 100,
      "fields[bundleIds]": "name,identifier,platform,seedId",
    };
    if (input.identifier) q["filter[identifier]"] = input.identifier;
    if (input.platform) q["filter[platform]"] = input.platform;
    const ids = await client.list("/v1/bundleIds", q);
    return ids.map((b) => ({ id: b.id, ...b.attributes }));
  },
});

export const createBundleIdTool = tool({
  name: "asc_create_bundle_id",
  description:
    "Register a new bundle ID. platform uses the BundleIdPlatform enum (IOS / MAC_OS / UNIVERSAL — tvOS/visionOS live " +
    "under IOS or UNIVERSAL). The returned id is the resource id (not the reverse-DNS string).",
  inputSchema: z.object({
    name: z.string().describe("Display name in the developer portal."),
    identifier: z.string().describe("Reverse-DNS identifier, e.g. com.example.app."),
    platform: z.enum(BUNDLE_ID_PLATFORM).default("UNIVERSAL"),
    seedId: z.string().optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const attributes: Record<string, unknown> = { name: input.name, identifier: input.identifier, platform: input.platform };
    if (input.seedId) attributes.seedId = input.seedId;
    const res = await client.post<{ data: { id: string; attributes?: Record<string, unknown> } }>("/v1/bundleIds", {
      data: { type: "bundleIds", attributes },
    });
    return { ok: true, bundleIdResourceId: res.data.id, ...res.data.attributes };
  },
});

export const deleteBundleIdTool = tool({
  name: "asc_delete_bundle_id",
  description: "Delete a bundle ID by its resource id (from asc_list_bundle_ids).",
  inputSchema: z.object({ bundleIdResourceId: z.string() }).strict(),
  handler: async (input, { client }) => {
    await client.delete(`/v1/bundleIds/${input.bundleIdResourceId}`);
    return { ok: true, bundleIdResourceId: input.bundleIdResourceId };
  },
});

// ── Capabilities ─────────────────────────────────────────────────────────────

export const enableBundleCapabilityTool = tool({
  name: "asc_enable_bundle_capability",
  description:
    "Enable a capability on a bundle ID. capabilityType examples: ICLOUD, IN_APP_PURCHASE, PUSH_NOTIFICATIONS, " +
    "GAME_CENTER, ASSOCIATED_DOMAINS, HEALTHKIT, HOMEKIT, APPLE_PAY, SIRIKIT, APP_GROUPS, NETWORK_EXTENSIONS. " +
    "Some capabilities take a settings array.",
  inputSchema: z.object({
    bundleIdResourceId: z.string(),
    capabilityType: z.string().describe("CapabilityType enum value (see examples in the description)."),
    settings: z.array(z.unknown()).optional().describe("Optional capability settings array (capability-specific)."),
  }).strict(),
  handler: async (input, { client }) => {
    const attributes: Record<string, unknown> = { capabilityType: input.capabilityType };
    if (input.settings) attributes.settings = input.settings;
    const res = await client.post<{ data: { id: string } }>("/v1/bundleIdCapabilities", {
      data: {
        type: "bundleIdCapabilities",
        attributes,
        relationships: { bundleId: { data: { type: "bundleIds", id: input.bundleIdResourceId } } },
      },
    });
    return { ok: true, capabilityId: res.data.id, capabilityType: input.capabilityType };
  },
});

export const disableBundleCapabilityTool = tool({
  name: "asc_disable_bundle_capability",
  description: "Disable a capability by its bundleIdCapability id.",
  inputSchema: z.object({ capabilityId: z.string() }).strict(),
  handler: async (input, { client }) => {
    await client.delete(`/v1/bundleIdCapabilities/${input.capabilityId}`);
    return { ok: true, capabilityId: input.capabilityId };
  },
});

// ── Certificates ─────────────────────────────────────────────────────────────

export const listCertificatesTool = tool({
  name: "asc_list_certificates",
  description: "List signing certificates (id, name, certificateType, serialNumber, expirationDate). Filter by certificateType.",
  inputSchema: z.object({
    certificateType: z.string().optional().describe("e.g. DEVELOPMENT, DISTRIBUTION, IOS_DISTRIBUTION, MAC_APP_DISTRIBUTION."),
    limit: z.number().int().min(1).max(200).default(100).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const q: Record<string, string | number | undefined> = {
      limit: input.limit ?? 100,
      "fields[certificates]": "name,certificateType,displayName,serialNumber,platform,expirationDate",
    };
    if (input.certificateType) q["filter[certificateType]"] = input.certificateType;
    const certs = await client.list("/v1/certificates", q);
    return certs.map((c) => ({ id: c.id, ...c.attributes }));
  },
});

export const createCertificateTool = tool({
  name: "asc_create_certificate",
  description:
    "Create a signing certificate from a Certificate Signing Request (CSR). certificateType examples: DEVELOPMENT, " +
    "DISTRIBUTION, IOS_DISTRIBUTION, MAC_APP_DISTRIBUTION, MAC_INSTALLER_DISTRIBUTION. Returns certificateContent " +
    "(base64 DER) to install.",
  inputSchema: z.object({
    certificateType: z.string().describe("CertificateType enum value."),
    csrContent: z.string().describe("PEM-encoded Certificate Signing Request."),
  }).strict(),
  handler: async (input, { client }) => {
    const res = await client.post<{ data: { id: string; attributes?: Record<string, unknown> } }>("/v1/certificates", {
      data: { type: "certificates", attributes: { certificateType: input.certificateType, csrContent: input.csrContent } },
    });
    return { ok: true, certificateId: res.data.id, ...res.data.attributes };
  },
});

export const revokeCertificateTool = tool({
  name: "asc_revoke_certificate",
  description: "Revoke a certificate by id (from asc_list_certificates).",
  inputSchema: z.object({ certificateId: z.string() }).strict(),
  handler: async (input, { client }) => {
    await client.delete(`/v1/certificates/${input.certificateId}`);
    return { ok: true, certificateId: input.certificateId };
  },
});

// ── Devices ──────────────────────────────────────────────────────────────────

export const listDevicesTool = tool({
  name: "asc_list_devices",
  description: "List registered test devices (id, name, udid, platform, deviceClass, status).",
  inputSchema: z.object({
    platform: z.enum(["IOS", "MAC_OS"]).optional(),
    limit: z.number().int().min(1).max(200).default(100).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const q: Record<string, string | number | undefined> = {
      limit: input.limit ?? 100,
      "fields[devices]": "name,udid,platform,deviceClass,status,model",
    };
    if (input.platform) q["filter[platform]"] = input.platform;
    const devices = await client.list("/v1/devices", q);
    return devices.map((d) => ({ id: d.id, ...d.attributes }));
  },
});

export const registerDeviceTool = tool({
  name: "asc_register_device",
  description: "Register a test device by UDID so it can be included in development/ad-hoc provisioning profiles.",
  inputSchema: z.object({
    name: z.string(),
    udid: z.string().describe("The device UDID."),
    platform: z.enum(["IOS", "MAC_OS"]).default("IOS"),
  }).strict(),
  handler: async (input, { client }) => {
    const res = await client.post<{ data: { id: string; attributes?: Record<string, unknown> } }>("/v1/devices", {
      data: { type: "devices", attributes: { name: input.name, udid: input.udid, platform: input.platform } },
    });
    return { ok: true, deviceId: res.data.id, ...res.data.attributes };
  },
});

// ── Profiles ─────────────────────────────────────────────────────────────────

export const listProfilesTool = tool({
  name: "asc_list_profiles",
  description: "List provisioning profiles (id, name, profileType, profileState, uuid, expirationDate).",
  inputSchema: z.object({
    profileType: z.string().optional().describe("e.g. IOS_APP_STORE, IOS_APP_DEVELOPMENT, IOS_APP_ADHOC."),
    limit: z.number().int().min(1).max(200).default(100).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const q: Record<string, string | number | undefined> = {
      limit: input.limit ?? 100,
      "fields[profiles]": "name,profileType,profileState,uuid,expirationDate,platform",
    };
    if (input.profileType) q["filter[profileType]"] = input.profileType;
    const profiles = await client.list("/v1/profiles", q);
    return profiles.map((p) => ({ id: p.id, ...p.attributes }));
  },
});

export const createProfileTool = tool({
  name: "asc_create_profile",
  description:
    "Create a provisioning profile. profileType examples: IOS_APP_STORE, IOS_APP_DEVELOPMENT, IOS_APP_ADHOC, " +
    "IOS_APP_INHOUSE, MAC_APP_STORE, MAC_APP_DEVELOPMENT. Link a bundleId + certificate ids; include device ids for " +
    "development/ad-hoc profiles. Returns profileContent (base64 mobileprovision) to install.",
  inputSchema: z.object({
    name: z.string(),
    profileType: z.string().describe("ProfileType enum value (see examples)."),
    bundleIdResourceId: z.string(),
    certificateIds: z.array(z.string()).min(1),
    deviceIds: z.array(z.string()).optional().describe("Required for development / ad-hoc profiles; omit for App Store."),
  }).strict(),
  handler: async (input, { client }) => {
    const relationships: Record<string, unknown> = {
      bundleId: { data: { type: "bundleIds", id: input.bundleIdResourceId } },
      certificates: { data: input.certificateIds.map((id) => ({ type: "certificates", id })) },
    };
    if (input.deviceIds?.length) {
      relationships.devices = { data: input.deviceIds.map((id) => ({ type: "devices", id })) };
    }
    const res = await client.post<{ data: { id: string; attributes?: Record<string, unknown> } }>("/v1/profiles", {
      data: { type: "profiles", attributes: { name: input.name, profileType: input.profileType }, relationships },
    });
    return { ok: true, profileId: res.data.id, ...res.data.attributes };
  },
});

export const deleteProfileTool = tool({
  name: "asc_delete_profile",
  description: "Delete a provisioning profile by id (from asc_list_profiles).",
  inputSchema: z.object({ profileId: z.string() }).strict(),
  handler: async (input, { client }) => {
    await client.delete(`/v1/profiles/${input.profileId}`);
    return { ok: true, profileId: input.profileId };
  },
});
