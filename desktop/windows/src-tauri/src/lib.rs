mod navigation;
mod update;
mod window;
#[cfg(windows)]
mod windows_webview;

use navigation::{is_app_url, is_fallback_url, APP_ORIGIN};
use std::{sync::Mutex, time::Duration};
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::{StateFlags, WindowExt};

#[tauri::command]
fn desktop_get_info(window: tauri::WebviewWindow) -> Result<serde_json::Value, String> {
    authorize(&window)?;
    Ok(
        serde_json::json!({"version": env!("CARGO_PKG_VERSION"), "saveHandshake": 1, "settingsActions": 1, "windowCaption": 1}),
    )
}

#[derive(Debug, PartialEq)]
enum SettingsAction {
    Update,
    Browser,
}

fn settings_action(value: &str) -> Result<SettingsAction, String> {
    match value {
        "update" => Ok(SettingsAction::Update),
        "browser" => Ok(SettingsAction::Browser),
        _ => Err("Unsupported desktop settings action".into()),
    }
}

#[tauri::command]
fn desktop_settings_action(window: tauri::WebviewWindow, action: String) -> Result<(), String> {
    authorize(&window)?;
    match settings_action(&action)? {
        SettingsAction::Update => update::check(window.app_handle(), true),
        SettingsAction::Browser => {
            window
                .app_handle()
                .opener()
                .open_url(APP_ORIGIN, None::<&str>)
                .map_err(|_| "Unable to open official website")?;
        }
    }
    Ok(())
}

fn authorize(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" || !window.url().is_ok_and(|url| is_app_url(&url)) {
        return Err("Desktop capability unavailable".into());
    }
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
enum CaptionAction {
    Attach,
    System,
    State,
    Drag,
    Minimize,
    ToggleMaximize,
    Close,
}

#[derive(serde::Serialize)]
struct CaptionState {
    decorated: bool,
    maximized: bool,
    fullscreen: bool,
}

#[derive(Default)]
struct CaptionLoad {
    generation: u64,
    claimed: bool,
}

impl CaptionLoad {
    fn start(&mut self) {
        self.generation += 1;
        self.claimed = false;
    }

    fn awaiting_claim(&self) -> Option<u64> {
        (!self.claimed).then_some(self.generation)
    }
}

fn on_caption_page_load(window: tauri::WebviewWindow, payload: PageLoadPayload<'_>) {
    let state = window.state::<Mutex<CaptionLoad>>();
    match payload.event() {
        PageLoadEvent::Started => {
            // WebView2 can still be displaying the previous document at ContentLoading.
            state.lock().unwrap().start();
        }
        PageLoadEvent::Finished if is_fallback_url(payload.url()) => {
            let _ = window.set_decorations(true);
        }
        PageLoadEvent::Finished => {
            let Some(generation) = state.lock().unwrap().awaiting_claim() else {
                return;
            };
            if !matches!(window.is_decorated(), Ok(false)) {
                return;
            }
            let window = window.clone();
            tauri::async_runtime::spawn(async move {
                // Older pages and failed loads still need working system controls.
                tokio::time::sleep(Duration::from_secs(2)).await;
                let restore = window.clone();
                let _ = window.run_on_main_thread(move || {
                    let state = restore.state::<Mutex<CaptionLoad>>();
                    if state.lock().unwrap().awaiting_claim() == Some(generation) {
                        let _ = restore.set_decorations(true);
                    }
                });
            });
        }
    }
}

#[tauri::command]
fn desktop_caption(
    window: tauri::WebviewWindow,
    action: CaptionAction,
) -> Result<CaptionState, String> {
    authorize(&window)?;
    let apply = || -> tauri::Result<CaptionState> {
        match action {
            CaptionAction::Attach | CaptionAction::System => {
                window.set_decorations(matches!(action, CaptionAction::System))?;
                window.state::<Mutex<CaptionLoad>>().lock().unwrap().claimed = true;
            }
            CaptionAction::State => (),
            CaptionAction::Drag => window.start_dragging()?,
            CaptionAction::Minimize => window.minimize()?,
            CaptionAction::ToggleMaximize if window.is_maximized()? => window.unmaximize()?,
            CaptionAction::ToggleMaximize => window.maximize()?,
            CaptionAction::Close => window::request_close(&window),
        }
        Ok(CaptionState {
            decorated: window.is_decorated()?,
            maximized: window.is_maximized()?,
            fullscreen: window.is_fullscreen()?,
        })
    };
    apply().map_err(|_| "Window control unavailable".into())
}

