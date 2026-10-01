#!/usr/bin/env bash
# Golden tiles: fetch a fixed set of overlay tiles from the plugin running
# on this machine (brain), forcing each one to be computed afresh, so two
# runs can be compared byte for byte (docs/plans/structural-cleanup.md,
# phase 0.3).
#
#   golden_tiles.sh fetch <label> [time]   → ~/golden-tiles/<label>/
#   golden_tiles.sh compare <labelA> <labelB>
#
# A pre/post pair must be taken within one forecast cycle (and currents /
# tide run), or the data, not the code, differs: run `fetch pre-…` with
# the old build, deploy, restart Signal K, run `fetch post-…`, compare.
# The time defaults to the forecast's valid_from + 24 h and is stored
# with the label; the post run reuses it from the pre run's time file.
set -euo pipefail

BASE=${BASE:-https://localhost:3443/plugins/signalk-weather-router-plus}
DATA=${DATA:-$HOME/.signalk/plugin-config-data/signalk-weather-router-plus}
OUT=${OUT:-$HOME/golden-tiles}

# z x y: around the vessel (New York, 40.65 N 73.98 W) at z 8 and 10,
# one in the Gulf Stream, one in Europe (outside any prebuild radius).
TILES="8/75/95 8/75/96 8/76/95 10/301/383 10/302/383 7/38/49 6/32/21"
PNG_LAYERS="wind waves current sea_state precip temperature sst tide barbs arrows isobars"
JSON_LAYERS="wind waves msl temperature sst precip sea_state current tide barbs arrows land"

fetch() {
  local label=$1 time=${2:-}
  local dir=$OUT/$label
  mkdir -p "$dir"
  if [ -z "$time" ]; then
    time=$(curl -sk "$BASE/api/status" | python3 -c '
import sys,json,datetime
d=json.load(sys.stdin); vf=d["forecast"]["valid_from"]
t=datetime.datetime.fromisoformat(vf.replace("Z","+00:00"))+datetime.timedelta(hours=24)
print(t.strftime("%Y-%m-%dT%H:00:00Z"))')
  fi
  echo "$time" > "$dir/time"
  curl -sk "$BASE/api/status" > "$dir/status.json"
  : > "$dir/cache-headers"
  local n=0 hits=0
  for t in $TILES; do
    IFS=/ read -r z x y <<< "$t"
    # Remove every saved answer for this tile so the server computes it again
    # (land tiles have no hour suffix).
    for L in $JSON_LAYERS; do rm -f "$DATA"/overlay-tiles/*/"$L"/"$z"/"${x}_${y}_"*.gz "$DATA"/overlay-tiles/*/"$L"/"$z"/"${x}_${y}.gz"; done
    # JSON tiles first: rendering a PNG reads (and saves) its JSON tile, so
    # the other order makes the JSON fetches cache hits.
    for L in $JSON_LAYERS; do
      local f="$dir/${L}_${z}_${x}_${y}.gz"
      local hdr
      hdr=$(curl -sk -o "$f" -D - "$BASE/api/tile/$L/$z/$x/$y?time=$time" | tr -d '\r' | awk 'tolower($1)=="x-tile-cache:"{print $2} /^HTTP/{print $2}' | paste -sd' ')
      echo "json $L $z/$x/$y $hdr" >> "$dir/cache-headers"
      n=$((n+1)); case "$hdr" in *hit*) hits=$((hits+1));; esac
      # gzip bodies carry an mtime header; store the decompressed bytes for comparison.
      gzip -dc "$f" > "${f%.gz}.raw" 2>/dev/null || true
    done
    # PNGs are also held in a 48 MB in-memory cache keyed by layer/tile/hour/
    # generation that only a restart or an unused time empties: a "hit" here
    # means the PNG was rendered earlier, not now.
    for L in $PNG_LAYERS; do
      local f="$dir/${L}_${z}_${x}_${y}.png"
      local hdr
      hdr=$(curl -sk -o "$f" -D - "$BASE/api/tile/$L/$z/$x/$y.png?time=$time" | tr -d '\r' | awk 'tolower($1)=="x-tile-cache:"{print $2} /^HTTP/{print $2}' | paste -sd' ')
      echo "png $L $z/$x/$y $hdr" >> "$dir/cache-headers"
      n=$((n+1)); case "$hdr" in *hit*) hits=$((hits+1));; esac
    done
  done
  echo "$label: $n fetches, $hits served from cache (0 expected; PNG hits: restart Signal K or pass an unused time), time $time"
  awk '{print $1, $NF}' "$dir/cache-headers" | sort | uniq -c
  grep -vE ' 200 (miss|hit)$' "$dir/cache-headers" | sed 's/^/  not a 200: /' || true
}

compare() {
  local a=$OUT/$1 b=$OUT/$2 same=0 diff=0 missing=0
  if ! cmp -s "$a/time" "$b/time"; then echo "times differ: $(cat "$a/time") vs $(cat "$b/time")"; fi
  local ga gb
  ga=$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d["forecast"]["cycle"])' "$a/status.json")
  gb=$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d["forecast"]["cycle"])' "$b/status.json")
  [ "$ga" = "$gb" ] || echo "FORECAST CYCLES DIFFER ($ga vs $gb): differences below may be data, not code"
  for f in "$a"/*.png "$a"/*.raw; do
    local base; base=$(basename "$f")
    if [ ! -f "$b/$base" ]; then missing=$((missing+1)); echo "missing in $2: $base"; continue; fi
    if cmp -s "$f" "$b/$base"; then same=$((same+1)); else diff=$((diff+1)); echo "DIFFERS: $base ($(stat -c%s "$f") vs $(stat -c%s "$b/$base") bytes)"; fi
  done
  echo "$same identical, $diff differ, $missing missing"
}

case ${1:-} in
  fetch) fetch "$2" "${3:-}";;
  compare) compare "$2" "$3";;
  *) echo "usage: $0 fetch <label> [time] | compare <labelA> <labelB>"; exit 2;;
esac
