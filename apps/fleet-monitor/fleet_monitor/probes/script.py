import re

# One script per tick, not one command per metric. With ControlMaster holding
# the connection open, a whole host costs one round trip.
#
# Deliberately no `set -e`: an absent optional source (no render node, no
# hwmon chip) must leave the remaining sections intact rather than truncate
# the response.
VITALS_SCRIPT = """
echo '###stat'; head -n 16 /proc/stat 2>/dev/null
echo '###meminfo'; head -n 16 /proc/meminfo 2>/dev/null
echo '###netdev'; cat /proc/net/dev 2>/dev/null
echo '###loadavg'; cat /proc/loadavg 2>/dev/null
echo '###uptime'; cat /proc/uptime 2>/dev/null
echo '###gpu'
if [ -r /sys/class/drm/card0/gt_act_freq_mhz ]; then
  cat /sys/class/drm/card0/gt_act_freq_mhz /sys/class/drm/card0/gt_max_freq_mhz 2>/dev/null
fi
"""

SLOW_SCRIPT = """
echo '###df'; df -Pk /volume1 2>/dev/null
echo '###hwmon'
for chip in /sys/class/hwmon/hwmon*; do
  name=$(cat "$chip/name" 2>/dev/null) || continue
  for sensor in "$chip"/temp*_input; do
    [ -r "$sensor" ] || continue
    echo "$name $(basename "$sensor")=$(cat "$sensor" 2>/dev/null)"
  done
done
echo '###inotify'
echo "max_user_watches=$(cat /proc/sys/fs/inotify/max_user_watches 2>/dev/null)"
echo "max_user_instances=$(cat /proc/sys/fs/inotify/max_user_instances 2>/dev/null)"
echo "instances_in_use=$(find /proc/*/fd -lname 'anon_inode:inotify' 2>/dev/null | wc -l)"
"""


def split_sections(text: str) -> dict[str, str]:
    """Split a batched response into {section name: body}.

    Sentinels must be at the start of a line to be recognized as boundaries;
    any occurrence of the sentinel mid-line is preserved as part of the body.
    Anything before the first sentinel is dropped, which absorbs login banners
    and any ssh chatter that survived LogLevel=ERROR. A sentinel with no body
    yields an empty string rather than a missing key: "collected, nothing
    there" and "never collected" are different states and must stay different.
    """
    chunks = re.split(r"(?m)^###", text)
    named = [chunk.split("\n", 1) for chunk in chunks[1:]]
    return {head.strip(): (rest[0] if rest else "") for head, *rest in named if head.strip()}
