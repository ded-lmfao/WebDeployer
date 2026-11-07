fn main() {
    // Invalidate build cache whenever public files change
    println!("cargo:rerun-if-changed=public");
    println!("cargo:rerun-if-changed=build.rs");
    if let Ok(entries) = std::fs::read_dir("public") {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                println!("cargo:rerun-if-changed={}", path.display());
            }
        }
    }
}

