// Development only (`npm run dev`, then open /?fake): Azure is replaced by the fake the tests use, slowed down so the
// loading states show, and the app starts signed in as a fake user. Production builds leave this file out.
import { fakeAzure } from "./fakeAzure";

export const FAKE = import.meta.env.DEV && new URLSearchParams(location.search).has("fake");

export function installFake() {
  const fake = fakeAzure({ delay: 250 }), real = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    return url.startsWith("https://management.azure.com") ? fake.fetch(url, init ?? {}) : real(input, init);
  }) as typeof window.fetch;
}
