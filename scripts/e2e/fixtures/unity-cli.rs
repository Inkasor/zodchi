use std::{env, fs, io::Write};

fn main() {
    let args: Vec<_> = env::args().skip(1).collect();
    let Some(project) = args.windows(2).find(|pair| pair[0] == "--project-path").map(|pair| &pair[1]) else {
        std::process::exit(2);
    };
    assert!(args.iter().any(|arg| arg == "--non-interactive"));
    let trace = env::var("ZODCHI_FIXTURE_UNITY_TRACE").unwrap();
    let mut trace = fs::OpenOptions::new().create(true).append(true).open(trace).unwrap();
    if args.iter().any(|arg| arg == "status") {
        let project = project.replace('\\', "\\\\").replace('"', "\\\"");
        writeln!(trace, "status").unwrap();
        println!("{{\"success\":true,\"data\":{{\"instances\":[{{\"pid\":1234,\"project\":\"{project}\",\"state\":\"ready\"}}]}}}}");
        return;
    }
    let index = args.iter().position(|arg| arg == "command").unwrap();
    let name = args[index + 1].as_str();
    match name {
        "eval" if args.iter().any(|arg| arg.contains("AssetDatabase.Refresh")) => {
            writeln!(trace, "refresh").unwrap();
            println!("true");
        }
        "eval" => {
            writeln!(trace, "state").unwrap();
            let dirty = env::var("ZODCHI_FIXTURE_UNITY_DIRTY").as_deref() == Ok("1");
            println!("{{\"dirty\":{dirty},\"playing\":false,\"compiling\":false,\"scene\":\"Assets/Fixture.unity\"}}");
        }
        "console" => {
            writeln!(trace, "console").unwrap();
            println!("{{\"entries\":[]}}");
        }
        "find_gameobjects" => {
            writeln!(trace, "find_gameobjects").unwrap();
            println!("{{\"count\":3}}");
        }
        "screenshot" => {
            writeln!(trace, "screenshot").unwrap();
            let output = &args[args.iter().position(|arg| arg == "--output").unwrap() + 1];
            let image = env::var("ZODCHI_FIXTURE_UNITY_PNG").unwrap();
            let bytes: Vec<_> = (0..image.len()).step_by(2)
                .map(|i| u8::from_str_radix(&image[i..i+2], 16).unwrap()).collect();
            fs::write(output, bytes).unwrap();
            println!("{{\"width\":1}}");
        }
        _ => std::process::exit(2),
    }
}
