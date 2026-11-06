#!/bin/bash
# Idempotent: append napcat-plugin-joiner to NapCat's official-plugin whitelist
# inside the running container. napcat.mjs comes from the image layer (not a
# persistent volume), so container recreate / image update LOSES this patch:
# re-run this script (then docker restart qq-napcat) after any compose up / pull.
set -euo pipefail
C=qq-napcat
F=/app/napcat/napcat.mjs
T=/tmp/napcat.mjs.patched

docker cp "$C:$F" "$T"
python3 - "$T" <<'PYEOF'
import re, sys
p = sys.argv[1]
x = open(p, encoding="utf-8").read()
if "napcat-plugin-joiner" in x:
    print("already patched, no-op"); sys.exit(0)
pat = re.compile(r"new Set\(\[[^\]]*?napcat-plugin-qce[^\]]*?\]\)", 16)
m = pat.findall(x)
assert len(m) == 1, "anchor not unique: %d" % len(m)
new = pat.sub(lambda r: r.group(0).replace('"napcat-plugin-qce"', '"napcat-plugin-qce", "napcat-plugin-joiner"', 1), x, count=1)
open(p, "w", encoding="utf-8").write(new)
print("patched")
PYEOF

docker cp "$T" "$C:$F"
docker exec "$C" sh -c "chown 0:0 $F && chmod 0644 $F"
rm -f "$T"
echo "verify count: $(docker exec $C sh -c "grep -c napcat-plugin-joiner $F")"
