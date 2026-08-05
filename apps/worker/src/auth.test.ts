import { describe, expect, it, vi } from "vitest";
import { authenticateRequest, AuthError } from "./auth";

describe("authenticateRequest", () => {
  it("derives a stable, non-reversible development user ID", async () => {
    const request = new Request("https://example.com/api/plan");
    const first = await authenticateRequest(request, {
      AUTH_MODE: "development",
      DEV_USER_ID: "developer@example.com",
    });
    const second = await authenticateRequest(request, {
      AUTH_MODE: "development",
      DEV_USER_ID: "developer@example.com",
    });
    expect(first.id).toBe(second.id);
    expect(first.id).toMatch(/^u_[A-Za-z0-9_-]{43}$/);
    expect(first.id).not.toContain("developer");
  });

  it("validates Access claims through the supplied verifier", async () => {
    const verifier = vi.fn(async () => ({
      sub: "access-subject",
      email: "person@example.com",
    }));
    const request = new Request("https://example.com/api/plan", {
      headers: { "cf-access-jwt-assertion": "signed-token" },
    });
    const user = await authenticateRequest(
      request,
      {
        AUTH_MODE: "access",
        TEAM_DOMAIN: "https://team.cloudflareaccess.com",
        POLICY_AUD: "audience-tag",
      },
      verifier,
    );

    expect(verifier).toHaveBeenCalledWith(
      "signed-token",
      "https://team.cloudflareaccess.com",
      "audience-tag",
    );
    expect(user.email).toBe("person@example.com");
    expect(user.id).toMatch(/^u_[A-Za-z0-9_-]{43}$/);
  });

  it("rejects an invalid Access token without leaking verifier errors", async () => {
    const request = new Request("https://example.com/api/plan", {
      headers: { "cf-access-jwt-assertion": "bad-token" },
    });
    const action = authenticateRequest(
      request,
      {
        TEAM_DOMAIN: "https://team.cloudflareaccess.com",
        POLICY_AUD: "audience-tag",
      },
      vi.fn(async () => {
        throw new Error("signature details");
      }),
    );

    await expect(action).rejects.toMatchObject({
      status: 401,
      code: "invalid_authentication",
      message: "The Cloudflare Access session is invalid or expired.",
    } satisfies Partial<AuthError>);
  });
});
