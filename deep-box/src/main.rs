//! deep-box: serve a directory over HTTP from a Node.js server running in an
//! Alpine (aarch64 Linux) guest under LiteBox on Apple Silicon, via the HVF backend.
//! The LiteBox runner and the node:alpine rootfs are embedded in this binary.
use flate2::read::GzDecoder;
use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

const RUNNER_GZ: &[u8] = include_bytes!("../assets/runner.gz");
const ROOTFS_GZ: &[u8] = include_bytes!("../assets/rootfs.tar.gz");
const ENTITLEMENTS: &[u8] = include_bytes!("../assets/entitlements.plist");
const SERVER_JS: &[u8] = include_bytes!("../assets/server.js");
/// dsh-dynamic-agent + a Linux/musl runtime closure of the deepseek harness (see build-agent.sh).
const AGENT_GZ: &[u8] = include_bytes!("../assets/agent.tar.gz");

const HOST_IP: &str = "10.0.0.1";
const GUEST_IP: &str = "10.0.0.2";

const USAGE: &str = "usage: deep-box [--port N] [--iface utunN] [--selftest PATH] [dir]\n\
       deep-box --agent [--env-file FILE] [prompt...]\n\
  With a <dir>: serves it as a website. Without: serves an Alpine dashboard (htop + shell terminals).\n\
  Open http://10.0.0.2:<port> (default 8080). Needs sudo for the utun interface.\n\
  --agent: run the dsh dynamic agent (sallespro/dsh-dynamic-agent) inside the guest and print its answer.\n\
           Credentials come from --env-file, else .env next to this binary, else ./.env (needs OPENAI_API_KEY).\n\
           No sudo: the guest reaches the network through LiteBox's rootless outbound proxy.";

fn die(msg: impl std::fmt::Display) -> ! {
    eprintln!("deep-box: {msg}");
    std::process::exit(1);
}

fn gunzip_to(data: &[u8], dest: &Path) -> io::Result<()> {
    let mut out = fs::File::create(dest)?;
    io::copy(&mut GzDecoder::new(data), &mut out)?;
    out.flush()
}

/// Extract the embedded runner (signed) and base rootfs into a per-version cache dir.
fn prepare_cache() -> io::Result<(PathBuf, PathBuf)> {
    let home = std::env::var("HOME").map_err(|_| io::Error::other("HOME not set"))?;
    let dir = Path::new(&home)
        .join(".cache/deep-box")
        .join(format!("{}-{}-{}", RUNNER_GZ.len(), ROOTFS_GZ.len(), AGENT_GZ.len()));
    let runner = dir.join("runner");
    let rootfs = dir.join("rootfs.tar");
    if dir.join(".ready").exists() {
        return Ok((runner, rootfs));
    }
    eprintln!("first run: unpacking runner and rootfs into {} ...", dir.display());
    fs::create_dir_all(&dir)?;
    gunzip_to(RUNNER_GZ, &runner)?;
    fs::set_permissions(&runner, fs::Permissions::from_mode(0o755))?;
    let ent = dir.join("entitlements.plist");
    fs::write(&ent, ENTITLEMENTS)?;
    let st = Command::new("/usr/bin/codesign")
        .args(["--force", "--options", "runtime", "--sign", "-", "--entitlements"])
        .arg(&ent)
        .arg(&runner)
        .status()?;
    if !st.success() {
        return Err(io::Error::other("codesign failed"));
    }
    gunzip_to(ROOTFS_GZ, &rootfs)?;
    fs::write(dir.join(".ready"), b"")?;
    Ok((runner, rootfs))
}

/// Base rootfs + the agent closure under /opt/dsh, built once per version and cached.
fn agent_rootfs(base: &Path) -> io::Result<PathBuf> {
    let dir = base.parent().expect("rootfs has a parent");
    let out = dir.join("rootfs-agent.tar");
    if dir.join(".agent-ready").exists() {
        return Ok(out);
    }
    eprintln!("first agent run: building the agent rootfs (one-off, ~1 min) ...");
    let gz = dir.join("agent.tar.gz");
    let tree = dir.join("agent");
    let _ = fs::remove_dir_all(&tree);
    fs::create_dir_all(&tree)?;
    fs::write(&gz, AGENT_GZ)?;
    let run = |cmd: &mut Command, what: &str| -> io::Result<()> {
        if cmd.status()?.success() { Ok(()) } else { Err(io::Error::other(format!("{what} failed"))) }
    };
    run(Command::new("/usr/bin/tar").arg("-xzf").arg(&gz).arg("-C").arg(&tree), "unpacking the agent")?;
    // APFS clone (instant, copy-on-write); fall back to a plain copy elsewhere.
    let _ = fs::remove_file(&out);
    if !Command::new("/bin/cp").arg("-c").arg(base).arg(&out).status().map(|s| s.success()).unwrap_or(false) {
        fs::copy(base, &out)?;
    }
    // bsdtar -r appends at the true end of the archive; hand-concatenated tars are not read correctly by LiteBox.
    run(
        Command::new("/usr/bin/tar").env("COPYFILE_DISABLE", "1").arg("-rf").arg(&out).arg("-C").arg(&tree).arg("opt/dsh"),
        "adding the agent to the rootfs",
    )?;
    let _ = fs::remove_dir_all(&tree);
    let _ = fs::remove_file(&gz);
    fs::write(dir.join(".agent-ready"), b"")?;
    Ok(out)
}

