.PHONY: lint test

lint:
	bash -n boxup
	bash -n fleetctl
	bash -n install.sh
	bash -n box-bootstrap.sh
	@command -v shellcheck >/dev/null && shellcheck -S warning boxup fleetctl install.sh box-bootstrap.sh || echo "shellcheck not installed; skipped"

test:
	bash tests/test-iter3-fixes.sh
