// semantic-release uses only tags reachable from `main`. Orphan tags (e.g. after history
// rewrite) still block `git tag vX` if vX already exists globally — keep highest merged tag
// aligned with package.json (e.g. tag v0.4.5 on the chore(release) commit).
module.exports = {
  branches: ["main"],
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "@semantic-release/changelog",
    "@semantic-release/npm",
    [
      "@semantic-release/exec",
      {
        prepareCmd:
          "node -e \"const fs=require('fs');const path='../extension/manifest.json';const m=JSON.parse(fs.readFileSync(path,'utf8'));m.version='${nextRelease.version}'.replace(/^v/,'');fs.writeFileSync(path,JSON.stringify(m,null,2)+'\\\\n');\"",
      },
    ],
    "@semantic-release/github",
    [
      "@semantic-release/git",
      {
        assets: ["package.json", "CHANGELOG.md", "../extension/manifest.json"],
        message:
          "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
      },
    ],
  ],
};
