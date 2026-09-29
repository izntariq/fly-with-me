# Git explainer

This project keeps its full history in git: every version from the first line of the simulator to today, one commit
per step, dated when it actually happened.

## How this history was made

Git was switched on partway through the build (at the "keep a git history" request). To get **every version from the
start**, the history was rebuilt afterwards from the Claude Code session transcript, which records every file write
and edit in order:

1. Every file change from the session was replayed, in order, into an empty folder.
2. The replay was checked to end **byte-for-byte identical** to the working project.
3. The changes were grouped into logical versions. Each one became a commit, with its original timestamp and notes
   on what was asked for and what changed.

So every commit is a real state the code was in at that time, not a summary.

## The main ideas in 60 seconds

| Word | Meaning here |
|---|---|
| **commit** | A saved snapshot of the whole project, plus a message saying what changed and why. Each has a short id like `81fbfea`. |
| **branch** | A named line of commits. `main` is the real history. |
| **tag** | A permanent name on one commit. The versions are tagged `v0.1` … `v1.5`. |
| **HEAD** | "Where you are right now", normally the newest commit on `main`. |
| **working tree** | The actual files in the folder. `git status` shows what you've changed since the last commit. |

## Everyday commands

```bash
git log --oneline                  # the whole history, newest first
git log --oneline --reverse        # oldest first: read it like a story
git tag -n1                        # the named versions and their one-line notes
git show v1.1                      # full notes + every line changed in a version
git show v1.1 --stat               # just which files changed
git log -p -- web/js/desi.js       # the complete history of one file
git log --grep "tempo"             # find commits by what their notes say
git diff v1.0 v1.5 --stat          # what changed between two versions
git blame web/js/flydj.js          # which commit last touched each line
```

## Run an old version

```bash
git switch --detach v1.0           # the folder now contains v1.0 exactly
./run.sh                           # run it (the downloaded data in data/ and vendor/ is shared)
git switch main                    # come back to the latest
```

`--detach` means "look at this commit without moving any branch". Nothing is lost when you switch back.

To keep an old version running next to the current one, use a second folder that shares the same history:

```bash
git worktree add ../fly-v1.0 v1.0  # ../fly-v1.0 now holds v1.0
git worktree remove ../fly-v1.0    # clean up afterwards
```

Two servers can't share port 8765, so run the second one with `PORT=8766 ./run.sh`.

## Undo things

```bash
git restore web/js/main.js                 # throw away uncommitted edits to one file
git restore --source v1.2 web/js/fx.js     # bring back one file as it was in v1.2 (then commit it)
git revert <commit>                        # add a new commit that undoes an old one (history stays intact)
```

Avoid `git reset --hard` unless you're sure: it discards uncommitted work.

## What isn't in git, and why

| Path | Why it's excluded | How to get it back |
|---|---|---|
| `vendor/Drosophila_brain_model/` | Shiu et al. model + FlyWire connectivity, about 190 MB | `./run.sh` clones it |
| `data/neuron_annotations.tsv` | FlyWire cell-type annotations, about 32 MB | `./run.sh` downloads it |
| `data/*.npz`, `data/brain_xy.bin` | caches built on first start | rebuilt automatically |
| `.claude/settings.local.json` | your personal Claude Code permissions | — |

## How new work gets committed

Each working, tested change gets its own commit, with a subject line saying what changed and a body saying why, what
was asked for, and anything measured. Bigger features also get a version tag (`git tag -a v1.6 -m "…"`).

There is no remote yet, so the history lives only on this Mac. To back it up on GitHub:

```bash
gh repo create fly-brain-dj --private --source . --push
git push --tags
```
