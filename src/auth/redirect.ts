// The page Entra ID sends the browser back to after sign-in. MSAL's redirect bridge hands the response to the
// app (or to the hidden frame silent sign-in uses) and, after a full-page sign-in, returns to where it started.
import { broadcastResponseToMainFrame } from "@azure/msal-browser/redirect-bridge";

broadcastResponseToMainFrame().catch(e => {
  console.error(e);
  location.replace("/");
});
