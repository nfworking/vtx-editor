# Release notes

One file per release, named for its tag: `release-notes/v0.1.12.md`.

- Start it with `scripts/draft-release-notes.sh v0.1.12`, then edit it into notes for people.
- The first line must be `# Vantrex 0.1.12` (the viewer rejects a file that does not start with a heading).
- Use short sections: **New**, **Improved**, **Fixed**, and **Upgrade notes** when something needs the reader's attention.
- Images and GIFs go in `release-notes/images/` and are written `![what it shows](images/name.png)`.
- Commit the file before you tag. The Release workflow publishes it as the GitHub release text, and the editor opens
  it in a tab the first time it starts after an update.
- If the file is missing when a tag is pushed, the workflow falls back to a plain list of commits and says so.
