# The project owns its root Makefile. Component registration is a managed projection.
.DEFAULT_GOAL := help
export DEVKIT_APP := $(app)
export DEVKIT_PACKAGE := $(package)
export DEVKIT_FOLLOW := $(follow)
export DEVKIT_TAIL := $(tail)
export DEVKIT_HEADLESS := $(or $(headless),0)
export DEVKIT_SYNC_RECONCILE := $(or $(reconcile),0)
export DEVKIT_SYNC_PREVIEW := $(or $(preview),0)
export DEVKIT_PACKAGE_AGGREGATE := 0
export DEVKIT_TARGET_COMPONENT :=
export DEVKIT_EXPECTED_MANIFEST := $(word 1,$(shell sha256sum .devkit/manifest.json 2>/dev/null))

devkit_loader := .devkit/runtime/devkit.sh
include .devkit/project.mk

devkit_app_valid := $(if $(strip $(app)),$(if $(findstring %,$(app)),,$(if $(filter 1,$(words $(app))),$(filter $(app),$(DEVKIT_REGISTERED_APPS)),)),1)
devkit_package_valid := $(if $(strip $(package)),$(if $(findstring %,$(package)),,$(if $(filter 1,$(words $(package))),$(filter $(package),$(DEVKIT_REGISTERED_PACKAGES)),)),1)
devkit_selectors_valid := $(if $(and $(strip $(app)),$(strip $(package))),,$(and $(devkit_app_valid),$(devkit_package_valid)))
devkit_dev_selectors_valid := $(if $(strip $(package)),,$(devkit_app_valid))

devkit_selected_apps := $(if $(devkit_dev_selectors_valid),$(if $(strip $(app)),$(app),$(DEVKIT_REGISTERED_APPS)),)
devkit_selected_packages := $(if $(devkit_selectors_valid),$(if $(strip $(package)),$(package),$(DEVKIT_REGISTERED_PACKAGES)),)
devkit_targets = $(if $(devkit_selectors_valid),$(if $(strip $(app)),$(addprefix $(1)-,$(app)),$(if $(strip $(package)),$(addprefix $(1)/packages/,$(package)),$(addprefix $(1)-,$(DEVKIT_REGISTERED_APPS)) $(addprefix $(1)/packages/,$(DEVKIT_REGISTERED_PACKAGES)))),)

.PHONY: help doctor setup check fix test build dev up down logs status sync package setup-node-workspace
# One Make invocation shares dependencies/output paths, even when -j is inherited.
# Native tools may still parallelize internally; separate invocations use admission.
.NOTPARALLEL:

help doctor down logs status sync:
	@exec sh $(devkit_loader) $@

setup: $(call devkit_targets,setup)
check: $(call devkit_targets,check)
fix: $(call devkit_targets,fix)
test: $(call devkit_targets,test)
build: $(call devkit_targets,build)
setup check fix test build:
	@exec sh $(devkit_loader) snapshot

dev up: $(addprefix dev-,$(devkit_selected_apps))
dev up:
	@exec sh $(devkit_loader) dev-snapshot
package: export DEVKIT_PACKAGE_AGGREGATE := $(if $(strip $(app)$(package)),0,1)
package: $(if $(devkit_selectors_valid),$(if $(strip $(app)),$(addprefix package-,$(app)),$(if $(strip $(package)),$(addprefix package/packages/,$(package)),$(addprefix package-,$(DEVKIT_DESKTOP_APPS)) $(addprefix package/packages/,$(DEVKIT_PACKAGEABLE_PACKAGES)))),)
	@exec sh $(devkit_loader) package-snapshot
setup-node-workspace:
	@exec sh $(devkit_loader) setup-node
setup-node-workspace: export DEVKIT_TARGET_COMPONENT :=

.PHONY: $(foreach command,setup check fix test build dev package,$(addprefix $(command)-,$(DEVKIT_REGISTERED_APPS)))
.PHONY: $(foreach command,setup check fix test build package,$(addprefix $(command)/packages/,$(DEVKIT_REGISTERED_PACKAGES)))
$(foreach command,setup check fix test build dev package,$(addprefix $(command)-,$(DEVKIT_REGISTERED_APPS))): export DEVKIT_TARGET_COMPONENT = apps/$*
$(foreach command,setup check fix test build package,$(addprefix $(command)/packages/,$(DEVKIT_REGISTERED_PACKAGES))): export DEVKIT_TARGET_COMPONENT = packages/$*

$(addprefix setup-,$(DEVKIT_REGISTERED_APPS)): setup-%:
	@exec sh $(devkit_loader) setup
$(addprefix check-,$(DEVKIT_REGISTERED_APPS)): check-%:
	@exec sh $(devkit_loader) check
$(addprefix fix-,$(DEVKIT_REGISTERED_APPS)): fix-%:
	@exec sh $(devkit_loader) fix
$(addprefix test-,$(DEVKIT_REGISTERED_APPS)): test-%:
	@exec sh $(devkit_loader) test
$(addprefix build-,$(DEVKIT_REGISTERED_APPS)): build-%:
	@exec sh $(devkit_loader) build
$(addprefix dev-,$(DEVKIT_REGISTERED_APPS)): dev-%:
	@exec sh $(devkit_loader) dev
$(addprefix package-,$(DEVKIT_REGISTERED_APPS)): package-%:
	@exec sh $(devkit_loader) package

$(addprefix setup/packages/,$(DEVKIT_REGISTERED_PACKAGES)): setup/packages/%:
	@exec sh $(devkit_loader) setup
$(addprefix check/packages/,$(DEVKIT_REGISTERED_PACKAGES)): check/packages/%:
	@exec sh $(devkit_loader) check
$(addprefix fix/packages/,$(DEVKIT_REGISTERED_PACKAGES)): fix/packages/%:
	@exec sh $(devkit_loader) fix
$(addprefix test/packages/,$(DEVKIT_REGISTERED_PACKAGES)): test/packages/%:
	@exec sh $(devkit_loader) test
$(addprefix build/packages/,$(DEVKIT_REGISTERED_PACKAGES)): build/packages/%:
	@exec sh $(devkit_loader) build
$(addprefix package/packages/,$(DEVKIT_REGISTERED_PACKAGES)): package/packages/%:
	@exec sh $(devkit_loader) package

# command= uses shellwords syntax without expansions. Exact argv: devkit exec -- ...
export DEVKIT_EXEC_COMMAND := $(value command)
export DEVKIT_EXEC_WRITE := $(or $(write),0)
export DEVKIT_EXEC_NETWORK := $(or $(network),none)
export DEVKIT_EXEC_PREPARE := $(or $(prepare),0)
.PHONY: exec
exec:
	@exec sh $(devkit_loader) exec
