.PHONY: lint test ts-deps ts-test ts-build ts-deploy ts-cutover ts-apply-flip ts-cutback \
        ts-release-build ts-release-publish

lint:
	bash -n boxup
	bash -n install.sh
	bash -n box-bootstrap.sh
	bash -n vps/install-vps.sh
	bash -n fleet/scripts/release-build.sh
	bash -n fleet/scripts/release-publish.sh
	@command -v shellcheck >/dev/null && shellcheck -S warning boxup install.sh box-bootstrap.sh vps/install-vps.sh fleet/scripts/release-build.sh fleet/scripts/release-publish.sh || echo "shellcheck not installed; skipped"

test:
	bash tests/test-iter3-fixes.sh
	bash tests/test-install-vps.sh
	bash tests/test-boxup-config.sh
	bash tests/test-makefile-targets.sh

# --- fleet2 (bun+TS brain) ---------------------------------------------------
# These targets require bun; the bash `test`/`lint` targets above do NOT, so a
# machine without bun still runs the shell suite (blueprint D1). Since phase 3
# (D7) fleet2 IS the brain engine — bash fleetctl is retired.
VPS ?= root@107.172.132.211
FLEET2_REMOTE ?= /opt/grok-fleet/fleet2

# The TUI is an Ink (React) app since fleet-tui-ink D4, so the bun targets need
# the node_modules tree. `--frozen-lockfile` makes the tracked fleet/bun.lock the
# authority: a dependency edit that forgot to commit the lock fails here rather
# than resolving something different on the release machine.
ts-deps:
	cd fleet && bun install --frozen-lockfile

ts-test: ts-deps
	cd fleet && bun test

ts-build: ts-deps
	cd fleet && bun build src/cli.ts --compile --minify --sourcemap \
		--target=bun-linux-x64 --define IS_COMPILED=true \
		--define process.env.NODE_ENV='"production"' \
		--define FLEET2_GIT_SHA="\"$$(git rev-parse --short HEAD)\"" \
		--outfile dist/fleet2

# --- release (blueprint fleet2-release-install D12/D15) -----------------------
# Hosts no longer BUILD fleet2 (they needed bun + make + a checkout, and the r2
# gate died on `make: command not found`); vps/install-vps.sh downloads a pinned
# release asset instead. These two targets are how that asset comes to exist.
#
# D12 SPLITS build from publish so a gate's happy-path run cannot create a
# permanent public release as a side effect. D15 is the operator sequence:
#   1. make ts-release-build                 (local, network-free; rewrites the
#                                             two pin constants in the installer)
#   2. git commit that pin bump              (a normal commit on main)
#   3. make ts-release-publish CONFIRM=1     (tags THAT commit, uploads the asset)
# The tag is created in step 3 at the commit from step 2, so the tag always names
# a commit whose installer pin matches the published bytes.
FLEET2_ASSET        = fleet2-linux-x64
FLEET2_DIST         = fleet/dist/$(FLEET2_ASSET)
FLEET2_REPO        ?= chaogebaba/grok-box-setup
FLEET2_INSTALLER    = vps/install-vps.sh

ts-release-build:
	@bash fleet/scripts/release-build.sh "$(FLEET2_INSTALLER)" "$(FLEET2_DIST)"

ts-release-publish:
	@bash fleet/scripts/release-publish.sh "$(FLEET2_INSTALLER)" "$(FLEET2_DIST)" "$(FLEET2_REPO)" "$(CONFIRM)"

# Atomic deploy (D10/S9): scp to a temp name, keep the previous binary as
# fleet2.prev, chmod, then `mv -f` over the live path, and smoke `version`.
# Rollback of fleet2 itself is `mv fleet2.prev fleet2`. Note: on the VPS the
# canonical install path is `vps/install-vps.sh` (D7 install_fleet2); this
# target is a fast dev redeploy of the binary only.
ts-deploy: ts-build
	scp fleet/dist/fleet2 $(VPS):$(FLEET2_REMOTE).tmp
	ssh $(VPS) 'set -e; \
		[ -f $(FLEET2_REMOTE) ] && cp -f $(FLEET2_REMOTE) $(FLEET2_REMOTE).prev || true; \
		chmod 0755 $(FLEET2_REMOTE).tmp; \
		mv -f $(FLEET2_REMOTE).tmp $(FLEET2_REMOTE); \
		$(FLEET2_REMOTE) version'

