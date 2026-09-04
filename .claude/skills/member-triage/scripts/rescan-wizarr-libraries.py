"""Rescan one Plex server's libraries into Wizarr's cache, from inside the container.

Wizarr shares by library NAME from its own `library` table, and only refreshes
that table when someone presses "Scan libraries". Its scan routes are
session-only (no API-key equivalent), so this mirrors the upsert in
app/blueprints/media_servers/routes.py (scan_server_libraries) for one server:
existing rows are renamed in place by Plex section id (their primary key is
kept, so pending invites are repaired without a reissue), new sections are
inserted, vanished ones are disabled when an invite still references them and
deleted otherwise. A failed scan changes nothing.

It writes to Wizarr's database: snapshot first with the nas-state-backup skill.

Run from the repo root, as the user gunicorn runs as, with the app on the path:

    scp .claude/skills/member-triage/scripts/rescan-wizarr-libraries.py crivas@192.168.50.2:/tmp/
    ssh crivas@192.168.50.2 '
      D=/usr/local/bin/docker
      U=$(sudo -n $D exec wizarr awk "/^Uid:/{print \\$2}" /proc/1/status)
      G=$(sudo -n $D exec wizarr awk "/^Gid:/{print \\$2}" /proc/1/status)
      sudo -n $D cp /tmp/rescan-wizarr-libraries.py wizarr:/tmp/
      sudo -n $D exec -u $U:$G -w /app -e PYTHONPATH=/app -e FLASK_SKIP_SCHEDULER=true \\
        wizarr /app/.venv/bin/python /tmp/rescan-wizarr-libraries.py Meleys
      sudo -n $D exec wizarr rm -f /tmp/rescan-wizarr-libraries.py'

FLASK_SKIP_SCHEDULER stops create_app() starting Wizarr's background jobs in
this second process. Confirm afterwards with GET /api/libraries.
"""

import logging
import sys

logging.basicConfig(level=logging.WARNING)

from app import create_app  # noqa: E402
from app.extensions import db  # noqa: E402
from app.models import Library, MediaServer, invite_libraries  # noqa: E402
from app.services.media.service import scan_libraries_for_server  # noqa: E402

target = sys.argv[1] if len(sys.argv) > 1 else "Meleys"
app = create_app()
with app.app_context():
    server = MediaServer.query.filter_by(name=target).first()
    if not server:
        print(f"no media_server named {target!r}")
        raise SystemExit(2)
    print(f"server {server.id} {server.name} {server.url}")
    try:
        raw = scan_libraries_for_server(server)
    except Exception as exc:
        print(f"SCAN FAILED, nothing changed: {exc!r}")
        raise SystemExit(1)
    items = list(raw.items()) if isinstance(raw, dict) else [(name, name) for name in raw]
    print(f"scan returned {len(items)} sections")
    existing = {lib.external_id: lib for lib in Library.query.filter_by(server_id=server.id).all()}
    incoming = set()
    for fid, name in items:
        fid = str(fid)
        incoming.add(fid)
        if fid in existing:
            lib = existing[fid]
            if lib.name != name or not lib.enabled:
                print(f"  UPDATE id={lib.id} {lib.name!r} enabled={lib.enabled} -> {name!r} enabled=True")
            lib.name = name
            lib.enabled = True
        else:
            print(f"  INSERT {name!r} external={fid}")
            db.session.add(Library(external_id=fid, name=name, server_id=server.id, enabled=True))
    for ext, lib in existing.items():
        if str(ext) not in incoming:
            referenced = db.session.execute(
                invite_libraries.select().where(invite_libraries.c.library_id == lib.id)
            ).first()
            if referenced:
                print(f"  DISABLE id={lib.id} {lib.name!r} (gone from Plex, still referenced by invites)")
                lib.enabled = False
            else:
                print(f"  DELETE id={lib.id} {lib.name!r} (gone from Plex, unreferenced)")
                db.session.delete(lib)
    db.session.commit()
    print("committed; after:")
    for lib in Library.query.filter_by(server_id=server.id).order_by(Library.name).all():
        print(f"  {lib.id} {lib.external_id} {lib.name!r} enabled={lib.enabled}")
