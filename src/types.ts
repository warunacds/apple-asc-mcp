// JSON:API shapes used by App Store Connect.

export interface JsonApiRef {
  type: string;
  id: string;
}

export interface Relationship {
  data?: JsonApiRef | JsonApiRef[] | null;
  links?: { self?: string; related?: string };
}

export interface Resource<A = Record<string, unknown>> {
  type: string;
  id: string;
  attributes?: A;
  relationships?: Record<string, Relationship>;
  links?: { self?: string };
}

export interface ListResponse<A = Record<string, unknown>> {
  data: Resource<A>[];
  included?: Resource[];
  links?: { self?: string; first?: string; next?: string };
  meta?: { paging?: { total?: number; limit?: number } };
}

export interface SingleResponse<A = Record<string, unknown>> {
  data: Resource<A>;
  included?: Resource[];
  links?: { self?: string };
}

export interface ApiError {
  id?: string;
  status: string;
  code: string;
  title: string;
  detail?: string;
  source?: { pointer?: string; parameter?: string };
  meta?: Record<string, unknown>;
}

export interface ErrorResponse {
  errors: ApiError[];
}

export interface UploadOperation {
  method: string;
  url: string;
  offset: number;
  length: number;
  requestHeaders: { name: string; value: string }[];
}

// Common attribute shapes we touch frequently — kept loose; the API adds attributes regularly.

export interface AppAttrs {
  name?: string;
  bundleId?: string;
  sku?: string;
  primaryLocale?: string;
  contentRightsDeclaration?: string;
}

export interface BuildAttrs {
  version?: string; // CFBundleVersion (e.g. "42")
  uploadedDate?: string;
  expirationDate?: string;
  expired?: boolean;
  processingState?: "PROCESSING" | "FAILED" | "INVALID" | "VALID";
  buildAudienceType?: "INTERNAL_ONLY" | "APP_STORE_ELIGIBLE";
  usesNonExemptEncryption?: boolean | null;
  minOsVersion?: string;
}

export interface AppStoreVersionAttrs {
  versionString?: string;
  platform?: "IOS" | "MAC_OS" | "TV_OS" | "VISION_OS";
  appStoreState?: string;
  appVersionState?: string;
  copyright?: string;
  releaseType?: "MANUAL" | "AFTER_APPROVAL" | "SCHEDULED";
  earliestReleaseDate?: string;
  reviewType?: "APP_STORE" | "NOTARIZATION";
  downloadable?: boolean;
}

export interface VersionLocAttrs {
  locale?: string;
  description?: string;
  keywords?: string;
  marketingUrl?: string;
  promotionalText?: string;
  supportUrl?: string;
  whatsNew?: string;
}

export interface ScreenshotAttrs {
  fileName?: string;
  fileSize?: number;
  sourceFileChecksum?: string;
  uploaded?: boolean;
  uploadOperations?: UploadOperation[];
  imageAsset?: { templateUrl: string; height: number; width: number };
  assetToken?: string;
  assetDeliveryState?: { state: "AWAITING_UPLOAD" | "UPLOAD_COMPLETE" | "COMPLETE" | "FAILED"; errors?: unknown[]; warnings?: unknown[] };
}

export interface BuildUploadAttrs {
  bundleVersion?: string;
  platform?: "IOS" | "MAC_OS" | "TV_OS" | "VISION_OS";
  state?: "AWAITING_UPLOAD" | "UPLOADING" | "UPLOADED" | "PROCESSING" | "COMPLETE" | "FAILED";
  uploaded?: boolean;
}

export interface BuildUploadFileAttrs {
  fileName?: string;
  fileSize?: number;
  assetType?: string;
  uploadOperations?: UploadOperation[];
  uploaded?: boolean;
  sourceFileChecksum?: string;
}
