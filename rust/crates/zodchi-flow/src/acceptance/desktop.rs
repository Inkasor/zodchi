//! Start a process on an inactive Windows desktop. The active desktop is never switched.

use super::{environment, Tool};
use std::{
    ffi::{c_void, OsStr},
    fs::File,
    io, mem,
    os::windows::{ffi::OsStrExt, io::AsRawHandle},
    ptr,
};
use zodchi_core::{
    process::kill_tree,
    util::{fail, Result},
};

type Handle = *mut c_void;
const DESKTOP_ACCESS: u32 = 0x00c7; // enumerate, read/write objects, create windows and menus
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CREATE_UNICODE_ENVIRONMENT: u32 = 0x0400;

#[repr(C)]
struct StartupInfo {
    size: u32,
    reserved: *mut u16,
    desktop: *mut u16,
    title: *mut u16,
    geometry: [u32; 7],
    flags: u32,
    show: u16,
    reserved_size: u16,
    reserved2: *mut u8,
    stdin: Handle,
    stdout: Handle,
    stderr: Handle,
}

#[repr(C)]
struct ProcessInfo {
    process: Handle,
    thread: Handle,
    pid: u32,
    tid: u32,
}

#[link(name = "User32")]
extern "system" {
    fn CreateDesktopW(
        name: *const u16,
        device: *const u16,
        mode: *mut c_void,
        flags: u32,
        access: u32,
        security: *const c_void,
    ) -> Handle;
    fn CloseDesktop(desktop: Handle) -> i32;
    fn GetThreadDesktop(thread: u32) -> Handle;
    fn SetThreadDesktop(desktop: Handle) -> i32;
    fn OpenInputDesktop(flags: u32, inherit: i32, access: u32) -> Handle;
    fn GetUserObjectInformationW(
        handle: Handle,
        index: i32,
        data: *mut c_void,
        size: u32,
        needed: *mut u32,
    ) -> i32;
}

#[link(name = "Kernel32")]
extern "system" {
    fn GetCurrentThreadId() -> u32;
    fn GetCurrentProcess() -> Handle;
    fn DuplicateHandle(
        source_process: Handle,
        source: Handle,
        target_process: Handle,
        target: *mut Handle,
        access: u32,
        inherit: i32,
        options: u32,
    ) -> i32;
    fn CreateProcessW(
        program: *const u16,
        command: *mut u16,
        process_security: *const c_void,
        thread_security: *const c_void,
        inherit: i32,
        flags: u32,
        environment: *const c_void,
        cwd: *const u16,
        startup: *mut StartupInfo,
        info: *mut ProcessInfo,
    ) -> i32;
    fn CloseHandle(handle: Handle) -> i32;
    fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
    fn GetExitCodeProcess(handle: Handle, code: *mut u32) -> i32;
}

fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain([0]).collect()
}

fn quoted(out: &mut Vec<u16>, arg: &OsStr) {
    out.push(34);
    let mut slashes = 0;
    for c in arg.encode_wide() {
        if c == 92 {
            slashes += 1;
            continue;
        }
        out.extend(std::iter::repeat_n(
            92,
            if c == 34 { 2 * slashes + 1 } else { slashes },
        ));
        slashes = 0;
        out.push(c);
    }
    out.extend(std::iter::repeat_n(92, 2 * slashes));
    out.push(34);
}

fn input_name() -> io::Result<String> {
    unsafe {
        let input = OpenInputDesktop(0, 0, 1);
        if input.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut buffer = [0u16; 256];
        let mut size = 0;
        let ok = GetUserObjectInformationW(
            input,
            2,
            buffer.as_mut_ptr().cast(),
            mem::size_of_val(&buffer) as u32,
            &mut size,
        );
        let result = if ok == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(String::from_utf16_lossy(
                &buffer[..buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len())],
            ))
        };
        CloseDesktop(input);
        result
    }
}

struct Desktop {
    handle: Handle,
    original_thread: Handle,
    name: String,
    input: String,
}

impl Desktop {
    fn new() -> Result<Self> {
        let input = input_name()?;
        let name = format!("ZodchiAcceptance-{:016x}", rand::random::<u64>());
        unsafe {
            let original_thread = GetThreadDesktop(GetCurrentThreadId());
            let handle = CreateDesktopW(
                wide(&name).as_ptr(),
                ptr::null(),
                ptr::null_mut(),
                0,
                DESKTOP_ACCESS,
                ptr::null(),
            );
            if handle.is_null() {
                return fail(format!("Windows could not create a private desktop: {}. Use the local Zodchi executor in the interactive user session.", io::Error::last_os_error()));
            }
            let desktop = Self {
                handle,
                original_thread,
                name,
                input,
            };
            if input_name()? == desktop.name {
                return fail("The test desktop was unexpectedly active.");
            }
            Ok(desktop)
        }
    }
}

