#!/bin/sh
# Build the Arch package (npm run desktop:arch) for the latest commit, in the background: started by
# .githooks/post-commit. One build at a time; a commit made during a build marks one more build, run
# after it. The package: packages/desktop/arch/gh-writer-<version>-<rel>-x86_64.pkg.tar.zst.
# Log: .git/arch-build.log. A desktop notification says when it's built, or that it failed.
root=$(git rev-parse --show-toplevel)
gitdir=$(git rev-parse --absolute-git-dir)
pending="$gitdir/arch-build.pending"
log="$gitdir/arch-build.log"
notify() { command -v notify-send >/dev/null && notify-send -a gh-writer "$@"; }

exec 9>"$gitdir/arch-build.lock"
while :; do
  # A build under way sees the mark and builds again when it's done.
  flock -n 9 || exit 0
  while [ -e "$pending" ]; do
    rm -f "$pending"
    commit=$(git -C "$root" log -1 --format='%h %s')
    printf '\n=== %s: building %s\n' "$(date -Is)" "$commit" >>"$log"
    if (cd "$root" && npm run desktop:arch) >>"$log" 2>&1; then
      pkg=$(ls -t "$root"/packages/desktop/arch/gh-writer-*-x86_64.pkg.tar.zst | head -1)
      echo "=== built $pkg" >>"$log"
      notify "Arch package built" "$commit

sudo pacman -U $pkg"
    else
      echo "=== FAILED" >>"$log"
      notify -u critical "Arch build failed" "$commit

See .git/arch-build.log"
    fi
  done
  flock -u 9
  # A commit that came just as the last build finished.
  [ -e "$pending" ] || exit 0
done
