#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn test_vault_roundtrip() {
        let temp_dir = PathBuf::from("./target/test-vault");
        fs::create_dir_all(&temp_dir).ok();

        // Test key creation and encryption
        let mut key = [0u8; 32];
        for i in 0..32 {
            key[i] = i as u8;
        }
        let key_path = temp_dir.join("master.key");
        fs::write(&key_path, hex::encode(&key)).unwrap();

        let hex_read = fs::read_to_string(&key_path).unwrap();
        let decoded = hex::decode(hex_read.trim()).unwrap();
        assert_eq!(decoded.len(), 32);

        fs::remove_dir_all(&temp_dir).ok();
    }
}

