.DEFAULT_GOAL := help

RELEASE_LEVEL ?= patch
RELEASE_FLAGS ?=
RELEASE_NOTES ?=

ifeq ($(firstword $(MAKECMDGOALS)),release)
RELEASE_NOTES_FROM_GOALS := $(wordlist 2,$(words $(MAKECMDGOALS)),$(MAKECMDGOALS))
ifneq ($(strip $(RELEASE_NOTES_FROM_GOALS)),)
override RELEASE_NOTES := $(RELEASE_NOTES_FROM_GOALS)
$(foreach goal,$(filter-out release,$(RELEASE_NOTES_FROM_GOALS)),$(eval $(goal):;@:))
endif
endif

.PHONY: help release release-patch release-minor release-major check lint bootstrap bootstrap-next

help:
	@printf '%s\n' \
	  'make check                         Run typecheck and tests' \
	  'make lint                          Run build and lint only (no tests; used by the pre-push hook)' \
	  'make release [notes...]           Test, auto-note, bump, commit, tag, and push a release' \
	  '                                  (or RELEASE_NOTES="...")' \
	  'make release-patch                 Prepare the next patch release' \
	  'make release-minor                 Prepare the next minor release' \
	  'make release-major                 Prepare the next major release' \
	  'make bootstrap                     Run the next self-host issue' \
	  'make bootstrap-N                   Run self-host for issue N' \
	  'make bootstrap-next                Show/select the next self-host issue only'

check:
	npm run typecheck
	npm test

lint:
	npm run build
	npm run lint

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
	RELEASE_NOTES="$(RELEASE_NOTES)" npm run release -- $(RELEASE_LEVEL) --push $(RELEASE_FLAGS)

release-patch:
	$(MAKE) release RELEASE_LEVEL=patch

release-minor:
	$(MAKE) release RELEASE_LEVEL=minor

release-major:
	$(MAKE) release RELEASE_LEVEL=major