/// Locate the credentials file: --env-file, else .env beside the executable, else ./.env.
fn find_env_file(explicit: Option<String>) -> PathBuf {
    if let Some(p) = explicit {
        let p = PathBuf::from(p);
        if !p.is_file() {
            die(format!("--env-file {} not found", p.display()));
        }
        return p;
    }
    let beside = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join(".env")));
    for cand in beside.into_iter().chain([PathBuf::from(".env")]) {
        if cand.is_file() {
            return cand;
        }
    }
    die("no .env found (looked beside the binary and in the current directory); create one with OPENAI_API_KEY=... or pass --env-file")
}

/// Run the dsh dynamic agent once in the guest, with the credentials staged as a file in a private temp dir
/// (never on a command line), and exit with its status.
fn run_agent(runner: &Path, base: &Path, env_file: PathBuf, prompt: Vec<String>) -> ! {
    let creds = fs::read(&env_file).unwrap_or_else(|e| die(format!("cannot read {}: {e}", env_file.display())));
    if !String::from_utf8_lossy(&creds).lines().any(|l| l.trim_start().starts_with("OPENAI_API_KEY=")) {
        eprintln!("deep-box: warning: {} has no OPENAI_API_KEY=... line", env_file.display());
    }
    let agent_base = agent_rootfs(base).unwrap_or_else(|e| die(format!("agent setup failed: {e}")));

    let work = std::env::temp_dir().join(format!("deep-box-agent-{}", std::process::id()));
    let _ = fs::remove_dir_all(&work);
    fs::create_dir_all(work.join("stage/opt/dsh/agent")).unwrap_or_else(|e| die(e));
    fs::set_permissions(&work, fs::Permissions::from_mode(0o700)).unwrap_or_else(|e| die(e));
    let env_in_stage = work.join("stage/opt/dsh/agent/.env");
    fs::write(&env_in_stage, creds).unwrap_or_else(|e| die(e));
    fs::set_permissions(&env_in_stage, fs::Permissions::from_mode(0o600)).unwrap_or_else(|e| die(e));

    let tar = work.join("rootfs.tar");
    if !Command::new("/bin/cp").arg("-c").arg(&agent_base).arg(&tar).status().map(|s| s.success()).unwrap_or(false) {
        fs::copy(&agent_base, &tar).unwrap_or_else(|e| die(e));
    }
    let st = Command::new("/usr/bin/tar")
        .env("COPYFILE_DISABLE", "1")
        .arg("-rf").arg(&tar).arg("-C").arg(work.join("stage")).arg("opt/dsh/agent/.env")
        .status().unwrap_or_else(|e| die(e));
    if !st.success() {
        die("failed to stage the credentials");
    }

    let mut cmd = Command::new(runner);
    cmd.args(["--unstable", "--hvf", "--guest-root", "--net-proxy"])
        .args(["--env", "NODE_USE_ENV_PROXY=1", "--env", "HOME=/root"])
        .args(["--env", "DSH_BIN=/opt/dsh/lib/bin.js", "--env", "DSH_HOME=/opt/dsh/home"])
        .arg("--initial-files").arg(&tar)
        .args(["/usr/local/bin/node", "/opt/dsh/agent/dsh-dynamic-agent.mjs"]);
    if !prompt.is_empty() {
        cmd.arg(prompt.join(" "));
    }
    let code = cmd.status().map(|s| s.code().unwrap_or(1)).unwrap_or_else(|e| {
        eprintln!("deep-box: failed to start runner: {e}");
        1
    });
    let _ = fs::remove_dir_all(&work);
    std::process::exit(code);
}

fn sudo(args: &[&str]) -> bool {
    Command::new("sudo").args(args).status().map(|s| s.success()).unwrap_or(false)
}

