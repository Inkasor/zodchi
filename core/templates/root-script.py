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
import stat
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
        "dest": os.path.join(os.path.abspath(os.sep), "example-placeholder.conf"),   # placeholder (a path in the root folder, nothing is probed): a real absolute path goes here
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


def wanted_ids(change):
    """The configured owner and group as numbers (None where the config leaves them alone)."""
    uid = gid = None
    if change.get("owner"):
        import pwd
        uid = pwd.getpwnam(change["owner"]).pw_uid
    if change.get("group"):
        import grp
        gid = grp.getgrnam(change["group"]).gr_gid
    return uid, gid


def plan_one(change):
    """Read-only: what would happen to one file. Returns (action, problems, sha256 of the source, lstat of dest).

    The digest is taken here, once; install and verify hold the files to it, so a source that changes after
    planning cannot get installed or pass verification. The lstat of dest (None unless dest is a regular file) is
    the snapshot that backup and install hold the destination to: a dest that changed since is not touched."""
    problems = []
    src, dest = source_path(change), change["dest"]
    if not os.path.isfile(src):
        return "invalid", [f"source is missing: {src}"], None, None
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
        return "invalid", problems, want, None
    try:
        st = os.lstat(dest)  # lstat: a symlink must be seen as a symlink
    except FileNotFoundError:
        return "create", [], want, None
    if stat.S_ISLNK(st.st_mode):
        return "invalid", [f"dest is a symlink, which this template does not replace: {dest}"], want, None
    if not stat.S_ISREG(st.st_mode):
        return "invalid", [f"dest is not a regular file: {dest}"], want, None
    uid, gid = wanted_ids(change)
    same = (sha256_of(dest) == want and stat.S_IMODE(st.st_mode) == change["mode"]
            and (uid is None or st.st_uid == uid) and (gid is None or st.st_gid == gid))
    return ("keep" if same else "replace"), [], want, st


def check():
    """Print the plan. No root needed, nothing is written."""
    say(f"check mode ({NAME}); nothing is written")
    if PLACEHOLDER:
        say("note: PLACEHOLDER is True, this is the unedited template config")
    bad = 0
    for change in CHANGES:
        action, problems, *_ = plan_one(change)
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


