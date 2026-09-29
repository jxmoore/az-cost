# azcost

azcost shows where your Azure money went, as a treemap: a bigger box is a bigger cost. Inspired by [aztree](https://github.com/milanm/aztree). However, It's a hosted, TypeScript/React
application you run in your own environment. Users sign in with their Microsoft account, and the page reads the costs *they* are allowed to see.

**Status: proof of concept.**

## How it works

```
browser ──sign in (PKCE)──▶ Entra ID
   │
   └──bearer token──▶ management.azure.com  (Cost Management, Advisor, Resource Graph, tag names)
web server (e.g. Caddy) ── serves the static files and config.json. It never sees a token or a cost.
```

- **The browser does everything.** It signs in with MSAL (auth code + PKCE, no client secret), calls Azure Resource
  Manager directly (ARM allows CORS), runs the rules and draws the map.
- **Permissions:** delegated `user_impersonation` on Azure Service Management, so each person sees exactly what their
  Azure RBAC allows. They need **Cost Management Reader** (or Reader) on a subscription. Advisor tips, the idle checks
  and the automatic tag choice need Reader.
- **Sign-in:** if the user already has a Microsoft session in that browser, silent SSO signs them in without a prompt.
  Otherwise they click **Sign in with Microsoft**.
- **Token mode (no app registration needed):** paste the output of
  `az account get-access-token --resource https://management.azure.com/ --query accessToken -o tsv`.
  This is the web version of aztree's `AZURE_ACCESS_TOKEN`: it lasts about an hour and sees one tenant.
- **Demo:** **Try the demo** shows fake data, no Azure needed.
- **Storage:** the last run is kept in the browser's IndexedDB so it reopens instantly.
  **Forget** on the start page clears it. MSAL keeps its tokens in `sessionStorage`, so they last only as long as the tab.

## 1. Create the app registration (once)

In the Entra admin center: **App registrations → New registration**.

| Setting | Value |
|---|---|
| Name | `azcost` |
| Supported account types | Accounts in this organizational directory only (single tenant) |
| Redirect URI | Platform **Single-page application (SPA)**: `https://<your-host>/redirect.html` |

Then:

1. **Authentication → Single-page application:** also add `http://localhost:5173/redirect.html` for local
   development. Leave implicit grant off.
2. **API permissions → Add a permission → Azure Service Management → Delegated → `user_impersonation`.**
   Grant admin consent if your tenant doesn't let users consent to apps themselves.
3. **Don't create a client secret.** A SPA can't keep one, and azcost doesn't use one.
4. Copy the **Application (client) ID** and the **Directory (tenant) ID**.

There's one redirect URI, `/redirect.html`, for every sign-in: full-page, silent and token renewal.
That page is MSAL v5's redirect bridge.

## 2. Run it

### Any static web server (Caddy example)

`npm run build` writes a static site to `dist/`. Copy it into any web server image. The app needs three things from
the server:

1. **`/config.json`** with the two ids, read once at startup. `Caddyfile.example` answers that request from the
   `AZCOST_CLIENT_ID` and `AZCOST_TENANT_ID` environment variables. No file is written, so one image works for
   any tenant. Neither id is a secret. Without them, the app still starts and offers the token and demo modes.
2. **A single-page-app fallback:** unknown paths serve `index.html`.
3. **A Content-Security-Policy** (recommended). The example's policy lets the page talk only to itself,
   `login.microsoftonline.com` and `management.azure.com`.

```dockerfile
FROM caddy:2-alpine
COPY dist/ /srv/
COPY Caddyfile.example /etc/caddy/Caddyfile
```

```bash
docker run -p 8080:8080 -e AZCOST_CLIENT_ID=<application-client-id> -e AZCOST_TENANT_ID=<directory-tenant-id> your-image
```

Serve it over **HTTPS** in production: Entra ID only accepts `http://` redirect URIs for `localhost`. Either let
Caddy do TLS (set `AZCOST_SITE_ADDRESS` to your hostname) or run it behind your ingress, and register that
`https://…/redirect.html`.

### Locally

```bash
npm install
npm run dev          # http://localhost:5173
```

Set your ids in `public/config.json`, or leave the placeholders and use a pasted token or the demo.

## Using it

After sign-in, pick subscriptions (all enabled ones are pre-selected when there are 10 or fewer) and click **Read costs**.
The optional settings are the same as aztree's flags:

- **Period:** days, compared with the period before.
- **Cost type:** actual or amortized.
- **Tag** for the tag view.
- **Scope:** a billing scope instead of subscriptions.
- **Advisor** and the **Resource Graph** idle checks, each on or off.

Cost Management throttles by subscription and tenant. A run makes about 10–14 requests per subscription and waits
when Azure asks it to, and the progress log shows those waits.



