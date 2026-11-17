#!/usr/bin/env python3
"""Template of a script that changes a system as root, safely.

Copy this file, edit the CONFIG block, set PLACEHOLDER = False, and give the copy to the ops-script workflow
before a human types a sudo password for it. The rules the skeleton keeps:

  --check   (the default) needs no root. It reads the current state, validates the inputs and prints what --apply
            would change. It writes nothing and exits 0 when everything is in order, 1 when a problem is found.
  --apply   needs root (exit 2 otherwise). Before it replaces a file it saves the old one into a backup folder
            named with a timestamp, then it changes, then it verifies. If anything fails, it restores every file
            from the backup, runs the rollback commands and exits 1 (3 if the rollback itself failed).

The script holds no product names, hosts or users: those belong in your copy's CONFIG block.
Run it in a real terminal (sudo needs a password and a TTY), for example: sudo python3 this-script.py --apply
Remote: ssh -t <user>@<host> "sudo python3 this-script.py --apply"
"""
import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import time

# ---------------------------------------------------------------- CONFIG: edit this block in your copy
# Keep True until the block below describes the real change. While True, --apply refuses to run.
PLACEHOLDER = True

# Name of the change; it names the backup folder.
NAME = "example-change"

# Where backups go. Each run makes a subfolder named with a timestamp inside it.
BACKUP_ROOT = "/var/backups/" + NAME

# Files to install. "source" is a path relative to this script (a companion file next to it) or absolute.
# "dest" is an absolute path. "mode" is octal. "owner" and "group" are names, or None to leave them as the
# system gives a new file (root); an existing owner is not carried over, so set them when they matter.
# "sha256" is the expected hash of the source, or None to skip that check; pin it for a payload you did not write.
CHANGES = [
    {
        "source": os.path.basename(__file__),   # placeholder: the script itself
        "dest": os.path.join(tempfile.gettempdir(), "example-placeholder.conf"),   # placeholder: a real absolute path goes here
        "mode": 0o644,
        "owner": None,
        "group": None,
        "sha256": None,
    },
]

# Commands (lists of arguments, no shell) that run after the files are in place, e.g. a config test or a reload.
AFTER_APPLY_COMMANDS = []
# Commands that must succeed after the change for it to count as verified, e.g. a service health check.
VERIFY_COMMANDS = []
# Commands that run after a rollback restored the files, e.g. a reload of the old config.
AFTER_ROLLBACK_COMMANDS = []
# ------------------------------------------------------------------------------------------------------

HERE = os.path.dirname(os.path.abspath(__file__))


def say(msg=""):
    print(msg, flush=True)


def is_root():
    geteuid = getattr(os, "geteuid", None)
    return bool(geteuid) and geteuid() == 0


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def source_path(change):
    return change["source"] if os.path.isabs(change["source"]) else os.path.join(HERE, change["source"])


def plan_one(change):
    """Read-only: what would happen to one file. Returns (action, problems)."""
    problems = []
    src, dest = source_path(change), change["dest"]
    if not os.path.isfile(src):
        return "invalid", [f"source is missing: {src}"]
    want = sha256_of(src)
    if change.get("sha256") and change["sha256"].lower() != want:
        problems.append(f"source {src} has sha256 {want}, expected {change['sha256']}")
    if not os.path.isabs(dest):
        problems.append(f"dest must be absolute: {dest}")
    elif not os.path.isdir(os.path.dirname(dest)):
        problems.append(f"folder of dest does not exist: {os.path.dirname(dest)}")
    for kind, mod, getter in (("owner", "pwd", "getpwnam"), ("group", "grp", "getgrnam")):
        name = change.get(kind)
        if name:
            try:
                getattr(__import__(mod), getter)(name)
            except ImportError:
                problems.append(f"{kind} {name} cannot be checked on this system")
            except KeyError:
                problems.append(f"{kind} {name} does not exist here")
    if problems:
        return "invalid", problems
    if not os.path.exists(dest):
        return "create", []
    if os.path.isdir(dest):
        return "invalid", [f"dest is a directory: {dest}"]
    same = sha256_of(dest) == want and (os.stat(dest).st_mode & 0o7777) == change["mode"]
    return ("keep" if same else "replace"), []


def check():
    """Print the plan. No root needed, nothing is written."""
    say(f"check mode ({NAME}); nothing is written")
    if PLACEHOLDER:
        say("note: PLACEHOLDER is True, this is the unedited template config")
    bad = 0
    for change in CHANGES:
        action, problems = plan_one(change)
        say(f"  {action:8} {change['dest']}  <- {change['source']}")
        for p in problems:
            say(f"           problem: {p}")
            bad += 1
    for label, cmds in (("after apply", AFTER_APPLY_COMMANDS), ("verify", VERIFY_COMMANDS), ("after rollback", AFTER_ROLLBACK_COMMANDS)):
        for cmd in cmds:
            say(f"  {label}: {' '.join(cmd)}")
    say(f"apply would need root, and would back up replaced files to {BACKUP_ROOT}/<timestamp>/")
    if bad:
        say(f"{bad} problem(s): fix them before --apply")
        return 1
    say("ok")
    return 0


