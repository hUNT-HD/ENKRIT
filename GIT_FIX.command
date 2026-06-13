#!/bin/bash
# ENKRIT — fix git: clear stale lock, stop tracking Xcode user-state, sync & push.
cd "$(dirname "$0")" || exit 1
echo "=== ENKRIT git fix ==="
echo ""

# 1) Clear stale locks (these block commits/push)
rm -f .git/index.lock .git/objects/maintenance.lock 2>/dev/null

# 2) Identity
git config user.email "kshitizgarg19@gmail.com"
git config user.name "Kshitiz Garg"

# 3) Stop tracking the Xcode user-state file that keeps showing as modified
git rm -r --cached --ignore-unmatch "ios/ENKRIT.xcodeproj/project.xcworkspace/xcuserdata" >/dev/null 2>&1
git add .gitignore

# 4) Commit (ok if nothing to commit)
git commit -m "chore: gitignore Xcode user state (stop push churn)" || echo "(nothing new to commit)"

# 5) Integrate any remote changes first (prevents 'fetch first' rejection)
echo ""
echo "Syncing with remote (pull --rebase)..."
git pull --rebase origin main

# 6) Push
echo ""
echo "Pushing to GitHub..."
git push
RC=$?
echo ""
if [ $RC -eq 0 ]; then
  echo "SUCCESS — repo is clean and pushed."
else
  echo "Push exit code: $RC — see messages above."
fi
echo ""
echo "Final status:"
git status -sb
echo ""
read -p "Press Enter to close..."
