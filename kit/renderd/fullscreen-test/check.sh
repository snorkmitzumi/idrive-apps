#!/bin/sh
# After the restart: how the template and in-page drawing stand. Run as root on the head unit; send the output.
R=/var/opt/mgu-render
echo "== status.json"; cat "$R/status.json" 2>/dev/null || echo "(none)"
echo "== boot count"; cat "$R/hmi-boot" 2>/dev/null || echo "(none)"
if [ -e /run/mgu-render/hmi-template ]; then echo "== template mounted this start: yes"; else echo "== template mounted this start: NO"; fi
echo "== template files"; ls -l "$R/hmi" 2>/dev/null; ls -l /mnt/dataro/data/hmi/bmw/widget/LT_State_A4A_WelcomeApp.pbw 2>/dev/null
echo "== layout (install.sh)"; cat "$R/hmi-layout" 2>/dev/null || echo "(none: stock)"
echo "== local configuration"; cat "$R/mgu-render.local.conf" 2>/dev/null
echo "== mgu-render-hmi"; journalctl -u mgu-render-hmi -b --no-pager 2>/dev/null | tail -n 15
echo "== mgu-render (embed lines)"; journalctl -u mgu-render -b --no-pager 2>/dev/null | grep -i -E 'embed|template|robertn_store|cockpit' | tail -n 25
