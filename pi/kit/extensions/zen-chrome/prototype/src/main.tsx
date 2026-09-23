/** PROTOTYPE — throwaway. */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

document.body.style.margin = "0";
createRoot(document.getElementById("root") as HTMLElement).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
