use std::time::Duration;

use crate::projects::Project;
use super::Runtime;

impl Runtime {

    pub fn stop_maintenance_server(&self, project_id: i64) {
        if let Ok(mut map) = self.maintenance_shutdowns.lock() {
            if let Some(tx) = map.remove(&project_id) {
                let _ = tx.send(());
            }
        }
    }

    pub fn render_maintenance_html(name: &str, slug: &str, status_text: &str) -> String {
        let safe_name = name
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        let safe_slug = slug
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        let safe_status = status_text
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");

        format!(
            r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{safe_name} — Under Maintenance</title>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{
    min-height: 100vh;
    background: #070b14;
    background-image:
      radial-gradient(circle at 50% 0%, rgba(37, 99, 235, 0.14), transparent 55%),
      radial-gradient(circle at 85% 85%, rgba(245, 158, 11, 0.08), transparent 45%);
    color: #f1f5f9;
    font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }}
  .card {{
    width: 100%;
    max-width: 560px;
    background: #0d1527;
    border: 1px solid #1a2744;
    border-radius: 8px;
    padding: 38px 34px 30px;
    box-shadow: 0 24px 60px rgba(2, 6, 18, 0.78);
    position: relative;
    overflow: hidden;
  }}
  .top-bar {{
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 3px;
    background: linear-gradient(90deg, #2563eb, #f59e0b, #3b82f6);
    background-size: 200% 100%;
    animation: slideBar 3.2s linear infinite;
  }}
  @keyframes slideBar {{
    0% {{ background-position: 0% 0%; }}
    100% {{ background-position: 200% 0%; }}
  }}
  .badge {{
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 5px 12px;
    background: rgba(245, 158, 11, 0.12);
    border: 1px solid rgba(245, 158, 11, 0.32);
    border-radius: 6px;
    color: #fbbf24;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    margin-bottom: 20px;
  }}
  .dot {{
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #f59e0b;
    box-shadow: 0 0 10px #f59e0b;
    animation: pulse 1.8s ease-in-out infinite;
  }}
  @keyframes pulse {{
    0%, 100% {{ opacity: 1; transform: scale(1); }}
    50% {{ opacity: 0.45; transform: scale(0.88); }}
  }}
  .icon-box {{
    width: 48px;
    height: 48px;
    border-radius: 8px;
    background: #111d35;
    border: 1px solid #1e3158;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #60a5fa;
    margin-bottom: 18px;
  }}
  h1 {{
    font-size: 24px;
    font-weight: 700;
    color: #f8fafc;
    letter-spacing: -0.02em;
    margin-bottom: 10px;
  }}
  .subtitle {{
    font-size: 14.5px;
    line-height: 1.65;
    color: #94a3b8;
    margin-bottom: 24px;
  }}
  .info-panel {{
    background: #080e1c;
    border: 1px solid #17233d;
    border-radius: 6px;
    padding: 14px 16px;
    margin-bottom: 22px;
  }}
  .info-row {{
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 12.5px;
    padding: 5px 0;
  }}
  .info-row + .info-row {{
    border-top: 1px solid rgba(255, 255, 255, 0.05);
    margin-top: 5px;
    padding-top: 10px;
  }}
  .info-label {{ color: #64748b; font-weight: 500; }}
  .info-val {{ color: #e2e8f0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }}
  .footer {{
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-top: 16px;
    border-top: 1px solid #16223b;
    font-size: 12px;
    color: #64748b;
  }}
  .btn {{
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    background: #162442;
    hover: #1e3158;
    border: 1px solid #263b66;
    border-radius: 6px;
    color: #e2e8f0;
    font-size: 12px;
    font-weight: 600;
    text-decoration: none;
    cursor: pointer;
    transition: all 0.15s ease;
  }}
  .btn:hover {{
    background: #1f335c;
    border-color: #3b82f6;
    color: #ffffff;
  }}
</style>
</head>
<body>
  <div class="card">
    <div class="top-bar"></div>
    <div class="badge"><span class="dot"></span> {safe_status}</div>
    <div class="icon-box">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
      </svg>
    </div>
    <h1>{safe_name} is Under Maintenance</h1>
    <p class="subtitle">
      Our developers and engineering team are currently working on updates, scheduled maintenance, or system improvements for this website. It will be back online shortly.
    </p>
    <div class="info-panel">
      <div class="info-row">
        <span class="info-label">Service</span>
        <span class="info-val">{safe_name} ({safe_slug})</span>
      </div>
      <div class="info-row">
        <span class="info-label">Status</span>
        <span class="info-val" style="color:#fbbf24;">Developers Working &bull; Maintenance Mode</span>
      </div>
      <div class="info-row">
        <span class="info-label">Auto-Retry</span>
        <span class="info-val" id="retry-status">Every 30 seconds</span>
      </div>
    </div>
    <div class="footer">
      <span>Managed by WebDep Deployment Platform</span>
      <button class="btn" id="check-btn" onclick="checkBackendReady(true)">Check Again</button>
    </div>
  </div>
  <script>
    async function checkBackendReady(manual) {{
      const btn = document.getElementById('check-btn');
      if (manual && btn) {{
        btn.disabled = true;
        btn.textContent = 'Checking...';
      }}
      try {{
        const res = await fetch(window.location.href, {{
          method: 'GET',
          cache: 'no-store',
          headers: {{ 'X-Maintenance-Probe': '1' }}
        }});
        const isMaint = res.status === 503 || res.headers.get('x-webdep-maintenance') === '1';
        if (res.ok && !isMaint) {{
          window.location.reload();
          return;
        }}
      }} catch (_) {{
        // Backend not reachable yet — keep maintenance page as is
      }}
      if (manual && btn) {{
        btn.disabled = false;
        btn.textContent = 'Check Again';
      }}
    }}
    setInterval(() => checkBackendReady(false), 30000);
  </script>
</body>
</html>"#
        )
    }

    pub fn start_maintenance_server(
        &self,
        project_id: i64,
        name: &str,
        slug: &str,
        port: u16,
        status_text: &str,
    ) {
        self.stop_maintenance_server(project_id);

        let (tx, mut rx) = tokio::sync::oneshot::channel::<()>();
        if let Ok(mut map) = self.maintenance_shutdowns.lock() {
            map.insert(project_id, tx);
        }

        let html = Self::render_maintenance_html(name, slug, status_text);
        let response_bytes = format!(
            "HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/html; charset=utf-8\r\nX-WebDep-Maintenance: 1\r\nCache-Control: no-store, no-cache, must-revalidate\r\nRetry-After: 30\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            html.len(),
            html
        )
        .into_bytes();

        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};

            let mut listener_opt = None;
            for _ in 0..8 {
                if let Ok(l) = tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
                    listener_opt = Some(l);
                    break;
                }
                if let Ok(l) = tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
                    listener_opt = Some(l);
                    break;
                }
                tokio::select! {
                    _ = &mut rx => return,
                    _ = tokio::time::sleep(Duration::from_millis(120)) => {}
                }
            }

            let listener = match listener_opt {
                Some(l) => l,
                None => return,
            };

            loop {
                tokio::select! {
                    _ = &mut rx => {
                        break;
                    }
                    accept_res = listener.accept() => {
                        if let Ok((mut stream, _)) = accept_res {
                            let resp = response_bytes.clone();
                            tokio::spawn(async move {
                                let mut buf = [0u8; 1024];
                                let _ = tokio::time::timeout(Duration::from_millis(250), stream.read(&mut buf)).await;
                                let _ = stream.write_all(&resp).await;
                                let _ = stream.shutdown().await;
                            });
                        }
                    }
                }
            }
        });
    }



    pub async fn set_maintenance_mode(&self, p: &Project, enabled: bool) -> Result<(), String> {
        if enabled {
            self.bump_stop_seq(p.id);
            {
                let conn = self.db.lock().unwrap();
                conn.execute(
                    "UPDATE projects SET app_status='maintenance', app_pid=NULL, app_started_at=NULL WHERE id=?",
                    rusqlite::params![p.id],
                )
                .ok();
            }

            let proj_lock = self.get_project_lock(p.id);
            let _guard = proj_lock.lock().await;
            self.kill_project_everything(p).await;

            {
                let conn = self.db.lock().unwrap();
                conn.execute(
                    "UPDATE projects SET app_status='maintenance', app_pid=NULL, app_started_at=NULL WHERE id=?",
                    rusqlite::params![p.id],
                )
                .ok();
            }

            if let Some(port) = p.port {
                self.start_maintenance_server(
                    p.id,
                    &p.name,
                    &p.slug,
                    port,
                    "Scheduled Maintenance • Developers Working",
                );
            }

            self.logs.add(
                Some(p.id),
                None,
                "system",
                "info",
                &format!(
                    "Enabled Maintenance Mode for '{}' (Port {} serving Maintenance Page)",
                    p.name,
                    p.port.unwrap_or(3000)
                ),
            );
        } else {
            self.stop_maintenance_server(p.id);
        }
        Ok(())
    }

}