fn main() {
    let mut port = "8080".to_string();
    let mut iface = "utun9".to_string(); // high unit to avoid VPN utuns
    let mut selftest: Option<String> = None;
    let mut dir: Option<String> = None; // None => built-in Alpine dashboard
    let mut agent = false;
    let mut env_file: Option<String> = None;
    let mut rest: Vec<String> = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--port" => port = args.next().unwrap_or_else(|| die(USAGE)),
            "--iface" => iface = args.next().unwrap_or_else(|| die(USAGE)),
            "--selftest" => selftest = Some(args.next().unwrap_or_else(|| die(USAGE))),
            "--agent" => agent = true,
            "--env-file" => env_file = Some(args.next().unwrap_or_else(|| die(USAGE))),
            "-h" | "--help" => {
                println!("{USAGE}");
                return;
            }
            _ => rest.push(a),
        }
    }
    if agent {
        let (runner, base) = prepare_cache().unwrap_or_else(|e| die(format!("setup failed: {e}")));
        run_agent(&runner, &base, find_env_file(env_file), rest);
    }
    if env_file.is_some() {
        die("--env-file only applies with --agent");
    }
    let mut rest = rest.into_iter();
    dir = rest.next();
    if rest.next().is_some() {
        die(USAGE);
    }
    let dir = dir.map(|d| {
        let d = fs::canonicalize(d).unwrap_or_else(|e| die(format!("cannot open directory: {e}")));
        if !d.is_dir() {
            die(format!("{} is not a directory", d.display()));
        }
        d
    });
    if port.parse::<u16>().is_err() {
        die("invalid --port");
    }

    let (runner, base) = prepare_cache().unwrap_or_else(|e| die(format!("setup failed: {e}")));

    // With a directory: per-run rootfs = base + /app/server.js + /www (a copy of the served dir).
    // Without one: the base rootfs already contains the dashboard at /dash.
    let work = std::env::temp_dir().join(format!("deep-box-{}", std::process::id()));
    let tar = match &dir {
        Some(dir) => {
            let stage = work.join("stage");
            fs::create_dir_all(stage.join("app")).unwrap_or_else(|e| die(e));
            fs::write(stage.join("app/server.js"), SERVER_JS).unwrap_or_else(|e| die(e));
            symlink(dir, stage.join("www")).unwrap_or_else(|e| die(e));
            let tar = work.join("rootfs.tar");
            fs::copy(&base, &tar).unwrap_or_else(|e| die(e));
            let st = Command::new("/usr/bin/tar")
                .args(["-rhf"]).arg(&tar).arg("-C").arg(&stage).args(["app", "www"])
                .status().unwrap_or_else(|e| die(e));
            if !st.success() {
                die("failed to add the directory to the guest rootfs");
            }
            tar
        }
        None => base.clone(),
    };

    let cleanup = {
        let work = work.clone();
        move || { let _ = fs::remove_dir_all(&work); }
    };
    let interrupted = Arc::new(AtomicBool::new(false));
    {
        let f = interrupted.clone();
        ctrlc::set_handler(move || f.store(true, Ordering::SeqCst)).ok();
    }

    let mut cmd_args: Vec<String> = vec![
        "--unstable".into(), "--hvf".into(),
        "--guest-ip".into(), GUEST_IP.into(), "--gateway-ip".into(), HOST_IP.into(),
        "--initial-files".into(), tar.display().to_string(),
        "--env".into(), format!("PORT={port}"),
    ];
    let selftest_mode = selftest.is_some();
    if let Some(path) = &selftest {
        // In-guest check: no network interface, no sudo.
        cmd_args.extend(["--env".into(), format!("SELFTEST={path}")]);
    } else {
        cmd_args.extend(["--tun-device-name".into(), iface.clone()]);
    }
    let entry = if dir.is_some() { "/app/server.js" } else { "/dash/server.js" };
    cmd_args.extend(["/usr/local/bin/node".into(), entry.into()]);

    let mut child = if selftest_mode {
        Command::new(&runner).args(&cmd_args).spawn()
    } else {
        eprintln!("sudo is needed to create the {iface} network interface");
        if !sudo(&["-v"]) {
            cleanup();
            die("sudo failed");
        }
        Command::new("sudo").arg(&runner).args(&cmd_args).spawn()
    }
    .unwrap_or_else(|e| { cleanup(); die(format!("failed to start runner: {e}")) });

    if !selftest_mode {
        let mut up = false;
        for _ in 0..50 {
            if Command::new("/sbin/ifconfig").arg(&iface).stdout(Stdio::null()).stderr(Stdio::null())
                .status().map(|s| s.success()).unwrap_or(false) { up = true; break; }
            if child.try_wait().ok().flatten().is_some() { break; }
            std::thread::sleep(Duration::from_millis(200));
        }
        if !up || !sudo(&["/sbin/ifconfig", &iface, HOST_IP, GUEST_IP, "up"]) {
            let _ = child.kill();
            cleanup();
            die(format!("could not bring up {iface}"));
        }
        let what = dir.as_ref().map_or("the Alpine dashboard".to_string(), |d| d.display().to_string());
        eprintln!("\nServing {what} at  http://{GUEST_IP}:{port}   (Ctrl-C to stop)\n");
    }

    let code = loop {
        if let Some(st) = child.try_wait().unwrap_or(None) { break st.code().unwrap_or(1); }
        if interrupted.load(Ordering::SeqCst) {
            // SIGINT already reached the whole foreground group; give it a moment, then force.
            std::thread::sleep(Duration::from_millis(500));
            if child.try_wait().ok().flatten().is_none() { sudo(&["/bin/kill", &child.id().to_string()]); let _ = child.kill(); }
            break 0;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let _ = child.wait();
    cleanup();
    std::process::exit(code);
}
