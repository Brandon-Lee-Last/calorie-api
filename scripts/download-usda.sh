#!/usr/bin/env bash
# Downloads USDA FoodData Central's Foundation and SR Legacy foods (public domain) as JSON into a folder:
#   scripts/download-usda.sh usda    ->  usda/foundation_food.json  usda/sr_legacy_food.json
# The download page names the newest files; if it cannot be read, the last releases we know of are tried.
set -euo pipefail
out="${1:?usage: download-usda.sh <folder>}"
mkdir -p "$out"
page=$(curl -fsSL https://fdc.nal.usda.gov/download-datasets || true)
for kind in foundation_food sr_legacy_food; do
  url=$(printf '%s' "$page" | grep -oE "[^\"' ]*FoodData_Central_${kind}_json_[0-9-]+\.zip" | sort -u | tail -1 || true)
  case "$url" in /*) url="https://fdc.nal.usda.gov$url" ;; "" | http*) ;; *) url="https://fdc.nal.usda.gov/$url" ;; esac
  if [ -z "$url" ]; then
    for name in foundation_food_json_2025-04-24 foundation_food_json_2024-10-31 sr_legacy_food_json_2018-04; do
      case "$name" in ${kind}_*) ;; *) continue ;; esac
      if curl -fsIL "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_${name}.zip" >/dev/null; then
        url="https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_${name}.zip"
        break
      fi
    done
  fi
  [ -n "$url" ] || { echo "::error::Could not find the USDA $kind download"; exit 1; }
  echo "USDA $kind: $url"
  tmp=$(mktemp -d)
  curl -fsSL "$url" -o "$tmp/$kind.zip"
  unzip -o -q "$tmp/$kind.zip" -d "$tmp/x"
  json=$(find "$tmp/x" -name '*.json' -printf '%s %p\n' | sort -n | tail -1 | cut -d' ' -f2-)
  mv "$json" "$out/$kind.json"
  rm -rf "$tmp"
done
ls -la "$out"
