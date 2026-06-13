#!/bin/bash
# Deploy the ENKRIT dummy release page to demoenkrit.netlify.app
# (separate site — does NOT touch your real site)
cd "$(dirname "$0")" || exit 1
echo "================================================="
echo "  Deploying ENKRIT release page"
echo "  -> https://demoenkrit.netlify.app"
echo "  dir: $(pwd)   size: $(du -sh . | cut -f1)"
echo "================================================="
echo ""
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found. Install Node.js first."
  read -p "Press Enter to close..."; exit 1
fi
echo "If a browser opens asking to authorize Netlify, click Authorize, then come back here."
echo ""
# --prod publishes to the live URL; --site targets the demoenkrit site by name.
npx --yes netlify-cli deploy --prod --dir="." --site="demoenkrit"
RC=$?
echo ""
echo "================================================="
echo "  netlify deploy exit code: $RC"
if [ $RC -eq 0 ]; then
  echo "  Live at: https://demoenkrit.netlify.app"
else
  echo "  Deploy failed — see messages above."
  echo "  If it says 'Not authorized' run:  npx netlify-cli login"
  echo "  If it says site not found, check the site name in your Netlify account."
fi
echo "================================================="
read -p "Press Enter to close..."
