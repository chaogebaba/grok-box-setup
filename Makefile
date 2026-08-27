.PHONY: lint

lint:
	find scripts -name '*.sh' -print0 | xargs -0 -n1 bash -n
	bash -n install.sh