# --- fleet2 cutover / soak / apply-flip / cutback (systemd drop-in; runs ON the
# VPS) ------------------------------------------------------------------------
# The same unit / timer / env / lock, so two engines never run concurrently
# (D15). All targets daemon-reload and print the resulting ExecStart. They touch
# /etc/systemd and require root on the VPS. These are the ONLY apply-flip and
# rollback tooling — do not delete them again (they were dropped by 634b922 and
# restored here; docs/FLEET-BRAIN.md §"Cutover / soak / apply-flip / cutback"
# documents them and tests/test-makefile-targets.sh now binds docs to Makefile).
DROPIN_DIR = /etc/systemd/system/fleet-reconcile.service.d
DROPIN = $(DROPIN_DIR)/fleet2.conf
SOAK_MARKER = /var/lib/grok-fleet/fleet2.soak-ok
CONFIG = /opt/grok-fleet/config.toml
# systemctl is a variable ONLY so the shell test-suite can drive the real
# recipes against a scratch DROPIN_DIR on a machine with no systemd
# (SYSTEMCTL=true). Production leaves it at `systemctl`.
SYSTEMCTL ?= systemctl
# T2 hazard: $$apply must stay a BARE $apply inside the single-quoted bash -c —
# $${apply} would be expanded by systemd against the unit env to empty and
# --apply lost silently. (Makefile $$ ⇒ a literal $ in the recipe.)
WRAPPER_EXEC = ExecStart=/bin/bash -c 'apply=""; grep -Eq "^[[:space:]]*apply[[:space:]]*=[[:space:]]*true" $(CONFIG) && apply="--apply"; exec $(FLEET2_REMOTE) reconcile $$apply'
SOAK_EXEC = ExecStart=$(FLEET2_REMOTE) reconcile --dry-run
# R2-B1 (production defect): WRAPPER_EXEC must reach the drop-in file with a
# LITERAL $apply. Interpolating it into a recipe as "$(WRAPPER_EXEC)" does NOT
# work: make expands $$apply to a bare $apply in the recipe TEXT, and then the
# SHELL expands that $apply — inside double quotes — to the empty string. The
# installed drop-in then ends at `reconcile ` and --apply is lost forever, while
# `make -n` and any recipe-text assertion still show a healthy bare $apply.
# Exporting instead hands the fully expanded value to the child through the
# ENVIRONMENT, which the shell never re-expands; recipes use "$$WRAPPER_EXEC".
export WRAPPER_EXEC

# ts-cutover: install the WRAPPER drop-in (runtime apply-evaluated). REFUSES
# (G3/I1) unless the soak marker exists — the wrapper form is only ever installed
# via ts-apply-flip. Use `make ts-cutover SOAK=1` for the gate/soak (dry-run).
ts-cutover:
	@mkdir -p $(DROPIN_DIR)
ifeq ($(SOAK),1)
	@printf '%s\n' '[Service]' 'ExecStart=' '$(SOAK_EXEC)' > $(DROPIN)
	@echo "ts-cutover: installed SOAK drop-in (hard-coded --dry-run)"
else
	@if [ ! -f $(SOAK_MARKER) ]; then \
		echo "ts-cutover: REFUSED — no soak marker ($(SOAK_MARKER)); run 'make ts-cutover SOAK=1' for the gate, then 'make ts-apply-flip' after a clean 24h soak" >&2; \
		exit 1; \
	fi
	@printf '%s\n' '[Service]' 'ExecStart=' "$$WRAPPER_EXEC" > $(DROPIN)
	@echo "ts-cutover: installed WRAPPER drop-in (runtime apply-evaluated)"
endif
	$(SYSTEMCTL) daemon-reload
	@$(SYSTEMCTL) cat fleet-reconcile.service 2>/dev/null | grep -A1 '^ExecStart' || cat $(DROPIN)

# ts-apply-flip: verify a trailing SOAK window (I1 binding; H4/I3), write the
# marker, and swap the soak drop-in for the wrapper form. SOAK_SINCE may only
# LENGTHEN the window (>=24h). FORCE=1 overrides the check and is recorded INTO
# the marker (I1). The check counts `reconcile: done (DRY-RUN)` and refuses on any
# non-zero ExecMainStatus / Result=exit-code in the window.
SOAK_SINCE ?= -24h
ts-apply-flip:
	@bash fleet/scripts/apply-flip.sh "$(SOAK_SINCE)" "$(FORCE)" "$(SOAK_MARKER)" "$(DROPIN)" "$(DROPIN_DIR)" "$$WRAPPER_EXEC"
	$(SYSTEMCTL) daemon-reload
	@$(SYSTEMCTL) cat fleet-reconcile.service 2>/dev/null | grep -A1 '^ExecStart' || cat $(DROPIN)

# ts-cutback: PHASE-3 ROLLBACK. The pre-phase-3 semantic ("rm the drop-in and
# daemon-reload, back to bash fleetctl") is DEAD: D7 retired bash fleetctl and
# /opt/grok-fleet/fleetctl no longer exists, so removing the drop-in would leave
# the unit pointing at a missing binary. The phase-3-correct rollback is instead
# to (1) restore the PREVIOUS fleet2 binary kept by ts-deploy / install_fleet2 as
# fleet2.prev, and (2) reinstall the SOAK (dry-run) drop-in, so a bad binary
# CANNOT apply mutations while it is being diagnosed. Re-flip with ts-apply-flip
# after a fresh clean soak window. Refuses (rc 1) when there is no .prev.
ts-cutback:
	@if [ ! -f $(FLEET2_REMOTE).prev ]; then \
		echo "ts-cutback: REFUSED — no previous binary at $(FLEET2_REMOTE).prev; nothing to roll back to (deploy keeps .prev only when the binary changed)" >&2; \
		exit 1; \
	fi
	mv -f $(FLEET2_REMOTE).prev $(FLEET2_REMOTE)
	@mkdir -p $(DROPIN_DIR)
	@printf '%s\n' '[Service]' 'ExecStart=' '$(SOAK_EXEC)' > $(DROPIN)
	@echo "ts-cutback: restored $(FLEET2_REMOTE) from .prev and forced the SOAK (dry-run) drop-in"
	$(SYSTEMCTL) daemon-reload
	@$(SYSTEMCTL) cat fleet-reconcile.service 2>/dev/null | grep -A1 '^ExecStart' || cat $(DROPIN)
