.DEFAULT_GOAL := help

RELEASE_LEVEL ?= patch
RELEASE_FLAGS ?=

.PHONY: help release release-patch release-minor release-major check bootstrap bootstrap-next

help:
	@printf '%s\n' \
	  'make check                         Run typecheck and tests' \
	  'make release [RELEASE_LEVEL=...]  Test, bump, commit, tag, and push a release' \
	  'make release-patch                 Prepare the next patch release' \
	  'make release-minor                 Prepare the next minor release' \
	  'make release-major                 Prepare the next major release' \
	  'make bootstrap                     Run the next self-host issue' \
	  'make bootstrap-N                   Run self-host for issue N' \
	  'make bootstrap-next                Show/select the next self-host issue only'

check:
	npm run typecheck
	npm test

bootstrap:
	npm run bootstrap:self-host

bootstrap-next:
	npm run bootstrap:self-host -- --next-only

bootstrap-%:
	@case '$*' in \
	  ''|*[!0-9]*) echo "make bootstrap-$*: '$*' is not a valid issue number" >&2; exit 1 ;; \
	esac
	npm run bootstrap:self-host -- --issue $*

release:
	npm run release -- $(RELEASE_LEVEL) --push $(RELEASE_FLAGS)

release-patch:
	$(MAKE) release RELEASE_LEVEL=patch

release-minor:
	$(MAKE) release RELEASE_LEVEL=minor

release-major:
	$(MAKE) release RELEASE_LEVEL=major
