#!/bin/bash
cd "$(dirname "$0")"

echo "=== ENKRIT GitHub Push ==="
echo ""

# Remove stale lock if present
if [ -f .git/index.lock ]; then
  echo "Removing stale .git/index.lock..."
  rm -f .git/index.lock
fi

# Config identity
git config user.email "kshitizgarg19@gmail.com"
git config user.name "Kshitiz Garg"

# Stage everything
git add -A

echo "Files to commit:"
git status --short
echo ""

# Commit
git commit -m "Private folder security fixes + iOS Xcode project + AppDelegate fix

Critical/High severity bug fixes:
- BUG-01: Lock button requires auth before adding to vault
- BUG-02: closeToolsPanel delegates to lockVault for proper vault cleanup
- BUG-03: Private files excluded from Recently Played (isPrivatePath check)
- BUG-04: renderLibGrid no longer permanently mutates LibState.allFiles
- BUG-05: promptSecretUnlock reads fresh store on every auth attempt
- BUG-06: triggerBiometric cancels pending callback before new request
- BUG-08: privateAddMode auto-resets after 30s safety timeout
- BUG-09: decoyAddMode same 30s safety timeout fix
- BUG-12: PIN hash upgraded to salted pinHashV2 (2000 rounds, random salt)

iOS:
- AppDelegate.swift: fix accidental text corruption (Swift compile error)
- Add full iOS Xcode project (WKWebView, PHSchemeHandler, MediaSchemeHandler)
- Sync ios/ENKRIT/www/app.js with all bug fixes

Other:
- Add install_android.command helper script
- CLAUDE.md with build/run commands and architecture docs"

echo ""
echo "Pushing to GitHub..."
git push

if [ $? -eq 0 ]; then
  echo ""
  echo "SUCCESS! All changes pushed to GitHub."
else
  echo ""
  echo "Push failed — you may need to run: git push --set-upstream origin main"
  echo "Or check your GitHub credentials."
fi

echo ""
echo "Press Enter to close."
read
