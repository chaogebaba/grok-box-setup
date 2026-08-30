.PHONY: lint test ts-test ts-build ts-deploy

lint:
	bash -n boxup
	bash -n fleetctl
	bash -n install.sh
	bash -n box-bootstrap.sh
	bash -n vps/install-vps.sh
	@command -v shellcheck >/dev/null && shellcheck -S warning boxup fleetctl install.sh box-bootstrap.sh vps/install-vps.sh || echo "shellcheck not installed; skipped"

test:
	bash tests/test-iter3-fixes.sh
	bash tests/test-fleet-brain.sh
	bash tests/test-boxup-config.sh

# --- fleet2 (bun+TS brain, phase 1) -----------------------------------------
# These targets require bun; the bash `test`/`lint` targets above do NOT, so a
# machine without bun still runs the shell suite (blueprint D1).
VPS ?= root@107.172.132.211
FLEET2_REMOTE ?= /opt/grok-fleet/fleet2

ts-test:
	cd fleet && bun test

ts-build:
	cd fleet && bun build src/cli.ts --compile --minify --sourcemap \
		--target=bun-linux-x64 --define IS_COMPILED=true \
		--define FLEET2_GIT_SHA="\"$$(git rev-parse --short HEAD)\"" \
		--outfile dist/fleet2

# Atomic deploy (D10/S9): scp to a temp name, keep the previous binary as
# fleet2.prev, chmod, then `mv -f` over the live path, and smoke `version`.
# Rollback of fleet2 itself is `mv fleet2.prev fleet2`.
ts-deploy: ts-build
	scp fleet/dist/fleet2 $(VPS):$(FLEET2_REMOTE).tmp
	ssh $(VPS) 'set -e; \
		[ -f $(FLEET2_REMOTE) ] && cp -f $(FLEET2_REMOTE) $(FLEET2_REMOTE).prev || true; \
		chmod 0755 $(FLEET2_REMOTE).tmp; \
		mv -f $(FLEET2_REMOTE).tmp $(FLEET2_REMOTE); \
		$(FLEET2_REMOTE) version'
