use crate::models::{CommandError, CommandResult};

#[cfg(windows)]
pub struct JobObject {
    handle: windows::Win32::Foundation::HANDLE,
}

// Windows kernel handles may be used and closed from any process thread. Ownership remains
// exclusive to this wrapper, and every operation is synchronized by the containing state mutex.
#[cfg(windows)]
unsafe impl Send for JobObject {}
#[cfg(windows)]
unsafe impl Sync for JobObject {}

#[cfg(windows)]
impl JobObject {
    pub fn attach(process_id: u32) -> CommandResult<Option<Self>> {
        use std::{ffi::c_void, mem::size_of};
        use windows::core::PCWSTR;
        use windows::Win32::{
            Foundation::CloseHandle,
            System::{
                JobObjects::{
                    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                },
                Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE},
            },
        };

        // SAFETY: Null security/name parameters request an unnamed job with default ACLs.
        let job = unsafe { CreateJobObjectW(None, PCWSTR::null()) }.map_err(|error| {
            CommandError::new(
                "job_object_create_failed",
                format!("Không tạo được Windows Job Object: {error}"),
            )
        })?;
        let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: The pointer and byte length describe `information` for the documented class.
        if let Err(error) = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &information as *const _ as *const c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } {
            // SAFETY: `job` is a valid owned handle.
            let _ = unsafe { CloseHandle(job) };
            return Err(CommandError::new(
                "job_object_config_failed",
                format!("Không cấu hình được KILL_ON_JOB_CLOSE: {error}"),
            ));
        }

        // SAFETY: OpenProcess validates the PID and requested access rights.
        let process = match unsafe {
            OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, process_id)
        } {
            Ok(process) => process,
            Err(error) => {
                // SAFETY: `job` is a valid owned handle.
                let _ = unsafe { CloseHandle(job) };
                return Err(CommandError::new(
                    "process_open_failed",
                    format!("Không mở được sidecar process: {error}"),
                ));
            }
        };

        // SAFETY: `job` and `process` are valid kernel handles.
        let assigned = unsafe { AssignProcessToJobObject(job, process) };
        // SAFETY: `process` is no longer needed after assignment.
        let _ = unsafe { CloseHandle(process) };
        if let Err(error) = assigned {
            // SAFETY: `job` is a valid owned handle.
            let _ = unsafe { CloseHandle(job) };
            return Err(CommandError::new(
                "job_object_assign_failed",
                format!("Không gắn sidecar vào Windows Job Object: {error}"),
            ));
        }
        Ok(Some(Self { handle: job }))
    }

    pub fn terminate(&self) {
        use windows::Win32::System::JobObjects::TerminateJobObject;
        // SAFETY: `self.handle` remains valid for the duration of this call.
        let _ = unsafe { TerminateJobObject(self.handle, 1) };
    }
}

#[cfg(windows)]
pub fn soft_cancel(process_id: u32) -> bool {
    use windows::Win32::System::Console::{GenerateConsoleCtrlEvent, CTRL_BREAK_EVENT};
    // SAFETY: The process is started in its own process group with group id equal to its PID.
    unsafe { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, process_id) }.is_ok()
}

#[cfg(windows)]
impl Drop for JobObject {
    fn drop(&mut self) {
        use windows::Win32::Foundation::CloseHandle;
        // KILL_ON_JOB_CLOSE ensures descendants cannot survive app/job teardown.
        // SAFETY: `self.handle` is owned and closed exactly once.
        let _ = unsafe { CloseHandle(self.handle) };
    }
}

#[cfg(not(windows))]
pub struct JobObject;

#[cfg(not(windows))]
impl JobObject {
    pub fn attach(_process_id: u32) -> CommandResult<Option<Self>> {
        Ok(None)
    }

    pub fn terminate(&self) {}
}

#[cfg(not(windows))]
pub fn soft_cancel(_process_id: u32) -> bool {
    false
}
