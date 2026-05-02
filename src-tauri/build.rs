fn main() {
    tauri_build::build();

    // ── macOS-only: link & bundle Syphon.framework ───────────────────────
    // Syphon is the standard macOS shared-texture protocol used by ProPresenter,
    // OBS (via plugin), Resolume, MadMapper, etc. We bundle the framework into
    // the .app's Contents/Frameworks dir (Tauri does that via tauri.conf.json's
    // bundle.macOS.frameworks) and tell rustc to link against it at build time.
    //
    // The @executable_path-relative rpath ensures dyld finds the framework at
    // runtime — both inside the bundled .app (where the binary lives at
    // Contents/MacOS/kairo and the framework at Contents/Frameworks/Syphon.framework)
    // and during cargo-run dev builds (where we point at the in-tree Frameworks/).
    #[cfg(target_os = "macos")]
    {
        let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        println!("cargo:rustc-link-search=framework={}/Frameworks", manifest);
        println!("cargo:rustc-link-lib=framework=Syphon");
        // Production rpath: points at the framework copied into the .app bundle.
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
        // Dev rpath: lets `cargo run` from src-tauri/ find the in-tree copy.
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}/Frameworks", manifest);
        println!("cargo:rerun-if-changed=Frameworks/Syphon.framework/Syphon");
    }
}
