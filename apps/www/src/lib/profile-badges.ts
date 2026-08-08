import type { ProfileBadgeId } from "@tokenmaxxing/api-contract";

interface ProfileBadgeDefinition {
  imagePath: string;
  name: string;
}

const PROFILE_BADGES = {
  contributor: {
    imagePath: "/badges/contributor.png",
    name: "Contributor",
  },
  discord: {
    imagePath: "/badges/discord.png",
    name: "Discord member",
  },
  owner: {
    imagePath: "/badges/owner.png",
    name: "Owner",
  },
  starred: {
    imagePath: "/badges/starred.png",
    name: "Starred the repository",
  },
} as const satisfies Record<ProfileBadgeId, ProfileBadgeDefinition>;

function profileBadgeDefinition(id: ProfileBadgeId): ProfileBadgeDefinition {
  return PROFILE_BADGES[id];
}

export { PROFILE_BADGES, profileBadgeDefinition };

export type { ProfileBadgeDefinition };
