//! Minimal FFmpeg/ffprobe stand-in for workflow state and receipts. It does no media encoding.
use std::{env, fs, io::Write, path::Path, process::ExitCode};

fn main() -> ExitCode {
    let args: Vec<_> = env::args_os().skip(1).collect();
    let operation = if args.first().is_some_and(|arg| arg == "render") {
        "render"
    } else if args.iter().any(|arg| arg == "-show_entries") {
        "inspect"
    } else if args.iter().any(|arg| arg == "-frames:v") {
        "frame"
    } else {
        "decode"
    };
    let trace = env::var_os("ZODCHI_FIXTURE_VIDEO_TRACE").unwrap();
    writeln!(
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(trace)
            .unwrap(),
        "{operation}"
    )
    .unwrap();
    if operation == "render" {
        fs::write(Path::new(args.last().unwrap()), b"fixture MP4").unwrap();
    } else if operation == "inspect" {
        if fs::read(Path::new(args.last().unwrap())).unwrap() != b"fixture MP4" {
            return ExitCode::FAILURE;
        }
        println!(
            r#"{{"streams":[{{"codec_name":"h264","codec_type":"video","width":1080,"height":1920,"r_frame_rate":"24/1"}}],"format":{{"duration":"1.0","format_name":"mov,mp4,m4a,3gp,3g2,mj2"}}}}"#
        );
    } else if operation == "frame" {
        fs::copy(
            env::var_os("ZODCHI_FIXTURE_VIDEO_FRAME").unwrap(),
            args.last().unwrap(),
        )
        .unwrap();
    }
    ExitCode::SUCCESS
}
