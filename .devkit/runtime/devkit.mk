# The project owns its root Makefile. Component registration is a managed projection.
.DEFAULT_GOAL := help
export DEVKIT_APP := $(value app)
export DEVKIT_PACKAGE := $(value package)
export DEVKIT_FOLLOW := $(value follow)
export DEVKIT_TAIL := $(value tail)
export DEVKIT_HEADLESS := $(or $(value headless),0)
export DEVKIT_CLEANUP := $(or $(value cleanup),0)
export DEVKIT_SYNC_RECONCILE := $(or $(value reconcile),0)
export DEVKIT_SYNC_PREVIEW := $(or $(value preview),0)
export DEVKIT_INFO_JSON := $(or $(value json),0)
export DEVKIT_LIFECYCLE_NAME := $(value name)
export DEVKIT_LIFECYCLE_TEMPLATE := $(value template)
export DEVKIT_LIFECYCLE_API := $(value api)
export DEVKIT_LIFECYCLE_USE := $(value use)
export DEVKIT_LIFECYCLE_PROFILE := $(value profile)
export DEVKIT_LIFECYCLE_TO := $(value to)
export DEVKIT_PACKAGE_AGGREGATE := 0
export DEVKIT_DEV_GROUP :=
export DEVKIT_TARGET_COMPONENT :=

# Capture aliases before unexport, which defines an absent variable in GNU Make.
devkit_command_present := $(if $(filter undefined,$(origin command)),,1)
devkit_cmd_present := $(if $(filter undefined,$(origin cmd)),,1)
export DEVKIT_EXEC_CONFLICT := $(and $(devkit_command_present),$(devkit_cmd_present))
export DEVKIT_EXEC_COMMAND := $(if $(devkit_command_present),$(value command),$(value cmd))
export DEVKIT_EXEC_COMPONENT := $(value component)
export DEVKIT_EXEC_WRITE := $(or $(value write),0)
export DEVKIT_EXEC_NETWORK := $(or $(value network),none)
export DEVKIT_EXEC_PREPARE := $(or $(value prepare),0)
unexport app package follow tail headless cleanup reconcile preview json
unexport name template api use profile to command cmd component write network prepare

devkit_loader := .devkit/runtime/devkit.sh
devkit_projection := $(shell test -d .devkit && test ! -L .devkit && test -f .devkit/project.mk && test ! -L .devkit/project.mk && test -r .devkit/project.mk && printf yes)
ifeq ($(devkit_projection),yes)
include .devkit/project.mk
endif
devkit_plan := $(value DEVKIT_EXPECTED_PLAN)

# Use the literal inputs throughout the DAG as well as the recipe environment.
devkit_app_valid := $(if $(DEVKIT_APP),$(if $(findstring %,$(DEVKIT_APP)),,$(if $(filter 1,$(words $(DEVKIT_APP))),$(filter $(DEVKIT_APP),$(DEVKIT_REGISTERED_APPS)),)),1)
devkit_package_valid := $(if $(DEVKIT_PACKAGE),$(if $(findstring %,$(DEVKIT_PACKAGE)),,$(if $(filter 1,$(words $(DEVKIT_PACKAGE))),$(filter $(DEVKIT_PACKAGE),$(DEVKIT_REGISTERED_PACKAGES)),)),1)
devkit_selectors_valid := $(if $(and $(DEVKIT_APP),$(DEVKIT_PACKAGE)),,$(and $(devkit_app_valid),$(devkit_package_valid)))
devkit_dev_selectors_valid := $(if $(DEVKIT_PACKAGE),,$(devkit_app_valid))

devkit_dev_aggregate := $(if $(DEVKIT_APP),0,$(if $(word 2,$(DEVKIT_REGISTERED_APPS)),1,0))
devkit_skipped_desktop := $(if $(filter 1,$(devkit_dev_aggregate)),$(if $(filter 0,$(DEVKIT_HEADLESS)),$(if $(DISPLAY),,$(DEVKIT_DESKTOP_APPS))))
devkit_selected_apps := $(if $(devkit_dev_selectors_valid),$(if $(DEVKIT_APP),$(filter $(DEVKIT_APP),$(DEVKIT_REGISTERED_APPS)),$(filter-out $(devkit_skipped_desktop),$(DEVKIT_REGISTERED_APPS))),)
devkit_targets = $(if $(devkit_selectors_valid),$(if $(DEVKIT_APP),$(addprefix $(1)-,$(filter $(DEVKIT_APP),$(DEVKIT_REGISTERED_APPS))),$(if $(DEVKIT_PACKAGE),$(addprefix $(1)/packages/,$(filter $(DEVKIT_PACKAGE),$(DEVKIT_REGISTERED_PACKAGES))),$(addprefix $(1)-,$(DEVKIT_REGISTERED_APPS)) $(addprefix $(1)/packages/,$(DEVKIT_REGISTERED_PACKAGES)))),)
devkit_app_targets := $(foreach command,setup check fix test build dev package,$(addprefix $(command)-,$(DEVKIT_REGISTERED_APPS)))
devkit_package_targets := $(foreach command,setup check fix test build package,$(addprefix $(command)/packages/,$(DEVKIT_REGISTERED_PACKAGES)))
devkit_dag := setup check fix test build dev up package setup-node-workspace $(devkit_app_targets) $(devkit_package_targets)

