import { users, type User } from "@tokenmaxxing/db";

import type { AuthUser } from "@tokenmaxxing/api-contract";

/**
 * The only user fields public endpoints may expose. Select through
 * `publicUserColumns` rather than whole `users` rows so moderation and audit
 * columns never leave the database on public paths.
 */

const publicUserColumns = {
  avatarUrl: users.avatarUrl,
  id: users.id,
  login: users.login,
  name: users.name,
};

function toAuthUser(user: Pick<User, "avatarUrl" | "id" | "login" | "name">): AuthUser {
  return { avatarUrl: user.avatarUrl, id: user.id, login: user.login, name: user.name };
}

export { publicUserColumns, toAuthUser };
