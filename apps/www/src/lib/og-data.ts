import { ProfileResponse } from "@tokenmaxxing/api-contract";

import { fetchPublicProfile } from "./public-api";

type Profile = typeof ProfileResponse.Type;

/** Everything the OG card renders: the profile summary, nothing more. */
interface ProfileOgData {
  profile: Profile;
}

async function loadProfileOgData(login: string): Promise<ProfileOgData | null> {
  const profile = await fetchPublicProfile(login, "", ProfileResponse);

  return profile === null ? null : { profile };
}

export { loadProfileOgData };

export type { Profile, ProfileOgData };
