use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
};
use zodchi_core::util::{fail, GatewayError, Result};
use zodchi_flow_engine::video_media;

const CHUNK: usize = 8 * 1024 * 1024;
const MAX_BYTES: u64 = 256 * 1024 * 1024 * 1024;

/// Verify the whole file first, then verify each block again before sending its
/// bytes. A local edit during a long transfer cannot change the bytes sent.
pub(super) struct Artifact {
    file: File,
    pub(super) size: u64,
    blocks: Vec<[u8; 32]>,
}

impl Artifact {
    pub(super) fn open(pin: &Value) -> Result<Self> {
        let path = video_media::text(&pin["path"], "accepted MP4 path")?;
        let size = pin["bytes"]
            .as_u64()
            .filter(|n| (1..=MAX_BYTES).contains(n))
            .ok_or_else(|| {
                GatewayError("The accepted MP4 has an invalid YouTube upload size.".into())
            })?;
        let mut file = File::open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.len() != size {
            return fail("The accepted MP4 differs from the frozen publication plan.");
        }
        let mut full = Sha256::new();
        let mut blocks = Vec::new();
        let mut buffer = vec![0; size.min(CHUNK as u64) as usize];
        let mut remaining = size;
        while remaining > 0 {
            let n = remaining.min(CHUNK as u64) as usize;
            let block = &mut buffer[..n];
            file.read_exact(block)?;
            full.update(&*block);
            blocks.push(Sha256::digest(block).into());
            remaining -= n as u64;
        }
        if pin["sha256"] != format!("{:x}", full.finalize()) || file.metadata()?.len() != size {
            return fail("The accepted MP4 differs from the frozen publication plan.");
        }
        Ok(Self { file, size, blocks })
    }

    pub(super) fn chunk(&mut self, offset: u64) -> Result<Vec<u8>> {
        let end = self.size.min(offset + CHUNK as u64);
        let mut cursor = offset;
        let mut bytes = Vec::with_capacity((end - offset) as usize);
        while cursor < end {
            let start = cursor / CHUNK as u64 * CHUNK as u64;
            let length = (self.size - start).min(CHUNK as u64) as usize;
            let mut block = vec![0; length];
            self.file.seek(SeekFrom::Start(start))?;
            self.file.read_exact(&mut block)?;
            let digest: [u8; 32] = Sha256::digest(&block).into();
            if digest != self.blocks[(start / CHUNK as u64) as usize] {
                return fail("The accepted MP4 changed during the transfer.");
            }
            let stop = end.min(start + length as u64);
            bytes.extend_from_slice(&block[(cursor - start) as usize..(stop - start) as usize]);
            cursor = stop;
        }
        Ok(bytes)
    }
}
