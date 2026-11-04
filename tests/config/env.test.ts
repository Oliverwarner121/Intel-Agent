import { describe, expect, it } from "vitest";
import { ConfigError, getServerEnv } from "@/config/env";

const secret = "x".repeat(32);

describe("getServerEnv", () => {
  it("defaults APP_ENV to local", () => {
    expect(getServerEnv({ CRON_SECRET: secret })).toEqual({ APP_ENV: "local", CRON_SECRET: secret });
  });

  it("reports invalid variable names without their values", () => {
    const error = (() => {
      try {
        getServerEnv({ APP_ENV: "staging", CRON_SECRET: "short-secret-value" });
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).invalidVariables.sort()).toEqual(["APP_ENV", "CRON_SECRET"]);
    expect((error as ConfigError).message).not.toContain("short-secret-value");
  });
});

describe("getServerEnv Google settings", () => {
  it("treats blank optional values as unset", () => {
    expect(getServerEnv({ CRON_SECRET: secret, GOOGLE_CLIENT_ID: " ", GOOGLE_REFRESH_TOKEN: "token" })).toEqual({
      APP_ENV: "local",
      CRON_SECRET: secret,
      GOOGLE_REFRESH_TOKEN: "token",
    });
  });
});
