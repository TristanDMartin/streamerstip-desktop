use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::process::Command;
use std::sync::Mutex;

use serde::Serialize;

#[allow(dead_code)]
pub const CAPTURE_ACCELERATOR: &str = "CommandOrControl+Shift+F9";

struct CpuTimes {
    idle: u64,
    total: u64,
}

static PREVIOUS_CPU: Mutex<Option<String>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostResources {
    pub cpu_percent: Option<f64>,
    pub memory_percent: Option<f64>,
    pub gpu_util_percent: Option<f64>,
    pub vram_total_mb: Option<f64>,
    pub vram_used_mb: Option<f64>,
    pub encoder_util_percent: Option<f64>,
}

pub fn read_host_metrics() -> HostResources {
    let mut sample = read_nvidia();
    sample.memory_percent = read_memory_percent();
    sample.cpu_percent = read_cpu_percent();
    sample
}

pub fn append_decision(path: &Path, line: &str) -> Result<(), String> {
    if line.is_empty()
        || line.len() > 4_000
        || line.contains('\n')
        || line.contains('\r')
        || !line.starts_with('{')
        || !line.contains("tippy.resource-monitor.v1")
    {
        return Err("bad_log_line".to_string());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "log_unavailable".to_string())?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|_| "log_unavailable".to_string())?;
    file.write_all(line.as_bytes()).map_err(|_| "log_unavailable".to_string())?;
    file.write_all(b"\n").map_err(|_| "log_unavailable".to_string())?;
    Ok(())
}

pub fn memory_percent_from_meminfo(text: &str) -> Option<f64> {
    let total = meminfo_kb(text, "MemTotal:")?;
    let available = meminfo_kb(text, "MemAvailable:")?;
    if total == 0 {
        return None;
    }
    let used = total.saturating_sub(available);
    Some((used as f64) / (total as f64) * 100.0)
}

pub fn cpu_percent_from_stat(previous: &str, current: &str) -> Option<f64> {
    let before = cpu_times(previous)?;
    let after = cpu_times(current)?;
    let total = after.total.saturating_sub(before.total);
    if total == 0 {
        return None;
    }
    let idle = after.idle.saturating_sub(before.idle);
    Some((1.0 - (idle as f64) / (total as f64)) * 100.0)
}

pub fn parse_nvidia_smi(text: &str) -> HostResources {
    let mut sample = empty_host();
    let Some(line) = text.lines().find(|item| !item.trim().is_empty()) else {
        return sample;
    };
    let cells: Vec<&str> = line.split(',').collect();
    if cells.len() < 4 {
        return sample;
    }
    sample.gpu_util_percent = parse_cell(cells[0]);
    sample.vram_total_mb = parse_cell(cells[1]);
    sample.vram_used_mb = parse_cell(cells[2]);
    sample.encoder_util_percent = parse_cell(cells[3]);
    sample
}

fn empty_host() -> HostResources {
    HostResources {
        cpu_percent: None,
        memory_percent: None,
        gpu_util_percent: None,
        vram_total_mb: None,
        vram_used_mb: None,
        encoder_util_percent: None,
    }
}

fn parse_cell(cell: &str) -> Option<f64> {
    let trimmed = cell.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("[N/A]") || trimmed.eq_ignore_ascii_case("N/A") {
        return None;
    }
    trimmed.parse::<f64>().ok()
}

fn meminfo_kb(text: &str, key: &str) -> Option<u64> {
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix(key) {
            let number = rest.split_whitespace().next()?;
            return number.parse::<u64>().ok();
        }
    }
    None
}

fn cpu_times(text: &str) -> Option<CpuTimes> {
    let line = text.lines().find(|line| line.starts_with("cpu "))?;
    let mut numbers = Vec::new();
    for part in line.split_whitespace().skip(1) {
        numbers.push(part.parse::<u64>().ok()?);
    }
    if numbers.len() < 5 {
        return None;
    }
    let idle = numbers[3].saturating_add(numbers[4]);
    let total = numbers.iter().copied().fold(0u64, u64::saturating_add);
    Some(CpuTimes { idle, total })
}

fn read_memory_percent() -> Option<f64> {
    #[cfg(target_os = "linux")]
    {
        let text = std::fs::read_to_string("/proc/meminfo").ok()?;
        return memory_percent_from_meminfo(&text);
    }
    #[cfg(target_os = "windows")]
    {
        return powershell_number("$o=Get-CimInstance Win32_OperatingSystem; [math]::Round((($o.TotalVisibleMemorySize-$o.FreePhysicalMemory)/$o.TotalVisibleMemorySize)*100,1)");
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        None
    }
}

fn read_cpu_percent() -> Option<f64> {
    #[cfg(target_os = "linux")]
    {
        let text = std::fs::read_to_string("/proc/stat").ok()?;
        let mut previous = PREVIOUS_CPU.lock().unwrap_or_else(|err| err.into_inner());
        let percent = match previous.as_deref() {
            Some(before) => cpu_percent_from_stat(before, &text),
            None => None,
        };
        *previous = Some(text);
        return percent;
    }
    #[cfg(target_os = "windows")]
    {
        return powershell_number("(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average");
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        None
    }
}

fn read_nvidia() -> HostResources {
    let output = Command::new("nvidia-smi")
        .args([
            "--query-gpu=utilization.gpu,memory.total,memory.used,utilization.encoder",
            "--format=csv,noheader,nounits",
        ])
        .output();
    match output {
        Ok(output) if output.status.success() => {
            parse_nvidia_smi(&String::from_utf8_lossy(&output.stdout))
        }
        _ => empty_host(),
    }
}

#[cfg(target_os = "windows")]
fn powershell_number(script: &str) -> Option<f64> {
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.trim().parse::<f64>().ok()
}

#[cfg(test)]
mod tests {
    use super::{append_decision, cpu_percent_from_stat, memory_percent_from_meminfo, parse_nvidia_smi};

    #[test]
    fn memory_and_cpu_parsers_use_host_counters() {
        let mem = "MemTotal: 16000000 kB\nMemAvailable: 4000000 kB\n";
        let percent = memory_percent_from_meminfo(mem).unwrap();
        assert!((percent - 75.0).abs() < 0.01);
        let before = "cpu  10 0 10 80 0 0 0 0\n";
        let after = "cpu  20 0 20 100 0 0 0 0\n";
        let cpu = cpu_percent_from_stat(before, after).unwrap();
        assert!((cpu - 50.0).abs() < 0.01);
    }

    #[test]
    fn nvidia_smi_na_does_not_invent_a_gpu() {
        let sample = parse_nvidia_smi("12, 8192, 1024, [N/A]\n");
        assert_eq!(sample.gpu_util_percent, Some(12.0));
        assert_eq!(sample.vram_total_mb, Some(8192.0));
        assert_eq!(sample.vram_used_mb, Some(1024.0));
        assert_eq!(sample.encoder_util_percent, None);
        let missing = parse_nvidia_smi("");
        assert_eq!(missing.gpu_util_percent, None);
    }

    #[test]
    fn resource_decisions_append_locally_and_reject_a_foreign_line() {
        let path = std::env::temp_dir().join(format!("tippy-resource-{}-test.jsonl", std::process::id()));
        let line = "{\"policy\":\"tippy.resource-monitor.v1\",\"phase\":\"suspended\"}";
        append_decision(&path, line).unwrap();
        let stored = std::fs::read_to_string(&path).unwrap();
        assert_eq!(stored, format!("{line}\n"));
        assert!(append_decision(&path, "hello").is_err());
        let _ = std::fs::remove_file(path);
    }
}
