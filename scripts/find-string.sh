#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/find-string.sh <directory> <search-string> <output-file>

Recursively searches <directory> for files containing <search-string>,
prints matches as filename:line:content, and writes the same results to
<output-file>.
EOF
}

abs_path() {
  local path="$1"
  local dir
  local base

  dir=$(dirname -- "$path")
  base=$(basename -- "$path")

  (
    cd -- "$dir"
    printf '%s/%s\n' "$(pwd -P)" "$base"
  )
}

if [[ $# -ne 3 ]]; then
  usage >&2
  exit 1
fi

search_dir="$1"
search_string="$2"
output_file="$3"

if [[ ! -d "$search_dir" ]]; then
  printf 'Error: directory not found: %s\n' "$search_dir" >&2
  exit 1
fi

output_abs=$(abs_path "$output_file")
search_abs=$(abs_path "$search_dir")

mkdir -p -- "$(dirname -- "$output_file")"
: >"$output_file"

found_match=0

while IFS= read -r -d '' file; do
  file_abs=$(abs_path "$file")

  if [[ "$file_abs" == "$output_abs" ]]; then
    continue
  fi

  if grep --binary-files=without-match -F -H -n -- "$search_string" "$file" \
    | tee -a "$output_file"; then
    found_match=1
  fi
done < <(find "$search_abs" -type f -print0)

if [[ $found_match -eq 0 ]]; then
  printf 'No matches found for "%s" in %s\n' "$search_string" "$search_dir" \
    | tee "$output_file"
fi
