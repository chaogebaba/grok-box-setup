// Gate-r1 finding 1 — `fleet2 version` must embed the BUILD sha, not re-run git
// in the invocation directory. resolveGitSha(buildSha, runGit) uses the build
// flag when set and only falls back to runtime git when it is empty (dev/test).

import { test, expect, describe } from "bun:test";
import { resolveGitSha } from "../src/cli.ts";

describe("resolveGitSha (build-sha precedence)", () => {
  test("uses the injected build sha WITHOUT calling git", async () => {
    let gitCalled = false;
    const sha = await resolveGitSha("d35f9f9", async () => {
      gitCalled = true;
      return "SHOULD-NOT-BE-USED";
    });
    expect(sha).toBe("d35f9f9");
    expect(gitCalled).toBe(false); // the compiled binary never shells out to git
  });

  test("falls back to runtime git when the build sha is empty (dev)", async () => {
    let gitCalled = false;
    const sha = await resolveGitSha("", async () => {
      gitCalled = true;
      return "abc1234";
    });
    expect(sha).toBe("abc1234");
    expect(gitCalled).toBe(true);
  });

  test("runtime fallback surfaces 'unknown' when git fails", async () => {
    const sha = await resolveGitSha("", async () => "unknown");
    expect(sha).toBe("unknown");
  });
});
