"""Publish the current commit to the public GitHub copy (github.com/JP-RanzCalhoun/Worship-Studio).

The public copy is the separate `public` branch: one snapshot commit per update, signed with GitHub's private
noreply address, never the local history (that carries JP's work email). Steps:
  1. Check the committed tree (HEAD) for personal data; stop if any is found.
  2. Add a commit on `public` whose files are exactly HEAD's.
  3. Push `public` to the `github` remote as `main` (only with --push).

Usage (from the repo folder, after committing locally):
  python tools/dev/publish_public.py "What changed"            # check + snapshot commit, no push
  python tools/dev/publish_public.py "What changed" --push     # also push

Only publish when JP asks ("update GitHub"). The repo is public: anyone can read it.
"""

import os
import re
import subprocess
import sys

NOREPLY = "270335032+JP-RanzCalhoun@users.noreply.github.com"
NAME = "JP-RanzCalhoun"
REMOTE = "github"


def git(*args: str, env: dict | None = None, input: str | None = None) -> str:
    r = subprocess.run(["git", *args], capture_output=True, text=True, encoding="utf-8", env=env, input=input)
    if r.returncode != 0:
        sys.exit(f"git {' '.join(args)} failed:\n{r.stderr.strip()}")
    return r.stdout.strip()


def personal_terms() -> list[str]:
    """What must never be public: the local git email, its domain, and the Windows user name."""
    terms = []
    email = subprocess.run(["git", "config", "user.email"], capture_output=True, text=True).stdout.strip()
    if email:
        terms += [email, email.split("@")[-1]]
    user = os.environ.get("USERNAME", "")
    if len(user) >= 4:
        terms.append(user)
    return terms


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    message, push = sys.argv[1], "--push" in sys.argv[2:]
    if git("status", "--porcelain", "--untracked-files=no"):
        sys.exit("Commit (or stash) local changes first: the public copy is made from HEAD.")

    # 1. Personal data in the committed files: stop, never clean silently.
    found = []
    for term in personal_terms():
        r = subprocess.run(["git", "grep", "-I", "-i", "-n", "-F", term, "HEAD", "--"], capture_output=True, text=True, encoding="utf-8")
        found += r.stdout.splitlines()
    r = subprocess.run(["git", "grep", "-I", "-n", "-E", r"\bC0[A-Z0-9]{9}\b", "HEAD", "--"], capture_output=True, text=True, encoding="utf-8")
    found += [f"{l}   <- looks like a Slack channel ID" for l in r.stdout.splitlines()]
    if found:
        print("Not published. Remove these from the files, commit, and run again:")
        print("\n".join(f"  {l[:160]}" for l in found[:40]))
        sys.exit(1)
    print("Check passed: no email, user name or Slack ID in the committed files.")
    print("Also check by eye that no new song lyrics or recordings were added (copyright).")

    # 2. Snapshot commit on `public` with exactly HEAD's files.
    tree = git("rev-parse", "HEAD^{tree}")
    parent = subprocess.run(["git", "rev-parse", "--verify", "-q", "public"], capture_output=True, text=True).stdout.strip()
    if parent and git("rev-parse", f"{parent}^{{tree}}") == tree:
        print("The public branch already has these files. Nothing to commit.")
    else:
        env = {**os.environ, "GIT_AUTHOR_NAME": NAME, "GIT_AUTHOR_EMAIL": NOREPLY, "GIT_COMMITTER_NAME": NAME, "GIT_COMMITTER_EMAIL": NOREPLY}
        args = ["commit-tree", tree] + (["-p", parent] if parent else [])
        body = f"{message}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n"
        commit = git(*args, env=env, input=body)
        git("update-ref", "refs/heads/public", commit)
        print(f"public -> {commit[:7]}  {message}")

    # 3. Push (never forced).
    if push:
        print(git("push", REMOTE, "public:main") or "Pushed.")
    else:
        print(f"Not pushed. To publish: git push {REMOTE} public:main")


if __name__ == "__main__":
    main()