def run_commands(cmds, label):
    for cmd in cmds:
        say(f"  {label}: {' '.join(cmd)}")
        r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True)
        if r.stdout.strip():
            say("    " + r.stdout.strip().replace("\n", "\n    "))
        if r.returncode != 0:
            raise RuntimeError(f"{label} command failed with exit {r.returncode}: {' '.join(cmd)}")


def install(change, src):
    """Atomic replace: write next to dest, set mode and owner, then rename over it."""
    dest = change["dest"]
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(dest), prefix=".new-")
    try:
        with os.fdopen(fd, "wb") as out, open(src, "rb") as f:
            shutil.copyfileobj(f, out)
        os.chmod(tmp, change["mode"])
        if change.get("owner") or change.get("group"):
            import grp
            import pwd
            uid = pwd.getpwnam(change["owner"]).pw_uid if change.get("owner") else -1
            gid = grp.getgrnam(change["group"]).gr_gid if change.get("group") else -1
            os.chown(tmp, uid, gid)
        os.replace(tmp, dest)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def verify(change):
    dest = change["dest"]
    if not os.path.isfile(dest):
        raise RuntimeError(f"{dest} is missing after the change")
    if sha256_of(dest) != sha256_of(source_path(change)):
        raise RuntimeError(f"{dest} differs from its source after the change")
    if (os.stat(dest).st_mode & 0o7777) != change["mode"]:
        raise RuntimeError(f"{dest} has mode {os.stat(dest).st_mode & 0o7777:o}, expected {change['mode']:o}")
    if change.get("owner"):
        import pwd
        if pwd.getpwuid(os.stat(dest).st_uid).pw_name != change["owner"]:
            raise RuntimeError(f"{dest} has the wrong owner")
    if change.get("group"):
        import grp
        if grp.getgrgid(os.stat(dest).st_gid).gr_name != change["group"]:
            raise RuntimeError(f"{dest} has the wrong group")


def rollback(done, backup_dir):
    """Restore from the backup, newest change first. Returns True when everything was restored."""
    ok = True
    for dest, saved in reversed(done):
        try:
            if saved is None:
                if os.path.exists(dest):
                    os.unlink(dest)
                say(f"  rollback: removed {dest} (it did not exist before)")
            else:
                shutil.copy2(saved, dest + ".restore")
                os.replace(dest + ".restore", dest)
                say(f"  rollback: restored {dest} from {saved}")
        except Exception as e:  # keep going: restore as much as possible
            ok = False
            say(f"  rollback FAILED for {dest}: {e}; the old file is at {saved}")
    try:
        run_commands(AFTER_ROLLBACK_COMMANDS, "after rollback")
    except Exception as e:
        ok = False
        say(f"  rollback command failed: {e}")
    say(f"backup folder: {backup_dir}")
    return ok


def apply():
    if not is_root():
        say("--apply needs root: run it with sudo in your own terminal (see the top of this file)")
        return 2
    if PLACEHOLDER:
        say("refused: PLACEHOLDER is True. Edit the CONFIG block, set PLACEHOLDER = False, and check it first with --check")
        return 2
    plans = [(c, plan_one(c)) for c in CHANGES]
    problems = [p for _, (_, ps) in plans for p in ps]
    if problems:
        for p in problems:
            say(f"problem: {p}")
        say("nothing changed")
        return 1
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup_dir, n = os.path.join(BACKUP_ROOT, stamp), 1
    while os.path.exists(backup_dir):  # two runs within one second must not share a folder
        n += 1
        backup_dir = os.path.join(BACKUP_ROOT, f"{stamp}-{n}")
    os.makedirs(backup_dir, mode=0o700)
    say(f"backup folder: {backup_dir}")
    done = []  # (dest, backup path or None when the file did not exist)
    try:
        for i, (change, (action, _)) in enumerate(plans):
            dest = change["dest"]
            if action == "keep":
                say(f"  keep     {dest} (already as wanted)")
                continue
            saved = None
            if os.path.exists(dest):
                saved = os.path.join(backup_dir, f"{i:02d}-{os.path.basename(dest)}")
                shutil.copy2(dest, saved)
                with open(os.path.join(backup_dir, "MANIFEST.txt"), "a") as m:  # which backup belongs to which file
                    m.write(f"{os.path.basename(saved)} is the old {dest}\n")
            done.append((dest, saved))
            install(change, source_path(change))
            say(f"  {action:8} {dest}")
        run_commands(AFTER_APPLY_COMMANDS, "after apply")
        for change in CHANGES:
            verify(change)
        run_commands(VERIFY_COMMANDS, "verify")
    except Exception as e:
        say(f"FAILED: {e}")
        say("rolling back from the backup")
        return 1 if rollback(done, backup_dir) else 3
    say("ok: applied and verified")
    return 0


def main():
    ap = argparse.ArgumentParser(description="Root change with a check mode, backups, verification and rollback")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--check", action="store_true", help="default: no root, read and report what would change")
    g.add_argument("--apply", action="store_true", help="make the change (needs root)")
    args = ap.parse_args()
    sys.exit(apply() if args.apply else check())


if __name__ == "__main__":
    main()