.PHONY: help info status doctor down logs sync add-app add-package register update recover $(devkit_dag)
# One Make invocation shares dependencies/output paths, even when -j is inherited.
# Native tools may still parallelize internally; separate invocations use admission.
.NOTPARALLEL:

help info status doctor down logs sync add-app add-package register update recover:
	@exec sh $(devkit_loader) $@

# Cache the first DAG recipe's manifest digest for this entire Make invocation.
# The plan token comes from the projection Make parsed, before any prerequisite.
devkit_manifest_digest = $(if $(filter undefined,$(origin devkit_manifest_saved)),$(eval devkit_manifest_saved := $(shell sh .devkit/runtime/devkit.sh make-manifest | awk 'length($$0) == 64 && $$0 !~ /[^a-f0-9]/ { print; exit }')))$(devkit_manifest_saved)
$(devkit_dag): private export DEVKIT_MAKE_DAG := 1
$(devkit_dag): private export DEVKIT_MAKE_PLAN := $(devkit_plan)
devkit_task = DEVKIT_EXPECTED_MANIFEST=$(devkit_manifest_digest) exec sh $(devkit_loader)

setup: $(call devkit_targets,setup)
check: $(call devkit_targets,check)
fix: $(call devkit_targets,fix)
test: $(call devkit_targets,test)
build: $(call devkit_targets,build)
setup check fix test build:
	@$(devkit_task) snapshot

dev up: export DEVKIT_DEV_GROUP := $(devkit_selected_apps)
dev up: devkit-dev-selection $(addprefix dev-,$(devkit_selected_apps))
.PHONY: devkit-dev-selection
devkit-dev-selection:
	@$(foreach desktop,$(devkit_skipped_desktop),printf '%s\n' 'devkit: warning: skipping Electron app $(desktop) without DISPLAY; use headless=1 or app=$(desktop).' >&2;):
dev up:
	@$(devkit_task) dev-snapshot
package: export DEVKIT_PACKAGE_AGGREGATE := $(if $(DEVKIT_APP)$(DEVKIT_PACKAGE),0,1)
package: $(if $(DEVKIT_APP)$(DEVKIT_PACKAGE),$(call devkit_targets,package),$(addprefix package-,$(DEVKIT_DESKTOP_APPS)) $(addprefix package/packages/,$(DEVKIT_PACKAGEABLE_PACKAGES)))
	@$(devkit_task) package-snapshot
setup-node-workspace:
	@$(devkit_task) setup-node
setup-node-workspace: export DEVKIT_TARGET_COMPONENT :=

ifneq ($(devkit_app_targets),)
$(devkit_app_targets): export DEVKIT_TARGET_COMPONENT = apps/$*
endif
ifneq ($(devkit_package_targets),)
$(devkit_package_targets): export DEVKIT_TARGET_COMPONENT = packages/$*
endif

$(addprefix setup-,$(DEVKIT_REGISTERED_APPS)): setup-%:
	@$(devkit_task) setup
$(addprefix check-,$(DEVKIT_REGISTERED_APPS)): check-%:
	@$(devkit_task) check
$(addprefix fix-,$(DEVKIT_REGISTERED_APPS)): fix-%:
	@$(devkit_task) fix
$(addprefix test-,$(DEVKIT_REGISTERED_APPS)): test-%:
	@$(devkit_task) test
$(addprefix build-,$(DEVKIT_REGISTERED_APPS)): build-%:
	@$(devkit_task) build
$(addprefix dev-,$(DEVKIT_REGISTERED_APPS)): dev-%:
	@$(devkit_task) dev
$(addprefix package-,$(DEVKIT_REGISTERED_APPS)): package-%:
	@$(devkit_task) package

$(addprefix setup/packages/,$(DEVKIT_REGISTERED_PACKAGES)): setup/packages/%:
	@$(devkit_task) setup
$(addprefix check/packages/,$(DEVKIT_REGISTERED_PACKAGES)): check/packages/%:
	@$(devkit_task) check
$(addprefix fix/packages/,$(DEVKIT_REGISTERED_PACKAGES)): fix/packages/%:
	@$(devkit_task) fix
$(addprefix test/packages/,$(DEVKIT_REGISTERED_PACKAGES)): test/packages/%:
	@$(devkit_task) test
$(addprefix build/packages/,$(DEVKIT_REGISTERED_PACKAGES)): build/packages/%:
	@$(devkit_task) build
$(addprefix package/packages/,$(DEVKIT_REGISTERED_PACKAGES)): package/packages/%:
	@$(devkit_task) package

.PHONY: exec
exec:
	@exec sh $(devkit_loader) exec
