# Instana Dashboard Fix — build / package
#
#   make lint      syntax-check JS and validate manifest.json
#   make package   build dist/instana-dashboard-fix-extension-<version>.zip
#   make clean     remove dist/
#   make           lint + package (default)

EXT      := instana-dashboard-fix-extension
VERSION  := $(shell sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' manifest.json | head -n1)
DIST     := dist
ZIP      := $(DIST)/$(EXT)-$(VERSION).zip

# Files shipped inside the extension package (paths are at the zip root).
FILES := manifest.json inject.js bridge.js popup.html popup.js README.md

.PHONY: all lint package clean

all: lint package

lint:
	@command -v node >/dev/null 2>&1 && { \
	  node --check inject.js && \
	  node --check bridge.js && \
	  node --check popup.js && \
	  echo "JS OK"; \
	} || echo "node not found, skipping JS syntax check"
	@python3 -m json.tool manifest.json >/dev/null && echo "manifest.json OK"

package: lint
	@mkdir -p $(DIST)
	@rm -f $(ZIP)
	@zip -q -X $(ZIP) $(FILES)
	@echo "Built $(ZIP)"

clean:
	@rm -rf $(DIST)
	@echo "Cleaned $(DIST)"
