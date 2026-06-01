#!/usr/bin/env bun
// Bump the plugin version in lockstep across the two files that carry a
// literal version string: package.json (also read by server.ts at runtime for
// the MCP server identifier) and .claude-plugin/plugin.json (queried by Claude
// Code's marketplace on `/plugin update`).
//
// Usage: bun run bump <semver>   (e.g. 0.2.0)

const newVersion = Bun.argv[2];
if (!newVersion || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(newVersion)) {
  console.error('usage: bun run bump <semver>  (e.g. 0.2.0 or 0.2.0-rc.1)');
  process.exit(1);
}

const targets = ['package.json', '.claude-plugin/plugin.json'];
for (const path of targets) {
  const file = Bun.file(path);
  const json = (await file.json()) as { version?: string };
  const prev = json.version ?? '<unset>';
  json.version = newVersion;
  await Bun.write(path, JSON.stringify(json, null, 2) + '\n');
  console.log(`${path}: ${prev} -> ${newVersion}`);
}
