"""Durable single-heavy-job scheduling, called only by a trusted coordinator.

Owner strings are not credentials. The service must authenticate callers and
validate the database storage path. Leases never expire solely because of age.
"""
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import re
import secrets
import sqlite3
import time
import uuid


class QueueError(ValueError):
    pass


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}', value):
        raise QueueError('Invalid identifier')


class JobQueue:
    def __init__(self, path: Path):
        self.path = Path(path)
        if not self.path.is_absolute() or self.path.is_symlink():
            raise QueueError('Queue path must be absolute and not a symlink')
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as db:
            version = db.execute('PRAGMA user_version').fetchone()[0]
            if version not in (0, 1):
                raise QueueError('Unsupported queue schema')
            db.execute('''CREATE TABLE IF NOT EXISTS jobs (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL,
                request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
                worktree_id TEXT NOT NULL, source_digest TEXT NOT NULL,
                profile TEXT NOT NULL, operation TEXT NOT NULL, payload TEXT NOT NULL,
                state TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL,
                coordinator TEXT, lease_token TEXT, exit_code INTEGER,
                UNIQUE(owner, request_key))''')
            db.execute('PRAGMA user_version=1')

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            yield db
        finally:
            db.close()

    @contextmanager
    def transaction(self):
        with self.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            try:
                yield db
                db.execute('COMMIT')
            except BaseException:
                db.execute('ROLLBACK')
                raise

    @staticmethod
    def record(row, private=False):
        if row is None:
            raise QueueError('Unknown job')
        result = dict(row)
        result['payload'] = json.loads(result['payload'])
        if not private:
            result.pop('lease_token', None)
        result.pop('request_hash', None)
        return result

    def submit(self, *, owner, worktree_id, source_digest, profile, operation, request_key, payload):
        for value in (owner, worktree_id, profile, operation, request_key):
            identifier(value)
        if not re.fullmatch('[a-f0-9]{64}', source_digest):
            raise QueueError('source_digest must be SHA-256')
        if not isinstance(payload, dict):
            raise QueueError('payload must be an object')
        encoded = json.dumps(payload, sort_keys=True, separators=(',', ':'), allow_nan=False)
        if len(encoded.encode('utf-8')) > 65536:
            raise QueueError('Request exceeds 64 KiB')
        identity = json.dumps([worktree_id, source_digest, profile, operation, encoded])
        request_hash = hashlib.sha256(identity.encode()).hexdigest()
        with self.transaction() as db:
            previous = db.execute('SELECT * FROM jobs WHERE owner=? AND request_key=?', (owner, request_key)).fetchone()
            if previous:
                if previous['request_hash'] != request_hash:
                    raise QueueError('Idempotency key reused for a different request')
                return self.record(previous)
            job_id, now = uuid.uuid4().hex, time.time()
            db.execute('''INSERT INTO jobs
                (job_id,owner,request_key,request_hash,worktree_id,source_digest,
                 profile,operation,payload,state,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,'queued',?,?)''',
                (job_id, owner, request_key, request_hash, worktree_id, source_digest,
                 profile, operation, encoded, now, now))
            return self.record(db.execute('SELECT * FROM jobs WHERE job_id=?', (job_id,)).fetchone())

    def get(self, job_id):
        with self.connection() as db:
            return self.record(db.execute('SELECT * FROM jobs WHERE job_id=?', (job_id,)).fetchone())

    def list(self, *, owner=None, limit=100):
        if not isinstance(limit, int) or not 1 <= limit <= 1000:
            raise QueueError('Limit must be 1..1000')
        with self.connection() as db:
            rows = db.execute('SELECT * FROM jobs WHERE (? IS NULL OR owner=?) ORDER BY sequence DESC LIMIT ?',
                              (owner, owner, limit)).fetchall()
            return [self.record(row) for row in rows]

    def claim(self, coordinator):
        identifier(coordinator)
        with self.transaction() as db:
            if db.execute("SELECT 1 FROM jobs WHERE state IN ('running','cancel_requested') LIMIT 1").fetchone():
                return None
            row = db.execute("SELECT * FROM jobs WHERE state='queued' ORDER BY sequence LIMIT 1").fetchone()
            if row is None:
                return None
            db.execute("UPDATE jobs SET state='running',coordinator=?,lease_token=?,updated_at=? WHERE job_id=?",
                       (coordinator, secrets.token_hex(32), time.time(), row['job_id']))
            return self.record(db.execute('SELECT * FROM jobs WHERE job_id=?', (row['job_id'],)).fetchone(), True)

    def cancel(self, job_id, owner):
        with self.transaction() as db:
            row = db.execute('SELECT * FROM jobs WHERE job_id=?', (job_id,)).fetchone()
            if row is None or row['owner'] != owner:
                raise QueueError('Unknown job or owner mismatch')
            states = {'queued': 'cancelled', 'running': 'cancel_requested'}
            if row['state'] in states:
                db.execute('UPDATE jobs SET state=?,updated_at=? WHERE job_id=?',
                           (states[row['state']], time.time(), job_id))

    def finish(self, job_id, lease_token, state, exit_code):
        """Caller must first confirm terminal process/container state."""
        if state not in ('succeeded', 'failed', 'cancelled', 'interrupted', 'blocked'):
            raise QueueError('Invalid terminal state')
        if state == 'succeeded' and exit_code != 0:
            raise QueueError('Successful job requires exit code zero')
        with self.transaction() as db:
            row = db.execute('SELECT * FROM jobs WHERE job_id=?', (job_id,)).fetchone()
            if row is None or row['state'] not in ('running', 'cancel_requested'):
                raise QueueError('Job is not running')
            if not secrets.compare_digest(row['lease_token'], lease_token):
                raise QueueError('Lease mismatch')
            db.execute('UPDATE jobs SET state=?,exit_code=?,updated_at=?,lease_token=NULL WHERE job_id=?',
                       (state, exit_code, time.time(), job_id))
