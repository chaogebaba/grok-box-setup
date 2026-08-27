.PHONY: lint

lint:
	bash -n boxup
	bash -n fleetctl
	bash -n install.sh
	bash -n box-bootstrap.sh
	@command -v shellcheck >/dev/null && shellcheck -S warning boxup fleetctl install.sh box-bootstrap.sh || echo "shellcheck not installed; skipped"
