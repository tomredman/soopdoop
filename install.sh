#!/usr/bin/env bash
# ABOUTME: Installs soopdoop: puts the newest release in ~/.soopdoop/app (or moves an existing install to it) and runs its setup.
# ABOUTME: curl -fsSL https://raw.githubusercontent.com/tomredman/soopdoop/main/install.sh | bash -s -- [--invite <code>]
set -euo pipefail

# Everything runs inside main, so bash has read the whole script before any command runs (curl | bash safe).
main() {
  local repo="https://github.com/tomredman/soopdoop.git"
  local dir="${SOOPDOOP_DIR:-$HOME/.soopdoop/app}"

  if ! command -v git >/dev/null 2>&1; then
    echo "soopdoop needs git. On a Mac, run: xcode-select --install" >&2
    exit 1
  fi

  if [ -d "$dir/.git" ]; then
    echo "Checking for the newest soopdoop release..."
    git -C "$dir" fetch --quiet --tags --force origin
  else
    echo "Downloading soopdoop into $dir..."
    mkdir -p "$(dirname "$dir")"
    git clone --quiet "$repo" "$dir"
  fi

  # The newest vX.Y.Z tag. awk reads every line, so the pipe never breaks early.
  local tag
  tag="$(git -C "$dir" tag --list 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | awk 'NR == 1')"
  if [ -z "$tag" ]; then
    echo "There is no soopdoop release yet." >&2
    exit 1
  fi

  if [ -n "$(git -C "$dir" status --porcelain --untracked-files=no)" ]; then
    echo "$dir has local changes, so the installer will not touch it." >&2
    exit 1
  fi
  git -C "$dir" -c advice.detachedHead=false checkout --quiet --detach "refs/tags/$tag"
  echo "soopdoop $tag"

  if [ "${SOOPDOOP_INSTALL_ONLY:-}" = "1" ]; then
    echo "Downloaded; not running setup (SOOPDOOP_INSTALL_ONLY=1)."
    return 0
  fi
  exec "$dir/bin/soopdoop" setup "$@"
}

main "$@"
