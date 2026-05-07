#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ $# -lt 1 ]]; then
  echo "Usage: $(basename "$0") <sorting-id> [base-file.js]"
  echo "Example: $(basename "$0") timsort timsort_base_0120.js"
  exit 1
fi

SORTING_ID="$1"
BASE_FILE="${2:-${SORTING_ID}_base_0120.js}"

node benchmark_search_cli.js --sorting "$SORTING_ID" --base-file "$BASE_FILE" --from-shortlist --presets=medium,balanced,large,huge --ab-testing=on --runs 7 --progress
