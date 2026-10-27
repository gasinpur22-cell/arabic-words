#!/usr/bin/env bash
# Downloads Wikimedia Commons photos listed as "name|File_name.jpg" into a folder,
# resized to 800px wide, and writes their author/license to credits.json.
set -euo pipefail
list="$1"; out="$2"
mkdir -p "$out"
UA="arabic-words-site/1.0 (https://github.com/gasinpur22-cell/arabic-words)"
echo "{" > "$out/credits.json"; first=1
while IFS='|' read -r name file; do
  [ -z "$name" ] && continue
  enc=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$file")
  if curl -fsSL -A "$UA" "https://commons.wikimedia.org/wiki/Special:FilePath/$enc?width=800" -o "$out/$name.jpg"; then
    meta=$(curl -fsSL -A "$UA" "https://commons.wikimedia.org/w/api.php?action=query&titles=File:$enc&prop=imageinfo&iiprop=extmetadata&format=json" | python3 -c '
import sys,json,re
p=next(iter(json.load(sys.stdin)["query"]["pages"].values()))
m=p["imageinfo"][0]["extmetadata"]
strip=lambda s: re.sub("<[^>]+>","",s or "").strip()
print(json.dumps({"author":strip(m.get("Artist",{}).get("value")),"license":strip(m.get("LicenseShortName",{}).get("value"))},ensure_ascii=False))' || echo '{}')
    [ $first = 1 ] || echo "," >> "$out/credits.json"; first=0
    printf '"%s": {"file": "%s", "meta": %s}' "$name" "$file" "$meta" >> "$out/credits.json"
    echo "ok $name"
  else
    echo "FAIL $name $file"
  fi
  sleep 1
done < "$list"
echo "}" >> "$out/credits.json"
