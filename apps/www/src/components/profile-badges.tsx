import type { ProfileBadgeId } from "@tokenmaxxing/api-contract";

import { cn } from "../lib/cn";
import { profileBadgeDefinition } from "../lib/profile-badges";

type ProfileBadgeSize = "profile" | "og";

const SIZE_CLASSES: Record<ProfileBadgeSize, string> = {
  og: "size-12",
  profile: "size-7",
};

function ProfileBadges({
  badges,
  className,
  size = "profile",
}: {
  badges: readonly ProfileBadgeId[];
  className?: string;
  size?: ProfileBadgeSize;
}) {
  if (badges.length === 0) {
    return null;
  }

  return (
    <div
      aria-label="Profile badges"
      className={cn("flex shrink-0 items-center gap-1.5", className)}
    >
      {badges.map((badge) => {
        const definition = profileBadgeDefinition(badge);

        return (
          <img
            alt={definition.name}
            className={cn(SIZE_CLASSES[size], "rounded-full")}
            height={size === "og" ? 48 : 28}
            key={badge}
            src={definition.imagePath}
            title={definition.name}
            width={size === "og" ? 48 : 28}
          />
        );
      })}
    </div>
  );
}

export { ProfileBadges };
