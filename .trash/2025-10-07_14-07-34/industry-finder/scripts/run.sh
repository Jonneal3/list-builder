#!/bin/sh
set -e
DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$DIR"

node src/orchestrator.js "$@"


