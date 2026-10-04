#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api_sidecar;
mod commands;
mod compute_probe;
mod provenance;
mod recent_index;
mod workspace_commands;

use api_sidecar::ApiSidecar;
use commands::AppConfig;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use workspace_commands::WorkspaceHost;

fn main() {
    let launch_intent =
        std::env::var("FULLMAG_LAUNCH_INTENT").unwrap_or_else(|_| "hub".to_string());

    // If FULLMAG_UI_URL is set, use it directly (managed by fullmag CLI).
    // Otherwise, start fullmag-api as a sidecar and serve the web UI from it.
    let external_url = std::env::var("FULLMAG_UI_URL").ok();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(move |app| {
            app.manage(WorkspaceHost::default());
            let (url, sidecar) = if let Some(ref url) = external_url {
                let api_base = std::env::var("FULLMAG_API_BASE")
                    .unwrap_or_else(|_| "http://localhost:8083".into());
                app.manage(AppConfig {
                    api_base,
                    ui_url: url.clone(),
                    launch_intent: launch_intent.clone(),
                });
                (url.clone(), None)
            } else {
                let sidecar =
                    ApiSidecar::start().map_err(|e| Box::<dyn std::error::Error>::from(e))?;
                let base = sidecar.base_url();
                let ui_url = sidecar.ui_url();
                app.manage(AppConfig {
                    api_base: base.clone(),
                    ui_url: ui_url.clone(),
                    launch_intent: launch_intent.clone(),
                });
                (ui_url, Some(sidecar))
            };

            let parsed_url: url::Url = url.parse().map_err(|error| {
                Box::<dyn std::error::Error>::from(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("invalid UI URL: {error}"),
                ))
            })?;

            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed_url))
                .title("Fullmag")
                .inner_size(1400.0, 900.0)
                .min_inner_size(800.0, 600.0)
                .center()
                .build()?;

            if let Some(mut sidecar) = sidecar {
                sidecar.start_runtime_attach();
                app.manage(sidecar);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_file_dialog,
            commands::open_project_dialog,
            commands::open_project_archive_dialog,
            commands::pick_output_directory,
            commands::open_project_path,
            commands::open_project_archive_path,
            commands::app_build_info,
            commands::author_identity,
            commands::compute_probe,
            commands::project_provenance_read,
            commands::project_record_outcome,
            commands::recent_index_read,
            commands::recent_index_rebuild,
            commands::recent_index_pin,
            commands::recent_index_forget,
            commands::save_project_archive,
            commands::reveal_in_file_manager,
            commands::get_app_config,
            workspace_commands::workspace_list,
            workspace_commands::workspace_pin,
            workspace_commands::workspace_forget,
            workspace_commands::workspace_history,
            workspace_commands::workspace_open_script_dialog,
            workspace_commands::workspace_open_script,
            workspace_commands::workspace_reveal,
            workspace_commands::workspace_read_script_text,
        ])
        .run(tauri::generate_context!())
        .expect("error while running fullmag-ui");
}
