use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rand::RngCore;
use std::fs;
use std::path::Path;

#[derive(Clone)]
pub struct Vault {
    cipher: Aes256Gcm,
}

impl Vault {
    pub fn new(data_dir: &Path) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let key_path = data_dir.join("master.key");
        let key_bytes = if key_path.exists() {
            let hex_str = fs::read_to_string(&key_path)?.trim().to_string();
            hex::decode(hex_str)?
        } else {
            let mut key = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut key);
            fs::create_dir_all(data_dir)?;
            fs::write(&key_path, hex::encode(&key))?;
            key.to_vec()
        };

        if key_bytes.len() != 32 {
            return Err("Master key must be exactly 32 bytes (256 bits)".into());
        }

        let cipher = Aes256Gcm::new_from_slice(&key_bytes)
            .map_err(|e| format!("Failed to initialize cipher: {}", e))?;

        Ok(Self { cipher })
    }

    pub fn encrypt(&self, plaintext: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let mut iv = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut iv);
        let nonce = Nonce::from_slice(&iv);

        let ciphertext_and_tag = self
            .cipher
            .encrypt(nonce, plaintext.as_bytes())
            .map_err(|e| format!("Encryption error: {}", e))?;

        let mut payload = Vec::with_capacity(12 + ciphertext_and_tag.len());
        payload.extend_from_slice(&iv);
        payload.extend_from_slice(&ciphertext_and_tag);

        Ok(BASE64.encode(payload))
    }

    pub fn decrypt(&self, encrypted_b64: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let payload = BASE64.decode(encrypted_b64.trim())?;
        if payload.len() < 28 {
            return Err("Encrypted payload too short (must contain 12-byte IV + 16-byte tag)".into());
        }

        let (iv, ciphertext_and_tag) = payload.split_at(12);
        let nonce = Nonce::from_slice(iv);

        let plaintext = self
            .cipher
            .decrypt(nonce, ciphertext_and_tag)
            .map_err(|e| format!("Decryption authentication failed: {}", e))?;

        Ok(String::from_utf8(plaintext)?)
    }
}

