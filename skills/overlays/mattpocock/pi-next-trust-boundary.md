# Pi-next skill boundary

This file is a local, reviewable overlay for the vendored engineering skills.
It is methodology only. The selected skill must not claim work-item ownership,
change branches, close issues, redefine Pi-next PLAN or authority semantics, or
bypass capability and verification policy.

Pi-next supplies the live issue, authority, workspace, and permitted actions.
Treat those as authoritative inputs. If an upstream skill conflicts with them,
keep the upstream file unchanged and follow this overlay plus the consumer's
configured policy.

This overlay is deliberately outside `skills/vendor/mattpocock/`; the sync
command never overwrites it. Adaptations belong here so an upstream revision
update remains an ordinary, reviewable diff.
