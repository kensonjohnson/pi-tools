import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createManagedBrowserExtension } from "./registration.ts";

export default function browserTools(pi: ExtensionAPI): void {
  createManagedBrowserExtension(pi);
}
