import fcntl
import multiprocessing
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from docker_isolated_sqlite_snapshot import hold_workspace_database, validate_copied_workspace


def try_writer(path, output):
    try:
        connection = sqlite3.connect(path, timeout=0)
        connection.execute('INSERT INTO sample VALUES (2)')
        connection.commit()
        output.put('written')
    except sqlite3.OperationalError:
        output.put('blocked')


class SQLiteSnapshotTests(unittest.TestCase):
    def test_source_remains_unchanged_and_other_process_writer_is_fenced(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            db = root / 'workspace.db'
            with sqlite3.connect(db) as c:
                c.execute('CREATE TABLE sample (value INTEGER)')
                c.execute('INSERT INTO sample VALUES (1)')
            before = db.read_bytes()
            with hold_workspace_database(root):
                # Closing an unrelated FD must not drop the OFD locks.
                db.read_bytes()
                output = multiprocessing.Queue()
                process = multiprocessing.Process(target=try_writer, args=(str(db), output))
                process.start(); process.join(5)
                self.assertEqual(process.exitcode, 0)
                self.assertEqual(output.get(timeout=1), 'blocked')
            self.assertEqual(db.read_bytes(), before)

    def test_closed_wal_database_without_shm_blocks_a_first_writer(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); db=root/'workspace.db'
            connection=sqlite3.connect(db)
            connection.execute('PRAGMA journal_mode=WAL')
            connection.execute('CREATE TABLE sample (value)')
            connection.commit(); connection.close()
            self.assertFalse((root/'workspace.db-shm').exists())
            before=db.read_bytes()
            with hold_workspace_database(root):
                output=multiprocessing.Queue()
                process=multiprocessing.Process(target=try_writer,args=(str(db),output))
                process.start(); process.join(5)
                self.assertEqual(process.exitcode,0)
                self.assertEqual(output.get(timeout=1),'blocked')
            self.assertEqual(db.read_bytes(),before)
            self.assertFalse((root/'workspace.db-wal').exists())
            self.assertFalse((root/'workspace.db-shm').exists())

    def test_rejects_source_symlink(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); (root/'target').write_bytes(b'SQLite format 3\0')
            (root/'workspace.db').symlink_to(root/'target')
            with self.assertRaises(ValueError):
                with hold_workspace_database(root): pass

    def test_bad_copy_database_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); (root/'workspace.db').write_bytes(b'corrupt')
            with self.assertRaises(sqlite3.DatabaseError): validate_copied_workspace(root)

    def test_copy_validates_without_touching_source(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            with sqlite3.connect(root/'workspace.db') as c: c.execute('CREATE TABLE sample (value)')
            self.assertEqual(validate_copied_workspace(root)['quick_check'], 'ok')

if __name__ == '__main__': unittest.main()
