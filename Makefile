.PHONY: lint test

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
