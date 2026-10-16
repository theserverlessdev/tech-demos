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
};

export type TokenResponse = {
  access_token: string;
  id_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
};

export type UserInfo = {
  sub: string;
  email: string;
  email_verified: boolean;
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
};

export type AdminView = {
  users: AdminUser[];
  apps: AdminApp[];
};

export type ApiError = {
  error: { code: string; message: string };
};

export const SAMPLE_CLIENT_ID = "melody-sample";
export const USER_TTL_MS = 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 60 * 1000;
export const ACCESS_TTL_SEC = 15 * 60;
export const REFRESH_TTL_MS = 24 * 60 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 60 * 1000;
export const PBKDF2_ITERATIONS = 100_000;
