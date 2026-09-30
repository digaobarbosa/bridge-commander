#!/bin/sh
# local-git.checkout — put the card's code in the project folder, so the captain
# can run or read it from the checkout they already use.
#   BC_REPO        the project folder (the main checkout)
#   BC_WORKTREE    the card's worktree, when a worker has one
#   BC_BRANCH      the card's branch name
#   BC_INPUT_MODE  detach | branch
p="$BC_REPO"; w="$BC_WORKTREE"; b="$BC_BRANCH"

git -C "$p" rev-parse --git-dir >/dev/null 2>&1 || { echo "$p is not a git checkout" >&2; exit 1; }
if [ -n "$(git -C "$p" status --porcelain --untracked-files=no)" ]; then
  echo "refusing: $p has uncommitted changes. Commit or stash them there first:" >&2
  git -C "$p" status --short --untracked-files=no >&2
  exit 1
fi

if [ "$BC_INPUT_MODE" = branch ]; then
  case "$b" in -*|'') echo "refusing: branch name '$b' is empty or looks like an option" >&2; exit 1 ;; esac
  # The branch is born with the worker's first commit; before that only the name exists.
  if ! git -C "$p" show-ref --verify --quiet "refs/heads/$b"; then
    echo "refusing: $b does not exist yet (the worker has not committed to it). Use How = detach to get the worktree's commit." >&2
    exit 1
  fi
  top=$(git -C "$p" rev-parse --show-toplevel)
  holder=$(git -C "$p" worktree list --porcelain | awk -v ref="refs/heads/$b" 'substr($0,1,9)=="worktree " {w=substr($0,10)} $0=="branch " ref {print w}')
  if [ "$holder" = "$top" ]; then echo "$p is already on $b"; exit 0; fi
  if [ -n "$holder" ]; then
    echo "refusing: $b is checked out in the worktree $holder, and git lets one branch be checked out in only one place. Use How = detach to get the same commit here, or remove that worktree first." >&2
    exit 1
  fi
  git -C "$p" switch "$b" && echo "$p is on $b"
  exit $?
fi

# detach: the worktree's HEAD is the worker's latest commit whether or not the
# branch exists yet; without a worktree, the branch is all there is.
if [ -n "$w" ] && git -C "$w" rev-parse --git-dir >/dev/null 2>&1; then
  target=$(git -C "$w" rev-parse HEAD) || exit 1
  from="the worktree $w"
  if [ -n "$(git -C "$w" status --porcelain)" ]; then
    echo "note: $w has uncommitted changes; they are not part of this checkout."
  fi
else
  case "$b" in -*|'') echo "refusing: no worktree and no usable branch name" >&2; exit 1 ;; esac
  target="$b"; from="$b"
fi
git -C "$p" switch --detach "$target" && echo "$p is at $(git -C "$p" rev-parse --short HEAD) (detached, from $from)"
