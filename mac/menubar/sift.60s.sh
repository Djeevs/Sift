#!/bin/bash
#
# <bitbar.title>Sift</bitbar.title>
# <bitbar.desc>What Sift found for you today.</bitbar.desc>
# <bitbar.dependencies>node</bitbar.dependencies>
#
# A menu bar item for Sift, for SwiftBar (or xbar). Copy or symlink this into
# your plugin folder; the 60s in the filename is the refresh interval.
#
# This is deliberately a prototype rather than a native app. It answers the
# question a native app would cost a fortnight to answer -- is a glanceable
# menu actually useful here, or does the browser dashboard cover it? -- for the
# price of a shell script, and it reads the same /api/status a native client
# would, so nothing is wasted if the answer is yes.
#
# Read-only on purpose. Anything that spends money stays behind the dashboard.

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"
SIFT_URL="${SIFT_URL:-http://127.0.0.1:8790}"

NODE="$(command -v node)"
STATUS="$(curl -fsS --max-time 3 "$SIFT_URL/api/status" 2>/dev/null)"

if [ -z "$STATUS" ] || [ -z "$NODE" ]; then
  echo "◌ | sfimage=tray.fill"
  echo "---"
  if [ -z "$NODE" ]; then
    echo "Node.js was not found on PATH"
  else
    echo "Sift is not running"
    echo "Start it | href=$SIFT_URL"
  fi
  echo "Refresh | refresh=true"
  exit 0
fi

printf '%s' "$STATUS" | "$NODE" -e '
let raw = ""; process.stdin.on("data", c => raw += c).on("end", () => {
  const url = process.env.SIFT_URL || "http://127.0.0.1:8790";
  let data; try { data = JSON.parse(raw); } catch { console.log("◌\n---\nSift sent something unreadable"); return; }
  const profiles = data.profiles || [];
  // The badge counts the active reader, not every profile: a test reader must
  // not inflate the number you glance at.
  const primary = profiles.find(p => p.active) || (profiles.length === 1 ? profiles[0] : null);
  const picks = primary ? (primary.picksToday || 0) : profiles.reduce((sum, p) => sum + (p.picksToday || 0), 0);
  const busy = profiles.some(p => p.running);
  const attention = profiles.filter(p => p.needsAttention);

  // The menu bar title is the whole point: one glance, no click.
  const title = busy ? "◍" : attention.length > 0 ? "◌" : picks > 0 ? `◉ ${picks}` : "◉";
  console.log(`${title} | font=Menlo`);
  console.log("---");

  for (const p of profiles) {
    console.log(`${p.id}${p.active ? "" : " (not active)"} | size=13`);
    if (p.running) console.log(`--${p.running.label} is running…`);
    else if (p.needsAttention) console.log(`--${p.needsAttention} | color=orange`);
    else console.log(`--${p.picksToday} chosen today`);

    for (const pick of p.picks.slice(0, 5)) {
      const label = pick.title.length > 60 ? pick.title.slice(0, 57) + "…" : pick.title;
      console.log(`--${label} — ${pick.source}${pick.url ? ` | href=${pick.url}` : ""}`);
    }
    if (p.spendThisMonth !== null && p.monthlyLimit) {
      console.log(`--$${p.spendThisMonth.toFixed(2)} of $${p.monthlyLimit} this month | color=gray`);
    }
    console.log(`--Open ${p.id} | href=${url}/profile/${encodeURIComponent(p.id)}`);
  }

  console.log("---");
  console.log(`Open Sift | href=${url}`);
  console.log("Refresh | refresh=true");
  console.log(`Sift ${data.version} | color=gray size=11`);
});
'
