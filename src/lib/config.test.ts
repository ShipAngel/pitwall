import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateConfig } from "./config";

const valid = {
  repos: [{ owner: "Acme", name: "frontend" }],
  linear: {
    teamKey: "ENG",
  },
  refreshIntervalSeconds: 60,
};

describe("validateConfig", () => {
  it("accepts a well-formed config", () => {
    expect(() => validateConfig(valid)).not.toThrow();
  });

  it("returns the parsed config", () => {
    expect(validateConfig(valid)).toEqual(valid);
  });

  it("rejects non-object input", () => {
    expect(() => validateConfig("string")).toThrow(/must be a JSON object/);
    expect(() => validateConfig(null)).toThrow(/must be a JSON object/);
  });

  it("rejects missing repos array", () => {
    expect(() => validateConfig({ ...valid, repos: undefined })).toThrow(
      /'repos' must be an array/,
    );
  });

  it("rejects repos missing owner or name", () => {
    expect(() =>
      validateConfig({ ...valid, repos: [{ owner: "Acme" }] }),
    ).toThrow(/repos\[0\] must have 'owner' and 'name'/);
  });

  it("rejects missing linear object", () => {
    expect(() => validateConfig({ ...valid, linear: undefined })).toThrow(
      /'linear' object is required/,
    );
  });

  it("rejects empty teamKey", () => {
    expect(() =>
      validateConfig({ ...valid, linear: { ...valid.linear, teamKey: "" } }),
    ).toThrow(/'linear.teamKey'/);
  });


  it("rejects non-positive refresh interval", () => {
    expect(() =>
      validateConfig({ ...valid, refreshIntervalSeconds: 0 }),
    ).toThrow(/refreshIntervalSeconds/);
    expect(() =>
      validateConfig({ ...valid, refreshIntervalSeconds: -1 }),
    ).toThrow(/refreshIntervalSeconds/);
  });

  it("defaults a missing refresh interval to 300 seconds", () => {
    const config: Record<string, unknown> = { ...valid };
    delete config.refreshIntervalSeconds;
    expect(validateConfig(config).refreshIntervalSeconds).toBe(300);
    expect(validateConfig(valid).refreshIntervalSeconds).toBe(valid.refreshIntervalSeconds);
  });

  it("accepts a custom wipLabel", () => {
    expect(() =>
      validateConfig({ ...valid, wipLabel: "in-progress" }),
    ).not.toThrow();
  });

  it("allows wipLabel to be omitted", () => {
    expect(() => validateConfig(valid)).not.toThrow();
  });

  it("rejects a non-string wipLabel", () => {
    expect(() => validateConfig({ ...valid, wipLabel: 123 })).toThrow(
      /'wipLabel'/,
    );
  });

  it("accepts a whole-number hotspotThreshold and rejects anything else", () => {
    expect(() => validateConfig({ ...valid, hotspotThreshold: 25 })).not.toThrow();
    for (const hotspotThreshold of [0, -1, 2.5, "10", Number.NaN]) {
      expect(() => validateConfig({ ...valid, hotspotThreshold })).toThrow(/hotspotThreshold/);
    }
  });

  it("rejects an empty wipLabel", () => {
    expect(() => validateConfig({ ...valid, wipLabel: "   " })).toThrow(
      /'wipLabel'/,
    );
  });
});

describe("validateConfig — colliding repo names", () => {
  const withRepos = (
    repos: { owner: string; name: string }[],
    enabled: boolean,
  ) => ({ ...valid, repos, terminals: { enabled } });

  const COLLIDING = [
    { owner: "Acme", name: "forms.app" },
    { owner: "Acme", name: "forms-app" },
  ];

  it("rejects two repos that would share a GitHub query alias", () => {
    // repoAlias collapses "." and "-" alike, so both become repo_Acme_forms_app.
    // GraphQL refuses the duplicate and the GitHub and Security panels go down.
    expect(() => validateConfig(withRepos(COLLIDING, false))).toThrow(/same name/);
  });

  it("rejects them with terminals on too, where they'd also share a tmux session", () => {
    expect(() => validateConfig(withRepos(COLLIDING, true))).toThrow(/same name/);
  });

  it("rejects names that differ as aliases but share a tmux session", () => {
    // sanitizeForTmux collapses a run of dots to one dash; repoAlias doesn't.
    const repos = [
      { owner: "x", name: "my..app" },
      { owner: "x", name: "my.app" },
    ];
    expect(() => validateConfig(withRepos(repos, true))).toThrow(/per-PR terminals/);
  });

  it("catches collisions across the owner/name boundary", () => {
    const acrossSlash = [
      { owner: "a-b", name: "c" },
      { owner: "a", name: "b-c" },
    ];
    expect(() => validateConfig(withRepos(acrossSlash, false))).toThrow(/same name/);
  });

  it("names both offenders so the config can be fixed", () => {
    expect(() => validateConfig(withRepos(COLLIDING, true))).toThrow(
      /forms\.app.*forms-app|forms-app.*forms\.app/,
    );
  });

  it("rejects the same repo listed twice in different case", () => {
    const repos = [
      { owner: "Acme", name: "api" },
      { owner: "acme", name: "API" },
    ];
    expect(() => validateConfig(withRepos(repos, false))).toThrow(/ignores case/);
  });

  it("does not treat a duplicate entry as a collision", () => {
    const dup = [
      { owner: "Acme", name: "forms-app" },
      { owner: "Acme", name: "forms-app" },
    ];
    expect(() => validateConfig(withRepos(dup, true))).not.toThrow();
  });

  it("allows same-named repos in different orgs", () => {
    const orgs = [
      { owner: "Acme", name: "app" },
      { owner: "Other", name: "app" },
    ];
    expect(() => validateConfig(withRepos(orgs, true))).not.toThrow();
  });
});

describe("validateConfig — values that used to slip through", () => {
  it("accepts config.example.json as shipped, since it is every new user's first step", () => {
    const example = JSON.parse(
      readFileSync(path.join(__dirname, "../../config.example.json"), "utf8"),
    );
    expect(() => validateConfig(example)).not.toThrow();
  });

  it("rejects a refresh interval that isn't a finite number", () => {
    for (const refreshIntervalSeconds of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => validateConfig({ ...valid, refreshIntervalSeconds })).toThrow(
        /refreshIntervalSeconds/,
      );
    }
  });

  it("rejects an owner or name that isn't a string", () => {
    expect(() => validateConfig({ ...valid, repos: [{ owner: 5, name: "x" }] })).toThrow(
      /repos\[0\]/,
    );
    expect(() => validateConfig({ ...valid, repos: [{ owner: "a", name: {} }] })).toThrow(
      /repos\[0\]/,
    );
  });

  it("rejects characters GitHub doesn't allow, which would break the query text", () => {
    for (const repo of [
      { owner: 'acme"', name: "x" },
      { owner: "acme", name: 'x") { id } #' },
      { owner: "acme corp", name: "x" },
      { owner: "acme", name: "x/y" },
    ]) {
      expect(() => validateConfig({ ...valid, repos: [repo] })).toThrow(/valid GitHub/);
    }
  });

  it("accepts the characters GitHub does allow", () => {
    const repos = [{ owner: "my-org", name: "My_Repo.js-2" }];
    expect(() => validateConfig({ ...valid, repos })).not.toThrow();
  });
});
