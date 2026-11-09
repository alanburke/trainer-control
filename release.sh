#!/bin/sh
# Bumps the ?v= version on every script so phones download the new code,
# then commits and pushes. Usage: ./release.sh "What changed"
set -e
cd "$(dirname "$0")"
old=$(grep -oE 'app\.js\?v=[0-9]+' index.html | grep -oE '[0-9]+$')
new=$((old + 1))
sed -i '' -E "s/\.js\?v=$old/.js?v=$new/g" index.html app.js click.js
git add -A
git commit -m "${1:-Release v$new}"
git push
echo "Released v$new"
