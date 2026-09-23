import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { makeTestDatabase, type TestDatabase } from "./sqlite-d1";

describe("D1 test harness", () => {
  let database: TestDatabase;

  beforeEach(() => {
    database = makeTestDatabase();
  });

  afterEach(() => database.close());

  const selectWith = (count: number) =>
    database.d1
      .prepare(`select ${Array.from({ length: count }, () => "?").join(", ")}`)
      .bind(...Array.from({ length: count }, (_, index) => index));

  it("allows statements up to D1's 100 bound parameters", async () => {
    await expect(selectWith(100).raw()).resolves.toHaveLength(1);
  });

  it("rejects statements over D1's 100 bound parameters, like D1 does", async () => {
    await expect(selectWith(101).all()).rejects.toThrow("too many SQL variables");
    await expect(database.d1.batch([selectWith(1), selectWith(101)])).rejects.toThrow(
      "too many SQL variables",
    );
  });
});
