fn main() {
    // Package the website's actual first-paint design so slow/offline networks
    // don't create another product splash or leave the window blank.
    let source = "../../../index.html";
    let icon = "../../../public/agent-mark-144.webp";
    println!("cargo:rerun-if-changed={source}");
    println!("cargo:rerun-if-changed={icon}");
    let html = std::fs::read_to_string(source).expect("read website boot template");
    let css = html
        .split_once("<style>")
        .and_then(|(_, tail)| tail.split_once("</style>"))
        .map(|(styles, _)| styles)
        .expect("website boot stylesheet");
    assert!(
        css.contains("__BOOT_MARK_IMAGE__"),
        "website boot image missing"
    );
    std::fs::write(
        "../shell-ui/boot.css",
        css.replace("__BOOT_MARK_IMAGE__", "boot-mark.webp"),
    )
    .expect("pack website boot stylesheet");
    std::fs::copy(icon, "../shell-ui/boot-mark.webp").expect("pack website boot icon");
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_get_info",
            "desktop_report_state",
            "desktop_settings_action",
            "desktop_caption",
        ]),
    ))
    .expect("failed to build explicit desktop permissions");
}
