#!/usr/bin/env bash
# Deploy the backend to an Azure App Service and prove the new code is live.
# Run from Git Bash, naming the target app explicitly:
#   AZ_RG=<resource group> AZ_APP=<app service name> bash scripts/deploy.sh
# There is no default target: risips-demo-api runs the JavaScript backend, and deploying this code there by accident
# would replace it. The app's startup command must be `npm start`.
#
# Git Bash's `tar` is GNU tar, which ignores -a and writes a plain tar named .zip. Azure then unpacks
# nothing ("files to be synced = 0") and still reports the deploy as successful, so always use Windows'
# bsdtar and check the result.
set -euo pipefail
cd "$(dirname "$0")/.."
RG=${AZ_RG:?set AZ_RG to the resource group}
APP=${AZ_APP:?set AZ_APP to the App Service name (not risips-demo-api, which runs the JS backend)}
ZIP=deploy.zip

rm -f "$ZIP"
/c/Windows/System32/tar.exe -a -c -f "$ZIP" package.json package-lock.json src data/catalog.json data/catalog-rules.production.json node_modules
file "$ZIP" | grep -q 'Zip archive' || { echo "FAIL: $ZIP is not a zip"; exit 1; }

az webapp deploy -g "$RG" -n "$APP" --src-path "$ZIP" --type zip -o none

TOKEN=$(az account get-access-token --query accessToken -o tsv)
bad=0
for f in $(git ls-files src data/catalog.json data/catalog-rules.production.json); do
  live=$(curl -s -H "Authorization: Bearer $TOKEN" "https://$APP.scm.azurewebsites.net/api/vfs/site/wwwroot/$f")
  if [ "$(printf '%s' "$live" | tr -d '\r')" != "$(tr -d '\r' < "$f")" ]; then echo "NOT LIVE: $f"; bad=1; fi
done
[ $bad = 0 ] || { echo "FAIL: Azure is not serving the local code"; exit 1; }
rm -f "$ZIP"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 90 "https://$APP.azurewebsites.net/sips")
echo "All files live. GET /sips -> $code (401 = up)"
