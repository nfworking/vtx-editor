#!/usr/bin/env bash
# Starts the release notes for a new version: collects what changed since the last tag and writes a skeleton to
# release-notes/<tag>.md. Edit it into notes for people (what they can do now, not commit messages), then commit it
# before tagging. The Release workflow publishes the file with the release, and the editor opens it after an update.
#
#   scripts/draft-release-notes.sh v0.1.12
set -euo pipefail

TAG="${1:?usage: draft-release-notes.sh vX.Y.Z}"
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "the version must look like v0.1.12" >&2; exit 1; }

cd "$(git rev-parse --show-toplevel)"
FILE="release-notes/${TAG}.md"
[ -e "$FILE" ] && { echo "$FILE already exists" >&2; exit 1; }

PREV="$(git describe --tags --abbrev=0 --match 'v[0-9]*' 2>/dev/null || true)"
RANGE="${PREV:+$PREV..}HEAD"

mkdir -p release-notes/images
{
  echo "# Vantrex ${TAG#v}"
  echo
  echo "## New"
  echo
  echo "- "
  echo
  echo "## Improved"
  echo
  echo "- "
  echo
  echo "## Fixed"
  echo
  echo "- "
  echo
  echo "[All releases](https://github.com/nfworking/vtx-editor/releases)"
  echo
  echo "<!-- Commits since ${PREV:-the beginning}. Delete this block. Images go in release-notes/images/ and are written ![text](images/name.png).
$(git log --no-merges --pretty='- %s (%h)' "$RANGE")
-->"
} > "$FILE"

echo "wrote $FILE ($(git rev-list --count "$RANGE") commits since ${PREV:-the beginning}). Edit it, then commit it and tag ${TAG}."
