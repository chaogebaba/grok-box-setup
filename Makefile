.PHONY: lint test ts-test ts-build ts-deploy ts-cutover ts-apply-flip ts-cutback

lint:
	bash -n boxup
	bash -n install.sh
	bash -n box-bootstrap.sh
	bash -n vps/install-vps.sh
	@command -v shellcheck >/dev/null && shellcheck -S warning boxup install.sh box-bootstrap.sh vps/install-vps.sh || echo "shellcheck not installed; skipped"

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

ts-test:
	cd fleet && bun test

ts-build:
	cd fleet && bun build src/cli.ts --compile --minify --sourcemap \
		--target=bun-linux-x64 --define IS_COMPILED=true \
		--define FLEET2_GIT_SHA="\"$$(git rev-parse --short HEAD)\"" \
		--outfile dist/fleet2

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
# T2 hazard: $$apply must stay a BARE $apply inside the single-quoted bash -c —
# $${apply} would be expanded by systemd against the unit env to empty and
# --apply lost silently. (Makefile $$ ⇒ a literal $ in the recipe.)
WRAPPER_EXEC = ExecStart=/bin/bash -c 'apply=""; grep -Eq "^[[:space:]]*apply[[:space:]]*=[[:space:]]*true" $(CONFIG) && apply="--apply"; exec $(FLEET2_REMOTE) reconcile $$apply'
SOAK_EXEC = ExecStart=$(FLEET2_REMOTE) reconcile --dry-run

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
	@printf '%s\n' '[Service]' 'ExecStart=' "$(WRAPPER_EXEC)" > $(DROPIN)
	@echo "ts-cutover: installed WRAPPER drop-in (runtime apply-evaluated)"
endif
	systemctl daemon-reload
	systemctl cat fleet-reconcile.service | grep -A1 '^ExecStart'

# ts-apply-flip: verify a trailing SOAK window (I1 binding; H4/I3), write the
# marker, and swap the soak drop-in for the wrapper form. SOAK_SINCE may only
# LENGTHEN the window (>=24h). FORCE=1 overrides the check and is recorded INTO
# the marker (I1). The check counts `reconcile: done (DRY-RUN)` and refuses on any
# non-zero ExecMainStatus / Result=exit-code in the window.
SOAK_SINCE ?= -24h
ts-apply-flip:
	@bash fleet/scripts/apply-flip.sh "$(SOAK_SINCE)" "$(FORCE)" "$(SOAK_MARKER)" "$(DROPIN)" "$(DROPIN_DIR)" "$(WRAPPER_EXEC)"
	systemctl daemon-reload
	systemctl cat fleet-reconcile.service | grep -A1 '^ExecStart'

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
	systemctl daemon-reload
	systemctl cat fleet-reconcile.service | grep -A1 '^ExecStart'
