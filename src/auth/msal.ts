// Microsoft sign-in (Entra ID, authorization code + PKCE; no client secret), and the tokens for Azure Resource Manager.
import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
} from "@azure/msal-browser";
import type { AppConfig } from "./config";

/** Delegated access to ARM as the signed-in user: they see exactly what their Azure RBAC lets them see. */
export const ARM_SCOPES = ["https://management.azure.com/user_impersonation"];

export interface Auth {
  pca: PublicClientApplication;
  account: AccountInfo | null;
}

const redirectUri = () => `${location.origin}/redirect.html`;

/** Start MSAL and find out who's signed in: a sign-in that just came back, an account from this browser session,
 * or silent single sign-on from an existing Microsoft session in this browser (no prompt when it works). */
export async function startAuth(cfg: AppConfig): Promise<Auth> {
  const pca = new PublicClientApplication({
    auth: {
      clientId: cfg.clientId,
      authority: `https://login.microsoftonline.com/${cfg.tenantId}`,
      redirectUri: redirectUri(),
      postLogoutRedirectUri: location.origin + "/",
    },
    cache: { cacheLocation: "sessionStorage" }, // tokens last for the tab, not on disk across browser restarts
  });
  await pca.initialize();
  const result = await pca.handleRedirectPromise();
  let account: AccountInfo | null = result?.account ?? pca.getActiveAccount() ?? pca.getAllAccounts()[0] ?? null;
  if (!account) {
    try {
      account = (await pca.ssoSilent({ scopes: ARM_SCOPES })).account;
    } catch {
      account = null; // no session, third-party cookies blocked, or consent needed: the user clicks Sign in
    }
  }
  if (account) pca.setActiveAccount(account);
  return { pca, account };
}

export function signIn(auth: Auth) {
  // back to this very page after sign-in: a shared link keeps what it points to
  return auth.pca.loginRedirect({ scopes: ARM_SCOPES, redirectStartPage: location.href });
}

export function signOut(auth: Auth) {
  return auth.pca.logoutRedirect({ account: auth.account ?? undefined });
}

/** A token for ARM, refreshed silently; when that needs the user, a full-page sign-in. */
export function tokenSource(auth: Auth): () => Promise<string> {
  return async () => {
    try {
      return (await auth.pca.acquireTokenSilent({ scopes: ARM_SCOPES, account: auth.account ?? undefined })).accessToken;
    } catch (e) {
      if (e instanceof InteractionRequiredAuthError) await auth.pca.acquireTokenRedirect({ scopes: ARM_SCOPES });
      throw e;
    }
  };
}

/** A pasted token (`az account get-access-token`). Returns who it's for, or
 * an error when it isn't a token for ARM or has expired. Only decoded to show that; ARM does the real check. */
export function inspectToken(token: string): { ok: true; who: string; expires: Date; tenant: string | null } | { ok: false; error: string } {
  try {
    const part = token.trim().split(".")[1];
    const claims = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=")));
    const aud = String(claims.aud ?? "").replace(/\/$/, "");
    if (aud !== "https://management.azure.com" && aud !== "https://management.core.windows.net") {
      return { ok: false, error: `That token is for ${aud || "something else"}, not Azure Resource Manager. Use: az account get-access-token --resource https://management.azure.com/` };
    }
    const expires = new Date(claims.exp * 1000);
    if (expires.getTime() < Date.now()) return { ok: false, error: `That token expired at ${expires.toLocaleTimeString()}. Get a fresh one.` };
    return { ok: true, who: claims.upn ?? claims.unique_name ?? claims.email ?? claims.appid ?? "token", expires, tenant: claims.tid ?? null };
  } catch {
    return { ok: false, error: "That doesn't look like an access token (a JWT: three parts separated by dots)." };
  }
}
