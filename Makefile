.DEFAULT_GOAL := help

RELEASE_LEVEL ?= patch
RELEASE_FLAGS ?=

.PHONY: help release release-patch release-minor release-major check

help:
	@printf '%s\n' \
	  'make check                         Run typecheck and tests' \
	  'make release [RELEASE_LEVEL=...]  Test, bump, commit, and tag a release' \
	  'make release-patch                 Prepare the next patch release' \
	  'make release-minor                 Prepare the next minor release' \
	  'make release-major                 Prepare the next major release'

check:
	npm run typecheck
	npm test

release:
	npm run release -- $(RELEASE_LEVEL) $(RELEASE_FLAGS)

release-patch:
	$(MAKE) release RELEASE_LEVEL=patch

release-minor:
	$(MAKE) release RELEASE_LEVEL=minor

release-major:
	$(MAKE) release RELEASE_LEVEL=major
