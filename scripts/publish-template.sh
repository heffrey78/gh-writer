#!/usr/bin/env bash
# Publish templates/novel to a private GitHub template repository, creating it
# on first run. Safe to re-run: it commits only when the template changed.
#
# Usage: scripts/publish-template.sh [owner/repo]
#   default repo: heffrey78/gh-writer-novel-template
#   COMMIT_MESSAGE_SUFFIX: optional extra lines appended to the commit message
set -euo pipefail

REPO="${1:-heffrey78/gh-writer-novel-template}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/templates/novel"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if ! gh repo view "$REPO" >/dev/null 2>&1; then
  gh repo create "$REPO" --private --description "Starter repository for a novel written with gh-writer"
fi
# Mark it as a template before any content lands, so the template's own
# "Set up novel" workflow skips it.
gh api -X PATCH "repos/$REPO" -F is_template=true >/dev/null

git clone -q "$(gh repo view "$REPO" --json sshUrl -q .sshUrl)" "$WORK/repo" 2>/dev/null
cd "$WORK/repo"
git checkout -q -B main
find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -a "$SRC/." .
git add -A

if git diff --cached --quiet; then
  echo "Template $REPO is already up to date."
  exit 0
fi

SOURCE_REV="$(git -C "$ROOT" rev-parse --short HEAD)"
MESSAGE="Update template from gh-writer $SOURCE_REV"
if [ -n "${COMMIT_MESSAGE_SUFFIX:-}" ]; then
  MESSAGE="$MESSAGE"$'\n\n'"$COMMIT_MESSAGE_SUFFIX"
fi
git commit -q -m "$MESSAGE"
git push -q -u origin main
echo "Published templates/novel to https://github.com/$REPO ($SOURCE_REV)"