def stage(src, dest, uid, gid, mode):
    """Copy src into a new, exclusively created file next to dest and give it its owner and mode.
    Returns (path, sha256 of the bytes written). The caller renames it over dest or deletes it."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(dest), prefix=".new-")
    try:
        h = hashlib.sha256()
        with os.fdopen(fd, "wb") as out, open(src, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
                out.write(chunk)
        if uid is not None or gid is not None:  # owner first: chown can clear setuid and setgid bits
            os.chown(tmp, -1 if uid is None else uid, -1 if gid is None else gid)
        os.chmod(tmp, mode)
        return tmp, h.hexdigest()
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def same_file(a, b):
    """True when two stat results describe the same file in the same state."""
    keys = ("st_dev", "st_ino", "st_mode", "st_uid", "st_gid", "st_size", "st_mtime_ns")
    return all(getattr(a, k) == getattr(b, k) for k in keys)


def backup(dest, saved, snap):
    """Copy dest into saved through a handle that does not follow symlinks, and only when dest is still the file
    that was planned. Returns the fstat of the old file (its owner, mode and times, for the restore)."""
    fd = os.open(dest, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))  # fails on a symlink
    with os.fdopen(fd, "rb") as f:
        old = os.fstat(f.fileno())
        if not same_file(old, snap):
            raise RuntimeError(f"{dest} changed after planning; nothing was replaced")
        with open(saved, "xb") as out:
            shutil.copyfileobj(f, out)
    os.utime(saved, ns=(old.st_atime_ns, old.st_mtime_ns))
    return old


def install(change, src, digest, snap, placed):
    """Stage next to dest, check the staged bytes against the planned digest, then put the file in place without
    overwriting anything this run did not plan to replace: a new file is hard-linked (that fails when anything at all
    is there, even a dangling symlink), a replacement renames over dest only while dest is still the planned file.
    placed gets True the moment the file is in place."""
    dest = change["dest"]
    tmp, got = stage(src, dest, *wanted_ids(change), change["mode"])
    try:
        if got != digest:
            raise RuntimeError(f"{src} changed after planning: staged sha256 {got}, planned {digest}")
        if snap is None:
            os.link(tmp, dest)
            placed.append(True)
            os.unlink(tmp)
        else:
            if not same_file(os.lstat(dest), snap):
                raise RuntimeError(f"{dest} changed after planning; nothing was replaced")
            os.replace(tmp, dest)
            placed.append(True)
    except BaseException:
        if os.path.lexists(tmp):
            os.unlink(tmp)
        raise


def verify(change, digest):
    dest = change["dest"]
    if not os.path.isfile(dest) or os.path.islink(dest):
        raise RuntimeError(f"{dest} is missing or not a regular file after the change")
    if sha256_of(dest) != digest:
        raise RuntimeError(f"{dest} differs from the planned source digest after the change")
    st = os.stat(dest)
    if stat.S_IMODE(st.st_mode) != change["mode"]:
        raise RuntimeError(f"{dest} has mode {stat.S_IMODE(st.st_mode):o}, expected {change['mode']:o}")
    uid, gid = wanted_ids(change)
    if uid is not None and st.st_uid != uid:
        raise RuntimeError(f"{dest} has the wrong owner")
    if gid is not None and st.st_gid != gid:
        raise RuntimeError(f"{dest} has the wrong group")


def restore(saved, dest, old):
    """Put the backup back as it was: bytes, owner, group, mode and times; old is the lstat taken before the change."""
    tmp, _ = stage(saved, dest, old.st_uid, old.st_gid, stat.S_IMODE(old.st_mode))
    try:
        os.utime(tmp, ns=(old.st_atime_ns, old.st_mtime_ns))
        os.replace(tmp, dest)
    except BaseException:
        if os.path.lexists(tmp):
            os.unlink(tmp)
        raise
    now = os.lstat(dest)
    if (sha256_of(dest) != sha256_of(saved) or (now.st_uid, now.st_gid) != (old.st_uid, old.st_gid)
            or stat.S_IMODE(now.st_mode) != stat.S_IMODE(old.st_mode)):
        raise RuntimeError(f"{dest} does not match its backup after the restore")


def rollback(done, backup_dir):
    """Restore from the backup, newest change first. Returns True when everything was restored."""
    ok = True
    for dest, saved, old, placed in reversed(done):
        try:
            if not placed:
                say(f"  rollback: {dest} was not changed by this run; left alone")
            elif saved is None:
                if os.path.lexists(dest):  # lexists: a dangling symlink is an entry too
                    os.unlink(dest)
                if os.path.lexists(dest):
                    raise RuntimeError("the entry is still there after the removal")
                say(f"  rollback: removed {dest} (it did not exist before)")
            else:
                restore(saved, dest, old)
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
    os.makedirs(BACKUP_ROOT, mode=0o700, exist_ok=True)
    import fcntl
    lock = open(os.path.join(BACKUP_ROOT, ".lock"), "a")  # one run at a time per change: two copies must not race
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        say(f"another run of {NAME} holds {lock.name}; nothing changed")
        return 1
    plans = [(c, *plan_one(c)) for c in CHANGES]
    problems = [p for _, _, ps, _, _ in plans for p in ps]
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
    manifest = os.path.join(backup_dir, "MANIFEST.txt")  # which backup belongs to which file, and what this run created

    def note(text):
        with open(manifest, "a") as m:
            m.write(text + "\n")

    note(f"{NAME}, run {stamp}")
    done = []  # (dest, backup path or None when the file did not exist, fstat of the old file or None, placed)
    try:
        for i, (change, action, _, digest, snap) in enumerate(plans):
            dest = change["dest"]
            if action == "keep":
                say(f"  keep     {dest} (already as wanted)")
                note(f"{dest} was already as wanted; not touched")
                continue
            saved = old = None
            if action == "replace":
                saved = os.path.join(backup_dir, f"{i:02d}-{os.path.basename(dest)}")
                old = backup(dest, saved, snap)
                note(f"{os.path.basename(saved)} is the old {dest} (uid {old.st_uid}, gid {old.st_gid}, mode {stat.S_IMODE(old.st_mode):o})")
            else:
                note(f"{dest} is new: created by this run, no previous file")
            placed = []  # becomes [True] when this run put its file at dest; a rollback touches only such files
            done.append((dest, saved, old, placed))
            install(change, source_path(change), digest, snap, placed)
            say(f"  {action:8} {dest}")
        run_commands(AFTER_APPLY_COMMANDS, "after apply")
        for change, _, _, digest, _ in plans:
            verify(change, digest)
        run_commands(VERIFY_COMMANDS, "verify")
    except (Exception, KeyboardInterrupt) as e:  # Ctrl-C during a command must roll back too
        say(f"FAILED: {str(e) or type(e).__name__}")
        say("rolling back from the backup")
        return 1 if rollback([(d, sv, o, bool(pl)) for d, sv, o, pl in done], backup_dir) else 3
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
