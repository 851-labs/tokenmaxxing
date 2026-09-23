import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { Gear, SignOut, Star, User } from "@phosphor-icons/react/ssr";

import { signOut } from "../lib/api";
import { meQueryOptions } from "../lib/queries";
import { GITHUB_URL } from "../lib/site";
import { Avatar } from "./ui/avatar";
import { buttonClassName } from "./ui/button";
import { Menu } from "./ui/menu";

function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur">
      <div className="mx-4 grid h-14 max-w-5xl grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border-x border-border px-4 lg:mx-auto">
        <Link className="min-w-0 truncate text-sm font-semibold" to="/">
          tokenmaxxing.sh
        </Link>
        <nav
          className="hidden items-baseline gap-6 justify-self-center sm:flex"
          aria-label="Primary"
        >
          {/* In-page anchors: only the one whose hash is in the URL is current. */}
          <Link
            activeOptions={{ includeHash: true }}
            activeProps={{ className: "text-foreground" }}
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            hash="leaderboard"
            to="/"
          >
            Leaderboard
          </Link>
          <Link
            activeOptions={{ includeHash: true }}
            activeProps={{ className: "text-foreground" }}
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            hash="faq"
            to="/"
          >
            FAQ
          </Link>
        </nav>
        <div className="col-start-3 justify-self-end">
          <UserMenu />
        </div>
      </div>
    </header>
  );
}

function UserMenu() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useQuery(meQueryOptions);
  const signout = useMutation({
    mutationFn: signOut,
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      await router.invalidate();
    },
  });

  if (me.isPending) {
    return (
      <div className="flex items-center gap-2">
        <GithubStarLink />
        <Avatar size="md" src={null} />
      </div>
    );
  }

  if (me.isError) {
    return (
      <div className="flex items-center gap-2">
        <GithubStarLink />
        <Link className={buttonClassName({ variant: "primary", size: "sm" })} to="/login">
          Log in
        </Link>
      </div>
    );
  }

  const user = me.data.user;

  return (
    <div className="flex items-center gap-2">
      <GithubStarLink />
      <Menu>
        <Menu.Trigger className="flex outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <Avatar alt={user.login} size="md" src={user.avatarUrl} />
        </Menu.Trigger>
        <Menu.Content>
          <Menu.Item icon={<User />} render={<Link params={{ user: user.login }} to="/$user" />}>
            Profile
          </Menu.Item>
          <Menu.Item icon={<Gear />} render={<Link to="/settings" />}>
            Settings
          </Menu.Item>
          <Menu.Separator />
          <Menu.Item
            className="text-red-500 data-highlighted:bg-red-500/10 data-highlighted:text-red-500"
            icon={<SignOut />}
            onClick={() => signout.mutate()}
          >
            Sign out
          </Menu.Item>
        </Menu.Content>
      </Menu>
    </div>
  );
}

function GithubStarLink() {
  return (
    <a
      className={buttonClassName({ variant: "outline", size: "sm" })}
      href={GITHUB_URL}
      rel="noreferrer"
      target="_blank"
    >
      <Star className="size-4" weight="bold" />
      Star
    </a>
  );
}

export { Nav };
