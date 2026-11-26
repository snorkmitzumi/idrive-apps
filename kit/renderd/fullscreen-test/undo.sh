#!/bin/sh
# Undoes install.sh: the stock template generator and local configuration back, the stock template built again.
# Run as root on the head unit, then restart it. Quick undo without this script, from SSH, for this start only:
#   umount /mnt/dataro/data/hmi/bmw/widget     (the HMI's stock widgets; then restart the HMI or the head unit)
set -eu
R=/var/opt/mgu-render
CUR=$R/current
LC=$R/mgu-render.local.conf

if [ -f "$R/hmi_template.js.stock" ]; then
	cp "$R/hmi_template.js.stock" "$CUR/hmi_template.js"
	chmod 0644 "$CUR/hmi_template.js"
	echo "stock generator back"
fi
if [ -f "$LC.before-fullscreen" ]; then
	mv -f "$LC.before-fullscreen" "$LC"
	echo "local configuration as before"
elif [ -f "$LC" ]; then
	grep -v -E '^[[:space:]]*(embed_layout|embed_area)[[:space:]]*=' "$LC" > "$LC.tmp" || :
	mv -f "$LC.tmp" "$LC"
	echo "embed_layout and embed_area taken out of $LC"
fi
rm -f "$R/hmi/stamp"
sh "$CUR/mgu-render-hmi.sh" --build "$CUR" "$R/hmi"
cat "$R/status.json" 2>/dev/null || :
echo "Now restart the head unit."
