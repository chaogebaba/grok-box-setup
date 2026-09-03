# grokfleet — the grok-fleet brain in bun + TypeScript (phase 1)

`grokfleet` is the fleet brain rewritten in bun + TypeScript. Phase 1 provides two
commands — **inventory** and batch **upgrade** — as a single compiled binary
that runs on the VPS alongside the bash `grokfleet` (see `../docs/FLEET-BRAIN.md`
§"Upgrades and inventory (grokfleet, phase 1)" for the full contract).

Zero runtime npm dependencies. Requires bun 1.4.0.

## Layout

```
src/
  cli.ts          entry — `grokfleet <cmd> [flags]`
  build-flags.ts  IS_COMPILED (build-time --define)
  env.ts          path/env resolution (FLEET_ETC/STATE/CONFIG/BOX_KEY…)
  log.ts notify.ts config.ts state.ts    logging / Telegram / TOML / inventory.json
  runner.ts       the ONE process seam (Bun.spawn); tests inject a FakeRunner
  tunnel.ts remote.ts boxes.ts status.ts  ssh/scp argv, remote command, box parsing
  stage.ts inventory.ts upgrade.ts        target resolution, inventory pass, upgrade pass
test/             bun test suite (box-free, FakeRunner)
dist/             compiled binary (gitignored — never shipped to boxes)
```

## Develop / test

```sh
bun run src/cli.ts version           # run from source
make ts-test                         # or: cd fleet && bun test
```

## Build

```sh
make ts-build     # → fleet/dist/grokfleet (bun --compile --minify --sourcemap
                  #   --target=bun-linux-x64 --define IS_COMPILED=true)
./fleet/dist/grokfleet version
```

## Deploy (VPS)

```sh
make ts-deploy    # scp → /opt/grok-fleet/.grokfleet.tmp, keep grokfleet.prev,
                  # chmod 0755, atomic `mv -f`, then smoke `grokfleet version`
```

Rollback of the binary itself: `mv /opt/grok-fleet/grokfleet.prev /opt/grok-fleet/grokfleet`.

Override the target host: `make ts-deploy VPS=root@<host> GROKFLEET_REMOTE=/opt/grok-fleet/grokfleet`.
