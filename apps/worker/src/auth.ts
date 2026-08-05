import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface AuthEnv {
  AUTH_MODE?: string;
  DEV_USER_ID?: string;
  POLICY_AUD?: string;
  TEAM_DOMAIN?: string;
}

export interface AuthenticatedUser {
  id: string;
  email?: string;
}

export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type AccessTokenVerifier = (
  token: string,
  teamDomain: string,
  audience: string,
) => Promise<JWTPayload>;

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function authenticateRequest(
  request: Request,
  env: AuthEnv,
  verifyToken: AccessTokenVerifier = verifyAccessToken,
): Promise<AuthenticatedUser> {
  const mode = env.AUTH_MODE ?? "access";

  if (mode === "development") {
    const devUser = env.DEV_USER_ID?.trim();
    if (!devUser || devUser.length > 256) {
      throw new AuthError(
        503,
        "auth_not_configured",
        "Development identity is not configured.",
      );
    }

    return { id: await hashIdentity("development", devUser) };
  }

  if (mode !== "access") {
    throw new AuthError(503, "auth_not_configured", "Authentication mode is invalid.");
  }

  const teamDomain = normalizeTeamDomain(env.TEAM_DOMAIN);
  const audience = env.POLICY_AUD?.trim();
  if (!audience) {
    throw new AuthError(
      503,
      "auth_not_configured",
      "Cloudflare Access audience is not configured.",
    );
  }

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) {
    throw new AuthError(
      401,
      "authentication_required",
      "A valid Cloudflare Access session is required.",
    );
  }

  let payload: JWTPayload;
  try {
    payload = await verifyToken(token, teamDomain, audience);
  } catch {
    throw new AuthError(
      401,
      "invalid_authentication",
      "The Cloudflare Access session is invalid or expired.",
    );
  }

  if (!payload.sub) {
    throw new AuthError(
      401,
      "invalid_authentication",
      "The Cloudflare Access session has no subject.",
    );
  }

  return {
    id: await hashIdentity(teamDomain, payload.sub),
    email: typeof payload.email === "string" ? payload.email : undefined,
  };
}

async function verifyAccessToken(token: string, teamDomain: string, audience: string) {
  let keySet = keySets.get(teamDomain);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    keySets.set(teamDomain, keySet);
  }

  const { payload } = await jwtVerify(token, keySet, {
    algorithms: ["RS256"],
    issuer: teamDomain,
    audience,
  });
  return payload;
}

function normalizeTeamDomain(value?: string) {
  if (!value) {
    throw new AuthError(
      503,
      "auth_not_configured",
      "Cloudflare Access team domain is not configured.",
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthError(
      503,
      "auth_not_configured",
      "Cloudflare Access team domain is invalid.",
    );
  }

  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".cloudflareaccess.com") ||
    url.pathname !== "/" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new AuthError(
      503,
      "auth_not_configured",
      "Cloudflare Access team domain is invalid.",
    );
  }

  return url.origin;
}

async function hashIdentity(issuer: string, subject: string) {
  const bytes = new TextEncoder().encode(`${issuer}|${subject}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  const encoded = btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `u_${encoded}`;
}
