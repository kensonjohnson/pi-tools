import { searchRecordsProfile } from "./search/records.ts";
import { jsonProfile } from "./structured/json.ts";
import { goTestProfile } from "./test/go.ts";
import { vitestProfile } from "./test/vitest.ts";
import type { OutputProfile } from "./types.ts";

export const OUTPUT_PROFILES: readonly OutputProfile[] = [
  goTestProfile,
  vitestProfile,
  jsonProfile,
  searchRecordsProfile,
];

export function profileById(id: string): OutputProfile | undefined {
  return OUTPUT_PROFILES.find((profile) => profile.id === id);
}
