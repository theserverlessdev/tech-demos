export type AppConfig = {
  turnstileSiteKey: string;
  turnstileConfigured: boolean;
  issuer: string;
  clientId: string;
  redirectUri: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  logoutEndpoint: string;
  jwksUri: string;
  introspectionEndpoint: string;
  revocationEndpoint: string;
  deviceAuthorizationEndpoint: string;
  registrationEndpoint: string;
  parEndpoint: string;
  federation: { id: string; label: string }[];
};

export type TokenResponse = {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
};

export type UserInfo = {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
};

export type AdminUser = {
  emailMasked: string;
  createdAt: number;
  expiresAt: number;
};

export type AdminApp = {
  clientId: string;
  name: string;
  redirectUris: string[];
  grantTypes: string[];
  authMethod: string;
  clientType: string;
  scopes: string;
  expiresAt: number | null;
};

export type AdminView = {
  users: AdminUser[];
  apps: AdminApp[];
};

export type ApiError = {
  error: { code: string; message: string };
};

export const SAMPLE_CLIENT_ID = "melody-sample";
export const MACHINE_CLIENT_ID = "melody-machine";
export const USER_TTL_MS = 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 60 * 1000;
export const ACCESS_TTL_SEC = 15 * 60;
export const REFRESH_TTL_MS = 24 * 60 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 60 * 1000;
export const DEVICE_TTL_MS = 15 * 60 * 1000;
export const PAR_TTL_MS = 60 * 1000;
export const CLIENT_TTL_MS = 24 * 60 * 60 * 1000;
export const PBKDF2_ITERATIONS = 100_000;
export const STANDARD_SCOPES = ["openid", "profile", "email", "offline_access", "api"] as const;
export const KEY_ROTATE_MS = 12 * 60 * 60 * 1000;
export const KEY_VERIFY_WINDOW_MS = 24 * 60 * 60 * 1000;