impl Drop for Desktop {
    fn drop(&mut self) {
        unsafe {
            SetThreadDesktop(self.original_thread);
            CloseDesktop(self.handle);
        }
    }
}

struct OwnedHandle(Handle);

impl OwnedHandle {
    fn inherit(source: Handle) -> Result<Self> {
        unsafe {
            let current = GetCurrentProcess();
            let mut duplicate = ptr::null_mut();
            if DuplicateHandle(current, source, current, &mut duplicate, 0, 1, 2) == 0 {
                return Err(io::Error::last_os_error().into());
            }
            Ok(Self(duplicate))
        }
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

pub(super) struct Child {
    desktop: Desktop,
    process: OwnedHandle,
    pid: u32,
    done: bool,
}

impl Child {
    pub(super) fn launch(tool: &Tool<'_>, log: &File) -> Result<Self> {
        let desktop = Desktop::new()?;
        let stderr = OwnedHandle::inherit(log.as_raw_handle())?;
        let stdout = tool
            .stdout
            .as_ref()
            .map(|pipe| OwnedHandle::inherit(pipe.as_raw_handle()))
            .transpose()?;
        let null_file = File::open("NUL")?;
        let stdin = OwnedHandle::inherit(null_file.as_raw_handle())?;
        let mut desktop_name = wide(format!("WinSta0\\{}", desktop.name));
        let mut command = Vec::new();
        quoted(&mut command, tool.program.as_os_str());
        for arg in tool.args {
            command.push(32);
            quoted(&mut command, OsStr::new(arg));
        }
        command.push(0);
        let mut kept = environment();
        kept.sort_by_key(|(key, _)| key.to_ascii_uppercase());
        let mut env = Vec::new();
        for (key, value) in kept {
            env.extend(format!("{key}=").encode_utf16());
            env.extend(wide(value));
        }
        env.push(0);
        unsafe {
            let mut startup: StartupInfo = mem::zeroed();
            startup.size = mem::size_of::<StartupInfo>() as u32;
            startup.desktop = desktop_name.as_mut_ptr();
            startup.flags = 0x100; // STARTF_USESTDHANDLES
            startup.stdin = stdin.0;
            startup.stdout = stdout.as_ref().map_or(stderr.0, |pipe| pipe.0);
            startup.stderr = stderr.0;
            let mut info: ProcessInfo = mem::zeroed();
            let ok = CreateProcessW(
                wide(tool.program).as_ptr(),
                command.as_mut_ptr(),
                ptr::null(),
                ptr::null(),
                1,
                CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                env.as_ptr().cast(),
                wide(tool.cwd).as_ptr(),
                &mut startup,
                &mut info,
            );
            if ok == 0 {
                return Err(io::Error::last_os_error().into());
            }
            CloseHandle(info.thread);
            Ok(Self {
                desktop,
                process: OwnedHandle(info.process),
                pid: info.pid,
                done: false,
            })
        }
    }

    pub(super) fn wait(&mut self, seconds: u64) -> Result<u32> {
        unsafe {
            match WaitForSingleObject(self.process.0, (seconds * 1000) as u32) {
                0 => {
                    self.done = true;
                    let mut exit = 0;
                    if GetExitCodeProcess(self.process.0, &mut exit) != 0 {
                        Ok(exit)
                    } else {
                        Err(io::Error::last_os_error().into())
                    }
                }
                258 => fail("The acceptance tool timed out."),
                _ => Err(io::Error::last_os_error().into()),
            }
        }
    }

    pub(super) fn pid(&self) -> u32 {
        self.pid
    }
    pub(super) fn desktop(&self) -> &str {
        &self.desktop.name
    }
    pub(super) fn input_preserved(&self) -> Result<bool> {
        Ok(input_name()? == self.desktop.input)
    }
}

impl Drop for Child {
    fn drop(&mut self) {
        if !self.done {
            kill_tree(self.pid);
            unsafe {
                WaitForSingleObject(self.process.0, 3000);
            }
        }
    }
}
