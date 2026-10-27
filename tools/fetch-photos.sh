#!/usr/bin/env bash
# Скачивает фото слов с Wikimedia Commons. Список — строки «id|Имя_файла.jpg»
# (имя файла как в адресе commons.wikimedia.org/wiki/File:…). Уже скачанные
# пропускает, сжимает до 720px и дописывает автора и лицензию в credits.json.
set -euo pipefail
list="$1"; out="$2"
mkdir -p "$out"; [ -f "$out/credits.json" ] || echo "{}" > "$out/credits.json"
UA="arabic-words-site/1.0 (https://github.com/gasinpur22-cell/arabic-words)"
while IFS='|' read -r id file; do
  [ -z "$id" ] && continue
  [ -f "$out/$id.jpg" ] && continue
  enc=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$file")
  if ! curl -fsSL -A "$UA" "https://commons.wikimedia.org/wiki/Special:FilePath/$enc?width=1024" -o "$out/$id.jpg"; then
    echo "FAIL $id $file"; rm -f "$out/$id.jpg"; continue
  fi
  convert "$out/$id.jpg" -resize '720x720>' -strip -quality 78 -interlace Plane "$out/$id.jpg"
  curl -fsSL -A "$UA" "https://commons.wikimedia.org/w/api.php?action=query&titles=File:$enc&prop=imageinfo&iiprop=extmetadata&format=json" \
    | python3 -c '
import sys,json,re
id,file,path=sys.argv[1:4]
p=next(iter(json.load(sys.stdin)["query"]["pages"].values()))
m=p["imageinfo"][0]["extmetadata"]
strip=lambda s: re.sub("<[^>]+>","",s or "").strip()
c=json.load(open(path))
c[id]={"file":file,"meta":{"author":strip(m.get("Artist",{}).get("value")),"license":strip(m.get("LicenseShortName",{}).get("value"))}}
json.dump(c,open(path,"w"),ensure_ascii=False,indent=1)' "$id" "$file" "$out/credits.json"
  echo "ok $id"
  sleep 1
done < "$list"
