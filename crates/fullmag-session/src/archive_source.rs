//! Seekable ZIP input window with bounded metadata reads.

use std::io::{self, Read, Seek, SeekFrom};

use anyhow::{bail, Context, Result};

pub(crate) struct ArchiveSource<R> {
    reader: R,
    start: u64,
    length: u64,
    position: u64,
}

impl<R: Read + Seek> ArchiveSource<R> {
    pub fn new(mut reader: R) -> Result<Self> {
        let start = reader.stream_position()?;
        let end = reader.seek(SeekFrom::End(0))?;
        let length = end
            .checked_sub(start)
            .context("archive input starts beyond EOF")?;
        reader.seek(SeekFrom::Start(start))?;
        Ok(Self {
            reader,
            start,
            length,
            position: 0,
        })
    }

    pub fn len(&self) -> u64 {
        self.length
    }

    pub fn read_at(&mut self, offset: u64, length: usize) -> Result<Vec<u8>> {
        // Central entry name, extra and comment lengths are each u16.
        // EOCD tail is also smaller than this bound.
        const MAX_METADATA_READ: usize = 3 * u16::MAX as usize;
        if length > MAX_METADATA_READ {
            bail!("ZIP metadata read exceeds record budget");
        }
        if offset
            .checked_add(length as u64)
            .is_none_or(|end| end > self.length)
        {
            bail!("truncated ZIP metadata record");
        }
        self.seek(SeekFrom::Start(offset))?;
        let mut data = vec![0; length];
        self.read_exact(&mut data)?;
        Ok(data)
    }
}

impl<R: Read + Seek> Read for ArchiveSource<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let available = (self.length - self.position).min(buffer.len() as u64) as usize;
        let count = self.reader.read(&mut buffer[..available])?;
        self.position += count as u64;
        Ok(count)
    }
}

impl<R: Read + Seek> Seek for ArchiveSource<R> {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let position = match from {
            SeekFrom::Start(offset) => i128::from(offset),
            SeekFrom::End(offset) => i128::from(self.length) + i128::from(offset),
            SeekFrom::Current(offset) => i128::from(self.position) + i128::from(offset),
        };
        if !(0..=i128::from(self.length)).contains(&position) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "seek outside archive input",
            ));
        }
        let position = position as u64;
        self.reader.seek(SeekFrom::Start(self.start + position))?;
        self.position = position;
        Ok(position)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn source_window_preserves_start_and_checks_all_seek_origins() {
        let mut input = Cursor::new(b"prefixZIP".to_vec());
        input.set_position(6);
        let mut source = ArchiveSource::new(input).unwrap();
        assert_eq!(source.len(), 3);
        assert_eq!(source.read_at(0, 3).unwrap(), b"ZIP");
        assert_eq!(source.seek(SeekFrom::End(-2)).unwrap(), 1);
        assert_eq!(source.seek(SeekFrom::Current(1)).unwrap(), 2);
        assert!(source.seek(SeekFrom::Current(-3)).is_err());
        assert!(source.seek(SeekFrom::Start(4)).is_err());
        assert!(source.read_at(u64::MAX, 4).is_err());
        assert!(source.read_at(0, 3 * u16::MAX as usize + 1).is_err());
        assert_eq!(source.read_at(2, 1).unwrap(), b"P");
    }
}
