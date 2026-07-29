import { goTestProfile } from "./test/go.ts";
import type { OutputProfile } from "./types.ts";

export const OUTPUT_PROFILES: readonly OutputProfile[] = [goTestProfile];

export function profileById(id: string): OutputProfile | undefined {
  return OUTPUT_PROFILES.find((profile) => profile.id === id);
}
