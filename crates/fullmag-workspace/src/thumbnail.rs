//! Small PNG previews of projects (schema version 2).
//!
//! Previews live in their own table, not in `items.meta`, so that listing
//! items never drags image bytes along. The digest is supplied by the caller
//! (the crate carries no hashing dependency) and only decides whether a stored
//! preview is already current.

use rusqlite::{params, OptionalExtension};

use crate::error::{Result, WorkspaceError};
use crate::store::Workspace;
use crate::types::ItemRef;

/// Largest preview that is stored; a larger one is refused, never truncated.
pub const MAX_THUMBNAIL_BYTES: usize = 256 * 1024;

pub const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// A stored preview.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Thumbnail {
    /// Lower-case hex SHA-256 of `png`, as given when it was stored.
    pub sha256: String,
    pub png: Vec<u8>,
}

impl Workspace {
    /// Store the preview of an item, replacing an earlier one. `png` must carry
    /// the PNG signature and stay within [`MAX_THUMBNAIL_BYTES`]; `sha256` is
    /// its 64-digit hex digest. An unchanged digest leaves the row untouched.
    pub fn set_thumbnail<'a>(
        &self,
        item: impl Into<ItemRef<'a>>,
        sha256: &str,
        png: &[u8],
    ) -> Result<()> {
        if png.len() > MAX_THUMBNAIL_BYTES {
            return Err(WorkspaceError::Invalid(format!(
                "thumbnail exceeds {MAX_THUMBNAIL_BYTES} bytes"
            )));
        }
        if !png.starts_with(&PNG_SIGNATURE) {
            return Err(WorkspaceError::Invalid("thumbnail is not a PNG".into()));
        }
        if sha256.len() != 64 || !sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(WorkspaceError::Invalid(
                "thumbnail digest must be 64 hex digits".into(),
            ));
        }
        let digest = sha256.to_ascii_lowercase();
        let (found, _) = self.require(item.into())?;
        self.with_write_txn(|c| {
            c.execute(
                "INSERT INTO thumbnails (item_id, sha256, png) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(item_id) DO UPDATE SET sha256 = excluded.sha256, \
                 png = excluded.png WHERE thumbnails.sha256 != excluded.sha256",
                params![found.id, digest, png],
            )?;
            Ok(())
        })
    }

    /// The preview of an item, or `None` when it has none (or does not exist).
    pub fn get_thumbnail<'a>(&self, item: impl Into<ItemRef<'a>>) -> Result<Option<Thumbnail>> {
        let Some(found) = self.find(item)? else {
            return Ok(None);
        };
        Ok(self
            .conn
            .query_row(
                "SELECT sha256, png FROM thumbnails WHERE item_id = ?1",
                [found.id],
                |row| {
                    Ok(Thumbnail {
                        sha256: row.get(0)?,
                        png: row.get(1)?,
                    })
                },
            )
            .optional()?)
    }

    /// Drop the preview of an item; a no-op when there is none.
    pub fn remove_thumbnail<'a>(&self, item: impl Into<ItemRef<'a>>) -> Result<()> {
        let (found, _) = self.require(item.into())?;
        self.with_write_txn(|c| {
            c.execute("DELETE FROM thumbnails WHERE item_id = ?1", [found.id])?;
            Ok(())
        })
    }
}
