use super::*;
use std::{
    cell::RefCell,
    collections::HashMap,
    io::{self, BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};

const CHANNEL: &str = "UC0000000000000000000000";
const VIDEO: &str = "Ab012345678";
const BYTES: &[u8] = b"fixture mp4";
const SECRET: &str = "fixture-session-do-not-log";
const ACCESS: &str = "fixture-access";

#[derive(Default)]
struct TestVault(RefCell<HashMap<String, String>>);

impl Vault for TestVault {
    fn get(&self, key: &str) -> Result<Option<String>> {
        Ok(self.0.borrow().get(key).cloned())
    }
    fn put(&self, key: &str, value: &str) -> Result<()> {
        self.0.borrow_mut().insert(key.to_owned(), value.to_owned());
        Ok(())
    }
    fn forget(&self, key: &str) -> Result<()> {
        self.0.borrow_mut().remove(key);
        Ok(())
    }
}

struct Fixture {
    home: PathBuf,
    plan: Value,
    vault: TestVault,
}

impl Fixture {
    fn new() -> Self {
        let home = crate::checks::temp_dir("youtube", "fixture").unwrap();
        let file = home.join("approved.mp4");
        fs::write(&file, BYTES).unwrap();
        let vault = TestVault::default();
        vault
            .put(
                "profile/personal",
                &json!({
                    "client": { "client_id": "test.apps.googleusercontent.com" },
                    "refreshToken": "fixture-refresh", "channelId": CHANNEL,
                })
                .to_string(),
            )
            .unwrap();
        let metadata = metadata(&json!({
            "title": "Exact title", "description": "Exact description", "categoryId": "22",
            "selfDeclaredMadeForKids": false,
        }))
        .unwrap();
        let plan = json!({ "artifact": media::pin(&file).unwrap(), "videoRun": "source",
            "profile": "personal", "channelId": CHANNEL, "metadata": metadata, "notifySubscribers": false });
        Self { home, plan, vault }
    }

    fn journal(&self, id: &str, decision: &str) {
        let digest = input::args_digest(&self.plan);
        let run = json!({ "runId": id, "workflow": NAME, "version": VERSION,
            "inputs": { "plan": self.plan, "planSha256": digest } });
        let mut journal = Journal::create(&self.home, id, &run).unwrap();
        let wait = json!({ "kind": "waiting", "step": APPROVAL, "planSha256": digest });
        journal.append(wait.clone()).unwrap();
        if !decision.is_empty() {
            let answer = json!({ "decision": decision, "planSha256": digest, "ownerWords": "I checked the plan." });
            record_reply(&wait, &answer.to_string()).unwrap();
            journal
                .append(
                    json!({ "kind": "rerun", "step": APPROVAL, "ownerAnswer": answer.to_string() }),
                )
                .unwrap();
        }
    }

    fn resume(&self, id: &str, google: &Google) -> Exit {
        let (journal, run) = Journal::open(&self.home, id).unwrap();
        resume_with(journal, &run, &self.home, google, &self.vault).unwrap()
    }

    fn assert_private_journal(&self, id: &str) {
        let (journal, _) = Journal::open(&self.home, id).unwrap();
        let events = fs::read_to_string(journal.file("events.jsonl")).unwrap();
        for forbidden in [SECRET, "upload_id", "fixture-access", "fixture-refresh"] {
            assert!(!events.contains(forbidden));
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        crate::checks::remove(&self.home);
    }
}

struct Request {
    line: String,
    headers: HashMap<String, String>,
    bytes: Vec<u8>,
}

impl Request {
    fn read(stream: &mut TcpStream) -> Self {
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let mut headers = HashMap::new();
        loop {
            let mut header = String::new();
            reader.read_line(&mut header).unwrap();
            if header.trim().is_empty() {
                break;
            }
            let (name, value) = header.split_once(':').unwrap();
            headers.insert(name.to_ascii_lowercase(), value.trim().to_owned());
        }
        let mut bytes = vec![
            0;
            headers
                .get("content-length")
                .map_or(0, |len| len.parse().unwrap())
        ];
        reader.read_exact(&mut bytes).unwrap();
        Self {
            line,
            headers,
            bytes,
        }
    }
}

enum Reply {
    Token,
    Channel(&'static str),
    Open,
    Ack,
    Store,
    Video {
        privacy: &'static str,
        processed: bool,
    },
    Status(&'static str),
}

fn server(script: Vec<Reply>) -> (Google, thread::JoinHandle<Vec<Request>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let google = Google::fixture(&origin);
    let peer = thread::spawn(move || {
        script.into_iter().map(|reply| {
            let deadline = Instant::now() + Duration::from_secs(6);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock && Instant::now() < deadline =>
                        thread::sleep(Duration::from_millis(10)),
                    Err(error) => panic!("Missing an expected local YouTube request: {error}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let request = Request::read(&mut stream);
            let (status, headers, data) = match reply {
                Reply::Token => {
                    assert!(request.line.starts_with("POST /token "));
                    assert!(std::str::from_utf8(&request.bytes).unwrap().contains("grant_type=refresh_token"));
                    ("200 OK", String::new(), json!({"access_token": ACCESS}))
                }
                Reply::Channel(id) => {
                    assert!(request.line.starts_with("GET /youtube/v3/channels?"));
                    assert!(request.line.contains("mine=true"));
                    ("200 OK", String::new(), json!({"items":[{"id": id, "snippet":{"title":"Fixture"}}]}))
                }
                Reply::Open => {
                    assert!(request.line.starts_with("POST /upload/youtube/v3/videos?"));
                    assert!(request.line.contains("uploadType=resumable") && request.line.contains("notifySubscribers=false"));
                    let body: Value = serde_json::from_slice(&request.bytes).unwrap();
                    assert_eq!(body["status"]["privacyStatus"], "private");
                    assert!(body["status"].get("publishAt").is_none());
                    ("200 OK", format!("Location: {origin}/upload/youtube/v3/videos?upload_id={SECRET}\r\n"), Value::Null)
                }
                Reply::Ack => ("308 Resume Incomplete", "Range: bytes=0-3\r\n".into(), Value::Null),
                Reply::Store => ("201 Created", String::new(), json!({"id": VIDEO})),
                Reply::Video { privacy, processed } => {
                    assert!(request.line.starts_with("GET /youtube/v3/videos?"));
                    assert!(request.line.contains(&format!("id={VIDEO}")));
                    ("200 OK", String::new(), json!({"items": [{
                        "id": VIDEO,
                        "snippet":{"channelId": CHANNEL, "title": "Exact title", "description": "Exact description", "categoryId": "22"},
                        "status":{"privacyStatus": privacy, "uploadStatus": if processed {"processed"} else {"uploaded"}, "selfDeclaredMadeForKids": false},
                        "processingDetails":{"processingStatus": if processed {"succeeded"} else {"processing"}},
                    }]}))
                }
                Reply::Status(status) => (status, String::new(), Value::Null),
            };
            if !request.line.starts_with("POST /token ") {
                assert_eq!(request.headers.get("authorization").map(String::as_str), Some("Bearer fixture-access"));
            }
            let body = if data.is_null() { String::new() } else { data.to_string() };
            write!(stream, "HTTP/1.1 {status}\r\nConnection: close\r\nContent-Type: application/json\r\n{headers}Content-Length: {}\r\n\r\n{body}", body.len()).unwrap();
            request
        }).collect()
    });
    (google, peer)
}

fn ranges(requests: &[Request]) -> Vec<(&str, &[u8])> {
    requests
        .iter()
        .filter_map(|r| {
            r.headers
                .get("content-range")
                .map(|range| (range.as_str(), r.bytes.as_slice()))
        })
        .collect()
}

#[test]
fn resumes_at_server_offset_then_waits_for_processing_without_uploading_again() {
    let world = Fixture::new();
    world.journal("one", "approve");
    let (google, peer) = server(vec![
        Reply::Token,
        Reply::Channel(CHANNEL),
        Reply::Open,
        Reply::Ack,
        Reply::Status("503 Service Unavailable"),
        Reply::Token,
        Reply::Channel(CHANNEL),
        Reply::Ack,
        Reply::Store,
        Reply::Video {
            privacy: "private",
            processed: false,
        },
        Reply::Token,
        Reply::Channel(CHANNEL),
        Reply::Video {
            privacy: "private",
            processed: true,
        },
        Reply::Token,
        Reply::Channel(CHANNEL),
    ]);
    let initial = world.resume("one", &google);
    assert_eq!(initial.result["youtube"]["bytesAcknowledged"], 4);
    assert_eq!(initial.result["status"], "stopped");
    let resumed = world.resume("one", &google);
    assert_eq!(resumed.result["runId"], "one");
    assert_eq!(resumed.result["status"], "processing");
    assert_eq!(resumed.result["youtube"]["videoId"], VIDEO);
    let result = world.resume("one", &google);
    assert_eq!(result.code, 0);
    assert_eq!(result.result["verdict"], "private_verified");
    assert_eq!(result.result["observed"]["privacyStatus"], "private");
    assert_eq!(world.resume("one", &google).result, result.result);
    assert!(world.vault.get("upload/one").unwrap().is_none());
    world.journal("two", "approve");
    assert!(world.resume("two", &google).result["reason"]
        .as_str()
        .unwrap()
        .contains("run one"));
    world.assert_private_journal("one");
    let requests = peer.join().unwrap();
    assert_eq!(
        ranges(&requests),
        vec![
            ("bytes 0-10/11", BYTES),
            ("bytes 4-10/11", &BYTES[4..]),
            ("bytes */11", &[]),
            ("bytes 4-10/11", &BYTES[4..]),
        ]
    );
    assert_eq!(
        requests
            .iter()
            .filter(|r| r.line.starts_with("POST /upload"))
            .count(),
        1
    );
}

#[test]
fn lost_final_response_restores_video_id_without_resending_bytes() {
    let world = Fixture::new();
    world.journal("one", "approve");
    let (google, peer) = server(vec![
        Reply::Token,
        Reply::Channel(CHANNEL),
        Reply::Open,
        Reply::Status("503 Service Unavailable"),
        Reply::Token,
        Reply::Channel(CHANNEL),
        Reply::Store,
        Reply::Video {
            privacy: "public",
            processed: true,
        },
        Reply::Token,
        Reply::Channel(CHANNEL),
        Reply::Video {
            privacy: "private",
            processed: true,
        },
    ]);
    assert_eq!(world.resume("one", &google).result["status"], "stopped");
    let mismatch = world.resume("one", &google);
    assert_eq!(mismatch.result["stoppedAt"], "verify upload");
    assert_eq!(mismatch.result["youtube"]["videoId"], VIDEO);
    let result = world.resume("one", &google);
    assert_eq!(
        [
            result.result["runId"].as_str().unwrap(),
            result.result["videoId"].as_str().unwrap()
        ],
        ["one", VIDEO]
    );
    assert_eq!(result.code, 0);
    assert_eq!(
        ranges(&peer.join().unwrap()),
        vec![("bytes 0-10/11", BYTES), ("bytes */11", &[])]
    );
}

#[test]
fn expired_upload_session_stops_without_another_insert() {
    let world = Fixture::new();
    world.journal("one", "approve");
    let (google, peer) = server(vec![
        Reply::Token,
        Reply::Channel(CHANNEL),
        Reply::Open,
        Reply::Status("503 Service Unavailable"),
        Reply::Token,
        Reply::Channel(CHANNEL),
        Reply::Status("404 Not Found"),
    ]);
    assert_eq!(world.resume("one", &google).code, 2);
    let expired = world.resume("one", &google);
    assert!(expired.result["reason"]
        .as_str()
        .unwrap()
        .contains("expired"));
    assert_eq!(
        ranges(&peer.join().unwrap()),
        vec![("bytes 0-10/11", BYTES), ("bytes */11", &[])]
    );
}

#[test]
fn approval_exact_file_and_channel_are_gates_before_upload() {
    let world = Fixture::new();
    world.journal("waiting", "");
    world.journal("declined", "reject");
    world.journal("approved", "approve");
    let (google, peer) = server(vec![
        Reply::Token,
        Reply::Channel("UC1111111111111111111111"),
    ]);
    assert_eq!(world.resume("waiting", &google).result["status"], "waiting");
    assert_eq!(
        world.resume("declined", &google).result["verdict"],
        "cancelled"
    );
    let wrong = world.resume("approved", &google);
    assert_eq!(wrong.result["stoppedAt"], "verify channel");
    assert_eq!(peer.join().unwrap().len(), 2);
    fs::write(
        world.plan["artifact"]["path"].as_str().unwrap(),
        b"changed mp4",
    )
    .unwrap();
    let edited = world.resume("approved", &google);
    assert_eq!(edited.result["stoppedAt"], "verify MP4");
}
