import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { FAKE, installFake } from "./dev/fakeMode";

if (FAKE) installFake();

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
