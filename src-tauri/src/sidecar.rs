use std::collections::HashMap;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};

static JOBS: OnceLock<Mutex<HashMap<String, Child>>> = OnceLock::new();

fn jobs() -> &'static Mutex<HashMap<String, Child>> {
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn start(program: &str, args: &[String]) -> Result<String, String> {
    validate(program, args)?;
    let child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "sidecar_failed".to_string())?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    jobs().lock().map_err(|_| "sidecar_busy".to_string())?.insert(id.clone(), child);
    Ok(id)
}

pub fn cancel(id: &str) -> Result<(), String> {
    let mut map = jobs().lock().map_err(|_| "sidecar_busy".to_string())?;
    let mut child = map.remove(id).ok_or_else(|| "sidecar_missing".to_string())?;
    child.kill().map_err(|_| "sidecar_failed".to_string())?;
    Ok(())
}

pub fn wait(id: &str) -> Result<String, String> {
    let mut map = jobs().lock().map_err(|_| "sidecar_busy".to_string())?;
    let child = map.remove(id).ok_or_else(|| "sidecar_missing".to_string())?;
    let output = child.wait_with_output().map_err(|_| "sidecar_failed".to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let trimmed: String = stdout.chars().take(65_536).collect();
    if output.status.success() {
        return Ok(trimmed);
    }
    Err(format!("sidecar_exit:{}", output.status.code().unwrap_or(-1)))
}

fn validate(program: &str, args: &[String]) -> Result<(), String> {
    if !is_node(program) {
        return Err("bad_node".to_string());
    }
    if args.len() < 3 || args[0] != "--experimental-strip-types" || !is_scanner_cli(&args[1]) {
        return Err("bad_cli".to_string());
    }
    let command = args[2].as_str();
    if !matches!(command, "authorize" | "scan" | "review" | "edit" | "label") {
        return Err("bad_command".to_string());
    }
    for arg in args {
        let lower = arg.to_ascii_lowercase();
        if lower.contains("://") || lower.contains("twitch.tv") || arg.chars().any(|ch| matches!(ch, '\n' | '\r' | ';' | '|' | '&')) {
            return Err("remote_refused".to_string());
        }
    }
    Ok(())
}

fn is_node(program: &str) -> bool {
    if program == "node" {
        return true;
    }
    let absolute = program.starts_with('/') || (program.len() > 2 && program.as_bytes()[1] == b':');
    absolute && (program.ends_with("/node") || program.ends_with("\\node.exe") || program.ends_with("/node.exe"))
}

fn is_scanner_cli(path: &str) -> bool {
    let absolute = path.starts_with('/') || (path.len() > 2 && path.as_bytes()[1] == b':');
    absolute && path.replace('\\', "/").ends_with("services/tippy-vod-scanner/src/cli.ts")
}

#[cfg(test)]
mod tests {
    use super::validate;

    #[test]
    fn refuses_a_shell_a_relative_cli_and_a_remote_argument() {
        let cli = "C:/src/streamerstipReact/services/tippy-vod-scanner/src/cli.ts".to_string();
        let ok_args = vec!["--experimental-strip-types".to_string(), cli.clone(), "scan".to_string()];
        assert_eq!(validate("cmd.exe", &ok_args).unwrap_err(), "bad_node");
        let relative = vec![
            "--experimental-strip-types".to_string(),
            "services/tippy-vod-scanner/src/cli.ts".to_string(),
            "scan".to_string(),
        ];
        assert_eq!(validate("node", &relative).unwrap_err(), "bad_cli");
        let mut remote = ok_args.clone();
        remote.push("https://twitch.tv/example".to_string());
        assert_eq!(validate("node", &remote).unwrap_err(), "remote_refused");
    }

    #[test]
    fn accepts_node_and_the_scanner_commands_without_spawning() {
        let args = vec![
            "--experimental-strip-types".to_string(),
            "/opt/streamerstipReact/services/tippy-vod-scanner/src/cli.ts".to_string(),
            "edit".to_string(),
        ];
        assert!(validate("node", &args).is_ok());
        assert!(validate("/usr/local/bin/node", &args).is_ok());
        assert!(validate("C:/Program Files/nodejs/node.exe", &args).is_ok());
    }
}
