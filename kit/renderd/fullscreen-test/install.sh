#!/bin/sh
# Full-screen page template test for the MGU Store's renderer (mgu-render), iDrive 7.
# Run as root on the head unit:  sh install.sh wide   (or full)      Undo:  sh undo.sh
#   wide  BMW's title bar as stock, the app the full screen width under it (0,88,1920,632)
#   map   the title bar proxy kept but after the app, the app over the whole screen (0,0,1920,720): BMW's strip
#         drawn over it, as over BMW's map
#   full  no title bar, the app over the whole screen (0,0,1920,720): showed black on a G26 (2026-11-26)
#
# What it does (nothing else is touched):
#   1. shows how in-page drawing stands now (status.json, the boot count, the marker);
#   2. keeps the stock template generator as /var/opt/mgu-render/hmi_template.js.stock (once) and the unit's
#      local configuration as mgu-render.local.conf.before-fullscreen (once);
#   3. puts this folder's hmi_template.js (the stock one plus --layout full) in its place;
#   4. writes the layout to /var/opt/mgu-render/hmi-layout and its embed_area to mgu-render.local.conf;
#   5. builds the template from this head unit's HmiMain3D (mgu-render-hmi.sh --build).
# The template is mounted into the HMI at the next head-unit start. mgu-render's own guard: when the HMI fails
# twice with a template, that template is marked failed and the HMI keeps its stock widgets.
set -eu
R=/var/opt/mgu-render
CUR=$R/current
LC=$R/mgu-render.local.conf
HERE=$(cd "$(dirname "$0")" && pwd)
LAYOUT=${1:-wide}
case $LAYOUT in
wide) AREA=0,88,1920,632 ;;
full | map) AREA=0,0,1920,720 ;;
*) echo "usage: sh install.sh wide|map|full"; exit 2 ;;
esac

if [ ! -f "$CUR/hmi_template.js" ] || [ ! -f "$CUR/mgu-render-hmi.sh" ]; then
	echo "mgu-render is not installed here ($CUR): install the Renderer from the MGU Store first"
	exit 1
fi
if [ ! -e /usr/bin/HmiMain3D ]; then
	echo "no /usr/bin/HmiMain3D: this is not an iDrive 7 head unit"
	exit 1
fi

echo "== in-page drawing before the change"
cat "$R/status.json" 2>/dev/null || echo "(no status.json)"
echo "-- boot count:"; cat "$R/hmi-boot" 2>/dev/null || echo "(none)"
if [ -e /run/mgu-render/hmi-template ]; then echo "-- template mounted this start: yes"; else echo "-- template mounted this start: NO"; fi
journalctl -u mgu-render-hmi --no-pager 2>/dev/null | tail -n 8 || :

echo "== installing the full-screen generator"
[ -f "$R/hmi_template.js.stock" ] || cp -p "$CUR/hmi_template.js" "$R/hmi_template.js.stock"
if [ -f "$LC" ] && [ ! -f "$LC.before-fullscreen" ]; then cp -p "$LC" "$LC.before-fullscreen"; fi
cp "$HERE/hmi_template.js" "$CUR/hmi_template.js"
chmod 0644 "$CUR/hmi_template.js"

touch "$LC"
grep -v -E '^[[:space:]]*(embed_layout|embed_area)[[:space:]]*=' "$LC" > "$LC.tmp" || :
printf 'embed_area = %s\n' "$AREA" >> "$LC.tmp"
mv -f "$LC.tmp" "$LC"
echo "$LAYOUT" > "$R/hmi-layout"
echo "-- layout $LAYOUT; $LC:"; cat "$LC"

echo "== building the template from this HmiMain3D"
rm -f "$R/hmi/stamp"
sh "$CUR/mgu-render-hmi.sh" --build "$CUR" "$R/hmi"
cat "$R/status.json" 2>/dev/null || :
ls -l "$R/hmi" 2>/dev/null || :

cat <<'EOF'

== next
Restart the head unit (hold the volume knob until the screen goes dark, or run: reboot).
After it is up, open the MGU Store app: it draws in-page when the renderer offers it, so with this
template it should fill the screen's width (wide) or the whole screen (full). Turn the volume: the volume bar should show over it.
Then run:  sh check.sh   and send the output (and a photo).
Undo at any time:  sh undo.sh   then restart the head unit.
EOF