#[tauri::command]
fn desktop_report_state(
    window: tauri::WebviewWindow,
    report: window::SaveReport,
) -> Result<(), String> {
    authorize(&window)?;
    window::acknowledge(&window, report)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::POSITION | StateFlags::SIZE | StateFlags::MAXIMIZED)
                .skip_initial_state("main")
                .build(),
        )
        // WebView2 routes user-initiated popups. The plugin's click interceptor
        // would consume target=_blank and invoke an IPC unavailable to remote pages.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(window::CloseState::default())
        .manage(update::UpdateState::default())
        .manage(Mutex::new(CaptionLoad::default()))
        .invoke_handler(tauri::generate_handler![
            desktop_get_info,
            desktop_report_state,
            desktop_settings_action,
            desktop_caption
        ])
        .setup(|app| {
            let data = app.path().app_local_data_dir()?.join("WebView2");
            std::fs::create_dir_all(&data)?;
            // Load only the packaged page until native policies and the real-engine UA are installed.
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title(
                        app.config()
                            .product_name
                            .clone()
                            .unwrap_or_else(|| "Chevoink".into()),
                    )
                    .inner_size(1280.0, 800.0)
                    .visible(false)
                    .background_color(tauri::window::Color(31, 32, 35, 255))
                    .min_inner_size(640.0, 480.0)
                    .data_directory(data)
                    .disable_drag_drop_handler()
                    .initialization_script(include_str!("browser-links.js"))
                    .on_page_load(on_caption_page_load)
                    .on_navigation(|url| is_app_url(url) || is_fallback_url(url))
                    .build()?;
            // Restore only the normal bounds before maximizing on their monitor.
            // A stale/minimized/fullscreen session must never hide the taskbar.
            let _ = window.restore_state(StateFlags::POSITION | StateFlags::SIZE);
            #[cfg(windows)]
            windows_webview::style_system_caption(&window);
            window::install(&window)?;
            window.maximize()?;
            window.show()?;
            #[cfg(windows)]
            windows_webview::install(&window)?;
            update::schedule_check(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .unwrap_or_else(|error| {
            eprintln!("Chevoink startup failed: {error}");
            rfd::MessageDialog::new()
                .set_title("Chevoink 启动失败")
                .set_description(format!(
                    "客户端初始化未完成，未启动创作任务。\n请保留以下错误用于排查：\n{error}"
                ))
                .show();
        });
}

#[cfg(test)]
mod startup_tests {
    #[test]
    fn only_the_current_unclaimed_page_can_restore_the_system_caption() {
        let mut load = super::CaptionLoad::default();
        load.start();
        let displaced = load.awaiting_claim();
        load.start();
        assert_ne!(load.awaiting_claim(), displaced);

        let current = load.awaiting_claim();
        assert!(current.is_some());
        load.claimed = true;
        assert_eq!(load.awaiting_claim(), None);
    }

    #[test]
    fn settings_actions_are_a_closed_whitelist() {
        use super::{settings_action, SettingsAction};
        assert_eq!(settings_action("browser").unwrap(), SettingsAction::Browser);
        assert_eq!(settings_action("update").unwrap(), SettingsAction::Update);
        for value in [
            "https://example.com",
            "file:///C:/",
            "cmd.exe",
            "browser;shutdown",
            "",
            "UPDATE",
        ] {
            assert!(settings_action(value).is_err());
        }
    }

    #[test]
    fn packaged_updater_configuration_can_initialize_without_a_signing_key() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater: tauri_plugin_updater::Config =
            serde_json::from_value(config["plugins"]["updater"].clone()).unwrap();
        assert!(updater.pubkey.is_empty());
        assert!(updater.endpoints.is_empty());
        assert!(!updater.dangerous_insecure_transport_protocol);
        assert!(!updater.dangerous_accept_invalid_certs);
        assert!(!updater.dangerous_accept_invalid_hostnames);
    }
}
